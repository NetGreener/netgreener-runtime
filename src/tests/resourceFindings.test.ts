import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  admitAnalyzeCandidate,
  buildResourceAnalyzeResultFromPaths,
  buildResourceFindingsFromSources,
  detectApiOverconsumptionHits,
  detectPollingIdleHits,
  detectProcessChurnHits,
  detectRepeatedWorkHits,
  detectFullDatasetInMemoryHits,
  detectRepeatedFileReadHits,
  detectRetryAmplificationHits,
  detectRetryAmplificationHitsPreferAst,
  detectRepeatedFileReadHitsPreferAst,
  detectApiOverconsumptionHitsPreferAst,
  detectUnboundedParallelismHitsPreferAst,
  detectPollingIdleHitsPreferAst,
  detectRepeatedWorkHitsPreferAst,
  detectProcessChurnHitsPreferAst,
  detectUnboundedParallelismHits,
  detectFullDatasetInMemoryHitsPreferAst,
  detectPerItemInsteadOfBatchHits,
  detectPerItemInsteadOfBatchHitsPreferAst,
  detectModelLoadInLoopHits,
  detectModelLoadInLoopHitsPreferAst,
  detectInferenceInsideLoopHits,
  detectInferenceInsideLoopHitsPreferAst,
  isTypescriptAnalyzeAvailable,
  toResourceFindingCandidate,
  validateResourceFindingCandidate,
  allResourceFindingsValid,
} from '../analyze/index.js'

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/analyze-sample',
)

const RETRY_SRC = `
export async function submitWithRetries(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url)
    if (res.ok) return res
  }
}
`

const LOOP_SRC = `
export async function fetchSequential(urls) {
  for (const url of urls) {
    await fetch(url)
  }
}
`

const MAP_SRC = `
export function fan(urls) {
  return urls.map((url) => fetch(url))
}
`

const PROMISE_ALL_SRC = `
export async function fetchAll(urls) {
  return Promise.all(urls.map((url) => fetch(url)))
}
`

test('detectRetryAmplificationHits finds fetch inside attempt loop', () => {
  const hits = detectRetryAmplificationHits(RETRY_SRC, 'retry.js')
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.mechanism_id, 'retry_amplification')
  assert.equal(hits[0]?.legacy_issue_type, 'api_call_in_retry_loop')
  assert.equal(hits[0]?.detector_id, 'js.static.retry_loop')
})

test('prefer-AST retry/file-read uses js.ast detectors when typescript is available', () => {
  assert.equal(isTypescriptAnalyzeAvailable(), true)
  const retry = detectRetryAmplificationHitsPreferAst(RETRY_SRC, 'retry.ts')
  assert.equal(retry.length, 1)
  assert.equal(retry[0]?.detector_id, 'js.ast.retry_loop')
  assert.equal(retry[0]?.mechanism_id, 'retry_amplification')

  const fileSrc = `
import { readFileSync } from 'node:fs'
export function loadMany(paths: string[]) {
  const out: string[] = []
  for (const p of paths) {
    out.push(readFileSync(p, 'utf8'))
  }
  return out
}
`
  const files = detectRepeatedFileReadHitsPreferAst(fileSrc, 'files.ts')
  assert.equal(files.length, 1)
  assert.equal(files[0]?.detector_id, 'js.ast.repeated_file_reads')
  assert.equal(files[0]?.primary_domain, 'storage.io')
})

test('prefer-AST covers overconsumption, Promise.all, and CPU twins', () => {
  const mapHits = detectApiOverconsumptionHitsPreferAst(MAP_SRC, 'map.ts')
  assert.ok(mapHits.some((h) => h.detector_id === 'js.ast.api_in_comprehension'))

  const loopHits = detectApiOverconsumptionHitsPreferAst(LOOP_SRC, 'loop.ts')
  assert.ok(loopHits.some((h) => h.detector_id === 'js.ast.api_in_loop'))

  const unbounded = detectUnboundedParallelismHitsPreferAst(PROMISE_ALL_SRC, 'all.ts')
  assert.equal(unbounded[0]?.detector_id, 'js.ast.unbounded_promise_all')

  const pollSrc = `
export function poll(check: () => boolean) {
  while (!check()) {
    setTimeout(() => {}, 50)
  }
}
`
  const poll = detectPollingIdleHitsPreferAst(pollSrc, 'poll.ts')
  assert.equal(poll[0]?.detector_id, 'js.ast.sleep_polling')

  const cpuSrc = `
import { execSync } from 'node:child_process'
export function scan(lines: string[], needle: string) {
  let blob = ''
  for (const line of lines) {
    const re = new RegExp(needle, 'i')
    if (re.test(line)) {}
    blob += \`\${line}\`
  }
}
export function runTools(cmds: string[]) {
  for (const cmd of cmds) {
    execSync(cmd)
  }
}
`
  const repeated = detectRepeatedWorkHitsPreferAst(cpuSrc, 'cpu.ts')
  assert.ok(repeated.some((h) => h.detector_id === 'js.ast.regex_compile_in_loop'))
  assert.ok(repeated.some((h) => h.detector_id === 'js.ast.string_concat_in_loop'))
  const churn = detectProcessChurnHitsPreferAst(cpuSrc, 'cpu.ts')
  assert.equal(churn[0]?.detector_id, 'js.ast.subprocess_in_loop')
})

test('prefer-AST full_dataset_in_memory pairs readFile + JSON.parse', () => {
  const src = `
import { readFileSync } from 'node:fs'
export function loadDataset(path: string): unknown {
  const raw = readFileSync(path, 'utf8')
  return JSON.parse(raw)
}
export function oneLiner(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}
`
  const hits = detectFullDatasetInMemoryHitsPreferAst(src, 'mem.ts')
  assert.ok(hits.length >= 2)
  assert.ok(hits.every((h) => h.detector_id === 'js.ast.full_dataset_in_memory'))
  assert.ok(hits.every((h) => h.mechanism_id === 'memory_retention_or_materialization'))
})

const NESTED_LOOKUP_SRC = `
export function matchMany(left, right) {
  const out = []
  for (const a of left) {
    for (const b of right) {
      if (right.find((x) => x.id === a.id)) {
        out.push(b)
      }
    }
  }
  return out
}
`

test('per_item_instead_of_batch: nested-loop lookup (heuristic + AST)', () => {
  const heuristic = detectPerItemInsteadOfBatchHits(NESTED_LOOKUP_SRC, 'nested.js')
  assert.equal(heuristic.length, 1)
  assert.equal(heuristic[0]?.mechanism_id, 'per_item_instead_of_batch')
  assert.equal(heuristic[0]?.legacy_issue_type, 'unvectorized_nested_loops')
  assert.equal(heuristic[0]?.detector_id, 'js.static.unvectorized_nested_loops')
  assert.equal(heuristic[0]?.primary_domain, 'compute.cpu')

  assert.equal(isTypescriptAnalyzeAvailable(), true)
  const ast = detectPerItemInsteadOfBatchHitsPreferAst(NESTED_LOOKUP_SRC, 'nested.ts')
  assert.equal(ast.length, 1)
  assert.equal(ast[0]?.detector_id, 'js.ast.unvectorized_nested_loops')
  assert.equal(ast[0]?.mechanism_id, 'per_item_instead_of_batch')

  // Single-level loop must not fire
  const single = detectPerItemInsteadOfBatchHitsPreferAst(
    `
export function oneLevel(items, id) {
  for (const item of items) {
    if (items.find((x) => x.id === id)) return item
  }
}
`,
    'single.ts',
  )
  assert.equal(single.length, 0)
})

const MODEL_LOAD_SRC = `
export async function loadPerItem(paths) {
  const out = []
  for (const p of paths) {
    const model = await loadLayersModel("file://" + p)
    out.push(model)
  }
  return out
}
`

test('model_load_in_loop: TF-style loader in loop (heuristic + AST)', () => {
  const heuristic = detectModelLoadInLoopHits(MODEL_LOAD_SRC, 'model.js')
  assert.equal(heuristic.length, 1)
  assert.equal(heuristic[0]?.mechanism_id, 'process_or_runtime_churn')
  assert.equal(heuristic[0]?.legacy_issue_type, 'model_load_in_loop')
  assert.equal(heuristic[0]?.detector_id, 'js.static.model_load_in_loop')

  assert.equal(isTypescriptAnalyzeAvailable(), true)
  const ast = detectModelLoadInLoopHitsPreferAst(MODEL_LOAD_SRC, 'model.ts')
  assert.equal(ast.length, 1)
  assert.equal(ast[0]?.detector_id, 'js.ast.model_load_in_loop')

  const requireSrc = `
export function loadPkgs(names) {
  for (const n of names) {
    require('@tensorflow/tfjs')
  }
}
`
  const reqHits = detectModelLoadInLoopHitsPreferAst(requireSrc, 'req.ts')
  assert.ok(reqHits.some((h) => h.legacy_issue_type === 'model_load_in_loop'))

  // Expanded API roots: groq in retry loop → retry_amplification
  const groqRetry = `
export async function submit(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await groq.chat.completions.create({ model: 'x' })
  }
}
`
  const retry = detectRetryAmplificationHitsPreferAst(groqRetry, 'groq.ts')
  assert.equal(retry.length, 1)
  assert.equal(retry[0]?.mechanism_id, 'retry_amplification')
})

const INFERENCE_SRC = `
export async function scorePerItem(model, batches) {
  const out = []
  for (const batch of batches) {
    out.push(await model.predict(batch))
  }
  return out
}
`

test('inference_inside_loop: predict/session.run in loop (heuristic + AST)', () => {
  const heuristic = detectInferenceInsideLoopHits(INFERENCE_SRC, 'infer.js')
  assert.equal(heuristic.length, 1)
  assert.equal(heuristic[0]?.mechanism_id, 'per_item_instead_of_batch')
  assert.equal(heuristic[0]?.primary_domain, 'compute.gpu')
  assert.equal(heuristic[0]?.legacy_issue_type, 'inference_inside_loop')
  assert.equal(heuristic[0]?.detector_id, 'js.static.inference_inside_loop')

  assert.equal(isTypescriptAnalyzeAvailable(), true)
  const ast = detectInferenceInsideLoopHitsPreferAst(INFERENCE_SRC, 'infer.ts')
  assert.equal(ast.length, 1)
  assert.equal(ast[0]?.detector_id, 'js.ast.inference_inside_loop')
  assert.equal(ast[0]?.primary_domain, 'compute.gpu')

  const onnxSrc = `
export async function runOnnx(session, feedsList) {
  for (const feeds of feedsList) {
    await session.run(feeds)
  }
}
`
  const onnx = detectInferenceInsideLoopHitsPreferAst(onnxSrc, 'onnx.ts')
  assert.ok(onnx.some((h) => h.legacy_issue_type === 'inference_inside_loop'))

  // Bare Process.run-style names must not fire without a session qualifier
  const bareRun = `
export function tick(proc, jobs) {
  for (const j of jobs) {
    proc.run(j)
  }
}
`
  assert.equal(detectInferenceInsideLoopHits(bareRun, 'bare.js').length, 0)
  assert.equal(detectInferenceInsideLoopHitsPreferAst(bareRun, 'bare.ts').length, 0)
})

test('detectApiOverconsumptionHits finds fetch in plain loop and map', () => {
  const loopHits = detectApiOverconsumptionHits(LOOP_SRC, 'loop.js')
  assert.ok(loopHits.some((h) => h.legacy_issue_type === 'network_call_in_loop'))
  assert.equal(loopHits[0]?.mechanism_id, 'external_api_overconsumption')

  const mapHits = detectApiOverconsumptionHits(MAP_SRC, 'map.js')
  assert.ok(mapHits.some((h) => h.legacy_issue_type === 'api_call_in_comprehension'))

  // Retry loops are owned by retry_amplification — overconsumption must not double-fire
  const retryOwned = detectApiOverconsumptionHits(RETRY_SRC, 'retry.js')
  assert.equal(retryOwned.length, 0)
})

test('detectUnboundedParallelismHits finds Promise.all + fetch map', () => {
  const hits = detectUnboundedParallelismHits(PROMISE_ALL_SRC, 'all.js')
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.mechanism_id, 'unbounded_parallelism')
  assert.equal(hits[0]?.primary_domain, 'network.io')
  assert.equal(hits[0]?.legacy_issue_type, 'unbounded_asyncio_gather_with_io')
})

const POLL_SRC = `
export function poll(check) {
  while (!check()) {
    setTimeout(() => {}, 50)
  }
}
`

const CPU_LOOP_SRC = `
import { execSync } from 'node:child_process'
export function scan(lines, needle) {
  let blob = ''
  for (const line of lines) {
    const re = new RegExp(needle, 'i')
    if (re.test(line)) {}
    blob += \`\${line}\`
  }
}
export function runTools(cmds) {
  for (const cmd of cmds) {
    execSync(cmd)
  }
}
`

test('CPU RD0 twins: polling, repeated_work, process churn', () => {
  const poll = detectPollingIdleHits(POLL_SRC, 'poll.js')
  assert.equal(poll[0]?.mechanism_id, 'polling_or_idle_work')
  assert.equal(poll[0]?.legacy_issue_type, 'sleep_polling')

  const repeated = detectRepeatedWorkHits(CPU_LOOP_SRC, 'cpu.js')
  assert.ok(repeated.some((h) => h.legacy_issue_type === 'regex_compile_in_loop'))
  assert.ok(repeated.some((h) => h.legacy_issue_type === 'string_concat_in_loop'))
  assert.ok(repeated.every((h) => h.mechanism_id === 'repeated_work'))

  const churn = detectProcessChurnHits(CPU_LOOP_SRC, 'cpu.js')
  assert.equal(churn[0]?.mechanism_id, 'process_or_runtime_churn')
  assert.equal(churn[0]?.legacy_issue_type, 'subprocess_in_loop')

  const finding = toResourceFindingCandidate(poll[0]!, '42')
  assert.ok(finding)
  assert.equal(finding.primary_domain, 'compute.cpu')
})

const FILE_LOOP_SRC = `
import { readFileSync } from 'node:fs'
export function loadMany(paths) {
  const out = []
  for (const p of paths) {
    out.push(readFileSync(p, 'utf8'))
  }
  return out
}
`

const DATASET_SRC = `
import { readFileSync } from 'node:fs'
export function loadDataset(path) {
  const raw = readFileSync(path, 'utf8')
  return JSON.parse(raw)
}
export function oneLiner(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}
`

test('memory/IO RD0 twins: repeated_file_reads + full_dataset_in_memory', () => {
  const reads = detectRepeatedFileReadHits(FILE_LOOP_SRC, 'files.js')
  assert.equal(reads[0]?.mechanism_id, 'repeated_work')
  assert.equal(reads[0]?.primary_domain, 'storage.io')
  assert.equal(reads[0]?.legacy_issue_type, 'repeated_file_reads')

  const mem = detectFullDatasetInMemoryHits(DATASET_SRC, 'mem.js')
  assert.ok(mem.length >= 2)
  assert.ok(mem.every((h) => h.mechanism_id === 'memory_retention_or_materialization'))
  assert.ok(mem.every((h) => h.primary_domain === 'memory.host'))
  assert.ok(mem.every((h) => h.legacy_issue_type === 'full_dataset_in_memory'))

  const admitted = toResourceFindingCandidate(mem[0]!, '42')
  assert.ok(admitted)
  assert.equal(admitted.primary_domain, 'memory.host')
})

test('admitAnalyzeCandidate accepts contract network.io alias', () => {
  assert.equal(admitAnalyzeCandidate({ domain: 'network.io' }).admitted, true)
  assert.equal(admitAnalyzeCandidate({ domain: 'compute.cpu' }).admitted, true)
})

test('toResourceFindingCandidate emits resource_finding_v1 candidate shape', () => {
  const hit = detectRetryAmplificationHits(RETRY_SRC, 'retry.js')[0]
  assert.ok(hit)
  const finding = toResourceFindingCandidate(hit, '42')
  assert.ok(finding)
  assert.equal(finding.schema_version, 'resource_finding_v1')
  assert.equal(finding.evidence_state, 'candidate')
  assert.equal(finding.comparison_origin, 'none')
  assert.equal(finding.lifecycle_status, 'pending_admission')
  assert.equal(finding.verification_outcome, 'not_run')
  assert.equal(finding.primary_domain, 'external_api')
  assert.equal(finding.mechanism_id, 'retry_amplification')
  assert.equal(finding.project_id, '42')
  assert.ok(finding.finding_id.length >= 8)
  assert.equal(finding.lineage.detector_id, 'js.static.retry_loop')
  assert.deepEqual(finding.lineage.observation_ids, [])
})

test('default-deny blocks security-category hits from becoming findings', () => {
  const hit = detectRetryAmplificationHits(RETRY_SRC, 'retry.js')[0]
  assert.ok(hit)
  const denied = toResourceFindingCandidate({ ...hit, category: 'security' }, '42')
  assert.equal(denied, null)
  assert.equal(admitAnalyzeCandidate({ domain: 'external_api', category: 'style' }).admitted, false)
})

test('style-only source emits no resource findings', () => {
  const findings = buildResourceFindingsFromSources({
    'styleOnly.ts': 'export const x = 1\n// const apiKey = "sk-secret"\n',
  })
  assert.equal(findings.length, 0)
})

test('negative architecture/security fixtures emit no resource findings', () => {
  const result = buildResourceAnalyzeResultFromPaths(fixtureRoot, [
    'architectureNoise.ts',
    'securitySmell.ts',
    'styleOnly.ts',
  ])
  assert.equal(result.findings.length, 0)
})

test('emitted candidates validate against resource_finding_v1 schema', () => {
  const result = buildResourceAnalyzeResultFromPaths(fixtureRoot, null, {
    projectId: '42',
  })
  assert.ok(result.findings.length >= 1)
  assert.equal(allResourceFindingsValid(result.findings), true)
  for (const f of result.findings) {
    const v = validateResourceFindingCandidate(f)
    assert.equal(v.ok, true, JSON.stringify(v.errors))
  }
})

test('schema gate rejects malformed candidate documents', () => {
  const bad = {
    schema_version: 'resource_finding_v1',
    finding_id: 'short',
    evidence_state: 'candidate',
  }
  const v = validateResourceFindingCandidate(bad)
  assert.equal(v.ok, false)
  assert.ok(v.errors.length >= 1)
})

test('buildResourceAnalyzeResultFromPaths covers retry + fan-out + cpu + memory fixtures', () => {
  const result = buildResourceAnalyzeResultFromPaths(fixtureRoot, null, {
    projectId: '42',
  })
  assert.equal(result.schema, 'resource_analyze_result_v0')
  assert.ok(result.findings.some((f) => f.mechanism_id === 'retry_amplification'))
  assert.ok(
    result.findings.some(
      (f) =>
        f.mechanism_id === 'retry_amplification' &&
        (f.lineage.detector_id === 'js.ast.retry_loop' ||
          f.lineage.detector_id === 'js.static.retry_loop'),
    ),
  )
  assert.ok(result.findings.some((f) => f.mechanism_id === 'external_api_overconsumption'))
  assert.ok(result.findings.some((f) => f.mechanism_id === 'unbounded_parallelism'))
  assert.ok(result.findings.some((f) => f.mechanism_id === 'polling_or_idle_work'))
  assert.ok(result.findings.some((f) => f.mechanism_id === 'repeated_work'))
  assert.ok(result.findings.some((f) => f.mechanism_id === 'process_or_runtime_churn'))
  assert.ok(result.findings.some((f) => f.mechanism_id === 'memory_retention_or_materialization'))
  assert.ok(result.findings.some((f) => f.mechanism_id === 'per_item_instead_of_batch'))
  assert.ok(result.findings.some((f) => f.primary_domain === 'storage.io'))
  assert.ok(result.stats.files_scanned >= 2)
  assert.ok(!result.findings.some((f) => /secret|security|style/i.test(f.mechanism_id)))
})
