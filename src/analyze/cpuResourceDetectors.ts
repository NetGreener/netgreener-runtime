/**
 * Heuristic JS/TS twins for local CPU-ish RD0 candidate_map rules:
 *   - sleep_polling → polling_or_idle_work / compute.cpu
 *   - regex_compile_in_loop / string_concat_in_loop → repeated_work / compute.cpu
 *   - subprocess_in_loop → process_or_runtime_churn / compute.cpu
 *   - model_load_in_loop → process_or_runtime_churn / compute.cpu
 *   - unvectorized_nested_loops → per_item_instead_of_batch / compute.cpu
 *   - inference_inside_loop → per_item_instead_of_batch / compute.gpu
 *
 * Skips low-energy ``print_in_loop`` (Python always-downgrade class).
 * Skips ML-only training gates (``no_early_stopping`` / ``no_lr_scheduler`` /
 * ``no_mixed_precision`` → excess_training_work / accelerator_underutilization).
 */

import {
  forEachSourceLine,
  INFERENCE_RE,
  MODEL_LOAD_RE,
  NESTED_LOOKUP_RE,
  REGEX_COMPILE_RE,
  SLEEP_POLL_RE,
  STRING_CONCAT_RE,
  SUBPROCESS_RE,
} from './heuristicScan.js'
import {
  languageForPath,
  type ResourceCandidateHit,
  type ResourcePrimaryDomain,
} from './resourceFindingCandidate.js'

const DETECTOR_VERSION = '0.1.0'

function baseHit(
  relPath: string,
  lineNo: number,
  language: 'javascript' | 'typescript',
  opts: {
    mechanism_id: string
    primary_domain?: ResourcePrimaryDomain
    title: string
    detector_id: string
    legacy_issue_type: string
  },
): ResourceCandidateHit {
  const primary = opts.primary_domain ?? 'compute.cpu'
  return {
    mechanism_id: opts.mechanism_id,
    primary_domain: primary,
    admission_domain: primary,
    title: opts.title,
    rel_path: relPath,
    start_line: lineNo,
    end_line: lineNo,
    language,
    detector_id: opts.detector_id,
    detector_version: DETECTOR_VERSION,
    legacy_issue_type: opts.legacy_issue_type,
  }
}

/** Python ``sleep_polling`` twin. */
export function detectPollingIdleHits(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const hits: ResourceCandidateHit[] = []
  const language = languageForPath(relPath)
  const path = relPath.replace(/\\/g, '/')
  forEachSourceLine(source, ({ line, lineNo, inLoop }) => {
    if (!inLoop || !SLEEP_POLL_RE.test(line)) return
    hits.push(
      baseHit(path, lineNo, language, {
        mechanism_id: 'polling_or_idle_work',
        title: 'Sleep/delay inside loop may burn CPU with idle wakeups',
        detector_id: 'js.static.sleep_polling',
        legacy_issue_type: 'sleep_polling',
      }),
    )
  })
  return hits
}

/** Python ``regex_compile_in_loop`` + ``string_concat_in_loop`` twins. */
export function detectRepeatedWorkHits(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const hits: ResourceCandidateHit[] = []
  const language = languageForPath(relPath)
  const path = relPath.replace(/\\/g, '/')
  forEachSourceLine(source, ({ line, lineNo, inLoop }) => {
    if (!inLoop) return
    if (REGEX_COMPILE_RE.test(line)) {
      hits.push(
        baseHit(path, lineNo, language, {
          mechanism_id: 'repeated_work',
          title: 'RegExp compiled inside loop may repeat avoidable CPU work',
          detector_id: 'js.static.regex_compile_in_loop',
          legacy_issue_type: 'regex_compile_in_loop',
        }),
      )
    }
    if (STRING_CONCAT_RE.test(line)) {
      hits.push(
        baseHit(path, lineNo, language, {
          mechanism_id: 'repeated_work',
          title: 'String concatenation inside loop may repeat avoidable CPU work',
          detector_id: 'js.static.string_concat_in_loop',
          legacy_issue_type: 'string_concat_in_loop',
        }),
      )
    }
  })
  return hits
}

/** Python ``subprocess_in_loop`` twin (child_process spawn/exec). */
export function detectProcessChurnHits(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const hits: ResourceCandidateHit[] = []
  const language = languageForPath(relPath)
  const path = relPath.replace(/\\/g, '/')
  const mentionsChildProcess =
    /\bchild_process\b|\bnode:child_process\b/.test(source) ||
    /\bfrom\s+['"](?:node:)?child_process['"]/.test(source) ||
    /\brequire\(\s*['"](?:node:)?child_process['"]\s*\)/.test(source)

  forEachSourceLine(source, ({ line, lineNo, inLoop }) => {
    if (!inLoop || !SUBPROCESS_RE.test(line)) return
    // Avoid flagging unrelated ``spawn`` names unless child_process is in file,
    // except execSync/spawnSync which are strongly Node subprocess APIs.
    const strong =
      /\b(?:execSync|spawnSync|execFileSync|fork)\s*\(/.test(line) ||
      mentionsChildProcess
    if (!strong) return
    hits.push(
      baseHit(path, lineNo, language, {
        mechanism_id: 'process_or_runtime_churn',
        title: 'Subprocess spawn/exec inside loop may repeat process churn',
        detector_id: 'js.static.subprocess_in_loop',
        legacy_issue_type: 'subprocess_in_loop',
      }),
    )
  })
  return hits
}

/**
 * Python ``model_load_in_loop`` twin (TF.js / ONNX / transformers loaders,
 * or dynamic import/require of heavy model packages inside a loop).
 */
export function detectModelLoadInLoopHits(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const hits: ResourceCandidateHit[] = []
  const language = languageForPath(relPath)
  const path = relPath.replace(/\\/g, '/')
  forEachSourceLine(source, ({ line, lineNo, inLoop }) => {
    if (!inLoop || !MODEL_LOAD_RE.test(line)) return
    hits.push(
      baseHit(path, lineNo, language, {
        mechanism_id: 'process_or_runtime_churn',
        title: 'Model/runtime load inside loop may repeat expensive initialization',
        detector_id: 'js.static.model_load_in_loop',
        legacy_issue_type: 'model_load_in_loop',
      }),
    )
  })
  return hits
}

/**
 * Python ``unvectorized_nested_loops`` twin: array lookup inside nested loops
 * (O(n²) per-item scan instead of a batched/indexed path).
 */
export function detectPerItemInsteadOfBatchHits(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const hits: ResourceCandidateHit[] = []
  const language = languageForPath(relPath)
  const path = relPath.replace(/\\/g, '/')
  forEachSourceLine(source, ({ line, lineNo, loopDepth }) => {
    if (loopDepth < 2 || !NESTED_LOOKUP_RE.test(line)) return
    hits.push(
      baseHit(path, lineNo, language, {
        mechanism_id: 'per_item_instead_of_batch',
        title:
          'Nested-loop array lookup may scan per item instead of a batched/indexed path',
        detector_id: 'js.static.unvectorized_nested_loops',
        legacy_issue_type: 'unvectorized_nested_loops',
      }),
    )
  })
  return hits
}

/**
 * Python ``inference_inside_loop`` twin (TF.js predict / ONNX session.run /
 * executeAsync inside a loop → per-item instead of batch; compute.gpu).
 */
export function detectInferenceInsideLoopHits(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const hits: ResourceCandidateHit[] = []
  const language = languageForPath(relPath)
  const path = relPath.replace(/\\/g, '/')
  forEachSourceLine(source, ({ line, lineNo, inLoop }) => {
    if (!inLoop || !INFERENCE_RE.test(line)) return
    hits.push(
      baseHit(path, lineNo, language, {
        mechanism_id: 'per_item_instead_of_batch',
        primary_domain: 'compute.gpu',
        title:
          'Model inference inside loop may run per item instead of a supported batch path',
        detector_id: 'js.static.inference_inside_loop',
        legacy_issue_type: 'inference_inside_loop',
      }),
    )
  })
  return hits
}
