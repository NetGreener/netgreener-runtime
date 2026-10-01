import {
  getRuntime,
  type NetGreenerRuntime,
  type NetGreenerRuntimeOptions,
} from './runtime.js'
import {
  enterTenantStore,
  resolveTenantFromHttpRequest,
  runWithTenantContext,
  setTenantContext,
  tenantConfigFromRuntime,
  type TenantStore,
} from './tenantContext.js'
import { enterRequestAttribution } from './requestContext.js'
import { UNKNOWN_ROUTE_TEMPLATE } from './express.js'
import {
  beginProcessResourceSample,
  endProcessResourceSample,
  type ProcessResourceMark,
} from './processResources.js'

/** Minimal Fastify-compatible request shape (avoid hard dependency). */
export type FastifyRequestLike = {
  method?: string
  url?: string
  /** Fastify 3/4 route pattern when routing has matched. */
  routerPath?: string
  /** Fastify 4.16+ / 5 route config url (template). */
  routeOptions?: { url?: string }
  headers?: Record<string, unknown>
}

export type FastifyReplyLike = {
  statusCode?: number
}

export type FastifyDone = (err?: Error) => void

export type FastifyLike = {
  addHook: (
    name: 'onRequest' | 'onResponse' | 'onError' | string,
    handler: (...args: unknown[]) => unknown,
  ) => unknown
  register?: (plugin: unknown, opts?: unknown) => Promise<unknown> | unknown
}

const MAX_ROUTE_TEMPLATE_LEN = 512

const REQ_STATE = Symbol.for('netgreener.fastify.requestState')

type RequestState = {
  tenantStore: TenantStore
  method: string
  started: bigint
  resourceMark: ProcessResourceMark
  recorded: boolean
}

/**
 * Bounded template for service_unit attribution.
 * Never fall back to raw customer paths, query strings, or url.
 */
export function fastifyRouteTemplate(req: FastifyRequestLike): string {
  const candidates = [req.routeOptions?.url, req.routerPath]
  for (const route of candidates) {
    if (typeof route !== 'string') continue
    const template = route.trim()
    if (
      !template ||
      template.length > MAX_ROUTE_TEMPLATE_LEN ||
      template.includes('?') ||
      template.includes('#')
    ) {
      continue
    }
    return template
  }
  return UNKNOWN_ROUTE_TEMPLATE
}

function httpServiceUnit(method: string, req: FastifyRequestLike): string {
  return `${method} ${fastifyRouteTemplate(req)}`
}

function getRequestState(req: object): RequestState | undefined {
  return (req as { [REQ_STATE]?: RequestState })[REQ_STATE]
}

function setRequestState(req: object, state: RequestState): void {
  ;(req as { [REQ_STATE]?: RequestState })[REQ_STATE] = state
}

/**
 * Bind tenant on the Fastify request-scoped store (and ALS when active).
 * Prefer this after auth in Fastify handlers — ``setTenantContext`` alone may
 * not update the store captured at ``onRequest`` when ALS does not span the route.
 */
export function bindFastifyTenant(
  request: object,
  ctx: import('./tenantContext.js').TenantContext,
): void {
  const state = getRequestState(request)
  if (state) state.tenantStore.current = ctx
  setTenantContext(ctx)
}

/**
 * Fastify plugin: record per-route latency/status into NetGreenerRuntime.
 *
 * Register with ``await fastify.register(netgreenerFastifyPlugin())`` (or
 * ``fastify.register(netgreenerFastifyPlugin({ config }))``).
 *
 * The plugin breaks Fastify encapsulation (skip-override) so hooks apply to
 * routes registered on the same instance after ``register``, matching Express
 * middleware scope.
 *
 * Enable with NETGREENER_SERVICE_RUNTIME=1 and credentials (see README).
 * Installs outbound ``fetch`` metering when runtime is enabled (via getRuntime.start).
 *
 * Route identity prefers ``routeOptions.url`` / ``routerPath`` at response time.
 * Raw ``url`` is never a metering fallback.
 *
 * Tenant/attribution use ``enterWith`` so ALS spans Fastify's hook → route gap
 * (unlike Express, where ``next()`` stays inside ``run()``).
 */
export function netgreenerFastifyPlugin(
  opts: NetGreenerRuntimeOptions = {},
): (fastify: FastifyLike) => Promise<void> {
  const runtime = getRuntime({
    collector: 'fastify_middleware',
    framework: 'fastify',
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

  const tenantConfig = tenantConfigFromRuntime(runtime.config)

  const plugin = async function netgreenerFastify(fastify: FastifyLike): Promise<void> {
    if (!runtime.enabled) return

    fastify.addHook(
      'onRequest',
      function netgreenerOnRequest(request: unknown, _reply: unknown, done: unknown) {
        const req = request as FastifyRequestLike & object
        const entryTenant = resolveTenantFromHttpRequest(req, tenantConfig)
        const method = (req.method || 'GET').toUpperCase()
        const resolveServiceUnit = () => httpServiceUnit(method, req)
        const tenantStore = enterTenantStore(entryTenant)
        enterRequestAttribution({
          resolveServiceUnit,
          serviceUnit: resolveServiceUnit(),
        })
        setRequestState(req, {
          tenantStore,
          method,
          started: process.hrtime.bigint(),
          resourceMark: beginProcessResourceSample(),
          recorded: false,
        })
        runtime.beginRequest()
        if (typeof done === 'function') {
          ;(done as FastifyDone)()
        }
      },
    )

    const finish = (request: unknown, reply: unknown, done: unknown) => {
      const req = request as FastifyRequestLike & object
      const state = getRequestState(req)
      if (!state || state.recorded) {
        if (typeof done === 'function') (done as FastifyDone)()
        return
      }
      state.recorded = true
      const durationMs = Number(process.hrtime.bigint() - state.started) / 1e6
      const resources = endProcessResourceSample(state.resourceMark)
      const path = fastifyRouteTemplate(req)
      const statusCode =
        typeof (reply as FastifyReplyLike)?.statusCode === 'number'
          ? (reply as FastifyReplyLike).statusCode!
          : 200
      runWithTenantContext(state.tenantStore.current, () => {
        runtime.recordHttp({
          method: state.method,
          path,
          statusCode,
          durationMs,
          cpuTimeMs: resources.cpuTimeMs,
          peakRssKb: resources.rssKb,
        })
      })
      runtime.endRequest()
      if (typeof done === 'function') (done as FastifyDone)()
    }

    fastify.addHook('onResponse', function netgreenerOnResponse(request, reply, done) {
      finish(request, reply, done)
    })
  }

  // Break Fastify encapsulation so root `register(plugin)` meters sibling routes
  // (same intent as `fastify-plugin` without a hard dependency).
  const pluginMeta = plugin as unknown as {
    [key: symbol]: unknown
  }
  pluginMeta[Symbol.for('skip-override')] = true
  pluginMeta[Symbol.for('fastify.display-name')] = 'netgreener-fastify'

  return plugin
}

export function getFastifyRuntime(): NetGreenerRuntime {
  return getRuntime({ collector: 'fastify_middleware', framework: 'fastify' })
}
