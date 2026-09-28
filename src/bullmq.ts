/**
 * BullMQ worker binding (N3 / T2 Node analogue of Celery task_kwarg).
 *
 * No hard dependency on ``bullmq`` — wrap any processor that receives a job-like
 * object with ``name`` + ``data``. Enqueue with organization_id (or configured
 * kwarg) in ``job.data``.
 */

import {
  getRuntime,
  type NetGreenerRuntime,
  type NetGreenerRuntimeOptions,
} from './runtime.js'
import {
  loadTenantConfig,
  resolveTenantFromTaskData,
  runWithTenantContext,
  type TenantContext,
} from './tenantContext.js'
import { runWithRequestAttribution } from './requestContext.js'
import {
  beginProcessResourceSample,
  endProcessResourceSample,
} from './processResources.js'

/** Minimal BullMQ Job shape (avoid hard dependency). */
export type BullMqJobLike = {
  id?: string
  name?: string
  data?: Record<string, unknown>
}

export type BullMqProcessorOptions = NetGreenerRuntimeOptions & {
  /** Fallback service unit name when job.name is missing. */
  defaultJobName?: string
}

function serviceUnitForJob(job: BullMqJobLike, fallback: string): string {
  const name = String(job.name || fallback || 'job').trim() || 'job'
  return `task:${name.slice(0, 240)}`
}

/**
 * Wrap a BullMQ (or compatible) processor so each job:
 * - binds tenant from ``job.data[NETGREENER_TENANT_TASK_KWARG]`` when configured
 * - attributes outbound ``fetch`` to ``task:<job.name>``
 * - records a runtime task sample for flush
 */
export function netgreenerBullMqProcessor<Job extends BullMqJobLike, Result>(
  processor: (job: Job) => Promise<Result> | Result,
  opts: BullMqProcessorOptions = {},
): (job: Job) => Promise<Result> {
  const runtime = getRuntime({
    collector: 'bullmq_worker',
    framework: 'bullmq',
    ...opts,
  })
  runtime.start()
  const tenantConfig = loadTenantConfig()
  const fallbackName = opts.defaultJobName || 'job'

  return async function netgreenerInstrumentedProcessor(job: Job): Promise<Result> {
    if (!runtime.enabled) {
      return await processor(job)
    }
    const tenant = resolveTenantFromTaskData(
      job?.data && typeof job.data === 'object' ? job.data : null,
      tenantConfig,
    )
    const serviceUnit = serviceUnitForJob(job, fallbackName)
    const started = performance.now()
    const resourceMark = beginProcessResourceSample()
    let error = false

    const run = async (): Promise<Result> => {
      try {
        return await processor(job)
      } catch (err) {
        error = true
        throw err
      } finally {
        const resources = endProcessResourceSample(resourceMark)
        runtime.recordTask({
          serviceUnit,
          durationMs: performance.now() - started,
          error,
          tenantId: tenant?.tenantId ?? null,
          cpuTimeMs: resources.cpuTimeMs,
          peakRssKb: resources.rssKb,
        })
      }
    }

    return runWithTenantContext(tenant, () =>
      runWithRequestAttribution({ serviceUnit }, () => run()),
    )
  }
}

/**
 * Bind tenant + request attribution for one job without wrapping the whole Worker.
 * Useful when you already own the processor loop.
 */
export function runBullMqJobWithNetGreener<Job extends BullMqJobLike, Result>(
  job: Job,
  fn: () => Promise<Result> | Result,
  opts: BullMqProcessorOptions = {},
): Promise<Result> {
  const runtime = getRuntime({
    collector: 'bullmq_worker',
    framework: 'bullmq',
    ...opts,
  })
  runtime.start()
  const tenantConfig = loadTenantConfig()
  const tenant = resolveTenantFromTaskData(
    job?.data && typeof job.data === 'object' ? job.data : null,
    tenantConfig,
  )
  const serviceUnit = serviceUnitForJob(job, opts.defaultJobName || 'job')
  const started = performance.now()
  const resourceMark = beginProcessResourceSample()
  let error = false

  const run = async (): Promise<Result> => {
    try {
      return await fn()
    } catch (err) {
      error = true
      throw err
    } finally {
      if (runtime.enabled) {
        const resources = endProcessResourceSample(resourceMark)
        runtime.recordTask({
          serviceUnit,
          durationMs: performance.now() - started,
          error,
          tenantId: tenant?.tenantId ?? null,
          cpuTimeMs: resources.cpuTimeMs,
          peakRssKb: resources.rssKb,
        })
      }
    }
  }

  return runWithTenantContext(tenant, () =>
    runWithRequestAttribution({ serviceUnit }, () => run()),
  )
}

export function getBullMqRuntime(): NetGreenerRuntime {
  return getRuntime({ collector: 'bullmq_worker', framework: 'bullmq' })
}

export type { TenantContext }
