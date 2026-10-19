import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  assertMp3ConcurrencyGate,
  assertMp3ProcessRestartGate,
  assertMp3RestartGate,
  formatMp3GateFailure,
} from '../dogfood/mp3WorkerGates.js'

const goodMeta = {
  service_runtime_v0: {
    collector: 'bullmq_worker',
    units: [{ service_unit: 'task:analyze_document', calls: 4, unit_type: 'task' }],
    by_tenant: { org_bullmq_live: { calls: 4 } },
  },
}

test('assertMp3ConcurrencyGate passes on bullmq_worker + jobs + tenant', () => {
  const r = assertMp3ConcurrencyGate({
    phase: 'concurrency',
    completedJobs: 4,
    minCompletedJobs: 4,
    sessionMetadata: goodMeta,
    expectedTenant: 'org_bullmq_live',
    expectedTaskUnit: 'task:analyze_document',
  })
  assert.equal(r.ok, true)
  assert.match(formatMp3GateFailure(r), /PASS/)
})

test('assertMp3ConcurrencyGate fails when too few jobs complete', () => {
  const r = assertMp3ConcurrencyGate({
    phase: 'concurrency',
    completedJobs: 1,
    minCompletedJobs: 4,
    sessionMetadata: goodMeta,
  })
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /completedJobs/)
})

test('assertMp3ConcurrencyGate fails on wrong collector', () => {
  const r = assertMp3ConcurrencyGate({
    phase: 'concurrency',
    completedJobs: 4,
    minCompletedJobs: 4,
    sessionMetadata: {
      service_runtime_v0: { collector: 'express_middleware', units: [] },
    },
  })
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /bullmq_worker/)
})

test('assertMp3RestartGate reuses concurrency checks', () => {
  const r = assertMp3RestartGate({
    phase: 'restart',
    completedJobs: 2,
    minCompletedJobs: 2,
    sessionMetadata: goodMeta,
    expectedTaskUnit: 'task:analyze_document',
  })
  assert.equal(r.ok, true)
})

test('assertMp3RestartGate fails without service_runtime_v0', () => {
  const r = assertMp3RestartGate({
    phase: 'restart',
    completedJobs: 2,
    minCompletedJobs: 2,
    sessionMetadata: null,
  })
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /service_runtime_v0/)
})

test('assertMp3ProcessRestartGate expects node_process collector', () => {
  const r = assertMp3ProcessRestartGate({
    phase: 'process_restart',
    completedJobs: 2,
    minCompletedJobs: 2,
    sessionMetadata: {
      service_runtime_v0: {
        collector: 'node_process',
        units: [{ service_unit: 'task:cron_job', calls: 2 }],
        by_tenant: { org_cron: { calls: 2 } },
      },
    },
    expectedTenant: 'org_cron',
    expectedTaskUnit: 'task:cron_job',
  })
  assert.equal(r.ok, true)

  const bad = assertMp3ProcessRestartGate({
    phase: 'process_restart',
    completedJobs: 2,
    minCompletedJobs: 2,
    sessionMetadata: goodMeta,
  })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.reason, /node_process/)
})
