/**
 * Nest-via-adapter → MP2 opt-in collector path (not default).
 *
 * Uses Nest Express middleware on a real Express loopback (no hard @nestjs dep).
 * Proves ``nest_express_middleware`` metadata over collector IPC.
 */
import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createNetServer, type Server as NetServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { Express, RequestHandler } from 'express'

import { encodeCollectorFrame } from '../collectorIpc.js'
import {
  applyNetGreenerNestHooks,
  getNestRuntime,
  netgreenerNestExpressMiddleware,
} from '../nest.js'
import { _resetOutboundInstrumentationForTests } from '../externalApiMeter.js'
import type { ExportResult } from '../exporter.js'
import { _resetRuntimeForTests } from '../runtime.js'
import { DEFAULT_TENANT_RUNTIME_FIELDS } from '../tenantDefaults.js'

const ENV_KEYS = [
  'NETGREENER_SERVICE_RUNTIME',
  'NETGREENER_TOKEN',
  'NETGREENER_PROJECT_ID',
  'NETGREENER_RUNTIME_DRY_RUN',
  'NETGREENER_EXPORT_MODE',
  'NETGREENER_COLLECTOR_ENDPOINT',
  'NETGREENER_EMIT_TIMEOUT_MS',
] as const

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}
for (const key of ENV_KEYS) {
  savedEnv[key] = process.env[key]
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const previous = savedEnv[key]
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
}

type ExpressFactory = {
  (): Express
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
  _resetOutboundInstrumentationForTests()
  _resetRuntimeForTests()
})

afterEach(() => {
  restoreEnv()
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
    dryRun: false,
    deployEnvironment: 'test',
    releaseTag: null,
    estimateTdpWatts: 65,
    ...DEFAULT_TENANT_RUNTIME_FIELDS,
    ...overrides,
  }
}

function skipWithoutExpress(t: { skip: (msg?: string) => void }): boolean {
  if (createExpress) return false
  t.skip('express not installed as a local dev dependency')
  return true
}

async function listen(app: Express): Promise<{ server: HttpServer; baseUrl: string }> {
  const server = createHttpServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, baseUrl: `http://127.0.0.1:${port}` }
}

async function closeHttp(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
}

async function withMockCollector(
  handler: (request: Record<string, unknown>) => Record<string, unknown>,
  fn: (endpoint: string) => Promise<void>,
): Promise<void> {
  const server: NetServer = createNetServer((socket) => {
    const chunks: Buffer[] = []
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const buf = Buffer.concat(chunks)
      if (buf.length < 4) return
      const length = buf.readUInt32BE(0)
      if (buf.length < 4 + length) return
      chunks.length = 0
      const rest = buf.subarray(4 + length)
      if (rest.length) chunks.push(rest)
      try {
        const request = JSON.parse(buf.subarray(4, 4 + length).toString('utf8')) as Record<
          string,
          unknown
        >
        socket.write(encodeCollectorFrame(handler(request)))
      } catch {
        socket.destroy()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const endpoint = `tcp://127.0.0.1:${address.port}`
  try {
    await fn(endpoint)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  }
}

test('nest Express middleware flush spools over opt-in collector IPC', async (t) => {
  if (skipWithoutExpress(t)) return
  const express = createExpress!

  let seen: Record<string, unknown> | undefined
  await withMockCollector((request) => {
    seen = request
    assert.equal(request.kind, 'run_session_window')
    assert.equal(request.emitter, 'netgreener_node')
    const meta = request.session_metadata as {
      service_runtime_v0?: { collector?: string; framework?: string; units?: Array<{ service_unit: string }> }
    }
    assert.equal(meta.service_runtime_v0?.collector, 'nest_express_middleware')
    assert.equal(meta.service_runtime_v0?.framework, 'nest')
    assert.ok(meta.service_runtime_v0?.units?.some((u) => u.service_unit === 'GET /health'))
    return { ok: true, event_id: String(request.event_id) }
  }, async (endpoint) => {
    process.env.NETGREENER_EXPORT_MODE = 'collector'
    process.env.NETGREENER_COLLECTOR_ENDPOINT = endpoint
    process.env.NETGREENER_EMIT_TIMEOUT_MS = '2000'
    delete process.env.NETGREENER_RUNTIME_DRY_RUN

    _resetOutboundInstrumentationForTests()
    _resetRuntimeForTests()

    const app = express()
    app.use(
      netgreenerNestExpressMiddleware({
        config: testConfig(),
      }) as unknown as RequestHandler,
    )
    app.get('/health', (_req, res) => {
      res.status(200).json({ ok: true })
    })

    const { server, baseUrl } = await listen(app)
    try {
      const res = await fetch(`${baseUrl}/health`)
      assert.equal(res.status, 200)

      const result = await getNestRuntime('express').flush('manual')
      assert.ok(result)
      assert.equal(result.ok, true, result.ok ? 'ok' : String(result.error))
      assert.equal((result as ExportResult).mode, 'collector')
      assert.ok((result as ExportResult).collectorEventId)
      assert.ok(seen)
    } finally {
      await closeHttp(server)
    }
  })
})

test('applyNetGreenerNestHooks Express path flushes via collector IPC', async (t) => {
  if (skipWithoutExpress(t)) return
  const express = createExpress!

  let seen: Record<string, unknown> | undefined
  await withMockCollector((request) => {
    seen = request
    const meta = request.session_metadata as {
      service_runtime_v0?: { collector?: string }
    }
    assert.equal(meta.service_runtime_v0?.collector, 'nest_express_middleware')
    return { ok: true, event_id: String(request.event_id) }
  }, async (endpoint) => {
    process.env.NETGREENER_EXPORT_MODE = 'collector'
    process.env.NETGREENER_COLLECTOR_ENDPOINT = endpoint
    process.env.NETGREENER_EMIT_TIMEOUT_MS = '2000'
    delete process.env.NETGREENER_RUNTIME_DRY_RUN

    _resetOutboundInstrumentationForTests()
    _resetRuntimeForTests()

    const app = express()
    const nestLike = {
      getHttpAdapter: () => ({ getType: () => 'express' }),
      use: (mw: unknown) => {
        app.use(mw as RequestHandler)
      },
    }
    const kind = await applyNetGreenerNestHooks(nestLike, { config: testConfig() })
    assert.equal(kind, 'express')

    app.get('/ready', (_req, res) => {
      res.status(200).json({ ok: true })
    })

    const { server, baseUrl } = await listen(app)
    try {
      const res = await fetch(`${baseUrl}/ready`)
      assert.equal(res.status, 200)

      const result = await getNestRuntime('express').flush('manual')
      assert.ok(result)
      assert.equal(result.ok, true, result.ok ? 'ok' : String(result.error))
      assert.equal((result as ExportResult).mode, 'collector')
      assert.ok(seen)
    } finally {
      await closeHttp(server)
    }
  })
})
