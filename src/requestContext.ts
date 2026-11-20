import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

export const EXECUTION_CARRIER_KEY = 'netgreener/execution_v1'
export const EXECUTION_HEADER = 'x-netgreener-execution-v1'
export type ExecutionContext = Readonly<{
  schema_version: 1
  execution_id: string
  step_id: string
  parent_step_id: string | null
  link_state: 'root' | 'local' | 'propagated' | 'missing' | 'invalid'
}>
export type ExecutionCarrier = Pick<ExecutionContext, 'schema_version' | 'execution_id' | 'step_id'>
const executionStorage = new AsyncLocalStorage<ExecutionContext>()
const executionIdPattern = /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/
const validId = (value: unknown): value is string => typeof value === 'string'
  && (value.length === 32 || value.length === 36) && executionIdPattern.test(value)

export function validateExecutionContext(value: unknown): ExecutionContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  if (Object.keys(obj).sort().join(',') !== 'execution_id,link_state,parent_step_id,schema_version,step_id') return null
  if (obj.schema_version !== 1 || !validId(obj.execution_id) || !validId(obj.step_id)) return null
  if (obj.parent_step_id !== null && (!validId(obj.parent_step_id) || obj.parent_step_id === obj.step_id)) return null
  if (typeof obj.link_state !== 'string' || !['root', 'local', 'propagated', 'missing', 'invalid'].includes(obj.link_state)) return null
  if (['local', 'propagated'].includes(String(obj.link_state)) !== (obj.parent_step_id !== null)) return null
  return Object.freeze({ ...obj }) as ExecutionContext
}

export function currentExecutionContext(): ExecutionContext | null {
  return executionStorage.getStore() ?? null
}

export function executionCarrier(): ExecutionCarrier | null {
  const ctx = currentExecutionContext()
  return ctx ? { schema_version: 1, execution_id: ctx.execution_id, step_id: ctx.step_id } : null
}

export function executionHeaders(): Record<string, string> {
  const carrier = executionCarrier()
  return carrier ? { [EXECUTION_HEADER]: JSON.stringify(carrier) } : {}
}

export function newExecutionContext(opts: {
  carrier?: unknown; boundary?: boolean; executionId?: string; stepId?: string
} = {}): ExecutionContext {
  let executionId = opts.executionId
  let parent: string | null = null
  let state: ExecutionContext['link_state'] = opts.boundary ? 'missing' : 'root'
  let carrier = opts.carrier
  if (typeof carrier === 'string') {
    try { carrier = carrier.length <= 512 ? JSON.parse(carrier) : null } catch { carrier = null }
  }
  if (opts.carrier !== undefined && opts.carrier !== null) {
    const obj = carrier as Record<string, unknown> | null
    if (obj && typeof obj === 'object' && !Array.isArray(obj)
      && Object.keys(obj).sort().join(',') === 'execution_id,schema_version,step_id'
      && obj.schema_version === 1 && validId(obj.execution_id) && validId(obj.step_id)) {
      executionId = obj.execution_id; parent = obj.step_id; state = 'propagated'
    } else { executionId = undefined; state = 'invalid' }
  } else if (!opts.boundary && !executionId) {
    const active = currentExecutionContext()
    if (active) { executionId = active.execution_id; parent = active.step_id; state = 'local' }
  }
  const ctx = validateExecutionContext({ schema_version: 1, execution_id: executionId ?? randomUUID().replace(/-/g, ''),
    step_id: opts.stepId ?? randomUUID().replace(/-/g, ''), parent_step_id: parent, link_state: state })
  if (!ctx) throw new Error('Invalid execution identity or self-parent link')
  return ctx
}

export function runWithExecution<T>(opts: {
  carrier?: unknown; boundary?: boolean; executionId?: string; context?: ExecutionContext
}, fn: () => T): T {
  const ctx = opts.context ? validateExecutionContext(opts.context) : newExecutionContext(opts)
  if (!ctx) throw new Error('Invalid execution context')
  return executionStorage.run(ctx, fn)
}

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
