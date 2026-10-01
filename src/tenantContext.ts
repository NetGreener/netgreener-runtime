import { AsyncLocalStorage } from 'node:async_hooks'

/** Downstream B2B customer company id (not NetGreener org, not end-user). */
export type TenantId = string

export type TenantContext = {
  tenantId: TenantId
  tenantSource: string
  tenantLabel?: string
}

const TENANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/**
 * Mutable ALS cell so ``setTenantContext`` (manual auth) updates the same
 * object Express holds for finish/close after the request ALS exits.
 */
export type TenantStore = { current: TenantContext | null }

const storage = new AsyncLocalStorage<TenantStore>()

export function normalizeTenantId(value: unknown): TenantId | null {
  if (value === null || value === undefined) return null
  const cleaned = String(value).trim()
  if (!cleaned || cleaned.includes('@')) return null
  const clipped = cleaned.length > 128 ? cleaned.slice(0, 128) : cleaned
  return TENANT_ID_RE.test(clipped) ? clipped : null
}

export type TenantConfig = {
  enabled: boolean
  source: string
  claim: string
  header: string
  pathRegex: string | null
  taskKwarg: string
  labelClaim: string | null
}

function tenantConfigFromSource(fields: {
  source: string
  claim: string
  header: string
  pathRegex: string | null
  taskKwarg: string
  labelClaim: string | null
}): TenantConfig {
  const source = (fields.source || 'none').trim().toLowerCase()
  const enabled = !['', 'none', 'off', '0', 'false'].includes(source)
  return {
    enabled,
    source,
    claim: (fields.claim || 'organization_id').trim(),
    header: (fields.header || 'X-Organization-Id').trim(),
    pathRegex: (fields.pathRegex || '').trim() || null,
    taskKwarg: (fields.taskKwarg || 'organization_id').trim(),
    labelClaim: (fields.labelClaim || '').trim() || null,
  }
}

export function loadTenantConfig(env: NodeJS.ProcessEnv = process.env): TenantConfig {
  return tenantConfigFromSource({
    source: env.NETGREENER_TENANT_SOURCE || 'none',
    claim: env.NETGREENER_TENANT_CLAIM || 'organization_id',
    header: env.NETGREENER_TENANT_HEADER || 'X-Organization-Id',
    pathRegex: (env.NETGREENER_TENANT_PATH_REGEX || '').trim() || null,
    taskKwarg: env.NETGREENER_TENANT_TASK_KWARG || 'organization_id',
    labelClaim: (env.NETGREENER_TENANT_LABEL_CLAIM || '').trim() || null,
  })
}

/**
 * Build tenant config from effective RuntimeConfig (programmatic opts.config).
 * Prefer this over ambient ``loadTenantConfig()`` when a runtime is already loaded.
 */
export function tenantConfigFromRuntime(config: {
  tenantSource: string
  tenantClaim: string
  tenantHeader: string
  tenantPathRegex: string | null
  tenantTaskKwarg: string
  tenantLabelClaim: string | null
}): TenantConfig {
  return tenantConfigFromSource({
    source: config.tenantSource,
    claim: config.tenantClaim,
    header: config.tenantHeader,
    pathRegex: config.tenantPathRegex,
    taskKwarg: config.tenantTaskKwarg,
    labelClaim: config.tenantLabelClaim,
  })
}

function configuredTenantSourceLabel(config: TenantConfig): string | null {
  if (!config.enabled) return null
  if (config.source === 'jwt_claim') return `jwt_claim:${config.claim}`
  if (config.source === 'header') return `header:${config.header}`
  if (config.source === 'path_regex' && config.pathRegex) return `path_regex:${config.pathRegex}`
  if (config.source === 'task_kwarg') return `task_kwarg:${config.taskKwarg}`
  if (config.source === 'manual') return 'manual'
  return config.source
}

function headerValue(req: { headers?: Record<string, unknown> }, name: string): string | null {
  const headers = req.headers || {}
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue
    if (Array.isArray(value)) return String(value[0] ?? '').trim() || null
    return String(value ?? '').trim() || null
  }
  return null
}

function jwtPayloadUnverified(authorization: string | null): Record<string, unknown> | null {
  if (!authorization) return null
  const auth = authorization.trim()
  if (!auth.toLowerCase().startsWith('bearer ')) return null
  const token = auth.slice(7).trim()
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const segment = parts[1]
    const pad = '='.repeat((4 - (segment.length % 4)) % 4)
    const raw = Buffer.from(segment + pad, 'base64url').toString('utf8')
    const payload = JSON.parse(raw) as unknown
    return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function claimValue(payload: Record<string, unknown>, claim: string): unknown {
  if (claim in payload) return payload[claim]
  if (claim.includes('.')) {
    let cur: unknown = payload
    for (const part of claim.split('.')) {
      if (!cur || typeof cur !== 'object' || !(part in (cur as Record<string, unknown>))) {
        return null
      }
      cur = (cur as Record<string, unknown>)[part]
    }
    return cur
  }
  return null
}

export function resolveTenantFromHttpRequest(
  req: {
    headers?: Record<string, unknown>
    path?: string
    url?: string
  },
  config: TenantConfig,
): TenantContext | null {
  if (!config.enabled || config.source === 'manual') return null

  if (config.source === 'jwt_claim') {
    const payload = jwtPayloadUnverified(headerValue(req, 'authorization'))
    if (!payload) return null
    const tenantId = normalizeTenantId(claimValue(payload, config.claim))
    if (!tenantId) return null
    const labelRaw = config.labelClaim ? claimValue(payload, config.labelClaim) : null
    return {
      tenantId,
      tenantSource: `jwt_claim:${config.claim}`,
      ...(labelRaw != null ? { tenantLabel: String(labelRaw).slice(0, 128) } : {}),
    }
  }

  if (config.source === 'header') {
    const tenantId = normalizeTenantId(headerValue(req, config.header))
    if (!tenantId) return null
    return { tenantId, tenantSource: `header:${config.header}` }
  }

  if (config.source === 'path_regex' && config.pathRegex) {
    const path = (req.path || req.url || '').split('?')[0] || ''
    try {
      const re = new RegExp(config.pathRegex)
      const match = re.exec(path)
      if (!match) return null
      const captured = match[1] ?? match[0]
      const tenantId = normalizeTenantId(captured)
      if (!tenantId) return null
      return { tenantId, tenantSource: `path_regex:${config.pathRegex}` }
    } catch {
      return null
    }
  }

  return null
}

/**
 * Resolve tenant from queue job payload (Celery kwargs / BullMQ job.data).
 * Requires ``NETGREENER_TENANT_SOURCE=task_kwarg``.
 */
export function resolveTenantFromTaskData(
  data: Record<string, unknown> | null | undefined,
  config: TenantConfig,
): TenantContext | null {
  if (!config.enabled || config.source !== 'task_kwarg') return null
  const key = config.taskKwarg || 'organization_id'
  const tenantId = normalizeTenantId((data || {})[key])
  if (!tenantId) return null
  return { tenantId, tenantSource: `task_kwarg:${key}` }
}

export function runWithTenantContext<T>(ctx: TenantContext | null, fn: () => T): T {
  return storage.run({ current: ctx }, fn)
}

/**
 * Enter a mutable tenant cell for the remainder of this async chain (Fastify
 * ``onRequest`` → route). Prefer ``runWithTenantContext`` when the whole
 * handler runs inside one callback (Express ``next``).
 */
export function enterTenantStore(ctx: TenantContext | null): TenantStore {
  const store: TenantStore = { current: ctx }
  storage.enterWith(store)
  return store
}

/** Active mutable tenant cell for this async context (if any). */
export function getTenantStore(): TenantStore | undefined {
  return storage.getStore()
}

export function getTenantContext(): TenantContext | null {
  return storage.getStore()?.current ?? null
}

/**
 * Bind tenant for the current request (e.g. after auth).
 * Mutates the active store in place so finish/close still see the binding
 * after the middleware ALS callback returns.
 */
export function setTenantContext(ctx: TenantContext): void {
  const store = storage.getStore()
  if (store) {
    store.current = ctx
    return
  }
  storage.enterWith({ current: ctx })
}

export function collectWindowTenantIds(
  runtimeV0?: { by_tenant?: Record<string, unknown> } | null,
  externalV0?: { by_tenant?: Record<string, unknown> } | null,
): Set<TenantId> {
  const ids = new Set<TenantId>()
  for (const block of [runtimeV0, externalV0]) {
    if (!block?.by_tenant) continue
    for (const key of Object.keys(block.by_tenant)) {
      if (key) ids.add(key)
    }
  }
  return ids
}

export function attachWindowTenantToRunContext(
  runContext: Record<string, unknown>,
  opts: {
    runtimeV0?: { by_tenant?: Record<string, unknown> } | null
    externalV0?: { by_tenant?: Record<string, unknown> } | null
    tenantConfig: TenantConfig
    activeContext?: TenantContext | null
  },
): Record<string, unknown> {
  const tenantIds = collectWindowTenantIds(opts.runtimeV0, opts.externalV0)
  if (tenantIds.size !== 1) return runContext
  const tenantId = [...tenantIds][0]
  runContext.tenant_id = tenantId
  const source =
    configuredTenantSourceLabel(opts.tenantConfig) || opts.activeContext?.tenantSource
  if (source) runContext.tenant_source = source
  const label = opts.activeContext?.tenantLabel
  if (label) runContext.tenant_label = label
  return runContext
}
