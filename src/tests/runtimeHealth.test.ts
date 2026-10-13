import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildRuntimeHealthV0,
  markHooksActive,
  noteExportAttempt,
  noteExportResult,
  noteFlushSkippedInFlight,
  _resetRuntimeHealthForTests,
} from '../runtimeHealth.js'
import { loadRuntimeConfig } from '../config.js'
import { _resetRuntimeForTests, NetGreenerRuntime } from '../runtime.js'

test('runtime health reports ok after successful export', () => {
  _resetRuntimeHealthForTests()
  markHooksActive({ processKind: 'express', exportMode: 'direct' })
  noteExportAttempt('direct')
  noteExportResult(true)
  const health = buildRuntimeHealthV0()
  assert.equal(health.status, 'ok')
  assert.equal(health.hooks_active, true)
  assert.equal(health.export_ok, 1)
  assert.equal(health.export_fail, 0)
  assert.equal(health.export_mode, 'direct')
})

test('runtime health conflicts when most exports fail', () => {
  _resetRuntimeHealthForTests()
  markHooksActive({ processKind: 'express', exportMode: 'direct' })
  noteExportAttempt('direct')
  noteExportResult(false, 'network down')
  const health = buildRuntimeHealthV0()
  assert.equal(health.status, 'conflict')
  assert.ok(health.codes.includes('export_fail'))
  assert.match(health.detail, /network down/)
})

test('runtime health degrades on in-flight skip with mostly healthy exports', () => {
  _resetRuntimeHealthForTests()
  markHooksActive({ processKind: 'express', exportMode: 'direct' })
  noteExportAttempt('direct')
  noteExportResult(true)
  noteExportAttempt('direct')
  noteExportResult(true)
  noteFlushSkippedInFlight()
  const health = buildRuntimeHealthV0()
  assert.equal(health.status, 'degraded')
  assert.ok(health.codes.includes('export_skipped_in_flight'))
  assert.equal(health.export_skipped_in_flight, 1)
})

test('dry-run flush attaches runtime_health_v0 with export counters', async () => {
  _resetRuntimeForTests()
  process.env.NETGREENER_SERVICE_RUNTIME = '1'
  process.env.NETGREENER_TOKEN = 'ngs_test'
  process.env.NETGREENER_PROJECT_ID = '42'
  process.env.NETGREENER_RUNTIME_DRY_RUN = '1'

  const runtime = new NetGreenerRuntime({
    config: loadRuntimeConfig(),
    collector: 'express_middleware',
    framework: 'express',
  })
  runtime.recordHttp({
    method: 'GET',
    path: '/health',
    statusCode: 200,
    durationMs: 10,
    cpuTimeMs: 2,
    peakRssKb: 4096,
  })
  const result = await runtime.flush('manual')
  assert.ok(result?.ok)
  if (result && result.ok) {
    const meta = (result.body as { session_metadata: Record<string, unknown> })
      .session_metadata
    const health = meta.runtime_health_v0 as {
      status: string
      export_ok: number
      hooks_active: boolean
      export_mode: string
    }
    assert.ok(health)
    assert.equal(health.hooks_active, true)
    assert.equal(health.export_ok, 1)
    assert.equal(health.export_mode, 'direct')
    assert.equal(health.status, 'ok')
  }

  _resetRuntimeForTests()
  delete process.env.NETGREENER_SERVICE_RUNTIME
  delete process.env.NETGREENER_TOKEN
  delete process.env.NETGREENER_PROJECT_ID
  delete process.env.NETGREENER_RUNTIME_DRY_RUN
})
