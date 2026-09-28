import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import {
  configReady,
  DEFAULT_ESTIMATE_TDP_WATTS,
  DEFAULT_RUNTIME_FLUSH_MINUTES,
  loadRuntimeConfig,
  MAX_ESTIMATE_TDP_WATTS,
  MAX_RUNTIME_FLUSH_MINUTES,
  MIN_ESTIMATE_TDP_WATTS,
  MIN_RUNTIME_FLUSH_MINUTES,
  type RuntimeConfig,
} from '../config.js'
import { DEFAULT_TENANT_RUNTIME_FIELDS } from '../tenantDefaults.js'

assert.equal(
  MAX_ESTIMATE_TDP_WATTS,
  10_000,
  'committed Node v0 TDP ceiling is 10_000 W; do not silently adopt a 2000 test literal',
)

function readyConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    enabled: true,
    apiUrl: 'https://example.test',
    token: 'token',
    projectId: 42,
    organizationId: 7,
    flushIntervalMs: DEFAULT_RUNTIME_FLUSH_MINUTES * 60 * 1000,
    dryRun: true,
    deployEnvironment: null,
    releaseTag: null,
    estimateTdpWatts: DEFAULT_ESTIMATE_TDP_WATTS,
    ...DEFAULT_TENANT_RUNTIME_FIELDS,
    ...overrides,
  }
}

const ENV_KEYS_TOUCHED = [
  'NETGREENER_SERVICE_RUNTIME',
  'NETGREENER_API_URL',
  'NETGREENER_TOKEN',
  'NETGREENER_PROJECT_ID',
  'NETGREENER_ORG_ID',
  'NETGREENER_RUNTIME_FLUSH_MINUTES',
  'NETGREENER_RUNTIME_DRY_RUN',
  'NETGREENER_DEPLOY_ENVIRONMENT',
  'DEPLOY_ENV',
  'NETGREENER_RELEASE_TAG',
  'GIT_SHA',
  'NETGREENER_ESTIMATE_TDP_WATTS',
  'NETGREENER_TENANT_SOURCE',
  'NETGREENER_TENANT_CLAIM',
  'NETGREENER_TENANT_HEADER',
  'NETGREENER_TENANT_PATH_REGEX',
  'NETGREENER_TENANT_TASK_KWARG',
  'NETGREENER_TENANT_LABEL_CLAIM',
] as const

const savedEnv: Partial<Record<(typeof ENV_KEYS_TOUCHED)[number], string | undefined>> = {}

function stashEnv(): void {
  for (const key of ENV_KEYS_TOUCHED) {
    savedEnv[key] = process.env[key]
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS_TOUCHED) {
    const previous = savedEnv[key]
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
}

stashEnv()
after(() => {
  restoreEnv()
})

test('loads only positive safe integer project and organization IDs', () => {
  const valid = loadRuntimeConfig({
    NETGREENER_PROJECT_ID: String(Number.MAX_SAFE_INTEGER),
    NETGREENER_ORG_ID: '7',
  })
  assert.equal(valid.projectId, Number.MAX_SAFE_INTEGER)
  assert.equal(valid.organizationId, 7)

  for (const invalid of ['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
    const config = loadRuntimeConfig({
      NETGREENER_PROJECT_ID: invalid,
      NETGREENER_ORG_ID: invalid,
    })
    assert.equal(config.projectId, 0, `project ID ${invalid}`)
    assert.equal(config.organizationId, null, `organization ID ${invalid}`)
  }
})

test('keeps flush minutes and TDP estimates inside explicit finite bounds', () => {
  const atBounds = loadRuntimeConfig({
    NETGREENER_RUNTIME_FLUSH_MINUTES: String(MAX_RUNTIME_FLUSH_MINUTES),
    NETGREENER_ESTIMATE_TDP_WATTS: String(MAX_ESTIMATE_TDP_WATTS),
  })
  assert.equal(atBounds.flushIntervalMs, MAX_RUNTIME_FLUSH_MINUTES * 60 * 1000)
  assert.equal(atBounds.estimateTdpWatts, MAX_ESTIMATE_TDP_WATTS)

  const fractional = loadRuntimeConfig({
    NETGREENER_RUNTIME_FLUSH_MINUTES: '1.5',
    NETGREENER_ESTIMATE_TDP_WATTS: '65.5',
  })
  assert.equal(fractional.flushIntervalMs, 90_000)
  assert.equal(fractional.estimateTdpWatts, 65.5)

  const invalidPairs: Array<[string, string]> = [
    ['0', '0'],
    ['-1', '-1'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    [String(MAX_RUNTIME_FLUSH_MINUTES + 1), String(MAX_ESTIMATE_TDP_WATTS + 1)],
  ]
  for (const [flushMinutes, tdpWatts] of invalidPairs) {
    const config = loadRuntimeConfig({
      NETGREENER_RUNTIME_FLUSH_MINUTES: flushMinutes,
      NETGREENER_ESTIMATE_TDP_WATTS: tdpWatts,
    })
    assert.equal(
      config.flushIntervalMs,
      DEFAULT_RUNTIME_FLUSH_MINUTES * 60 * 1000,
      `flush minutes ${flushMinutes}`,
    )
    assert.equal(config.estimateTdpWatts, DEFAULT_ESTIMATE_TDP_WATTS, `TDP ${tdpWatts}`)
  }

  const minimums = loadRuntimeConfig({
    NETGREENER_RUNTIME_FLUSH_MINUTES: String(MIN_RUNTIME_FLUSH_MINUTES),
    NETGREENER_ESTIMATE_TDP_WATTS: String(MIN_ESTIMATE_TDP_WATTS),
  })
  assert.equal(minimums.flushIntervalMs, MIN_RUNTIME_FLUSH_MINUTES * 60 * 1000)
  assert.equal(minimums.estimateTdpWatts, MIN_ESTIMATE_TDP_WATTS)
})

test('configReady rejects invalid programmatic numeric configuration', () => {
  assert.deepEqual(configReady(readyConfig()), { ok: true })

  const invalidCases: Array<[Partial<RuntimeConfig>, RegExp]> = [
    [{ projectId: 0 }, /PROJECT_ID/],
    [{ projectId: -1 }, /PROJECT_ID/],
    [{ projectId: 1.5 }, /PROJECT_ID/],
    [{ projectId: Number.MAX_SAFE_INTEGER + 1 }, /PROJECT_ID/],
    [{ organizationId: 0 }, /ORG_ID/],
    [{ organizationId: 1.5 }, /ORG_ID/],
    [{ flushIntervalMs: 0 }, /flushIntervalMs/],
    [
      { flushIntervalMs: (MAX_RUNTIME_FLUSH_MINUTES + 1) * 60 * 1000 },
      /flushIntervalMs/,
    ],
    [{ flushIntervalMs: Number.POSITIVE_INFINITY }, /flushIntervalMs/],
    [{ estimateTdpWatts: 0 }, /estimateTdpWatts/],
    [{ estimateTdpWatts: MAX_ESTIMATE_TDP_WATTS + 1 }, /estimateTdpWatts/],
    [{ estimateTdpWatts: Number.NaN }, /estimateTdpWatts/],
  ]

  for (const [overrides, reasonPattern] of invalidCases) {
    const result = configReady(readyConfig(overrides))
    assert.equal(result.ok, false, JSON.stringify(overrides))
    assert.match(result.reason || '', reasonPattern)
  }
})

test('loadRuntimeConfig reads supplied env for every field despite conflicting process.env', () => {
  for (const key of ENV_KEYS_TOUCHED) {
    process.env[key] = `dummy-conflict-${key}`
  }
  process.env.NETGREENER_PROJECT_ID = '97'
  process.env.NETGREENER_ORG_ID = '2'
  process.env.NETGREENER_RUNTIME_FLUSH_MINUTES = '300'
  process.env.NETGREENER_ESTIMATE_TDP_WATTS = '999'
  process.env.NETGREENER_TENANT_SOURCE = 'jwt_claim'

  try {
    const config = loadRuntimeConfig({
      NETGREENER_SERVICE_RUNTIME: '1',
      NETGREENER_API_URL: 'https://supplied.example/',
      NETGREENER_TOKEN: 'supplied-token',
      NETGREENER_PROJECT_ID: '42',
      NETGREENER_ORG_ID: '9',
      NETGREENER_RUNTIME_FLUSH_MINUTES: '7',
      NETGREENER_RUNTIME_DRY_RUN: '1',
      NETGREENER_DEPLOY_ENVIRONMENT: 'staging',
      NETGREENER_RELEASE_TAG: 'abc123',
      NETGREENER_ESTIMATE_TDP_WATTS: '120',
      NETGREENER_TENANT_SOURCE: 'header',
      NETGREENER_TENANT_CLAIM: 'org_id',
      NETGREENER_TENANT_HEADER: 'X-Org',
      NETGREENER_TENANT_PATH_REGEX: '^/t/(?<tenant_id>[^/]+)',
      NETGREENER_TENANT_TASK_KWARG: 'organization_id',
      NETGREENER_TENANT_LABEL_CLAIM: 'org_name',
    })

    assert.equal(config.enabled, true)
    assert.equal(config.apiUrl, 'https://supplied.example')
    assert.equal(config.token, 'supplied-token')
    assert.equal(config.projectId, 42)
    assert.equal(config.organizationId, 9)
    assert.equal(config.flushIntervalMs, 7 * 60 * 1000)
    assert.equal(config.dryRun, true)
    assert.equal(config.deployEnvironment, 'staging')
    assert.equal(config.releaseTag, 'abc123')
    assert.equal(config.estimateTdpWatts, 120)
    assert.equal(config.tenantSource, 'header')
    assert.equal(config.tenantClaim, 'org_id')
    assert.equal(config.tenantHeader, 'X-Org')
    assert.equal(config.tenantPathRegex, '^/t/(?<tenant_id>[^/]+)')
    assert.equal(config.tenantTaskKwarg, 'organization_id')
    assert.equal(config.tenantLabelClaim, 'org_name')
  } finally {
    restoreEnv()
  }
})
