/**
 * MP2 adapter exporter surface.
 *
 * Default mode is ``direct`` (existing uploadRunSession path). Collector mode is
 * opt-in IPC to a NetGreener collector (durable spool ACK). Do not change the live
 * default without repeated product-owner authorization.
 *
 * ``NETGREENER_MP2_SHADOW_COMPARE=1`` logs canonical payload digests only
 * (no dual-POST, no default flip). Matches Python bridge digest semantics.
 */
import { createHash } from 'node:crypto'
import type { RuntimeConfig } from './config.js'
import {
  sendCollectorEvent,
  newCollectorEventId,
  CollectorIpcError,
} from './collectorIpc.js'
import {
  uploadRunSession,
  type RunSessionCreatePayload,
  type UploadResult,
} from './uploader.js'
import { flushModeRequestsThin } from './serverlessHints.js'

export type ExportMode = 'direct' | 'collector' | 'thin'

export type ExportResult = UploadResult & {
  mode: ExportMode
  durabilityGrade: 'best_effort_in_process' | 'durable_sibling_spool' | 'best_effort_bounded'
  collectorEventId?: string
}

/** NetGreener Observation v1 batch document (semantic envelope object). */
export type ObservationBatchDocument = Record<string, unknown>

export type ObservationExporter = {
  readonly mode: ExportMode
  exportRunSessionWindow(
    config: RuntimeConfig,
    payload: RunSessionCreatePayload,
    fetchImpl?: typeof fetch,
  ): Promise<ExportResult>
  exportObservationBatch(
    config: RuntimeConfig,
    batch: ObservationBatchDocument,
    options?: { projectId?: number },
  ): Promise<ExportResult>
}

function readExportMode(env: NodeJS.ProcessEnv = process.env): ExportMode {
  // Explicit EXPORT_MODE always wins (including explicit ``direct``).
  const exportRaw = (env.NETGREENER_EXPORT_MODE || '').trim().toLowerCase()
  if (exportRaw === 'collector' || exportRaw === 'thin' || exportRaw === 'direct') {
    return exportRaw
  }
  // Alias: FLUSH_MODE=thin when EXPORT_MODE unset — does not auto-detect platforms.
  if (flushModeRequestsThin(env)) return 'thin'
  return 'direct'
}

function emitTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number((env.NETGREENER_EMIT_TIMEOUT_MS || '100').trim())
  return Number.isFinite(raw) && raw > 0 ? raw : 100
}

/** Opt-in digest logging; mirrors Python ``shadow_compare_enabled``. */
export function shadowCompareEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.NETGREENER_MP2_SHADOW_COMPARE || '')
    .trim()
    .toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

/** Stable JSON matching Python ``json.dumps(..., sort_keys=True, separators=(",", ":"))``. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(',')}}`
}

export function canonicalPayloadDigest(payload: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex')
}

/** RunSession body shape used by Python ``run_session_payload_from_ipc`` digests. */
export function runSessionShadowPayload(
  payload: RunSessionCreatePayload,
): Record<string, unknown> {
  return {
    project_id: payload.project_id,
    runtime_window_id: payload.runtime_window_id,
    start_time: payload.start_time,
    end_time: payload.end_time,
    server_name: payload.server_name ?? null,
    energy_kwh: payload.energy_kwh ?? null,
    session_metadata: payload.session_metadata ?? null,
  }
}

function logShadowCompare(
  kind: string,
  idField: string,
  idValue: string,
  digest: string,
): void {
  console.info(
    `mp2_shadow_compare kind=${kind} ${idField}=${idValue} payload_sha256=${digest} emitter=netgreener_node`,
  )
}

function maybeShadowRunSession(payload: RunSessionCreatePayload): void {
  if (!shadowCompareEnabled()) return
  const body = runSessionShadowPayload(payload)
  logShadowCompare(
    'run_session_window',
    'runtime_window_id',
    String(body.runtime_window_id ?? ''),
    canonicalPayloadDigest(body),
  )
}

function maybeShadowObservationBatch(batch: ObservationBatchDocument): void {
  if (!shadowCompareEnabled()) return
  const batchId = typeof batch.batch_id === 'string' ? batch.batch_id : ''
  logShadowCompare(
    'observation_batch',
    'batch_id',
    batchId,
    canonicalPayloadDigest(batch),
  )
}

function resolveProjectId(
  config: RuntimeConfig,
  batch: ObservationBatchDocument,
  options?: { projectId?: number },
): number | null {
  if (options?.projectId != null && Number.isFinite(options.projectId)) {
    return Number(options.projectId)
  }
  const routing = batch.routing
  if (routing && typeof routing === 'object' && !Array.isArray(routing)) {
    const routed = (routing as { project_id?: unknown }).project_id
    const parsed = Number(routed)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  if (Number.isFinite(config.projectId) && config.projectId > 0) return config.projectId
  return null
}

function observationBatchNotWired(mode: ExportMode, grade: ExportResult['durabilityGrade']): ExportResult {
  return {
    ok: false,
    error:
      'export_observation_batch is stub-ready for collector spool only; direct/thin Observation upload is not wired (no cutover)',
    mode,
    durabilityGrade: grade,
  }
}

/** Existing Node v0 path: adapter posts RunSession directly. */
export class DirectRunSessionExporter implements ObservationExporter {
  readonly mode: ExportMode = 'direct'
  async exportRunSessionWindow(
    config: RuntimeConfig,
    payload: RunSessionCreatePayload,
    fetchImpl?: typeof fetch,
  ): Promise<ExportResult> {
    const result = await uploadRunSession(config, payload, fetchImpl)
    return { ...result, mode: 'direct', durabilityGrade: 'best_effort_in_process' }
  }

  async exportObservationBatch(
    _config: RuntimeConfig,
    _batch: ObservationBatchDocument,
  ): Promise<ExportResult> {
    return observationBatchNotWired('direct', 'best_effort_in_process')
  }
}

/**
 * Thin/emergency alias of direct upload with an explicit durability grade.
 * Same POST path today; grade is declared for evidence honesty.
 */
export class ThinRunSessionExporter implements ObservationExporter {
  readonly mode: ExportMode = 'thin'
  async exportRunSessionWindow(
    config: RuntimeConfig,
    payload: RunSessionCreatePayload,
    fetchImpl?: typeof fetch,
  ): Promise<ExportResult> {
    const result = await uploadRunSession(config, payload, fetchImpl)
    return { ...result, mode: 'thin', durabilityGrade: 'best_effort_bounded' }
  }

  async exportObservationBatch(
    _config: RuntimeConfig,
    _batch: ObservationBatchDocument,
  ): Promise<ExportResult> {
    return observationBatchNotWired('thin', 'best_effort_bounded')
  }
}

/**
 * Collector-backed export (MP2). Not the default.
 *
 * ``run_session_window`` and ``observation_batch`` IPC frames (Python
 * collector_protocol compatible). Durable spool ACK only — Observation upload
 * bridge is a later slice. Never reports silent success when the collector is
 * absent or rejects.
 */
export class CollectorRunSessionExporter implements ObservationExporter {
  readonly mode: ExportMode = 'collector'
  async exportRunSessionWindow(
    config: RuntimeConfig,
    payload: RunSessionCreatePayload,
    _fetchImpl?: typeof fetch,
  ): Promise<ExportResult> {
    const endpoint = (process.env.NETGREENER_COLLECTOR_ENDPOINT || '').trim()
    if (!endpoint) {
      return {
        ok: false,
        error: 'collector export mode requires NETGREENER_COLLECTOR_ENDPOINT',
        mode: 'collector',
        durabilityGrade: 'durable_sibling_spool',
      }
    }
    if (config.dryRun) {
      maybeShadowRunSession(payload)
      return {
        ok: true,
        status: 0,
        body: payload,
        dryRun: true,
        mode: 'collector',
        durabilityGrade: 'durable_sibling_spool',
      }
    }
    const eventId = newCollectorEventId()
    try {
      const ack = await sendCollectorEvent({
        endpoint,
        timeoutMs: emitTimeoutMs(),
        payload: {
          kind: 'run_session_window',
          event_id: eventId,
          project_id: payload.project_id,
          runtime_window_id: payload.runtime_window_id,
          start_time: payload.start_time,
          end_time: payload.end_time,
          server_name: payload.server_name ?? null,
          energy_kwh: payload.energy_kwh ?? null,
          session_metadata: payload.session_metadata,
          wall_time_utc: new Date().toISOString(),
          emitter: 'netgreener_node',
          export_mode: 'collector',
        },
      })
      if (!ack.ok) {
        return {
          ok: false,
          error: ack.error || 'collector rejected run_session_window',
          mode: 'collector',
          durabilityGrade: 'durable_sibling_spool',
          collectorEventId: ack.event_id || eventId,
        }
      }
      maybeShadowRunSession(payload)
      return {
        ok: true,
        status: 0,
        body: { event_id: ack.event_id || eventId },
        mode: 'collector',
        durabilityGrade: 'durable_sibling_spool',
        collectorEventId: ack.event_id || eventId,
      }
    } catch (err) {
      const message =
        err instanceof CollectorIpcError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      return {
        ok: false,
        error: `collector IPC failed: ${message}`,
        mode: 'collector',
        durabilityGrade: 'durable_sibling_spool',
        collectorEventId: eventId,
      }
    }
  }

  async exportObservationBatch(
    config: RuntimeConfig,
    batch: ObservationBatchDocument,
    options?: { projectId?: number },
  ): Promise<ExportResult> {
    const endpoint = (process.env.NETGREENER_COLLECTOR_ENDPOINT || '').trim()
    if (!endpoint) {
      return {
        ok: false,
        error: 'collector export mode requires NETGREENER_COLLECTOR_ENDPOINT',
        mode: 'collector',
        durabilityGrade: 'durable_sibling_spool',
      }
    }
    const projectId = resolveProjectId(config, batch, options)
    if (projectId == null) {
      return {
        ok: false,
        error: 'observation_batch requires project_id (options, batch.routing, or config)',
        mode: 'collector',
        durabilityGrade: 'durable_sibling_spool',
      }
    }
    if (config.dryRun) {
      maybeShadowObservationBatch(batch)
      return {
        ok: true,
        status: 0,
        body: batch,
        dryRun: true,
        mode: 'collector',
        durabilityGrade: 'durable_sibling_spool',
      }
    }
    const eventId = newCollectorEventId()
    try {
      const ack = await sendCollectorEvent({
        endpoint,
        timeoutMs: emitTimeoutMs(),
        payload: {
          kind: 'observation_batch',
          event_id: eventId,
          project_id: projectId,
          batch,
          wall_time_utc: new Date().toISOString(),
          emitter: 'netgreener_node',
          export_mode: 'collector',
        },
      })
      if (!ack.ok) {
        return {
          ok: false,
          error: ack.error || 'collector rejected observation_batch',
          mode: 'collector',
          durabilityGrade: 'durable_sibling_spool',
          collectorEventId: ack.event_id || eventId,
        }
      }
      maybeShadowObservationBatch(batch)
      return {
        ok: true,
        status: 0,
        body: { event_id: ack.event_id || eventId },
        mode: 'collector',
        durabilityGrade: 'durable_sibling_spool',
        collectorEventId: ack.event_id || eventId,
      }
    } catch (err) {
      const message =
        err instanceof CollectorIpcError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      return {
        ok: false,
        error: `collector IPC failed: ${message}`,
        mode: 'collector',
        durabilityGrade: 'durable_sibling_spool',
        collectorEventId: eventId,
      }
    }
  }
}

export function resolveObservationExporter(
  env: NodeJS.ProcessEnv = process.env,
): ObservationExporter {
  const mode = readExportMode(env)
  if (mode === 'collector') return new CollectorRunSessionExporter()
  if (mode === 'thin') return new ThinRunSessionExporter()
  return new DirectRunSessionExporter()
}

export function exportModeFromEnv(env: NodeJS.ProcessEnv = process.env): ExportMode {
  return readExportMode(env)
}
