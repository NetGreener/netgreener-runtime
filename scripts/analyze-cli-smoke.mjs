/**
 * Smoke for thin ``netgreener-analyze`` CLI (no upload).
 *
 *   npm run example:analyze-cli -- ./fixtures/analyze-sample --project-id 42 --quiet
 *   node scripts/analyze-cli-smoke.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'dist/analyze/cli.js')
const fixture = join(root, 'fixtures/analyze-sample')

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    cwd: root,
  })
  return result
}

const full = run([fixture, '--project-id', '42', '--quiet'])
assert.equal(full.status, 0, full.stderr)
const parsed = JSON.parse(full.stdout)
assert.equal(parsed.schema, 'resource_analyze_result_v0')
assert.ok(Array.isArray(parsed.findings))
assert.ok(parsed.findings.length >= 1)

const findingsOnly = run([fixture, '--findings-only', '--quiet'])
assert.equal(findingsOnly.status, 0, findingsOnly.stderr)
const findings = JSON.parse(findingsOnly.stdout)
assert.ok(Array.isArray(findings))
assert.ok(findings.every((f) => f.schema_version === 'resource_finding_v1'))

const bad = run(['./no-such-dir-analyze-cli', '--quiet'])
assert.equal(bad.status, 2)

const help = run(['--help'])
assert.equal(help.status, 0)
assert.match(help.stdout, /netgreener analyze/)

const gated = run([fixture, '--fail-on', 'any', '--quiet'])
assert.equal(gated.status, 1, 'fixture has candidates so --fail-on any must exit 1')
assert.match(gated.stderr, /NetGreener gate failed/)
// JSON still printed before gate
assert.ok(JSON.parse(gated.stdout).findings.length >= 1)

const allowed = run([
  fixture,
  '--fail-on',
  'any',
  '--max-at-or-above',
  '999',
  '--quiet',
])
assert.equal(allowed.status, 0, 'high max-at-or-above must pass')

const mech = run([fixture, '--fail-on', 'retry_amplification', '--quiet'])
assert.equal(mech.status, 1)
assert.match(mech.stderr, /retry_amplification/)

const missingMax = run([fixture, '--max-at-or-above', '1', '--quiet'])
assert.equal(missingMax.status, 2)

const summaryFail = run([
  fixture,
  '--json-summary',
  '--fail-on',
  'any',
  '--project-id',
  '42',
])
assert.equal(summaryFail.status, 1)
const summary = JSON.parse(summaryFail.stdout)
assert.equal(summary.schema, 'netgreener_analyze_gate_summary_v0')
assert.equal(summary.upload, 'never')
assert.equal(summary.ok, false)
assert.equal(summary.exit_code, 1)
assert.equal(summary.gate.exceeded, true)
assert.ok(summary.findings_total >= 1)

const summaryPass = run([
  fixture,
  '--json-summary',
  '--fail-on',
  'any',
  '--max-at-or-above',
  '999',
])
assert.equal(summaryPass.status, 0)
assert.equal(JSON.parse(summaryPass.stdout).ok, true)

console.log(
  `ANALYZE CLI SMOKE PASS (findings=${findings.length}, upload=never, fail-on=ok, json-summary=ok)`,
)
