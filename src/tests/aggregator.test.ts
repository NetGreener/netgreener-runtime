import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ServiceRuntimeAggregator } from '../aggregator.js'
import { MAX_TENANT_BUCKETS, TENANT_OVERFLOW_ID } from '../tenantContext.js'

function buildRuntime(aggregator: ServiceRuntimeAggregator) {
  const runtime = aggregator.buildV0({
    collector: 'express_middleware',
    framework: 'express',
    windowEnergyKwh: 0.001,
    windowSeconds: 60,
  })
  assert.ok(runtime)
  return runtime
}

test('overlapping CPU intervals and shared-route tenants conserve window CPU and RAM', () => {
  const agg = new ServiceRuntimeAggregator()
  for (const tenantId of ['a', 'b']) {
    agg.record({ serviceUnit: 'GET /shared', tenantId, durationMs: 100, cpuTimeMs: 100 })
  }
  const doc = agg.buildV0({ collector: 'test', framework: 'express',
    windowEnergyKwh: 0.001, windowSeconds: 1, windowCpuSeconds: 0.1,
    windowRamGbHours: 1,
    occupancy: { by_unit: { 'GET /shared': 1 }, idle_seconds: 0, in_flight_seconds: 0 },
  })!
  assert.equal(doc.units[0].cpu_seconds_total, 0.1)
  assert.equal(doc.attribution_detail?.cpu?.kind, 'allocated_estimate')
  const tenantUnits = Object.values(doc.by_tenant!).flatMap(bucket => bucket.units)
  assert.equal(tenantUnits.reduce((sum, unit) => sum + unit.cpu_seconds_total, 0), 0.1)
  assert.equal(tenantUnits.reduce((sum, unit) => sum + (unit.ram_gb_hours ?? 0), 0), 1)
})

test('tenant cap and retry merge preserve all calls in an explicit overflow bucket', () => {
  const agg = new ServiceRuntimeAggregator()
  for (let i = 0; i < 250; i++) {
    agg.record({ serviceUnit: 'GET /shared', tenantId: `a${i}`, durationMs: 1 })
  }
  const snapshot = agg.takeSnapshot()
  for (let i = 0; i < 250; i++) {
    agg.record({ serviceUnit: 'GET /shared', tenantId: `b${i}`, durationMs: 1 })
  }
  agg.mergeSnapshot(snapshot)
  const doc = buildRuntime(agg)
  assert.equal(Object.keys(doc.by_tenant!).length, MAX_TENANT_BUCKETS)
  assert.equal(Object.values(doc.by_tenant!).reduce((sum, bucket) => sum + bucket.calls, 0), 500)
  assert.ok(doc.by_tenant![TENANT_OVERFLOW_ID].calls > 0)
})

test('normalizes and bounds service-unit identity', () => {
  const aggregator = new ServiceRuntimeAggregator()
  aggregator.record({ serviceUnit: '  GET /health  ', durationMs: 1 })

  const sharedLongPrefix = `GET /${'x'.repeat(300)}`
  aggregator.record({ serviceUnit: `${sharedLongPrefix}/one`, durationMs: 2 })
  aggregator.record({ serviceUnit: `${sharedLongPrefix}/two`, durationMs: 3 })
  aggregator.record({ serviceUnit: '   ', durationMs: 4 })

  const runtime = buildRuntime(aggregator)
  assert.equal(runtime.units.length, 3)
  assert.equal(runtime.units.find((unit) => unit.service_unit === 'GET /health')?.calls, 1)
  assert.equal(runtime.units.find((unit) => unit.service_unit === 'UNKNOWN')?.calls, 1)

  const bounded = runtime.units.find((unit) => unit.service_unit.endsWith('…'))
  assert.ok(bounded)
  assert.equal(bounded.service_unit.length, 256)
  assert.equal(bounded.calls, 2)
})

test('caps total units and sends excess observations to one overflow bucket', () => {
  const aggregator = new ServiceRuntimeAggregator()
  for (let index = 0; index < 525; index += 1) {
    aggregator.record({
      serviceUnit: `GET /items/${index}`,
      durationMs: 1,
      error: index % 10 === 0,
    })
  }

  const runtime = buildRuntime(aggregator)
  assert.equal(runtime.units.length, 500)
  assert.equal(runtime.units.reduce((sum, unit) => sum + unit.calls, 0), 525)
  assert.equal(runtime.units.reduce((sum, unit) => sum + unit.errors, 0), 53)
  assert.equal(aggregator.totalDurationMs(), 525)

  const overflow = runtime.units.find((unit) => unit.service_unit === '__other__')
  assert.ok(overflow)
  assert.equal(overflow.calls, 26)
})

test('retry merge remains bounded and preserves snapshot plus in-flight observations', () => {
  const aggregator = new ServiceRuntimeAggregator()
  for (let index = 0; index < 520; index += 1) {
    aggregator.record({
      serviceUnit: `GET /before/${index}`,
      durationMs: 2,
      error: index % 10 === 0,
    })
  }

  const snapshot = aggregator.takeSnapshot()
  const snapshotStartedAt = snapshot.windowStartedMs()
  for (let index = 0; index < 520; index += 1) {
    aggregator.record({
      serviceUnit: `GET /during/${index}`,
      durationMs: 3,
      error: index % 13 === 0,
    })
  }

  aggregator.mergeSnapshot(snapshot)

  const runtime = buildRuntime(aggregator)
  assert.equal(runtime.units.length, 500)
  assert.equal(runtime.units.reduce((sum, unit) => sum + unit.calls, 0), 1040)
  assert.equal(runtime.units.reduce((sum, unit) => sum + unit.errors, 0), 92)
  assert.equal(aggregator.totalDurationMs(), 2600)
  assert.equal(aggregator.windowStartedMs(), snapshotStartedAt)
  assert.ok(runtime.units.some((unit) => unit.service_unit === '__other__'))
})
