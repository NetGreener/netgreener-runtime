/**
 * Runtime / export health (N6 / CAP-R5 honesty).
 *
 * Additive ``runtime_health_v0`` twin of Python ``netgreener.runtime_health``.
 * Does not change upload defaults or invent collector spool metrics.
 */

import { configReady, loadRuntimeConfig } from './config.js'
import { exportModeFromEnv } from './exporter.js'
import { resolveLifecycle } from './lifecycle.js'
import { normalizeCollectorEndpoint } from './collectorIpc.js'

export type RuntimeSetupCheck = {
  name: string
  status: 'pass' | 'fail' | 'not_verified'
  detail: string
}

export function inspectRuntimeSetup(env: NodeJS.ProcessEnv = process.env) {
  const config = loadRuntimeConfig(env)
  const lifecycle = resolveLifecycle({ env }).lifecycle
  const exportMode = exportModeFromEnv(env, { lifecycle })
  let validApiUrl = false
  try {
    const url = new URL(config.apiUrl)
    validApiUrl = ['https:', 'http:'].includes(url.protocol) && Boolean(url.hostname)
  } catch {}
  let validDelivery = exportMode !== 'collector'
  if (exportMode === 'collector') {
    try {
      const endpoint = new URL(normalizeCollectorEndpoint(env.NETGREENER_COLLECTOR_ENDPOINT || ''))
      validDelivery = endpoint.protocol === 'tcp:'
        ? Boolean(endpoint.hostname && Number(endpoint.port) > 0 && Number(endpoint.port) <= 65535)
        : endpoint.protocol === 'unix:' && process.platform !== 'win32' && endpoint.pathname.startsWith('/')
    } catch {}
  }
  const checks: RuntimeSetupCheck[] = [
    { name: 'runtime_enabled', status: config.enabled ? 'pass' : 'fail', detail: 'Set the token and project ID to enable automatically; NETGREENER_SERVICE_RUNTIME=0 disables it.' },
    { name: 'credentials', status: config.token ? 'pass' : 'fail', detail: 'NETGREENER_TOKEN is checked for presence only; authentication is not verified.' },
    { name: 'project', status: config.projectId > 0 ? 'pass' : 'fail', detail: 'NETGREENER_PROJECT_ID must be a positive safe integer; project access is not verified.' },
    { name: 'api_url', status: validApiUrl ? 'pass' : 'fail', detail: 'NETGREENER_API_URL must be an HTTP(S) URL; the endpoint is not contacted.' },
    { name: 'delivery', status: validDelivery ? 'pass' : 'fail', detail: 'Collector mode requires a valid TCP host/port or supported Unix socket endpoint; availability is not verified.' },
    ...['hooks', 'tenant_attribution', 'provider_instrumentation', 'upload'].map(name => ({
      name, status: 'not_verified' as const,
      detail: 'Verify inside the running application with authenticated traffic and persisted telemetry.',
    })),
  ]
  return {
    schema: 'netgreener_runtime_status_v1' as const,
    scope: 'local_configuration' as const,
    ready: configReady(config).ok && checks.every(check => check.status !== 'fail'),
    enabled: config.enabled,
    dry_run: config.dryRun,
    lifecycle,
    export_mode: exportMode,
    checks,
  }
}

export type RuntimeHealthStatus = 'ok' | 'degraded' | 'conflict' | 'unknown'

export type RuntimeHealthV0 = {
  schema_version: 1
  status: RuntimeHealthStatus
  codes: string[]
  detail: string
  remediation: string[]
  bootstrap: string
  hooks_active: boolean
  process_kind: string
  collector_mode: string | null
  export_mode: string
  export_attempts: number
  export_ok: number
  export_fail: number
  /** Flushes skipped because another flush was in flight (best-effort drop). */
  export_skipped_in_flight: number
}

type HealthState = {
  hooksActive: boolean
  processKind: string
  bootstrap: string
  codes: string[]
  exportMode: string
  exportAttempts: number
  exportOk: number
  exportFail: number
  exportSkippedInFlight: number
  lastError: string | null
}

const state: HealthState = {
  hooksActive: false,
  processKind: 'process',
  bootstrap: 'node_runtime_v0',
  codes: [],
  exportMode: 'direct',
  exportAttempts: 0,
  exportOk: 0,
  exportFail: 0,
  exportSkippedInFlight: 0,
  lastError: null,
}

export function _resetRuntimeHealthForTests(): void {
  state.hooksActive = false
  state.processKind = 'process'
  state.bootstrap = 'node_runtime_v0'
  state.codes = []
  state.exportMode = 'direct'
  state.exportAttempts = 0
  state.exportOk = 0
  state.exportFail = 0
  state.exportSkippedInFlight = 0
  state.lastError = null
}

export function markHooksActive(opts?: {
  processKind?: string
  exportMode?: string
}): void {
  state.hooksActive = true
  if (opts?.processKind) state.processKind = opts.processKind
  if (opts?.exportMode) state.exportMode = opts.exportMode
}

export function noteExportMode(mode: string): void {
  state.exportMode = mode
}

export function noteFlushSkippedInFlight(): void {
  state.exportSkippedInFlight += 1
}

export function noteExportAttempt(mode: string): void {
  state.exportMode = mode
  state.exportAttempts += 1
}

export function noteExportResult(ok: boolean, error?: string): void {
  if (ok) {
    state.exportOk += 1
    state.lastError = null
    state.codes = state.codes.filter((c) => c !== 'export_fail')
  } else {
    state.exportFail += 1
    state.lastError = error || 'export_failed'
    if (!state.codes.includes('export_fail')) state.codes.push('export_fail')
  }
}

function collectorModeFromEnv(): string | null {
  const raw = String(process.env.NETGREENER_COLLECTOR_MODE || '')
    .trim()
    .toLowerCase()
  return raw || null
}

export function buildRuntimeHealthV0(): RuntimeHealthV0 {
  const failRate =
    state.exportAttempts > 0 ? state.exportFail / state.exportAttempts : 0
  let status: RuntimeHealthStatus = 'unknown'
  const codes = [...state.codes]
  const remediation: string[] = []

  if (!state.hooksActive) {
    status = 'unknown'
  } else if (state.lastError && state.exportFail > 0 && failRate >= 0.5) {
    status = 'conflict'
    remediation.push(
      'Check NETGREENER_API_URL / NETGREENER_TOKEN (direct) or NETGREENER_COLLECTOR_ENDPOINT (collector).',
    )
  } else if (state.exportFail > 0 || state.exportSkippedInFlight > 0) {
    status = 'degraded'
    if (state.exportSkippedInFlight > 0) {
      codes.push('export_skipped_in_flight')
      remediation.push(
        'A flush was skipped while another was in flight — window data is retried on failure merge; reduce flush contention if drops grow.',
      )
    }
    if (state.exportFail > 0) {
      remediation.push(
        'Inspect prior export errors; the exact pending window is retained in memory for retry. Direct mode does not survive process restart.',
      )
    }
  } else if (state.exportOk > 0 || state.hooksActive) {
    status = 'ok'
  }

  let detail = 'Node Runtime hooks active.'
  if (state.lastError) {
    detail = `Last export error: ${state.lastError}`
  } else if (state.exportSkippedInFlight > 0) {
    detail = `Hooks active; ${state.exportSkippedInFlight} in-flight flush skip(s).`
  } else if (status === 'ok') {
    detail = 'Node Runtime hooks active; exports healthy.'
  }

  return {
    schema_version: 1,
    status,
    codes: [...new Set(codes)],
    detail,
    remediation,
    bootstrap: state.bootstrap,
    hooks_active: state.hooksActive,
    process_kind: state.processKind,
    collector_mode: collectorModeFromEnv(),
    export_mode: state.exportMode,
    export_attempts: state.exportAttempts,
    export_ok: state.exportOk,
    export_fail: state.exportFail,
    export_skipped_in_flight: state.exportSkippedInFlight,
  }
}

export function mergeHealthIntoMetadata(
  meta: Record<string, unknown>,
  health: RuntimeHealthV0 = buildRuntimeHealthV0(),
): void {
  meta.runtime_health_v0 = health
}
