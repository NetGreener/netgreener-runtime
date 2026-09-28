/**
 * Outbound external-API call metering (N2).
 *
 * Additive ``external_api_v0`` for Node flushes — usage metadata only
 * (no prompts/bodies). Soft-wraps:
 * - global ``fetch`` (primary)
 * - ``axios`` Axios.prototype.request when axios is resolvable (optional peer)
 * - ``undici.request`` / Dispatcher.request when undici is resolvable
 *
 * Uploads restore unwrapped ``fetch``. Axios→fetch adapter paths skip the
 * fetch meter via ALS so the same call is not double-counted.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'

import { getTenantContext } from './tenantContext.js'
import { attributionServiceUnit } from './requestContext.js'
import type {
  ExternalApiModelBucket,
  ExternalApiProvider,
  ExternalApiTenantBucket,
  ExternalApiV0,
} from './types.js'

const requireFromHere = createRequire(import.meta.url)

/**
 * Nested transport ownership — only the outermost wrap records.
 * axios → (optional fetch adapter) → undici must count once.
 */
const outboundMeterOwnerAls = new AsyncLocalStorage<'fetch' | 'axios' | 'undici'>()

const MAX_PROVIDERS = 200
const MAX_MODELS_PER_PROVIDER = 16
const MAX_USAGE_PARSE_BYTES = 256 * 1024

const AZURE_DEPLOYMENT_RE = /\/openai\/deployments\/([^/?#]+)/i

/** Ordered host-substring → provider_key (first match wins). Mirrors Python. */
const HOST_PROVIDER_PATTERNS: Array<[string, string]> = [
  ['openai.azure.com', 'openai'],
  ['openai.com', 'openai'],
  ['anthropic.com', 'anthropic'],
  ['stripe.com', 'stripe'],
  ['twilio.com', 'twilio'],
  ['sendgrid.com', 'sendgrid'],
  ['sendgrid.net', 'sendgrid'],
  ['cognitiveservices.azure.com', 'azure_document_intelligence'],
  ['cognitive.microsoft.com', 'azure_document_intelligence'],
  ['textract.', 'aws_textract'],
  ['documentai.googleapis.com', 'google_document_ai'],
  ['vision.googleapis.com', 'google_document_ai'],
  ['generativelanguage.googleapis.com', 'google'],
  ['googleapis.com', 'google'],
  ['cohere.ai', 'cohere'],
  ['cohere.com', 'cohere'],
  ['huggingface.co', 'huggingface'],
  ['amazonaws.com', 'boto3'],
]

type ModelAgg = {
  model: string
  calls: number
  errors: number
  input_tokens: number
  output_tokens: number
  calls_with_usage: number
}

type ProviderAgg = {
  provider_key: string
  calls: number
  errors: number
  duration_ms_total: number
  input_tokens: number
  output_tokens: number
  calls_with_usage: number
  hosts: Set<string>
  models: Set<string>
  by_model: Map<string, ModelAgg>
}

function registeredDomain(host: string): string {
  const parts = host.split('.').filter(Boolean)
  if (parts.length >= 2) return parts.slice(-2).join('.')
  return host
}

export function providerForHost(host: string): string {
  const h = (host || '').toLowerCase().trim()
  for (const [needle, provider] of HOST_PROVIDER_PATTERNS) {
    if (h.includes(needle)) return provider
  }
  return registeredDomain(h) || 'unknown'
}

export function hostFromUrl(url: unknown): string {
  try {
    return new URL(String(url)).hostname || ''
  } catch {
    return ''
  }
}

export function modelFromUrl(url: unknown): string | null {
  try {
    const match = AZURE_DEPLOYMENT_RE.exec(String(url || ''))
    const name = match?.[1]?.trim().slice(0, 128)
    return name || null
  } catch {
    return null
  }
}

function isPrivateOrLocalHost(host: string): boolean {
  if (!host) return true
  const h = host.toLowerCase()
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')) {
    return true
  }
  if (
    h.startsWith('10.') ||
    h.startsWith('192.168.') ||
    h.startsWith('169.254.') ||
    h.startsWith('0.')
  ) {
    return true
  }
  // 172.16.0.0 – 172.31.255.255 (string prefix best-effort)
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true
  return false
}

function asTokenInt(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

function pairFromKeys(
  usage: Record<string, unknown>,
  inKeys: string[],
  outKeys: string[],
): [number, number] | null {
  if (![...inKeys, ...outKeys].some((k) => k in usage)) return null
  let inTok = 0
  for (const key of inKeys) {
    if (key in usage) {
      inTok = asTokenInt(usage[key])
      break
    }
  }
  let outTok = 0
  for (const key of outKeys) {
    if (key in usage) {
      outTok = asTokenInt(usage[key])
      break
    }
  }
  return [inTok, outTok]
}

export function tokensFromUsage(usage: Record<string, unknown>): [number, number] {
  const openaiChat = pairFromKeys(usage, ['prompt_tokens'], ['completion_tokens'])
  const openaiResp = pairFromKeys(usage, ['input_tokens'], ['output_tokens'])
  const gemini = pairFromKeys(
    usage,
    ['promptTokenCount', 'prompt_token_count'],
    [
      'candidatesTokenCount',
      'candidates_token_count',
      'outputTokenCount',
      'output_token_count',
    ],
  )
  const scored = [openaiChat, openaiResp, gemini].filter(
    (p): p is [number, number] => Boolean(p && (p[0] || p[1])),
  )
  let inTok = 0
  let outTok = 0
  if (scored.length) {
    ;[inTok, outTok] = scored.reduce((a, b) => (a[0] + a[1] >= b[0] + b[1] ? a : b))
  } else {
    for (const nestedKey of ['billed_units', 'tokens']) {
      const nested = usage[nestedKey]
      if (nested && typeof nested === 'object') {
        const [ni, no] = tokensFromUsage(nested as Record<string, unknown>)
        if (ni || no) {
          inTok = ni
          outTok = no
          break
        }
      }
    }
  }
  let total = 0
  for (const totalKey of ['total_tokens', 'totalTokenCount', 'total_token_count']) {
    if (totalKey in usage) {
      total = asTokenInt(usage[totalKey])
      break
    }
  }
  if (total && total > inTok + outTok) {
    if (inTok || outTok) outTok = Math.max(outTok, total - inTok)
    else inTok = total
  }
  if (inTok || outTok) return [inTok, outTok]
  return openaiChat || openaiResp || gemini || [0, 0]
}

function usageFromPayload(data: Record<string, unknown>): {
  input: number
  output: number
  model: string | null
} {
  let model: string | null = null
  const modelRaw = data.model ?? data.modelVersion ?? data.model_version
  if (typeof modelRaw === 'string' && modelRaw.trim()) {
    model = modelRaw.trim().slice(0, 128)
  }
  let bestIn = 0
  let bestOut = 0
  for (const usageKey of ['usage', 'usageMetadata', 'usage_metadata'] as const) {
    const usage = data[usageKey]
    if (usage && typeof usage === 'object') {
      const [input, output] = tokensFromUsage(usage as Record<string, unknown>)
      if (input + output > bestIn + bestOut) {
        bestIn = input
        bestOut = output
      }
    }
  }
  if (bestIn || bestOut) return { input: bestIn, output: bestOut, model }
  for (const nestedKey of ['response', 'message'] as const) {
    const nested = data[nestedKey]
    if (nested && typeof nested === 'object') {
      const extracted = usageFromPayload(nested as Record<string, unknown>)
      if (extracted.input || extracted.output || extracted.model) {
        return {
          input: extracted.input,
          output: extracted.output,
          model: extracted.model || model,
        }
      }
    }
  }
  return { input: 0, output: 0, model }
}

const SSE_TOKEN_KEY_RE =
  /(?<!\\)"(prompt_tokens|input_tokens|completion_tokens|output_tokens|promptTokenCount|candidatesTokenCount|outputTokenCount|prompt_token_count|candidates_token_count|output_token_count|total_tokens|totalTokenCount|total_token_count)"\s*:\s*(\d+)/g

const SSE_IN_KEYS = new Set([
  'prompt_tokens',
  'input_tokens',
  'promptTokenCount',
  'prompt_token_count',
])
const SSE_OUT_KEYS = new Set([
  'completion_tokens',
  'output_tokens',
  'candidatesTokenCount',
  'outputTokenCount',
  'candidates_token_count',
  'output_token_count',
])

export function usageFromSseText(text: string): {
  input: number
  output: number
  model: string | null
} {
  if (!text) return { input: 0, output: 0, model: null }
  let bestIn = 0
  let bestOut = 0
  let model: string | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('data:')) line = line.slice(5).trim()
    if (!line || line === '[DONE]' || (line[0] !== '{' && line[0] !== '[')) continue
    try {
      const data = JSON.parse(line) as unknown
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue
      const extracted = usageFromPayload(data as Record<string, unknown>)
      if (extracted.model) model = extracted.model
      if (extracted.input) bestIn = extracted.input
      if (extracted.output) bestOut = extracted.output
    } catch {
      continue
    }
  }
  if (!bestIn && !bestOut) {
    let recoveredIn = 0
    let recoveredOut = 0
    let recoveredTotal = 0
    SSE_TOKEN_KEY_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = SSE_TOKEN_KEY_RE.exec(text)) !== null) {
      const key = match[1]
      const value = Number(match[2])
      if (!Number.isFinite(value) || value < 0) continue
      if (SSE_IN_KEYS.has(key)) recoveredIn = value
      else if (SSE_OUT_KEYS.has(key)) recoveredOut = value
      else recoveredTotal = value
    }
    if (recoveredTotal && recoveredTotal > recoveredIn + recoveredOut) {
      if (recoveredIn || recoveredOut) {
        recoveredOut = Math.max(recoveredOut, recoveredTotal - recoveredIn)
      } else {
        recoveredIn = recoveredTotal
      }
    }
    bestIn = recoveredIn
    bestOut = recoveredOut
  }
  if (model == null) {
    const modelMatches = [
      ...text.matchAll(/(?<!\\)"(?:model|modelVersion)"\s*:\s*"([^"\\]{1,128})"/g),
    ]
    if (modelMatches.length) {
      const last = modelMatches[modelMatches.length - 1]?.[1]?.trim()
      if (last) model = last
    }
  }
  return { input: bestIn, output: bestOut, model }
}

function isStreamingContentType(response: Response): boolean {
  const ctype = (response.headers.get('content-type') || '').toLowerCase()
  return (
    ctype.includes('text/event-stream') ||
    ctype.includes('ndjson') ||
    ctype.includes('application/stream+json')
  )
}

export async function extractUsageFromResponse(
  response: Response,
  url: string,
): Promise<{ input: number; output: number; model: string | null }> {
  let model = modelFromUrl(url)
  try {
    const ctype = (response.headers.get('content-type') || '').toLowerCase()
    const clone = response.clone()
    const buf = Buffer.from(await clone.arrayBuffer())
    if (buf.length === 0) return { input: 0, output: 0, model }
    const bounded =
      buf.length > MAX_USAGE_PARSE_BYTES ? buf.subarray(buf.length - MAX_USAGE_PARSE_BYTES) : buf
    const text = bounded.toString('utf8')
    const streaming = isStreamingContentType(response) || text.startsWith('data:')
    if (streaming || buf.length > MAX_USAGE_PARSE_BYTES) {
      const extracted = usageFromSseText(text)
      if (extracted.model) model = extracted.model
      return { input: extracted.input, output: extracted.output, model }
    }
    const trimmed = text.trimStart()
    if (ctype.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(text) as unknown
        if (parsed && typeof parsed === 'object') {
          const extracted = usageFromPayload(parsed as Record<string, unknown>)
          if (extracted.model) model = extracted.model
          if (extracted.input || extracted.output) {
            return { input: extracted.input, output: extracted.output, model }
          }
        }
      } catch {
        /* fall through to SSE/field scan */
      }
    }
    const extracted = usageFromSseText(text)
    if (extracted.model) model = extracted.model
    return { input: extracted.input, output: extracted.output, model }
  } catch {
    return { input: 0, output: 0, model }
  }
}

/**
 * Usage extraction for axios (and similar) bodies already buffered by the client.
 * Does not read streams; returns zeros for stream/Buffer/unknown shapes.
 */
export function usageFromClientBody(
  data: unknown,
  url: string,
  contentType?: string | null,
): { input: number; output: number; model: string | null } {
  const model = modelFromUrl(url)
  if (data == null) return { input: 0, output: 0, model }
  if (typeof data === 'object') {
    if (Buffer.isBuffer(data)) {
      const text = data.toString(
        'utf8',
        Math.max(0, data.length - MAX_USAGE_PARSE_BYTES),
        data.length,
      )
      const extracted = usageFromSseText(text)
      return {
        input: extracted.input,
        output: extracted.output,
        model: extracted.model || model,
      }
    }
    // Readable / stream — do not consume (privacy + caller ownership).
    if (typeof (data as { pipe?: unknown }).pipe === 'function') {
      return { input: 0, output: 0, model }
    }
    if (!Array.isArray(data)) {
      const extracted = usageFromPayload(data as Record<string, unknown>)
      return {
        input: extracted.input,
        output: extracted.output,
        model: extracted.model || model,
      }
    }
  }
  if (typeof data === 'string') {
    const ctype = (contentType || '').toLowerCase()
    const trimmed = data.trimStart()
    const streaming =
      ctype.includes('text/event-stream') ||
      ctype.includes('ndjson') ||
      ctype.includes('application/stream+json') ||
      trimmed.startsWith('data:')
    if (streaming || data.length > MAX_USAGE_PARSE_BYTES) {
      const slice =
        data.length > MAX_USAGE_PARSE_BYTES
          ? data.slice(data.length - MAX_USAGE_PARSE_BYTES)
          : data
      const extracted = usageFromSseText(slice)
      return {
        input: extracted.input,
        output: extracted.output,
        model: extracted.model || model,
      }
    }
    if (ctype.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(data) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const extracted = usageFromPayload(parsed as Record<string, unknown>)
          return {
            input: extracted.input,
            output: extracted.output,
            model: extracted.model || model,
          }
        }
      } catch {
        /* fall through */
      }
    }
    const extracted = usageFromSseText(data)
    return {
      input: extracted.input,
      output: extracted.output,
      model: extracted.model || model,
    }
  }
  return { input: 0, output: 0, model }
}

function emptyProvider(key: string): ProviderAgg {
  return {
    provider_key: key,
    calls: 0,
    errors: 0,
    duration_ms_total: 0,
    input_tokens: 0,
    output_tokens: 0,
    calls_with_usage: 0,
    hosts: new Set(),
    models: new Set(),
    by_model: new Map(),
  }
}

export class ExternalApiAggregator {
  private providers = new Map<string, ProviderAgg>()
  private byServiceUnit = new Map<string, Map<string, ProviderAgg>>()
  private byTenant = new Map<string, Map<string, ProviderAgg>>()
  private excludedHosts = new Set<string>()

  setExcludedHosts(hosts: Iterable<string>): void {
    this.excludedHosts = new Set(
      [...hosts].map((h) => h.toLowerCase().trim()).filter(Boolean),
    )
  }

  private isExcluded(host: string): boolean {
    if (isPrivateOrLocalHost(host)) return true
    const h = host.toLowerCase()
    for (const ex of this.excludedHosts) {
      if (h === ex || h === registeredDomain(ex) || h.endsWith(`.${registeredDomain(ex)}`)) {
        return true
      }
    }
    return false
  }

  hasData(): boolean {
    for (const p of this.providers.values()) {
      if (p.calls > 0) return true
    }
    return false
  }

  private recordProvider(
    bucket: Map<string, ProviderAgg>,
    opts: {
      provider: string
      host: string
      durationMs: number
      error: boolean
      inputTokens: number
      outputTokens: number
      model?: string | null
    },
  ): void {
    let provider = opts.provider
    let p = bucket.get(provider)
    if (!p) {
      if (bucket.size >= MAX_PROVIDERS) {
        provider = '__other__'
        p = bucket.get(provider)
        if (!p) {
          p = emptyProvider(provider)
          bucket.set(provider, p)
        }
      } else {
        p = emptyProvider(provider)
        bucket.set(provider, p)
      }
    }
    p.calls += 1
    if (opts.error) p.errors += 1
    p.duration_ms_total += Math.max(0, opts.durationMs)
    const hasUsage = opts.inputTokens > 0 || opts.outputTokens > 0
    if (hasUsage) p.calls_with_usage += 1
    if (opts.inputTokens > 0) p.input_tokens += opts.inputTokens
    if (opts.outputTokens > 0) p.output_tokens += opts.outputTokens
    if (opts.host && p.hosts.size < 8) p.hosts.add(opts.host.toLowerCase())
    const model = (opts.model || '').trim().slice(0, 128)
    if (!model) return
    if (p.models.size < MAX_MODELS_PER_PROVIDER) p.models.add(model)
    let mKey = model
    let mAgg = p.by_model.get(mKey)
    if (!mAgg) {
      if (p.by_model.size >= MAX_MODELS_PER_PROVIDER) {
        mKey = '__other__'
        mAgg = p.by_model.get(mKey)
        if (!mAgg) {
          mAgg = { model: mKey, calls: 0, errors: 0, input_tokens: 0, output_tokens: 0, calls_with_usage: 0 }
          p.by_model.set(mKey, mAgg)
        }
      } else {
        mAgg = { model: mKey, calls: 0, errors: 0, input_tokens: 0, output_tokens: 0, calls_with_usage: 0 }
        p.by_model.set(mKey, mAgg)
      }
    }
    mAgg.calls += 1
    if (opts.error) mAgg.errors += 1
    if (hasUsage) mAgg.calls_with_usage += 1
    if (opts.inputTokens > 0) mAgg.input_tokens += opts.inputTokens
    if (opts.outputTokens > 0) mAgg.output_tokens += opts.outputTokens
  }

  record(opts: {
    host: string
    durationMs?: number
    error?: boolean
    inputTokens?: number
    outputTokens?: number
    serviceUnit?: string | null
    model?: string | null
    tenantId?: string | null
  }): void {
    if (this.isExcluded(opts.host)) return
    const provider = providerForHost(opts.host)
    const durationMs = opts.durationMs ?? 0
    const error = Boolean(opts.error)
    const inputTokens = opts.inputTokens ?? 0
    const outputTokens = opts.outputTokens ?? 0
    const model = opts.model ?? null
    // When callers pass serviceUnit / tenantId (including null), keep that
    // call-entry snapshot — do not fall through to live ALS after await.
    const serviceUnit = Object.prototype.hasOwnProperty.call(opts, 'serviceUnit')
      ? (opts.serviceUnit || '').trim() || '__unknown__'
      : attributionServiceUnit() || '__unknown__'
    const tenantId = Object.prototype.hasOwnProperty.call(opts, 'tenantId')
      ? (opts.tenantId || '').trim() || null
      : getTenantContext()?.tenantId || null

    this.recordProvider(this.providers, {
      provider,
      host: opts.host,
      durationMs,
      error,
      inputTokens,
      outputTokens,
      model,
    })

    let unitBucket = this.byServiceUnit.get(serviceUnit)
    if (!unitBucket) {
      unitBucket = new Map()
      this.byServiceUnit.set(serviceUnit, unitBucket)
    }
    this.recordProvider(unitBucket, {
      provider,
      host: opts.host,
      durationMs,
      error,
      inputTokens,
      outputTokens,
      model,
    })

    if (tenantId) {
      let tenantBucket = this.byTenant.get(tenantId)
      if (!tenantBucket) {
        tenantBucket = new Map()
        this.byTenant.set(tenantId, tenantBucket)
      }
      this.recordProvider(tenantBucket, {
        provider,
        host: opts.host,
        durationMs,
        error,
        inputTokens,
        outputTokens,
        model,
      })
    }
  }

  private providerRow(p: ProviderAgg): ExternalApiProvider {
    const row: ExternalApiProvider = {
      provider_key: p.provider_key,
      calls: p.calls,
      errors: p.errors,
      calls_with_usage: p.calls_with_usage,
    }
    if (p.calls > 0) {
      row.duration_ms_avg = Math.round((p.duration_ms_total / p.calls) * 1000) / 1000
    }
    if (p.hosts.size) row.hosts = [...p.hosts].sort().slice(0, 8)
    if (p.input_tokens) row.input_tokens = p.input_tokens
    if (p.output_tokens) row.output_tokens = p.output_tokens
    if (p.input_tokens || p.output_tokens) {
      row.total_tokens = p.input_tokens + p.output_tokens
    }
    if (p.models.size) row.models = [...p.models].sort().slice(0, MAX_MODELS_PER_PROVIDER)
    if (p.by_model.size) {
      const byModel: ExternalApiModelBucket[] = [...p.by_model.values()]
        .filter((m) => m.calls > 0)
        .sort((a, b) => b.calls - a.calls)
        .map((m) => {
          const mRow: ExternalApiModelBucket = {
            model: m.model,
            calls: m.calls,
            errors: m.errors,
            calls_with_usage: m.calls_with_usage,
          }
          if (m.input_tokens) mRow.input_tokens = m.input_tokens
          if (m.output_tokens) mRow.output_tokens = m.output_tokens
          if (m.input_tokens || m.output_tokens) {
            mRow.total_tokens = m.input_tokens + m.output_tokens
          }
          return mRow
        })
      if (byModel.length) row.by_model = byModel
    }
    return row
  }

  buildV0(): ExternalApiV0 | null {
    const providers = [...this.providers.values()].filter((p) => p.calls > 0)
    if (!providers.length) return null
    const out = providers
      .sort((a, b) => b.calls - a.calls)
      .map((p) => this.providerRow(p))

    const by_service_unit: Record<
      string,
      { service_unit: string; calls: number; errors: number; providers: ExternalApiProvider[] }
    > = {}
    for (const [unit, bucket] of this.byServiceUnit.entries()) {
      const provs = [...bucket.values()].filter((p) => p.calls > 0)
      if (!provs.length) continue
      const rows = provs.sort((a, b) => b.calls - a.calls).map((p) => this.providerRow(p))
      by_service_unit[unit] = {
        service_unit: unit,
        calls: rows.reduce((s, r) => s + r.calls, 0),
        errors: rows.reduce((s, r) => s + r.errors, 0),
        providers: rows,
      }
    }

    const by_tenant: Record<string, ExternalApiTenantBucket> = {}
    for (const [tenant, bucket] of this.byTenant.entries()) {
      const provs = [...bucket.values()].filter((p) => p.calls > 0)
      if (!provs.length) continue
      const rows = provs.sort((a, b) => b.calls - a.calls).map((p) => this.providerRow(p))
      by_tenant[tenant] = {
        tenant_id: tenant,
        calls: rows.reduce((s, r) => s + r.calls, 0),
        errors: rows.reduce((s, r) => s + r.errors, 0),
        providers: rows,
      }
    }

    const payload: ExternalApiV0 = {
      collector: 'outbound_http',
      providers: out,
    }
    if (Object.keys(by_service_unit).length) payload.by_service_unit = by_service_unit
    if (Object.keys(by_tenant).length) payload.by_tenant = by_tenant
    return payload
  }

  takeSnapshot(): ExternalApiAggregator {
    const snap = new ExternalApiAggregator()
    snap.providers = this.providers
    snap.byServiceUnit = this.byServiceUnit
    snap.byTenant = this.byTenant
    snap.excludedHosts = new Set(this.excludedHosts)
    this.providers = new Map()
    this.byServiceUnit = new Map()
    this.byTenant = new Map()
    return snap
  }

  private static mergeProvider(target: ProviderAgg, source: ProviderAgg): void {
    target.calls += source.calls
    target.errors += source.errors
    target.duration_ms_total += source.duration_ms_total
    target.input_tokens += source.input_tokens
    target.output_tokens += source.output_tokens
    target.calls_with_usage += source.calls_with_usage
    for (const h of source.hosts) {
      if (target.hosts.size >= 8) break
      target.hosts.add(h)
    }
    for (const m of source.models) {
      if (target.models.size >= MAX_MODELS_PER_PROVIDER) break
      target.models.add(m)
    }
    for (const [key, src] of source.by_model.entries()) {
      let dst = target.by_model.get(key)
      if (!dst) {
        if (
          target.by_model.size >= MAX_MODELS_PER_PROVIDER &&
          !target.by_model.has(key)
        ) {
          const otherKey = '__other__'
          dst = target.by_model.get(otherKey)
          if (!dst) {
            dst = { model: otherKey, calls: 0, errors: 0, input_tokens: 0, output_tokens: 0, calls_with_usage: 0 }
            target.by_model.set(otherKey, dst)
          }
        } else {
          target.by_model.set(key, { ...src })
          continue
        }
      }
      dst.calls += src.calls
      dst.errors += src.errors
      dst.input_tokens += src.input_tokens
      dst.output_tokens += src.output_tokens
      dst.calls_with_usage += src.calls_with_usage
    }
  }

  mergeSnapshot(snapshot: ExternalApiAggregator): void {
    for (const [key, src] of snapshot.providers.entries()) {
      const dst = this.providers.get(key)
      if (!dst) this.providers.set(key, src)
      else ExternalApiAggregator.mergeProvider(dst, src)
    }
    for (const [unit, srcBucket] of snapshot.byServiceUnit.entries()) {
      let dstBucket = this.byServiceUnit.get(unit)
      if (!dstBucket) {
        this.byServiceUnit.set(unit, srcBucket)
        continue
      }
      for (const [key, src] of srcBucket.entries()) {
        const dst = dstBucket.get(key)
        if (!dst) dstBucket.set(key, src)
        else ExternalApiAggregator.mergeProvider(dst, src)
      }
    }
    for (const [tenant, srcBucket] of snapshot.byTenant.entries()) {
      let dstBucket = this.byTenant.get(tenant)
      if (!dstBucket) {
        this.byTenant.set(tenant, srcBucket)
        continue
      }
      for (const [key, src] of srcBucket.entries()) {
        const dst = dstBucket.get(key)
        if (!dst) dstBucket.set(key, src)
        else ExternalApiAggregator.mergeProvider(dst, src)
      }
    }
    snapshot.providers = new Map()
    snapshot.byServiceUnit = new Map()
    snapshot.byTenant = new Map()
  }

  clear(): void {
    this.providers.clear()
    this.byServiceUnit.clear()
    this.byTenant.clear()
  }
}

const globalAgg = new ExternalApiAggregator()
let installed = false
let originalFetch: typeof fetch | null = null
let restoreAxios: (() => void) | null = null
let restoreUndici: (() => void) | null = null
const pendingUsageParses: Promise<unknown>[] = []

type UsageBits = { input: number; output: number; model: string | null }

function recordMeteredCall(opts: {
  host: string
  url: string
  durationMs: number
  error: boolean
  usage: UsageBits
  serviceUnit: string | null
  tenantId: string | null
}): void {
  try {
    globalAgg.record({
      host: opts.host,
      durationMs: opts.durationMs,
      error: opts.error,
      inputTokens: opts.usage.input,
      outputTokens: opts.usage.output,
      model: opts.usage.model || modelFromUrl(opts.url),
      serviceUnit: opts.serviceUnit,
      tenantId: opts.tenantId,
    })
  } catch {
    /* never break caller */
  }
}

function resolveAxiosUrl(config: Record<string, unknown> | null | undefined): string {
  if (!config || typeof config !== 'object') return ''
  const base = typeof config.baseURL === 'string' ? config.baseURL : ''
  const path = typeof config.url === 'string' ? config.url : ''
  if (!base && !path) return ''
  try {
    if (base) return new URL(path || '', base).toString()
    return new URL(path).toString()
  } catch {
    return path || base
  }
}

function headerContentType(headers: unknown): string | null {
  if (!headers || typeof headers !== 'object') return null
  const h = headers as Record<string, unknown>
  for (const key of Object.keys(h)) {
    if (key.toLowerCase() === 'content-type') {
      const v = h[key]
      if (typeof v === 'string') return v
      if (Array.isArray(v) && typeof v[0] === 'string') return v[0]
    }
  }
  // axios Headers object
  const get = (headers as { get?: (k: string) => unknown }).get
  if (typeof get === 'function') {
    const v = get.call(headers, 'content-type')
    if (typeof v === 'string') return v
  }
  return null
}

export async function _awaitPendingUsageParses(): Promise<void> {
  await Promise.allSettled(pendingUsageParses.splice(0, pendingUsageParses.length))
}

export function getExternalAggregator(): ExternalApiAggregator {
  return globalAgg
}

export function getOriginalFetch(): typeof fetch | null {
  return originalFetch
}

export function buildExternalV0(): ExternalApiV0 | null {
  return globalAgg.buildV0()
}

export function clearExternalAggregator(): void {
  globalAgg.clear()
}

function installFetchWrap(): void {
  if (typeof globalThis.fetch !== 'function') return
  if ((globalThis.fetch as { _netgreenerWrapped?: boolean })._netgreenerWrapped) return
  originalFetch = globalThis.fetch.bind(globalThis)
  const base = originalFetch

  const wrapped: typeof fetch = async (input, init) => {
    // Axios (or another outer wrap) already owns this call.
    if (outboundMeterOwnerAls.getStore()) {
      return base(input, init)
    }
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url
    const host = hostFromUrl(url)
    // Snapshot inbound attribution when the outbound call starts — not after await.
    const serviceUnitAtStart = attributionServiceUnit()
    const tenantIdAtStart = getTenantContext()?.tenantId ?? null
    const start = performance.now()
    let error = false
    let response: Response | undefined
    try {
      response = await outboundMeterOwnerAls.run('fetch', () => base(input, init))
      if (response.status >= 400) error = true
      return response
    } catch (err) {
      error = true
      throw err
    } finally {
      const durationMs = performance.now() - start
      const recordUsage = (usage: UsageBits) => {
        recordMeteredCall({
          host,
          url,
          durationMs,
          error,
          usage,
          serviceUnit: serviceUnitAtStart,
          tenantId: tenantIdAtStart,
        })
      }
      if (!response) {
        recordUsage({ input: 0, output: 0, model: modelFromUrl(url) })
      } else {
        const captured = response
        const parse = async () => {
          try {
            return await extractUsageFromResponse(captured, url)
          } catch {
            return { input: 0, output: 0, model: modelFromUrl(url) }
          }
        }
        if (isStreamingContentType(captured)) {
          pendingUsageParses.push(parse().then(recordUsage))
        } else {
          try {
            recordUsage(await parse())
          } catch {
            recordUsage({ input: 0, output: 0, model: modelFromUrl(url) })
          }
        }
      }
    }
  }
  ;(wrapped as { _netgreenerWrapped?: boolean })._netgreenerWrapped = true
  globalThis.fetch = wrapped
}

function installAxiosWrap(): void {
  let axiosMod: {
    default?: { Axios?: { prototype: { request: (...args: unknown[]) => unknown } } }
    Axios?: { prototype: { request: (...args: unknown[]) => unknown } }
  }
  try {
    axiosMod = requireFromHere('axios') as typeof axiosMod
  } catch {
    return
  }
  const AxiosCtor = axiosMod.Axios || axiosMod.default?.Axios
  if (!AxiosCtor?.prototype?.request) return
  const proto = AxiosCtor.prototype as {
    request: ((...args: unknown[]) => unknown) & { _netgreenerWrapped?: boolean }
  }
  if (proto.request._netgreenerWrapped) return

  const originalRequest = proto.request
  const wrappedRequest = function netgreenerAxiosRequest(
    this: unknown,
    ...args: unknown[]
  ): unknown {
    if (outboundMeterOwnerAls.getStore()) {
      return originalRequest.apply(this, args)
    }
    const configOrUrl = args[0]
    const config = args[1]
    const cfg: Record<string, unknown> =
      typeof configOrUrl === 'string'
        ? { ...(typeof config === 'object' && config ? (config as object) : {}), url: configOrUrl }
        : configOrUrl && typeof configOrUrl === 'object'
          ? { ...(configOrUrl as object) }
          : {}
    const url = resolveAxiosUrl(cfg)
    const host = hostFromUrl(url)
    const serviceUnitAtStart = attributionServiceUnit()
    const tenantIdAtStart = getTenantContext()?.tenantId ?? null
    const start = performance.now()
    let error = false

    const invoke = (): unknown => originalRequest.apply(this, args)

    const after = (result: unknown, threw: boolean): unknown => {
      const durationMs = performance.now() - start
      if (threw) {
        recordMeteredCall({
          host,
          url,
          durationMs,
          error: true,
          usage: { input: 0, output: 0, model: modelFromUrl(url) },
          serviceUnit: serviceUnitAtStart,
          tenantId: tenantIdAtStart,
        })
        return result
      }
      const resp = result as {
        status?: number
        data?: unknown
        headers?: unknown
        config?: { responseType?: string }
      } | null
      try {
        if (resp && typeof resp.status === 'number' && resp.status >= 400) error = true
      } catch {
        /* ignore */
      }
      const responseType = String(resp?.config?.responseType || cfg.responseType || '').toLowerCase()
      const streaming = responseType === 'stream'
      let usage: UsageBits = { input: 0, output: 0, model: modelFromUrl(url) }
      if (!streaming && resp) {
        try {
          usage = usageFromClientBody(resp.data, url, headerContentType(resp.headers))
        } catch {
          /* zeros */
        }
      }
      recordMeteredCall({
        host,
        url,
        durationMs,
        error,
        usage,
        serviceUnit: serviceUnitAtStart,
        tenantId: tenantIdAtStart,
      })
      return result
    }

    try {
      const maybePromise = outboundMeterOwnerAls.run('axios', invoke)
      if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
        return (maybePromise as Promise<unknown>).then(
          (r) => after(r, false),
          (err) => {
            after(undefined, true)
            throw err
          },
        )
      }
      return after(maybePromise, false)
    } catch (err) {
      after(undefined, true)
      throw err
    }
  }
  wrappedRequest._netgreenerWrapped = true
  proto.request = wrappedRequest as typeof proto.request
  restoreAxios = () => {
    proto.request = originalRequest
    restoreAxios = null
  }
}

function installUndiciWrap(): void {
  let undici: {
    request?: ((...args: unknown[]) => unknown) & { _netgreenerWrapped?: boolean }
    Dispatcher?: {
      prototype: {
        request: ((...args: unknown[]) => unknown) & { _netgreenerWrapped?: boolean }
      }
    }
  }
  try {
    undici = requireFromHere('undici') as typeof undici
  } catch {
    return
  }

  const wrapUndiciRequest = (
    original: (...args: unknown[]) => unknown,
  ): ((...args: unknown[]) => unknown) & { _netgreenerWrapped?: boolean } => {
    const wrapped = function netgreenerUndiciRequest(
      this: unknown,
      ...args: unknown[]
    ): unknown {
      // Outer fetch/axios already recorded — undici is the transport only.
      if (outboundMeterOwnerAls.getStore()) {
        return original.apply(this, args)
      }
      // Dispatcher.prototype.request(opts) vs undici.request(url, opts)
      let url = ''
      if (typeof args[0] === 'string' || args[0] instanceof URL) {
        url = String(args[0])
      } else if (args[0] && typeof args[0] === 'object') {
        const opts = args[0] as { path?: string; origin?: string; hostname?: string }
        if (typeof opts.path === 'string' && (opts.origin || opts.hostname)) {
          url = `${opts.origin || `https://${opts.hostname}`}${opts.path}`
        } else if (typeof (opts as { url?: string }).url === 'string') {
          url = String((opts as { url?: string }).url)
        }
      }
      const host = hostFromUrl(url)
      const serviceUnitAtStart = attributionServiceUnit()
      const tenantIdAtStart = getTenantContext()?.tenantId ?? null
      const start = performance.now()

      const finish = (result: unknown, threw: boolean): unknown => {
        const durationMs = performance.now() - start
        let error = threw
        if (!threw && result && typeof result === 'object') {
          const status = (result as { statusCode?: number }).statusCode
          if (typeof status === 'number' && status >= 400) error = true
        }
        // Do not consume undici body streams — call/error/duration only (tokens via fetch/axios JSON).
        recordMeteredCall({
          host,
          url,
          durationMs,
          error,
          usage: { input: 0, output: 0, model: modelFromUrl(url) },
          serviceUnit: serviceUnitAtStart,
          tenantId: tenantIdAtStart,
        })
        return result
      }

      try {
        const maybePromise = outboundMeterOwnerAls.run('undici', () =>
          original.apply(this, args),
        )
        if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
          return (maybePromise as Promise<unknown>).then(
            (r) => finish(r, false),
            (err) => {
              finish(undefined, true)
              throw err
            },
          )
        }
        return finish(maybePromise, false)
      } catch (err) {
        finish(undefined, true)
        throw err
      }
    }
    wrapped._netgreenerWrapped = true
    return wrapped
  }

  const restores: Array<() => void> = []

  // Wrap both the module helper and Dispatcher.prototype. Nested calls are
  // de-duped by outboundMeterOwnerAls (undici.request → dispatcher.request).
  if (typeof undici.request === 'function' && !undici.request._netgreenerWrapped) {
    const original = undici.request.bind(undici)
    undici.request = wrapUndiciRequest(original) as typeof undici.request
    restores.push(() => {
      undici.request = original as typeof undici.request
    })
  }

  const dispProto = undici.Dispatcher?.prototype
  if (dispProto && typeof dispProto.request === 'function' && !dispProto.request._netgreenerWrapped) {
    const original = dispProto.request
    dispProto.request = wrapUndiciRequest(function (this: unknown, ...args: unknown[]) {
      return original.apply(this, args)
    }) as typeof dispProto.request
    restores.push(() => {
      dispProto.request = original
    })
  }

  if (restores.length) {
    restoreUndici = () => {
      for (const r of restores) {
        try {
          r()
        } catch {
          /* ignore */
        }
      }
      restoreUndici = null
    }
  }
}

/** Test helper — reset install state. */
export function _resetOutboundInstrumentationForTests(): void {
  pendingUsageParses.length = 0
  if (originalFetch && typeof globalThis.fetch === 'function') {
    globalThis.fetch = originalFetch
  }
  originalFetch = null
  if (restoreAxios) {
    try {
      restoreAxios()
    } catch {
      /* ignore */
    }
  }
  restoreAxios = null
  if (restoreUndici) {
    try {
      restoreUndici()
    } catch {
      /* ignore */
    }
  }
  restoreUndici = null
  installed = false
  globalAgg.clear()
}

export function installOutboundInstrumentation(opts?: {
  excludedHosts?: Iterable<string>
}): void {
  if (installed) return
  installed = true
  if (opts?.excludedHosts) {
    globalAgg.setExcludedHosts(opts.excludedHosts)
  }
  try {
    installFetchWrap()
  } catch {
    /* never break caller bootstrap */
  }
  try {
    installAxiosWrap()
  } catch {
    /* optional peer */
  }
  try {
    installUndiciWrap()
  } catch {
    /* optional / built-in */
  }
}
