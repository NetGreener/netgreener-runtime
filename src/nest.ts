/**
 * NestJS via underlying HTTP adapter (experimental N1 v0).
 *
 * Nest does not need a separate interception stack: apply Express middleware or
 * the Fastify plugin on the adapter Nest already uses. No hard ``@nestjs/*``
 * dependency.
 */

import {
  netgreenerExpressMiddleware,
  type ExpressNext,
  type ExpressRequest,
  type ExpressResponse,
} from './express.js'
import { netgreenerFastifyPlugin, type FastifyLike } from './fastify.js'
import {
  getRuntime,
  type NetGreenerRuntime,
  type NetGreenerRuntimeOptions,
} from './runtime.js'

/** Duck-typed Nest application surface used for adapter detection. */
export type NestApplicationLike = {
  getHttpAdapter?: () => {
    getType?: () => string
    getInstance?: () => FastifyLike | unknown
  }
  use?: (middleware: unknown) => unknown
}

export type NestHttpAdapterKind = 'express' | 'fastify' | 'unknown'

/**
 * Detect whether a Nest app is backed by Express or Fastify.
 * Uses ``HttpAdapter.getType()`` when present (Nest public API).
 */
export function detectNestHttpAdapter(app: NestApplicationLike): NestHttpAdapterKind {
  try {
    const adapter = app.getHttpAdapter?.()
    const raw = (adapter?.getType?.() || '').toLowerCase().trim()
    if (raw === 'express') return 'express'
    if (raw === 'fastify') return 'fastify'
    const name = (adapter as { constructor?: { name?: string } })?.constructor?.name || ''
    const lower = name.toLowerCase()
    if (lower.includes('fastify')) return 'fastify'
    if (lower.includes('express')) return 'express'
  } catch {
    /* ignore */
  }
  return 'unknown'
}

/**
 * Express-adapter Nest apps: ``app.use(netgreenerNestExpressMiddleware())``
 * after ``NestFactory.create`` (same place you add other Express middleware).
 */
export function netgreenerNestExpressMiddleware(
  opts: NetGreenerRuntimeOptions = {},
): (req: ExpressRequest, res: ExpressResponse, next: ExpressNext) => void {
  return netgreenerExpressMiddleware({
    ...opts,
    collector: opts.collector ?? 'nest_express_middleware',
    framework: opts.framework ?? 'nest',
  })
}

/**
 * Fastify-adapter Nest apps: register on the underlying Fastify instance::
 *
 *   const instance = app.getHttpAdapter().getInstance()
 *   await instance.register(netgreenerNestFastifyPlugin())
 */
export function netgreenerNestFastifyPlugin(
  opts: NetGreenerRuntimeOptions = {},
): (fastify: FastifyLike) => Promise<void> {
  return netgreenerFastifyPlugin({
    ...opts,
    collector: opts.collector ?? 'nest_fastify_middleware',
    framework: opts.framework ?? 'nest',
  })
}

/**
 * Convenience: apply the matching hook for the Nest HTTP adapter in use.
 * Returns the detected adapter kind. Fastify path is async (``register``).
 */
export async function applyNetGreenerNestHooks(
  app: NestApplicationLike,
  opts: NetGreenerRuntimeOptions = {},
): Promise<NestHttpAdapterKind> {
  const kind = detectNestHttpAdapter(app)
  if (kind === 'express') {
    if (typeof app.use !== 'function') {
      throw new Error('Nest Express adapter expected app.use(...)')
    }
    app.use(netgreenerNestExpressMiddleware(opts))
    return kind
  }
  if (kind === 'fastify') {
    const instance = app.getHttpAdapter?.()?.getInstance?.() as FastifyLike | undefined
    if (!instance || typeof instance.register !== 'function') {
      throw new Error('Nest Fastify adapter expected getInstance().register(...)')
    }
    await instance.register(netgreenerNestFastifyPlugin(opts))
    return kind
  }
  throw new Error(
    'Unknown Nest HTTP adapter — use netgreenerNestExpressMiddleware or netgreenerNestFastifyPlugin explicitly',
  )
}

export function getNestRuntime(kind: 'express' | 'fastify' = 'express'): NetGreenerRuntime {
  if (kind === 'fastify') {
    return getRuntime({ collector: 'nest_fastify_middleware', framework: 'nest' })
  }
  return getRuntime({ collector: 'nest_express_middleware', framework: 'nest' })
}
