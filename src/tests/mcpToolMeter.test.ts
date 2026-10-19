import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadRuntimeConfig } from '../config.js'
import {
  StreamUsageMeter,
  _resetOutboundInstrumentationForTests,
  buildExternalV0,
  clearExternalAggregator,
  installOutboundInstrumentation,
} from '../externalApiMeter.js'
import {
  McpToolBudgetBlocked,
  _resetMcpToolMeterForTests,
  activeMcpToolCallId,
  beginToolCall,
  buildMcpLatencyV0,
  buildMcpToolV0,
  finishToolCall,
  installMcpClientInstrumentation,
  runWithMcpToolCall,
} from '../mcpToolMeter.js'
import { _resetRuntimeForTests, NetGreenerRuntime } from '../runtime.js'
import { DEFAULT_TENANT_RUNTIME_FIELDS } from '../tenantDefaults.js'

function jsonResponse(): Response {
  return new Response('{"ok":true}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('mcp tool meter', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    _resetOutboundInstrumentationForTests()
    _resetMcpToolMeterForTests()
    clearExternalAggregator()
  })

  afterEach(() => {
    _resetOutboundInstrumentationForTests()
    _resetMcpToolMeterForTests()
    clearExternalAggregator()
    globalThis.fetch = originalFetch
    delete process.env.NETGREENER_MCP_MAX_CALLS
    delete process.env.NETGREENER_MCP_MAX_REPEATS
    delete process.env.NETGREENER_MCP_BUDGET_MODE
    delete process.env.NETGREENER_MCP_TOOL_ESTIMATE_USD
    delete process.env.NETGREENER_METRICS_PORT
    delete process.env.NETGREENER_COLLECTOR_ENDPOINT
    delete process.env.NETGREENER_PROJECT_ID
  })

  it('gives every tool call its own id', () => {
    const first = beginToolCall('demo', 'lookup_record')
    const second = beginToolCall('demo', 'lookup_record')
    assert.notEqual(first.callId, second.callId)
    assert.equal(activeMcpToolCallId(), null)
  })

  it('keeps concurrent calls on their own ids', async () => {
    const seen: string[] = []
    await Promise.all([
      runWithMcpToolCall('call-a', async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        seen.push(activeMcpToolCallId() ?? 'none')
      }),
      runWithMcpToolCall('call-b', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        seen.push(activeMcpToolCallId() ?? 'none')
      }),
    ])
    assert.deepEqual(seen.sort(), ['call-a', 'call-b'])
    assert.equal(activeMcpToolCallId(), null)
  })

  it('restores the outer id after a nested call', () => {
    let inner: string | null = null
    let outerAfter: string | null = null
    runWithMcpToolCall('outer', () => {
      runWithMcpToolCall('inner', () => {
        inner = activeMcpToolCallId()
      })
      outerAfter = activeMcpToolCallId()
    })
    assert.equal(inner, 'inner')
    assert.equal(outerAfter, 'outer')
    assert.equal(activeMcpToolCallId(), null)
  })

  it('clears the id after an exception', () => {
    assert.throws(() => {
      runWithMcpToolCall('boom', () => {
        throw new Error('tool failed')
      })
    })
    assert.equal(activeMcpToolCallId(), null)
  })

  it('does not attribute a task that started before the tool call', async () => {
    let seen: string | null = 'pending'
    const early = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      seen = activeMcpToolCallId()
    })()
    await new Promise((resolve) => setTimeout(resolve, 5))
    await runWithMcpToolCall('later', async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    await early
    assert.equal(seen, null)
  })

  it('does not link HTTP that starts outside a tool', async () => {
    globalThis.fetch = async () => jsonResponse()
    installOutboundInstrumentation({ excludedHosts: [] })
    await fetch('https://api.openai.com/v1/models')
    const decision = beginToolCall('demo', 'lookup_record')
    finishToolCall(decision, { success: true, durationMs: 4 })
    const mcp = buildMcpToolV0()
    assert.ok(mcp)
    assert.equal(mcp!.http_in_context, undefined)
    const external = buildExternalV0()
    assert.equal(external?.providers[0]?.calls, 1)
    assert.equal(JSON.stringify(external).includes('tool_call_id'), false)
  })

  it('keeps the id captured when the request started, after the tool context ends', async () => {
    let started!: () => void
    const startedGate = new Promise<void>((resolve) => {
      started = resolve
    })
    let release!: () => void
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve
    })
    globalThis.fetch = async () => {
      started()
      await releaseGate
      return jsonResponse()
    }
    installOutboundInstrumentation({ excludedHosts: [] })

    const decision = beginToolCall('demo', 'lookup_record')
    let flight!: Promise<Response>
    runWithMcpToolCall(decision.callId, () => {
      flight = fetch('https://api.openai.com/v1/chat/completions')
    })
    await startedGate
    assert.equal(activeMcpToolCallId(), null)
    release()
    await flight
    finishToolCall(decision, { success: true, durationMs: 8 })

    const mcp = buildMcpToolV0()
    const links = mcp?.http_in_context as Array<Record<string, unknown>>
    assert.equal(links.length, 1)
    assert.equal(links[0].tool_call_id, decision.callId)
    assert.equal(links[0].host, 'api.openai.com')
    assert.equal(JSON.stringify(links).includes('/v1/'), false)
    assert.equal(JSON.stringify(links).includes('chat/completions'), false)
    const external = buildExternalV0()
    assert.equal(external?.providers[0]?.calls, 1)
    assert.equal(JSON.stringify(external).includes('tool_call_id'), false)
    assert.equal(JSON.stringify(external).includes(decision.callId), false)
  })

  it('reports the stream id stored at start, not the id active at finish', () => {
    const decision = beginToolCall('demo', 'lookup_record')
    finishToolCall(decision, { success: true, durationMs: 2 })
    const meter = new StreamUsageMeter({
      host: 'api.openai.com',
      url: 'https://api.openai.com/v1/chat/completions',
      start: performance.now(),
      error: false,
      serviceUnit: null,
      tenantId: null,
      parentToolCallId: decision.callId,
    })
    assert.equal(activeMcpToolCallId(), null)
    meter.finish()
    const links = buildMcpToolV0()?.http_in_context as Array<Record<string, unknown>>
    assert.equal(links[0].tool_call_id, decision.callId)
    assert.equal(JSON.stringify(links).includes('chat/completions'), false)
    assert.equal(JSON.stringify(buildExternalV0()).includes('tool_call_id'), false)
  })

  it('does not inherit the id in a child process', () => {
    const meterHref = pathToFileURL(
      join(dirname(fileURLToPath(import.meta.url)), '../mcpToolMeter.js'),
    ).href
    let child = ''
    runWithMcpToolCall('parent-only', () => {
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { activeMcpToolCallId } from ${JSON.stringify(meterHref)}; console.log(activeMcpToolCallId() ?? 'none')`,
        ],
        { encoding: 'utf8' },
      )
      assert.equal(result.status, 0, result.stderr)
      child = (result.stdout || '').trim()
    })
    assert.equal(child, 'none')
    assert.equal(activeMcpToolCallId(), null)
  })

  it('warns by default and blocks only when that mode is set', () => {
    process.env.NETGREENER_MCP_MAX_REPEATS = '1'
    const first = beginToolCall('demo', 'lookup_record')
    const second = beginToolCall('demo', 'lookup_record')
    assert.equal(first.action, 'allow')
    assert.equal(second.action, 'warn')
    finishToolCall(first, { success: true, durationMs: 3 })
    finishToolCall(second, { success: true, durationMs: 3 })
    const warned = buildMcpToolV0()
    assert.equal(warned?.budget_mode, 'warn')
    assert.equal(warned?.budget_scope, 'in_process')
    assert.ok(
      (warned?.notes as string[]).some((note) => note.includes('whole Node process')),
    )

    _resetMcpToolMeterForTests()
    process.env.NETGREENER_MCP_BUDGET_MODE = 'block'
    const allowed = beginToolCall('demo', 'lookup_record')
    const blocked = beginToolCall('demo', 'lookup_record')
    assert.equal(blocked.action, 'block')
    finishToolCall(allowed, { success: true, durationMs: 1 })
    finishToolCall(blocked, { success: false, durationMs: 0 })
    assert.equal(activeMcpToolCallId(), null)
    const calls = buildMcpToolV0()?.calls as Array<{ invoked: boolean; budget_action: string }>
    assert.equal(calls[1].invoked, false)
    assert.equal(calls[1].budget_action, 'block')
    assert.equal(new McpToolBudgetBlocked('stopped').name, 'McpToolBudgetBlocked')
  })

  it('keeps a configured estimate off the API cost', () => {
    process.env.NETGREENER_MCP_TOOL_ESTIMATE_USD = JSON.stringify({ lookup_record: 0.02 })
    const decision = beginToolCall('demo', 'lookup_record')
    finishToolCall(decision, { success: true, durationMs: 5 })
    const mcp = buildMcpToolV0()
    const calls = mcp?.calls as Array<{ estimated_usd?: number; estimate_label?: string }>
    const byTool = mcp?.by_tool as Array<{ estimated_usd?: number; estimate_label?: string }>
    assert.equal(calls[0].estimated_usd, 0.02)
    assert.equal(calls[0].estimate_label, 'configured')
    assert.equal(byTool[0].estimated_usd, 0.02)
    assert.equal(byTool[0].estimate_label, 'configured')
  })

  it('marks overlapping durations and leaves a remainder only when both sums fit', () => {
    const decision = beginToolCall('demo', 'lookup_record')
    finishToolCall(decision, { success: false, durationMs: 4000 })
    const mcp = buildMcpToolV0()
    const overlap = buildMcpLatencyV0(
      mcp,
      { providers: [{ calls: 1, duration_ms_avg: 3000 }] },
      5,
    )
    assert.equal(overlap?.rows_overlap_each_other, true)
    assert.equal(overlap?.remainder_omitted, true)
    assert.equal(
      (overlap?.rows as Array<{ id: string }>).some((row) => row.id === 'unattributed'),
      false,
    )
    const httpOverWall = buildMcpLatencyV0(
      mcp,
      { providers: [{ calls: 1, duration_ms_avg: 8000 }] },
      5,
    )
    const httpRow = (httpOverWall?.rows as Array<{ id: string; overlapping: boolean }>).find(
      (row) => row.id === 'http',
    )
    assert.equal(httpRow?.overlapping, true)

    const inside = buildMcpLatencyV0(
      mcp,
      { providers: [{ calls: 2, duration_ms_total: 1000 }] },
      10,
    )
    const unattributed = (inside?.rows as Array<{ id: string; duration_ms: number }>).find(
      (row) => row.id === 'unattributed',
    )
    assert.equal(unattributed?.duration_ms, 5000)
    const failed = (inside?.rows as Array<{ id: string; duration_ms: number }>).find(
      (row) => row.id === 'failed_mcp',
    )
    assert.equal(failed?.duration_ms, 4000)
  })

  it('does not keep a local copy when a collector or metrics port is configured', () => {
    process.env.NETGREENER_METRICS_PORT = '1'
    const decision = beginToolCall('demo', 'lookup_record')
    finishToolCall(decision, { success: true, durationMs: 2 })
    assert.equal(buildMcpToolV0(), null)
  })

  it('does not share the counter with a child process', () => {
    beginToolCall('demo', 'lookup_record')
    beginToolCall('demo', 'lookup_record')
    const meterHref = pathToFileURL(
      join(dirname(fileURLToPath(import.meta.url)), '../mcpToolMeter.js'),
    ).href
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { beginToolCall } from ${JSON.stringify(meterHref)}; console.log(beginToolCall('demo', 'lookup_record').attempt)`,
      ],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal((result.stdout || '').trim(), '1')
  })

  it('does not patch an MCP client until a verified SDK is tested', () => {
    assert.equal(installMcpClientInstrumentation(), false)
    const mcp = buildMcpToolV0()
    assert.equal(mcp, null)
  })

  it('attaches mcp_tool_v0 on an existing flush and restores it if upload fails', async () => {
    const decision = beginToolCall('demo', 'lookup_record')
    finishToolCall(decision, { success: true, durationMs: 6 })
    const runtime = new NetGreenerRuntime({
      config: {
        enabled: true,
        apiUrl: 'http://127.0.0.1:9',
        token: 'ngs_test',
        projectId: 1,
        organizationId: null,
        organizationSlug: null,
        flushIntervalMs: 60_000,
        dryRun: false,
        deployEnvironment: null,
        releaseTag: null,
        estimateTdpWatts: 65,
        ...DEFAULT_TENANT_RUNTIME_FIELDS,
      },
      collector: 'express_middleware',
      framework: 'express',
      fetchImpl: async () => new Response(JSON.stringify({ detail: 'nope' }), { status: 500 }),
    })
    runtime.recordHttp({
      method: 'GET',
      path: '/health',
      statusCode: 200,
      durationMs: 5,
    })
    const failed = await runtime.flush('manual')
    assert.ok(failed && !failed.ok)
    assert.equal(buildMcpToolV0()?.schema, 'mcp_tool_v0')

    _resetRuntimeForTests()
    process.env.NETGREENER_SERVICE_RUNTIME = '1'
    process.env.NETGREENER_TOKEN = 'ngs_test'
    process.env.NETGREENER_PROJECT_ID = '42'
    process.env.NETGREENER_RUNTIME_DRY_RUN = '1'
    const dry = new NetGreenerRuntime({
      config: loadRuntimeConfig(),
      collector: 'express_middleware',
      framework: 'express',
    })
    dry.recordHttp({
      method: 'GET',
      path: '/health',
      statusCode: 200,
      durationMs: 5,
      cpuTimeMs: 1,
      peakRssKb: 1024,
    })
    const ok = await dry.flush('manual')
    assert.ok(ok && ok.ok)
    if (ok && ok.ok) {
      const meta = (ok.body as { session_metadata: Record<string, unknown> }).session_metadata
      const mcp = meta.mcp_tool_v0 as { calls: Array<{ call_id: string }> }
      assert.equal(mcp.calls[0].call_id, decision.callId)
      assert.equal(JSON.stringify(meta.external_api_v0 ?? {}).includes('tool_call_id'), false)
      const latency = meta.mcp_latency_v0 as { schema: string; rows: Array<{ id: string }> }
      assert.equal(latency.schema, 'mcp_latency_v0')
      assert.ok(latency.rows.some((row) => row.id === 'mcp'))
      assert.ok(latency.rows.some((row) => row.id === 'wall'))
    }
    assert.equal(buildMcpToolV0(), null)
    _resetRuntimeForTests()
    delete process.env.NETGREENER_SERVICE_RUNTIME
    delete process.env.NETGREENER_TOKEN
    delete process.env.NETGREENER_PROJECT_ID
    delete process.env.NETGREENER_RUNTIME_DRY_RUN
  })
})
