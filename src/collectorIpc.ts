/**
 * NetGreener collector IPC client (MP2).
 *
 * Wire-compatible with Python ``collector_protocol``:
 * 4-byte big-endian length + UTF-8 JSON object, max 256 KiB.
 * Endpoint schemes: ``tcp://host:port`` (Windows/Linux) or ``unix:///abs/path`` (non-Windows).
 */
import { createConnection, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { URL } from 'node:url'

export const COLLECTOR_MAX_FRAME_BYTES = 256 * 1024

export type CollectorIpcAck = {
  ok: boolean
  event_id?: string
  status?: string
  error?: string
}

export class CollectorIpcError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CollectorIpcError'
  }
}

export function normalizeCollectorEndpoint(endpoint: string): string {
  const raw = endpoint.trim()
  if (!raw) throw new CollectorIpcError('collector endpoint is empty')
  if (/^(tcp|unix):\/\//i.test(raw)) return raw
  // Allow host:port convenience form used in some local notes.
  if (/^[^/]+:\d+$/.test(raw)) return `tcp://${raw}`
  throw new CollectorIpcError('Collector endpoint must use tcp:// or unix://')
}

export function encodeCollectorFrame(payload: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  if (body.length < 1 || body.length > COLLECTOR_MAX_FRAME_BYTES) {
    throw new CollectorIpcError(
      `Collector frame must be 1..${COLLECTOR_MAX_FRAME_BYTES} bytes`,
    )
  }
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

async function readExact(socket: Socket, size: number): Promise<Buffer> {
  if (size === 0) return Buffer.alloc(0)
  // Paused-mode reads on an exclusively owned ACK socket.
  // Resolve readable/close wakes on setImmediate so a sync 'readable'
  // re-entry cannot microtask-spin and starve response timers (Windows).
  socket.pause()
  const chunks: Buffer[] = []
  let received = 0
  while (received < size) {
    const chunk = socket.read(size - received)
    if (chunk !== null && chunk.length > 0) {
      chunks.push(chunk)
      received += chunk.length
      continue
    }
    if (socket.readableEnded || socket.destroyed) {
      throw new CollectorIpcError('Collector peer closed the connection mid-frame')
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        socket.off('readable', onReadable)
        socket.off('end', onClosed)
        socket.off('close', onClosed)
        socket.off('error', onError)
        setImmediate(fn)
      }
      const onReadable = () => finish(() => resolve())
      const onClosed = () =>
        finish(() =>
          reject(new CollectorIpcError('Collector peer closed the connection mid-frame')),
        )
      const onError = (err: Error) => finish(() => reject(err))

      socket.once('readable', onReadable)
      socket.once('end', onClosed)
      socket.once('close', onClosed)
      socket.once('error', onError)

      if (socket.readableEnded || socket.destroyed) {
        onClosed()
        return
      }
      if (socket.readableLength > 0) {
        onReadable()
      }
    })
  }
  return Buffer.concat(chunks)
}

export async function recvCollectorFrame(socket: Socket): Promise<Record<string, unknown>> {
  const header = await readExact(socket, 4)
  const length = header.readUInt32BE(0)
  if (length < 1 || length > COLLECTOR_MAX_FRAME_BYTES) {
    throw new CollectorIpcError(`Collector frame must be 1..${COLLECTOR_MAX_FRAME_BYTES} bytes`)
  }
  const body = await readExact(socket, length)
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    throw new CollectorIpcError('Collector frame contains invalid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CollectorIpcError('Collector frame must contain a JSON object')
  }
  return parsed as Record<string, unknown>
}

function connectCollector(endpoint: string, timeoutMs: number): Promise<Socket> {
  const normalized = normalizeCollectorEndpoint(endpoint)
  return new Promise((resolve, reject) => {
    const url = new URL(normalized)
    let socket: Socket
    const onError = (err: Error) => {
      socket.destroy()
      reject(err)
    }
    if (url.protocol === 'tcp:') {
      const host = url.hostname
      const port = Number(url.port)
      if (!host || !Number.isFinite(port) || port <= 0) {
        reject(new CollectorIpcError('TCP collector endpoint must include host and port'))
        return
      }
      socket = createConnection({ host, port })
    } else if (url.protocol === 'unix:') {
      if (process.platform === 'win32') {
        reject(new CollectorIpcError('Unix collector endpoints are unavailable on Windows'))
        return
      }
      const path = url.pathname
      if (!path || !path.startsWith('/')) {
        reject(new CollectorIpcError('Unix collector endpoint must use an absolute path'))
        return
      }
      socket = createConnection({ path })
    } else {
      reject(new CollectorIpcError('Collector endpoint must use tcp:// or unix://'))
      return
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.setTimeout(0)
      socket.off('error', onError)
      resolve(socket)
    })
    socket.once('timeout', () => {
      socket.destroy()
      reject(new CollectorIpcError('Collector connection timed out'))
    })
    socket.once('error', onError)
  })
}

export type SendCollectorEventOptions = {
  endpoint: string
  payload: Record<string, unknown>
  timeoutMs?: number
}

export async function sendCollectorEvent(
  options: SendCollectorEventOptions,
): Promise<CollectorIpcAck> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 100)
  const socket = await connectCollector(options.endpoint, timeoutMs)
  try {
    const frame = encodeCollectorFrame(options.payload)
    await new Promise<void>((resolve, reject) => {
      socket.write(frame, (err) => (err ? reject(err) : resolve()))
    })
    const ack = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new CollectorIpcError('Collector response timed out'))
      }, timeoutMs)
      recvCollectorFrame(socket)
        .then((frame) => {
          clearTimeout(timer)
          resolve(frame)
        })
        .catch((err) => {
          clearTimeout(timer)
          reject(err)
        })
    })
    return {
      ok: ack.ok === true,
      event_id: typeof ack.event_id === 'string' ? ack.event_id : undefined,
      status: typeof ack.status === 'string' ? ack.status : undefined,
      error: typeof ack.error === 'string' ? ack.error : undefined,
    }
  } finally {
    socket.destroy()
  }
}

export function newCollectorEventId(): string {
  return randomUUID()
}
