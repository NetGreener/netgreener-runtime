import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { ServiceRuntimeAggregator } from '../aggregator.js'
import {
  _resetOccupancyTrackerForTests,
  getOccupancyTracker,
} from '../occupancyTracker.js'
import { _resetRuntimeForTests, NetGreenerRuntime } from '../runtime.js'
import { recordMeteredTask } from '../taskMeter.js'
import { DEFAULT_TENANT_RUNTIME_FIELDS } from '../tenantDefaults.js'

afterEach(() => {
  _resetOccupancyTrackerForTests()
  _resetRuntimeForTests()
})

function testRuntime(): NetGreenerRuntime {
  return new NetGreenerRuntime({
    collector: 'node_process',
    framework: 'node',
    config: {
      enabled: true,
      apiUrl: 'https://example.test',
      token: 't',
      projectId: 1,
      organizationId: null,
      flushIntervalMs: 60_000,
      dryRun: true,
      deployEnvironment: 'test',
      releaseTag: null,
      estimateTdpWatts: 65,
      ...DEFAULT_TENANT_RUNTIME_FIELDS,
      tenantSource: 'none',
    },
  })
}

test('recordMeteredTask accrues occupancy for process/BullMQ path', async () => {
  _resetOccupancyTrackerForTests()
  const runtime = testRuntime()
  runtime.start()

  await recordMeteredTask(runtime, {
    serviceUnit: 'task:nightly_report',
    tenantId: 'org_acme',
    taskId: 'job-42',
    fn: async () => {
      await new Promise((r) => setTimeout(r, 40))
      return 'ok'
    },
  })

  const snap = getOccupancyTracker().takeWindowSnapshot()
  assert.ok(
    (snap.by_unit['task:nightly_report'] || 0) > 0,
    'occupancy should accrue to task unit',
  )
})

test('process-style flush attributes cpu_and_occupancy_v1 after metered task', async () => {
  _resetOccupancyTrackerForTests()
  const runtime = testRuntime()
  runtime.start()

  await recordMeteredTask(runtime, {
    serviceUnit: 'task:batch',
    tenantId: null,
    taskId: 't1',
    fn: async () => {
      await new Promise((r) => setTimeout(r, 35))
    },
  })

  const occupancy = getOccupancyTracker().takeWindowSnapshot()
  const agg = new ServiceRuntimeAggregator()
  agg.record({
    serviceUnit: 'task:batch',
    unitType: 'task',
    durationMs: 35,
    cpuTimeMs: 10,
    peakRssKb: 2048,
  })
  const v0 = agg.buildV0({
    collector: 'node_process',
    framework: 'node',
    windowEnergyKwh: 0.0001,
    windowSeconds: 1,
    windowRamGbHours: 0.001,
    occupancy,
  })
  assert.ok(v0)
  assert.equal(v0!.attribution, 'cpu_and_occupancy_v1')
  assert.ok((v0!.units[0]!.occupancy_seconds || 0) > 0)
  assert.ok((v0!.units[0]!.ram_gb_hours || 0) > 0)
})
