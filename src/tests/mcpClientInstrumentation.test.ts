import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { runWithExecution, currentExecutionContext, newExecutionContext, EXECUTION_CARRIER_KEY, type ExecutionContext } from '../requestContext.js'
import { ExternalApiAggregator } from '../externalApiMeter.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { loadRuntimeConfig } from '../config.js'
import { refreshRuntimeControls } from '../runtimeControls.js'
import {
  _resetMcpToolMeterForTests, activeMcpToolCallId, buildMcpToolV0,
  installMcpClientInstrumentation, McpToolBudgetBlocked, recordHttpInToolContext,
} from '../mcpToolMeter.js'

// Real SDK protocol/transport test; only the application tool handler is controlled.
describe('official MCP SDK client instrumentation', () => {
  const connections: Array<{ close(): Promise<void> }> = []
  const invoked: string[] = []
  const serverSteps: ExecutionContext[] = []
  let linkedUsage = new ExternalApiAggregator()

  async function connect(ClientType = Client, serverName = 'integration-server'): Promise<Client> {
    const server = new Server({ name: serverName, version: '1' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      invoked.push(params.name)
      if (params.name === 'attributed') runWithExecution({ carrier: params._meta?.[EXECUTION_CARRIER_KEY], boundary: true }, () => {
        serverSteps.push(currentExecutionContext()!)
        linkedUsage.record({ host: 'api.openai.com', inputTokens: 4, executionContext: newExecutionContext() })
      })
      if (params.name === 'throw') throw new Error('private-server-error')
      if (params.name === 'slow') await new Promise((resolve) => setTimeout(resolve, 20))
      return { content: [{ type: 'text' as const, text: 'private-result' }], isError: params.name === 'error' }
    })
    const client = new ClientType({ name: 'integration-client', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    connections.push(client, server)
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    return client
  }

  beforeEach(async () => {
    _resetMcpToolMeterForTests()
    invoked.length = 0
    serverSteps.length = 0
    linkedUsage = new ExternalApiAggregator()
    assert.equal(await installMcpClientInstrumentation(), true)
  })

  afterEach(async () => {
    await Promise.all(connections.splice(0).map((connection) => connection.close()))
    for (const key of ['NETGREENER_MCP_MAX_CALLS', 'NETGREENER_MCP_MAX_REPEATS', 'NETGREENER_MCP_BUDGET_MODE', 'NETGREENER_EXECUTION_PROPAGATION']) delete process.env[key]
    _resetMcpToolMeterForTests()
  })

  it('propagates execution identity over the actual MCP protocol only when enabled', async () => {
    const client = await connect()
    process.env.NETGREENER_EXECUTION_PROPAGATION = '1'
    await runWithExecution({ executionId: 'a'.repeat(32) }, async () => {
      const root = currentExecutionContext()!
      await client.callTool({ name: 'attributed' })
      const tool = (buildMcpToolV0()!.calls as Array<{ execution_context: ExecutionContext }>)[0].execution_context
      assert.equal(tool.parent_step_id, root.step_id)
      assert.equal(serverSteps[0].parent_step_id, tool.step_id)
      const api = linkedUsage.buildV0()!.execution_calls_v1!.calls[0]
      assert.equal(api.execution_context.execution_id, root.execution_id)
      assert.equal(api.execution_context.parent_step_id, serverSteps[0].step_id)
      assert.equal(currentExecutionContext(), root)
    })
    delete process.env.NETGREENER_EXECUTION_PROPAGATION
    await client.callTool({ name: 'attributed' })
    assert.equal(serverSteps[1].link_state, 'missing')
    assert.equal(currentExecutionContext(), null)
  })

  it('preserves results, captures tool/protocol failures, and excludes private payloads', async () => {
    const client = await connect()
    await client.listTools()
    assert.equal(buildMcpToolV0(), null)
    const result = await client.callTool({ name: 'ok', arguments: { secret: 'private-argument' } })
    assert.deepEqual(result.content, [{ type: 'text', text: 'private-result' }])
    assert.equal((await client.callTool({ name: 'error' })).isError, true)
    await assert.rejects(client.callTool({ name: 'throw' }), /private-server-error/)
    const ledger = buildMcpToolV0()!
    const rows = ledger.calls as Array<{ server: string; success: boolean; invoked: boolean; duration_ms: number }>
    assert.deepEqual(rows.map((row) => row.success), [true, false, false])
    assert.ok(rows.every((row) => row.server === 'integration-server' && row.invoked && row.duration_ms >= 0))
    assert.doesNotMatch(JSON.stringify(ledger), /private-|secret/)
    assert.equal(activeMcpToolCallId(), null)
  })

  it('applies dashboard policy before actual MCP transport invocation', async () => {
    const client = await connect()
    const config = loadRuntimeConfig({ NETGREENER_SERVICE_RUNTIME: '1', NETGREENER_TOKEN: 'mcp-dashboard-protocol',
      NETGREENER_PROJECT_ID: '1', NETGREENER_ORG_ID: '7', NETGREENER_API_URL: 'https://example.test' })
    const policy = async (mode: 'warn' | 'block' | null) => refreshRuntimeControls(config,
      (async () => new Response(JSON.stringify({ org_id: 7, metering_enabled: true,
        mcp_budget_mode: mode, mcp_max_calls: mode === null ? null : 0, mcp_max_repeats: null }))) as typeof fetch)
    try {
      await policy('warn')
      await client.callTool({ name: 'ok' })
      await policy('block')
      await assert.rejects(client.callTool({ name: 'blocked' }), McpToolBudgetBlocked)
      assert.deepEqual(invoked, ['ok'])
      const rows = buildMcpToolV0()!.calls as Array<{ budget_action: string; invoked: boolean }>
      assert.deepEqual(rows.map(row => row.budget_action), ['warn', 'block'])
      assert.equal(rows[1].invoked, false)
    } finally {
      await policy(null)
    }
  })

  it('shares limits across clients, warns by default, and blocks before transport invocation', async () => {
    const first = await connect()
    const second = await connect()
    process.env.NETGREENER_MCP_MAX_CALLS = '1'
    await first.callTool({ name: 'ok' })
    await second.callTool({ name: 'ok' })
    process.env.NETGREENER_MCP_BUDGET_MODE = 'block'
    await assert.rejects(second.callTool({ name: 'ok' }), McpToolBudgetBlocked)
    assert.deepEqual(invoked, ['ok', 'ok'])
    const rows = buildMcpToolV0()!.calls as Array<{ budget_action: string; invoked: boolean; attempt: number }>
    assert.deepEqual(rows.map((row) => row.budget_action), ['allow', 'warn', 'block'])
    assert.deepEqual(rows.map((row) => row.attempt), [1, 2, 3])
    assert.equal(rows[2].invoked, false)
    assert.equal(activeMcpToolCallId(), null)
  })

  it('patches ESM and CommonJS clients once and isolates concurrent calls', async () => {
    assert.equal(await installMcpClientInstrumentation(), true)
    const cjs = createRequire(import.meta.url)('@modelcontextprotocol/sdk/client/index.js')
    const first = await connect()
    const second = await connect(cjs.Client, 'second-server')
    await Promise.all([first.callTool({ name: 'slow' }), second.callTool({ name: 'ok' })])
    const rows = buildMcpToolV0()!.calls as Array<{ call_id: string; server: string }>
    assert.equal(rows.length, 2)
    assert.equal(new Set(rows.map((row) => row.call_id)).size, 2)
    assert.deepEqual(rows.map((row) => row.server).sort(), ['integration-server', 'second-server'])
    assert.equal(activeMcpToolCallId(), null)
  })

  it('cleans up call context after cancellation', async () => {
    const client = await connect()
    const abort = new AbortController()
    const pending = client.callTool({ name: 'slow' }, undefined, { signal: abort.signal })
    abort.abort(new Error('private-cancel-reason'))
    await assert.rejects(pending)
    const rows = buildMcpToolV0()!.calls as Array<{ success: boolean }>
    assert.equal(rows.length, 1)
    assert.equal(rows[0].success, false)
    assert.equal(activeMcpToolCallId(), null)
    assert.doesNotMatch(JSON.stringify(rows), /private-cancel/)
  })

  it('observes a real stdio server without storing transport arguments or results', async () => {
    const source = `
      import { Server } from '@modelcontextprotocol/sdk/server/index.js';
      import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
      import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
      const server = new Server({ name: 'stdio-integration', version: '1' }, { capabilities: { tools: {} } });
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'private-stdio-result' }] }));
      await server.connect(new StdioServerTransport());
    `
    const client = new Client({ name: 'stdio-client', version: '1' })
    connections.push(client)
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ['--input-type=module', '-e', source], stderr: 'pipe',
    }))
    await client.callTool({ name: 'lookup', arguments: { secret: 'private-stdio-argument' } })
    const ledger = buildMcpToolV0()!
    const rows = ledger.calls as Array<{ server: string; success: boolean }>
    assert.equal(rows.length, 1)
    assert.equal(rows[0].server, 'stdio-integration')
    assert.equal(rows[0].success, true)
    assert.doesNotMatch(JSON.stringify(ledger), /private-|secret|input-type|execPath/)
    assert.equal(ledger.http_in_context, undefined)
  })

  it('awaits optional hook installation in auto startup and respects disabled runtime', () => {
    const autoUrl = new URL('../auto.js', import.meta.url).href
    for (const enabled of ['0', '1']) {
      const source = `
        import ${JSON.stringify(autoUrl)};
        import { Client } from '@modelcontextprotocol/sdk/client/index.js';
        const active = Boolean(Client.prototype.callTool[Symbol.for('netgreener.mcp.callTool.wrapped')]);
        if (active !== ${enabled === '1'}) throw new Error('Unexpected MCP hook activation');
        process.exit(0);
      `
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        encoding: 'utf8', timeout: 15000,
        env: { ...process.env, NETGREENER_SERVICE_RUNTIME: enabled, NETGREENER_TOKEN: 'ngs_test',
          NETGREENER_PROJECT_ID: '1', NETGREENER_RUNTIME_DRY_RUN: '1' },
      })
      assert.equal(result.status, 0, result.stderr)
    }
  })

  it('declines unsupported or unreadable SDK metadata without patching the client', () => {
    const meterUrl = new URL('../mcpToolMeter.js', import.meta.url).href
    for (const mode of ['unsupported', 'unreadable']) {
      const source = `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        import { Client } from '@modelcontextprotocol/sdk/client/index.js';
        const original = fs.readFileSync;
        fs.readFileSync = function(path, ...args) {
          if (String(path).replaceAll('\\\\', '/').endsWith('/sdk/package.json')) {
            if (${JSON.stringify(mode)} === 'unreadable') throw new Error('SDK metadata unavailable');
            return JSON.stringify({ version: '99.0.0' });
          }
          return original.call(this, path, ...args);
        };
        syncBuiltinESMExports();
        const { installMcpClientInstrumentation, buildMcpToolV0 } = await import(${JSON.stringify(meterUrl)});
        if (await installMcpClientInstrumentation()) throw new Error('Unsupported SDK was accepted');
        if (Client.prototype.callTool[Symbol.for('netgreener.mcp.callTool.wrapped')]) throw new Error('Client was patched');
        if (buildMcpToolV0() !== null) throw new Error('Manufactured observation');
      `
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        encoding: 'utf8', timeout: 15000,
      })
      assert.equal(result.status, 0, result.stderr)
    }
  })

  it('keeps nested calls and same-process HTTP context separate', async () => {
    const inner = await connect()
    const client = await connect()
    const ids: string[] = []
    // Execute nested application work at the SDK request boundary, inside callTool's scope.
    client.request = new Proxy(client.request, {
      async apply(target, receiver, args) {
        const outerId = activeMcpToolCallId()
        assert.ok(outerId)
        ids.push(outerId)
        await inner.callTool({ name: 'ok' })
        assert.equal(activeMcpToolCallId(), outerId)
        recordHttpInToolContext({ toolCallId: outerId, host: 'api.example.test', durationMs: 2, error: false })
        return Reflect.apply(target, receiver, args)
      },
    })
    await client.callTool({ name: 'ok' })
    const ledger = buildMcpToolV0()!
    const rows = ledger.calls as Array<{ call_id: string }>
    assert.equal(rows.length, 2)
    assert.notEqual(rows[0].call_id, ids[0])
    assert.equal(rows[1].call_id, ids[0])
    assert.equal((ledger.http_in_context as Array<{ tool_call_id: string }>)[0].tool_call_id, ids[0])
    assert.equal(activeMcpToolCallId(), null)
  })
})
