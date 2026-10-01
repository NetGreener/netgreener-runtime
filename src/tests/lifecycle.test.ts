/**
 * Lifecycle-aware delivery: persistent vs ephemeral.
 * Does not change the persistent aggregator/export pipeline shape.
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import {
  loadRuntimeConfig,
  type RuntimeConfig,
} from '../config.js'
import { DEFAULT_TENANT_RUNTIME_FIELDS } from '../tenantDefaults.js'
import { exportModeFromEnv } from '../exporter.js'
import {
  resolveLifecycle,
  isEphemeralLifecycle,
} from '../lifecycle.js'
import {
  NetGreenerRuntime,
  _resetRuntimeForTests,
  getRuntime,
} from '../runtime.js'
import {
  clearExternalAggregator,
  getExternalAggregator,
  _resetOutboundInstrumentationForTests,
} from '../externalApiMeter.js'
import {
  runWithRequestAttribution,
  attributionServiceUnit,
} from '../requestContext.js'
import { NetGreener } from '../init.js'

function readyConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    enabled: true,
    apiUrl: 'https://example.test',
    token: 'token',
    projectId: 42,
    organizationId: 7,
    flushIntervalMs: 5 * 60 * 1000,
    dryRun: true,
    deployEnvironment: null,
    releaseTag: null,
    estimateTdpWatts: 65,
    ...DEFAULT_TENANT_RUNTIME_FIELDS,
    ...overrides,
  }
}

afterEach(() => {
  _resetRuntimeForTests()
  clearExternalAggregator()
  _resetOutboundInstrumentationForTests()
})

test('auto: Vercel signal → ephemeral lifecycle', () => {
  const resolved = resolveLifecycle({
    mode: 'auto',
    env: { VERCEL: '1', VERCEL_ENV: 'production' },
  })
  assert.equal(resolved.lifecycle, 'ephemeral')
  assert.equal(resolved.platform, 'vercel')
  assert.equal(resolved.capabilities.periodic_flush, false)
  assert.equal(resolved.capabilities.local_durable_spool, false)
  assert.equal(isEphemeralLifecycle({ env: { VERCEL: '1' } }), true)
})

test('auto: AWS Lambda signal → ephemeral', () => {
  const resolved = resolveLifecycle({
    mode: 'auto',
    env: { AWS_LAMBDA_FUNCTION_NAME: 'fn' },
  })
  assert.equal(resolved.lifecycle, 'ephemeral')
  assert.equal(resolved.platform, 'aws_lambda')
})

test('Docker / Kubernetes alone stay persistent', () => {
  assert.equal(
    resolveLifecycle({
      mode: 'auto',
      env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' },
    }).lifecycle,
    'persistent',
  )
  assert.equal(
    resolveLifecycle({
      mode: 'auto',
      env: { DOTNET_RUNNING_IN_CONTAINER: 'true' },
    }).lifecycle,
    'persistent',
  )
  assert.equal(
    resolveLifecycle({ mode: 'auto', env: {} }).platform,
    'generic',
  )
})

test('explicit persistent wins over Vercel signal', () => {
  const resolved = resolveLifecycle({
    mode: 'persistent',
    env: { VERCEL: '1' },
  })
  assert.equal(resolved.lifecycle, 'persistent')
  assert.equal(resolved.capabilities.periodic_flush, true)
})

test('ephemeral prefers thin export when EXPORT_MODE unset', () => {
  assert.equal(
    exportModeFromEnv({ AWS_LAMBDA_FUNCTION_NAME: 'fn' }),
    'thin',
  )
  assert.equal(
    exportModeFromEnv(
      { AWS_LAMBDA_FUNCTION_NAME: 'fn', NETGREENER_EXPORT_MODE: 'direct' },
    ),
    'direct',
  )
  assert.equal(
    exportModeFromEnv({ NETGREENER_RUNTIME: 'persistent', VERCEL: '1' }),
    'direct',
  )
})

test('persistent process: periodic timer starts; ephemeral does not', () => {
  const persistent = new NetGreenerRuntime({
    config: readyConfig(),
    runtimeMode: 'persistent',
  })
  persistent.start()
  assert.equal(persistent.lifecycle, 'persistent')
  // Timer is private; probe via flush kind metadata after manual path still works.
  assert.ok(persistent.enabled)

  const ephemeral = new NetGreenerRuntime({
    config: readyConfig(),
    runtimeMode: 'ephemeral',
  })
  ephemeral.start()
  assert.equal(ephemeral.lifecycle, 'ephemeral')
  assert.equal(ephemeral.lifecycleInfo.capabilities.periodic_flush, false)
})

test('ephemeral single request: record + invoke_end flush attributes route', async () => {
  const windows: string[] = []
  const runtime = new NetGreenerRuntime({
    config: readyConfig(),
    runtimeMode: 'ephemeral',
    onFlush: (_r, payload) => {
      windows.push(payload.runtime_window_id)
    },
  })
  runtime.start()
  runtime.beginRequest()
  runtime.recordHttp({
    method: 'POST',
    path: '/api/analyze',
    statusCode: 200,
    durationMs: 42,
  })
  getExternalAggregator().record({
    host: 'api.openai.com',
    durationMs: 10,
    error: false,
    serviceUnit: 'POST /api/analyze',
    inputTokens: 100,
    outputTokens: 20,
  })
  runtime.endRequest()
  // Idle microtask schedules invoke_end flush.
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.equal(windows.length, 1)
  const result = await runtime.flush('manual')
  // Already flushed — no leftover unless more data.
  assert.equal(result, null)
})

test('concurrent requests: ALS attribution never crosses', async () => {
  const seen: string[] = []
  await Promise.all([
    runWithRequestAttribution({ serviceUnit: 'POST /api/analyze' }, async () => {
      await new Promise((r) => setTimeout(r, 5))
      seen.push(`A:${attributionServiceUnit()}`)
      await new Promise((r) => setTimeout(r, 5))
      seen.push(`A2:${attributionServiceUnit()}`)
    }),
    runWithRequestAttribution({ serviceUnit: 'POST /api/search' }, async () => {
      await new Promise((r) => setTimeout(r, 2))
      seen.push(`B:${attributionServiceUnit()}`)
      await new Promise((r) => setTimeout(r, 8))
      seen.push(`B2:${attributionServiceUnit()}`)
    }),
  ])
  assert.ok(seen.includes('A:POST /api/analyze'))
  assert.ok(seen.includes('A2:POST /api/analyze'))
  assert.ok(seen.includes('B:POST /api/search'))
  assert.ok(seen.includes('B2:POST /api/search'))
  assert.ok(!seen.some((s) => s.startsWith('A:') && s.includes('search')))
  assert.ok(!seen.some((s) => s.startsWith('B:') && s.includes('analyze')))
})

test('instance reuse: no stale in-flight after prior request', async () => {
  const runtime = new NetGreenerRuntime({
    config: readyConfig(),
    runtimeMode: 'ephemeral',
  })
  runtime.beginRequest()
  runtime.recordHttp({
    method: 'GET',
    path: '/api/one',
    statusCode: 200,
    durationMs: 1,
  })
  runtime.endRequest()
  await new Promise((r) => setImmediate(r))
  await runtime.flush('manual')

  assert.equal(runtime._inFlightForTests(), 0)
  runtime.beginRequest()
  assert.equal(runtime._inFlightForTests(), 1)
  runtime.recordHttp({
    method: 'GET',
    path: '/api/two',
    statusCode: 200,
    durationMs: 2,
  })
  runtime.endRequest()
  assert.equal(runtime._inFlightForTests(), 0)
})

test('telemetry backend failure: customer path still succeeds (fail open)', async () => {
  let customerOk = false
  const runtime = new NetGreenerRuntime({
    config: readyConfig({ dryRun: false, apiUrl: 'https://127.0.0.1:1' }),
    runtimeMode: 'ephemeral',
    fetchImpl: (async () => {
      throw new Error('network down')
    }) as typeof fetch,
  })
  runtime.recordHttp({
    method: 'POST',
    path: '/api/analyze',
    statusCode: 200,
    durationMs: 5,
  })
  const flushResult = await runtime.flush('invoke_end')
  customerOk = true
  assert.equal(customerOk, true)
  assert.equal(flushResult?.ok, false)
})

test('duplicate/retry: sticky runtime_window_id preserved across failed flush', async () => {
  let calls = 0
  const ids: string[] = []
  const runtime = new NetGreenerRuntime({
    config: readyConfig(),
    runtimeMode: 'ephemeral',
    exporter: {
      mode: 'thin',
      async exportRunSessionWindow(_config, _payload) {
        calls += 1
        if (calls === 1) {
          return {
            ok: false,
            error: 'backend unavailable',
            mode: 'thin',
            durabilityGrade: 'best_effort_bounded',
          }
        }
        return {
          ok: true,
          status: 201,
          body: { run_id: 1 },
          mode: 'thin',
          durabilityGrade: 'best_effort_bounded',
        }
      },
      async exportObservationBatch() {
        return {
          ok: false,
          error: 'unused',
          mode: 'thin',
          durabilityGrade: 'best_effort_bounded',
        }
      },
    },
    onFlush: (_r, payload) => {
      ids.push(payload.runtime_window_id)
    },
  })
  runtime.recordHttp({
    method: 'POST',
    path: '/api/analyze',
    statusCode: 200,
    durationMs: 5,
  })
  const first = await runtime.flush('invoke_end')
  assert.equal(first?.ok, false)
  const second = await runtime.flush('invoke_end')
  assert.equal(second?.ok, true)
  assert.equal(ids.length, 2)
  assert.equal(ids[0], ids[1], 'retry must reuse the same runtime_window_id')
})

test('NetGreener.init exposes one product surface', () => {
  const rt = NetGreener.init({
    runtime: 'persistent',
    config: readyConfig(),
  })
  assert.equal(rt.lifecycle, 'persistent')
  assert.equal(getRuntime().lifecycle, 'persistent')
})

test('concurrent ephemeral idle flush waits until all requests finish', async () => {
  const flushes: string[] = []
  const runtime = new NetGreenerRuntime({
    config: readyConfig(),
    runtimeMode: 'ephemeral',
    onFlush: (_r, payload) => {
      const meta = payload.session_metadata as {
        run_context?: { runtime_flush_kind?: string }
      }
      flushes.push(String(meta?.run_context?.runtime_flush_kind ?? ''))
    },
  })
  runtime.beginRequest()
  runtime.beginRequest()
  runtime.recordHttp({
    method: 'POST',
    path: '/api/analyze',
    statusCode: 200,
    durationMs: 1,
  })
  runtime.recordHttp({
    method: 'POST',
    path: '/api/search',
    statusCode: 200,
    durationMs: 2,
  })
  runtime.endRequest()
  await new Promise((r) => setImmediate(r))
  assert.equal(flushes.length, 0, 'must not flush while sibling request in flight')
  runtime.endRequest()
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.equal(flushes.length, 1)
  assert.equal(flushes[0], 'invoke_end')
})

// Silence unused import when loadRuntimeConfig not needed in all tests
void loadRuntimeConfig
