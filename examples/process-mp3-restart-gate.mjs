/**
 * MP3 process/cron restart gate (experimental).
 *
 * Proves ``startProcessRuntime`` + ``runWithProcessTenant`` survive a runtime
 * reset (simulating process restart) and still emit ``node_process`` metadata.
 * No Redis required. Default export mode remains direct.
 *
 * Dry-run (default):
 *   npm run example:process-mp3-gate
 *
 * Live (authorized only):
 *   $env:NETGREENER_RUNTIME_DRY_RUN="0"
 *   $env:NETGREENER_TOKEN="ngs_..."
 *   $env:NETGREENER_PROJECT_ID="97"
 *   $env:NETGREENER_API_URL="http://127.0.0.1:8000"
 *   npm run example:process-mp3-gate
 *
 * Does NOT claim MP3 production support or npm publish.
 */

import {
  _resetOutboundInstrumentationForTests,
  _resetRuntimeForTests,
  runWithProcessTenant,
  startProcessRuntime,
  flushProcessRuntime,
} from '../dist/index.js'
import {
  extractPersistedRunId,
  sessionMetadataForDogfood,
} from '../dist/dogfood/tenantDogfoodGates.js'
import {
  assertMp3ProcessRestartGate,
  formatMp3GateFailure,
} from '../dist/dogfood/mp3WorkerGates.js'

const dryRun =
  (process.env.NETGREENER_RUNTIME_DRY_RUN || '1').trim() !== '0' &&
  (process.env.NETGREENER_RUNTIME_DRY_RUN || '1').trim().toLowerCase() !== 'false'
const live = !dryRun

process.env.NETGREENER_SERVICE_RUNTIME = '1'
process.env.NETGREENER_TOKEN = process.env.NETGREENER_TOKEN || 'ngs_local_process_mp3'
process.env.NETGREENER_PROJECT_ID = process.env.NETGREENER_PROJECT_ID || '97'
process.env.NETGREENER_RUNTIME_DRY_RUN = dryRun ? '1' : '0'
process.env.NETGREENER_API_URL =
  process.env.NETGREENER_API_URL || 'http://127.0.0.1:8000'
delete process.env.NETGREENER_EXPORT_MODE

const tenant = 'org_process_mp3'
const taskUnit = 'task:cron_job'
const generations = Math.max(2, Number(process.env.NETGREENER_PROCESS_GENERATIONS || '2'))
const jobsPerGen = Math.max(2, Number(process.env.NETGREENER_PROCESS_JOBS || '2'))

async function runGeneration(label) {
  _resetRuntimeForTests()
  _resetOutboundInstrumentationForTests()
  const flushed = []
  const runtime = startProcessRuntime({
    onFlush: (result, payload) => {
      flushed.push({ result, payload })
    },
  })
  let completed = 0
  for (let i = 0; i < jobsPerGen; i += 1) {
    await runWithProcessTenant(
      tenant,
      async () => {
        completed += 1
        return { ok: true, i }
      },
      { runtime, serviceUnit: taskUnit, source: 'manual' },
    )
  }
  const flushResult = await flushProcessRuntime('manual')
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
  return {
    completed,
    sessionMetadata,
    runId,
    windowId: flushPayload?.runtime_window_id,
  }
}

let exitCode = 0
try {
  console.log(
    `MP3 process gate  mode=${live ? 'LIVE' : 'DRY-RUN'}  generations=${generations}  jobsPerGen=${jobsPerGen}`,
  )
  for (let g = 0; g < generations; g += 1) {
    const label = `mp3-process-gen-${g}`
    const out = await runGeneration(label)
    const gate = assertMp3ProcessRestartGate({
      phase: 'process_restart',
      completedJobs: out.completed,
      minCompletedJobs: jobsPerGen,
      sessionMetadata: out.sessionMetadata,
      expectedTenant: tenant,
      expectedTaskUnit: taskUnit,
    })
    console.log(`${formatMp3GateFailure(gate)} (generation=${g})`)
    if (!gate.ok) exitCode = 1
    if (live && out.runId != null) {
      console.log(`[${label}] run_id=${out.runId} window=${out.windowId ?? 'n/a'}`)
    }
  }
  if (exitCode === 0) {
    console.log(
      live
        ? 'MP3 PROCESS RESTART GATE PASS (generations + live upload)'
        : 'MP3 PROCESS RESTART GATE PASS (generations; dry-run)',
    )
    console.log('Not claimed: MP3 production support label, managed sidecar, npm publish')
  }
} catch (err) {
  console.error('MP3 PROCESS RESTART GATE FAIL', err)
  exitCode = 1
} finally {
  _resetRuntimeForTests()
  _resetOutboundInstrumentationForTests()
  process.exitCode = exitCode
}
