import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  assertNoFalseCgroupClaim,
  CPU_SOURCE_DURATION_PROXY,
  CPU_SOURCE_PROCESS,
  MEMORY_SOURCE_PROCESS,
  missingnessByStatus,
  NODE_DIRECT_MISSINGNESS_INVENTORY,
} from '../n4/missingnessInventory.js'
import {
  beginProcessResourceSample,
  endProcessResourceSample,
} from '../processResources.js'
import { ServiceRuntimeAggregator } from '../aggregator.js'

test('inventory lists process CPU/RSS as measured with honest provenance', () => {
  const cpu = NODE_DIRECT_MISSINGNESS_INVENTORY.find(
    (e) => e.signal_id === 'unit.cpu_seconds_total',
  )
  const rss = NODE_DIRECT_MISSINGNESS_INVENTORY.find(
    (e) => e.signal_id === 'unit.peak_rss_kb_max',
  )
  assert.ok(cpu)
  assert.equal(cpu!.status, 'measured')
  assert.equal(cpu!.provenance, CPU_SOURCE_PROCESS)
  assert.ok(rss)
  assert.equal(rss!.status, 'measured')
  assert.equal(rss!.provenance, MEMORY_SOURCE_PROCESS)
})

test('process-tree/cgroup remains not_measured; health is measured', () => {
  const notMeasured = missingnessByStatus('not_measured').map((e) => e.signal_id)
  assert.ok(notMeasured.includes('collector.process_tree_cgroup'))
  assert.ok(!notMeasured.includes('runtime_health_v0'))
  const health = NODE_DIRECT_MISSINGNESS_INVENTORY.find(
    (e) => e.signal_id === 'runtime_health_v0',
  )
  assert.equal(health?.status, 'measured')
})

test('assertNoFalseCgroupClaim rejects cgroup-looking provenance', () => {
  assert.equal(assertNoFalseCgroupClaim(CPU_SOURCE_PROCESS), true)
  assert.equal(assertNoFalseCgroupClaim(CPU_SOURCE_DURATION_PROXY), true)
  assert.equal(assertNoFalseCgroupClaim('unavailable'), true)
  assert.equal(assertNoFalseCgroupClaim('cgroup_cpuacct'), false)
  assert.equal(assertNoFalseCgroupClaim('process_tree_rss'), false)
})

test('process resource sample returns finite non-negative cpu and rss', () => {
  const mark = beginProcessResourceSample()
  // Busy loop so CPU delta is observable on most hosts.
  let x = 0
  for (let i = 0; i < 200_000; i++) x += i
  assert.ok(x >= 0)
  const sample = endProcessResourceSample(mark)
  assert.equal(Number.isFinite(sample.cpuTimeMs), true)
  assert.ok(sample.cpuTimeMs >= 0)
  assert.ok(sample.rssKb > 0)
})

test('aggregator prefers measured CPU and peak RSS when provided', () => {
  const agg = new ServiceRuntimeAggregator()
  agg.record({
    serviceUnit: 'GET /health',
    durationMs: 100,
    cpuTimeMs: 25,
    peakRssKb: 4096,
  })
  const v0 = agg.buildV0({
    collector: 'express_middleware',
    framework: 'express',
    windowEnergyKwh: 0.001,
    windowSeconds: 60,
  })
  assert.ok(v0)
  assert.equal(v0!.units[0].cpu_seconds_total, 0.025)
  assert.equal(v0!.units[0].peak_rss_kb_max, 4096)
  assert.equal(agg.hasMeasuredCpu(), true)
  assert.equal(agg.hasMeasuredRss(), true)
})

test('aggregator falls back to duration proxy when CPU omitted', () => {
  const agg = new ServiceRuntimeAggregator()
  agg.record({ serviceUnit: 'GET /health', durationMs: 100 })
  const v0 = agg.buildV0({
    collector: 'express_middleware',
    framework: 'express',
    windowEnergyKwh: 0.001,
    windowSeconds: 60,
  })
  assert.ok(v0)
  assert.equal(v0!.units[0].cpu_seconds_total, 0.1)
  assert.equal(agg.hasMeasuredCpu(), false)
  assert.equal(v0!.units[0].peak_rss_kb_max, undefined)
})
