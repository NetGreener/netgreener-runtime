/**
 * Preload for ``netgreener run`` — meters the child Node process that executes
 * the user script. Loaded via ``node --import <this-module> <script>``.
 */

import { loadRuntimeConfig } from '../config.js'
import {
  beginProcessResourceSample,
  endProcessResourceSample,
} from '../processResources.js'
import { startProcessRuntime } from '../processRuntime.js'

const config = loadRuntimeConfig(process.env)
const runtime = startProcessRuntime({ config })
const resourceMark = beginProcessResourceSample()
const startedMs = performance.now()
let flushed = false

async function shutdownFlush(): Promise<void> {
  if (flushed) return
  flushed = true
  try {
    const resources = endProcessResourceSample(resourceMark)
    if (runtime.enabled) {
      runtime.recordTask({
        serviceUnit: 'task:netgreener_run',
        durationMs: performance.now() - startedMs,
        error: false,
        tenantId: null,
        cpuTimeMs: resources.cpuTimeMs,
        peakRssKb: resources.rssKb,
      })
    }
    await runtime.shutdown()
  } catch {
    // best-effort on exit
  }
}

process.once('beforeExit', () => {
  void shutdownFlush()
})
process.once('SIGINT', () => {
  void shutdownFlush().finally(() => process.exit(130))
})
process.once('SIGTERM', () => {
  void shutdownFlush().finally(() => process.exit(143))
})
