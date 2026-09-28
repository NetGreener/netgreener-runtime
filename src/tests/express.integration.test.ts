/**
 * Real Express loopback integration (dry-run flushes, stubbed outbound).
 * Requires the optional Express peer installed as a local dev dependency.
 */
import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Express, RequestHandler, Router } from 'express'

import {
  getExpressRuntime,
  netgreenerExpressMiddleware,
  UNKNOWN_ROUTE_TEMPLATE,
} from '../express.js'
import { setTenantContext } from '../tenantContext.js'
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

type ExpressFactory = {
  (): Express
  Router: () => Router
}

let createExpress: ExpressFactory | null = null

before(async () => {
  try {
    const mod = await import('express')
    createExpress = (mod.default ?? mod) as ExpressFactory
  } catch {
    createExpress = null
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

async function listen(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, baseUrl: `http://127.0.0.1:${port}` }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
}

function skipWithoutExpress(t: { skip: (msg?: string) => void }): boolean {
  if (createExpress) return false
  t.skip('express not installed as a local dev dependency')
  return true
}

test('express loopback: manual auth, overlap, mounts, 404, errors, once-only', async (t) => {
  if (skipWithoutExpress(t)) return
  const express = createExpress!

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

  const app = express()
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
  app.use(middleware as unknown as RequestHandler)

  const mounted = express.Router()
  mounted.get('/items/:id', async (req, res) => {
    assert.equal(req.route?.path, '/items/:id')
    await fetch('https://api.openai.com/v1/chat/completions')
    res.status(200).json({ ok: true, id: req.params.id })
  })
  app.use('/api/v1', mounted)

  app.get('/manual', (_req, res) => {
    setTenantContext({ tenantId: 'org_manual', tenantSource: 'verified-auth' })
    res.status(200).json({ ok: true })
  })

  app.get('/tenant', (_req, res) => {
    res.status(200).json({ ok: true })
  })

  app.get('/boom', (_req, res) => {
    res.status(500).json({ error: 'boom' })
  })

  // Late-bound route: register after middleware is already mounted.
  app.get('/late/:id', (req, res) => {
    res.status(200).json({ id: req.params.id })
  })

  const { server, baseUrl } = await listen(app)
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

    await getExpressRuntime().flush('manual')
    const runtime = flushedPayload?.session_metadata.service_runtime_v0
    assert.ok(runtime)

    const byUnit = new Map(runtime.units.map((u) => [u.service_unit, u]))
    assert.equal(byUnit.get('GET /manual')?.calls, 1)
    assert.equal(byUnit.get('GET /tenant')?.calls, 3)
    assert.equal(byUnit.get('GET /items/:id')?.calls, 1)
    assert.equal(byUnit.get('GET /late/:id')?.calls, 1)
    assert.equal(byUnit.get(`GET ${UNKNOWN_ROUTE_TEMPLATE}`)?.calls, 1)
    assert.equal(byUnit.get('GET /boom')?.calls, 1)
    assert.equal(byUnit.get('GET /boom')?.errors, 1)

    assert.equal(runtime.by_tenant?.org_manual?.calls, 1)
    assert.equal(runtime.by_tenant?.org_acme?.calls, 2)
    assert.equal(runtime.by_tenant?.org_beta?.calls, 1)

    const external = flushedPayload?.session_metadata.external_api_v0
    assert.ok(external?.by_service_unit?.['GET /items/:id'])
    assert.equal(external?.by_tenant?.org_acme?.calls, 1)
    assert.equal(JSON.stringify(flushedPayload).includes('doc-secret-99'), false)

    // Once-only: empty window after successful flush — no second payload.
    const second = await getExpressRuntime().flush('manual')
    assert.equal(second, null)
  } finally {
    await closeServer(server)
  }
})
