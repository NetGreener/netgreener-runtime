/**
 * Nest Fastify-adapter → MP2 opt-in collector path (not default).
 *
 * No hard @nestjs dep: duck-typed Nest app + real Fastify instance.
 * Proves ``nest_fastify_middleware`` metadata over collector IPC.
 */
import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import { createServer, type Server } from 'node:net'
import type { AddressInfo } from 'node:net'

import { encodeCollectorFrame } from '../collectorIpc.js'
import {
  applyNetGreenerNestHooks,
  getNestRuntime,
  netgreenerNestFastifyPlugin,
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

function skipWithoutFastify(t: { skip: (msg?: string) => void }): boolean {
  if (createFastify) return false
  t.skip('fastify not installed as a local dev dependency')
  return true
}

async function withMockCollector(
  handler: (request: Record<string, unknown>) => Record<string, unknown>,
  fn: (endpoint: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((socket) => {
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

function armCollectorEnv(endpoint: string): void {
  process.env.NETGREENER_EXPORT_MODE = 'collector'
  process.env.NETGREENER_COLLECTOR_ENDPOINT = endpoint
  process.env.NETGREENER_EMIT_TIMEOUT_MS = '2000'
  delete process.env.NETGREENER_RUNTIME_DRY_RUN
}

test('nest Fastify plugin flush spools over opt-in collector IPC', async (t) => {
  if (skipWithoutFastify(t)) return
  const Fastify = createFastify!

  let seen: Record<string, unknown> | undefined
  await withMockCollector((request) => {
    seen = request
    assert.equal(request.kind, 'run_session_window')
    assert.equal(request.emitter, 'netgreener_node')
    const meta = request.session_metadata as {
      service_runtime_v0?: {
        collector?: string
        framework?: string
        units?: Array<{ service_unit: string }>
      }
    }
    assert.equal(meta.service_runtime_v0?.collector, 'nest_fastify_middleware')
    assert.equal(meta.service_runtime_v0?.framework, 'nest')
    assert.ok(meta.service_runtime_v0?.units?.some((u) => u.service_unit === 'GET /health'))
    return { ok: true, event_id: String(request.event_id) }
  }, async (endpoint) => {
    armCollectorEnv(endpoint)
    _resetOutboundInstrumentationForTests()
    _resetRuntimeForTests()

    const app = Fastify({ logger: false })
    await app.register(netgreenerNestFastifyPlugin({ config: testConfig() }))
    app.get('/health', async () => ({ ok: true }))

    await app.listen({ port: 0, host: '127.0.0.1' })
    const addr = app.server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${addr.port}`
    try {
      const res = await fetch(`${baseUrl}/health`)
      assert.equal(res.status, 200)

      const result = await getNestRuntime('fastify').flush('manual')
      assert.ok(result)
      assert.equal(result.ok, true, result.ok ? 'ok' : String(result.error))
      assert.equal((result as ExportResult).mode, 'collector')
      assert.equal((result as ExportResult).durabilityGrade, 'durable_sibling_spool')
      assert.ok((result as ExportResult).collectorEventId)
      assert.ok(seen)

      const second = await getNestRuntime('fastify').flush('manual')
      assert.equal(second, null)
    } finally {
      await app.close()
    }
  })
})

test('applyNetGreenerNestHooks Fastify path flushes via collector IPC', async (t) => {
  if (skipWithoutFastify(t)) return
  const Fastify = createFastify!

  let seen: Record<string, unknown> | undefined
  await withMockCollector((request) => {
    seen = request
    const meta = request.session_metadata as {
      service_runtime_v0?: { collector?: string; framework?: string }
    }
    assert.equal(meta.service_runtime_v0?.collector, 'nest_fastify_middleware')
    assert.equal(meta.service_runtime_v0?.framework, 'nest')
    return { ok: true, event_id: String(request.event_id) }
  }, async (endpoint) => {
    armCollectorEnv(endpoint)
    _resetOutboundInstrumentationForTests()
    _resetRuntimeForTests()

    const app = Fastify({ logger: false })
    const nestLike = {
      getHttpAdapter: () => ({
        getType: () => 'fastify',
        getInstance: () => app,
      }),
    }
    const kind = await applyNetGreenerNestHooks(nestLike, { config: testConfig() })
    assert.equal(kind, 'fastify')

    app.get('/ready', async () => ({ ok: true }))

    await app.listen({ port: 0, host: '127.0.0.1' })
    const addr = app.server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${addr.port}`
    try {
      const res = await fetch(`${baseUrl}/ready`)
      assert.equal(res.status, 200)

      const result = await getNestRuntime('fastify').flush('manual')
      assert.ok(result)
      assert.equal(result.ok, true, result.ok ? 'ok' : String(result.error))
      assert.equal((result as ExportResult).mode, 'collector')
      assert.ok(seen)
    } finally {
      await app.close()
    }
  })
})
