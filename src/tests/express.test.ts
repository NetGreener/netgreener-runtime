import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'

import {
  expressRouteTemplate,
  getExpressRuntime,
  netgreenerExpressMiddleware,
  UNKNOWN_ROUTE_TEMPLATE,
  type ExpressRequest,
  type ExpressResponse,
} from '../express.js'
import { attributionServiceUnit } from '../requestContext.js'
import {
  getTenantContext,
  runWithTenantContext,
  setTenantContext,
} from '../tenantContext.js'
import { _resetOutboundInstrumentationForTests } from '../externalApiMeter.js'
import { _resetRuntimeForTests } from '../runtime.js'
import type { RunSessionCreatePayload } from '../uploader.js'
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

const realFetch = globalThis.fetch

after(() => {
  restoreEnv()
  globalThis.fetch = realFetch
  _resetOutboundInstrumentationForTests()
  _resetRuntimeForTests()
})

afterEach(() => {
  restoreEnv()
  globalThis.fetch = realFetch
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

function makeRes(): {
  res: ExpressResponse
  listeners: Map<string, Array<(...args: unknown[]) => void>>
  emit: (event: string) => void
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const res: ExpressResponse = {
    statusCode: 200,
    on: (event, listener) => {
      const list = listeners.get(event) || []
      list.push(listener)
      listeners.set(event, list)
      return res
    },
  }
  return {
    res,
    listeners,
    emit: (event: string) => {
      for (const listener of listeners.get(event) || []) listener()
    },
  }
}

test('uses the registered Express route template without raw request values', () => {
  const template = expressRouteTemplate({
    route: { path: '/users/:userId/orders/:orderId' },
    baseUrl: '/tenants/customer-123',
    path: '/users/alice/orders/private-order',
    url: '/users/alice/orders/private-order?token=secret',
  })

  assert.equal(template, '/users/:userId/orders/:orderId')
  assert.equal(template.includes('alice'), false)
  assert.equal(template.includes('customer-123'), false)
  assert.equal(template.includes('secret'), false)
})

test('uses one bounded bucket when Express has no route template', () => {
  assert.equal(
    expressRouteTemplate({
      path: '/customers/alice',
      url: '/customers/alice?token=secret',
    }),
    UNKNOWN_ROUTE_TEMPLATE,
  )
})

test('rejects malformed or unbounded route template values', () => {
  assert.equal(expressRouteTemplate({ route: { path: '' } }), UNKNOWN_ROUTE_TEMPLATE)
  assert.equal(
    expressRouteTemplate({ route: { path: '/search?query=:query' } }),
    UNKNOWN_ROUTE_TEMPLATE,
  )
  assert.equal(
    expressRouteTemplate({ route: { path: `/${'x'.repeat(512)}` } }),
    UNKNOWN_ROUTE_TEMPLATE,
  )
})

test('records finish and close as one bounded observation', async () => {
  const { res, emit } = makeRes()
  let nextCalls = 0
  let flushedPayload: RunSessionCreatePayload | undefined
  const middleware = netgreenerExpressMiddleware({
    config: testConfig(),
    onFlush: (_result, payload) => {
      flushedPayload = payload
    },
  })

  middleware(
    {
      method: 'get',
      route: { path: '/users/:userId' },
      path: '/users/customer-123',
      url: '/users/customer-123?token=secret',
    },
    res,
    () => {
      nextCalls += 1
    },
  )

  assert.equal(nextCalls, 1)
  emit('finish')
  emit('close')
  const result = await getExpressRuntime().flush('manual')

  assert.equal(result?.ok, true)
  assert.ok(flushedPayload)
  const runtime = flushedPayload.session_metadata.service_runtime_v0
  assert.ok(runtime)
  assert.equal(runtime.units.length, 1)
  assert.equal(runtime.units[0].calls, 1)
  assert.equal(runtime.units[0].service_unit, 'GET /users/:userId')
  assert.equal(JSON.stringify(runtime).includes('customer-123'), false)
  assert.equal(JSON.stringify(runtime).includes('secret'), false)
})

test('resolves route template after middleware entry when req.route appears late', async () => {
  const { res, emit } = makeRes()
  let flushedPayload: RunSessionCreatePayload | undefined
  const middleware = netgreenerExpressMiddleware({
    config: testConfig(),
    onFlush: (_result, payload) => {
      flushedPayload = payload
    },
  })

  const req: ExpressRequest = {
    method: 'POST',
    path: '/v1/documents/doc-secret-99/ocr',
    url: '/v1/documents/doc-secret-99/ocr?token=leak',
  }

  let seenDuringHandler: string | null = null
  middleware(req, res, () => {
    // Express attaches route after middleware entry, before the handler finishes.
    req.route = { path: '/v1/documents/:id/ocr' }
    seenDuringHandler = attributionServiceUnit()
  })

  assert.equal(seenDuringHandler, 'POST /v1/documents/:id/ocr')
  emit('finish')
  emit('close')
  await getExpressRuntime().flush('manual')

  const runtime = flushedPayload?.session_metadata.service_runtime_v0
  assert.ok(runtime)
  assert.equal(runtime.units[0].service_unit, 'POST /v1/documents/:id/ocr')
  assert.equal(JSON.stringify(runtime).includes('doc-secret-99'), false)
  assert.equal(JSON.stringify(runtime).includes('leak'), false)
})

test('never meters raw path when route never becomes available', async () => {
  const { res, emit } = makeRes()
  let flushedPayload: RunSessionCreatePayload | undefined
  const middleware = netgreenerExpressMiddleware({
    config: testConfig(),
    onFlush: (_result, payload) => {
      flushedPayload = payload
    },
  })

  middleware(
    {
      method: 'GET',
      path: '/customers/alice/private',
      url: '/customers/alice/private?token=secret',
    },
    res,
    () => undefined,
  )
  emit('finish')
  await getExpressRuntime().flush('manual')

  const runtime = flushedPayload?.session_metadata.service_runtime_v0
  assert.ok(runtime)
  assert.equal(runtime.units[0].service_unit, `GET ${UNKNOWN_ROUTE_TEMPLATE}`)
  assert.equal(JSON.stringify(runtime).includes('alice'), false)
  assert.equal(JSON.stringify(runtime).includes('secret'), false)
})

test('preserves sync handler errors and still records once', async () => {
  const { res, emit } = makeRes()
  let flushedPayload: RunSessionCreatePayload | undefined
  const middleware = netgreenerExpressMiddleware({
    config: testConfig(),
    onFlush: (_result, payload) => {
      flushedPayload = payload
    },
  })

  const req: ExpressRequest = {
    method: 'GET',
    path: '/boom/raw-id',
  }

  assert.throws(
    () => {
      middleware(req, res, () => {
        req.route = { path: '/boom' }
        throw new Error('handler failed')
      })
    },
    /handler failed/,
  )

  // App / error middleware may set status before finish/close; do not freeze 200 at throw.
  res.statusCode = 500
  emit('finish')
  emit('close')
  await getExpressRuntime().flush('manual')
  const runtime = flushedPayload?.session_metadata.service_runtime_v0
  assert.ok(runtime)
  assert.equal(runtime.units.length, 1)
  assert.equal(runtime.units[0].calls, 1)
  assert.equal(runtime.units[0].errors, 1)
  assert.equal(runtime.units[0].service_unit, 'GET /boom')
})

test('overlapping requests keep distinct tenants and do not inherit tenantless scope', async () => {
  process.env.NETGREENER_TENANT_SOURCE = 'header'
  process.env.NETGREENER_TENANT_HEADER = 'X-Organization-Id'

  const events: string[] = []
  let flushedPayload: RunSessionCreatePayload | undefined
  const middleware = netgreenerExpressMiddleware({
    config: {
      ...testConfig(),
      tenantSource: 'header',
      tenantHeader: 'X-Organization-Id',
    },
    onFlush: (_result, payload) => {
      flushedPayload = payload
    },
  })

  const a = makeRes()
  const b = makeRes()
  const none = makeRes()

  let aReady!: () => void
  const aReadyP = new Promise<void>((resolve) => {
    aReady = resolve
  })
  let continueA!: () => void
  const continueAP = new Promise<void>((resolve) => {
    continueA = resolve
  })

  const done: Promise<void>[] = []

  middleware(
    {
      method: 'GET',
      route: { path: '/a' },
      path: '/a/raw-a',
      headers: { 'X-Organization-Id': 'org_acme' },
    },
    a.res,
    () => {
      done.push(
        (async () => {
          events.push(`a-enter:${getTenantContext()?.tenantId ?? 'none'}`)
          assert.equal(getTenantContext()?.tenantId, 'org_acme')
          aReady()
          await continueAP
          events.push(`a-exit:${getTenantContext()?.tenantId ?? 'none'}`)
          assert.equal(getTenantContext()?.tenantId, 'org_acme')
        })(),
      )
    },
  )

  await aReadyP

  middleware(
    {
      method: 'GET',
      route: { path: '/b' },
      path: '/b/raw-b',
      headers: { 'X-Organization-Id': 'org_beta' },
    },
    b.res,
    () => {
      done.push(
        (async () => {
          events.push(`b-enter:${getTenantContext()?.tenantId ?? 'none'}`)
          assert.equal(getTenantContext()?.tenantId, 'org_beta')
          assert.notEqual(getTenantContext()?.tenantId, 'org_acme')
          continueA()
          events.push(`b-exit:${getTenantContext()?.tenantId ?? 'none'}`)
          assert.equal(getTenantContext()?.tenantId, 'org_beta')
        })(),
      )
    },
  )

  middleware(
    {
      method: 'GET',
      route: { path: '/public' },
      path: '/public/raw',
      headers: {},
    },
    none.res,
    () => {
      done.push(
        (async () => {
          events.push(`none:${getTenantContext()?.tenantId ?? 'none'}`)
          assert.equal(getTenantContext(), null)
        })(),
      )
    },
  )

  await Promise.all(done)

  b.emit('finish')
  a.emit('finish')
  none.emit('finish')
  a.emit('close')
  b.emit('close')
  none.emit('close')

  await getExpressRuntime().flush('manual')
  const runtime = flushedPayload?.session_metadata.service_runtime_v0
  assert.ok(runtime)
  assert.equal(runtime.by_tenant?.org_acme?.calls, 1)
  assert.equal(runtime.by_tenant?.org_beta?.calls, 1)
  // Deterministic interleave checkpoints (relative order may vary for tenantless).
  assert.ok(events.includes('a-enter:org_acme'))
  assert.ok(events.includes('a-exit:org_acme'))
  assert.ok(events.includes('b-enter:org_beta'))
  assert.ok(events.includes('b-exit:org_beta'))
  assert.ok(events.includes('none:none'))
  assert.ok(events.indexOf('a-enter:org_acme') < events.indexOf('b-enter:org_beta'))
  assert.ok(events.indexOf('b-enter:org_beta') < events.indexOf('a-exit:org_acme'))

  const units = new Set(runtime.units.map((u) => u.service_unit))
  assert.ok(units.has('GET /a'))
  assert.ok(units.has('GET /b'))
  assert.ok(units.has('GET /public'))
  assert.equal(JSON.stringify(runtime).includes('raw-a'), false)
  assert.equal(JSON.stringify(runtime).includes('raw-b'), false)
})

test('nested outbound fetch inherits request tenant and late route unit', async () => {
  process.env.NETGREENER_TENANT_SOURCE = 'header'
  process.env.NETGREENER_TENANT_HEADER = 'X-Organization-Id'

  // Install the stub before middleware wraps fetch for metering.
  const prevFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch

  _resetOutboundInstrumentationForTests()
  _resetRuntimeForTests()

  try {
    const { res, emit } = makeRes()
    let flushedPayload: RunSessionCreatePayload | undefined
    const middleware = netgreenerExpressMiddleware({
      config: {
        ...testConfig(),
        tenantSource: 'header',
        tenantHeader: 'X-Organization-Id',
      },
      onFlush: (_result, payload) => {
        flushedPayload = payload
      },
    })

    const req: ExpressRequest = {
      method: 'POST',
      path: '/ocr/doc-99',
      headers: { 'X-Organization-Id': 'org_acme' },
    }

    await new Promise<void>((resolve, reject) => {
      middleware(req, res, () => {
        try {
          req.route = { path: '/ocr/:docId' }
          assert.equal(getTenantContext()?.tenantId, 'org_acme')
          assert.equal(attributionServiceUnit(), 'POST /ocr/:docId')
          void fetch('https://api.openai.com/v1/chat/completions').then(() => resolve(), reject)
        } catch (err) {
          reject(err)
        }
      })
    })

    emit('finish')
    await getExpressRuntime().flush('manual')

    const meta = flushedPayload?.session_metadata
    assert.ok(meta?.external_api_v0?.by_tenant?.org_acme)
    const byUnit = meta?.external_api_v0?.by_service_unit || {}
    assert.ok(byUnit['POST /ocr/:docId'])
    assert.equal(JSON.stringify(meta).includes('doc-99'), false)
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('manual setTenantContext after async auth survives finish inside and outside ALS', async () => {
  process.env.NETGREENER_TENANT_SOURCE = 'none'
  delete process.env.NETGREENER_TENANT_HEADER

  let flushedPayload: RunSessionCreatePayload | undefined
  const middleware = netgreenerExpressMiddleware({
    config: testConfig(),
    onFlush: (_result, payload) => {
      flushedPayload = payload
    },
  })

  // Case A: finish while still inside the bound request scope.
  const inside = makeRes()
  let duringHandler: string | null = null
  middleware({ method: 'GET', route: { path: '/documents/:id' } }, inside.res, () => {
    setTenantContext({ tenantId: 'org_manual', tenantSource: 'verified-auth' })
    duringHandler = getTenantContext()?.tenantId ?? null
    inside.emit('finish')
  })
  await getExpressRuntime().flush('manual')
  assert.equal(duringHandler, 'org_manual')
  const runtimeInside = flushedPayload?.session_metadata.service_runtime_v0
  assert.equal(runtimeInside?.by_tenant?.org_manual?.calls, 1)

  // Case B: bind after simulated async auth, then finish after request ALS exits.
  _resetOutboundInstrumentationForTests()
  _resetRuntimeForTests()
  let flushedOutside: RunSessionCreatePayload | undefined
  const outside = makeRes()
  let authDone!: () => void
  const authDoneP = new Promise<void>((resolve) => {
    authDone = resolve
  })
  const middlewareOutside = netgreenerExpressMiddleware({
    config: testConfig(),
    onFlush: (_result, payload) => {
      flushedOutside = payload
    },
  })
  middlewareOutside({ method: 'POST', route: { path: '/documents/:id' } }, outside.res, () => {
    void Promise.resolve().then(() => {
      setTenantContext({ tenantId: 'org_manual_out', tenantSource: 'verified-auth' })
      authDone()
    })
  })
  await authDoneP
  assert.equal(getTenantContext(), null, 'request ALS must have exited before finish')
  outside.emit('finish')
  outside.emit('close')
  await getExpressRuntime().flush('manual')
  const runtimeOutside = flushedOutside?.session_metadata.service_runtime_v0
  assert.equal(runtimeOutside?.by_tenant?.org_manual_out?.calls, 1)
})

test('programmatic tenant config wins over conflicting ambient env', async () => {
  process.env.NETGREENER_TENANT_SOURCE = 'none'
  process.env.NETGREENER_TENANT_HEADER = 'X-Wrong-Header'

  const { res, emit } = makeRes()
  let flushedPayload: RunSessionCreatePayload | undefined
  let handlerTenant: string | null = null
  const middleware = netgreenerExpressMiddleware({
    config: {
      ...testConfig(),
      tenantSource: 'header',
      tenantHeader: 'X-Organization-Id',
    },
    onFlush: (_result, payload) => {
      flushedPayload = payload
    },
  })

  middleware(
    {
      method: 'GET',
      route: { path: '/configured/:id' },
      headers: { 'x-organization-id': 'org_config' },
    },
    res,
    () => {
      handlerTenant = getTenantContext()?.tenantId ?? null
    },
  )
  emit('finish')
  emit('close')
  await getExpressRuntime().flush('manual')

  const runtime = flushedPayload?.session_metadata.service_runtime_v0
  assert.equal(handlerTenant, 'org_config')
  assert.equal(runtime?.by_tenant?.org_config?.calls, 1)
  assert.equal(runtime?.units.reduce((n, u) => n + u.calls, 0), 1)
})

test('tenantless request under outer ALS does not inherit outer tenant', async () => {
  process.env.NETGREENER_TENANT_SOURCE = 'header'
  process.env.NETGREENER_TENANT_HEADER = 'X-Organization-Id'

  const { res, emit } = makeRes()
  let flushedPayload: RunSessionCreatePayload | undefined
  let handlerTenant: string | null | undefined = 'unset'
  const middleware = netgreenerExpressMiddleware({
    config: {
      ...testConfig(),
      tenantSource: 'header',
      tenantHeader: 'X-Organization-Id',
    },
    onFlush: (_result, payload) => {
      flushedPayload = payload
    },
  })

  runWithTenantContext({ tenantId: 'org_outer', tenantSource: 'manual' }, () => {
    middleware(
      {
        method: 'GET',
        route: { path: '/public' },
        headers: {},
      },
      res,
      () => {
        handlerTenant = getTenantContext()?.tenantId ?? null
      },
    )
  })
  emit('finish')
  await getExpressRuntime().flush('manual')

  assert.equal(handlerTenant, null)
  const runtime = flushedPayload?.session_metadata.service_runtime_v0
  assert.ok(runtime)
  assert.equal(runtime.by_tenant?.org_outer, undefined)
  assert.equal(runtime.units.reduce((n, u) => n + u.calls, 0), 1)
})

test('outbound attribution snapshots route at call entry while route mutates', async () => {
  let completeFetch!: (value: Response) => void
  let fetchCalls = 0
  const prevFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    fetchCalls += 1
    return new Promise<Response>((resolve) => {
      completeFetch = resolve
    })
  }) as typeof fetch

  _resetOutboundInstrumentationForTests()
  _resetRuntimeForTests()

  try {
    const { res, emit } = makeRes()
    let flushedPayload: RunSessionCreatePayload | undefined
    const middleware = netgreenerExpressMiddleware({
      config: testConfig(),
      onFlush: (_result, payload) => {
        flushedPayload = payload
      },
    })

    const req: ExpressRequest = { method: 'GET', route: { path: '/first/:id' } }
    let pendingFetch!: Promise<Response>
    middleware(req, res, () => {
      pendingFetch = fetch('https://api.openai.com/v1/chat/completions')
      req.route = { path: '/second/:id' }
    })

    assert.equal(typeof completeFetch, 'function')
    completeFetch(
      new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await pendingFetch
    emit('finish')
    emit('close')
    await getExpressRuntime().flush('manual')

    const external = flushedPayload?.session_metadata.external_api_v0
    assert.equal(fetchCalls, 1)
    assert.deepEqual(Object.keys(external?.by_service_unit ?? {}).sort(), ['GET /first/:id'])
    assert.ok(external?.by_service_unit?.['GET /first/:id'])
    // HTTP completion may use the later route; outbound must not.
    const runtime = flushedPayload?.session_metadata.service_runtime_v0
    assert.equal(runtime?.units[0]?.service_unit, 'GET /second/:id')
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('tenantless outbound snapshot survives later auth binding', async () => {
  process.env.NETGREENER_TENANT_SOURCE = 'none'
  let completeFetch!: (value: Response) => void
  const prevFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Promise<Response>((resolve) => {
      completeFetch = resolve
    })) as typeof fetch

  _resetOutboundInstrumentationForTests()
  _resetRuntimeForTests()

  try {
    const { res, emit } = makeRes()
    let flushedPayload: RunSessionCreatePayload | undefined
    const middleware = netgreenerExpressMiddleware({
      config: testConfig(),
      onFlush: (_result, payload) => {
        flushedPayload = payload
      },
    })

    let pendingFetch!: Promise<Response>
    middleware({ method: 'GET', route: { path: '/pending/:id' } }, res, () => {
      pendingFetch = fetch('https://api.openai.com/v1/chat/completions')
      setTenantContext({ tenantId: 'org_late', tenantSource: 'verified-auth' })
    })

    completeFetch(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    await pendingFetch
    emit('finish')
    emit('close')
    await getExpressRuntime().flush('manual')

    const meta = flushedPayload?.session_metadata
    assert.deepEqual(Object.keys(meta?.external_api_v0?.by_tenant ?? {}).sort(), [])
    assert.deepEqual(Object.keys(meta?.service_runtime_v0?.by_tenant ?? {}).sort(), ['org_late'])
  } finally {
    globalThis.fetch = prevFetch
  }
})
