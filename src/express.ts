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

/** Minimal Express-compatible types (avoid hard dependency for unit tests). */
export type ExpressRequest = {
  method?: string
  path?: string
  url?: string
  route?: { path?: string }
  baseUrl?: string
  headers?: Record<string, unknown>
}

export type ExpressResponse = {
  statusCode?: number
  on: (event: string, listener: (...args: unknown[]) => void) => unknown
}

export type ExpressNext = (err?: unknown) => void

/**
 * Bounded template for service_unit attribution.
 * Never fall back to raw customer paths, baseUrl mounts, or query strings.
 */
export const UNKNOWN_ROUTE_TEMPLATE = '<unmatched>'

const MAX_ROUTE_TEMPLATE_LEN = 512

/**
 * Return only a framework-owned route template.
 *
 * Express ``req.path``, ``req.url``, and ``req.baseUrl`` may contain customer
 * identifiers or query values — they are never safe metering fallbacks.
 * Prefer resolving this at finish/close (after routing) rather than at entry.
 */
export function expressRouteTemplate(req: ExpressRequest): string {
  const route = req.route?.path
  if (typeof route !== 'string') return UNKNOWN_ROUTE_TEMPLATE
  const template = route.trim()
  if (
    !template ||
    template.length > MAX_ROUTE_TEMPLATE_LEN ||
    template.includes('?') ||
    template.includes('#')
  ) {
    return UNKNOWN_ROUTE_TEMPLATE
  }
  return template
}

function httpServiceUnit(method: string, req: ExpressRequest): string {
  return `${method} ${expressRouteTemplate(req)}`
}

/**
 * Express middleware: record per-route latency/status into NetGreenerRuntime.
 *
 * Enable with NETGREENER_SERVICE_RUNTIME=1 and credentials (see README).
 * Also installs outbound ``fetch`` metering (N2) when runtime is enabled.
 *
 * Route identity is resolved when the response finishes (or on sync handler
 * throw), so Express can attach ``req.route`` after middleware entry.
 *
 * Manual ``setTenantContext`` after auth mutates the request tenant store in
 * place; finish/close read that store rather than freezing the entry-time value.
 */
export function netgreenerExpressMiddleware(
  opts: NetGreenerRuntimeOptions = {},
): (req: ExpressRequest, res: ExpressResponse, next: ExpressNext) => void {
  const runtime = getRuntime({
    collector: 'express_middleware',
    framework: 'express',
    ...opts,
  })
  runtime.start()

  const onSignal = () => {
    void runtime.shutdown()
  }
  process.once('beforeExit', onSignal)
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  // Prefer programmatic RuntimeConfig over ambient process.env.
  const tenantConfig = tenantConfigFromRuntime(runtime.config)

  return function netgreenerMiddleware(req, res, next) {
    if (!runtime.enabled) {
      next()
      return
    }

    const entryTenant: TenantContext | null = resolveTenantFromHttpRequest(req, tenantConfig)
    const method = (req.method || 'GET').toUpperCase()
    const resolveServiceUnit = () => httpServiceUnit(method, req)

    const handle = () => {
      // Same mutable cell ``setTenantContext`` updates (manual auth binding).
      const tenantStore: TenantStore = getTenantStore() ?? { current: entryTenant }
      const started = process.hrtime.bigint()
      const resourceMark = beginProcessResourceSample()
      let recorded = false
      const finish = () => {
        if (recorded) return
        recorded = true
        const ended = process.hrtime.bigint()
        const durationMs = Number(ended - started) / 1e6
        const resources = endProcessResourceSample(resourceMark)
        const path = expressRouteTemplate(req)
        const statusCode = typeof res.statusCode === 'number' ? res.statusCode : 200
        // finish/close may run outside the request ALS — re-enter the live store.
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
      }
      res.on('finish', finish)
      res.on('close', finish)
      try {
        next()
      } catch (err) {
        // Do not record here: status may still change before finish/close.
        // Preserve the original error without mutating response status.
        throw err
      }
    }

    const withAttribution = () =>
      runWithRequestAttribution(
        {
          resolveServiceUnit,
          // Snapshot for workers / fallback; outbound captures at call entry.
          serviceUnit: resolveServiceUnit(),
        },
        handle,
      )

    // Always enter a request-local tenant store (null clears inheritance).
    runWithTenantContext(entryTenant, withAttribution)
  }
}

export function getExpressRuntime(): NetGreenerRuntime {
  return getRuntime({ collector: 'express_middleware', framework: 'express' })
}
