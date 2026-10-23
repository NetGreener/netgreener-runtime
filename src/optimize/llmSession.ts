/**
 * Opt-in LLM optimize via shared api_server ``POST /optimize/function``.
 *
 * Owner OK 2026-10-02. Default ``netgreener optimize`` stays local (no LLM).
 * ``--llm`` calls the same brain as Python/VSCE — does not invent savings,
 * does not flip EXPORT_MODE. Opt-in ``--apply-verified`` writes via
 * VerificationProvider (see llmApply.ts) — never via local ``--apply``.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ResourceFindingCandidateV1 } from '../analyze/resourceFindingCandidate.js'
import { NetGreenerClient, ApiError } from '../sdk/client.js'

export type OptimizeLlmRequest = {
  project_id: number
  file_path: string
  function_code: string
  language?: string
  issue_type?: string
  severity?: string
  description?: string
  focus_line?: number
  line_start?: number
  finding_id?: number
  force?: boolean
  user_llm_provider?: string
  user_llm_key?: string
  user_llm_endpoint?: string
  user_llm_model?: string
}

export type OptimizeLlmResult = {
  optimized_code: string
  explanation: string
  energy_note: string
  confidence: string
  model: string
  no_change_needed?: boolean
  review_passed?: boolean
  review_notes?: string
  apply_recommended?: boolean
  patch?: string | null
}

export type LlmOptimizeSessionItem = {
  finding_id: string
  mechanism_id: string
  file_path: string
  focus_line: number
  /** 1-based inclusive snippet range used for /optimize/function (for verified apply). */
  line_start?: number
  line_end?: number
  ok: boolean
  error?: string
  result?: OptimizeLlmResult
}

export type LlmOptimizeSessionV0 = {
  schema: 'optimize_llm_session_v0'
  project_id: number
  project_dir: string
  candidates_considered: number
  items: LlmOptimizeSessionItem[]
  notes: string[]
}

const MAX_SNIPPET_CHARS = 24_000
const DEFAULT_MAX_FINDINGS = 5

export function extractSnippetFromFinding(
  projectDir: string,
  finding: ResourceFindingCandidateV1,
  opts?: { padLines?: number },
): {
  path: string
  code: string
  focusLine: number
  lineStart: number
  lineEnd: number
} | null {
  const loc = finding.scope?.source_locations?.[0]
  if (!loc?.path || !loc.start_line) return null
  const abs = join(projectDir, loc.path)
  let text: string
  try {
    text = readFileSync(abs, 'utf8')
  } catch {
    return null
  }
  const lines = text.split(/\r?\n/)
  const pad = opts?.padLines ?? 2
  const start = Math.max(1, loc.start_line - pad)
  const end = Math.min(lines.length, Math.max(loc.end_line || loc.start_line, loc.start_line) + pad)
  const code = lines.slice(start - 1, end).join('\n')
  if (!code.trim()) return null
  const clipped =
    code.length > MAX_SNIPPET_CHARS
      ? `${code.slice(0, MAX_SNIPPET_CHARS)}\n/* …truncated… */`
      : code
  return {
    path: loc.path.replace(/\\/g, '/'),
    code: clipped,
    focusLine: loc.start_line,
    lineStart: start,
    lineEnd: end,
  }
}

export type RunLlmOptimizeSessionOptions = {
  projectDir: string
  projectId: number
  findings: ResourceFindingCandidateV1[]
  token: string
  apiUrl?: string
  maxFindings?: number
  fetchImpl?: typeof fetch
  /** Optional BYOK — same fields as OptimizeFunctionRequest. */
  byok?: {
    provider?: string
    key?: string
    endpoint?: string
    model?: string
  }
}

/**
 * Call api_server /optimize/function for up to N local Node candidates.
 * Never writes files. Never claims measured savings.
 */
export async function runLlmOptimizeSession(
  opts: RunLlmOptimizeSessionOptions,
): Promise<LlmOptimizeSessionV0> {
  const max = Math.max(1, Math.min(opts.maxFindings ?? DEFAULT_MAX_FINDINGS, 20))
  const client = new NetGreenerClient({
    token: opts.token,
    baseUrl: opts.apiUrl,
    fetchImpl: opts.fetchImpl,
  })
  const items: LlmOptimizeSessionItem[] = []
  const notes = [
    'LLM optimize uses shared api_server POST /optimize/function (same brain as Python/VSCE).',
    'No measured energy/cost savings claimed.',
    'Default: review-only JSON. Opt-in write: --llm --apply-verified (VerificationProvider).',
    'Default netgreener optimize (without --llm) remains local deterministic proposals only.',
  ]

  const batch = opts.findings.slice(0, max)
  for (const finding of batch) {
    const snippet = extractSnippetFromFinding(opts.projectDir, finding)
    const loc = finding.scope?.source_locations?.[0]
    const filePath = loc?.path || finding.scope?.id || 'unknown'
    if (!snippet) {
      items.push({
        finding_id: finding.finding_id,
        mechanism_id: finding.mechanism_id,
        file_path: filePath,
        focus_line: loc?.start_line || 0,
        ok: false,
        error: 'Could not read source snippet',
      })
      continue
    }
    try {
      const result = (await client.optimizeFunction({
        project_id: opts.projectId,
        file_path: snippet.path,
        function_code: snippet.code,
        language: finding.scope.language === 'typescript' ? 'typescript' : 'javascript',
        issue_type: finding.mechanism_id,
        description: finding.title,
        focus_line: snippet.focusLine,
        line_start: snippet.lineStart,
        force: true,
        ...(opts.byok?.provider
          ? {
              user_llm_provider: opts.byok.provider,
              user_llm_key: opts.byok.key,
              user_llm_endpoint: opts.byok.endpoint,
              user_llm_model: opts.byok.model,
            }
          : {}),
      })) as OptimizeLlmResult
      items.push({
        finding_id: finding.finding_id,
        mechanism_id: finding.mechanism_id,
        file_path: snippet.path,
        focus_line: snippet.focusLine,
        line_start: snippet.lineStart,
        line_end: snippet.lineEnd,
        ok: true,
        result,
      })
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? `HTTP ${err.statusCode}: ${err.detail}`
          : err instanceof Error
            ? err.message
            : String(err)
      items.push({
        finding_id: finding.finding_id,
        mechanism_id: finding.mechanism_id,
        file_path: snippet.path,
        focus_line: snippet.focusLine,
        line_start: snippet.lineStart,
        line_end: snippet.lineEnd,
        ok: false,
        error: msg,
      })
    }
  }

  return {
    schema: 'optimize_llm_session_v0',
    project_id: opts.projectId,
    project_dir: opts.projectDir,
    candidates_considered: opts.findings.length,
    items,
    notes,
  }
}
