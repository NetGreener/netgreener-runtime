/**
 * Shared task/job metering (process runtime, BullMQ) — one hot path.
 *
 * Twins Python process_runtime / Celery: OccupancyTracker begin/end around the
 * task so BullMQ/process flushes carry ``cpu_and_occupancy_v1`` anomaly evidence.
 */

import { randomUUID } from 'node:crypto'

import type { NetGreenerRuntime } from './runtime.js'
import { getOccupancyTracker } from './occupancyTracker.js'
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
    /** Stable id for occupancy (BullMQ job id); defaults to UUID. */
    taskId?: string | null
  },
): T | Promise<T> {
  if (!runtime.enabled) {
    return sample.fn()
  }

  const started = performance.now()
  const resourceMark = beginProcessResourceSample()
  const taskId = String(sample.taskId || '').trim() || randomUUID()
  getOccupancyTracker().begin(taskId)
  let error = false
  runtime.beginRequest()

  const finalize = (): void => {
    const resources = endProcessResourceSample(resourceMark)
    getOccupancyTracker().end(taskId, sample.serviceUnit)
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
