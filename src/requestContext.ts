import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Current inbound HTTP / task unit for outbound attribution.
 *
 * Prefer ``resolveServiceUnit`` when route metadata may appear after middleware
 * entry (Express). Callers that await work (outbound fetch) must snapshot
 * ``attributionServiceUnit()`` when the call begins. Static ``serviceUnit``
 * remains for workers/batch.
 */
export type RequestAttribution = {
  serviceUnit?: string
  resolveServiceUnit?: () => string
}

const storage = new AsyncLocalStorage<RequestAttribution | null>()

export function runWithRequestAttribution<T>(
  attribution: RequestAttribution | null,
  fn: () => T,
): T {
  return storage.run(attribution, fn)
}

/**
 * Bind attribution for frameworks (e.g. Fastify) whose hooks return before the
 * route runs — ``run()`` would exit too early. Cleared implicitly by the next
 * ``run``/``enterWith`` on another request.
 */
export function enterRequestAttribution(attribution: RequestAttribution | null): void {
  storage.enterWith(attribution)
}

export function getRequestAttribution(): RequestAttribution | null {
  return storage.getStore() ?? null
}

export function attributionServiceUnit(): string | null {
  const store = getRequestAttribution()
  if (!store) return null
  if (typeof store.resolveServiceUnit === 'function') {
    try {
      const resolved = store.resolveServiceUnit()
      if (typeof resolved === 'string' && resolved.trim()) return resolved.trim()
    } catch {
      // Fall through to static unit.
    }
  }
  const staticUnit = (store.serviceUnit || '').trim()
  return staticUnit || null
}
