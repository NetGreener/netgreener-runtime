import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildAnalyzeGateSummary,
  countGateFindings,
  findingsExceedFailThreshold,
  formatAnalyzeGateFailureMessage,
  resolveAnalyzeGateLimit,
} from '../analyze/analyzeGate.js'
import type { ResourceFindingCandidateV1 } from '../analyze/resourceFindingCandidate.js'

function fake(mechanism_id: string): ResourceFindingCandidateV1 {
  return {
    schema_version: 'resource_finding_v1',
    finding_id: `rf_${mechanism_id}_testhash01`,
    project_id: '42',
    evidence_state: 'candidate',
    comparison_origin: 'none',
    lifecycle_status: 'pending_admission',
    verification_outcome: 'not_run',
    primary_domain: 'external_api',
    mechanism_id,
    title: 'Test candidate title ok',
    scope: {
      kind: 'script',
      id: 'x.ts',
      language: 'typescript',
      runtime: 'nodejs',
      source_locations: [{ path: 'x.ts', start_line: 1, end_line: 1 }],
    },
    lineage: {
      detector_id: 'js.test',
      detector_version: '0.1.0',
      policy_version: '0.1.0',
      observation_ids: [],
      benchmark_result_ids: [],
    },
  }
}

test('resolveAnalyzeGateLimit defaults to 0 when fail-on set', () => {
  assert.equal(resolveAnalyzeGateLimit(null, null), null)
  assert.equal(resolveAnalyzeGateLimit('any', null), 0)
  assert.equal(resolveAnalyzeGateLimit('any', 2), 2)
})

test('countGateFindings matches any and mechanism lists', () => {
  const findings = [
    fake('retry_amplification'),
    fake('retry_amplification'),
    fake('external_api_overconsumption'),
  ]
  assert.equal(countGateFindings(findings, 'any'), 3)
  assert.equal(countGateFindings(findings, 'candidate'), 3)
  assert.equal(countGateFindings(findings, 'retry_amplification'), 2)
  assert.equal(
    countGateFindings(findings, 'retry_amplification,external_api_overconsumption'),
    3,
  )
  assert.equal(countGateFindings(findings, 'none'), 0)
})

test('findingsExceedFailThreshold respects max-at-or-above', () => {
  const findings = [fake('retry_amplification'), fake('retry_amplification')]
  assert.equal(findingsExceedFailThreshold(findings, 'any', 0), true)
  assert.equal(findingsExceedFailThreshold(findings, 'any', 1), true)
  assert.equal(findingsExceedFailThreshold(findings, 'any', 2), false)
  assert.equal(findingsExceedFailThreshold(findings, 'retry_amplification', 1), true)
  assert.equal(findingsExceedFailThreshold(findings, 'polling_or_idle_work', 0), false)
})

test('formatAnalyzeGateFailureMessage includes mechanism tops', () => {
  const msg = formatAnalyzeGateFailureMessage(
    [fake('retry_amplification'), fake('external_api_overconsumption')],
    'any',
    0,
  )
  assert.match(msg, /NetGreener gate failed/)
  assert.match(msg, /retry_amplification/)
})

test('buildAnalyzeGateSummary is CI-shaped and fail-closed', () => {
  const findings = [fake('retry_amplification'), fake('external_api_overconsumption')]
  const pass = buildAnalyzeGateSummary({
    projectId: '42',
    filesScanned: 3,
    findings,
    failOn: null,
  })
  assert.equal(pass.schema, 'netgreener_analyze_gate_summary_v0')
  assert.equal(pass.upload, 'never')
  assert.equal(pass.ok, true)
  assert.equal(pass.exit_code, 0)
  assert.equal(pass.gate, null)
  assert.equal(pass.findings_total, 2)

  const fail = buildAnalyzeGateSummary({
    projectId: '42',
    filesScanned: 3,
    findings,
    failOn: 'any',
    maxAtOrAbove: 0,
  })
  assert.equal(fail.ok, false)
  assert.equal(fail.exit_code, 1)
  assert.equal(fail.gate?.exceeded, true)
  assert.equal(fail.gate?.matching, 2)
  assert.match(String(fail.gate?.message), /NetGreener gate failed/)
})
