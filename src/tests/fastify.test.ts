import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'

import {
  fastifyRouteTemplate,
  getFastifyRuntime,
  netgreenerFastifyPlugin,
  type FastifyLike,
  type FastifyRequestLike,
} from '../fastify.js'
import { UNKNOWN_ROUTE_TEMPLATE } from '../express.js'
import { attributionServiceUnit } from '../requestContext.js'
import {
  getTenantContext,
  setTenantContext,
} from '../tenantContext.js'
import { _resetOutboundInstrumentationForTests } from '../externalApiMeter.js'
import { _resetRuntimeForTests } from '../runtime.js'
import { DEFAULT_TENANT_RUNTIME_FIELDS } from '../tenantDefaults.js'

const TENANT_ENV_KEYS = [
  'NETGREENER_TENANT_SOURCE',
  'NETGREENER_TENANT_HEADER',
  'NETGREENER_SERVICE_RUNTIME',
  'NETGREENER_TOKEN',
  'NETGREENER_PROJECT_ID',
  'NETGREENER_RUNTIME_DRY_RUN',
] as const

const savedEnv: Partial<Record<(typeof TENANT_ENV_KEYS)[number], string | undefined>> = {}
for (const key of TENANT_ENV_KEYS) {
  savedEnv[key] = process.env[key]
}

function restoreEnv(): void {
  for (const key of TENANT_ENV_KEYS) {
    const previous = savedEnv[key]
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
}

after(() => {
  restoreEnv()
  _resetOutboundInstrumentationForTests()
  _resetRuntimeForTests()
})

afterEach(() => {
  restoreEnv()
  _resetOutboundInstrumentationForTests()
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

type HookFn = (...args: unknown[]) => unknown

function createFakeFastify() {
  const hooks = new Map<string, HookFn[]>()
  const fastify: FastifyLike = {
    addHook(name, handler) {
      const list = hooks.get(name) ?? []
      list.push(handler as HookFn)
      hooks.set(name, list)
    },
  }
  return {
    fastify,
    async runRequest(
      req: FastifyRequestLike,
      reply: { statusCode: number },
      during?: () => void | Promise<void>,
    ) {
      for (const handler of hooks.get('onRequest') ?? []) {
        await new Promise<void>((resolve, reject) => {
          const result = handler(req, reply, (err?: Error) => {
            if (err) reject(err)
            else resolve()
          })
          if (result && typeof (result as Promise<void>).then === 'function') {
            ;(result as Promise<void>).then(() => resolve()).catch(reject)
          }
        })
      }
      if (during) await during()
      for (const handler of hooks.get('onResponse') ?? []) {
        await new Promise<void>((resolve, reject) => {
          const result = handler(req, reply, (err?: Error) => {
            if (err) reject(err)
            else resolve()
          })
          if (result && typeof (result as Promise<void>).then === 'function') {
            ;(result as Promise<void>).then(() => resolve()).catch(reject)
          }
        })
      }
    },
  }
}

test('fastifyRouteTemplate uses routerPath / routeOptions.url only', () => {
  assert.equal(
    fastifyRouteTemplate({ url: '/users/secret-id?x=1', routerPath: '/users/:id' }),
    '/users/:id',
  )
  assert.equal(
    fastifyRouteTemplate({ url: '/raw', routeOptions: { url: '/items/:itemId' } }),
    '/items/:itemId',
  )
  assert.equal(fastifyRouteTemplate({ url: '/only-raw' }), UNKNOWN_ROUTE_TEMPLATE)
  assert.equal(
    fastifyRouteTemplate({ routerPath: '/x?evil=1' }),
    UNKNOWN_ROUTE_TEMPLATE,
  )
})

test('fastify plugin records bounded route and header tenant', async () => {
  _resetRuntimeForTests()

  const plugin = netgreenerFastifyPlugin({
    config: {
      ...testConfig(),
      tenantSource: 'header',
      tenantHeader: 'X-Organization-Id',
    },
  })
  const { fastify, runRequest } = createFakeFastify()
  await plugin(fastify)

  const req: FastifyRequestLike = {
    method: 'GET',
    url: '/users/abc-should-not-appear',
    routerPath: '/users/:id',
    headers: { 'x-organization-id': 'org_fastify' },
  }
  await runRequest(req, { statusCode: 200 })

  const runtime = getFastifyRuntime()
  const result = await runtime.flush('manual')
  assert.ok(result?.ok)
  if (result && result.ok) {
    const meta = result.body as {
      session_metadata?: {
        service_runtime_v0?: {
          units?: Array<{ service_unit: string }>
          by_tenant?: Record<string, { calls: number }>
        }
      }
    }
    const units = meta.session_metadata?.service_runtime_v0?.units ?? []
    assert.ok(units.some((u) => u.service_unit === 'GET /users/:id'))
    assert.ok(!JSON.stringify(units).includes('abc-should-not-appear'))
    assert.equal(meta.session_metadata?.service_runtime_v0?.by_tenant?.org_fastify?.calls, 1)
  }
})

test('fastify onRequest enterWith keeps tenant and route for nested work', async () => {
  _resetRuntimeForTests()
  process.env.NETGREENER_TENANT_SOURCE = 'header'

  const plugin = netgreenerFastifyPlugin({
    config: {
      ...testConfig(),
      tenantSource: 'header',
      tenantHeader: 'X-Organization-Id',
    },
  })
  const { fastify, runRequest } = createFakeFastify()
  await plugin(fastify)

  let seenTenant: string | null = null
  let seenUnit: string | null = null
  const req: FastifyRequestLike = {
    method: 'POST',
    url: '/predict/xyz',
    routeOptions: { url: '/predict' },
    headers: { 'x-organization-id': 'org_hook' },
  }

  await runRequest(req, { statusCode: 201 }, () => {
    seenTenant = getTenantContext()?.tenantId ?? null
    seenUnit = attributionServiceUnit()
    setTenantContext({ tenantId: 'org_manual', tenantSource: 'verified-auth' })
    assert.equal(getTenantContext()?.tenantId, 'org_manual')
  })

  assert.equal(seenTenant, 'org_hook')
  assert.equal(seenUnit, 'POST /predict')

  const meta = (await getFastifyRuntime().flush('manual')) as {
    ok?: boolean
    body?: {
      session_metadata?: {
        service_runtime_v0?: { by_tenant?: Record<string, { calls: number }> }
      }
    }
  }
  assert.ok(meta?.ok)
  // finish uses live tenant store after manual bind
  assert.equal(meta.body?.session_metadata?.service_runtime_v0?.by_tenant?.org_manual?.calls, 1)
})

test('disabled runtime registers no hooks', async () => {
  _resetRuntimeForTests()
  const plugin = netgreenerFastifyPlugin({
    config: { ...testConfig(), enabled: false },
  })
  let hooked = 0
  const fastify: FastifyLike = {
    addHook() {
      hooked += 1
    },
  }
  await plugin(fastify)
  assert.equal(hooked, 0)
})
