import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ServiceRuntimeAggregator } from '../aggregator.js'
import {
  OccupancyTracker,
  _resetOccupancyTrackerForTests,
} from '../occupancyTracker.js'

test('OccupancyTracker accrues share to unit on end', async () => {
  const t = new OccupancyTracker()
  t.begin('a')
  await new Promise((r) => setTimeout(r, 30))
  t.end('a', 'GET /x')
  const snap = t.takeWindowSnapshot()
  assert.ok(snap.by_unit['GET /x']! > 0)
  assert.equal(snap.in_flight_seconds, 0)
})

test('OccupancyTracker concurrent requests split occupancy', async () => {
  const t = new OccupancyTracker()
  t.begin('a')
  t.begin('b')
  await new Promise((r) => setTimeout(r, 40))
  t.end('a', 'GET /a')
  t.end('b', 'GET /b')
  const snap = t.takeWindowSnapshot()
  assert.ok(snap.by_unit['GET /a']! > 0)
  assert.ok(snap.by_unit['GET /b']! > 0)
})

test('buildV0 with occupancy sets cpu_and_occupancy_v1 and window-scales', () => {
  _resetOccupancyTrackerForTests()
  const agg = new ServiceRuntimeAggregator()
  agg.record({
    serviceUnit: 'GET /x',
    durationMs: 10,
    cpuTimeMs: 5,
    peakRssKb: 1024,
  })
  const v0 = agg.buildV0({
    collector: 'test',
    framework: 'express',
    windowEnergyKwh: 0.001,
    windowSeconds: 60,
    windowRamGbHours: 0.06,
    occupancy: {
      by_unit: { 'GET /x': 1.5 },
      idle_seconds: 2,
      in_flight_seconds: 0.1,
    },
  })
  assert.ok(v0)
  assert.equal(v0!.attribution, 'cpu_and_occupancy_v1')
  // coverage 3.6 → scale to 60; unit share 1.5/3.6 * 60 = 25
  assert.ok(Math.abs((v0!.units[0]!.occupancy_seconds || 0) - 25) < 1e-6)
  assert.ok(v0!.unattributed)
  const una = v0!.unattributed!.occupancy_seconds || 0
  assert.ok(Math.abs(una + (v0!.units[0]!.occupancy_seconds || 0) - 60) < 1e-6)
  assert.ok((v0!.units[0]!.ram_gb_hours || 0) > 0)
  assert.ok((v0!.unattributed!.ram_gb_hours || 0) > 0)
})
