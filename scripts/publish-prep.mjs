/**
 * Publish prep smoke — never publishes.
 *
 *   npm run example:publish-prep
 *
 * Fails if package.json is not private (guards accidental publish readiness).
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

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.equal(pkg.name, '@netgreener/runtime')
assert.equal(
  pkg.private,
  true,
  'REFUSE: package must stay private:true until owner explicitly opens publish',
)
assert.ok(pkg.version, 'version required')

console.log(`--- publish-prep: private=${pkg.private} version=${pkg.version} ---`)
console.log('--- publish-prep: running production-prep-smoke (publish=never) ---')
run(process.execPath, ['scripts/production-prep-smoke.mjs'])

const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
assert.match(changelog, /\[0\.1\.0\]/, 'CHANGELOG must document 0.1.0')
assert.match(
  readFileSync(join(root, 'SUPPORT_LABEL.md'), 'utf8'),
  /Node\.js Runtime beta/,
  'SUPPORT_LABEL must freeze Runtime beta',
)
assert.match(
  readFileSync(join(root, 'PUBLISH_PREP.md'), 'utf8'),
  /Do not.*npm publish/i,
  'PUBLISH_PREP must forbid agent publish',
)

console.log(
  `PUBLISH PREP PASS (private=true, version=${pkg.version}, production-prep green, changelog present)`,
)
console.log('OWNER ACTION REQUIRED to publish — this script never runs npm publish')
