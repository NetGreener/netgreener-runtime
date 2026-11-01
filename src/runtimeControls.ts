/** Company policy cache shared by JavaScript/TypeScript hooks and exporters. */
import { createHash } from 'node:crypto'
import type { RuntimeConfig } from './config.js'
import { jwtPayloadUnverified } from './tenantContext.js'

type State = {
  enabled: boolean
  orgId: number | null
  timer?: NodeJS.Timeout
  refreshing: boolean
  listeners: Set<(enabled: boolean) => void>
  windowSeconds: number | null
  intervalListeners: Set<() => void>
}
const states = new Map<string, State>()
let activeKey: string | undefined

function accountKey(config: RuntimeConfig): string {
  return createHash('sha256').update(JSON.stringify([config.apiUrl, config.organizationId, config.token])).digest('hex')
}

function stateFor(config: RuntimeConfig): State {
  const key = accountKey(config)
  let state = states.get(key)
  if (!state) {
    const claim = jwtPayloadUnverified(`Bearer ${config.token}`)?.org_id
    const id = config.organizationId ?? Number(claim)
    state = { enabled: true, orgId: Number.isSafeInteger(id) && Number(id) > 0 ? Number(id) : null, refreshing: false, listeners: new Set(), windowSeconds: null, intervalListeners: new Set() }
    states.set(key, state)
  }
  return state
}

export function meteringAllowed(config?: RuntimeConfig): boolean {
  return (config ? stateFor(config) : activeKey ? states.get(activeKey) : undefined)?.enabled ?? true
}

export function runtimeWindowIntervalMs(config: RuntimeConfig): number {
  const seconds = stateFor(config).windowSeconds
  return seconds == null ? config.flushIntervalMs : seconds * 1000
}

export function applyRuntimeControls(config: RuntimeConfig, enabled: boolean, orgId?: number): void {
  const state = stateFor(config)
  if (orgId != null && Number.isSafeInteger(orgId) && orgId > 0) state.orgId = orgId
  activeKey = accountKey(config)
  if (state.enabled === enabled) return
  state.enabled = enabled
  for (const listener of state.listeners) listener(enabled)
}

export async function refreshRuntimeControls(config: RuntimeConfig, fetchImpl: typeof fetch): Promise<void> {
  const state = stateFor(config)
  if (config.dryRun || state.orgId == null || state.refreshing) return
  state.refreshing = true
  try {
    const response = await fetchImpl(`${config.apiUrl}/api/v1/organizations/${state.orgId}/runtime-controls`, {
      headers: { Authorization: `Bearer ${config.token}`, 'X-Organization-ID': String(state.orgId) },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return
    const data = await response.json() as { org_id?: number; metering_enabled?: boolean; runtime_window_seconds?: number | null; effective_runtime_window_seconds?: number }
    if (data.org_id === state.orgId && typeof data.metering_enabled === 'boolean') {
      applyRuntimeControls(config, data.metering_enabled)
      const seconds = data.effective_runtime_window_seconds ?? data.runtime_window_seconds
      if (seconds === null || (typeof seconds === 'number' && Number.isInteger(seconds) && seconds >= 30 && seconds <= 86400)) {
        if (state.windowSeconds !== seconds) {
          state.windowSeconds = seconds
          for (const listener of state.intervalListeners) listener()
        }
      }
    }
  } catch {
    // Retain the last known policy, including a known pause, during outages.
  } finally {
    state.refreshing = false
  }
}

export function startRuntimeControls(config: RuntimeConfig, fetchImpl: typeof fetch, onChange?: (enabled: boolean) => void, onIntervalChange?: (milliseconds: number) => void): () => void {
  if (config.dryRun || !config.enabled) return () => {}
  activeKey = accountKey(config)
  const state = stateFor(config)
  if (onChange) state.listeners.add(onChange)
  const intervalListener = onIntervalChange ? () => onIntervalChange(runtimeWindowIntervalMs(config)) : undefined
  if (intervalListener) state.intervalListeners.add(intervalListener)
  if (!state.timer) {
    state.timer = setInterval(() => { void refreshRuntimeControls(config, fetchImpl) }, 30_000)
    state.timer.unref?.()
  }
  return () => {
    if (onChange) state.listeners.delete(onChange)
    if (intervalListener) state.intervalListeners.delete(intervalListener)
  }
}
