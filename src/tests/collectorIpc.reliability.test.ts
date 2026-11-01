/**
 * MP2 Node IPC reliability (local unit evidence).
 *
 * Does not claim live API/UI, Observation cloud ingest, or export-mode cutover.
 */
import assert from 'node:assert/strict'
import { createServer, type Server, type Socket } from 'node:net'
import { test } from 'node:test'

import {
  CollectorIpcError,
  encodeCollectorFrame,
  sendCollectorEvent,
} from '../collectorIpc.js'
import { CollectorRunSessionExporter } from '../exporter.js'
import type { RuntimeConfig } from '../config.js'
import type { RunSessionCreatePayload } from '../uploader.js'

const config = {
  enabled: true,
  apiUrl: 'https://example.test',
  token: 't',
  projectId: 1,
  organizationId: null,
  flushIntervalMs: 60_000,
  dryRun: false,
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
  start_time: '2026-09-17T12:00:00.000Z',
  end_time: '2026-09-17T12:00:05.000Z',
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

async function listen(): Promise<{
  server: Server
  endpoint: string
  sockets: Set<Socket>
}> {
  const server = createServer()
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, endpoint: `tcp://127.0.0.1:${address.port}`, sockets }
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  // server.close() waits for idle sockets; force-drop peers so reliability
  // cases (no-ACK / mid-frame drop) cannot hang the suite.
  for (const socket of sockets) {
    socket.destroy()
  }
  sockets.clear()
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
}

function readRequest(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
      const buf = Buffer.concat(chunks)
      if (buf.length < 4) return
      const length = buf.readUInt32BE(0)
      if (buf.length < 4 + length) return
      socket.off('data', onData)
      try {
        resolve(JSON.parse(buf.subarray(4, 4 + length).toString('utf8')))
      } catch (err) {
        reject(err)
      }
    }
    socket.on('data', onData)
    socket.once('error', reject)
  })
}

test('IPC client reassembles ACK split across multiple writes', async () => {
  const { server, endpoint, sockets } = await listen()
  server.on('connection', async (socket) => {
    await readRequest(socket)
    const frame = encodeCollectorFrame({ ok: true, event_id: 'evt-split' })
    socket.write(frame.subarray(0, 2))
    await new Promise((r) => setTimeout(r, 20))
    socket.write(frame.subarray(2, 6))
    await new Promise((r) => setTimeout(r, 20))
    socket.write(frame.subarray(6))
  })
  try {
    const ack = await sendCollectorEvent({
      endpoint,
      payload: { kind: 'probe', project_id: 1 },
      timeoutMs: 2000,
    })
    assert.equal(ack.ok, true)
    assert.equal(ack.event_id, 'evt-split')
  } finally {
    await closeServer(server, sockets)
  }
})

test('IPC client fails closed when peer closes before ACK', async () => {
  const { server, endpoint, sockets } = await listen()
  server.on('connection', async (socket) => {
    await readRequest(socket)
    socket.destroy()
  })
  try {
    await assert.rejects(
      () =>
        sendCollectorEvent({
          endpoint,
          payload: { kind: 'probe', project_id: 1 },
          timeoutMs: 500,
        }),
      (err: unknown) =>
        err instanceof CollectorIpcError ||
        (err instanceof Error && /closed|timed out|ECONNRESET|reset/i.test(err.message)),
    )
  } finally {
    await closeServer(server, sockets)
  }
})

test('IPC client fails closed when ACK never arrives (timeout)', async () => {
  const { server, endpoint, sockets } = await listen()
  server.on('connection', async (socket) => {
    await readRequest(socket)
    // Intentionally never write an ACK.
  })
  try {
    await assert.rejects(
      () =>
        sendCollectorEvent({
          endpoint,
          payload: { kind: 'probe', project_id: 1 },
          timeoutMs: 150,
        }),
      (err: unknown) =>
        err instanceof CollectorIpcError && /timed out/i.test(err.message),
    )
  } finally {
    await closeServer(server, sockets)
  }
})

test('IPC client rejects non-object ACK JSON', async () => {
  const { server, endpoint, sockets } = await listen()
  server.on('connection', async (socket) => {
    await readRequest(socket)
    const body = Buffer.from('[]', 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length, 0)
    socket.write(Buffer.concat([header, body]))
  })
  try {
    await assert.rejects(
      () =>
        sendCollectorEvent({
          endpoint,
          payload: { kind: 'probe', project_id: 1 },
          timeoutMs: 1000,
        }),
      (err: unknown) =>
        err instanceof CollectorIpcError && /JSON object/i.test(err.message),
    )
  } finally {
    await closeServer(server, sockets)
  }
})

test('collector exporter stays fail-closed on mid-session peer drop (no silent direct)', async () => {
  const { server, endpoint, sockets } = await listen()
  server.on('connection', async (socket) => {
    await readRequest(socket)
    socket.destroy()
  })
  const previous = process.env.NETGREENER_COLLECTOR_ENDPOINT
  const previousTimeout = process.env.NETGREENER_EMIT_TIMEOUT_MS
  process.env.NETGREENER_COLLECTOR_ENDPOINT = endpoint
  process.env.NETGREENER_EMIT_TIMEOUT_MS = '400'
  try {
    const exporter = new CollectorRunSessionExporter()
    const result = await exporter.exportRunSessionWindow(config, payload)
    assert.equal(result.ok, false)
    assert.equal(result.mode, 'collector')
    assert.match(String(result.error), /collector IPC failed/)
    assert.doesNotMatch(String(result.error), /uploadRunSession|direct/i)
  } finally {
    if (previous === undefined) delete process.env.NETGREENER_COLLECTOR_ENDPOINT
    else process.env.NETGREENER_COLLECTOR_ENDPOINT = previous
    if (previousTimeout === undefined) delete process.env.NETGREENER_EMIT_TIMEOUT_MS
    else process.env.NETGREENER_EMIT_TIMEOUT_MS = previousTimeout
    await closeServer(server, sockets)
  }
})
