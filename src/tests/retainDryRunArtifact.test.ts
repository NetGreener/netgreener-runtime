import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  assertArtifactRedacted,
  buildDryRunArtifact,
  DRY_RUN_ARTIFACT_SCHEMA,
  redactSensitive,
  writeDryRunArtifact,
} from '../dogfood/retainDryRunArtifact.js'

test('redactSensitive strips ngs tokens and secret keys', () => {
  const redacted = redactSensitive({
    token: 'ngs_live_secret_value_here',
    nested: { Authorization: 'Bearer abcdefghijklmnop' },
    note: 'prefix ngs_live_secret_value_here suffix',
  })
  assert.equal((redacted as { token: string }).token, '[REDACTED]')
  assert.equal(
    (redacted as { nested: { Authorization: string } }).nested.Authorization,
    '[REDACTED]',
  )
  assert.match((redacted as { note: string }).note, /\[REDACTED\]/)
  assert.ok(!(redacted as { note: string }).note.includes('ngs_live'))
})

test('buildDryRunArtifact is revision-bound and upload=never', () => {
  const payload = {
    session_metadata: {
      service_runtime_v0: { collector: 'express_middleware', units: [] },
    },
  }
  const art = buildDryRunArtifact({
    payload,
    gitSha: 'abcdef0123456789',
    packageVersion: '0.1.0',
    sources: ['unit-test'],
  })
  assert.equal(art.schema, DRY_RUN_ARTIFACT_SCHEMA)
  assert.equal(art.git_sha_short, 'abcdef0')
  assert.equal(art.dry_run, true)
  assert.equal(art.upload, 'never')
  assert.equal(art.checks.collector, 'express_middleware')
  assert.equal(art.checks.ok, true)
  assertArtifactRedacted(art)
})

test('writeDryRunArtifact writes summary + latest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ng-dry-run-art-'))
  try {
    const art = buildDryRunArtifact({
      payload: {
        session_metadata: {
          service_runtime_v0: { collector: 'express_middleware' },
        },
      },
      gitSha: 'deadbeefcafebabe',
    })
    const { summaryPath, latestPath } = writeDryRunArtifact(dir, art)
    const latest = JSON.parse(readFileSync(latestPath, 'utf8'))
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
    assert.equal(latest.schema, DRY_RUN_ARTIFACT_SCHEMA)
    assert.equal(summary.git_sha_short, 'deadbee')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
