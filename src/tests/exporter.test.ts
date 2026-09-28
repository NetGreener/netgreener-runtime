import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import { test } from 'node:test'

import {
  encodeCollectorFrame,
  normalizeCollectorEndpoint,
  sendCollectorEvent,
} from '../collectorIpc.js'
import {
  CollectorRunSessionExporter,
  DirectRunSessionExporter,
  ThinRunSessionExporter,
  canonicalPayloadDigest,
  exportModeFromEnv,
  resolveObservationExporter,
  runSessionShadowPayload,
  shadowCompareEnabled,
} from '../exporter.js'
import type { RuntimeConfig } from '../config.js'
import type { RunSessionCreatePayload } from '../uploader.js'

const config = {
  enabled: true,
  apiUrl: 'https://example.test',
  token: 't',
  projectId: 1,
  organizationId: null,
  flushIntervalMs: 60_000,
  dryRun: true,
  deployEnvironment: null,
  releaseTag: null,
  estimateTdpWatts: 65,
  tenantSource: 'none',
  tenantClaim: '',
  tenantHeader: '',
  tenantPathRegex: null,
  tenantTaskKwarg: '',
  tenantLabelClaim: null,
} satisfies RuntimeConfig

const payload: RunSessionCreatePayload = {
  project_id: 1,
  start_time: '2026-09-15T00:00:00.000Z',
  end_time: '2026-09-15T00:05:00.000Z',
  runtime_window_id: 'rtw_' + 'a'.repeat(64),
  session_metadata: {
    service_runtime_v0: {
      framework: 'express',
      collector: 'express_middleware',
      window_seconds: 60,
      attribution: 'cpu_share',
      accuracy: 'trend',
      units: [],
    },
  },
}

test('default export mode is direct', () => {
  assert.equal(exportModeFromEnv({}), 'direct')
  assert.equal(resolveObservationExporter({}).mode, 'direct')
})

test('direct exporter uses dry-run upload path', async () => {
  const exporter = new DirectRunSessionExporter()
  const result = await exporter.exportRunSessionWindow(config, payload)
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'direct')
  assert.equal(result.durabilityGrade, 'best_effort_in_process')
  assert.equal(result.dryRun, true)
})

test('thin exporter declares bounded durability', async () => {
  const exporter = new ThinRunSessionExporter()
  const result = await exporter.exportRunSessionWindow(config, payload)
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'thin')
  assert.equal(result.durabilityGrade, 'best_effort_bounded')
})

test('collector exporter fails closed without endpoint', async () => {
  const previous = process.env.NETGREENER_COLLECTOR_ENDPOINT
  delete process.env.NETGREENER_COLLECTOR_ENDPOINT
  try {
    const exporter = new CollectorRunSessionExporter()
    const result = await exporter.exportRunSessionWindow(
      { ...config, dryRun: false },
      payload,
    )
    assert.equal(result.ok, false)
    assert.equal(result.mode, 'collector')
    assert.match(String(result.error), /NETGREENER_COLLECTOR_ENDPOINT/)
  } finally {
    if (previous === undefined) delete process.env.NETGREENER_COLLECTOR_ENDPOINT
    else process.env.NETGREENER_COLLECTOR_ENDPOINT = previous
  }
})

test('normalize host:port to tcp://', () => {
  assert.equal(normalizeCollectorEndpoint('127.0.0.1:17999'), 'tcp://127.0.0.1:17999')
})

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

test('collector IPC round-trips length-prefixed JSON', async () => {
  await withMockCollector((request) => {
    assert.equal(request.kind, 'probe')
    return { ok: true, event_id: 'evt-probe' }
  }, async (endpoint) => {
    const ack = await sendCollectorEvent({
      endpoint,
      payload: { kind: 'probe', project_id: 1 },
      timeoutMs: 2000,
    })
    assert.equal(ack.ok, true)
    assert.equal(ack.event_id, 'evt-probe')
  })
})

test('collector exporter spools run_session_window over IPC', async () => {
  await withMockCollector((request) => {
    assert.equal(request.kind, 'run_session_window')
    assert.equal(request.project_id, 1)
    assert.equal(request.emitter, 'netgreener_node')
    assert.equal(request.runtime_window_id, payload.runtime_window_id)
    assert.ok(request.session_metadata)
    return { ok: true, event_id: String(request.event_id) }
  }, async (endpoint) => {
    const previous = process.env.NETGREENER_COLLECTOR_ENDPOINT
    process.env.NETGREENER_COLLECTOR_ENDPOINT = endpoint
    try {
      const exporter = resolveObservationExporter({
        NETGREENER_EXPORT_MODE: 'collector',
        NETGREENER_COLLECTOR_ENDPOINT: endpoint,
      })
      assert.equal(exporter.mode, 'collector')
      const result = await exporter.exportRunSessionWindow(
        { ...config, dryRun: false },
        payload,
      )
      assert.equal(result.ok, true, result.ok ? 'ok' : String(result.error))
      assert.equal(result.mode, 'collector')
      assert.equal(result.durabilityGrade, 'durable_sibling_spool')
      assert.ok(result.collectorEventId)
    } finally {
      if (previous === undefined) delete process.env.NETGREENER_COLLECTOR_ENDPOINT
      else process.env.NETGREENER_COLLECTOR_ENDPOINT = previous
    }
  })
})

test('collector exporter fails closed when peer is down', async () => {
  const previous = process.env.NETGREENER_COLLECTOR_ENDPOINT
  const previousTimeout = process.env.NETGREENER_EMIT_TIMEOUT_MS
  process.env.NETGREENER_COLLECTOR_ENDPOINT = 'tcp://127.0.0.1:1'
  process.env.NETGREENER_EMIT_TIMEOUT_MS = '200'
  try {
    const exporter = new CollectorRunSessionExporter()
    const result = await exporter.exportRunSessionWindow(
      { ...config, dryRun: false },
      payload,
    )
    assert.equal(result.ok, false)
    assert.match(String(result.error), /collector IPC failed/)
  } finally {
    if (previous === undefined) delete process.env.NETGREENER_COLLECTOR_ENDPOINT
    else process.env.NETGREENER_COLLECTOR_ENDPOINT = previous
    if (previousTimeout === undefined) delete process.env.NETGREENER_EMIT_TIMEOUT_MS
    else process.env.NETGREENER_EMIT_TIMEOUT_MS = previousTimeout
  }
})

const observationBatch = {
  schema_name: 'netgreener.observation.v1',
  schema_version: 1,
  contract_status: 'mp0_draft',
  batch_id: 'bat_' + 'a'.repeat(64),
  batch_sequence: '1',
  emitted_at: '2026-09-12T12:00:00Z',
  source: {
    language: 'typescript',
    runtime_name: 'node',
    runtime_version: '20.0.0',
    adapter_name: 'test-producer',
    adapter_version: '0.1.0',
    runtime_instance_id: 'rti_' + 'b'.repeat(64),
    capability_ids: ['CAP-R1', 'CAP-R2', 'CAP-R3', 'CAP-R4', 'CAP-R5'],
    deployment_mode: 'local',
  },
  routing: { project_id: 1, workload_id: 'sample', service_name: 'sample' },
  privacy: {
    content_capture: 'none',
    dimension_policy: 'allowlist',
    route_policy: 'template_or_unknown',
    dropped_dimension_count: 0,
  },
  events: [
    {
      record_type: 'adapter_health',
      facts: {
        component: 'adapter',
        status: 'ok',
        reason_codes: [],
        counters: { queue_depth: 0 },
      },
    },
  ],
  window: {
    window_id: 'win_' + 'c'.repeat(64),
    start_time: '2026-09-12T12:00:00Z',
    end_time: '2026-09-12T12:01:00Z',
    state: 'closed',
    clock_source: 'runtime_monotonic',
  },
}

test('direct observation batch export fails closed without inventing upload', async () => {
  const exporter = new DirectRunSessionExporter()
  const result = await exporter.exportObservationBatch(config, observationBatch)
  assert.equal(result.ok, false)
  assert.match(String(result.error), /stub-ready|not wired/)
})

test('collector observation batch spools over IPC', async () => {
  await withMockCollector((request) => {
    assert.equal(request.kind, 'observation_batch')
    assert.equal(request.project_id, 1)
    assert.ok(request.batch)
    return { ok: true, event_id: String(request.event_id) }
  }, async (endpoint) => {
    const previous = process.env.NETGREENER_COLLECTOR_ENDPOINT
    process.env.NETGREENER_COLLECTOR_ENDPOINT = endpoint
    try {
      const exporter = resolveObservationExporter({
        NETGREENER_EXPORT_MODE: 'collector',
        NETGREENER_COLLECTOR_ENDPOINT: endpoint,
      })
      const result = await exporter.exportObservationBatch(
        { ...config, dryRun: false },
        observationBatch,
      )
      assert.equal(result.ok, true, result.ok ? 'ok' : String(result.error))
      assert.equal(result.mode, 'collector')
      assert.ok(result.collectorEventId)
    } finally {
      if (previous === undefined) delete process.env.NETGREENER_COLLECTOR_ENDPOINT
      else process.env.NETGREENER_COLLECTOR_ENDPOINT = previous
    }
  })
})

test('shadow compare flag is opt-in', () => {
  assert.equal(shadowCompareEnabled({}), false)
  assert.equal(shadowCompareEnabled({ NETGREENER_MP2_SHADOW_COMPARE: '1' }), true)
  assert.equal(shadowCompareEnabled({ NETGREENER_MP2_SHADOW_COMPARE: 'yes' }), true)
})

test('collector exporter logs shadow digest when flag enabled (no dual-POST)', async () => {
  const previousFlag = process.env.NETGREENER_MP2_SHADOW_COMPARE
  const previousEndpoint = process.env.NETGREENER_COLLECTOR_ENDPOINT
  process.env.NETGREENER_MP2_SHADOW_COMPARE = '1'
  const expected = canonicalPayloadDigest(runSessionShadowPayload(payload))
  const lines: string[] = []
  const originalInfo = console.info
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  try {
    await withMockCollector(
      (request) => ({ ok: true, event_id: String(request.event_id) }),
      async (endpoint) => {
        process.env.NETGREENER_COLLECTOR_ENDPOINT = endpoint
        const exporter = new CollectorRunSessionExporter()
        const result = await exporter.exportRunSessionWindow(
          { ...config, dryRun: false },
          payload,
        )
        assert.equal(result.ok, true, result.ok ? 'ok' : String(result.error))
      },
    )
    assert.ok(
      lines.some(
        (line) =>
          line.includes('mp2_shadow_compare') &&
          line.includes('run_session_window') &&
          line.includes(expected) &&
          line.includes('emitter=netgreener_node'),
      ),
      `expected shadow digest log, got: ${lines.join(' | ') || '(none)'}`,
    )
  } finally {
    console.info = originalInfo
    if (previousFlag === undefined) delete process.env.NETGREENER_MP2_SHADOW_COMPARE
    else process.env.NETGREENER_MP2_SHADOW_COMPARE = previousFlag
    if (previousEndpoint === undefined) delete process.env.NETGREENER_COLLECTOR_ENDPOINT
    else process.env.NETGREENER_COLLECTOR_ENDPOINT = previousEndpoint
  }
})

test('collector observation batch logs shadow digest when flag enabled', async () => {
  const previousFlag = process.env.NETGREENER_MP2_SHADOW_COMPARE
  const previousEndpoint = process.env.NETGREENER_COLLECTOR_ENDPOINT
  process.env.NETGREENER_MP2_SHADOW_COMPARE = '1'
  const expected = canonicalPayloadDigest(observationBatch)
  const lines: string[] = []
  const originalInfo = console.info
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  try {
    await withMockCollector(
      (request) => ({ ok: true, event_id: String(request.event_id) }),
      async (endpoint) => {
        process.env.NETGREENER_COLLECTOR_ENDPOINT = endpoint
        const exporter = new CollectorRunSessionExporter()
        const result = await exporter.exportObservationBatch(
          { ...config, dryRun: false },
          observationBatch,
        )
        assert.equal(result.ok, true, result.ok ? 'ok' : String(result.error))
      },
    )
    assert.ok(
      lines.some(
        (line) =>
          line.includes('mp2_shadow_compare') &&
          line.includes('observation_batch') &&
          line.includes(expected),
      ),
      `expected observation shadow digest log, got: ${lines.join(' | ') || '(none)'}`,
    )
  } finally {
    console.info = originalInfo
    if (previousFlag === undefined) delete process.env.NETGREENER_MP2_SHADOW_COMPARE
    else process.env.NETGREENER_MP2_SHADOW_COMPARE = previousFlag
    if (previousEndpoint === undefined) delete process.env.NETGREENER_COLLECTOR_ENDPOINT
    else process.env.NETGREENER_COLLECTOR_ENDPOINT = previousEndpoint
  }
})
