/** Best-effort run_id extraction from RunSession upload JSON body. */
export function extractRunId(body) {
  if (body == null || typeof body !== 'object') return null
  const o = body
  for (const key of ['id', 'run_id', 'runId', 'run_session_id']) {
    const v = o[key]
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}
