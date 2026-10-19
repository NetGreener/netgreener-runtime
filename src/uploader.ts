import type { RuntimeConfig } from './config.js'
import type { RuntimeSessionMetadata } from './types.js'
import { validateRuntimeSessionMetadata } from './contract/validate.js'

export type RunSessionCreatePayload = {
  project_id: number
  start_time: string
  end_time: string
  server_name?: string | null
  energy_kwh?: number
  runtime_window_id: string
  session_metadata: RuntimeSessionMetadata
}

export type UploadResult =
  | { ok: true; status: number; body: unknown; dryRun?: boolean }
  | { ok: false; status?: number; error: string; body?: unknown }

export async function uploadRunSession(
  config: RuntimeConfig,
  payload: RunSessionCreatePayload,
  fetchImpl: typeof fetch = fetch,
): Promise<UploadResult> {
  const validation = validateRuntimeSessionMetadata(payload.session_metadata)
  if (!validation.ok) {
    return {
      ok: false,
      error: `session_metadata contract failed: ${JSON.stringify(validation.issues)}`,
    }
  }

  if (config.dryRun) {
    return { ok: true, status: 0, body: payload, dryRun: true }
  }

  const url = `${config.apiUrl}/api/v1/runsessions/`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  if (config.organizationId != null) {
    headers['X-Organization-ID'] = String(config.organizationId)
  }

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })
    const text = await res.text()
    let body: unknown = text
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      /* keep text */
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `upload failed HTTP ${res.status}`,
        body,
      }
    }
    return { ok: true, status: res.status, body }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
