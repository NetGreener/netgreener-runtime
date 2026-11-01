/**
 * Linux cgroup v2 reader (Python ``cgroup_v2.CgroupV2Reader`` twin).
 *
 * Windows / non-Linux: ``available === false`` with an honest reason.
 * Does not invent CPU/memory values. Injectable paths support unit tests.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { platform } from 'node:os'

export type CgroupV2Snapshot = {
  cpu_usage_usec: number
  cpu_throttled_usec: number | null
  memory_current_bytes: number | null
  memory_peak_bytes: number | null
  memory_limit_bytes: number | null
  io_read_bytes: number | null
  io_write_bytes: number | null
}

export type CgroupV2Provenance = {
  schema_version: 1
  source: 'linux_cgroup_v2'
  available: boolean
  path: string | null
  reason: string | null
  process_count: number | null
  shared_process_boundary: boolean | null
}

function keyValues(text: string): Record<string, number> {
  const values: Record<string, number> = {}
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length === 2) {
      const n = Number(parts[1])
      if (Number.isFinite(n)) values[parts[0]!] = n
    }
  }
  return values
}

function ioTotals(text: string): { read: number; write: number } {
  let read = 0
  let write = 0
  for (const line of text.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/).slice(1)
    for (const token of tokens) {
      const eq = token.indexOf('=')
      if (eq < 0) continue
      const key = token.slice(0, eq)
      const amount = Number(token.slice(eq + 1))
      if (!Number.isFinite(amount)) continue
      if (key === 'rbytes') read += amount
      else if (key === 'wbytes') write += amount
    }
  }
  return { read, write }
}

export function resolveCgroupV2Path(
  procSelfCgroup: string,
  mountRoot = '/sys/fs/cgroup',
): string | null {
  for (const line of procSelfCgroup.split(/\r?\n/)) {
    const sep = line.indexOf('::')
    if (sep < 0) continue
    const hierarchy = line.slice(0, sep).trim()
    if (hierarchy !== '0') continue
    const relative = line.slice(sep + 2).trim().replace(/^\/+/, '')
    return relative ? join(mountRoot, relative) : mountRoot
  }
  return null
}

export type CgroupV2ReaderOptions = {
  procSelfCgroupPath?: string
  mountRoot?: string
  /** Force platform detection (tests). */
  platform?: NodeJS.Platform
}

export class CgroupV2Reader {
  readonly path: string | null
  readonly reason: string | null
  private readonly mountRoot: string

  constructor(opts: CgroupV2ReaderOptions = {}) {
    const plat = opts.platform ?? platform()
    this.mountRoot = opts.mountRoot ?? '/sys/fs/cgroup'
    const procPath = opts.procSelfCgroupPath ?? '/proc/self/cgroup'

    if (plat !== 'linux') {
      this.path = null
      this.reason = 'cgroup_v2_linux_only'
      return
    }
    try {
      if (!existsSync(procPath)) {
        this.path = null
        this.reason = 'proc_self_cgroup_unavailable'
        return
      }
      const content = readFileSync(procPath, 'utf8')
      const resolved = resolveCgroupV2Path(content, this.mountRoot)
      if (!resolved) {
        this.path = null
        this.reason = 'unified_cgroup_v2_entry_not_found'
        return
      }
      if (!existsSync(join(resolved, 'cpu.stat'))) {
        this.path = null
        this.reason = 'cpu_stat_unavailable'
        return
      }
      this.path = resolved
      this.reason = null
    } catch {
      this.path = null
      this.reason = 'proc_self_cgroup_unavailable'
    }
  }

  get available(): boolean {
    return this.path != null
  }

  private readFile(name: string): string | null {
    if (!this.path) return null
    try {
      return readFileSync(join(this.path, name), 'utf8').trim()
    } catch {
      return null
    }
  }

  private integerFile(name: string, unlimitedIsNone = false): number | null {
    const text = this.readFile(name)
    if (text == null || (unlimitedIsNone && text === 'max')) return null
    const n = Number(text)
    return Number.isFinite(n) ? Math.max(0, n) : null
  }

  processCount(): number | null {
    const text = this.readFile('cgroup.procs')
    if (text == null) return null
    const pids = new Set<number>()
    for (const line of text.split(/\r?\n/)) {
      const n = Number(line.trim())
      if (Number.isFinite(n)) pids.add(n)
    }
    return pids.size > 0 ? pids.size : null
  }

  snapshot(): CgroupV2Snapshot | null {
    const cpuText = this.readFile('cpu.stat')
    if (cpuText == null) return null
    const cpu = keyValues(cpuText)
    if (cpu.usage_usec == null) return null
    const ioText = this.readFile('io.stat')
    const io = ioText != null ? ioTotals(ioText) : null
    return {
      cpu_usage_usec: cpu.usage_usec,
      cpu_throttled_usec: cpu.throttled_usec ?? null,
      memory_current_bytes: this.integerFile('memory.current'),
      memory_peak_bytes: this.integerFile('memory.peak'),
      memory_limit_bytes: this.integerFile('memory.max', true),
      io_read_bytes: io?.read ?? null,
      io_write_bytes: io?.write ?? null,
    }
  }

  provenance(): CgroupV2Provenance {
    const process_count = this.available ? this.processCount() : null
    return {
      schema_version: 1,
      source: 'linux_cgroup_v2',
      available: this.available,
      path: this.path,
      reason: this.reason,
      process_count,
      shared_process_boundary:
        process_count != null ? process_count > 1 : null,
    }
  }
}

export function snapshotDelta(
  start: CgroupV2Snapshot,
  end: CgroupV2Snapshot,
): Record<string, number | null> {
  const delta = (before: number | null, after: number | null): number | null => {
    if (before == null || after == null || after < before) return null
    return after - before
  }
  return {
    cpu_usage_usec: delta(start.cpu_usage_usec, end.cpu_usage_usec),
    cpu_throttled_usec: delta(start.cpu_throttled_usec, end.cpu_throttled_usec),
    io_read_bytes: delta(start.io_read_bytes, end.io_read_bytes),
    io_write_bytes: delta(start.io_write_bytes, end.io_write_bytes),
    memory_current_bytes: end.memory_current_bytes,
    memory_peak_bytes: end.memory_peak_bytes,
    memory_limit_bytes: end.memory_limit_bytes,
  }
}
