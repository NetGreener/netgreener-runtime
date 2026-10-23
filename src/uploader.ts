import { applyRuntimeControls, meteringAllowed, startRuntimeControls } from './runtimeControls.js'
import { createHash } from 'node:crypto'
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

// A 402 pauses all windows for this account, including new exporter instances.
// Collector delivery uses the Python durable queue and its persisted billing pause.
const billingPauses = new Map<string, { checkAfter: number; required: number; orgId: number | null; body: unknown }>()

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

  startRuntimeControls(config, fetchImpl)
  if (!meteringAllowed(config)) {
    return { ok: false, status: 423, error: 'Metering is paused by your organization administrator' }
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

  const account = createHash('sha256').update(JSON.stringify([config.apiUrl, config.organizationId, config.token])).digest('hex')
  const pause = billingPauses.get(account)
  const pausedResult = (): UploadResult => ({
    ok: false, status: 402, body: pause?.body,
    error: 'Runtime uploads paused: insufficient organization credits. Add credits in the dashboard at /billing/credits.',
  })
  try {
    if (pause) {
      if (Date.now() < pause.checkAfter) return pausedResult()
      pause.checkAfter = Date.now() + 300_000
      if (pause.orgId != null) {
        const balance = await fetchImpl(`${config.apiUrl}/api/v1/billing/organizations/${pause.orgId}/credits`, { headers })
        if (!balance.ok) return pausedResult()
        const data = await balance.json() as { balance_credits?: number }
        if (typeof data.balance_credits !== 'number' || data.balance_credits < pause.required) return pausedResult()
      }
      billingPauses.delete(account)
    }
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
      if (res.status === 423) {
        const envelope = body as { detail?: { org_id?: number }; error?: { org_id?: number } } | null
        applyRuntimeControls(config, false, (envelope?.detail ?? envelope?.error)?.org_id)
      }
      if (res.status === 402) {
        const envelope = body as { detail?: { required_credits?: number; org_id?: number }; error?: { required_credits?: number; org_id?: number } } | null
        const detail = envelope?.detail ?? envelope?.error
        const orgId = detail?.org_id ?? config.organizationId
        billingPauses.set(account, {
          checkAfter: Date.now() + 300_000,
          required: Math.max(1, Number(detail?.required_credits) || 1), orgId, body,
        })
      }
      return {
        ok: false,
        status: res.status,
        error: res.status === 402
          ? 'Runtime uploads paused: insufficient organization credits. Add credits in the dashboard at /billing/credits.'
          : `upload failed HTTP ${res.status}`,
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
