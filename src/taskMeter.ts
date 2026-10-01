/**
 * Shared task/job metering (process runtime, BullMQ) — one hot path.
 */

import type { NetGreenerRuntime } from './runtime.js'
import {
  beginProcessResourceSample,
  endProcessResourceSample,
} from './processResources.js'

export function recordMeteredTask<T>(
  runtime: NetGreenerRuntime,
  sample: {
    serviceUnit: string
    tenantId: string | null
    fn: () => T | Promise<T>
  },
): T | Promise<T> {
  if (!runtime.enabled) {
    return sample.fn()
  }

  const started = performance.now()
  const resourceMark = beginProcessResourceSample()
  let error = false
  runtime.beginRequest()

  const finalize = (): void => {
    const resources = endProcessResourceSample(resourceMark)
    runtime.recordTask({
      serviceUnit: sample.serviceUnit,
      durationMs: performance.now() - started,
      error,
      tenantId: sample.tenantId,
      cpuTimeMs: resources.cpuTimeMs,
      peakRssKb: resources.rssKb,
    })
    runtime.endRequest()
  }

  try {
    const result = sample.fn()
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          finalize()
          return value
        },
        (err) => {
          error = true
          finalize()
          throw err
        },
      )
    }
    finalize()
    return result
  } catch (err) {
    error = true
    finalize()
    throw err
  }
}
