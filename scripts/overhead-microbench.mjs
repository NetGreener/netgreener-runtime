/**
 * Absolute wrap-cost microbench (diagnostic — not O1/O2 gate).
 *   node scripts/overhead-microbench.mjs
 */
import { performance } from 'node:perf_hooks'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distIndex = pathToFileURL(join(root, 'dist/index.js')).href
const N = 5000

function bench(label, fn) {
  for (let i = 0; i < 200; i++) fn()
  const t0 = performance.now()
  const c0 = process.cpuUsage()
  for (let i = 0; i < N; i++) fn()
  const wall = performance.now() - t0
  const cpu = process.cpuUsage(c0)
  const cpuMs = (cpu.user + cpu.system) / 1000
  console.log(
    `${label.padEnd(40)} wall=${(wall / N).toFixed(4)}ms/op  cpu=${(cpuMs / N).toFixed(4)}ms/op`,
  )
}

const {
  beginProcessResourceSample,
  endProcessResourceSample,
  loadRuntimeConfig,
  netgreenerBullMqProcessor,
  runWithProcessTenant,
  startProcessRuntime,
  _resetRuntimeForTests,
  _resetOutboundInstrumentationForTests,
} = await import(distIndex)

bench('noop', () => {})
bench('performance.now x2', () => {
  const a = performance.now()
  performance.now() - a
})
bench('cpuUsage begin+end', () => {
  const m = beginProcessResourceSample()
  endProcessResourceSample(m)
})
bench('memoryUsage.rss only', () => {
  process.memoryUsage().rss
})
bench('cpuUsage alone (no rss)', () => {
  const a = process.cpuUsage()
  process.cpuUsage(a)
})

_resetRuntimeForTests()
_resetOutboundInstrumentationForTests()
const config = loadRuntimeConfig({
  NETGREENER_SERVICE_RUNTIME: '1',
  NETGREENER_TOKEN: 'ngs_x',
  NETGREENER_PROJECT_ID: '1',
  NETGREENER_RUNTIME_DRY_RUN: '1',
})
const runtime = startProcessRuntime({
  config,
  fetchImpl: async () => {
    throw new Error('no')
  },
})
bench('runWithProcessTenant empty', () => {
  runWithProcessTenant('t1', () => 1, { runtime, serviceUnit: 'task:mb' })
})

_resetRuntimeForTests()
_resetOutboundInstrumentationForTests()
const handler = netgreenerBullMqProcessor(() => 1, {
  config,
  fetchImpl: async () => {
    throw new Error('no')
  },
})
const job = { id: '1', name: 'mb', data: {} }
bench('bullmq wrap empty', () => {
  handler(job)
})

console.log('done')
