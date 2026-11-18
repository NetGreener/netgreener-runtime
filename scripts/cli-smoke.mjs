/**
 * Smoke for multi-command ``netgreener`` CLI (no upload).
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
const runSmoke = join(root, 'fixtures/run-smoke/hello.mjs')

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
assert.match(help.stdout, /optimize <projectDir>/)
assert.match(help.stdout, /Examples:/)
assert.match(help.stdout, /upload=never/)

const helpAnalyze = run(['help', 'analyze'])
assert.equal(helpAnalyze.status, 0)
assert.match(helpAnalyze.stdout, /--json-summary/)
assert.match(helpAnalyze.stdout, /Examples:/)

const helpOpt = run(['help', 'optimize'])
assert.equal(helpOpt.status, 0)
assert.match(helpOpt.stdout, /proposal/i)
assert.match(helpOpt.stdout, /OPTIMIZE_STUB/)

const version = run(['--version'])
assert.equal(version.status, 0)
assert.match(version.stdout, /0\.1\.\d+/)

const analyze = run(['analyze', fixture, '--project-id', '42', '--quiet'])
assert.equal(analyze.status, 0, analyze.stderr)
const parsed = JSON.parse(analyze.stdout)
assert.equal(parsed.schema, 'resource_analyze_result_v0')
assert.ok(parsed.findings.length >= 1)

const runLive = run(['run', runSmoke, join(root, 'fixtures/run-smoke'), '--no-upload', '--no-analyze'])
assert.equal(runLive.status, 0, runLive.stderr)
assert.match(runLive.stdout, /netgreener-run-smoke-ok/)

const opt = run(['optimize', fixture, '--quiet', '--project-id', '42'])
assert.equal(opt.status, 0, opt.stderr)
const optParsed = JSON.parse(opt.stdout)
assert.equal(optParsed.schema, 'optimize_result_v0')
assert.ok(optParsed.proposals.length >= 1)
assert.ok(optParsed.verification)
assert.equal(optParsed.verification.schema, 'verification_result_v0')

const optVerify = run(['optimize', fixture, '--verify', '--quiet'])
assert.equal(optVerify.status, 0, optVerify.stderr)
assert.equal(JSON.parse(optVerify.stdout).schema, 'verification_result_v0')

const unknown = run(['wat'])
assert.equal(unknown.status, 2)

console.log(
  'NETGREENER CLI UX SMOKE PASS (help/examples; analyze+run+optimize+verify; upload=never)',
)
