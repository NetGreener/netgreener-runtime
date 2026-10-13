/**
 * Next.js App Router adapter (Wave 3 pilot).
 *
 * Maps into the same Runtime / observation / export path as Express.
 * Not a Vercel production claim — use persistent Node or pilot wording.
 * Does not change NETGREENER_EXPORT_MODE defaults.
 */

import { randomUUID } from 'node:crypto'

import {
  getRuntime,
  type NetGreenerRuntime,
  type NetGreenerRuntimeOptions,
} from './runtime.js'
import {
  getTenantStore,
  resolveTenantFromHttpRequest,
  runWithTenantContext,
  tenantConfigFromRuntime,
  type TenantContext,
  type TenantStore,
} from './tenantContext.js'
import { runWithRequestAttribution } from './requestContext.js'
import {
  beginProcessResourceSample,
  endProcessResourceSample,
} from './processResources.js'
import { getOccupancyTracker } from './occupancyTracker.js'
import type { UploadResult } from './uploader.js'

export const UNKNOWN_NEXT_ROUTE_TEMPLATE = '<unmatched>'
const MAX_ROUTE_TEMPLATE_LEN = 512

/** Minimal Next Request-like shape (App Router / Fetch API). */
export type NextRequestLike = {
  method?: string
  url?: string
  nextUrl?: { pathname?: string }
  headers?: Headers | Record<string, unknown>
}

export type NextRouteContext = Record<string, unknown>

export type NetGreenerNextOptions = NetGreenerRuntimeOptions & {
  /**
   * Static route template override (e.g. ``/api/intake/[id]``).
   * Prefer this over raw pathnames that may embed customer ids.
   */
  routeTemplate?: string
}

/**
 * Call from ``instrumentation.ts`` ``register()`` to start the Runtime singleton.
 *
 * ```ts
 * export async function register() {
 *   const { registerNetGreenerNext } = await import('@netgreener/runtime/next')
 *   registerNetGreenerNext()
 * }
 * ```
 */
export function registerNetGreenerNext(
  opts: NetGreenerNextOptions = {},
): NetGreenerRuntime {
  const runtime = getRuntime({
    collector: 'next_app_router',
    framework: 'next',
    ...opts,
  })
  runtime.start()
  if (runtime.lifecycle === 'persistent') {
    const onSignal = () => {
      void runtime.shutdown()
    }
    process.once('beforeExit', onSignal)
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
  }
  return runtime
}

/**
 * Bounded route template for service_unit attribution.
 * Never use query strings; prefer an explicit ``routeTemplate`` option.
 */
export function nextRouteTemplate(
  req: NextRequestLike,
  override?: string,
): string {
  if (typeof override === 'string') {
    const t = override.trim()
    if (
      t &&
      t.length <= MAX_ROUTE_TEMPLATE_LEN &&
      !t.includes('?') &&
      !t.includes('#')
    ) {
      return t
    }
  }
  const pathname =
    req.nextUrl?.pathname ||
    (typeof req.url === 'string' ? safePathname(req.url) : '')
  const template = (pathname || '').trim()
  if (
    !template ||
    template.length > MAX_ROUTE_TEMPLATE_LEN ||
    template.includes('?') ||
    template.includes('#')
  ) {
    return UNKNOWN_NEXT_ROUTE_TEMPLATE
  }
  return template
}

function safePathname(url: string): string {
  try {
    return new URL(url, 'http://local').pathname
  } catch {
    return url.split('?')[0] || ''
  }
}

function headersAsRecord(
  headers: NextRequestLike['headers'],
): Record<string, unknown> {
  if (!headers) return {}
  if (typeof (headers as Headers).get === 'function') {
    const out: Record<string, unknown> = {}
    ;(headers as Headers).forEach((value, key) => {
      out[key] = value
    })
    return out
  }
  return headers as Record<string, unknown>
}

/**
 * Wrap an App Router route handler (``GET``/``POST``/…) with NetGreener metering.
 *
 * ```ts
 * export const POST = withNetGreenerRoute(async (req) => {
 *   return Response.json({ ok: true })
 * }, { routeTemplate: '/api/intake' })
 * ```
 */
export function withNetGreenerRoute<
  TReq extends NextRequestLike,
  TArgs extends unknown[],
  TResult,
>(
  handler: (req: TReq, ...args: TArgs) => Promise<TResult> | TResult,
  opts: NetGreenerNextOptions = {},
): (req: TReq, ...args: TArgs) => Promise<TResult> {
  const runtime = getRuntime({
    collector: 'next_app_router',
    framework: 'next',
    ...opts,
  })
  runtime.start()
  const tenantConfig = tenantConfigFromRuntime(runtime.config)

  return async function netgreenerNextHandler(req: TReq, ...args: TArgs) {
    if (!runtime.enabled) {
      return handler(req, ...args)
    }

    const method = (req.method || 'GET').toUpperCase()
    const path = nextRouteTemplate(req, opts.routeTemplate)
    const resolveServiceUnit = () => `${method} ${path}`
    const fakeHttpReq = {
      method,
      headers: headersAsRecord(req.headers),
    }
    const entryTenant: TenantContext | null = resolveTenantFromHttpRequest(
      fakeHttpReq,
      tenantConfig,
    )

    return runWithTenantContext(entryTenant, () =>
      runWithRequestAttribution(
        {
          resolveServiceUnit,
          serviceUnit: resolveServiceUnit(),
        },
        async () => {
          const tenantStore: TenantStore = getTenantStore() ?? {
            current: entryTenant,
          }
          const started = process.hrtime.bigint()
          const resourceMark = beginProcessResourceSample()
          const requestId = randomUUID()
          getOccupancyTracker().begin(requestId)
          runtime.beginRequest()
          let statusCode = 200
          try {
            const result = await handler(req, ...args)
            statusCode = statusFromResult(result)
            return result
          } catch (err) {
            statusCode = 500
            throw err
          } finally {
            const ended = process.hrtime.bigint()
            const durationMs = Number(ended - started) / 1e6
            const resources = endProcessResourceSample(resourceMark)
            const serviceUnit = resolveServiceUnit()
            getOccupancyTracker().end(requestId, serviceUnit)
            runWithTenantContext(tenantStore.current, () => {
              runtime.recordHttp({
                method,
                path,
                statusCode,
                durationMs,
                cpuTimeMs: resources.cpuTimeMs,
                peakRssKb: resources.rssKb,
              })
            })
            runtime.endRequest()
            if (runtime.lifecycle === 'ephemeral') {
              void runtime.flushForInvokeEnd()
            }
          }
        },
      ),
    )
  }
}

function statusFromResult(result: unknown): number {
  if (
    result &&
    typeof result === 'object' &&
    'status' in result &&
    typeof (result as { status: unknown }).status === 'number'
  ) {
    return (result as { status: number }).status
  }
  return 200
}

export function getNextRuntime(): NetGreenerRuntime {
  return getRuntime({ collector: 'next_app_router', framework: 'next' })
}

/** Explicit flush helper for instrumentation ``onRequestError`` / custom hooks. */
export async function flushNetGreenerNext(
  kind: 'manual' | 'shutdown' | 'invoke_end' = 'manual',
): Promise<UploadResult | null> {
  const runtime = getNextRuntime()
  if (kind === 'shutdown') return runtime.shutdown()
  if (kind === 'invoke_end') return runtime.flushForInvokeEnd()
  return runtime.flush(kind)
}

/**
 * Schedule a best-effort flush after the response (Vercel ``waitUntil`` when present).
 * Fail-open: never throws into the customer path.
 */
export function scheduleNetGreenerFlush(
  waitUntil?: (promise: Promise<unknown>) => void,
): void {
  const p = flushNetGreenerNext('invoke_end').catch(() => null)
  if (typeof waitUntil === 'function') {
    waitUntil(p)
    return
  }
  void p
}
