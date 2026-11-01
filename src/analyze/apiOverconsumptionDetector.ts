/**
 * Heuristic JS/TS twins of Python API overconsumption rules:
 *   - api_call_in_comprehension
 *   - network_call_in_loop / paid_api_in_loop (non-retry loops)
 *
 * RD0 disposition → mechanism ``external_api_overconsumption`` / ``external_api``.
 * Skips retry loops (owned by retry_amplification detector).
 */

import {
  advanceBraceDepth,
  COMPREHENSION_RE,
  hasApiCall,
  LOOP_HEADER_RE,
  PROMISE_ALL_RE,
  RETRY_HEADER_RE,
  stripLineComment,
} from './heuristicScan.js'
import {
  languageForPath,
  type ResourceCandidateHit,
} from './resourceFindingCandidate.js'

const DETECTOR_VERSION = '0.1.0'
const MECHANISM = 'external_api_overconsumption'
const TITLE_COMP = 'API call inside map/filter may multiply billed attempts'
const TITLE_LOOP = 'API call inside loop may multiply billed attempts'

function hitBase(
  relPath: string,
  lineNo: number,
  language: 'javascript' | 'typescript',
  legacy: string,
  detectorId: string,
  title: string,
): ResourceCandidateHit {
  return {
    mechanism_id: MECHANISM,
    primary_domain: 'external_api',
    admission_domain: 'external_api',
    title,
    rel_path: relPath,
    start_line: lineNo,
    end_line: lineNo,
    language,
    detector_id: detectorId,
    detector_version: DETECTOR_VERSION,
    legacy_issue_type: legacy,
  }
}

/**
 * Detect API calls inside array comprehensions (.map / .flatMap / …) or plain loops.
 */
export function detectApiOverconsumptionHits(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const lines = source.split(/\r?\n/)
  const hits: ResourceCandidateHit[] = []
  let braceDepth = 0
  let loopAtDepth: number | null = null
  let inRetryLoop = false
  const language = languageForPath(relPath)
  const path = relPath.replace(/\\/g, '/')

  for (let i = 0; i < lines.length; i += 1) {
    const line = stripLineComment(lines[i] ?? '')
    const lineNo = i + 1
    const isRetryHeader = RETRY_HEADER_RE.test(line)
    const isLoopHeader = LOOP_HEADER_RE.test(line)
    const before = braceDepth
    const { braceDepth: next, openedBrace } = advanceBraceDepth(line, braceDepth)
    braceDepth = next

    if (isRetryHeader) {
      inRetryLoop = true
      loopAtDepth = openedBrace ? before : braceDepth
    } else if (isLoopHeader && loopAtDepth === null) {
      inRetryLoop = false
      loopAtDepth = openedBrace ? before : braceDepth
    }

    if (loopAtDepth !== null && braceDepth <= loopAtDepth) {
      loopAtDepth = null
      inRetryLoop = false
    }

    // Same-line comprehension + API — skip Promise.all (owned by unbounded detector)
    if (COMPREHENSION_RE.test(line) && hasApiCall(line) && !PROMISE_ALL_RE.test(line)) {
      hits.push(
        hitBase(
          path,
          lineNo,
          language,
          'api_call_in_comprehension',
          'js.static.api_in_comprehension',
          TITLE_COMP,
        ),
      )
      continue
    }

    // Nested body of a non-retry loop
    if (
      loopAtDepth !== null &&
      !inRetryLoop &&
      braceDepth > loopAtDepth &&
      hasApiCall(line)
    ) {
      hits.push(
        hitBase(
          path,
          lineNo,
          language,
          'network_call_in_loop',
          'js.static.api_in_loop',
          TITLE_LOOP,
        ),
      )
    }
  }

  return hits
}
