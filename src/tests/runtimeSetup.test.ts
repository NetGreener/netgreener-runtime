import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { loadRuntimeConfig } from '../config.js'
import { inspectRuntimeSetup } from '../runtimeHealth.js'
import { NetGreenerRuntime } from '../runtime.js'
import { _resetOutboundInstrumentationForTests } from '../externalApiMeter.js'
import { runWithTenantContext } from '../tenantContext.js'
import { applyRuntimeControls } from '../runtimeControls.js'

const credentials = { NETGREENER_TOKEN: 'ngs_setup_secret', NETGREENER_PROJECT_ID: '42' }

test('automatic enablement preserves a cached company pause', () => {
  const config = loadRuntimeConfig(credentials)
  applyRuntimeControls(config, false)
  try {
    assert.equal(config.enabled, true)
    assert.equal(new NetGreenerRuntime({ config }).enabled, false)
  } finally {
    applyRuntimeControls(config, true)
  }
})

test('setup inspection is local, credential-free, and does not claim live coverage', () => {
  const originalFetch = globalThis.fetch
  const report = inspectRuntimeSetup({
    ...credentials,
    NETGREENER_API_URL: 'https://user:private-password@example.test/private-path?token=private-query',
  })
  assert.equal(report.ready, true)
  assert.equal(report.scope, 'local_configuration')
  assert.equal(report.lifecycle, 'persistent')
  assert.equal(report.export_mode, 'direct')
  assert.equal(globalThis.fetch, originalFetch)
  assert.deepEqual(report.checks.filter(check => check.status === 'not_verified').map(check => check.name), [
    'hooks', 'tenant_attribution', 'provider_instrumentation', 'upload',
  ])
  for (const secret of [credentials.NETGREENER_TOKEN, 'private-password', 'private-path', 'private-query']) {
    assert.equal(JSON.stringify(report).includes(secret), false)
  }
})

test('setup inspection rejects missing configuration, invalid URLs, and incomplete collector selection', () => {
  for (const env of [
    {},
    { ...credentials, NETGREENER_SERVICE_RUNTIME: '0' },
    { ...credentials, NETGREENER_PROJECT_ID: 'NaN' },
    { ...credentials, NETGREENER_API_URL: 'file:///tmp/config' },
    { ...credentials, NETGREENER_EXPORT_MODE: 'collector' },
    { ...credentials, NETGREENER_EXPORT_MODE: 'collector', NETGREENER_COLLECTOR_ENDPOINT: 'tcp://localhost' },
    { ...credentials, NETGREENER_EXPORT_MODE: 'collector', NETGREENER_COLLECTOR_ENDPOINT: 'tcp://localhost:70000' },
  ]) {
    assert.equal(inspectRuntimeSetup(env).ready, false)
  }
  assert.equal(inspectRuntimeSetup({ ...credentials, VERCEL: '1' }).lifecycle, 'ephemeral')
  assert.equal(inspectRuntimeSetup({ ...credentials, CONTAINER_APP_NAME: 'test' }).lifecycle, 'persistent')
  assert.equal(inspectRuntimeSetup({
    ...credentials, NETGREENER_EXPORT_MODE: 'collector', NETGREENER_COLLECTOR_ENDPOINT: 'tcp://127.0.0.1:4319',
  }).ready, true)
})

test('runtime status CLI reports readiness and fails invalid configuration without leaking credentials', () => {
  const cli = fileURLToPath(new URL('../cli/netgreener.js', import.meta.url))
  const env: NodeJS.ProcessEnv = { ...process.env, ...credentials }
  for (const key of ['NETGREENER_SERVICE_RUNTIME', 'NETGREENER_EXPORT_MODE', 'NETGREENER_API_URL']) delete env[key]
  const result = spawnSync(process.execPath, [cli, 'runtime', 'status', '--json'], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).ready, true)
  assert.equal(result.stdout.includes(credentials.NETGREENER_TOKEN), false)
  const disabled = spawnSync(process.execPath, [cli, 'runtime', 'status', '--json'], {
    env: { ...env, NETGREENER_SERVICE_RUNTIME: '0' }, encoding: 'utf8',
  })
  assert.equal(disabled.status, 1)
  assert.equal(JSON.parse(disabled.stdout).ready, false)
  const invalid = spawnSync(process.execPath, [cli, 'runtime', 'status', '--unknown'], { env, encoding: 'utf8' })
  assert.equal(invalid.status, 2)
})

test('automatic enablement records an attributed runtime window using the existing upload contract', async () => {
  const runtime = new NetGreenerRuntime({
    config: loadRuntimeConfig({ ...credentials, NETGREENER_RUNTIME_DRY_RUN: '1' }),
  })
  try {
    runtime.start()
    assert.equal(runtime.enabled, true)
    runWithTenantContext({ tenantId: 'company-a', tenantSource: 'verified-auth' }, () => {
      runtime.recordHttp({ method: 'GET', path: '/health', statusCode: 200, durationMs: 5, cpuTimeMs: 1 })
    })
    const result = await runtime.flush('manual')
    assert.ok(result?.ok && result.dryRun)
    const body = result.body as { session_metadata: { service_runtime_v0: { by_tenant: Record<string, unknown> } } }
    assert.ok(body.session_metadata.service_runtime_v0.by_tenant['company-a'])
  } finally {
    await runtime.shutdown()
    _resetOutboundInstrumentationForTests()
  }
})
