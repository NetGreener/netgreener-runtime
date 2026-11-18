/**
 * Opt-in managed sibling collector launcher (Python ``process_launcher`` twin).
 *
 * When ``NETGREENER_COLLECTOR_MODE=managed``:
 * 1. Start ``python -m netgreener.collector_server``
 * 2. Point child at ``NETGREENER_EXPORT_MODE=collector`` + endpoint
 * 3. On child exit: terminate collector (drain)
 *
 * Unset mode stays direct. BullMQ meters in-process and does not use this
 * switch. Python Celery workers default to managed inside the Python launcher.
 * Windows: ``tcp://`` only.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, Socket } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export type CollectorMode = 'managed' | 'direct' | null

export function normalizedCollectorMode(
  env: NodeJS.ProcessEnv = process.env,
): CollectorMode {
  const raw = String(env.NETGREENER_COLLECTOR_MODE || '')
    .trim()
    .toLowerCase()
  if (!raw) return null
  if (raw === 'off' || raw === 'disabled' || raw === 'legacy') return 'direct'
  if (raw === 'managed' || raw === 'direct') return raw
  return null
}

export async function reserveTcpEndpoint(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        reject(new Error('failed to reserve TCP port'))
        return
      }
      const endpoint = `tcp://127.0.0.1:${addr.port}`
      server.close(() => resolve(endpoint))
    })
    server.on('error', reject)
  })
}

async function waitForTcp(
  endpoint: string,
  child: ChildProcess,
  timeoutMs = 5000,
): Promise<void> {
  const m = /^tcp:\/\/([^:]+):(\d+)$/i.exec(endpoint.trim())
  if (!m) return
  const host = m[1]!
  const port = Number(m[2])
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error('NetGreener collector exited during startup')
    }
    const ok = await new Promise<boolean>((resolve) => {
      const sock = new Socket()
      sock.setTimeout(100)
      sock.once('connect', () => {
        sock.destroy()
        resolve(true)
      })
      sock.once('error', () => {
        sock.destroy()
        resolve(false)
      })
      sock.once('timeout', () => {
        sock.destroy()
        resolve(false)
      })
      sock.connect(port, host)
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('NetGreener collector did not become ready within 5 seconds')
}

export type ManagedCollectorHandle = {
  endpoint: string
  spoolDir: string
  process: ChildProcess
  stop: () => Promise<void>
}

export type StartManagedCollectorOptions = {
  env?: NodeJS.ProcessEnv
  pythonCommand?: string
  /** Injected spawn for tests. */
  spawnImpl?: typeof spawn
  /** Skip readiness wait (tests). */
  skipReadyWait?: boolean
}

/**
 * Start managed collector if mode is managed; otherwise return null.
 */
export async function startManagedCollector(
  opts: StartManagedCollectorOptions = {},
): Promise<ManagedCollectorHandle | null> {
  const env = { ...(opts.env ?? process.env) }
  if (normalizedCollectorMode(env) !== 'managed') return null

  let endpoint = String(env.NETGREENER_COLLECTOR_ENDPOINT || '').trim()
  if (!endpoint) {
    endpoint = await reserveTcpEndpoint()
  }
  if (endpoint.startsWith('unix:') && process.platform === 'win32') {
    throw new Error('Windows managed collector requires tcp:// endpoint')
  }

  const spoolDir =
    String(env.NETGREENER_SPOOL_DIR || '').trim() ||
    join(homedir() || tmpdir(), '.netgreener', 'collector')

  const python = opts.pythonCommand || process.env.NETGREENER_PYTHON || 'python'
  const spawnImpl = opts.spawnImpl ?? spawn
  const collectorEnv: NodeJS.ProcessEnv = {
    ...env,
    NETGREENER_RUNTIME_COLLECTOR: '1',
    NETGREENER_COLLECTOR_ENDPOINT: endpoint,
    NETGREENER_SPOOL_DIR: spoolDir,
  }

  const child = spawnImpl(
    python,
    [
      '-m',
      'netgreener.collector_server',
      '--endpoint',
      endpoint,
      '--spool-dir',
      spoolDir,
    ],
    {
      env: collectorEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )

  if (!opts.skipReadyWait) {
    try {
      await waitForTcp(endpoint, child)
    } catch (err) {
      child.kill('SIGTERM')
      throw err
    }
  }

  const drainSec = Number(env.NETGREENER_COLLECTOR_DRAIN_SECONDS || '10')
  const drainMs =
    Number.isFinite(drainSec) && drainSec > 0 ? drainSec * 1000 : 10_000

  return {
    endpoint,
    spoolDir,
    process: child,
    stop: async () => {
      if (child.exitCode != null) return
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          if (child.exitCode == null) child.kill('SIGKILL')
          resolve()
        }, drainMs)
        child.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
      })
    },
  }
}

/** Env overlay for a Node child that should export via the managed collector. */
export function childEnvForManagedCollector(
  base: NodeJS.ProcessEnv,
  endpoint: string,
  opts?: { keepCredentials?: boolean },
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...base,
    NETGREENER_EXPORT_MODE: 'collector',
    NETGREENER_COLLECTOR_ENDPOINT: endpoint,
    NETGREENER_COLLECTOR_MODE: 'managed',
  }
  const keep =
    opts?.keepCredentials ||
    String(base.NETGREENER_WORKER_KEEP_CREDENTIALS || '').trim() === '1'
  if (!keep) {
    delete out.NETGREENER_TOKEN
    delete out.NETGREENER_SERVICE_TOKEN
  }
  return out
}
