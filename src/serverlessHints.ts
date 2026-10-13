/**
 * Serverless / thin-flush platform hints.
 *
 * Detection lives here; lifecycle cutover lives in ``lifecycle.ts``.
 * Platform signals alone used to be informational only. With lifecycle
 * ``auto``, serverless signals select **ephemeral** flush behavior and
 * prefer thin export when ``NETGREENER_EXPORT_MODE`` is unset.
 * Explicit ``NETGREENER_EXPORT_MODE`` / ``NETGREENER_RUNTIME=persistent`` win.
 * Long-running Node (Docker/VM/K8s) stays on default ``direct``.
 */

export type ServerlessPlatformSignal =
  | 'aws_lambda'
  | 'azure_functions'
  | 'google_cloud_functions'
  | 'vercel'
  | 'netlify'

export type ServerlessPlatformHint = {
  /** True when any known serverless host signal is present. */
  detected: boolean
  signals: ServerlessPlatformSignal[]
  /**
   * Suggested export mode when a sibling collector cannot run.
   * Applied by ``exportModeFromEnv`` only when lifecycle resolves ephemeral
   * and ``NETGREENER_EXPORT_MODE`` is unset (see ``lifecycle.ts``).
   */
  suggestedExportMode: 'thin' | null
  notes: string[]
}

function present(env: NodeJS.ProcessEnv, key: string): boolean {
  return Boolean(String(env[key] || '').trim())
}

/**
 * Read well-known platform env vars. Additive / informational only.
 */
export function detectServerlessPlatformSignals(
  env: NodeJS.ProcessEnv = process.env,
): ServerlessPlatformHint {
  const signals: ServerlessPlatformSignal[] = []
  const notes: string[] = []

  if (present(env, 'AWS_LAMBDA_FUNCTION_NAME')) {
    signals.push('aws_lambda')
  }
  if (present(env, 'FUNCTIONS_WORKER_RUNTIME') || present(env, 'AZURE_FUNCTIONS_ENVIRONMENT')) {
    signals.push('azure_functions')
  }
  if (present(env, 'FUNCTION_TARGET') || present(env, 'FUNCTION_SIGNATURE_TYPE')) {
    signals.push('google_cloud_functions')
  }
  if (env.VERCEL === '1' || present(env, 'VERCEL_ENV')) {
    signals.push('vercel')
  }
  if (present(env, 'NETLIFY') || present(env, 'NETLIFY_DEV')) {
    signals.push('netlify')
  }

  const unique = [...new Set(signals)]
  const detected = unique.length > 0
  if (detected) {
    notes.push(
      'serverless host signal present; lifecycle auto → ephemeral (invoke-end flush; no periodic timer)',
    )
    notes.push(
      'when NETGREENER_EXPORT_MODE unset, ephemeral prefers thin (best_effort_bounded); explicit EXPORT_MODE wins',
    )
    notes.push(
      'no durable sibling spool in thin/ephemeral mode; override with NETGREENER_RUNTIME=persistent if needed',
    )
  }

  return {
    detected,
    signals: unique,
    suggestedExportMode: detected ? 'thin' : null,
    notes,
  }
}

/** True when ``NETGREENER_FLUSH_MODE`` requests thin (alias of export mode thin). */
export function flushModeRequestsThin(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.NETGREENER_FLUSH_MODE || '')
    .trim()
    .toLowerCase()
  return raw === 'thin'
}
