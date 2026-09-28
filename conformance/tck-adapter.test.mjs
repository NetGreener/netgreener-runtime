import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const adapterPath = fileURLToPath(new URL('./tck-adapter.mjs', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).trim()
const ledgerBytes = await readFile(
  fileURLToPath(new URL('./implementation-ledger.json', import.meta.url)),
)
const ledgerDigest = digest(ledgerBytes)
const typescriptPackage = JSON.parse(
  await readFile(
    fileURLToPath(
      new URL('../node_modules/typescript/package.json', import.meta.url),
    ),
    'utf8',
  ),
)

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function currentEnvironment(overrides = {}) {
  return {
    environment_id: 'nodejs-adapter-test',
    runtime: 'Node.js',
    runtime_version: process.versions.node,
    toolchain_versions: [`typescript==${typescriptPackage.version}`],
    os: process.platform,
    architecture: process.arch,
    deployment_mode:
      process.env.TF_BUILD?.trim().toLowerCase() === 'true'
        ? 'azure-pipelines'
        : 'local',
    framework: null,
    ...overrides,
  }
}

function input(value) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  return {
    digest: digest(bytes),
    media_type: 'application/json',
    content_base64: bytes.toString('base64'),
  }
}

function request({
  actionId,
  actionVersion = '1.0.0',
  caseId,
  inputs,
  environment = currentEnvironment(),
}) {
  return {
    schema_name: 'netgreener.tck_adapter_request.v1',
    schema_version: 1,
    protocol_version: '1.0.0',
    request_id: 'tckq_12345678-1234-4123-8123-123456789abc',
    contract_bundle_id:
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    catalog_version: '1.0.2',
    tck_version: '0.3.0',
    target: {
      target_id: 'nodejs.runtime',
      profile_id: 'nodejs.runtime',
      profile_digest:
        'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      environment_id: environment.environment_id,
      declared_environment: environment,
    },
    implementation: {
      id: 'netgreener-node-runtime',
      version: '0.1.0',
      source_revision: sourceRevision,
      artifact: {
        uri: 'conformance/implementation-ledger.json',
        digest: ledgerDigest,
        media_type: 'application/json',
      },
    },
    adapter: {
      id: 'netgreener-node-tck-adapter',
      version: '0.1.0',
      artifact_digest:
        'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    },
    case: {
      case_id: caseId,
      kind: inputs.length === 1 ? 'single' : 'pair',
      action: {
        action_id: actionId,
        action_version: actionVersion,
      },
      inputs,
    },
  }
}

async function invokeProcess(payload, extraEnvironment = {}) {
  const child = spawn(process.execPath, [adapterPath], {
    env: { ...process.env, ...extraEnvironment },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  child.stdin.end(JSON.stringify(payload))
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  return { exitCode, stdout, stderr }
}

async function invoke(payload, extraEnvironment = {}) {
  const { exitCode, stdout, stderr } = await invokeProcess(
    payload,
    extraEnvironment,
  )
  assert.equal(exitCode, 0, stderr)
  return JSON.parse(stdout)
}

test('adapter derives the observed Node/OS/architecture environment', async () => {
  const actual = currentEnvironment()
  const declared = currentEnvironment({
    deployment_mode: 'caller-claimed-ci',
    framework: 'express',
  })
  const response = await invoke(
    request({
      actionId: 'observation.validate',
      caseId: 'TCK-ENV-001',
      inputs: [input({})],
      environment: declared,
    }),
    {
      NETGREENER_TCK_DEPLOYMENT_MODE: 'caller-claimed-ci',
      NETGREENER_TCK_FRAMEWORK: 'express',
    },
  )

  assert.equal(response.execution_status, 'error')
  assert.equal(response.execution_code, 'ADAPTER_EXECUTION_ERROR')
  assert.equal(response.observed_environment.runtime_version, process.versions.node)
  assert.deepEqual(response.observed_environment.toolchain_versions, [
    `typescript==${typescriptPackage.version}`,
  ])
  assert.equal(response.observed_environment.os, process.platform)
  assert.equal(response.observed_environment.architecture, process.arch)
  assert.equal(
    response.observed_environment.deployment_mode,
    actual.deployment_mode,
  )
  assert.equal(response.observed_environment.framework, null)
  assert.notDeepEqual(response.observed_environment, declared)
})

test('missing production Observation v1 validator is reported unsupported', async () => {
  const first = await invoke(
    request({
      actionId: 'observation.validate',
      caseId: 'TCK-OBS-A',
      inputs: [input({ arbitrary: 'first' })],
    }),
  )
  const second = await invoke(
    request({
      actionId: 'observation.validate',
      caseId: 'TCK-OBS-B',
      inputs: [input({ arbitrary: 'different' })],
    }),
  )

  for (const response of [first, second]) {
    assert.equal(response.execution_status, 'unsupported')
    assert.equal(response.execution_code, 'ADAPTER_ACTION_UNSUPPORTED')
    assert.equal(response.observed, null)
  }
})

test('missing production delivery classifier is reported unsupported', async () => {
  const response = await invoke(
    request({
      actionId: 'delivery.classify',
      caseId: 'TCK-DELIVERY-A',
      inputs: [input({ identity: 'same' }), input({ identity: 'same' })],
    }),
  )

  assert.equal(response.execution_status, 'unsupported')
  assert.equal(response.execution_code, 'ADAPTER_ACTION_UNSUPPORTED')
  assert.equal(response.observed, null)
})

test('adapter refuses an implementation artifact other than its tracked ledger', async () => {
  const payload = request({
    actionId: 'observation.validate',
    caseId: 'TCK-LEDGER-BINDING',
    inputs: [input({})],
  })
  payload.implementation.artifact.digest =
    'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'

  const result = await invokeProcess(payload)
  assert.equal(result.exitCode, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /not the adjacent tracked ledger/)
})

test('unknown action versions are unsupported without inspecting case identity', async () => {
  const response = await invoke(
    request({
      actionId: 'observation.validate',
      actionVersion: '9.9.9',
      caseId: 'TCK-UNKNOWN-ACTION',
      inputs: [input({})],
    }),
  )

  assert.equal(response.execution_status, 'unsupported')
  assert.equal(response.execution_code, 'ADAPTER_ACTION_UNSUPPORTED')
})
