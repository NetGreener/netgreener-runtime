/**
 * Tenant + outbound E2E dogfood (experimental Node v0 / N2–N3).
 *
 * Dry-run (default — no network to api_server):
 *
 *   cd netgreener_node
 *   npm run example:dogfood-tenant
 *
 * Live upload to your api_server (you supply secrets):
 *
 *   $env:NETGREENER_RUNTIME_DRY_RUN="0"
 *   $env:NETGREENER_API_URL="http://127.0.0.1:8000"   # or staging / any non-vendor host
 *   $env:NETGREENER_TOKEN="ngs_..."
 *   $env:NETGREENER_PROJECT_ID="123"
 *   npm run example:dogfood-tenant
 *
 * Live mode requires real HTTP uploads to succeed. Failed uploads fail the run;
 * local payload capture is never a substitute for a successful live upload.
 *
 * Then check dashboard: External API Impact → Client company (org_acme / org_beta).
 *
 * This script does NOT require Redis/BullMQ. It uses the BullMQ processor wrap
 * with a job-like object, and stubs only vendor fetch hosts (Azure DI / OpenAI).
 */

import { createServer } from 'node:http'

import {
  _resetOutboundInstrumentationForTests,
  _resetRuntimeForTests,
  getBullMqRuntime,
  getExpressRuntime,
  loadRuntimeConfig,
  netgreenerBullMqProcessor,
  netgreenerExpressMiddleware,
  validateExternalApiV0,
  validateRuntimeSessionMetadata,
} from '../dist/index.js'
import {
  createVendorAwareFetch,
  extractPersistedRunId,
  sessionMetadataForDogfood,
} from '../dist/dogfood/tenantDogfoodGates.js'

_resetRuntimeForTests()
_resetOutboundInstrumentationForTests()

const dryRun =
  (process.env.NETGREENER_RUNTIME_DRY_RUN || '1').trim() !== '0' &&
  (process.env.NETGREENER_RUNTIME_DRY_RUN || '1').trim().toLowerCase() !== 'false'
const live = !dryRun

process.env.NETGREENER_SERVICE_RUNTIME = '1'
process.env.NETGREENER_TOKEN = process.env.NETGREENER_TOKEN || 'ngs_local_dogfood'
process.env.NETGREENER_PROJECT_ID = process.env.NETGREENER_PROJECT_ID || '1'
process.env.NETGREENER_RUNTIME_DRY_RUN = dryRun ? '1' : '0'
process.env.NETGREENER_TENANT_SOURCE = process.env.NETGREENER_TENANT_SOURCE || 'header'
process.env.NETGREENER_TENANT_HEADER =
  process.env.NETGREENER_TENANT_HEADER || 'X-Organization-Id'
process.env.NETGREENER_API_URL =
  process.env.NETGREENER_API_URL || 'http://127.0.0.1:8000'

const config = loadRuntimeConfig()

/** Stub vendor hostnames only; configured API destination always uses real HTTP. */
const realFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = createVendorAwareFetch(realFetch, { apiBaseUrl: config.apiUrl })

const flushed = []

const mw = netgreenerExpressMiddleware({
  config,
  onFlush: (result, payload) => {
    flushed.push({ result, payload })
    const mode = result.ok
      ? result.dryRun
        ? 'dry-run ok'
        : `HTTP ${result.status}`
      : `FAIL ${result.error}`
    console.log(`[flush express] ${mode}`)
  },
})

function assertDogfood(label, sessionMetadata) {
  const contract = validateRuntimeSessionMetadata(sessionMetadata)
  if (!contract.ok) {
    console.error(`[${label}] contract failed`, contract.issues)
    return false
  }
  const ext = sessionMetadata.external_api_v0
  if (!ext) {
    console.error(`[${label}] missing external_api_v0`)
    return false
  }
  const extOk = validateExternalApiV0(ext)
  if (!extOk.ok) {
    console.error(`[${label}] external_api_v0 invalid`, extOk.issues)
    return false
  }
  const byTenant = ext.by_tenant || {}
  const keys = Object.keys(byTenant)
  if (!keys.length) {
    console.error(`[${label}] external_api_v0.by_tenant empty`)
    return false
  }
  console.log(`[${label}] by_tenant keys:`, keys.join(', '))
  for (const k of keys) {
    const row = byTenant[k]
    console.log(
      `  - ${k}: calls=${row.calls} errors=${row.errors} providers=${(row.providers || [])
        .map((p) => p.provider_key)
        .join('|')}`,
    )
  }
  return true
}

function resolveWindow(label, flushResult, flushPayload) {
  const { sessionMetadata, uploadGate } = sessionMetadataForDogfood({
    live,
    flushResult,
    flushPayload,
    label,
  })
  if (!uploadGate.ok) {
    console.error(`[${label}] ${uploadGate.reason}`)
    return { ok: false, sessionMetadata: null }
  }
  if (live) {
    const runId = extractPersistedRunId(flushResult?.body)
    const windowId = flushPayload?.runtime_window_id
    console.log(
      `[${label}] live upload ok status=${flushResult.status} run_id=${runId ?? 'n/a'} runtime_window_id=${windowId ?? 'n/a'}`,
    )
  }
  return { ok: true, sessionMetadata }
}

const server = createServer((req, res) => {
  const path = (req.url || '/').split('?')[0]
  const fakeReq = {
    method: req.method,
    path,
    url: req.url,
    headers: req.headers,
    route: path.startsWith('/v1/') ? { path: path.replace(/\/[^/]+$/, '/:id').includes(':') ? path : path } : undefined,
  }
  if (path === '/v1/documents/ocr') {
    fakeReq.route = { path: '/v1/documents/ocr' }
  }
  const fakeRes = {
    statusCode: 200,
    on(event, fn) {
      if (event === 'finish' || event === 'close') res.on(event, fn)
      return this
    },
  }
  mw(fakeReq, fakeRes, async () => {
    try {
      await fetch('https://eastus.api.cognitive.microsoft.com/formrecognizer/v2.1/prebuilt/receipt/analyze', {
        method: 'POST',
      })
      await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST' })
      res.statusCode = 200
      fakeRes.statusCode = 200
      res.end(JSON.stringify({ ok: true, path }))
    } catch (err) {
      res.statusCode = 500
      fakeRes.statusCode = 500
      res.end(JSON.stringify({ error: String(err) }))
    }
  })
})

server.listen(0, async () => {
  const { port } = server.address()
  console.log(`dogfood server http://127.0.0.1:${port}`)
  console.log(`mode: ${dryRun ? 'DRY-RUN (no api_server upload)' : 'LIVE upload (real HTTP; fail on upload error)'}`)
  console.log(`api: ${config.apiUrl}  project: ${config.projectId}`)

  let ok = true

  await fetch(`http://127.0.0.1:${port}/v1/documents/ocr`, {
    method: 'POST',
    headers: { 'X-Organization-Id': 'org_acme' },
  })

  const expressFlush = await getExpressRuntime().flush('manual')
  const expressResolved = resolveWindow('express+fetch', expressFlush, flushed.at(-1)?.payload)
  if (!expressResolved.ok || !expressResolved.sessionMetadata) {
    ok = false
  } else {
    const expressMeta = expressResolved.sessionMetadata
    ok = assertDogfood('express+fetch', expressMeta) && ok
    if (!expressMeta.external_api_v0?.by_tenant?.org_acme) {
      console.error('expected org_acme in external_api_v0.by_tenant')
      ok = false
    }
  }

  process.env.NETGREENER_TENANT_SOURCE = 'task_kwarg'
  process.env.NETGREENER_TENANT_TASK_KWARG = 'organization_id'
  _resetRuntimeForTests()

  const workerFlushed = []
  const processor = netgreenerBullMqProcessor(
    async (job) => {
      await fetch('https://eastus.api.cognitive.microsoft.com/formrecognizer/documentModels/prebuilt-read:analyze', {
        method: 'POST',
      })
      return { document_id: job.data.document_id }
    },
    {
      onFlush: (result, payload) => {
        workerFlushed.push({ result, payload })
        console.log(
          `[flush bullmq] ${result.ok ? (result.dryRun ? 'dry-run ok' : `HTTP ${result.status}`) : result.error}`,
        )
      },
    },
  )

  await processor({
    id: 'job-1',
    name: 'analyze_document',
    data: { organization_id: 'org_beta', document_id: 'doc-99' },
  })

  const workerFlush = await getBullMqRuntime().flush('manual')
  const workerResolved = resolveWindow('bullmq-processor', workerFlush, workerFlushed.at(-1)?.payload)
  if (!workerResolved.ok || !workerResolved.sessionMetadata) {
    ok = false
  } else {
    const workerMeta = workerResolved.sessionMetadata
    ok = assertDogfood('bullmq-processor', workerMeta) && ok
    if (!workerMeta.external_api_v0?.by_tenant?.org_beta) {
      console.error('expected org_beta in external_api_v0.by_tenant')
      ok = false
    }
    const taskUnit = workerMeta.service_runtime_v0?.units?.find(
      (u) => u.service_unit === 'task:analyze_document',
    )
    if (!taskUnit) {
      console.error('expected service_runtime unit task:analyze_document')
      ok = false
    } else {
      console.log(`[bullmq-processor] task unit calls=${taskUnit.calls} type=${taskUnit.unit_type}`)
    }
  }

  console.log('\n--- summary ---')
  if (ok) {
    console.log(live ? 'DOGFOOD PASS (live uploads succeeded)' : 'DOGFOOD PASS (dry-run payload smoke)')
    if (dryRun) {
      console.log(
        'Next: set NETGREENER_RUNTIME_DRY_RUN=0, TOKEN/PROJECT_ID/API_URL, re-run; live mode fails if upload fails.',
      )
    } else {
      console.log(
        'Correlate run_id / runtime_window_id above with RunSessions + External APIs UI for org_acme / org_beta.',
      )
    }
  } else {
    console.log('DOGFOOD FAIL — see errors above')
  }

  server.close()
  process.exit(ok ? 0 : 1)
})
