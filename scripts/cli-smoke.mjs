/**
 * Smoke for multi-command ``netgreener`` CLI skeleton (no upload).
 *
 *   npm run example:cli-smoke
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'dist/cli/netgreener.js')
const fixture = join(root, 'fixtures/analyze-sample')

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    cwd: root,
  })
}

const help = run(['--help'])
assert.equal(help.status, 0)
assert.match(help.stdout, /Commands:/)
assert.match(help.stdout, /analyze/)
assert.match(help.stdout, /Examples:/)
assert.match(help.stdout, /upload=never/)

const helpAnalyze = run(['help', 'analyze'])
assert.equal(helpAnalyze.status, 0)
assert.match(helpAnalyze.stdout, /--json-summary/)
assert.match(helpAnalyze.stdout, /Examples:/)

const version = run(['--version'])
assert.equal(version.status, 0)
assert.match(version.stdout, /0\.1\.0/)

const analyze = run(['analyze', fixture, '--project-id', '42', '--quiet'])
assert.equal(analyze.status, 0, analyze.stderr)
const parsed = JSON.parse(analyze.stdout)
assert.equal(parsed.schema, 'resource_analyze_result_v0')
assert.ok(parsed.findings.length >= 1)

const runStub = run(['run', fixture])
assert.equal(runStub.status, 2)
assert.match(runStub.stderr, /not implemented/)
assert.match(runStub.stderr, /No upload/)
assert.match(runStub.stderr, /help analyze/)

const optStub = run(['optimize', fixture])
assert.equal(optStub.status, 2)
assert.match(optStub.stderr, /not implemented/)
assert.match(optStub.stderr, /OPTIMIZE_STUB\.md/)
assert.match(optStub.stderr, /no LLM/i)
assert.match(optStub.stderr, /No upload|no upload/i)

const unknown = run(['wat'])
assert.equal(unknown.status, 2)

console.log('NETGREENER CLI UX SMOKE PASS (help/examples; analyze wired; run/optimize stubs; upload=never)')
