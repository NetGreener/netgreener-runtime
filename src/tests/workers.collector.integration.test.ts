/**
 * BullMQ + process → MP2 opt-in collector path (not default).
 *
 * Twin of ``express.collector.integration.test.ts`` for N3 workers/scripts.
 * Default ``direct`` upload is unchanged. Dry-run skips IPC; this suite uses
 * dryRun=false + mock peer.
 */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { createServer, type Server } from 'node:net'

import { encodeCollectorFrame } from '../collectorIpc.js'
import {
  getBullMqRuntime,
  netgreenerBullMqProcessor,
} from '../bullmq.js'
import { clearExternalAggregator } from '../externalApiMeter.js'
import type { ExportResult } from '../exporter.js'
import {
  flushProcessRuntime,
  runWithProcessTenant,
  startProcessRuntime,
} from '../processRuntime.js'
import { _resetRuntimeForTests } from '../runtime.js'
import { DEFAULT_TENANT_RUNTIME_FIELDS } from '../tenantDefaults.js'

const ENV_KEYS = [
  'NETGREENER_TENANT_SOURCE',
  'NETGREENER_TENANT_TASK_KWARG',
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

after(() => {
  restoreEnv()
  clearExternalAggregator()
  _resetRuntimeForTests()
})

afterEach(() => {
  restoreEnv()
  clearExternalAggregator()
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
    tenantSource: 'task_kwarg',
    ...overrides,
  }
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
        const response = handler(request)
        socket.write(encodeCollectorFrame(response))
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
  process.env.NETGREENER_SERVICE_RUNTIME = '1'
  process.env.NETGREENER_TOKEN = 'test-token'
  process.env.NETGREENER_PROJECT_ID = '1'
}

test('bullmq job flush spools run_session_window over opt-in collector IPC', async () => {
  let seen: Record<string, unknown> | undefined
  await withMockCollector((request) => {
    seen = request
    assert.equal(request.kind, 'run_session_window')
    assert.equal(request.emitter, 'netgreener_node')
    assert.equal(request.export_mode, 'collector')
    const meta = request.session_metadata as {
      service_runtime_v0?: {
        collector?: string
        framework?: string
        units?: Array<{ service_unit: string; unit_type: string }>
      }
    }
    assert.equal(meta.service_runtime_v0?.collector, 'bullmq_worker')
    assert.equal(meta.service_runtime_v0?.framework, 'bullmq')
    assert.ok(
      meta.service_runtime_v0?.units?.some(
        (u) => u.service_unit === 'task:analyze_document' && u.unit_type === 'task',
      ),
    )
    return { ok: true, event_id: String(request.event_id) }
  }, async (endpoint) => {
    armCollectorEnv(endpoint)
    process.env.NETGREENER_TENANT_SOURCE = 'task_kwarg'
    process.env.NETGREENER_TENANT_TASK_KWARG = 'organization_id'
    clearExternalAggregator()
    _resetRuntimeForTests()

    const wrapped = netgreenerBullMqProcessor(
      async () => ({ ok: true }),
      { config: testConfig() },
    )
    await wrapped({
      id: '1',
      name: 'analyze_document',
      data: { organization_id: 'org_acme' },
    })

    const result = await getBullMqRuntime().flush('manual')
    assert.ok(result)
    assert.equal(result.ok, true, result.ok ? 'ok' : String(result.error))
    assert.equal((result as ExportResult).mode, 'collector')
    assert.equal((result as ExportResult).durabilityGrade, 'durable_sibling_spool')
    assert.ok((result as ExportResult).collectorEventId)
    assert.ok(seen)

    const second = await getBullMqRuntime().flush('manual')
    assert.equal(second, null)
  })
})

test('bullmq collector flush fails closed when peer is down (no silent direct)', async () => {
  armCollectorEnv('tcp://127.0.0.1:1')
  process.env.NETGREENER_EMIT_TIMEOUT_MS = '200'
  clearExternalAggregator()
  _resetRuntimeForTests()

  const wrapped = netgreenerBullMqProcessor(
    async () => ({ ok: true }),
    { config: testConfig() },
  )
  await wrapped({ id: '1', name: 'fail_closed', data: {} })

  const first = await getBullMqRuntime().flush('manual')
  assert.ok(first)
  assert.equal(first.ok, false)
  assert.match(String(first.error), /collector IPC failed/)
  assert.equal((first as ExportResult).mode, 'collector')

  const second = await getBullMqRuntime().flush('manual')
  assert.ok(second)
  assert.equal(second.ok, false)
  assert.equal((second as ExportResult).mode, 'collector')
})

test('process runtime flush spools run_session_window over opt-in collector IPC', async () => {
  let seen: Record<string, unknown> | undefined
  await withMockCollector((request) => {
    seen = request
    assert.equal(request.kind, 'run_session_window')
    assert.equal(request.emitter, 'netgreener_node')
    const meta = request.session_metadata as {
      service_runtime_v0?: {
        collector?: string
        framework?: string
        units?: Array<{ service_unit: string; unit_type: string }>
        by_tenant?: Record<string, { calls: number }>
      }
    }
    assert.equal(meta.service_runtime_v0?.collector, 'node_process')
    assert.equal(meta.service_runtime_v0?.framework, 'node')
    assert.ok(
      meta.service_runtime_v0?.units?.some(
        (u) => u.service_unit === 'task:nightly_report' && u.unit_type === 'task',
      ),
    )
    assert.equal(meta.service_runtime_v0?.by_tenant?.org_acme?.calls, 1)
    return { ok: true, event_id: String(request.event_id) }
  }, async (endpoint) => {
    armCollectorEnv(endpoint)
    clearExternalAggregator()
    _resetRuntimeForTests()

    startProcessRuntime({ config: testConfig({ tenantSource: 'none' }) })
    await runWithProcessTenant('org_acme', async () => ({ ok: true }), {
      serviceUnit: 'task:nightly_report',
    })

    const result = await flushProcessRuntime('manual')
    assert.ok(result)
    assert.equal(result.ok, true, result.ok ? 'ok' : String(result.error))
    assert.equal((result as ExportResult).mode, 'collector')
    assert.ok((result as ExportResult).collectorEventId)
    assert.ok(seen)

    const second = await flushProcessRuntime('manual')
    assert.equal(second, null)
  })
})
