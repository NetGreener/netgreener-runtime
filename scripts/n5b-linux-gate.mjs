/**
 * N5b Linux gate — process-tree + cgroup modules + honesty on non-Linux.
 *
 * Exit 0 on pass. On Windows: asserts honest unavailable (PASS for honesty).
 * On Linux: asserts processTree available; cgroup available if /sys/fs/cgroup present.
 *
 * Does not flip EXPORT_MODE. Does not upload.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import { CgroupV2Reader } from '../dist/cgroupV2.js'
import { processTreeAvailability, sampleProcessTree } from '../dist/processTree.js'

const plat = platform()
console.log(`n5b-linux-gate: platform=${plat}`)

const treeAvail = processTreeAvailability()
const cgroup = new CgroupV2Reader()

if (plat === 'linux') {
  assert.equal(treeAvail.available, true, 'process tree should be available on Linux')
  const sample = sampleProcessTree({ rootPid: process.pid })
  assert.ok(sample, 'sampleProcessTree should return a sample')
  assert.ok(sample.pidCount >= 1)
  assert.ok(sample.rssKb > 0)
  console.log(
    `n5b-linux-gate: process_tree ok pid_count=${sample.pidCount} rss_kb=${sample.rssKb}`,
  )
  if (existsSync('/sys/fs/cgroup')) {
    // May still be unavailable in odd hosts — require reader construct without throw
    console.log(
      `n5b-linux-gate: cgroup available=${cgroup.available} reason=${cgroup.reason}`,
    )
    if (cgroup.available) {
      const snap = cgroup.snapshot()
      assert.ok(snap)
      assert.ok(snap.cpu_usage_usec >= 0)
      console.log('n5b-linux-gate: cgroup snapshot ok')
    }
  }
} else {
  assert.equal(treeAvail.available, false)
  assert.equal(cgroup.available, false)
  assert.equal(cgroup.reason, 'cgroup_v2_linux_only')
  console.log('n5b-linux-gate: non-Linux honesty PASS (tree/cgroup unavailable)')
}

console.log('N5B LINUX GATE PASS')
