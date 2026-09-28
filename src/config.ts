export type RuntimeConfig = {
  enabled: boolean
  apiUrl: string
  token: string
  projectId: number
  organizationId: number | null
  flushIntervalMs: number
  dryRun: boolean
  deployEnvironment: string | null
  releaseTag: string | null
  /** Watts used for crude window energy estimate (trend accuracy). */
  estimateTdpWatts: number
  tenantSource: string
  tenantClaim: string
  tenantHeader: string
  tenantPathRegex: string | null
  tenantTaskKwarg: string
  tenantLabelClaim: string | null
}

/** Established v0 flush / TDP bounds (committed Node runtime foundation). */
export const DEFAULT_RUNTIME_FLUSH_MINUTES = 5
export const MIN_RUNTIME_FLUSH_MINUTES = 1
export const MAX_RUNTIME_FLUSH_MINUTES = 24 * 60
export const DEFAULT_ESTIMATE_TDP_WATTS = 65
export const MIN_ESTIMATE_TDP_WATTS = 1
/** Committed ceiling is 10_000 W — not the working-tree test literal 2000. */
export const MAX_ESTIMATE_TDP_WATTS = 10_000

const MIN_RUNTIME_FLUSH_INTERVAL_MS = MIN_RUNTIME_FLUSH_MINUTES * 60 * 1000
const MAX_RUNTIME_FLUSH_INTERVAL_MS = MAX_RUNTIME_FLUSH_MINUTES * 60 * 1000

function envTruthy(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = (env[name] || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

function envNumberInRange(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = (env[name] || '').trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback
}

function envPositiveSafeInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = (env[name] || '').trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : fallback
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

/**
 * Load runtime config from the supplied env object (defaults to process.env).
 *
 * Every field is read from that object so callers can pass an isolated map
 * without ambient process.env leaking into tests or programmatic loads.
 *
 * Required when enabled: NETGREENER_TOKEN, NETGREENER_PROJECT_ID
 * API URL: NETGREENER_API_URL (default https://core-api.netgreener.com)
 */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const enabled = envTruthy(env, 'NETGREENER_SERVICE_RUNTIME')
  const apiUrl = (env.NETGREENER_API_URL || 'https://core-api.netgreener.com').replace(/\/+$/, '')
  const token = (env.NETGREENER_TOKEN || '').trim()
  const projectId = envPositiveSafeInteger(env, 'NETGREENER_PROJECT_ID', 0)
  const organizationIdRaw = envPositiveSafeInteger(env, 'NETGREENER_ORG_ID', 0)
  const flushMinutes = envNumberInRange(
    env,
    'NETGREENER_RUNTIME_FLUSH_MINUTES',
    DEFAULT_RUNTIME_FLUSH_MINUTES,
    MIN_RUNTIME_FLUSH_MINUTES,
    MAX_RUNTIME_FLUSH_MINUTES,
  )
  return {
    enabled,
    apiUrl,
    token,
    projectId,
    organizationId: organizationIdRaw > 0 ? organizationIdRaw : null,
    flushIntervalMs: flushMinutes * 60 * 1000,
    dryRun: envTruthy(env, 'NETGREENER_RUNTIME_DRY_RUN'),
    deployEnvironment: (env.NETGREENER_DEPLOY_ENVIRONMENT || env.DEPLOY_ENV || '').trim() || null,
    releaseTag: (env.NETGREENER_RELEASE_TAG || env.GIT_SHA || '').trim() || null,
    estimateTdpWatts: envNumberInRange(
      env,
      'NETGREENER_ESTIMATE_TDP_WATTS',
      DEFAULT_ESTIMATE_TDP_WATTS,
      MIN_ESTIMATE_TDP_WATTS,
      MAX_ESTIMATE_TDP_WATTS,
    ),
    tenantSource: (env.NETGREENER_TENANT_SOURCE || 'none').trim().toLowerCase(),
    tenantClaim: (env.NETGREENER_TENANT_CLAIM || 'organization_id').trim(),
    tenantHeader: (env.NETGREENER_TENANT_HEADER || 'X-Organization-Id').trim(),
    tenantPathRegex: (env.NETGREENER_TENANT_PATH_REGEX || '').trim() || null,
    tenantTaskKwarg: (env.NETGREENER_TENANT_TASK_KWARG || 'organization_id').trim(),
    tenantLabelClaim: (env.NETGREENER_TENANT_LABEL_CLAIM || '').trim() || null,
  }
}

export function configReady(config: RuntimeConfig): { ok: boolean; reason?: string } {
  if (!config.enabled) return { ok: false, reason: 'NETGREENER_SERVICE_RUNTIME not enabled' }
  if (!config.token) return { ok: false, reason: 'NETGREENER_TOKEN missing' }
  if (!isPositiveSafeInteger(config.projectId)) {
    return { ok: false, reason: 'NETGREENER_PROJECT_ID must be a positive safe integer' }
  }
  if (config.organizationId !== null && !isPositiveSafeInteger(config.organizationId)) {
    return { ok: false, reason: 'NETGREENER_ORG_ID must be a positive safe integer' }
  }
  if (
    !Number.isFinite(config.flushIntervalMs) ||
    config.flushIntervalMs < MIN_RUNTIME_FLUSH_INTERVAL_MS ||
    config.flushIntervalMs > MAX_RUNTIME_FLUSH_INTERVAL_MS
  ) {
    return {
      ok: false,
      reason: `flushIntervalMs must be between ${MIN_RUNTIME_FLUSH_INTERVAL_MS} and ${MAX_RUNTIME_FLUSH_INTERVAL_MS}`,
    }
  }
  if (
    !Number.isFinite(config.estimateTdpWatts) ||
    config.estimateTdpWatts < MIN_ESTIMATE_TDP_WATTS ||
    config.estimateTdpWatts > MAX_ESTIMATE_TDP_WATTS
  ) {
    return {
      ok: false,
      reason: `estimateTdpWatts must be between ${MIN_ESTIMATE_TDP_WATTS} and ${MAX_ESTIMATE_TDP_WATTS}`,
    }
  }
  if (!config.apiUrl) return { ok: false, reason: 'NETGREENER_API_URL missing' }
  return { ok: true }
}
