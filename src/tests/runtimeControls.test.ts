import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadRuntimeConfig } from '../config.js'
import { NetGreenerRuntime } from '../runtime.js'
import { applyRuntimeControls, meteringAllowed, refreshRuntimeControls, runtimeWindowIntervalMs, startRuntimeControls } from '../runtimeControls.js'
import { getExternalAggregator } from '../externalApiMeter.js'
import { getMcpToolLedger } from '../mcpToolMeter.js'
import { uploadRunSession, type RunSessionCreatePayload } from '../uploader.js'

const config = loadRuntimeConfig({ NETGREENER_SERVICE_RUNTIME: '1', NETGREENER_TOKEN: 'controls-test', NETGREENER_PROJECT_ID: '1', NETGREENER_ORG_ID: '7', NETGREENER_API_URL: 'https://example.test' })

test('one-minute default and validated organization interval override retain local fallback', async () => {
  assert.equal(loadRuntimeConfig({}).flushIntervalMs, 60_000)
  const local = { ...config, token: 'interval-test', flushIntervalMs: 300_000 }
  const policy = async (value: unknown, orgId = 7) => refreshRuntimeControls(local,
    (async () => new Response(JSON.stringify({ org_id: orgId, metering_enabled: true, runtime_window_seconds: value }))) as typeof fetch)
  assert.equal(runtimeWindowIntervalMs(local), 300_000)
  await policy(30)
  assert.equal(runtimeWindowIntervalMs(local), 30_000)
  for (const invalid of [true, '60', 29, 86401, 60.5]) {
    await policy(invalid)
    assert.equal(runtimeWindowIntervalMs(local), 30_000)
  }
  await policy(120, 8)
  assert.equal(runtimeWindowIntervalMs(local), 30_000)
  await refreshRuntimeControls(local, (async () => { throw new Error('offline') }) as typeof fetch)
  assert.equal(runtimeWindowIntervalMs(local), 30_000)
  assert.equal(runtimeWindowIntervalMs({ ...local, organizationId: 8 }), 300_000)
  await policy(null)
  assert.equal(runtimeWindowIntervalMs(local), 300_000)
})

test('canonical organization default overrides differing local reporting intervals', async () => {
  for (const flushIntervalMs of [60_000, 300_000]) {
    const local = { ...config, token: `canonical-${flushIntervalMs}`, flushIntervalMs }
    await refreshRuntimeControls(local, (async () => new Response(JSON.stringify({ org_id: 7, metering_enabled: true, runtime_window_seconds: null, effective_runtime_window_seconds: 60 }))) as typeof fetch)
    assert.equal(runtimeWindowIntervalMs(local), 60_000)
  }
})

test('ephemeral interval timer runs only while invocations are active', (t) => {
  const timers = new Map<object, { callback: () => void; milliseconds: number }>()
  t.mock.method(globalThis, 'setInterval', ((callback: () => void, milliseconds: number) => {
    const handle = { unref() {} }
    timers.set(handle, { callback, milliseconds })
    return handle
  }) as typeof setInterval)
  t.mock.method(globalThis, 'clearInterval', ((handle: object) => { timers.delete(handle) }) as typeof clearInterval)
  const runtime = new NetGreenerRuntime({ config: { ...config, dryRun: true }, runtimeMode: 'ephemeral' })
  const flush = t.mock.method(runtime, 'flush', async () => null)
  try {
    runtime.start()
    assert.equal(timers.size, 0)
    runtime.beginRequest()
    runtime.beginRequest()
    assert.equal(timers.size, 1)
    const timer = [...timers.values()][0]
    assert.equal(timer.milliseconds, 60_000)
    timer.callback()
    assert.equal(flush.mock.callCount(), 1)
    runtime.endRequest({ deferInvokeFlush: true })
    assert.equal(timers.size, 1)
    runtime.endRequest({ deferInvokeFlush: true })
    assert.equal(timers.size, 0)
  } finally { runtime.stop() }
})

test('running persistent runtime reschedules windows and unsubscribes when stopped', async (t) => {
  const local = { ...config, token: 'running-interval-test' }
  const callbacks = new Map<object, { callback: () => void; milliseconds: number }>()
  t.mock.method(globalThis, 'setInterval', ((callback: () => void, milliseconds: number) => {
    const handle = { unref() {} }
    callbacks.set(handle, { callback, milliseconds })
    return handle
  }) as typeof setInterval)
  t.mock.method(globalThis, 'clearInterval', ((handle: object) => { callbacks.delete(handle) }) as typeof clearInterval)
  const runtime = new NetGreenerRuntime({ config: local, runtimeMode: 'persistent' })
  const flush = t.mock.method(runtime, 'flush', async () => null)
  const policy = async (seconds: number | null) => refreshRuntimeControls(local,
    (async () => new Response(JSON.stringify({ org_id: 7, metering_enabled: true, runtime_window_seconds: seconds }))) as typeof fetch)
  try {
    runtime.start()
    assert.ok([...callbacks.values()].some(timer => timer.milliseconds === 60_000))
    await policy(120)
    assert.ok([...callbacks.values()].some(timer => timer.milliseconds === 120_000))
    assert.ok(![...callbacks.values()].some(timer => timer.milliseconds === 60_000))
    const callback = [...callbacks.values()].find(timer => timer.milliseconds === 120_000)!.callback
    callback()
    assert.equal(flush.mock.callCount(), 1)
    await policy(null)
    assert.ok([...callbacks.values()].some(timer => timer.milliseconds === 60_000))
    runtime.stop()
    await policy(300)
    assert.ok(![...callbacks.values()].some(timer => timer.milliseconds === 300_000))
  } finally {
    runtime.stop()
  }
})

test('clearing shared organization policy restores each runtime local interval', async () => {
  const first = { ...config, token: 'shared-interval-test', flushIntervalMs: 60_000 }
  const second = { ...first, projectId: 2, flushIntervalMs: 300_000 }
  const seenFirst: number[] = []
  const seenSecond: number[] = []
  const offline = (async () => { throw new Error('offline') }) as typeof fetch
  const stopFirst = startRuntimeControls(first, offline, undefined, milliseconds => seenFirst.push(milliseconds))
  const stopSecond = startRuntimeControls(second, offline, undefined, milliseconds => seenSecond.push(milliseconds))
  try {
    for (const seconds of [30, null]) {
      await refreshRuntimeControls(first, (async () => new Response(JSON.stringify({ org_id: 7, metering_enabled: true, runtime_window_seconds: seconds }))) as typeof fetch)
    }
    assert.deepEqual(seenFirst, [30_000, 60_000])
    assert.deepEqual(seenSecond, [30_000, 300_000])
  } finally {
    stopFirst()
    stopSecond()
  }
})

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
