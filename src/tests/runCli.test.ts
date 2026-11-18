import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseRunArgs, runRunCli } from '../cli/runCli.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const smokeScript = join(root, 'fixtures/run-smoke/hello.mjs')

test('parseRunArgs reads flags and passthrough', () => {
  const f = parseRunArgs([
    'script.mjs',
    '.',
    '--no-upload',
    '--no-analyze',
    '--',
    '--port',
    '3',
  ])
  assert.equal(f.script, 'script.mjs')
  assert.equal(f.projectDir, '.')
  assert.equal(f.noUpload, true)
  assert.equal(f.noAnalyze, true)
  assert.deepEqual(f.scriptArgs, ['--port', '3'])
})

test('runRunCli dry-runs smoke script and exits 0', async () => {
  const code = await runRunCli([
    smokeScript,
    join(root, 'fixtures/run-smoke'),
    '--no-upload',
    '--no-analyze',
  ])
  assert.equal(code, 0)
})
