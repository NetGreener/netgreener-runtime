/**
 * CI smoke for MP4 Analyze scaffold.
 *
 *   npm run example:analyze-smoke
 *
 * Asserts fixture scan yields a service manifest, schema-valid resource_finding_v1
 * candidates, and that negative (architecture/security/style) paths emit zero.
 * Does not upload or touch RunSession.
 */

import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  allResourceFindingsValid,
  buildResourceAnalyzeResultFromPaths,
  isServiceProject,
  validateResourceFindingCandidate,
} from '../dist/analyze/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/analyze-sample')

const result = buildResourceAnalyzeResultFromPaths(root, null, { projectId: '42' })

assert.equal(result.schema, 'resource_analyze_result_v0')
assert.ok(isServiceProject(result.manifest), 'expected service_manifest_v0 service project')
assert.ok(result.findings.length >= 1, 'expected at least one resource_finding_v1 candidate')
assert.equal(
  allResourceFindingsValid(result.findings),
  true,
  'every candidate must validate against resource_finding_v1',
)
for (const finding of result.findings) {
  const v = validateResourceFindingCandidate(finding)
  assert.equal(v.ok, true, JSON.stringify({ finding_id: finding.finding_id, errors: v.errors }))
}

const requiredMechanisms = [
  'retry_amplification',
  'external_api_overconsumption',
  'unbounded_parallelism',
  'polling_or_idle_work',
  'repeated_work',
  'process_or_runtime_churn',
  'memory_retention_or_materialization',
]
for (const mechanism of requiredMechanisms) {
  assert.ok(
    result.findings.some((f) => f.mechanism_id === mechanism),
    `missing mechanism ${mechanism}`,
  )
}

assert.ok(
  !result.findings.some((f) => /secret|security|style|architecture/i.test(f.mechanism_id)),
  'non-resource categories must not appear as mechanisms',
)

const negatives = buildResourceAnalyzeResultFromPaths(root, [
  'architectureNoise.ts',
  'securitySmell.ts',
  'styleOnly.ts',
])
assert.equal(negatives.findings.length, 0, 'negative fixtures must emit zero candidates')

console.log(
  `ANALYZE SMOKE PASS (findings=${result.findings.length}, files=${result.stats.files_scanned}, ast_note=${result.notes.find((n) => n.startsWith('typescript AST')) || 'n/a'})`,
)
