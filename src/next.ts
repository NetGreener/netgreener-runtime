/**
 * Next.js App Router adapter (Wave 3 pilot).
 *
 * Maps into the same Runtime / observation / export path as Express.
 * Not a Vercel production claim — use persistent Node or pilot wording.
 * Does not change NETGREENER_EXPORT_MODE defaults.
 */

import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

import {
  getRuntime,
  type NetGreenerRuntime,
  type NetGreenerRuntimeOptions,
} from './runtime.js'
import {
  getTenantStore,
  resolveTenantFromHttpRequest,
  normalizeTenantId,
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
import {
  _awaitPendingUsageParses,
  outboundHttpInFlight,
  whenOutboundHttpIdle,
} from './externalApiMeter.js'
import type { UploadResult } from './uploader.js'
export { withNetGreener, type NextConfigLike } from './nextConfig.js'

type NextAfterFn = (task: () => Promise<unknown> | unknown) => void

/**
 * Sibling ``after()`` callbacks start in parallel with ours (Next.js p-queue).
 * A short quiet window lets those callbacks start their ``fetch`` before upload.
 */
let invokeFlushQuietMs = 25

/** Test hook. ``undefined`` loads ``next/server`` ``after`` when the app provides it. */
let nextAfterOverride: NextAfterFn | null | undefined

export function _setNextAfterForTests(fn: NextAfterFn | null | undefined): void {
  nextAfterOverride = fn
}

export function _setInvokeFlushQuietMsForTests(ms: number): void {
  invokeFlushQuietMs = ms
}

export const UNKNOWN_NEXT_ROUTE_TEMPLATE = '<unmatched>'
const MAX_ROUTE_TEMPLATE_LEN = 512

/** Minimal Next Request-like shape (App Router / Fetch API). */
export type NextRequestLike = {
  method?: string
  url?: string
  nextUrl?: { pathname?: string }
  headers?: Headers | Record<string, unknown>
  /** Platform keep-alive when Next.js ``after`` is not available. */
  waitUntil?: (promise: Promise<unknown>) => void
}

export type NextRouteContext = Record<string, unknown>

/** App-supplied tenant id for this invoke. NetGreener does not read Supabase. */
export type NextTenantResolver = (
  req: NextRequestLike,
) => Promise<string | null | undefined> | string | null | undefined

let installedTenantResolver: NextTenantResolver | undefined

export type NetGreenerNextOptions = NetGreenerRuntimeOptions & {
  /**
   * Static route template override (e.g. ``/api/intake/[id]``).
   * Prefer this over raw pathnames that may embed customer ids.
   */
  routeTemplate?: string
  /** Overrides the header tenant for this install. */
  resolveTenant?: NextTenantResolver
  /** Service-unit verb recorded on the sample. Defaults to the request method. */
  recordMethod?: string
  /** Aggregator unit type. Defaults to ``http_route`` or ``cron``. */
  unitType?: string
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
  if (opts.resolveTenant) installedTenantResolver = opts.resolveTenant
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

    const path = nextRouteTemplate(req, opts.routeTemplate)
    const cron =
      opts.unitType === 'cron' || path === '/api/cron' || path.startsWith('/api/cron/')
    const method = (opts.recordMethod || (cron ? 'CRON' : req?.method || 'GET')).toUpperCase()
    const unitType = opts.unitType || (cron ? 'cron' : 'http_route')
    const resolveServiceUnit = () => `${method} ${path}`
    const fakeHttpReq = {
      method,
      headers: headersAsRecord(req?.headers),
    }
    let entryTenant: TenantContext | null = resolveTenantFromHttpRequest(
      fakeHttpReq,
      tenantConfig,
    )
    const resolver = opts.resolveTenant ?? installedTenantResolver
    if (resolver) {
      try {
        const tenantId = normalizeTenantId(await resolver(req))
        if (tenantId) entryTenant = { tenantId, tenantSource: 'callback' }
      } catch {
        /* fail-open: a tenant callback must not break the request */
      }
    }

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
                unitType,
                cpuTimeMs: resources.cpuTimeMs,
                peakRssKb: resources.rssKb,
              })
            })
            runtime.endRequest({
              deferInvokeFlush: runtime.lifecycle === 'ephemeral',
            })
            if (runtime.lifecycle === 'ephemeral') {
              scheduleEphemeralInvokeFlush(runtime, readWaitUntil(req))
            }
          }
        },
      ),
    )
  }
}

/**
 * Loader target for an App Router route handler.
 * ``cron: true`` records the service unit as ``CRON <template>``.
 */
export function observeNextRoute<T extends (...args: never[]) => unknown>(
  handler: T,
  _method: string,
  routeTemplate: string,
  opts?: { cron?: boolean },
): T {
  return withNetGreenerRoute(handler as never, {
    routeTemplate,
    unitType: opts?.cron ? 'cron' : 'http_route',
    recordMethod: opts?.cron ? 'CRON' : undefined,
  }) as T
}

/** Loader target for a server page. */
export function observeNextPage<T extends (...args: never[]) => unknown>(
  component: T,
  routeTemplate: string,
): T {
  return withNetGreenerRoute(
    ((props: never) => (component as (props: never) => unknown)(props)) as never,
    { routeTemplate, unitType: 'page', recordMethod: 'GET' },
  ) as T
}

/** Loader target for a `'use server'` export. */
export function observeNextAction<T extends (...args: never[]) => unknown>(
  action: T,
  name: string,
  routeTemplate: string,
): T {
  const template = `${routeTemplate}#${name}`.slice(0, 512)
  return withNetGreenerRoute(action as never, {
    routeTemplate: template,
    unitType: 'action',
    recordMethod: 'ACTION',
  }) as T
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
 *
 * Prefers Next.js ``after()``, which runs once the response (including a stream)
 * has closed and is already passed to platform ``waitUntil``.
 */
export function scheduleNetGreenerFlush(
  waitUntil?: (promise: Promise<unknown>) => void,
): void {
  scheduleEphemeralInvokeFlush(getNextRuntime(), waitUntil)
}

function readWaitUntil(
  req: NextRequestLike,
): ((promise: Promise<unknown>) => void) | undefined {
  const maybe = (req as { waitUntil?: (promise: Promise<unknown>) => void }).waitUntil
  return typeof maybe === 'function' ? maybe : undefined
}

const requireFromHere = createRequire(import.meta.url)
let cachedNextAfter: NextAfterFn | null | undefined

function scheduleEphemeralInvokeFlush(
  runtime: NetGreenerRuntime,
  waitUntil?: (promise: Promise<unknown>) => void,
): void {
  // Start the upload only when Next runs the callback. ``after(promise)`` does
  // not wait for the response to close; ``after(fn)`` does.
  const start = () => finishEphemeralInvoke(runtime)
  if (scheduleWithNextAfter(start)) return
  const work = start()
  if (typeof waitUntil === 'function') {
    try {
      waitUntil(work)
      return
    } catch {
      /* fall through; the promise is already running */
    }
  }
  void work
}

function scheduleWithNextAfter(start: () => Promise<void>): boolean {
  const afterFn = resolveNextAfter()
  if (!afterFn) return false
  try {
    afterFn(() => start())
    return true
  } catch {
    return false
  }
}

function resolveNextAfter(): NextAfterFn | null {
  if (nextAfterOverride !== undefined) return nextAfterOverride
  if (cachedNextAfter !== undefined) return cachedNextAfter
  try {
    const mod = requireFromHere('next/server') as { after?: NextAfterFn }
    cachedNextAfter = typeof mod.after === 'function' ? mod.after : null
  } catch {
    cachedNextAfter = null
  }
  return cachedNextAfter
}

async function finishEphemeralInvoke(runtime: NetGreenerRuntime): Promise<void> {
  try {
    await waitForOutboundQuiet()
    await _awaitPendingUsageParses()
    await runtime.flushForInvokeEnd()
  } catch {
    /* fail-open: metering must not break the customer response */
  }
}

async function waitForOutboundQuiet(): Promise<void> {
  await delay(0)
  for (;;) {
    if (outboundHttpInFlight() === 0) {
      await delay(invokeFlushQuietMs)
      if (outboundHttpInFlight() === 0) return
    }
    await whenOutboundHttpIdle()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
