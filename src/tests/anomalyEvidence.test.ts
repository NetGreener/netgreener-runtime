import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

import { ServiceRuntimeAggregator } from '../aggregator.js'
import { enrichRunContextForAnomaly } from '../runContextEnrichment.js'
import { loadRuntimeConfig } from '../config.js'

test('platform release identities match Python shared scenarios', () => {
  const cases = JSON.parse(readFileSync(
    new URL('../../fixtures/release_identity_platforms.json', import.meta.url), 'utf8',
  )) as Array<{
    name: string
    env: NodeJS.ProcessEnv
    context?: Record<string, unknown>
    expected: Record<string, string | null>
  }>
  for (const scenario of cases) {
    const ctx = enrichRunContextForAnomaly({ ...scenario.context }, scenario.env)
    for (const [key, value] of Object.entries(scenario.expected)) {
      assert.equal(ctx[key] ?? null, value, `${scenario.name}: ${key}`)
    }
  }
})

test('release identity uses container tags, registry ports and digests like Python', () => {
  for (const [env, expected] of [
    [{ CONTAINER_IMAGE: 'registry:5000/team/app:v2.4.1' }, 'v2.4.1'],
    [{ CONTAINER_IMAGE: 'registry:5000/team/app' }, undefined],
    [{ NETGREENER_K8S_IMAGE: 'app@sha256:deadbeefdeadc0de1234567890abcdef' }, 'sha256:deadbeefdead'],
    [{ IMAGE_DIGEST: 'sha256:deadbeefdeadc0de1234567890abcdef' }, 'sha256:deadbeefdead'],
    [{ IMAGE_TAG: 'explicit', CONTAINER_IMAGE: 'app:other' }, 'explicit'],
  ] as const) {
    const ctx = enrichRunContextForAnomaly({}, env)
    assert.equal(ctx.release_tag, expected)
  }
})

test('enrichRunContextForAnomaly sets git_sha deploy_id and CI flags', () => {
  const ctx: Record<string, unknown> = { client: 'test' }
  enrichRunContextForAnomaly(ctx, {
    GIT_SHA: 'abcdef0123456789',
    NETGREENER_DEPLOY_ID: 'deploy-9',
    GITHUB_ACTIONS: 'true',
    IMAGE_TAG: 'v1.2.3',
  } as NodeJS.ProcessEnv)

  assert.equal(ctx.git_sha, 'abcdef0123456789')
  assert.equal(ctx.deploy_id, 'deploy-9')
  assert.equal(ctx.release_tag, 'v1.2.3')
  assert.equal(ctx.is_ci, true)
  assert.equal(ctx.ci_provider, 'github_actions')
})

test('enrichRunContextForAnomaly does not overwrite existing release_tag', () => {
  const ctx: Record<string, unknown> = { release_tag: 'keep-me' }
  enrichRunContextForAnomaly(ctx, {
    IMAGE_TAG: 'other',
    GIT_SHA: 'deadbeef',
  } as NodeJS.ProcessEnv)
  assert.equal(ctx.release_tag, 'keep-me')
  assert.equal(ctx.git_sha, 'deadbeef')
})

test('loadRuntimeConfig does not map GIT_SHA into releaseTag', () => {
  const config = loadRuntimeConfig({
    GIT_SHA: 'should-not-be-release-tag',
    NETGREENER_RELEASE_TAG: 'rel-1',
  } as NodeJS.ProcessEnv)
  assert.equal(config.releaseTag, 'rel-1')
})

test('loadRuntimeConfig ignores bare GIT_SHA for releaseTag', () => {
  const config = loadRuntimeConfig({
    GIT_SHA: 'abc123',
  } as NodeJS.ProcessEnv)
  assert.equal(config.releaseTag, null)
})

test('aggregator sets cpu_share + attribution_detail when CPU measured', () => {
  const agg = new ServiceRuntimeAggregator()
  agg.record({
    serviceUnit: 'GET /x',
    durationMs: 10,
    cpuTimeMs: 20,
    peakRssKb: 1024,
  })
  const v0 = agg.buildV0({
    collector: 'test',
    framework: 'express',
    windowEnergyKwh: 0.001,
    windowSeconds: 60,
  })
  assert.ok(v0)
  assert.equal(v0!.attribution, 'cpu_share')
  assert.equal(v0!.attribution_detail?.cpu?.kind, 'proxy')
  assert.equal(v0!.attribution_detail?.cpu?.method, 'request_process_cpu_time')
})

test('aggregator duration_share when no measured CPU', () => {
  const agg = new ServiceRuntimeAggregator()
  agg.record({ serviceUnit: 'GET /x', durationMs: 10 })
  const v0 = agg.buildV0({
    collector: 'test',
    framework: 'express',
    windowEnergyKwh: 0.001,
    windowSeconds: 60,
  })
  assert.ok(v0)
  assert.equal(v0!.attribution, 'duration_share')
  assert.equal(v0!.attribution_detail?.cpu?.kind, 'proxy')
})
