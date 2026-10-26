/**
 * Fixture: retry loop with fetch — should yield retry_amplification candidate.
 */
export async function submitWithRetries(url: string): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url)
    if (res.ok) return res
  }
  throw new Error('exhausted retries')
}
