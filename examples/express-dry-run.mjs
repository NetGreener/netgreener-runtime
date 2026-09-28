/**
 * Local smoke without deploying api_server:
 *
 *   cd netgreener_node
 *   npm run build
 *   node examples/express-dry-run.mjs
 *
 * Prints one dry-run RunSession payload. This script always disables cloud upload,
 * even when the caller's environment contains live credentials or DRY_RUN=false.
 */

import { createServer } from 'node:http'

import {
  getExpressRuntime,
  loadRuntimeConfig,
  netgreenerExpressMiddleware,
} from '../dist/index.js'

const config = loadRuntimeConfig({
  ...process.env,
  NETGREENER_SERVICE_RUNTIME: '1',
  NETGREENER_TOKEN: process.env.NETGREENER_TOKEN || 'ngs_local_dry_run',
  NETGREENER_PROJECT_ID: process.env.NETGREENER_PROJECT_ID || '1',
  NETGREENER_RUNTIME_DRY_RUN: '1',
})
const mw = netgreenerExpressMiddleware({
  config,
  fetchImpl: async () => {
    throw new Error('dry-run smoke attempted an outbound API request')
  },
  onFlush: (result) => {
    console.log('flush:', result.ok ? (result.dryRun ? 'dry-run ok' : `HTTP ${result.status}`) : result.error)
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

server.listen(0, async () => {
  const { port } = server.address()
  console.log(`dry-run server on http://127.0.0.1:${port}`)
  await fetch(`http://127.0.0.1:${port}/health`)
  await fetch(`http://127.0.0.1:${port}/v1/predict`, { method: 'POST' })
  await fetch(`http://127.0.0.1:${port}/fail`)
  const result = await getExpressRuntime().flush('manual')
  if (!result?.ok || !result.dryRun) {
    throw new Error('dry-run smoke did not return a dry-run result')
  }
  console.log(JSON.stringify(result?.ok ? result.body : result, null, 2))
  server.close()
  process.exit(0)
})
