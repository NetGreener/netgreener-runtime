/**
 * Process-tree CPU/RSS sampling (Linux /proc first; Windows honest unavailable).
 *
 * Aggregates self + descendant PIDs. Never invents cgroup values.
 * Injectable ``readProc`` supports unit tests without a real /proc.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { platform } from 'node:os'

export const CPU_SOURCE_PROCESS_TREE = 'process_tree_proc'
export const MEMORY_SOURCE_PROCESS_TREE = 'process_tree_rss'

export type ProcessTreeSample = {
  /** Aggregate user+system CPU milliseconds since boot for the tree. */
  cpuTimeMs: number
  /** Sum of RSS (KiB) across observed PIDs. */
  rssKb: number
  /** Root + descendants successfully sampled. */
  pidCount: number
  provenanceCpu: typeof CPU_SOURCE_PROCESS_TREE
  provenanceMemory: typeof MEMORY_SOURCE_PROCESS_TREE
}

export type ProcessTreeAvailability = {
  available: boolean
  reason: string | null
  platform: string
}

export type ProcessTreeOptions = {
  rootPid?: number
  procRoot?: string
  platform?: NodeJS.Platform
  /** Override /proc reads for tests. */
  readText?: (path: string) => string | null
  listPids?: () => number[]
}

function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function defaultListPids(procRoot: string): number[] {
  try {
    return readdirSync(procRoot)
      .map((name) => Number(name))
      .filter((n) => Number.isFinite(n) && n > 0)
  } catch {
    return []
  }
}

/** Parse ``/proc/<pid>/stat`` utime+stime (fields 14–15, 1/100s ticks). */
export function parseProcStatCpuTicks(statText: string): number | null {
  const closeParen = statText.lastIndexOf(')')
  if (closeParen < 0) return null
  const rest = statText.slice(closeParen + 2).trim().split(/\s+/)
  // After ``)``: state(0) ppid(1) … utime(11) stime(12) — 0-based in rest.
  const utime = Number(rest[11])
  const stime = Number(rest[12])
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null
  return utime + stime
}

/** Parse ``/proc/<pid>/stat`` ppid (field after state). */
export function parseProcStatPpid(statText: string): number | null {
  const closeParen = statText.lastIndexOf(')')
  if (closeParen < 0) return null
  const rest = statText.slice(closeParen + 2).trim().split(/\s+/)
  const ppid = Number(rest[1])
  return Number.isFinite(ppid) ? ppid : null
}

/** Parse ``/proc/<pid>/status`` VmRSS in KiB. */
export function parseProcStatusRssKb(statusText: string): number | null {
  for (const line of statusText.split(/\r?\n/)) {
    if (!line.startsWith('VmRSS:')) continue
    const n = Number(line.replace(/^VmRSS:\s*/, '').split(/\s+/)[0])
    return Number.isFinite(n) ? Math.max(0, n) : null
  }
  return null
}

export function processTreeAvailability(
  opts: ProcessTreeOptions = {},
): ProcessTreeAvailability {
  const plat = opts.platform ?? platform()
  if (plat !== 'linux') {
    return {
      available: false,
      reason: 'process_tree_linux_proc_only',
      platform: plat,
    }
  }
  const procRoot = opts.procRoot ?? '/proc'
  if (!existsSync(procRoot) && !opts.listPids) {
    return { available: false, reason: 'proc_unavailable', platform: plat }
  }
  return { available: true, reason: null, platform: plat }
}

/**
 * Collect descendant PIDs of ``rootPid`` (including root) via ppid links.
 */
export function collectDescendantPids(
  rootPid: number,
  opts: ProcessTreeOptions = {},
): number[] {
  const procRoot = opts.procRoot ?? '/proc'
  const readText = opts.readText ?? defaultReadText
  const allPids = opts.listPids ? opts.listPids() : defaultListPids(procRoot)
  const children = new Map<number, number[]>()
  for (const pid of allPids) {
    const stat = readText(join(procRoot, String(pid), 'stat'))
    if (!stat) continue
    const ppid = parseProcStatPpid(stat)
    if (ppid == null) continue
    const list = children.get(ppid) ?? []
    list.push(pid)
    children.set(ppid, list)
  }
  const out: number[] = []
  const stack = [rootPid]
  const seen = new Set<number>()
  while (stack.length) {
    const pid = stack.pop()!
    if (seen.has(pid)) continue
    seen.add(pid)
    out.push(pid)
    for (const child of children.get(pid) ?? []) stack.push(child)
  }
  return out
}

/**
 * Snapshot aggregate CPU ticks (ms) + RSS for the process tree.
 * CPU uses 100 Hz ticks → ms = ticks * 10.
 */
export function sampleProcessTree(
  opts: ProcessTreeOptions = {},
): ProcessTreeSample | null {
  const avail = processTreeAvailability(opts)
  if (!avail.available) return null
  const rootPid = opts.rootPid ?? process.pid
  const procRoot = opts.procRoot ?? '/proc'
  const readText = opts.readText ?? defaultReadText
  const pids = collectDescendantPids(rootPid, opts)
  let ticks = 0
  let rssKb = 0
  let pidCount = 0
  for (const pid of pids) {
    const stat = readText(join(procRoot, String(pid), 'stat'))
    const status = readText(join(procRoot, String(pid), 'status'))
    if (!stat) continue
    const t = parseProcStatCpuTicks(stat)
    if (t == null) continue
    ticks += t
    const rss = status ? parseProcStatusRssKb(status) : null
    if (rss != null) rssKb += rss
    pidCount += 1
  }
  if (pidCount === 0) return null
  return {
    cpuTimeMs: ticks * 10,
    rssKb,
    pidCount,
    provenanceCpu: CPU_SOURCE_PROCESS_TREE,
    provenanceMemory: MEMORY_SOURCE_PROCESS_TREE,
  }
}
