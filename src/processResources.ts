/**
 * Process-level CPU / RSS sampling for Node Runtime (CAP-R4 / N5).
 *
 * Mirrors Python ASGI middleware: ``time.process_time()`` + ``psutil`` RSS.
 * Uses Node ``process.cpuUsage`` / ``process.memoryUsage().rss`` only —
 * never invents cgroup or process-tree values.
 */

export const CPU_SOURCE_PROCESS = 'node_process_cpu_usage'
export const MEMORY_SOURCE_PROCESS = 'node_process_memory_rss'

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

/**
 * End a CPU interval and read current RSS.
 * ``cpuUsage(previous)`` returns user+system microseconds since ``previous``.
 */
export function endProcessResourceSample(
  mark: ProcessResourceMark,
): ProcessResourceSample {
  const delta = process.cpuUsage(mark.cpuStart)
  const cpuTimeMs = (delta.user + delta.system) / 1000
  const rssKb = Math.round(process.memoryUsage().rss / 1024)
  return {
    cpuTimeMs: Number.isFinite(cpuTimeMs) && cpuTimeMs >= 0 ? cpuTimeMs : 0,
    rssKb: Number.isFinite(rssKb) && rssKb >= 0 ? rssKb : 0,
  }
}

/** Point-in-time RSS (KiB) when no interval mark is available. */
export function currentRssKb(): number {
  const rssKb = Math.round(process.memoryUsage().rss / 1024)
  return Number.isFinite(rssKb) && rssKb >= 0 ? rssKb : 0
}
