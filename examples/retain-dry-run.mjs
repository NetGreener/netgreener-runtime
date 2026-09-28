/**
 * Run Express dry-run flush and retain a revision-bound redacted artifact.
 * Forces DRY_RUN=1 — never uploads. Does not change default flush pipelines.
 *
 *   npm run example:retain-dry-run
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import {
  getExpressRuntime,
  loadRuntimeConfig,
  netgreenerExpressMiddleware,
  _resetRuntimeForTests,
} from '../dist/index.js'
import {
  assertArtifactRedacted,
  buildDryRunArtifact,
  writeDryRunArtifact,
} from '../dist/dogfood/retainDryRunArtifact.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifactsDir = join(root, 'artifacts', 'dry-run')

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
  } catch {
    return 'unknown'
  }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

_resetRuntimeForTests()

const config = loadRuntimeConfig({
  ...process.env,
  NETGREENER_SERVICE_RUNTIME: '1',
  NETGREENER_TOKEN: process.env.NETGREENER_TOKEN || 'ngs_local_dry_run_artifact',
  NETGREENER_PROJECT_ID: process.env.NETGREENER_PROJECT_ID || '1',
  NETGREENER_RUNTIME_DRY_RUN: '1',
})

const mw = netgreenerExpressMiddleware({
  config,
  fetchImpl: async () => {
    throw new Error('retain-dry-run attempted an outbound API request')
  },
})

const server = createServer((req, res) => {
  const fakeReq = {
    method: req.method,
    path: (req.url || '/').split('?')[0],
    url: req.url,
  }
  const fakeRes = {
    statusCode: 200,
    on(event, fn) {
      if (event === 'finish' || event === 'close') {
        res.on(event, fn)
      }
      return this
    },
  }
  mw(fakeReq, fakeRes, () => {
    res.statusCode = fakeReq.path === '/fail' ? 500 : 200
    fakeRes.statusCode = res.statusCode
    res.end(JSON.stringify({ path: fakeReq.path, status: res.statusCode }))
  })
})

await new Promise((resolve) => server.listen(0, resolve))
const { port } = server.address()
await fetch(`http://127.0.0.1:${port}/health`)
await fetch(`http://127.0.0.1:${port}/v1/predict`, { method: 'POST' })
await fetch(`http://127.0.0.1:${port}/fail`)
const result = await getExpressRuntime().flush('manual')
server.close()

if (!result?.ok || !result.dryRun) {
  throw new Error('retain-dry-run did not return a dry-run flush result')
}

const artifact = buildDryRunArtifact({
  payload: result.body,
  gitSha: gitSha(),
  packageName: pkg.name,
  packageVersion: pkg.version,
  sources: ['express-dry-run', 'example:retain-dry-run'],
})
assertArtifactRedacted(artifact)
if (!artifact.checks.ok) {
  throw new Error('dry-run artifact checks failed (missing session_metadata / service_runtime_v0)')
}

const { summaryPath, latestPath } = writeDryRunArtifact(artifactsDir, artifact)
console.log(
  `DRY-RUN ARTIFACT RETAINED (sha=${artifact.git_sha_short}, collector=${artifact.checks.collector}, upload=never)`,
)
console.log(`  summary: ${summaryPath}`)
console.log(`  latest:  ${latestPath}`)
