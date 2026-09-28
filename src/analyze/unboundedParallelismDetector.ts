/**
 * Heuristic JS/TS twin of Python ``unbounded_asyncio_gather_with_io``.
 *
 * RD0 disposition → mechanism ``unbounded_parallelism`` / ``network.io``.
 * Flags ``Promise.all(…map…fetch)`` style fan-out without an obvious concurrency cap.
 */

import {
  hasApiCall,
  PROMISE_ALL_RE,
  stripLineComment,
} from './heuristicScan.js'
import {
  languageForPath,
  type ResourceCandidateHit,
} from './resourceFindingCandidate.js'

const DETECTOR_ID = 'js.static.unbounded_promise_all'
const DETECTOR_VERSION = '0.1.0'
const LEGACY_ISSUE = 'unbounded_asyncio_gather_with_io'
const MECHANISM = 'unbounded_parallelism'
const TITLE = 'Unbounded Promise.all fan-out may spike concurrent I/O cost'

/** Obvious concurrency caps we treat as not-unbounded (heuristic). */
const CAP_HINT_RE =
  /\b(?:pLimit|p-limit|bottleneck|Semaphore|mapLimit|eachLimit|PromisePool|concurrency\s*:)\b/i

/**
 * Detect unbounded Promise.all + API fan-out in one source file.
 */
export function detectUnboundedParallelismHits(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const lines = source.split(/\r?\n/)
  const hits: ResourceCandidateHit[] = []
  const language = languageForPath(relPath)
  const path = relPath.replace(/\\/g, '/')

  for (let i = 0; i < lines.length; i += 1) {
    const line = stripLineComment(lines[i] ?? '')
    const lineNo = i + 1
    if (!PROMISE_ALL_RE.test(line)) continue

    // Look at this line + next 2 for map/fetch / API signals and cap hints.
    const window = [line, stripLineComment(lines[i + 1] ?? ''), stripLineComment(lines[i + 2] ?? '')]
      .join(' ')
    if (CAP_HINT_RE.test(window)) continue
    const hasFanOut =
      /\.map\s*\(/.test(window) || /\.flatMap\s*\(/.test(window) || hasApiCall(window)
    if (!hasFanOut) continue
    if (!hasApiCall(window) && !/\.map\s*\(/.test(window)) continue
    // Require API somewhere in the window (avoid Promise.all(localCpuWork))
    if (!hasApiCall(window)) continue

    hits.push({
      mechanism_id: MECHANISM,
      primary_domain: 'network.io',
      admission_domain: 'network.io',
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

  return hits
}
