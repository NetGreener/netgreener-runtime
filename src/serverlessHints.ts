/**
 * Serverless / thin-flush platform hints (N3 mode docs).
 *
 * Detection only — does **not** flip ``NETGREENER_EXPORT_MODE`` by itself.
 * Long-running Node stays on default ``direct`` (or opt-in ``collector``).
 * Callers set ``NETGREENER_EXPORT_MODE=thin`` or ``NETGREENER_FLUSH_MODE=thin``
 * explicitly when a durable sibling collector is impossible.
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
   * Never applied automatically by this helper.
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
      'serverless host signal present; set NETGREENER_EXPORT_MODE=thin or NETGREENER_FLUSH_MODE=thin explicitly — auto-cutover is not applied',
    )
    notes.push(
      'flush best-effort at invoke end (runtime.flush / shutdown); no durable sibling spool in thin mode',
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
