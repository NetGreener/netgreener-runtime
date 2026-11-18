/**
 * Heuristic JS/TS twin of Python ``api_usage_audit.api_call_in_retry_loop``.
 *
 * Maps via RD0 disposition → mechanism ``retry_amplification`` / domain ``external_api``.
 * Not a TypeScript AST yet — brace-depth + line heuristics only.
 */

import {
  advanceBraceDepth,
  hasApiCall,
  RETRY_HEADER_RE,
  stripLineComment,
} from './heuristicScan.js'
import {
  languageForPath,
  type ResourceCandidateHit,
} from './resourceFindingCandidate.js'

const DETECTOR_ID = 'js.static.retry_loop'
const DETECTOR_VERSION = '0.1.0'
const LEGACY_ISSUE = 'api_call_in_retry_loop'
const MECHANISM = 'retry_amplification'
const TITLE = 'Retry loop may amplify billed API attempts'

/**
 * Detect API calls nested in retry-ish loops in one source file.
 */
export function detectRetryAmplificationHits(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const lines = source.split(/\r?\n/)
  const hits: ResourceCandidateHit[] = []
  let braceDepth = 0
  /** Brace depth of the retry loop header line (body is deeper). */
  let retryAtDepth: number | null = null
  const language = languageForPath(relPath)
  const path = relPath.replace(/\\/g, '/')

  for (let i = 0; i < lines.length; i += 1) {
    const line = stripLineComment(lines[i] ?? '')
    const lineNo = i + 1
    const isRetryHeader = RETRY_HEADER_RE.test(line)
    const before = braceDepth
    const { braceDepth: next, openedBrace } = advanceBraceDepth(line, braceDepth)
    braceDepth = next

    if (isRetryHeader && retryAtDepth === null) {
      retryAtDepth = openedBrace ? before : braceDepth
    }
    if (retryAtDepth !== null && braceDepth <= retryAtDepth) {
      retryAtDepth = null
    }

    if (retryAtDepth !== null && braceDepth > retryAtDepth && hasApiCall(line)) {
      hits.push({
        mechanism_id: MECHANISM,
        primary_domain: 'external_api',
        admission_domain: 'external_api',
        title: TITLE,
        rel_path: path,
        start_line: lineNo,
        end_line: lineNo,
        language,
        detector_id: DETECTOR_ID,
        detector_version: DETECTOR_VERSION,
        legacy_issue_type: LEGACY_ISSUE,
      })
    }
  }

  return hits
}
