/**
 * Production-prep smoke (no publish, no live token, no new API).
 *
 * Runs local gates that do **not** require Redis or api_server:
 *   1) MP3 gate unit tests
 *   2) process restart dry-run gate
 *   3) npm pack smoke (publish=never)
 *   4) architecture guard: uploader still targets existing Python api_server
 *
 *   npm run example:production-prep-smoke
 *
 * Does not claim MP3 production support. Does not flip export defaults.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function run(cmd, args) {
  return execFileSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

console.log('--- production-prep: MP3 + N4 missingness unit tests ---')
run(process.execPath, ['--test', 'dist/tests/mp3WorkerGates.test.js'])
run(process.execPath, ['--test', 'dist/tests/n4Missingness.test.js'])

console.log('--- production-prep: process restart dry-run ---')
process.env.NETGREENER_RUNTIME_DRY_RUN = '1'
run(process.execPath, ['examples/process-mp3-restart-gate.mjs'])

console.log('--- production-prep: pack smoke (publish=never) ---')
run(process.execPath, ['scripts/pack-smoke.mjs'])

console.log('--- production-prep: architecture guard (same api_server) ---')
const uploader = readFileSync(join(root, 'src/uploader.ts'), 'utf8')
assert.match(
  uploader,
  /\/api\/v1\/runsessions\//,
  'uploader must POST to existing api_server /api/v1/runsessions/',
)
assert.doesNotMatch(
  uploader,
  /createServer\(|express\(\)|fastify\(\)/,
  'uploader must not embed an HTTP server (no Node api_server fork)',
)
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const allowPublic = process.env.NETGREENER_ALLOW_PUBLIC_PACKAGE === '1'
if (!allowPublic) {
  assert.equal(pkg.private, true, 'package must stay private until owner publish sign-off')
} else {
  assert.equal(
    pkg.private,
    false,
    'NETGREENER_ALLOW_PUBLIC_PACKAGE=1 expects private:false on the release commit',
  )
}

console.log(
  'PRODUCTION PREP SMOKE PASS (MP3+N4 units + process dry-run + pack + same-api_server guard; publish=never)',
)
console.log('Still open: N4 collector CPU/RSS exit; owner npm publish; full supported label')
