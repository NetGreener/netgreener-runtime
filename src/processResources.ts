/**
 * Process-level CPU / RSS sampling for Node Runtime (CAP-R4 / N5).
 *
 * Mirrors Python ASGI middleware: ``time.process_time()`` + ``psutil`` RSS.
 * Uses Node ``process.cpuUsage`` / ``process.memoryUsage().rss`` only —
 * never invents cgroup or process-tree values.
 *
 * RSS OS reads are rate-limited (still measured, never fabricated). Peak RSS
 * aggregation stays honest: a cached sample is a real prior ``memoryUsage().rss``.
 */

export const CPU_SOURCE_PROCESS = 'node_process_cpu_usage'
export const MEMORY_SOURCE_PROCESS = 'node_process_memory_rss'

/** Min gap between ``memoryUsage()`` RSS reads (ms). Override via env for tests. */
const RSS_MIN_INTERVAL_MS = Number(
  process.env.NETGREENER_RSS_SAMPLE_INTERVAL_MS || 50,
)

let lastRssKb = 0
let lastRssAtMs = 0

export type ProcessResourceMark = {
  /** ``process.cpuUsage()`` snapshot at begin. */
  cpuStart: NodeJS.CpuUsage
}

export type ProcessResourceSample = {
  /** Process CPU time attributed to the interval (milliseconds). */
  cpuTimeMs: number
  /** Current RSS in KiB at end of interval. */
  rssKb: number
}

/** Start a CPU interval (call at request/task entry). */
export function beginProcessResourceSample(): ProcessResourceMark {
  return { cpuStart: process.cpuUsage() }
}

function readRssKb(force = false): number {
  const now = performance.now()
  if (
    !force &&
    lastRssAtMs > 0 &&
    now - lastRssAtMs < RSS_MIN_INTERVAL_MS &&
    lastRssKb > 0
  ) {
    return lastRssKb
  }
  const rssKb = Math.round(process.memoryUsage().rss / 1024)
  const safe = Number.isFinite(rssKb) && rssKb >= 0 ? rssKb : 0
  lastRssKb = safe
  lastRssAtMs = now
  return safe
}

/**
 * End a CPU interval and read current RSS.
 * ``cpuUsage(previous)`` returns user+system microseconds since ``previous``.
 */
export function endProcessResourceSample(
  mark: ProcessResourceMark,
): ProcessResourceSample {
  const delta = process.cpuUsage(mark.cpuStart)
  const cpuTimeMs = (delta.user + delta.system) / 1000
  return {
    cpuTimeMs: Number.isFinite(cpuTimeMs) && cpuTimeMs >= 0 ? cpuTimeMs : 0,
    rssKb: readRssKb(false),
  }
}

/** Point-in-time RSS (KiB) when no interval mark is available. */
export function currentRssKb(): number {
  return readRssKb(true)
}

/** Test helper — clear RSS cache. */
export function _resetRssSampleCacheForTests(): void {
  lastRssKb = 0
  lastRssAtMs = 0
}
