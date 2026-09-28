import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import {
  applyNetGreenerNestHooks,
  detectNestHttpAdapter,
  getNestRuntime,
  netgreenerNestExpressMiddleware,
  netgreenerNestFastifyPlugin,
} from '../nest.js'
import { _resetRuntimeForTests } from '../runtime.js'
import { DEFAULT_TENANT_RUNTIME_FIELDS } from '../tenantDefaults.js'

afterEach(() => {
  _resetRuntimeForTests()
})

function testConfig() {
  return {
    enabled: true,
    apiUrl: 'https://example.test',
    token: 'test-token',
    projectId: 1,
    organizationId: null,
    flushIntervalMs: 60_000,
    dryRun: true,
    deployEnvironment: 'test',
    releaseTag: null,
    estimateTdpWatts: 65,
    ...DEFAULT_TENANT_RUNTIME_FIELDS,
  }
}

test('detectNestHttpAdapter reads getType()', () => {
  assert.equal(
    detectNestHttpAdapter({
      getHttpAdapter: () => ({ getType: () => 'express' }),
    }),
    'express',
  )
  assert.equal(
    detectNestHttpAdapter({
      getHttpAdapter: () => ({ getType: () => 'fastify' }),
    }),
    'fastify',
  )
  assert.equal(detectNestHttpAdapter({}), 'unknown')
})

test('nest Express middleware records with nest collector metadata', async () => {
  _resetRuntimeForTests()
  const middleware = netgreenerNestExpressMiddleware({ config: testConfig() })
  const listeners = new Map<string, Array<() => void>>()
  const res = {
    statusCode: 200,
    on(event: string, fn: () => void) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
    },
  }
  middleware({ method: 'GET', route: { path: '/health' } }, res, () => {})
  for (const fn of listeners.get('finish') ?? []) fn()

  const runtime = getNestRuntime('express')
  const result = await runtime.flush('manual')
  assert.ok(result?.ok)
  if (result && result.ok) {
    const meta = result.body as {
      session_metadata?: { service_runtime_v0?: { collector?: string; units?: Array<{ service_unit: string }> } }
    }
    assert.equal(meta.session_metadata?.service_runtime_v0?.collector, 'nest_express_middleware')
    assert.ok(
      meta.session_metadata?.service_runtime_v0?.units?.some((u) => u.service_unit === 'GET /health'),
    )
  }
})

test('applyNetGreenerNestHooks wires Express use()', async () => {
  _resetRuntimeForTests()
  let used = 0
  const kind = await applyNetGreenerNestHooks(
    {
      getHttpAdapter: () => ({ getType: () => 'express' }),
      use() {
        used += 1
      },
    },
    { config: testConfig() },
  )
  assert.equal(kind, 'express')
  assert.equal(used, 1)
})

test('applyNetGreenerNestHooks registers Fastify plugin', async () => {
  _resetRuntimeForTests()
  let registered = 0
  const kind = await applyNetGreenerNestHooks(
    {
      getHttpAdapter: () => ({
        getType: () => 'fastify',
        getInstance: () => ({
          register(plugin: unknown) {
            registered += 1
            assert.equal(typeof plugin, 'function')
            return Promise.resolve()
          },
          addHook() {},
        }),
      }),
    },
    { config: testConfig() },
  )
  assert.equal(kind, 'fastify')
  assert.equal(registered, 1)
  // Plugin factory is constructible
  assert.equal(typeof netgreenerNestFastifyPlugin({ config: testConfig() }), 'function')
})

test('applyNetGreenerNestHooks rejects unknown adapter', async () => {
  await assert.rejects(
    () => applyNetGreenerNestHooks({ getHttpAdapter: () => ({ getType: () => 'foo' }) }),
    /Unknown Nest HTTP adapter/,
  )
})
