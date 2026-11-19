/**
 * Real BullMQ + Redis live smoke (experimental N3).
 *
 * Requires:
 *   - Redis (e.g. docker run -d --name netgreener-redis -p 6379:6379 redis:7-alpine)
 *   - Local peers: `npm install bullmq ioredis --no-save`
 *   - Live env (token / project / API); dry-run by default
 *
 *   $env:NETGREENER_RUNTIME_DRY_RUN="0"
 *   $env:NETGREENER_API_URL="https://core-api.netgreener.com"
 *   $env:NETGREENER_TOKEN="ngs_..."
 *   $env:NETGREENER_PROJECT_ID="97"
 *   node examples/bullmq-live-smoke.mjs
 *
 * Default export mode remains direct. Does not claim MP3 / managed sidecar.
 */

import { Queue, Worker } from 'bullmq'
import IORedis from 'ioredis'

import {
  _resetOutboundInstrumentationForTests,
  _resetRuntimeForTests,
  getBullMqRuntime,
  netgreenerBullMqProcessor,
  validateExternalApiV0,
  validateRuntimeSessionMetadata,
} from '../dist/index.js'
import {
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
process.env.NETGREENER_TOKEN = process.env.NETGREENER_TOKEN || 'ngs_local_bullmq_smoke'
process.env.NETGREENER_PROJECT_ID = process.env.NETGREENER_PROJECT_ID || '97'
process.env.NETGREENER_RUNTIME_DRY_RUN = dryRun ? '1' : '0'
process.env.NETGREENER_API_URL =
  process.env.NETGREENER_API_URL || 'https://core-api.netgreener.com'
process.env.NETGREENER_TENANT_SOURCE = process.env.NETGREENER_TENANT_SOURCE || 'task_kwarg'
process.env.NETGREENER_TENANT_TASK_KWARG =
  process.env.NETGREENER_TENANT_TASK_KWARG || 'organization_id'
// Leave EXPORT_MODE unset → default direct
delete process.env.NETGREENER_EXPORT_MODE

const connection = new IORedis({
  host: process.env.NETGREENER_REDIS_HOST || '127.0.0.1',
  port: Number(process.env.NETGREENER_REDIS_PORT || '6379'),
  maxRetriesPerRequest: null,
})
const queueName = process.env.NETGREENER_BULLMQ_QUEUE || 'netgreener-bullmq-smoke'

console.log(
  `mode: ${live ? 'LIVE upload' : 'DRY-RUN'}  redis=${connection.options.host}:${connection.options.port}  queue=${queueName}  project=${process.env.NETGREENER_PROJECT_ID}`,
)

const flushed = []
const processor = netgreenerBullMqProcessor(
  async (job) => {
    // Light outbound so external_api_v0 can appear when metering is on.
    try {
      await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: { Authorization: 'Bearer unused' },
      })
    } catch {
      /* ignore network / auth noise — metering still records attempt if wrapped */
    }
    return { ok: true, organization_id: job.data?.organization_id }
  },
  {
    onFlush: (result, payload) => {
      flushed.push({ result, payload })
      const mode = result.ok
        ? result.dryRun
          ? 'dry-run ok'
          : `HTTP ${result.status}`
        : `FAIL ${result.error}`
      console.log(`[flush bullmq-real] ${mode}`)
    },
  },
)

const worker = new Worker(queueName, processor, { connection, concurrency: 1 })
const queue = new Queue(queueName, { connection })

const jobDone = new Promise((resolve, reject) => {
  worker.on('completed', (job, result) => resolve({ job, result }))
  worker.on('failed', (job, err) => reject(err))
})

try {
  await queue.add(
    'analyze_document',
    { organization_id: 'org_bullmq_live', document_id: 'smoke-doc-1' },
    { removeOnComplete: 10, removeOnFail: 10 },
  )
  const { job, result } = await jobDone
  console.log(`[job] completed id=${job?.id} name=${job?.name} result=${JSON.stringify(result)}`)

  const flushResult = await getBullMqRuntime().flush('manual')
  if (!flushResult) {
    throw new Error('flush returned null — no runtime/external samples recorded')
  }

  const flushPayload = flushed.at(-1)?.payload
  const { sessionMetadata, uploadGate } = sessionMetadataForDogfood({
    live,
    flushResult,
    flushPayload,
    label: 'bullmq-real',
  })
  if (!uploadGate.ok) {
    console.error(`[bullmq-real] ${uploadGate.reason}`)
    process.exitCode = 1
  } else {
    const contract = validateRuntimeSessionMetadata(sessionMetadata)
    if (!contract.ok) {
      console.error('[bullmq-real] contract failed', contract.issues)
      process.exitCode = 1
    } else {
      const ext = sessionMetadata.external_api_v0
      if (ext) {
        const extOk = validateExternalApiV0(ext)
        if (!extOk.ok) console.warn('[bullmq-real] external_api_v0 issues', extOk.issues)
      }
      const runtime = sessionMetadata.service_runtime_v0
      console.log(
        `[bullmq-real] collector=${runtime?.collector} units=${(runtime?.units || [])
          .map((u) => u.service_unit)
          .join(',')}`,
      )
      console.log(
        `[bullmq-real] by_tenant=${Object.keys(runtime?.by_tenant || {}).join(',') || '(none)'}`,
      )
      if (live) {
        const runId = extractPersistedRunId(flushResult.body)
        console.log(
          `[bullmq-real] live upload ok status=${flushResult.status} run_id=${runId ?? 'n/a'} runtime_window_id=${flushPayload?.runtime_window_id ?? 'n/a'}`,
        )
      }
      console.log(
        live
          ? 'BULLMQ LIVE SMOKE PASS (real Worker + Redis + upload)'
          : 'BULLMQ DRY-RUN SMOKE PASS (real Worker + Redis)',
      )
    }
  }
} catch (err) {
  console.error('BULLMQ SMOKE FAIL', err)
  process.exitCode = 1
} finally {
  try {
    await worker.close()
  } catch {
    /* ignore */
  }
  try {
    await queue.close()
  } catch {
    /* ignore */
  }
  try {
    await connection.quit()
  } catch {
    /* ignore */
  }
  _resetRuntimeForTests()
  _resetOutboundInstrumentationForTests()
}
