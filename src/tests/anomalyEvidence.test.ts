import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

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
  const emptyApp = mkdtempSync(join(tmpdir(), 'netgreener-platform-identity-'))
  for (const scenario of cases) {
    const ctx = enrichRunContextForAnomaly({ ...scenario.context }, scenario.env, emptyApp)
    for (const [key, value] of Object.entries(scenario.expected)) {
      assert.equal(ctx[key] ?? null, value, `${scenario.name}: ${key}`)
    }
  }
})

test('release identity uses container tags, registry ports and digests like Python', () => {
  const emptyApp = mkdtempSync(join(tmpdir(), 'netgreener-container-identity-'))
  for (const [env, expected] of [
    [{ CONTAINER_IMAGE: 'registry:5000/team/app:v2.4.1' }, 'v2.4.1'],
    [{ CONTAINER_IMAGE: 'registry:5000/team/app' }, undefined],
    [{ NETGREENER_K8S_IMAGE: 'app@sha256:deadbeefdeadc0de1234567890abcdef' }, 'sha256:deadbeefdead'],
    [{ IMAGE_DIGEST: 'sha256:deadbeefdeadc0de1234567890abcdef' }, 'sha256:deadbeefdead'],
    [{ IMAGE_TAG: 'explicit', CONTAINER_IMAGE: 'app:other' }, 'explicit'],
    [{ IMAGE_TAG: 'latest' }, undefined],
  ] as const) {
    const ctx = enrichRunContextForAnomaly({}, env, emptyApp)
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


test('automatic source identity matches Python without any release variables', () => {
  const root = mkdtempSync(join(tmpdir(), 'netgreener-auto-source-'))
  const files: Record<string, string> = { 'app.py': "print('hello')\n", 'src/handler.ts': 'export const handler = () => 42\n', 'package.json': '{"name":"sample-app","version":"1.0.0"}\n' }
  const digest = createHash('sha256')
  for (const name of Object.keys(files).sort()) {
    mkdirSync(join(root, ...name.split('/').slice(0, -1)), { recursive: true })
    writeFileSync(join(root, name), files[name])
    const filename = Buffer.from(name)
    const content = Buffer.from(files[name])
    digest.update(`${filename.length}:`).update(filename).update(`${content.length}:`).update(content)
  }
  const identity = enrichRunContextForAnomaly({}, {}, root)
  const expected = digest.digest('hex')
  assert.equal(identity.release_identity_source, 'source_fingerprint')
  assert.equal(identity.source_revision_sha256, expected)
  assert.equal(identity.release_tag, `source:${expected.slice(0, 16)}`)
  writeFileSync(join(root, 'app.py'), "print('changed')\n")
  assert.deepEqual(enrichRunContextForAnomaly({}, {}, root), identity, 'one process retains its running revision')
  const moduleUrl = new URL('../runContextEnrichment.js', import.meta.url).href
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { enrichRunContextForAnomaly } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(enrichRunContextForAnomaly({}, {}, process.argv[1])))`, root],
    { encoding: 'utf8', windowsHide: true })
  assert.equal(child.status, 0, child.stderr)
  assert.notEqual(JSON.parse(child.stdout).release_tag, identity.release_tag, 'a new process detects changed application code without variables')
})

test('automatic Git identity uses the real application checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'netgreener-auto-git-'))
  writeFileSync(join(root, 'app.js'), 'console.log(42)\n')
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '-q')
  git('add', 'app.js')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'first')
  const identity = enrichRunContextForAnomaly({}, {}, root)
  assert.equal(identity.git_sha, git('rev-parse', 'HEAD'))
  assert.equal(identity.release_identity_source, 'git_commit')
})
