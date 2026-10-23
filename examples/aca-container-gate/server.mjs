/**
 * Minimal Express-shaped HTTP server for ACA / Docker container gate.
 * Records routes via netgreenerExpressMiddleware; flushes dry-run payload.
 */
import { createServer } from 'node:http'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  getExpressRuntime,
  loadRuntimeConfig,
  netgreenerExpressMiddleware,
  resolveLifecycle,
} from '../../dist/index.js'
import { extractRunId } from '../extractRunId.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const artifactDir = join(__dirname, '../../artifacts/aca-container-gate')

const config = loadRuntimeConfig({
  ...process.env,
  NETGREENER_SERVICE_RUNTIME: '1',
  NETGREENER_TOKEN: process.env.NETGREENER_TOKEN || 'ngs_local_dry_run',
  NETGREENER_PROJECT_ID: process.env.NETGREENER_PROJECT_ID || '1',
  NETGREENER_RUNTIME_DRY_RUN: process.env.NETGREENER_RUNTIME_DRY_RUN || '1',
})

const lifecycle = resolveLifecycle({ env: process.env })
const mw = netgreenerExpressMiddleware({
  config,
  fetchImpl: async () => {
    throw new Error('aca-container-gate attempted outbound API request')
  },
})

const server = createServer((req, res) => {
  const pathOnly = (req.url || '/').split('?')[0]
  const fakeReq = {
    method: req.method,
    path: pathOnly,
    url: req.url,
    route: { path: pathOnly === '/health' ? '/health' : pathOnly },
  }
  const fakeRes = {
    statusCode: 200,
    on(event, fn) {
      if (event === 'finish' || event === 'close') res.on(event, fn)
      return this
    },
  }
  mw(fakeReq, fakeRes, () => {
    if (pathOnly === '/health') {
      res.statusCode = 200
      fakeRes.statusCode = 200
      res.end(JSON.stringify({ ok: true, lifecycle: lifecycle.lifecycle, platform: lifecycle.platform }))
      return
    }
    res.statusCode = 200
    fakeRes.statusCode = 200
    res.end(JSON.stringify({ path: pathOnly }))
  })
})

const port = Number(process.env.PORT || 8080)
server.listen(port, async () => {
  const base = `http://127.0.0.1:${port}`
  await fetch(`${base}/health`)
  await fetch(`${base}/v1/predict`, { method: 'POST' })
  const result = await getExpressRuntime().flush('manual')
  mkdirSync(artifactDir, { recursive: true })
  const runId =
    result?.ok && !result.dryRun ? extractRunId(result.body) : null
  const summary = {
    gate: 'CHK-R6.container',
    platform_claim: 'azure_container_apps',
    claim_ready: Boolean(runId),
    lifecycle: lifecycle.lifecycle,
    platform: lifecycle.platform,
    container_app_name: process.env.CONTAINER_APP_NAME || null,
    dry_run: Boolean(result?.dryRun),
    ok: Boolean(result?.ok),
    run_id: runId,
    flushed_at: new Date().toISOString(),
  }
  writeFileSync(join(artifactDir, 'latest.json'), JSON.stringify({ summary, result }, null, 2))
  writeFileSync(
    join(artifactDir, 'SUMMARY.md'),
    [
      '# ACA / container gate evidence',
      '',
      `- check_id: \`CHK-R6.container\``,
      `- claimed platform: **Azure Container Apps** (local Docker uses ACA env shape)`,
      `- lifecycle: \`${lifecycle.lifecycle}\` (must be persistent)`,
      `- platform hint: \`${lifecycle.platform}\``,
      `- dry_run: \`${summary.dry_run}\``,
      `- ok: \`${summary.ok}\``,
      `- run_id: \`${runId ?? '(none — dry-run or upload body without id)'}\``,
      `- claim_ready: \`${summary.claim_ready}\``,
      `- flushed_at: \`${summary.flushed_at}\``,
      '',
      'Live claim: set real `NETGREENER_*`, `NETGREENER_RUNTIME_DRY_RUN=0`, deploy on ACA, re-run until `run_id` is set, then flip DEPLOYMENT_MATRIX.',
      '',
    ].join('\n'),
  )
  console.log(JSON.stringify(summary, null, 2))
  if (!result?.ok || lifecycle.lifecycle !== 'persistent') {
    server.close()
    process.exit(1)
  }
  // Live mode without run_id is a soft warn (API shape may vary); dry-run stays green.
  if (!result.dryRun && !runId) {
    console.warn('WARN: live upload ok but run_id not found in response body')
  }
  server.close()
  process.exit(0)
})
