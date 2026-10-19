/**
 * Wave 4 serverless thin gate — Vercel-shaped env, ephemeral flush, dry-run.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  NetGreener,
  _resetRuntimeForTests,
  loadRuntimeConfig,
  resolveLifecycle,
  exportModeFromEnv,
} from '../dist/index.js'
import { extractRunId } from './extractRunId.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const artifactDir = join(__dirname, '../artifacts/serverless-thin-gate')

_resetRuntimeForTests()
process.env.VERCEL = '1'
process.env.VERCEL_ENV = 'preview'
process.env.NETGREENER_SERVICE_RUNTIME = '1'
process.env.NETGREENER_TOKEN = 'ngs_local_dry_run'
process.env.NETGREENER_PROJECT_ID = '1'
process.env.NETGREENER_RUNTIME_DRY_RUN = '1'
delete process.env.NETGREENER_EXPORT_MODE

const env = { ...process.env }
const lifecycle = resolveLifecycle({ mode: 'auto', env })
const exportMode = exportModeFromEnv(env, { lifecycle: lifecycle.lifecycle })
const config = loadRuntimeConfig(env)
const runtime = NetGreener.init({ config, runtime: 'auto' })

runtime.beginRequest()
runtime.recordHttp({
  method: 'POST',
  path: '/api/serverless-pilot',
  statusCode: 200,
  durationMs: 12,
  cpuTimeMs: 1,
  peakRssKb: 50_000,
})
runtime.endRequest()
const result = await NetGreener.flushForInvokeEnd()

mkdirSync(artifactDir, { recursive: true })
const runId = result?.ok && !result.dryRun ? extractRunId(result.body) : null
const summary = {
  gate: 'CHK-R6.serverless-degraded',
  label: 'Serverless Runtime (thin) pilot',
  claim_ready: Boolean(runId),
  lifecycle: lifecycle.lifecycle,
  platform: lifecycle.platform,
  export_mode: exportMode,
  dry_run: Boolean(result?.dryRun),
  ok: Boolean(result?.ok),
  run_id: runId,
  flushed_at: new Date().toISOString(),
}
writeFileSync(join(artifactDir, 'latest.json'), JSON.stringify({ summary, result }, null, 2))
writeFileSync(
  join(artifactDir, 'SUMMARY.md'),
  [
    '# Serverless thin gate evidence',
    '',
    `- check_id: \`CHK-R6.serverless-degraded\``,
    `- label: pilot (not production until live run_id + new approval_ref)`,
    `- lifecycle: \`${lifecycle.lifecycle}\` (must be ephemeral)`,
    `- platform: \`${lifecycle.platform}\``,
    `- export_mode: \`${exportMode}\` (prefer thin when unset)`,
    `- dry_run: \`${summary.dry_run}\``,
    `- ok: \`${summary.ok}\``,
    `- run_id: \`${runId ?? '(none — dry-run or upload body without id)'}\``,
    `- claim_ready: \`${summary.claim_ready}\``,
    `- flushed_at: \`${summary.flushed_at}\``,
    '',
  ].join('\n'),
)

console.log(JSON.stringify(summary, null, 2))
_resetRuntimeForTests()
if (
  !result?.ok ||
  lifecycle.lifecycle !== 'ephemeral' ||
  exportMode !== 'thin'
) {
  process.exit(1)
}
