/**
 * Revision-bound dry-run artifact helpers (N6 evidence prep).
 * Redacts secrets; does not upload; does not change RunSession flush pipelines.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DRY_RUN_ARTIFACT_SCHEMA = 'netgreener_node_dry_run_artifact_v0'

const SECRET_STRING_RE =
  /\b(?:ngs_[A-Za-z0-9._-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-[A-Za-z0-9]{8,})\b/gi

const SECRET_KEY_RE =
  /^(?:authorization|api[_-]?key|token|access[_-]?token|password|secret|NETGREENER_TOKEN)$/i

export type DryRunArtifactV0 = {
  schema: typeof DRY_RUN_ARTIFACT_SCHEMA
  git_sha: string
  git_sha_short: string
  node_version: string
  package_name: string
  package_version: string
  created_at: string
  dry_run: true
  upload: 'never'
  sources: string[]
  checks: {
    ok: boolean
    has_session_metadata: boolean
    has_service_runtime_v0: boolean
    collector: string | null
  }
  payload_sha256_prefix: string
  payload_redacted: unknown
}

/** Deep-clone JSON-ish values while redacting secret-looking strings/keys. */
export function redactSensitive(value: unknown): unknown {
  if (value == null) return value
  if (typeof value === 'string') {
    return value.replace(SECRET_STRING_RE, '[REDACTED]')
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((v) => redactSensitive(v))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = '[REDACTED]'
        continue
      }
      out[k] = redactSensitive(v)
    }
    return out
  }
  return String(value)
}

export function sha256Prefix(value: unknown, chars = 12): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  return createHash('sha256').update(raw).digest('hex').slice(0, chars).toUpperCase()
}

export function extractDryRunChecks(payload: unknown): DryRunArtifactV0['checks'] {
  const body =
    payload && typeof payload === 'object' && 'body' in (payload as object)
      ? (payload as { body?: unknown }).body
      : payload
  const meta =
    body && typeof body === 'object' && 'session_metadata' in (body as object)
      ? (body as { session_metadata?: Record<string, unknown> }).session_metadata
      : body && typeof body === 'object'
        ? (body as Record<string, unknown>)
        : null
  const srv =
    meta && typeof meta === 'object'
      ? (meta.service_runtime_v0 as Record<string, unknown> | undefined)
      : undefined
  const collector =
    srv && typeof srv.collector === 'string' ? String(srv.collector) : null
  const hasMeta = Boolean(meta && typeof meta === 'object')
  const hasSrv = Boolean(srv && typeof srv === 'object')
  return {
    ok: hasMeta && hasSrv,
    has_session_metadata: hasMeta,
    has_service_runtime_v0: hasSrv,
    collector,
  }
}

export type BuildDryRunArtifactInput = {
  payload: unknown
  gitSha: string
  packageName?: string
  packageVersion?: string
  sources?: string[]
  createdAt?: string
  nodeVersion?: string
}

export function buildDryRunArtifact(input: BuildDryRunArtifactInput): DryRunArtifactV0 {
  const redacted = redactSensitive(input.payload)
  const checks = extractDryRunChecks(input.payload)
  const sha = String(input.gitSha || 'unknown').trim() || 'unknown'
  return {
    schema: DRY_RUN_ARTIFACT_SCHEMA,
    git_sha: sha,
    git_sha_short: sha === 'unknown' ? 'unknown' : sha.slice(0, 7),
    node_version: input.nodeVersion || process.version,
    package_name: input.packageName || '@netgreener/runtime',
    package_version: input.packageVersion || '0.0.0',
    created_at: input.createdAt || new Date().toISOString(),
    dry_run: true,
    upload: 'never',
    sources: input.sources?.length ? [...input.sources] : ['express-dry-run'],
    checks,
    payload_sha256_prefix: sha256Prefix(redacted),
    payload_redacted: redacted,
  }
}

export function writeDryRunArtifact(
  artifactsDir: string,
  artifact: DryRunArtifactV0,
): { summaryPath: string; latestPath: string } {
  mkdirSync(artifactsDir, { recursive: true })
  const stamp = artifact.created_at.replace(/[:.]/g, '-')
  const summaryPath = join(
    artifactsDir,
    `${artifact.git_sha_short}-${stamp}-summary.json`,
  )
  const latestPath = join(artifactsDir, 'latest-summary.json')
  const json = `${JSON.stringify(artifact, null, 2)}\n`
  writeFileSync(summaryPath, json, 'utf8')
  writeFileSync(latestPath, json, 'utf8')
  return { summaryPath, latestPath }
}

/** Fail closed if redacted text still looks like a live token. */
export function assertArtifactRedacted(artifact: DryRunArtifactV0): void {
  const blob = JSON.stringify(artifact)
  if (/\bngs_[A-Za-z0-9._-]{8,}\b/.test(blob)) {
    throw new Error('dry-run artifact still contains an ngs_ token (redaction failed)')
  }
  if (/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/i.test(blob)) {
    throw new Error('dry-run artifact still contains a Bearer token (redaction failed)')
  }
  if (artifact.upload !== 'never' || artifact.dry_run !== true) {
    throw new Error('dry-run artifact must declare dry_run=true and upload=never')
  }
}
