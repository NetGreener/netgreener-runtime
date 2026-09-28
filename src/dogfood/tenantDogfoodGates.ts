/**
 * Gates for Node tenant dogfood (experimental v0).
 *
 * Keeps vendor stubs narrow and live uploads honest:
 * - Stub decision uses **parsed hostname** boundaries (not path/query substrings).
 * - Configured NetGreener API destination always takes precedence (never stubbed).
 * - Failed live uploads must fail the run.
 */

/** Registrable / DNS suffixes for vendor hosts dogfood may stub. */
export const VENDOR_FETCH_HOST_SUFFIXES = [
  'cognitive.microsoft.com',
  'cognitiveservices.azure.com',
  'openai.com',
  'openai.azure.com',
] as const

/** @deprecated Use VENDOR_FETCH_HOST_SUFFIXES (hostname suffixes, not URL substrings). */
export const VENDOR_FETCH_HOST_MARKERS = VENDOR_FETCH_HOST_SUFFIXES

export type DogfoodUploadResult =
  | { ok: true; status: number; body?: unknown; dryRun?: boolean }
  | { ok: false; status?: number; error: string; body?: unknown; dryRun?: boolean }

export type VendorStubOptions = {
  /** Configured NetGreener API base URL — its host is never stubbed. */
  apiBaseUrl?: string | null
}

export function resolveFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  if (input && typeof input === 'object' && 'url' in input) {
    return String((input as Request).url || '')
  }
  return String(input)
}

/**
 * Extract hostname from a fetch destination. Returns null when the input is
 * not an absolute http(s) URL (relative paths are not stubbed).
 */
export function parseFetchHostname(input: RequestInfo | URL | string): string | null {
  const raw = typeof input === 'string' || input instanceof URL ? String(input) : resolveFetchUrl(input)
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
      return new URL(trimmed).hostname.toLowerCase()
    }
    // Relative / opaque — do not treat path fragments as hosts.
    return null
  } catch {
    return null
  }
}

/** True when hostname is exactly a vendor suffix or a subdomain of one. */
export function hostnameMatchesVendor(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return false
  return VENDOR_FETCH_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  )
}

export function parseApiHostname(apiBaseUrl?: string | null): string | null {
  if (!apiBaseUrl || !String(apiBaseUrl).trim()) return null
  try {
    const raw = String(apiBaseUrl).trim()
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`
    return new URL(withScheme).hostname.toLowerCase() || null
  } catch {
    return null
  }
}

/** Explicit API destination never stubs, even on a lookalike/vendor-named host. */
export function isConfiguredApiDestination(
  hostname: string,
  apiBaseUrl?: string | null,
): boolean {
  const apiHost = parseApiHostname(apiBaseUrl)
  if (!apiHost) return false
  return hostname.toLowerCase() === apiHost
}

/**
 * True only for explicit vendor hostnames that dogfood may stub.
 * Path/query substrings and lookalike hosts do not match.
 * Configured API host always wins (real HTTP).
 */
export function shouldStubVendorFetch(
  input: RequestInfo | URL | string,
  opts?: VendorStubOptions,
): boolean {
  const hostname = parseFetchHostname(input)
  if (!hostname) return false
  if (isConfiguredApiDestination(hostname, opts?.apiBaseUrl)) return false
  return hostnameMatchesVendor(hostname)
}

export function stubVendorResponse(input: RequestInfo | URL | string): Response {
  const hostname = parseFetchHostname(input) || ''
  if (
    hostnameMatchesVendor(hostname) &&
    (hostname === 'cognitive.microsoft.com' ||
      hostname.endsWith('.cognitive.microsoft.com') ||
      hostname === 'cognitiveservices.azure.com' ||
      hostname.endsWith('.cognitiveservices.azure.com'))
  ) {
    return new Response(JSON.stringify({ status: 'succeeded' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (
    hostnameMatchesVendor(hostname) &&
    (hostname === 'openai.com' ||
      hostname.endsWith('.openai.com') ||
      hostname === 'openai.azure.com' ||
      hostname.endsWith('.openai.azure.com'))
  ) {
    return new Response(
      JSON.stringify({
        model: 'gpt-4o-mini',
        usage: { prompt_tokens: 120, completion_tokens: 40 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Wrap fetch so only known vendor **hostnames** are stubbed.
 * The configured API destination always uses real HTTP.
 */
export function createVendorAwareFetch(
  realFetch: typeof fetch,
  opts?: VendorStubOptions,
): typeof fetch {
  return (async (input, init) => {
    if (shouldStubVendorFetch(input, opts)) {
      return stubVendorResponse(input)
    }
    return realFetch(input, init)
  }) as typeof fetch
}

export function assertUploadForMode(
  label: string,
  result: DogfoodUploadResult | null | undefined,
  opts: { live: boolean },
): { ok: boolean; reason?: string } {
  const live = opts.live
  if (!result) {
    return { ok: false, reason: `${label}: missing flush/upload result` }
  }
  if (!live) {
    if (!result.ok) {
      return {
        ok: false,
        reason: `${label}: ${'error' in result ? result.error : 'upload failed'}`,
      }
    }
    return { ok: true }
  }
  if (!result.ok) {
    return {
      ok: false,
      reason: `${label}: live upload failed: ${result.error}${
        result.status != null ? ` (HTTP ${result.status})` : ''
      }`,
    }
  }
  if (result.dryRun) {
    return { ok: false, reason: `${label}: expected live upload, got dry-run result` }
  }
  const status = Number(result.status)
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    return { ok: false, reason: `${label}: unexpected live HTTP status ${result.status}` }
  }
  return { ok: true }
}

/**
 * In live mode, never treat a local onFlush payload as proof of persistence.
 * In dry-run, allow the dry-run body or the captured onFlush payload.
 */
export function sessionMetadataForDogfood(opts: {
  live: boolean
  flushResult: DogfoodUploadResult | null | undefined
  flushPayload?: { session_metadata?: unknown } | null
  label?: string
}): { sessionMetadata: Record<string, unknown> | null; uploadGate: { ok: boolean; reason?: string } } {
  const label = opts.label || 'flush'
  const uploadGate = assertUploadForMode(label, opts.flushResult, { live: opts.live })
  if (!uploadGate.ok) {
    return { sessionMetadata: null, uploadGate }
  }

  if (opts.live) {
    const fromPayload = opts.flushPayload?.session_metadata
    if (fromPayload && typeof fromPayload === 'object') {
      return {
        sessionMetadata: fromPayload as Record<string, unknown>,
        uploadGate,
      }
    }
    return {
      sessionMetadata: null,
      uploadGate: {
        ok: false,
        reason: `${label}: live upload ok but session_metadata missing on payload`,
      },
    }
  }

  const body = opts.flushResult && opts.flushResult.ok ? opts.flushResult.body : null
  if (body && typeof body === 'object' && body !== null && 'session_metadata' in body) {
    const meta = (body as { session_metadata?: unknown }).session_metadata
    if (meta && typeof meta === 'object') {
      return { sessionMetadata: meta as Record<string, unknown>, uploadGate }
    }
  }
  const captured = opts.flushPayload?.session_metadata
  if (captured && typeof captured === 'object') {
    return { sessionMetadata: captured as Record<string, unknown>, uploadGate }
  }
  return {
    sessionMetadata: null,
    uploadGate: { ok: false, reason: `${label}: dry-run session_metadata missing` },
  }
}

export function extractPersistedRunId(uploadBody: unknown): number | string | null {
  if (!uploadBody || typeof uploadBody !== 'object') return null
  const row = uploadBody as Record<string, unknown>
  if (typeof row.run_id === 'number' || typeof row.run_id === 'string') return row.run_id
  if (typeof row.id === 'number' || typeof row.id === 'string') return row.id
  return null
}
