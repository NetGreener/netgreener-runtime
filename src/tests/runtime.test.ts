import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ServiceRuntimeAggregator } from '../aggregator.js'
import { loadRuntimeConfig } from '../config.js'
import { _resetRuntimeForTests, NetGreenerRuntime } from '../runtime.js'
import { newRuntimeWindowId } from '../windowId.js'
import { validateRuntimeSessionMetadata } from '../contract/validate.js'
import { DEFAULT_TENANT_RUNTIME_FIELDS } from '../tenantDefaults.js'

test('runtime_window_id matches api_server pattern', () => {
  const id = newRuntimeWindowId()
  assert.match(id, /^rtw_[0-9a-f]{64}$/)
})

test('loadRuntimeConfig reads every option from the injected environment', () => {
  const config = loadRuntimeConfig({
    NETGREENER_SERVICE_RUNTIME: 'yes',
    NETGREENER_API_URL: 'https://example.test/api/',
    NETGREENER_TOKEN: 'injected-token',
    NETGREENER_PROJECT_ID: '42',
    NETGREENER_ORG_ID: '7',
    NETGREENER_RUNTIME_FLUSH_MINUTES: '3',
    NETGREENER_RUNTIME_DRY_RUN: 'true',
    NETGREENER_DEPLOY_ENVIRONMENT: 'staging',
    NETGREENER_RELEASE_TAG: 'release-123',
    NETGREENER_ESTIMATE_TDP_WATTS: '95',
  })

  assert.deepEqual(config, {
    enabled: true,
    apiUrl: 'https://example.test/api',
    token: 'injected-token',
    projectId: 42,
    organizationId: 7,
    flushIntervalMs: 180_000,
    dryRun: true,
    deployEnvironment: 'staging',
    releaseTag: 'release-123',
    estimateTdpWatts: 95,
    ...DEFAULT_TENANT_RUNTIME_FIELDS,
  })
})

test('aggregator builds valid service_runtime_v0', () => {
  const agg = new ServiceRuntimeAggregator()
  agg.record({ serviceUnit: 'GET /health', durationMs: 10 })
  agg.record({ serviceUnit: 'POST /v1/predict', durationMs: 100, error: true })
  const v0 = agg.buildV0({
    collector: 'express_middleware',
    framework: 'express',
    windowEnergyKwh: 0.001,
    windowSeconds: 60,
  })
  assert.ok(v0)
  assert.equal(v0!.collector, 'express_middleware')
  assert.equal(v0!.units.length, 2)
  const result = validateRuntimeSessionMetadata({ service_runtime_v0: v0 })
  assert.equal(result.ok, true, JSON.stringify(result.issues))
})

test('aggregator contains non-finite and negative numeric inputs', () => {
  const agg = new ServiceRuntimeAggregator()
  agg.record({ serviceUnit: 'GET /nan', durationMs: Number.NaN })
  agg.record({ serviceUnit: 'GET /infinity', durationMs: Number.POSITIVE_INFINITY })
  agg.record({ serviceUnit: 'GET /negative', durationMs: -50 })
  const v0 = agg.buildV0({
    collector: 'express_middleware',
    framework: 'express',
    windowEnergyKwh: Number.POSITIVE_INFINITY,
    windowSeconds: Number.NaN,
  })

  assert.ok(v0)
  assert.equal(v0.window_seconds, 0)
  assert.equal(v0.allocation_reconciliation_v0?.window_energy_kwh, 0)
  for (const unit of v0.units) {
    assert.equal(Number.isFinite(unit.cpu_seconds_total), true)
    assert.equal(Number.isFinite(unit.energy_kwh), true)
    assert.equal(Number.isFinite(unit.carbon_g), true)
    assert.equal(Number.isFinite(unit.duration_ms.avg), true)
    assert.equal(Number.isFinite(unit.duration_ms.max), true)
  }
  const result = validateRuntimeSessionMetadata({ service_runtime_v0: v0 })
  assert.equal(result.ok, true, JSON.stringify(result.issues))
})

test('dry-run flush builds uploadable payload without network', async () => {
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
    durationMs: 12,
    cpuTimeMs: 4,
    peakRssKb: 8192,
  })
  runtime.recordHttp({
    method: 'POST',
    path: '/v1/predict',
    statusCode: 500,
    durationMs: 80,
    cpuTimeMs: 40,
    peakRssKb: 9000,
  })

  const result = await runtime.flush('manual')
  assert.ok(result)
  assert.equal(result!.ok, true)
  if (result && result.ok) {
    assert.equal(result.dryRun, true)
    const payload = result.body as {
      project_id: number
      runtime_window_id: string
      session_metadata: Record<string, unknown>
    }
    assert.equal(payload.project_id, 42)
    assert.match(payload.runtime_window_id, /^rtw_[0-9a-f]{64}$/)
    const metaCheck = validateRuntimeSessionMetadata(payload.session_metadata)
    assert.equal(metaCheck.ok, true, JSON.stringify(metaCheck.issues))
    const provenance = payload.session_metadata.measurement_provenance as {
      cpu_source: string
      memory_source: string
      energy_model: string
      carbon_factor: { source: string }
      evidence_grades: { combined_floor_grade: string }
    }
    assert.equal(provenance.cpu_source, 'node_process_cpu_usage')
    assert.equal(provenance.memory_source, 'node_process_memory_rss')
    assert.equal(provenance.energy_model, 'tdp_utilization_estimate')
    assert.equal(provenance.carbon_factor.source, 'default_grid_factor')
    assert.equal(provenance.evidence_grades.combined_floor_grade, 'G1')
  }

  _resetRuntimeForTests()
  delete process.env.NETGREENER_SERVICE_RUNTIME
  delete process.env.NETGREENER_TOKEN
  delete process.env.NETGREENER_PROJECT_ID
  delete process.env.NETGREENER_RUNTIME_DRY_RUN
})

test('failed upload restores aggregator for retry', async () => {
  _resetRuntimeForTests()
  const runtime = new NetGreenerRuntime({
    config: {
      enabled: true,
      apiUrl: 'http://127.0.0.1:9',
      token: 'ngs_test',
      projectId: 1,
      organizationId: null,
      flushIntervalMs: 60_000,
      dryRun: false,
      deployEnvironment: null,
      releaseTag: null,
      estimateTdpWatts: 65,
      ...DEFAULT_TENANT_RUNTIME_FIELDS,
    },
    fetchImpl: async () =>
      new Response(JSON.stringify({ detail: 'nope' }), { status: 500 }),
  })
  runtime.recordHttp({
    method: 'GET',
    path: '/a',
    statusCode: 200,
    durationMs: 5,
  })
  const first = await runtime.flush('manual')
  assert.ok(first && !first.ok)
  // Second flush should still have data (restored after failure).
  const second = await runtime.flush('manual')
  assert.ok(second)
  _resetRuntimeForTests()
})
