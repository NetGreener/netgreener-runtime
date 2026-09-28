/**
 * Process / cron / script runtime (N3) — no HTTP middleware required.
 *
 * Start metering, bind tenant for a job, flush on shutdown.
 */

import {
  getRuntime,
  type NetGreenerRuntime,
  type NetGreenerRuntimeOptions,
} from './runtime.js'
import type { UploadResult } from './uploader.js'
import {
  normalizeTenantId,
  runWithTenantContext,
  setTenantContext,
  type TenantContext,
} from './tenantContext.js'
import { runWithRequestAttribution } from './requestContext.js'
import {
  beginProcessResourceSample,
  endProcessResourceSample,
} from './processResources.js'

export type ProcessRuntimeOptions = NetGreenerRuntimeOptions & {
  /** Default service unit when recording a named job (e.g. scheduled_report). */
  serviceUnit?: string
}

let signalsInstalled = false

/**
 * Enable NetGreener runtime for a long-lived Node process (cron worker, script).
 * Installs outbound ``fetch`` metering and periodic flush when config is ready.
 */
export function startProcessRuntime(
  opts: ProcessRuntimeOptions = {},
): NetGreenerRuntime {
  const runtime = getRuntime({
    collector: 'node_process',
    framework: 'node',
    ...opts,
  })
  runtime.start()
  if (!signalsInstalled) {
    signalsInstalled = true
    const shutdown = () => {
      void runtime.shutdown()
    }
    process.once('beforeExit', shutdown)
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  }
  return runtime
}

/**
 * Run ``fn`` with an explicit tenant id (batch/cron style — no JWT).
 */
export async function runWithProcessTenant<T>(
  tenantId: string,
  fn: () => Promise<T> | T,
  opts?: {
    source?: string
    label?: string
    serviceUnit?: string
    runtime?: NetGreenerRuntime
  },
): Promise<T> {
  const normalized = normalizeTenantId(tenantId)
  if (!normalized) {
    throw new Error('invalid tenant_id')
  }
  const runtime = opts?.runtime ?? startProcessRuntime()
  const ctx: TenantContext = {
    tenantId: normalized,
    tenantSource: opts?.source || 'manual',
    ...(opts?.label ? { tenantLabel: opts.label.slice(0, 128) } : {}),
  }
  const serviceUnit = opts?.serviceUnit || 'task:process'
  const started = performance.now()
  const resourceMark = beginProcessResourceSample()
  let error = false

  const run = async (): Promise<T> => {
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
          tenantId: normalized,
          cpuTimeMs: resources.cpuTimeMs,
          peakRssKb: resources.rssKb,
        })
      }
    }
  }

  return runWithTenantContext(ctx, () =>
    runWithRequestAttribution({ serviceUnit }, () => run()),
  )
}

/**
 * Convenience: set tenant for the rest of the current async chain (enterWith).
 * Prefer ``runWithProcessTenant`` when possible.
 */
export function bindProcessTenant(
  tenantId: string,
  opts?: { source?: string; label?: string },
): TenantContext {
  const normalized = normalizeTenantId(tenantId)
  if (!normalized) throw new Error('invalid tenant_id')
  const ctx: TenantContext = {
    tenantId: normalized,
    tenantSource: opts?.source || 'manual',
    ...(opts?.label ? { tenantLabel: opts.label.slice(0, 128) } : {}),
  }
  setTenantContext(ctx)
  return ctx
}

export async function flushProcessRuntime(
  kind: 'manual' | 'shutdown' = 'manual',
): Promise<UploadResult | null> {
  const runtime = getRuntime({ collector: 'node_process', framework: 'node' })
  if (kind === 'shutdown') return runtime.shutdown()
  return runtime.flush(kind)
}
