import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadRuntimeConfig } from '../config.js'
import { NetGreenerRuntime } from '../runtime.js'
import { applyRuntimeControls, meteringAllowed, refreshRuntimeControls } from '../runtimeControls.js'
import { getExternalAggregator } from '../externalApiMeter.js'
import { getMcpToolLedger } from '../mcpToolMeter.js'
import { uploadRunSession, type RunSessionCreatePayload } from '../uploader.js'

const config = loadRuntimeConfig({ NETGREENER_SERVICE_RUNTIME: '1', NETGREENER_TOKEN: 'controls-test', NETGREENER_PROJECT_ID: '1', NETGREENER_ORG_ID: '7', NETGREENER_API_URL: 'https://example.test' })

test('company pause gates recording and upload and resumes after valid policy', async () => {
  const runtime = new NetGreenerRuntime({ config })
  applyRuntimeControls(config, false)
  try {
    assert.equal(runtime.enabled, false)
    runtime.recordHttp({ method: 'GET', path: '/test', statusCode: 200, durationMs: 10 })
    assert.equal(await runtime.flush(), null)
    const external = getExternalAggregator()
    external.clear()
    external.record({ host: 'api.openai.com', durationMs: 10 })
    assert.equal(external.hasData(), true) // Pure replay must preserve stored evidence.
    external.clear()
    const decision = getMcpToolLedger().beginToolCall('server', 'tool')
    assert.equal(decision.action, 'allow')
    let requests = 0
    const fetchImpl = (async () => { requests += 1; return new Response('{}', { status: 500 }) }) as typeof fetch
    const payload: RunSessionCreatePayload = {
      project_id: 1, start_time: new Date().toISOString(), end_time: new Date().toISOString(), runtime_window_id: 'rtw_' + 'a'.repeat(64),
      session_metadata: { service_runtime_v0: { framework: 'express', collector: 'express_middleware', window_seconds: 60, attribution: 'cpu_share', accuracy: 'trend', units: [] } },
    }
    const result = await uploadRunSession(config, payload, fetchImpl)
    assert.equal(result.ok, false)
    assert.equal(requests, 0)
    await refreshRuntimeControls(config, fetchImpl)
    assert.equal(meteringAllowed(config), false)
    const restore = (async () => new Response(JSON.stringify({ org_id: 7, metering_enabled: true }))) as typeof fetch
    await refreshRuntimeControls(config, restore)
    assert.equal(runtime.enabled, true)
    runtime.recordHttp({ method: 'GET', path: '/test', statusCode: 200, durationMs: 10 })
  } finally {
    applyRuntimeControls(config, true)
  }
})

test('policy ignores another company and keeps company caches isolated', async () => {
  const other = { ...config, organizationId: 8 }
  applyRuntimeControls(config, false)
  try {
    assert.equal(meteringAllowed(other), true)
    await refreshRuntimeControls(config, (async () => new Response(JSON.stringify({ org_id: 8, metering_enabled: true }))) as typeof fetch)
    assert.equal(meteringAllowed(config), false)
  } finally {
    applyRuntimeControls(config, true)
  }
})


test('opaque service tokens learn organization routing from a paused upload', async () => {
  const opaque = { ...config, organizationId: null, token: 'ngs_opaque-controls' }
  applyRuntimeControls(opaque, false, 7)
  try {
    const seen: string[] = []
    await refreshRuntimeControls(opaque, (async (url: string | URL | Request) => {
      seen.push(String(url))
      return new Response(JSON.stringify({ org_id: 7, metering_enabled: true }))
    }) as typeof fetch)
    assert.match(seen[0], /organizations\/7\/runtime-controls$/)
    assert.equal(meteringAllowed(opaque), true)
  } finally {
    applyRuntimeControls(opaque, true)
  }
})
