/**
 * Heuristic JS/TS twins for memory / storage RD0 candidate_map rules:
 *   - repeated_file_reads → repeated_work / storage.io
 *   - full_dataset_in_memory → memory_retention_or_materialization / memory.host
 */

import {
  FILE_READ_RE,
  forEachSourceLine,
  stripLineComment,
} from './heuristicScan.js'
import {
  languageForPath,
  type ResourceCandidateHit,
} from './resourceFindingCandidate.js'

const DETECTOR_VERSION = '0.1.0'
const JSON_PARSE_RE = /\bJSON\.parse\s*\(/

/**
 * Python ``repeated_file_reads`` twin — fs read inside a loop.
 */
export function detectRepeatedFileReadHits(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const hits: ResourceCandidateHit[] = []
  const language = languageForPath(relPath)
  const path = relPath.replace(/\\/g, '/')
  forEachSourceLine(source, ({ line, lineNo, inLoop }) => {
    if (!inLoop || !FILE_READ_RE.test(line)) return
    hits.push({
      mechanism_id: 'repeated_work',
      primary_domain: 'storage.io',
      admission_domain: 'storage.io',
      title: 'File read inside loop may repeat avoidable I/O work',
      rel_path: path,
      start_line: lineNo,
      end_line: lineNo,
      language,
      detector_id: 'js.static.repeated_file_reads',
      detector_version: DETECTOR_VERSION,
      legacy_issue_type: 'repeated_file_reads',
    })
  })
  return hits
}

/**
 * Python ``full_dataset_in_memory`` twin — load+parse entire file payload.
 * Flags JSON.parse(readFile…) on one line, or readFile then JSON.parse within 2 lines.
 */
export function detectFullDatasetInMemoryHits(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const hits: ResourceCandidateHit[] = []
  const language = languageForPath(relPath)
  const path = relPath.replace(/\\/g, '/')
  const lines = source.split(/\r?\n/).map((l) => stripLineComment(l))

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const lineNo = i + 1
    const sameLine = JSON_PARSE_RE.test(line) && FILE_READ_RE.test(line)
    const window = [lines[i + 1] ?? '', lines[i + 2] ?? ''].join('\n')
    const readThenParse = FILE_READ_RE.test(line) && JSON_PARSE_RE.test(window)

    if (!sameLine && !readThenParse) continue

    hits.push({
      mechanism_id: 'memory_retention_or_materialization',
      primary_domain: 'memory.host',
      admission_domain: 'memory.host',
      title: 'Loading and parsing an entire file may retain a full dataset in memory',
      rel_path: path,
      start_line: lineNo,
      end_line: lineNo,
      language,
      detector_id: 'js.static.full_dataset_in_memory',
      detector_version: DETECTOR_VERSION,
      legacy_issue_type: 'full_dataset_in_memory',
    })
  }

  return hits
}
