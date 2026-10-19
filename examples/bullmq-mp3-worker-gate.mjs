/**
 * MP3 BullMQ worker gate — concurrency + restart (experimental).
 *
 * Requires Redis + optional peers:
 *   docker run -d --name netgreener-redis -p 6379:6379 redis:7-alpine
 *   npm install bullmq ioredis --no-save
 *
 * Dry-run (default — no api_server upload):
 *   npm run example:bullmq-mp3-gate
 *
 * Live upload (authorized only):
 *   $env:NETGREENER_RUNTIME_DRY_RUN="0"
 *   $env:NETGREENER_API_URL="http://127.0.0.1:8000"
 *   $env:NETGREENER_TOKEN="ngs_..."
 *   $env:NETGREENER_PROJECT_ID="97"
 *   npm run example:bullmq-mp3-gate
 *
 * Does NOT claim MP3 production support, managed sidecar, or npm publish.
 * Default export mode remains direct.
 */

import { Queue, Worker } from 'bullmq'
import IORedis from 'ioredis'

import {
  _resetOutboundInstrumentationForTests,
  _resetRuntimeForTests,
  getBullMqRuntime,
  netgreenerBullMqProcessor,
} from '../dist/index.js'
import {
  extractPersistedRunId,
  sessionMetadataForDogfood,
} from '../dist/dogfood/tenantDogfoodGates.js'
import {
  assertMp3ConcurrencyGate,
  assertMp3RestartGate,
  formatMp3GateFailure,
} from '../dist/dogfood/mp3WorkerGates.js'

_resetRuntimeForTests()
_resetOutboundInstrumentationForTests()

const dryRun =
  (process.env.NETGREENER_RUNTIME_DRY_RUN || '1').trim() !== '0' &&
  (process.env.NETGREENER_RUNTIME_DRY_RUN || '1').trim().toLowerCase() !== 'false'
const live = !dryRun

process.env.NETGREENER_SERVICE_RUNTIME = '1'
process.env.NETGREENER_TOKEN = process.env.NETGREENER_TOKEN || 'ngs_local_bullmq_mp3'
process.env.NETGREENER_PROJECT_ID = process.env.NETGREENER_PROJECT_ID || '97'
process.env.NETGREENER_RUNTIME_DRY_RUN = dryRun ? '1' : '0'
process.env.NETGREENER_API_URL =
  process.env.NETGREENER_API_URL || 'http://127.0.0.1:8000'
process.env.NETGREENER_TENANT_SOURCE = process.env.NETGREENER_TENANT_SOURCE || 'task_kwarg'
process.env.NETGREENER_TENANT_TASK_KWARG =
  process.env.NETGREENER_TENANT_TASK_KWARG || 'organization_id'
delete process.env.NETGREENER_EXPORT_MODE

const host = process.env.NETGREENER_REDIS_HOST || '127.0.0.1'
const port = Number(process.env.NETGREENER_REDIS_PORT || '6379')
const queueName = process.env.NETGREENER_BULLMQ_MP3_QUEUE || 'netgreener-bullmq-mp3-gate'
const concurrency = Math.max(2, Number(process.env.NETGREENER_BULLMQ_CONCURRENCY || '2'))
const jobCount = Math.max(concurrency * 2, Number(process.env.NETGREENER_BULLMQ_JOBS || '4'))
const tenant = 'org_bullmq_mp3'
const taskName = 'analyze_document'
const taskUnit = `task:${taskName}`

function makeProcessor(label) {
  const flushed = []
  const processor = netgreenerBullMqProcessor(
    async (job) => {
      await new Promise((r) => setTimeout(r, 30))
      return { ok: true, organization_id: job.data?.organization_id, phase: label }
    },
    {
      onFlush: (result, payload) => {
        flushed.push({ result, payload })
      },
    },
  )
  return { processor, flushed }
}

async function waitJobs(worker, n, timeoutMs = 30000) {
  let done = 0
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout waiting for ${n} jobs (got ${done})`))
    }, timeoutMs)
    const onCompleted = () => {
      done += 1
      if (done >= n) {
        clearTimeout(timer)
        worker.off('completed', onCompleted)
        worker.off('failed', onFailed)
        resolve(done)
      }
    }
    const onFailed = (_job, err) => {
      clearTimeout(timer)
      worker.off('completed', onCompleted)
      worker.off('failed', onFailed)
      reject(err)
    }
    worker.on('completed', onCompleted)
    worker.on('failed', onFailed)
  })
}

async function flushAndMeta(flushed, label) {
  const flushResult = await getBullMqRuntime().flush('manual')
  if (!flushResult) {
    throw new Error(`${label}: flush returned null`)
  }
  const flushPayload = flushed.at(-1)?.payload
  const { sessionMetadata, uploadGate } = sessionMetadataForDogfood({
    live,
    flushResult,
    flushPayload,
    label,
  })
  if (!uploadGate.ok) {
    throw new Error(`${label}: ${uploadGate.reason}`)
  }
  const runId = live ? extractPersistedRunId(flushResult.body) : null
  return { sessionMetadata, flushResult, runId, windowId: flushPayload?.runtime_window_id }
}

let connection
let queue
let exitCode = 0

try {
  connection = new IORedis({ host, port, maxRetriesPerRequest: null, lazyConnect: true })
  await connection.connect()
  await connection.ping()

  console.log(
    `MP3 worker gate  mode=${live ? 'LIVE' : 'DRY-RUN'}  redis=${host}:${port}  queue=${queueName}  concurrency=${concurrency}  jobs=${jobCount}`,
  )

  queue = new Queue(queueName, { connection })
  await queue.obliterate({ force: true }).catch(() => {})

  // --- Phase A: concurrency ---
  _resetRuntimeForTests()
  _resetOutboundInstrumentationForTests()
  const a = makeProcessor('concurrency')
  const workerA = new Worker(queueName, a.processor, { connection, concurrency })
  for (let i = 0; i < jobCount; i += 1) {
    await queue.add(
      taskName,
      { organization_id: tenant, document_id: `c-${i}` },
      { removeOnComplete: 50, removeOnFail: 50 },
    )
  }
  const completedA = await waitJobs(workerA, jobCount)
  const metaA = await flushAndMeta(a.flushed, 'mp3-concurrency')
  const gateA = assertMp3ConcurrencyGate({
    phase: 'concurrency',
    completedJobs: completedA,
    minCompletedJobs: jobCount,
    sessionMetadata: metaA.sessionMetadata,
    expectedTenant: tenant,
    expectedTaskUnit: taskUnit,
  })
  console.log(formatMp3GateFailure(gateA))
  if (!gateA.ok) exitCode = 1
  if (live && metaA.runId != null) {
    console.log(`[concurrency] run_id=${metaA.runId} window=${metaA.windowId ?? 'n/a'}`)
  }
  await workerA.close()

  // --- Phase B: restart (new Worker after close) ---
  _resetRuntimeForTests()
  _resetOutboundInstrumentationForTests()
  const restartJobs = Math.max(2, concurrency)
  const b = makeProcessor('restart')
  const workerB = new Worker(queueName, b.processor, { connection, concurrency })
  for (let i = 0; i < restartJobs; i += 1) {
    await queue.add(
      taskName,
      { organization_id: tenant, document_id: `r-${i}` },
      { removeOnComplete: 50, removeOnFail: 50 },
    )
  }
  const completedB = await waitJobs(workerB, restartJobs)
  const metaB = await flushAndMeta(b.flushed, 'mp3-restart')
  const gateB = assertMp3RestartGate({
    phase: 'restart',
    completedJobs: completedB,
    minCompletedJobs: restartJobs,
    sessionMetadata: metaB.sessionMetadata,
    expectedTenant: tenant,
    expectedTaskUnit: taskUnit,
  })
  console.log(formatMp3GateFailure(gateB))
  if (!gateB.ok) exitCode = 1
  if (live && metaB.runId != null) {
    console.log(`[restart] run_id=${metaB.runId} window=${metaB.windowId ?? 'n/a'}`)
  }
  await workerB.close()

  if (exitCode === 0) {
    console.log(
      live
        ? 'MP3 BULLMQ WORKER GATE PASS (concurrency + restart + live upload)'
        : 'MP3 BULLMQ WORKER GATE PASS (concurrency + restart; dry-run)',
    )
    console.log('Not claimed: MP3 production support label, managed sidecar, npm publish')
  }
} catch (err) {
  const msg = err && typeof err === 'object' && 'message' in err ? err.message : String(err)
  if (/ECONNREFUSED|ENOTFOUND|connect/i.test(msg)) {
    console.error(
      'MP3 BULLMQ WORKER GATE BLOCKED: Redis not reachable. Start Redis (e.g. docker redis:7-alpine on :6379) and re-run. Unit tests for gate helpers still apply without Redis.',
    )
  } else {
    console.error('MP3 BULLMQ WORKER GATE FAIL', err)
  }
  exitCode = 1
} finally {
  try {
    if (queue) await queue.close()
  } catch {
    /* ignore */
  }
  try {
    if (connection) await connection.quit()
  } catch {
    /* ignore */
  }
  _resetRuntimeForTests()
  _resetOutboundInstrumentationForTests()
  process.exitCode = exitCode
}
