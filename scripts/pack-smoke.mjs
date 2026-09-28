/**
 * N6 pack smoke — ``npm pack --dry-run --json`` + real ``npm pack``.
 * Does **not** publish. Upload/live paths untouched.
 *
 *   npm run example:pack-smoke
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function npm(args) {
  return execFileSync('npm', args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
}

const dryOut = npm(['pack', '--dry-run', '--json'])
const dryStart = dryOut.indexOf('[')
assert.ok(dryStart >= 0, `expected JSON from npm pack --dry-run, got: ${dryOut.slice(0, 240)}`)
const dryParsed = JSON.parse(dryOut.slice(dryStart))
assert.ok(Array.isArray(dryParsed) && dryParsed.length >= 1, 'npm pack --dry-run returned empty')
const packInfo = dryParsed[0]
assert.equal(packInfo.name, '@netgreener/runtime')
assert.ok(packInfo.version, 'version present')

const files = (packInfo.files || []).map((f) =>
  String(typeof f === 'string' ? f : f.path || f.name || '').replace(/\\/g, '/'),
)
assert.ok(files.length > 0, 'pack file list non-empty')

function includesPath(fragment) {
  return files.some((p) => p === fragment || p.endsWith('/' + fragment) || p.includes(fragment))
}

assert.ok(includesPath('dist/index.js'), 'dist/index.js must be packed')
assert.ok(includesPath('dist/cli/netgreener.js'), 'netgreener bin entry packed')
assert.ok(includesPath('dist/analyze/cli.js'), 'netgreener-analyze bin entry packed')
assert.ok(includesPath('dist/collectorMetadata.js'), 'collector metadata module packed')
assert.ok(includesPath('README.md'), 'README packed')
assert.ok(includesPath('TUTORIAL.md'), 'TUTORIAL.md packed')
assert.ok(includesPath('CHANGELOG.md'), 'CHANGELOG.md packed')
const planLeak = files.filter((p) =>
  /PRODUCTION_|SUPPORT_LABEL|PACKAGING|PUBLISH_PREP|N4_MISSINGNESS|MP3_PRODUCTION|STACK\.md|PR_BODY/i.test(
    p,
  ),
)
assert.equal(planLeak.length, 0, `plan docs must not be packed: ${planLeak.slice(0, 5).join(', ')}`)

const testLeak = files.filter((p) => p.includes('dist/tests/'))
assert.equal(testLeak.length, 0, `dist/tests must not be packed: ${testLeak.slice(0, 5).join(', ')}`)

// Create a real tarball (publish=never), then delete it so the tree stays clean.
const before = new Set(readdirSync(root).filter((n) => n.endsWith('.tgz')))
const packOut = npm(['pack', '--silent']).trim()
const packName =
  packOut
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() || [...readdirSync(root)].filter((n) => n.endsWith('.tgz') && !before.has(n)).pop()

assert.ok(packName && String(packName).endsWith('.tgz'), `expected .tgz, got ${packName}`)
const tgzAbs = join(root, packName)
assert.ok(existsSync(tgzAbs), `missing ${tgzAbs}`)
unlinkSync(tgzAbs)

console.log(
  `PACK SMOKE PASS (name=${packInfo.name}@${packInfo.version}, files=${files.length}, tgz=${packName}, publish=never)`,
)
