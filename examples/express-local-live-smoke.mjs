/**
 * Laptop Express smoke → dry-run by default; live upload when credentials set.
 *
 * Dry-run (no cloud):
 *   npm run example:express-local-live
 *
 * Live (needs token + project; uses your local or prod api_server):
 *   $env:NETGREENER_RUNTIME_DRY_RUN="0"
 *   $env:NETGREENER_API_URL="http://127.0.0.1:8000"   # or https://core-api.netgreener.com
 *   $env:NETGREENER_TOKEN="ngs_..."
 *   $env:NETGREENER_PROJECT_ID="97"
 *   $env:NETGREENER_SERVICE_RUNTIME="1"
 *   npm run example:express-local-live
 *
 * Does not flip EXPORT_MODE. Prints run_id when live upload succeeds.
 */

import { createServer } from 'node:http'

import { extractPersistedRunId } from '../dist/dogfood/tenantDogfoodGates.js'
import {
  getExpressRuntime,
  loadRuntimeConfig,
  netgreenerExpressMiddleware,
} from '../dist/index.js'

const dryRun =
  (process.env.NETGREENER_RUNTIME_DRY_RUN || '1').trim() !== '0' &&
  (process.env.NETGREENER_RUNTIME_DRY_RUN || '1').trim().toLowerCase() !== 'false'
const live = !dryRun

if (live) {
  const token = (process.env.NETGREENER_TOKEN || '').trim()
  const projectId = (process.env.NETGREENER_PROJECT_ID || '').trim()
  if (!token || token.startsWith('ngs_local') || !projectId) {
    console.error(
      'LIVE mode requires real NETGREENER_TOKEN and NETGREENER_PROJECT_ID (not ngs_local_*).',
    )
    process.exit(2)
  }
}

const config = loadRuntimeConfig({
  ...process.env,
  NETGREENER_SERVICE_RUNTIME: '1',
  NETGREENER_TOKEN: process.env.NETGREENER_TOKEN || 'ngs_local_express_smoke',
  NETGREENER_PROJECT_ID: process.env.NETGREENER_PROJECT_ID || '97',
  NETGREENER_RUNTIME_DRY_RUN: dryRun ? '1' : '0',
  NETGREENER_API_URL:
    process.env.NETGREENER_API_URL ||
    (live ? 'https://core-api.netgreener.com' : 'http://127.0.0.1:8000'),
})

const mw = netgreenerExpressMiddleware({
  config,
  onFlush: (result) => {
    console.log(
      'flush:',
      result?.ok
        ? result.dryRun
          ? 'dry-run ok'
          : `HTTP ${result.status}`
        : result?.error || 'failed',
    )
  },
})

const server = createServer((req, res) => {
  const fakeReq = {
    method: req.method,
    path: (req.url || '/').split('?')[0],
    url: req.url,
    headers: req.headers,
  }
  const fakeRes = {
    statusCode: 200,
    on(event, fn) {
      if (event === 'finish' || event === 'close') res.on(event, fn)
      return this
    },
  }
  mw(fakeReq, fakeRes, () => {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, path: fakeReq.path, mode: live ? 'live' : 'dry-run' }))
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const addr = server.address()
const bound = typeof addr === 'object' && addr ? addr.port : 0

console.log(
  `mode: ${live ? 'LIVE upload' : 'DRY-RUN'}  http://127.0.0.1:${bound}/smoke  project=${process.env.NETGREENER_PROJECT_ID || '97'}`,
)

const resp = await fetch(`http://127.0.0.1:${bound}/smoke`)
const body = await resp.json()
console.log('response:', body)

const flushResult = await getExpressRuntime().flush('manual')
server.close()

if (!flushResult?.ok) {
  console.error('flush failed:', flushResult?.error || flushResult)
  process.exit(1)
}

if (live) {
  if (flushResult.dryRun) {
    console.error('LIVE smoke returned dry-run — check NETGREENER_RUNTIME_DRY_RUN=0')
    process.exit(1)
  }
  const runId = extractPersistedRunId(flushResult.body)
  if (runId == null) {
    console.warn('Upload ok but run_id not parsed — check dashboard for the latest run.')
    console.log(JSON.stringify(flushResult.body, null, 2))
  } else {
    console.log(`PASS run_id=${runId}`)
  }
} else {
  if (!flushResult.dryRun) {
    console.error('expected dry-run result')
    process.exit(1)
  }
  console.log('Dry-run PASS. Set NETGREENER_RUNTIME_DRY_RUN=0 + token/project for live run_id.')
}
