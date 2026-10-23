/**
 * Prefer TypeScript AST for Analyze detectors; fall back to heuristics.
 * Parses each source at most once via ``detectAllHitsAst``.
 */

import { detectApiOverconsumptionHits } from './apiOverconsumptionDetector.js'
import {
  detectAllHitsAst,
  type AstHitBundle,
} from './astDetectors.js'
import {
  detectInferenceInsideLoopHits,
  detectModelLoadInLoopHits,
  detectPollingIdleHits,
  detectPerItemInsteadOfBatchHits,
  detectProcessChurnHits,
  detectRepeatedWorkHits,
} from './cpuResourceDetectors.js'
import {
  detectFullDatasetInMemoryHits,
  detectRepeatedFileReadHits,
} from './memoryIoDetectors.js'
import { detectRetryAmplificationHits } from './retryAmplificationDetector.js'
import { detectUnboundedParallelismHits } from './unboundedParallelismDetector.js'
import type { ResourceCandidateHit } from './resourceFindingCandidate.js'

function prefer(
  astHits: ResourceCandidateHit[] | null | undefined,
  fallback: () => ResourceCandidateHit[],
): ResourceCandidateHit[] {
  if (astHits !== null && astHits !== undefined) return astHits
  return fallback()
}

/** Collect all prefer-AST hits for one source file (single parse when TS available). */
export function collectPreferAstHits(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const bundle: AstHitBundle | null = detectAllHitsAst(source, relPath)
  if (bundle) {
    return [
      ...bundle.retry,
      ...bundle.overconsumption,
      ...bundle.unbounded,
      ...bundle.polling,
      ...bundle.repeatedWork,
      ...bundle.processChurn,
      ...bundle.modelLoad,
      ...bundle.inference,
      ...bundle.fileReads,
      ...bundle.fullDataset,
      ...bundle.perItem,
    ]
  }
  return [
    ...detectRetryAmplificationHits(source, relPath),
    ...detectApiOverconsumptionHits(source, relPath),
    ...detectUnboundedParallelismHits(source, relPath),
    ...detectPollingIdleHits(source, relPath),
    ...detectRepeatedWorkHits(source, relPath),
    ...detectProcessChurnHits(source, relPath),
    ...detectModelLoadInLoopHits(source, relPath),
    ...detectInferenceInsideLoopHits(source, relPath),
    ...detectRepeatedFileReadHits(source, relPath),
    ...detectFullDatasetInMemoryHits(source, relPath),
    ...detectPerItemInsteadOfBatchHits(source, relPath),
  ]
}

export function detectRetryAmplificationHitsPreferAst(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const bundle = detectAllHitsAst(source, relPath)
  return prefer(bundle?.retry ?? null, () => detectRetryAmplificationHits(source, relPath))
}

export function detectRepeatedFileReadHitsPreferAst(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const bundle = detectAllHitsAst(source, relPath)
  return prefer(bundle?.fileReads ?? null, () =>
    detectRepeatedFileReadHits(source, relPath),
  )
}

export function detectApiOverconsumptionHitsPreferAst(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const bundle = detectAllHitsAst(source, relPath)
  return prefer(bundle?.overconsumption ?? null, () =>
    detectApiOverconsumptionHits(source, relPath),
  )
}

export function detectUnboundedParallelismHitsPreferAst(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const bundle = detectAllHitsAst(source, relPath)
  return prefer(bundle?.unbounded ?? null, () =>
    detectUnboundedParallelismHits(source, relPath),
  )
}

export function detectPollingIdleHitsPreferAst(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const bundle = detectAllHitsAst(source, relPath)
  return prefer(bundle?.polling ?? null, () => detectPollingIdleHits(source, relPath))
}

export function detectRepeatedWorkHitsPreferAst(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const bundle = detectAllHitsAst(source, relPath)
  return prefer(bundle?.repeatedWork ?? null, () => detectRepeatedWorkHits(source, relPath))
}

export function detectProcessChurnHitsPreferAst(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const bundle = detectAllHitsAst(source, relPath)
  return prefer(bundle?.processChurn ?? null, () => detectProcessChurnHits(source, relPath))
}

export function detectFullDatasetInMemoryHitsPreferAst(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const bundle = detectAllHitsAst(source, relPath)
  return prefer(bundle?.fullDataset ?? null, () =>
    detectFullDatasetInMemoryHits(source, relPath),
  )
}

export function detectPerItemInsteadOfBatchHitsPreferAst(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const bundle = detectAllHitsAst(source, relPath)
  return prefer(bundle?.perItem ?? null, () =>
    detectPerItemInsteadOfBatchHits(source, relPath),
  )
}

export function detectModelLoadInLoopHitsPreferAst(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const bundle = detectAllHitsAst(source, relPath)
  return prefer(bundle?.modelLoad ?? null, () =>
    detectModelLoadInLoopHits(source, relPath),
  )
}

export function detectInferenceInsideLoopHitsPreferAst(
  source: string,
  relPath: string,
): ResourceCandidateHit[] {
  const bundle = detectAllHitsAst(source, relPath)
  return prefer(bundle?.inference ?? null, () =>
    detectInferenceInsideLoopHits(source, relPath),
  )
}
