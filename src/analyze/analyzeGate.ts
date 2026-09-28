/**
 * CI gate helpers for Analyze resource candidates (Node twin of Python
 * ``findings_bridge`` fail-on, adapted to ``resource_finding_v1``).
 *
 * Resource candidates have no severity rank — gates match ``mechanism_id``
 * or the aliases ``any`` / ``candidate``.
 */

import type { ResourceFindingCandidateV1 } from './resourceFindingCandidate.js'

export type AnalyzeGateLimit = number | null

/** Effective count cap when ``--fail-on`` is set (default 0 = any match fails). */
export function resolveAnalyzeGateLimit(
  failOn: string | null | undefined,
  maxAtOrAbove: number | null | undefined,
): AnalyzeGateLimit {
  if (!failOn) return null
  return maxAtOrAbove == null ? 0 : maxAtOrAbove
}

function normalizeFailOn(failOn: string): string {
  return String(failOn || '')
    .trim()
    .toLowerCase()
}

/**
 * Count candidates that match ``failOn``.
 * - ``any`` / ``candidate`` → all findings
 * - comma-separated mechanism IDs → exact mechanism_id match
 */
export function countGateFindings(
  findings: Iterable<ResourceFindingCandidateV1>,
  failOn: string,
): number {
  const key = normalizeFailOn(failOn)
  if (!key || key === 'none' || key === 'off') return 0
  const list = [...findings]
  if (key === 'any' || key === 'candidate') return list.length
  const wanted = new Set(
    key
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  if (wanted.size === 0) return 0
  return list.filter((f) => wanted.has(String(f.mechanism_id || '').toLowerCase())).length
}

export function findingsExceedFailThreshold(
  findings: Iterable<ResourceFindingCandidateV1>,
  failOn: string,
  maxAtOrAbove = 0,
): boolean {
  return countGateFindings(findings, failOn) > maxAtOrAbove
}

export function formatAnalyzeGateFailureMessage(
  findings: Iterable<ResourceFindingCandidateV1>,
  failOn: string,
  maxAtOrAbove = 0,
): string {
  const list = [...findings]
  const bad = countGateFindings(list, failOn)
  const matching = listMatchingFindings(list, failOn)
  const top = new Map<string, number>()
  for (const f of matching) {
    const id = f.mechanism_id || 'unknown'
    top.set(id, (top.get(id) || 0) + 1)
  }
  const topStr =
    [...top.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, count]) => `${name} x${count}`)
      .join(', ') || 'n/a'
  const limit = maxAtOrAbove > 0 ? ` (max ${maxAtOrAbove})` : ''
  return (
    `NetGreener gate failed: ${bad} candidate(s) matching '${failOn}'${limit} ` +
    `(${list.length} total). Top: ${topStr}`
  )
}

function listMatchingFindings(
  findings: ResourceFindingCandidateV1[],
  failOn: string,
): ResourceFindingCandidateV1[] {
  const key = normalizeFailOn(failOn)
  if (!key || key === 'none' || key === 'off') return []
  if (key === 'any' || key === 'candidate') return findings
  const wanted = new Set(
    key
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  return findings.filter((f) => wanted.has(String(f.mechanism_id || '').toLowerCase()))
}

export type AnalyzeGateSummaryV0 = {
  schema: 'netgreener_analyze_gate_summary_v0'
  upload: 'never'
  ok: boolean
  exit_code: 0 | 1
  project_id: string
  files_scanned: number
  findings_total: number
  by_mechanism: Record<string, number>
  gate: null | {
    fail_on: string
    max_at_or_above: number
    matching: number
    exceeded: boolean
    message: string | null
  }
}

/** Machine-readable CI annotation payload (no upload). */
export function buildAnalyzeGateSummary(input: {
  projectId: string
  filesScanned: number
  findings: ResourceFindingCandidateV1[]
  failOn?: string | null
  maxAtOrAbove?: number | null
}): AnalyzeGateSummaryV0 {
  const findings = [...input.findings]
  const by_mechanism: Record<string, number> = {}
  for (const f of findings) {
    by_mechanism[f.mechanism_id] = (by_mechanism[f.mechanism_id] || 0) + 1
  }

  const limit = resolveAnalyzeGateLimit(input.failOn, input.maxAtOrAbove)
  if (!input.failOn || limit == null) {
    return {
      schema: 'netgreener_analyze_gate_summary_v0',
      upload: 'never',
      ok: true,
      exit_code: 0,
      project_id: input.projectId,
      files_scanned: input.filesScanned,
      findings_total: findings.length,
      by_mechanism,
      gate: null,
    }
  }

  const matching = countGateFindings(findings, input.failOn)
  const exceeded = matching > limit
  return {
    schema: 'netgreener_analyze_gate_summary_v0',
    upload: 'never',
    ok: !exceeded,
    exit_code: exceeded ? 1 : 0,
    project_id: input.projectId,
    files_scanned: input.filesScanned,
    findings_total: findings.length,
    by_mechanism,
    gate: {
      fail_on: input.failOn,
      max_at_or_above: limit,
      matching,
      exceeded,
      message: exceeded
        ? formatAnalyzeGateFailureMessage(findings, input.failOn, limit)
        : null,
    },
  }
}
