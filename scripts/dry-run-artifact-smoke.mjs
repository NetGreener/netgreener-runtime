/**
 * Smoke: retain dry-run artifact then assert shape + redaction.
 *
 *   npm run example:dry-run-artifact-smoke
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const retain = join(root, 'examples', 'retain-dry-run.mjs')
const latest = join(root, 'artifacts', 'dry-run', 'latest-summary.json')

const run = spawnSync(process.execPath, [retain], {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    NETGREENER_RUNTIME_DRY_RUN: '1',
    NETGREENER_TOKEN: 'ngs_should_be_redacted_token_xyz',
  },
})

assert.equal(run.status, 0, run.stderr || run.stdout)
assert.match(run.stdout, /DRY-RUN ARTIFACT RETAINED/)
assert.match(run.stdout, /upload=never/)
assert.ok(existsSync(latest), 'latest-summary.json missing')

const artifact = JSON.parse(readFileSync(latest, 'utf8'))
assert.equal(artifact.schema, 'netgreener_node_dry_run_artifact_v0')
assert.equal(artifact.dry_run, true)
assert.equal(artifact.upload, 'never')
assert.ok(artifact.git_sha_short)
assert.ok(artifact.checks?.ok)
assert.ok(artifact.checks?.has_service_runtime_v0)
assert.ok(artifact.payload_sha256_prefix)
assert.ok(!JSON.stringify(artifact).includes('ngs_should_be_redacted'))
assert.ok(!/\bngs_[A-Za-z0-9._-]{8,}\b/.test(JSON.stringify(artifact)))

console.log(
  `DRY-RUN ARTIFACT SMOKE PASS (sha=${artifact.git_sha_short}, collector=${artifact.checks.collector}, upload=never)`,
)
