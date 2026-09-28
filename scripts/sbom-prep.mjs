/**
 * N9 SBOM prep — never publishes.
 *
 *   npm run example:sbom-prep
 *
 * Uses npx @cyclonedx/cyclonedx-npm to write CycloneDX JSON under artifacts/sbom/.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'artifacts', 'sbom')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const allowPublic = process.env.NETGREENER_ALLOW_PUBLIC_PACKAGE === '1'
if (!allowPublic) {
  assert.equal(pkg.private, true, 'REFUSE: stay private until owner opens publish')
}

mkdirSync(outDir, { recursive: true })

const outFile = join(outDir, `${pkg.name.replace('/', '-')}-${pkg.version}.cdx.json`)

console.log(`--- sbom-prep: ${pkg.name}@${pkg.version} → ${outFile} ---`)

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const result = spawnSync(
  npx,
  [
    '--yes',
    '@cyclonedx/cyclonedx-npm@1.19.3',
    '--output-file',
    outFile,
    '--output-reproducible',
    '--omit',
    'dev',
  ],
  {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)

if (result.status !== 0) {
  console.error(result.stdout || '')
  console.error(result.stderr || '')
  process.exit(result.status ?? 1)
}

assert.ok(existsSync(outFile), `expected SBOM at ${outFile}`)
const sbom = JSON.parse(readFileSync(outFile, 'utf8'))
assert.ok(
  sbom.bomFormat === 'CycloneDX' || sbom.bomFormat === 'CycloneDx',
  'bomFormat must be CycloneDX',
)
assert.ok(Array.isArray(sbom.components) || sbom.metadata, 'SBOM missing components/metadata')

const listed = readdirSync(outDir).filter((f) => f.endsWith('.cdx.json'))
console.log(`SBOM PREP PASS (${listed.join(', ')})`)
console.log('N9 still open until org signing/provenance + SECURITY_RELEASE rows filled')
console.log('This script never runs npm publish')
