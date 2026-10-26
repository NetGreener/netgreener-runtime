import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { ResourceFindingCandidateV1 } from '../analyze/resourceFindingCandidate.js'
import {
  extractSnippetFromFinding,
  runLlmOptimizeSession,
} from '../optimize/llmSession.js'
import {
  buildVerifiedPatchesFromLlmSession,
  llmItemEligibleForVerifiedApply,
  spliceSnippetIntoFile,
} from '../optimize/llmApply.js'
import { parseOptimizeArgs } from '../optimize/cli.js'

function fakeFinding(rel: string, start: number, end: number): ResourceFindingCandidateV1 {
  return {
    schema_version: 'resource_finding_v1',
    finding_id: 'f1',
    project_id: '9',
    evidence_state: 'candidate',
    comparison_origin: 'none',
    lifecycle_status: 'pending_admission',
    verification_outcome: 'not_run',
    primary_domain: 'compute.cpu',
    mechanism_id: 'repeated_work',
    title: 'demo',
    scope: {
      kind: 'function',
      id: 'demo',
      language: 'javascript',
      runtime: 'nodejs',
      source_locations: [{ path: rel, start_line: start, end_line: end }],
    },
    lineage: {
      detector_id: 't',
      detector_version: '0',
      policy_version: '0',
      observation_ids: [],
      benchmark_result_ids: [],
    },
  }
}

test('parseOptimizeArgs accepts --llm and --max-llm', () => {
  const flags = parseOptimizeArgs(['./app', '--llm', '--max-llm', '3', '--project-id', '7'])
  assert.equal(flags.llm, true)
  assert.equal(flags.maxLlm, 3)
  assert.equal(flags.projectId, '7')
  assert.equal(flags.applyVerified, false)
})

test('parseOptimizeArgs accepts --apply-verified with --llm', () => {
  const flags = parseOptimizeArgs([
    './app',
    '--llm',
    '--apply-verified',
    '--project-id',
    '7',
  ])
  assert.equal(flags.llm, true)
  assert.equal(flags.applyVerified, true)
  assert.equal(flags.apply, false)
})

test('spliceSnippetIntoFile replaces inclusive line range', () => {
  const full = ['a', 'b', 'c', 'd'].join('\n')
  const out = spliceSnippetIntoFile(full, 2, 3, 'B\nC')
  assert.equal(out, ['a', 'B', 'C', 'd'].join('\n'))
})

test('llmItemEligibleForVerifiedApply gates review flags', () => {
  assert.equal(
    llmItemEligibleForVerifiedApply({
      finding_id: 'f',
      mechanism_id: 'm',
      file_path: 'a.js',
      focus_line: 1,
      line_start: 1,
      line_end: 2,
      ok: true,
      result: {
        optimized_code: 'x',
        explanation: '',
        energy_note: '',
        confidence: 'high',
        model: 't',
        review_passed: true,
        apply_recommended: true,
      },
    }).ok,
    true,
  )
  assert.equal(
    llmItemEligibleForVerifiedApply({
      finding_id: 'f',
      mechanism_id: 'm',
      file_path: 'a.js',
      focus_line: 1,
      line_start: 1,
      line_end: 2,
      ok: true,
      result: {
        optimized_code: 'x',
        explanation: '',
        energy_note: '',
        confidence: 'high',
        model: 't',
        apply_recommended: false,
      },
    }).ok,
    false,
  )
})

test('buildVerifiedPatchesFromLlmSession splices eligible items', () => {
  const root = mkdtempSync(join(tmpdir(), 'ng-llm-apply-'))
  writeFileSync(join(root, 'a.js'), ['keep', 'OLD', 'tail'].join('\n'))
  const { patches, skipped } = buildVerifiedPatchesFromLlmSession(root, {
    schema: 'optimize_llm_session_v0',
    project_id: 1,
    project_dir: root,
    candidates_considered: 1,
    notes: [],
    items: [
      {
        finding_id: 'f1',
        mechanism_id: 'repeated_work',
        file_path: 'a.js',
        focus_line: 2,
        line_start: 2,
        line_end: 2,
        ok: true,
        result: {
          optimized_code: 'NEW',
          explanation: 'ok',
          energy_note: 'n/a',
          confidence: 'high',
          model: 't',
          review_passed: true,
          apply_recommended: true,
        },
      },
    ],
  })
  assert.equal(skipped.length, 0)
  assert.equal(patches.length, 1)
  assert.equal(patches[0]!.rule_id, 'llm_optimize_function')
  assert.equal(patches[0]!.new_content, ['keep', 'NEW', 'tail'].join('\n'))
})

test('extractSnippetFromFinding reads padded lines', () => {
  const root = mkdtempSync(join(tmpdir(), 'ng-opt-'))
  writeFileSync(
    join(root, 'a.js'),
    ['line1', 'line2', 'TARGET', 'line4', 'line5'].join('\n'),
  )
  const snip = extractSnippetFromFinding(root, fakeFinding('a.js', 3, 3), { padLines: 1 })
  assert.ok(snip)
  assert.match(snip!.code, /line2/)
  assert.match(snip!.code, /TARGET/)
  assert.match(snip!.code, /line4/)
  assert.equal(snip!.focusLine, 3)
})

test('runLlmOptimizeSession posts /optimize/function', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ng-opt-'))
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'a.js'), 'function f() {\n  return 1\n}\n')
  const calls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method || 'GET'} ${String(input)}`)
    return new Response(
      JSON.stringify({
        optimized_code: 'function f() { return 1 }',
        explanation: 'ok',
        energy_note: 'n/a',
        confidence: 'medium',
        model: 'test',
        review_passed: true,
        apply_recommended: false,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch

  const session = await runLlmOptimizeSession({
    projectDir: root,
    projectId: 9,
    findings: [fakeFinding('a.js', 1, 3)],
    token: 'tok',
    apiUrl: 'https://example.test/api/v1',
    fetchImpl,
  })
  assert.equal(session.schema, 'optimize_llm_session_v0')
  assert.equal(session.items.length, 1)
  assert.equal(session.items[0]!.ok, true)
  assert.ok(calls.some((c) => c.includes('POST') && c.includes('/optimize/function')))
})
