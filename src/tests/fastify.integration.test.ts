/**
 * Real Fastify loopback integration (dry-run flushes, stubbed outbound).
 * Requires the optional Fastify peer installed as a local dev dependency.
 */
import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import type { AddressInfo } from 'node:net'

import {
  bindFastifyTenant,
  getFastifyRuntime,
  netgreenerFastifyPlugin,
} from '../fastify.js'
import { UNKNOWN_ROUTE_TEMPLATE } from '../express.js'
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

type FastifyInstance = {
  register: (plugin: unknown, opts?: unknown) => Promise<unknown> | unknown
  get: (path: string, handler: (...args: unknown[]) => unknown) => unknown
  listen: (opts: { port: number; host: string }) => Promise<string>
  close: () => Promise<void>
  server: { address: () => AddressInfo | string | null }
}

type FastifyFactory = (opts?: { logger?: boolean }) => FastifyInstance

let createFastify: FastifyFactory | null = null

before(async () => {
  try {
    const mod = await import('fastify')
    createFastify = (mod.default ?? mod) as FastifyFactory
  } catch {
    createFastify = null
  }
})

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

function testConfig(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  }
}

function skipWithoutFastify(t: { skip: (msg?: string) => void }): boolean {
  if (createFastify) return false
  t.skip('fastify not installed as a local dev dependency')
  return true
}

test('fastify loopback: manual auth, overlap, prefix, 404, errors, once-only', async (t) => {
  if (skipWithoutFastify(t)) return
  const Fastify = createFastify!

  process.env.NETGREENER_TENANT_SOURCE = 'none'
  _resetOutboundInstrumentationForTests()
  _resetRuntimeForTests()
  let flushedPayload: RunSessionCreatePayload | undefined
  let outboundHits = 0

  globalThis.fetch = (async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url
    if (url.startsWith('http://127.0.0.1')) {
      return realFetch(input as RequestInfo, init)
    }
    outboundHits += 1
    return new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  const app = Fastify({ logger: false })
  await app.register(
    netgreenerFastifyPlugin({
      config: {
        ...testConfig(),
        tenantSource: 'header',
        tenantHeader: 'X-Organization-Id',
      },
      onFlush: (_result, payload) => {
        flushedPayload = payload
      },
    }),
  )

  await app.register(
    async (scoped: FastifyInstance) => {
      scoped.get('/items/:id', async (request: unknown) => {
        const req = request as { params?: { id?: string } }
        await fetch('https://api.openai.com/v1/chat/completions')
        return { ok: true, id: req.params?.id }
      })
    },
    { prefix: '/api/v1' },
  )

  app.get('/manual', async (request) => {
    bindFastifyTenant(request as object, {
      tenantId: 'org_manual',
      tenantSource: 'verified-auth',
    })
    return { ok: true }
  })

  app.get('/tenant', async () => ({ ok: true }))

  app.get('/boom', async (_request, reply) => {
    const r = reply as { code: (n: number) => { send: (b: unknown) => unknown } }
    return r.code(500).send({ error: 'boom' })
  })

  // Late-bound route: registered after the plugin is already attached.
  app.get('/late/:id', async (request: unknown) => {
    const req = request as { params?: { id?: string } }
    return { id: req.params?.id }
  })

  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${addr.port}`

  try {
    const headersAcme = { 'X-Organization-Id': 'org_acme' }
    const headersBeta = { 'X-Organization-Id': 'org_beta' }

    const [manual, a, b, none, mountedOk, late, missing, boom] = await Promise.all([
      fetch(`${baseUrl}/manual`),
      fetch(`${baseUrl}/tenant`, { headers: headersAcme }),
      fetch(`${baseUrl}/tenant`, { headers: headersBeta }),
      fetch(`${baseUrl}/tenant`),
      fetch(`${baseUrl}/api/v1/items/doc-secret-99`, { headers: headersAcme }),
      fetch(`${baseUrl}/late/xyz`),
      fetch(`${baseUrl}/no-such-route`),
      fetch(`${baseUrl}/boom`),
    ])

    assert.equal(manual.status, 200)
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
    assert.equal(none.status, 200)
    assert.equal(mountedOk.status, 200)
    assert.equal(late.status, 200)
    assert.equal(missing.status, 404)
    assert.equal(boom.status, 500)
    assert.equal(outboundHits, 1)

    await getFastifyRuntime().flush('manual')
    const runtime = flushedPayload?.session_metadata.service_runtime_v0
    assert.ok(runtime)

    const byUnit = new Map(runtime.units.map((u) => [u.service_unit, u]))
    assert.equal(byUnit.get('GET /manual')?.calls, 1)
    assert.equal(byUnit.get('GET /tenant')?.calls, 3)
    // Fastify includes the register prefix in the route template.
    assert.equal(byUnit.get('GET /api/v1/items/:id')?.calls, 1)
    assert.equal(byUnit.get('GET /late/:id')?.calls, 1)
    assert.equal(byUnit.get(`GET ${UNKNOWN_ROUTE_TEMPLATE}`)?.calls, 1)
    assert.equal(byUnit.get('GET /boom')?.calls, 1)
    assert.equal(byUnit.get('GET /boom')?.errors, 1)

    assert.equal(runtime.by_tenant?.org_manual?.calls, 1)
    assert.equal(runtime.by_tenant?.org_acme?.calls, 2)
    assert.equal(runtime.by_tenant?.org_beta?.calls, 1)

    const external = flushedPayload?.session_metadata.external_api_v0
    assert.ok(external?.by_service_unit?.['GET /api/v1/items/:id'])
    assert.equal(external?.by_tenant?.org_acme?.calls, 1)
    assert.equal(JSON.stringify(flushedPayload).includes('doc-secret-99'), false)

    const second = await getFastifyRuntime().flush('manual')
    assert.equal(second, null)
  } finally {
    await app.close()
  }
})
