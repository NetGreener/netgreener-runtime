#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PROTOCOL_VERSION = '1.0.0'
const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url))
const IMPLEMENTATION_LEDGER_URI = 'conformance/implementation-ledger.json'
// A pair request can carry two schema-valid 8 MiB base64 fields plus envelope data.
const MAX_REQUEST_BYTES = 20 * 1024 * 1024

const actionBoundaries = new Map([
  [
    'observation.validate@1.0.0',
    {
      exportName: 'validateObservationEnvelope',
      async invoke(boundary, inputs) {
        const document = decodeJsonInput(inputs, 1)[0]
        const result = await boundary(document)
        if (
          !result ||
          typeof result !== 'object' ||
          typeof result.accepted !== 'boolean' ||
          !Array.isArray(result.errorCodes)
        ) {
          throw new Error('production observation validator returned an invalid result')
        }
        return {
          outcome: result.accepted ? 'accept' : 'reject',
          error_codes: normalizeErrorCodes(result.errorCodes),
        }
      },
    },
  ],
  [
    'delivery.classify@1.0.0',
    {
      exportName: 'classifyObservationDelivery',
      async invoke(boundary, inputs) {
        const [first, second] = decodeJsonInput(inputs, 2)
        const result = await boundary(first, second)
        if (
          !result ||
          typeof result !== 'object' ||
          !['duplicate', 'conflict'].includes(result.classification) ||
          !Array.isArray(result.errorCodes)
        ) {
          throw new Error('production delivery classifier returned an invalid result')
        }
        return {
          outcome: result.classification,
          error_codes: normalizeErrorCodes(result.errorCodes),
        }
      },
    },
  ],
])

function normalizeErrorCodes(values) {
  if (!values.every((value) => typeof value === 'string')) {
    throw new Error('production boundary error codes must be strings')
  }
  return [...new Set(values)].sort()
}

function decodeJsonInput(inputs, expectedCount) {
  if (!Array.isArray(inputs) || inputs.length !== expectedCount) {
    throw new Error(`action requires exactly ${expectedCount} input(s)`)
  }
  return inputs.map((input) => {
    if (
      !input ||
      typeof input !== 'object' ||
      input.media_type !== 'application/json' ||
      typeof input.content_base64 !== 'string' ||
      typeof input.digest !== 'string'
    ) {
      throw new Error('adapter input is not a digest-bound JSON document')
    }
    const bytes = Buffer.from(input.content_base64, 'base64')
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    if (digest !== input.digest) {
      throw new Error('adapter input digest does not match its exact decoded bytes')
    }
    return JSON.parse(bytes.toString('utf8'))
  })
}

async function actualEnvironment(request) {
  const environmentId = request?.target?.environment_id
  if (typeof environmentId !== 'string') {
    throw new Error('request target environment_id is missing')
  }
  const typescriptPackage = JSON.parse(
    await readFile(
      new URL('../node_modules/typescript/package.json', import.meta.url),
      'utf8',
    ),
  )
  return {
    environment_id: environmentId,
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
  }
}

function baseResponse(request, observedEnvironment) {
  return {
    schema_name: 'netgreener.tck_adapter_response.v1',
    schema_version: 1,
    protocol_version: request.protocol_version,
    request_id: request.request_id,
    contract_bundle_id: request.contract_bundle_id,
    target_id: request.target.target_id,
    profile_id: request.target.profile_id,
    environment_id: request.target.environment_id,
    observed_environment: observedEnvironment,
    implementation_artifact_digest: request.implementation.artifact.digest,
    adapter: request.adapter,
    case_id: request.case.case_id,
  }
}

async function boundLedgerAction(request, action) {
  if (
    request.implementation?.artifact?.uri !== IMPLEMENTATION_LEDGER_URI ||
    request.implementation?.artifact?.media_type !== 'application/json'
  ) {
    throw new Error('request implementation artifact is not the tracked ledger')
  }
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  }).trim()
  if (request.implementation?.source_revision !== sourceRevision) {
    throw new Error('request implementation revision is not the local Git HEAD')
  }
  const ledgerUrl = new URL('./implementation-ledger.json', import.meta.url)
  const ledgerBytes = await readFile(ledgerUrl)
  const ledgerDigest = `sha256:${createHash('sha256')
    .update(ledgerBytes)
    .digest('hex')}`
  if (ledgerDigest !== request.implementation.artifact.digest) {
    throw new Error(
      'request implementation artifact is not the adjacent tracked ledger',
    )
  }
  const ledger = JSON.parse(ledgerBytes.toString('utf8'))
  if (ledger.implementation_id !== request.implementation.id) {
    throw new Error('implementation ledger identity does not match the request')
  }
  const ledgerAction = ledger.tck_action_boundaries?.find(
    (candidate) =>
      candidate.action_id === action?.action_id &&
      candidate.action_version === action?.action_version,
  )
  if (ledgerAction?.status === 'implemented') {
    const modulePath = ledgerAction.production_module
    const resolvedModule = resolveProductionModule(modulePath)
    let committedModule
    try {
      committedModule = execFileSync(
        'git',
        ['show', `${sourceRevision}:${modulePath}`],
        { cwd: REPOSITORY_ROOT, encoding: null },
      )
    } catch {
      throw new Error(
        'implemented production module is not tracked at the requested Git revision',
      )
    }
    const workingModule = await readFile(resolvedModule)
    if (!workingModule.equals(committedModule)) {
      throw new Error(
        'implemented production module bytes differ from the tracked Git blob',
      )
    }
  }
  return ledgerAction
}

function resolveProductionModule(modulePath) {
  if (typeof modulePath !== 'string' || modulePath.includes('\\')) {
    throw new Error('implemented ledger action has an unsafe production module')
  }
  const resolved = path.resolve(REPOSITORY_ROOT, modulePath)
  const relative = path.relative(REPOSITORY_ROOT, resolved).split(path.sep).join('/')
  if (
    path.isAbsolute(modulePath) ||
    relative !== modulePath ||
    relative.startsWith('../')
  ) {
    throw new Error('implemented ledger action has an unsafe production module')
  }
  return resolved
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

async function readRequest() {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > MAX_REQUEST_BYTES) {
      throw new Error('adapter request exceeds the 20 MiB input limit')
    }
    chunks.push(chunk)
  }
  if (size === 0) throw new Error('adapter request is empty')
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function main() {
  const request = await readRequest()
  if (
    request?.schema_name !== 'netgreener.tck_adapter_request.v1' ||
    request?.schema_version !== 1 ||
    request?.protocol_version !== PROTOCOL_VERSION
  ) {
    throw new Error('unsupported or malformed TCK adapter request')
  }

  const observedEnvironment = await actualEnvironment(request)
  const base = baseResponse(request, observedEnvironment)
  if (!sameJson(observedEnvironment, request.target.declared_environment)) {
    return {
      ...base,
      execution_status: 'error',
      execution_code: 'ADAPTER_EXECUTION_ERROR',
      observed: null,
    }
  }

  const action = request.case?.action
  const ledgerAction = await boundLedgerAction(request, action)
  const actionKey = `${action?.action_id}@${action?.action_version}`
  const actionBoundary = actionBoundaries.get(actionKey)
  if (!actionBoundary) {
    return {
      ...base,
      execution_status: 'unsupported',
      execution_code: 'ADAPTER_ACTION_UNSUPPORTED',
      observed: null,
    }
  }

  if (!ledgerAction || ledgerAction.status !== 'implemented') {
    return {
      ...base,
      execution_status: 'unsupported',
      execution_code: 'ADAPTER_ACTION_UNSUPPORTED',
      observed: null,
    }
  }
  if (
    ledgerAction.production_export !== actionBoundary.exportName ||
    typeof ledgerAction.production_module !== 'string'
  ) {
    throw new Error('implemented ledger action has an invalid production boundary')
  }

  const production = await import(
    pathToFileURL(resolveProductionModule(ledgerAction.production_module)).href
  )
  const boundary = production[actionBoundary.exportName]
  if (typeof boundary !== 'function') {
    return {
      ...base,
      execution_status: 'unsupported',
      execution_code: 'ADAPTER_ACTION_UNSUPPORTED',
      observed: null,
    }
  }

  try {
    const observed = await actionBoundary.invoke(
      boundary,
      request.case.inputs,
    )
    return {
      ...base,
      execution_status: 'completed',
      execution_code: null,
      observed,
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return {
      ...base,
      execution_status: 'error',
      execution_code: 'ADAPTER_EXECUTION_ERROR',
      observed: null,
    }
  }
}

try {
  const response = await main()
  process.stdout.write(`${JSON.stringify(response)}\n`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 2
}
