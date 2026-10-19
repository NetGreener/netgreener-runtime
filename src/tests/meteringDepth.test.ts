import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  CgroupV2Reader,
  resolveCgroupV2Path,
  snapshotDelta,
} from '../cgroupV2.js'
import {
  collectDescendantPids,
  parseProcStatCpuTicks,
  parseProcStatPpid,
  parseProcStatusRssKb,
  processTreeAvailability,
  sampleProcessTree,
} from '../processTree.js'
import {
  childEnvForManagedCollector,
  normalizedCollectorMode,
  reserveTcpEndpoint,
  startManagedCollector,
} from '../managedCollectorLauncher.js'

test('resolveCgroupV2Path parses unified hierarchy', () => {
  const path = resolveCgroupV2Path('0::/system.slice/foo.service', '/sys/fs/cgroup')
  assert.equal(path?.replace(/\\/g, '/'), '/sys/fs/cgroup/system.slice/foo.service')
})

test('CgroupV2Reader unavailable on win32 with honest reason', () => {
  const reader = new CgroupV2Reader({ platform: 'win32' })
  assert.equal(reader.available, false)
  assert.equal(reader.reason, 'cgroup_v2_linux_only')
  assert.equal(reader.snapshot(), null)
  assert.equal(reader.provenance().available, false)
})

test('CgroupV2Reader reads fixture tree on linux platform override', () => {
  const root = mkdtempSync(join(tmpdir(), 'ng-cgroup-'))
  const cg = join(root, 'sys', 'fs', 'cgroup', 'demo')
  mkdirSync(cg, { recursive: true })
  writeFileSync(join(root, 'proc_self_cgroup'), '0::/demo\n')
  writeFileSync(
    join(cg, 'cpu.stat'),
    'usage_usec 1000\nthrottled_usec 10\n',
  )
  writeFileSync(join(cg, 'memory.current'), '4096\n')
  writeFileSync(join(cg, 'memory.peak'), '8192\n')
  writeFileSync(join(cg, 'memory.max'), 'max\n')
  writeFileSync(join(cg, 'cgroup.procs'), '1\n2\n')
  writeFileSync(join(cg, 'io.stat'), '8:0 rbytes=100 wbytes=20\n')

  const reader = new CgroupV2Reader({
    platform: 'linux',
    procSelfCgroupPath: join(root, 'proc_self_cgroup'),
    mountRoot: join(root, 'sys', 'fs', 'cgroup'),
  })
  assert.equal(reader.available, true)
  const snap = reader.snapshot()
  assert.ok(snap)
  assert.equal(snap!.cpu_usage_usec, 1000)
  assert.equal(snap!.memory_current_bytes, 4096)
  assert.equal(snap!.memory_limit_bytes, null)
  assert.equal(snap!.io_read_bytes, 100)
  assert.equal(reader.processCount(), 2)
  const end = { ...snap!, cpu_usage_usec: 1500 }
  assert.equal(snapshotDelta(snap!, end).cpu_usage_usec, 500)
})

test('processTreeAvailability false on win32', () => {
  const a = processTreeAvailability({ platform: 'win32' })
  assert.equal(a.available, false)
  assert.match(a.reason || '', /linux/)
})

test('process-tree parsers and aggregate sample from fixtures', () => {
  const stat =
    '1 (node) S 0 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0'
  // Rebuild a realistic line: after ) fields — use known layout
  const realistic =
    '42 (node) S 1 42 42 0 -1 4194304 123 0 0 0 50 25 0 0 20 0 1 0 12345 0 0'
  assert.equal(parseProcStatPpid(realistic), 1)
  assert.equal(parseProcStatCpuTicks(realistic), 75) // 50+25
  assert.equal(parseProcStatusRssKb('Name:\tnode\nVmRSS:\t  2048 kB\n'), 2048)

  const files = new Map<string, string>([
    [
      join('/proc', '100', 'stat'),
      '100 (root) S 0 100 100 0 -1 0 0 0 0 0 10 5 0 0 20 0 1 0 1 0 0',
    ],
    [join('/proc', '100', 'status'), 'VmRSS:\t1000 kB\n'],
    [
      join('/proc', '200', 'stat'),
      '200 (child) S 100 200 200 0 -1 0 0 0 0 0 20 10 0 0 20 0 1 0 1 0 0',
    ],
    [join('/proc', '200', 'status'), 'VmRSS:\t500 kB\n'],
  ])
  const sample = sampleProcessTree({
    platform: 'linux',
    rootPid: 100,
    procRoot: '/proc',
    listPids: () => [100, 200],
    readText: (p) => files.get(p) ?? null,
  })
  assert.ok(sample)
  assert.equal(sample!.pidCount, 2)
  assert.equal(sample!.cpuTimeMs, (15 + 30) * 10)
  assert.equal(sample!.rssKb, 1500)
  assert.deepEqual(collectDescendantPids(100, {
    platform: 'linux',
    procRoot: '/proc',
    listPids: () => [100, 200],
    readText: (p) => files.get(p) ?? null,
  }), [100, 200])
  void stat
})

test('normalizedCollectorMode and childEnvForManagedCollector', () => {
  assert.equal(normalizedCollectorMode({}), null)
  assert.equal(normalizedCollectorMode({ NETGREENER_COLLECTOR_MODE: 'managed' }), 'managed')
  assert.equal(normalizedCollectorMode({ NETGREENER_COLLECTOR_MODE: 'off' }), 'direct')
  const child = childEnvForManagedCollector(
    { NETGREENER_TOKEN: 'secret', FOO: '1' },
    'tcp://127.0.0.1:9',
  )
  assert.equal(child.NETGREENER_EXPORT_MODE, 'collector')
  assert.equal(child.NETGREENER_COLLECTOR_ENDPOINT, 'tcp://127.0.0.1:9')
  assert.equal(child.NETGREENER_TOKEN, undefined)
  assert.equal(child.FOO, '1')
})

test('reserveTcpEndpoint returns tcp://127.0.0.1:port', async () => {
  const ep = await reserveTcpEndpoint()
  assert.match(ep, /^tcp:\/\/127\.0\.0\.1:\d+$/)
})

test('startManagedCollector returns null when mode not managed', async () => {
  const handle = await startManagedCollector({
    env: { NETGREENER_COLLECTOR_MODE: 'direct' },
  })
  assert.equal(handle, null)
})

test('startManagedCollector spawns python -m netgreener.collector_server when managed', async () => {
  const calls: Array<{ cmd: string; args: string[] }> = []
  const fakeChild = {
    exitCode: null as number | null,
    kill() {
      this.exitCode = 0
    },
    once(event: string, cb: () => void) {
      if (event === 'exit') queueMicrotask(cb)
      return fakeChild
    },
  }
  const handle = await startManagedCollector({
    env: {
      NETGREENER_COLLECTOR_MODE: 'managed',
      NETGREENER_COLLECTOR_ENDPOINT: 'tcp://127.0.0.1:17999',
    },
    skipReadyWait: true,
    spawnImpl: ((cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args: [...args] })
      return fakeChild as never
    }) as unknown as typeof import('node:child_process').spawn,
  })
  assert.ok(handle)
  assert.equal(handle!.endpoint, 'tcp://127.0.0.1:17999')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.args[0], '-m')
  assert.equal(calls[0]!.args[1], 'netgreener.collector_server')
  await handle!.stop()
})
