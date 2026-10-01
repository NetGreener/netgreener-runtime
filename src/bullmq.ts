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
  resolveTenantFromTaskData,
  runWithTenantContext,
  tenantConfigFromRuntime,
  type TenantContext,
} from './tenantContext.js'
import { runWithRequestAttribution } from './requestContext.js'
import { recordMeteredTask } from './taskMeter.js'

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
): (job: Job) => Promise<Result> | Result {
  const runtime = getRuntime({
    collector: 'bullmq_worker',
    framework: 'bullmq',
    ...opts,
  })
  runtime.start()
  const tenantConfig = tenantConfigFromRuntime(runtime.config)
  const fallbackName = opts.defaultJobName || 'job'
  const tenantEnabled = tenantConfig.enabled

  return function netgreenerInstrumentedProcessor(job: Job): Promise<Result> | Result {
    if (!runtime.enabled) {
      return processor(job)
    }
    const tenant = tenantEnabled
      ? resolveTenantFromTaskData(
          job?.data && typeof job.data === 'object' ? job.data : null,
          tenantConfig,
        )
      : null
    const serviceUnit = serviceUnitForJob(job, fallbackName)
    const run = () =>
      runWithRequestAttribution({ serviceUnit }, () =>
        recordMeteredTask(runtime, {
          serviceUnit,
          tenantId: tenant?.tenantId ?? null,
          fn: () => processor(job),
        }),
      )
    // Skip empty tenant ALS when tenant source is disabled (still attributes outbound).
    return tenantEnabled ? runWithTenantContext(tenant, run) : run()
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
): Promise<Result> | Result {
  const runtime = getRuntime({
    collector: 'bullmq_worker',
    framework: 'bullmq',
    ...opts,
  })
  runtime.start()
  const tenantConfig = tenantConfigFromRuntime(runtime.config)
  const tenant = tenantConfig.enabled
    ? resolveTenantFromTaskData(
        job?.data && typeof job.data === 'object' ? job.data : null,
        tenantConfig,
      )
    : null
  const serviceUnit = serviceUnitForJob(job, opts.defaultJobName || 'job')
  const run = () =>
    runWithRequestAttribution({ serviceUnit }, () =>
      recordMeteredTask(runtime, {
        serviceUnit,
        tenantId: tenant?.tenantId ?? null,
        fn,
      }),
    )
  return (tenantConfig.enabled ? runWithTenantContext(tenant, run) : run()) as
    | Promise<Result>
    | Result
}

export function getBullMqRuntime(): NetGreenerRuntime {
  return getRuntime({ collector: 'bullmq_worker', framework: 'bullmq' })
}

export type { TenantContext }
