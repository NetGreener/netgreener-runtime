import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const testsDirectory = fileURLToPath(new URL('../dist/tests/', import.meta.url))

function discoverTests(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return discoverTests(path)
      return entry.isFile() && entry.name.endsWith('.test.js') ? [path] : []
    })
    .sort()
}

const tests = discoverTests(testsDirectory)
if (tests.length === 0) {
  throw new Error(`No compiled tests found under ${testsDirectory}`)
}

const result = spawnSync(process.execPath, ['--test', ...tests], {
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exitCode = result.status ?? 1
