/**
 * Same-process MCP tool observation for the Node runtime.
 *
 * Matches the Python week-1 counter and week-2 duration rows. The active
 * tool-call id lives in AsyncLocalStorage. A fetch that starts while that id
 * is set records a link. The link is not written onto external_api_v0.
 *
 * The counter is this process only. Warn is the default. Block is opt-in and
 * does not invoke the tool. A configured estimate is not added to API cost.
 * The official TypeScript MCP client is not patched. Calls are recorded only
 * when this process calls beginToolCall. A missing client hook is not monitoring.
 *
 * Raw tool arguments, results, and HTTP bodies are not stored.
 */

import { meteringAllowed } from './runtimeControls.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'

import { sendCollectorEvent } from './collectorIpc.js'
import { getTenantContext } from './tenantContext.js'

const MAX_STORED = 200

const NOTES = [
  'Budget is in-process only. Another process, worker, or machine does not share it.',
  'This counter covers the whole Node process. It is not a per-job budget.',
  'A high call count is not an anomaly and is not waste.',
  'stdio transport is not an HTTP call. HTTP made inside a tool stays in external_api_v0.',
  'A configured estimate is not a provider bill and is not added to API cost or CPU time.',
]

const CANNOT_SAY = [
  'Which API made a tool slow.',
  'Which wait was the Celery queue.',
  'Which retry slept. Failed-call time is not backoff.',
]

export class McpToolBudgetBlocked extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpToolBudgetBlocked'
  }
}

export type McpBudgetAction = 'allow' | 'warn' | 'block'

export type McpToolCallRow = {
  server: string
  tool: string
  started_at: string
  duration_ms: number
  success: boolean
  attempt: number
  budget_action: McpBudgetAction
  invoked: boolean
  call_id: string
  execution_id?: string
  tenant_id?: string
  estimated_usd?: number
  estimate_label?: 'configured'
  budget_reason?: string
}

export type McpHttpLinkRow = {
  tool_call_id: string
  host: string
  duration_ms: number
  error: boolean
}

export type McpToolDecision = {
  callId: string
  server: string
  tool: string
  attempt: number
  action: McpBudgetAction
  reason: string | null
}

const activeCall = new AsyncLocalStorage<string>()
const sequences = new Map<string, number>()

function clean(value: string, fallback: string): string {
  const text = value.trim().slice(0, 128)
  return text || fallback
}

function optionalIntEnv(name: string): number | null {
  const raw = (process.env[name] || '').trim()
  if (!raw) return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) return null
  return value
}

export function budgetMode(): 'warn' | 'block' {
  const mode = (process.env.NETGREENER_MCP_BUDGET_MODE || 'warn').trim().toLowerCase()
  return mode === 'block' ? 'block' : 'warn'
}

function configuredEstimates(): Map<string, number> {
  const raw = (process.env.NETGREENER_MCP_TOOL_ESTIMATE_USD || '').trim()
  const out = new Map<string, number>()
  if (!raw) return out
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const amount = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(amount) || amount < 0) continue
    out.set(String(key).slice(0, 160), amount)
  }
  return out
}

function configuredEstimateUsd(server: string, tool: string): number | null {
  const estimates = configuredEstimates()
  if (estimates.size === 0) return null
  const pair = estimates.get(`${server}::${tool}`)
  if (pair !== undefined) return pair
  const toolOnly = estimates.get(tool)
  return toolOnly === undefined ? null : toolOnly
}

function tenantIdNow(): string | null {
  try {
    const text = String(getTenantContext()?.tenantId || '').trim().slice(0, 128)
    return text || null
  } catch {
    return null
  }
}

function collectorEndpoint(): string {
  return (process.env.NETGREENER_COLLECTOR_ENDPOINT || '').trim()
}

function metricsPort(): string {
  return (process.env.NETGREENER_METRICS_PORT || '').trim()
}

function emitSample(payload: Record<string, unknown>): boolean {
  const collector = collectorEndpoint()
  const port = metricsPort()
  if (!collector && !port) return false
  if (collector) {
    void emitToCollector(collector, payload)
    return true
  }
  emitToMetricsPort(port, payload)
  return true
}

function emitToMetricsPort(port: string, payload: Record<string, unknown>): void {
  const portNumber = Number(port)
  if (!Number.isInteger(portNumber) || portNumber <= 0) return
  const socket = connect({ host: '127.0.0.1', port: portNumber, timeout: 2000 })
  socket.unref()
  const fail = () => {
    socket.destroy()
  }
  socket.once('error', fail)
  socket.once('timeout', fail)
  socket.once('connect', () => {
    socket.end(JSON.stringify(payload))
  })
}

async function emitToCollector(endpoint: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const projectId = Number(process.env.NETGREENER_PROJECT_ID || '')
    if (!Number.isInteger(projectId) || projectId <= 0) return
    const event: Record<string, unknown> = {
      ...payload,
      project_id: projectId,
      wall_time_utc: new Date().toISOString(),
    }
    const executionId = String(event.execution_id || '')
    if (executionId) {
      const sequence = (sequences.get(executionId) ?? 0) + 1
      sequences.set(executionId, sequence)
      event.event_id = randomUUID()
      event.sequence_number = sequence
    }
    const timeoutMs = Math.max(1, Number(process.env.NETGREENER_EMIT_TIMEOUT_MS || '100') || 100)
    await sendCollectorEvent({ endpoint, payload: event, timeoutMs })
  } catch {
    /* fail open: a missing collector must not break the tool call */
  }
}

export function activeMcpToolCallId(): string | null {
  const value = activeCall.getStore()
  const text = String(value || '').trim().slice(0, 64)
  return text || null
}

export function runWithMcpToolCall<T>(callId: string, fn: () => T): T {
  return activeCall.run(String(callId).slice(0, 64), fn)
}

export class McpToolLedger {
  private calls: McpToolCallRow[] = []
  private httpLinks: McpHttpLinkRow[] = []
  private dropped = 0
  private budgetTotals = new Map<string, number>()
  private budgetPairs = new Map<string, Map<string, number>>()

  hasCalls(): boolean {
    return this.calls.length > 0
  }

  beginToolCall(server: string, tool: string): McpToolDecision {
    if (!meteringAllowed()) return { callId: randomUUID(), server, tool, attempt: 1, action: 'allow', reason: null }
    const serverName = clean(server, 'unknown')
    const toolName = clean(tool, 'unknown')
    const scope = 'process'
    const total = (this.budgetTotals.get(scope) ?? 0) + 1
    this.budgetTotals.set(scope, total)
    let pairs = this.budgetPairs.get(scope)
    if (!pairs) {
      pairs = new Map()
      this.budgetPairs.set(scope, pairs)
    }
    const pairKey = `${serverName}\0${toolName}`
    const attempt = (pairs.get(pairKey) ?? 0) + 1
    pairs.set(pairKey, attempt)
    const maxCalls = optionalIntEnv('NETGREENER_MCP_MAX_CALLS')
    const maxRepeats = optionalIntEnv('NETGREENER_MCP_MAX_REPEATS')
    const reasons: string[] = []
    if (maxCalls !== null && total > maxCalls) reasons.push(`max calls per run is ${maxCalls}`)
    if (maxRepeats !== null && attempt > maxRepeats) {
      reasons.push(`max calls for this tool is ${maxRepeats}`)
    }
    const action: McpBudgetAction = reasons.length === 0 ? 'allow' : budgetMode()
    return {
      callId: randomUUID().replace(/-/g, ''),
      server: serverName,
      tool: toolName,
      attempt,
      action,
      reason: reasons.length ? reasons.join('; ') : null,
    }
  }

  finishToolCall(
    decision: McpToolDecision,
    opts: { success: boolean; durationMs: number; startedAt?: string },
  ): void {
    if (!meteringAllowed()) return
    const blocked = decision.action === 'block'
    const row: McpToolCallRow = {
      server: decision.server,
      tool: decision.tool,
      started_at: opts.startedAt ?? new Date().toISOString(),
      duration_ms: Math.round(Math.max(0, opts.durationMs) * 1000) / 1000,
      success: Boolean(opts.success) && !blocked,
      attempt: decision.attempt,
      budget_action: decision.action,
      invoked: !blocked,
      call_id: decision.callId,
    }
    const tenantId = tenantIdNow()
    if (tenantId) row.tenant_id = tenantId
    const estimate = configuredEstimateUsd(decision.server, decision.tool)
    if (estimate !== null) {
      row.estimated_usd = estimate
      row.estimate_label = 'configured'
    }
    if (decision.reason) row.budget_reason = decision.reason
    if (emitSample({ kind: 'mcp_tool_sample', ...row })) return
    this.append(row)
  }

  recordHttpLink(row: {
    toolCallId: string
    host: string
    durationMs: number
    error: boolean
  }): void {
    const toolCallId = row.toolCallId.trim().slice(0, 64)
    const host = row.host.trim().toLowerCase().slice(0, 255)
    if (!toolCallId || !host) return
    const link: McpHttpLinkRow = {
      tool_call_id: toolCallId,
      host,
      duration_ms: Math.round(Math.max(0, row.durationMs) * 1000) / 1000,
      error: row.error,
    }
    if (
      emitSample({
        kind: 'mcp_http_link_sample',
        ...link,
      })
    ) {
      return
    }
    if (this.httpLinks.length >= MAX_STORED) {
      this.dropped += 1
      return
    }
    this.httpLinks.push(link)
  }

  takeSnapshot(): McpToolLedger {
    const snapshot = new McpToolLedger()
    snapshot.calls = this.calls
    snapshot.httpLinks = this.httpLinks
    snapshot.dropped = this.dropped
    this.calls = []
    this.httpLinks = []
    this.dropped = 0
    return snapshot
  }

  mergeSnapshot(snapshot: McpToolLedger): void {
    this.calls = snapshot.calls.concat(this.calls)
    this.httpLinks = snapshot.httpLinks.concat(this.httpLinks)
    this.dropped += snapshot.dropped
    snapshot.calls = []
    snapshot.httpLinks = []
    snapshot.dropped = 0
    if (this.calls.length > MAX_STORED) {
      this.dropped += this.calls.length - MAX_STORED
      this.calls = this.calls.slice(-MAX_STORED)
    }
  }

  buildV0(): Record<string, unknown> | null {
    if (this.calls.length === 0) return null
    const byTool = new Map<
      string,
      {
        server: string
        tool: string
        calls: number
        failures: number
        duration_ms: number
        estimated_usd: number | null
      }
    >()
    const tenants = new Set<string>()
    for (const row of this.calls) {
      const key = `${row.server}\0${row.tool}`
      const bucket = byTool.get(key) ?? {
        server: row.server,
        tool: row.tool,
        calls: 0,
        failures: 0,
        duration_ms: 0,
        estimated_usd: null,
      }
      bucket.calls += 1
      if (!row.success) bucket.failures += 1
      bucket.duration_ms = Math.round((bucket.duration_ms + row.duration_ms) * 1000) / 1000
      if (row.estimated_usd !== undefined) {
        bucket.estimated_usd = Math.round(((bucket.estimated_usd ?? 0) + row.estimated_usd) * 1_000_000) / 1_000_000
      }
      if (row.tenant_id) tenants.add(row.tenant_id)
      byTool.set(key, bucket)
    }
    const tools = [...byTool.values()]
      .map((bucket) => {
        const row: Record<string, unknown> = {
          server: bucket.server,
          tool: bucket.tool,
          calls: bucket.calls,
          failures: bucket.failures,
          duration_ms: bucket.duration_ms,
        }
        if (bucket.estimated_usd !== null) {
          row.estimated_usd = bucket.estimated_usd
          row.estimate_label = 'configured'
        }
        return row
      })
      .sort((a, b) => Number(b.calls) - Number(a.calls) || String(a.tool).localeCompare(String(b.tool)))
    const payload: Record<string, unknown> = {
      schema: 'mcp_tool_v0',
      budget_scope: 'in_process',
      not_distributed: true,
      budget_mode: budgetMode(),
      limits: {
        max_calls: optionalIntEnv('NETGREENER_MCP_MAX_CALLS'),
        max_repeats: optionalIntEnv('NETGREENER_MCP_MAX_REPEATS'),
      },
      calls: this.calls,
      by_tool: tools,
      notes: NOTES,
    }
    if (this.httpLinks.length > 0) {
      payload.http_in_context = this.httpLinks
      payload.attribution_note =
        'Each HTTP row started while that tool call was active in this process. ' +
        'That is context, not proof the request was unnecessary. ' +
        'Cost stays in external_api_v0 and is not counted again.'
    }
    if (this.dropped > 0) {
      payload.truncated = true
      payload.dropped_calls = this.dropped
    }
    if (tenants.size === 1) payload.tenant_id = [...tenants][0]
    return payload
  }

  clear(): void {
    this.calls = []
    this.httpLinks = []
    this.dropped = 0
    this.budgetTotals.clear()
    this.budgetPairs.clear()
  }

  private append(row: McpToolCallRow): void {
    if (this.calls.length >= MAX_STORED) {
      this.dropped += 1
      return
    }
    this.calls.push(row)
  }
}

const ledger = new McpToolLedger()

export function getMcpToolLedger(): McpToolLedger {
  return ledger
}

export function beginToolCall(server: string, tool: string): McpToolDecision {
  return ledger.beginToolCall(server, tool)
}

export function finishToolCall(
  decision: McpToolDecision,
  opts: { success: boolean; durationMs: number; startedAt?: string },
): void {
  ledger.finishToolCall(decision, opts)
}

export function recordHttpInToolContext(row: {
  toolCallId: string | null
  host: string
  durationMs: number
  error: boolean
}): void {
  if (!meteringAllowed() || !row.toolCallId) return
  ledger.recordHttpLink({
    toolCallId: row.toolCallId,
    host: row.host,
    durationMs: row.durationMs,
    error: row.error,
  })
}

export function buildMcpToolV0(): Record<string, unknown> | null {
  return ledger.buildV0()
}

export function httpDurationMs(externalV0: Record<string, unknown> | null | undefined): number {
  if (!externalV0) return 0
  const providers = externalV0.providers
  if (!Array.isArray(providers)) return 0
  let total = 0
  for (const row of providers) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    if (record.duration_ms_total !== undefined && record.duration_ms_total !== null) {
      total += Number(record.duration_ms_total) || 0
      continue
    }
    total += (Number(record.calls) || 0) * (Number(record.duration_ms_avg) || 0)
  }
  return total
}

export function mcpDurationMs(
  mcpV0: Record<string, unknown> | null | undefined,
  failedOnly = false,
): number {
  if (!mcpV0 || !Array.isArray(mcpV0.calls)) return 0
  let total = 0
  for (const row of mcpV0.calls) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    if (failedOnly && record.success) continue
    if (failedOnly && record.success !== false) continue
    total += Number(record.duration_ms) || 0
  }
  return total
}

export function buildMcpLatencyV0(
  mcpV0: Record<string, unknown> | null | undefined,
  externalV0: Record<string, unknown> | null | undefined,
  wallSeconds: number | null,
): Record<string, unknown> | null {
  if (!mcpV0 || !Array.isArray(mcpV0.calls) || mcpV0.calls.length === 0) return null
  const wallMs = wallSeconds === null ? null : Math.max(0, wallSeconds * 1000)
  const mcpMs = mcpDurationMs(mcpV0)
  const httpMs = httpDurationMs(externalV0)
  const failedMs = mcpDurationMs(mcpV0, true)
  const mcpOver = wallMs !== null && mcpMs > wallMs
  const httpOver = wallMs !== null && httpMs > wallMs
  let remainder: number | null = null
  let rowsOverlap = false
  if (wallMs !== null && !mcpOver && !httpOver) {
    if (mcpMs + httpMs <= wallMs) remainder = Math.round((wallMs - mcpMs - httpMs) * 1000) / 1000
    else rowsOverlap = true
  }
  const rows: Array<Record<string, unknown>> = []
  if (wallMs !== null) {
    rows.push({
      id: 'wall',
      label: 'Task wall time',
      duration_ms: Math.round(wallMs * 1000) / 1000,
      overlapping: false,
    })
  }
  rows.push({
    id: 'mcp',
    label: 'MCP tools',
    duration_ms: Math.round(mcpMs * 1000) / 1000,
    overlapping: mcpOver,
  })
  rows.push({
    id: 'http',
    label: 'HTTP, including LLM',
    duration_ms: Math.round(httpMs * 1000) / 1000,
    overlapping: httpOver,
    note: 'Full call duration. Not time to first token.',
  })
  rows.push({
    id: 'failed_mcp',
    label: 'Failed MCP calls',
    duration_ms: Math.round(failedMs * 1000) / 1000,
    overlapping: false,
    note: 'Time inside calls that failed. Not backoff, and not proof of a retry loop.',
  })
  if (remainder !== null) {
    rows.push({
      id: 'unattributed',
      label: 'Unattributed',
      duration_ms: remainder,
      overlapping: false,
      note: 'Not CPU or GPU.',
    })
  }
  return {
    schema: 'mcp_latency_v0',
    rows,
    remainder_omitted: remainder === null,
    rows_overlap_each_other: rowsOverlap,
    cannot_say: CANNOT_SAY,
  }
}

export function clearMcpToolLedger(): void {
  ledger.clear()
}

/**
 * Official MCP client patching stays off until one SDK version is installed
 * and its callTool signature is tested. A command basename is not a server name.
 * This returns false so a caller cannot treat the hook as active.
 */
export function installMcpClientInstrumentation(): boolean {
  return false
}

export function _resetMcpToolMeterForTests(): void {
  ledger.clear()
}
