/**
 * Runtime lifecycle resolution (persistent vs ephemeral).
 *
 * Platform (vercel / lambda / …) and lifecycle are separate concepts.
 * Behavior depends primarily on lifecycle. Detection is best-effort;
 * ``NETGREENER_RUNTIME`` / ``init({ runtime })`` always wins.
 *
 * Does not rewrite the persistent collector pipeline. Ephemeral only
 * changes flush timing and prefers thin export when EXPORT_MODE is unset.
 */

import {
  detectServerlessPlatformSignals,
  type ServerlessPlatformSignal,
} from './serverlessHints.js'

export type RuntimeModePreference = 'auto' | 'persistent' | 'ephemeral'

export type RuntimeLifecycle = 'persistent' | 'ephemeral'

export type RuntimePlatform =
  | ServerlessPlatformSignal
  | 'docker'
  | 'kubernetes'
  | 'generic'

export type RuntimeCapabilities = {
  /** Host CPU sampling (cgroup / host meters). Not claimed on serverless. */
  cpu_sampling: boolean
  gpu_sampling: boolean
  /** process.cpuUsage / RSS deltas on instrumented hooks. */
  process_cpu_time: boolean
  periodic_flush: boolean
  local_durable_spool: boolean
}

export type ResolvedRuntimeLifecycle = {
  /** Requested preference (auto / override). */
  mode: RuntimeModePreference
  lifecycle: RuntimeLifecycle
  platform: RuntimePlatform
  capabilities: RuntimeCapabilities
  signals: ServerlessPlatformSignal[]
  notes: string[]
}

export type ResolveLifecycleOptions = {
  mode?: RuntimeModePreference
  env?: NodeJS.ProcessEnv
}

function readModePreference(
  env: NodeJS.ProcessEnv,
  override?: RuntimeModePreference,
): RuntimeModePreference {
  if (override === 'auto' || override === 'persistent' || override === 'ephemeral') {
    return override
  }
  const raw = String(env.NETGREENER_RUNTIME || '')
    .trim()
    .toLowerCase()
  if (raw === 'persistent' || raw === 'ephemeral' || raw === 'auto') {
    return raw
  }
  return 'auto'
}

function detectContainerPlatform(env: NodeJS.ProcessEnv): RuntimePlatform | null {
  if (present(env, 'KUBERNETES_SERVICE_HOST')) return 'kubernetes'
  // Generic container signal — never means serverless by itself.
  if (env.DOTNET_RUNNING_IN_CONTAINER === 'true' || present(env, 'container')) {
    return 'docker'
  }
  if (present(env, 'DOCKER') || env.container === 'docker') return 'docker'
  return null
}

function present(env: NodeJS.ProcessEnv, key: string): boolean {
  return Boolean(String(env[key] || '').trim())
}

function capabilitiesFor(lifecycle: RuntimeLifecycle): RuntimeCapabilities {
  if (lifecycle === 'ephemeral') {
    return {
      cpu_sampling: false,
      gpu_sampling: false,
      process_cpu_time: true,
      periodic_flush: false,
      local_durable_spool: false,
    }
  }
  return {
    cpu_sampling: false, // host/cgroup still not claimed by default
    gpu_sampling: false,
    process_cpu_time: true,
    periodic_flush: true,
    local_durable_spool: true, // available via opt-in collector; not forced
  }
}

/**
 * Resolve lifecycle + platform metadata.
 *
 * Default ``auto``: serverless host signals → ephemeral; otherwise persistent.
 * Docker / Kubernetes signals alone stay **persistent**.
 */
export function resolveLifecycle(
  opts: ResolveLifecycleOptions = {},
): ResolvedRuntimeLifecycle {
  const env = opts.env ?? process.env
  const mode = readModePreference(env, opts.mode)
  const hint = detectServerlessPlatformSignals(env)
  const containerPlatform = detectContainerPlatform(env)
  const notes: string[] = []

  let lifecycle: RuntimeLifecycle
  if (mode === 'ephemeral') {
    lifecycle = 'ephemeral'
    notes.push('runtime mode override: ephemeral')
  } else if (mode === 'persistent') {
    lifecycle = 'persistent'
    notes.push('runtime mode override: persistent')
  } else if (hint.detected) {
    lifecycle = 'ephemeral'
    notes.push(
      'auto: serverless host signal → ephemeral lifecycle (invoke-end flush; no periodic timer)',
    )
  } else {
    lifecycle = 'persistent'
    notes.push('auto: no serverless signal → persistent lifecycle')
  }

  let platform: RuntimePlatform = 'generic'
  if (hint.signals.length > 0) {
    platform = hint.signals[0]!
  } else if (containerPlatform) {
    platform = containerPlatform
    notes.push(`container/platform signal: ${containerPlatform} (lifecycle remains ${lifecycle})`)
  }

  if (lifecycle === 'ephemeral') {
    notes.push(
      'ephemeral: prefer NETGREENER_EXPORT_MODE=thin when unset; flush at invoke/request idle boundary',
    )
  }

  return {
    mode,
    lifecycle,
    platform,
    capabilities: capabilitiesFor(lifecycle),
    signals: hint.signals,
    notes,
  }
}

/** True when resolved lifecycle is ephemeral. */
export function isEphemeralLifecycle(opts: ResolveLifecycleOptions = {}): boolean {
  return resolveLifecycle(opts).lifecycle === 'ephemeral'
}
