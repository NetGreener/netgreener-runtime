/**
 * Optimize / verify IR for local JS/TS MP4 providers.
 *
 * Does not call api_server /optimize/*, does not invent measured savings.
 */

import type { ResourceFindingCandidateV1 } from '../analyze/resourceFindingCandidate.js'

export type OptimizeActionKind =
  | 'review_and_limit'
  | 'batch_or_debounce'
  | 'cache_or_memoize'
  | 'stream_or_bound'
  | 'backoff_or_cap'
  | 'idle_or_event'
  | 'manual_review'

export type OptimizePatchV0 = {
  schema: 'optimize_patch_v0'
  path: string
  /** Full file content after the safe transform (not a unified diff). */
  new_content: string
  /** Short description of the mechanical rule applied. */
  rule_id: string
  summary: string
}

export type OptimizeProposalV0 = {
  schema: 'optimize_proposal_v0'
  proposal_id: string
  finding_id: string
  mechanism_id: string
  primary_domain: string
  title: string
  action_kind: OptimizeActionKind
  guidance: string
  scope: ResourceFindingCandidateV1['scope']
  /** True only when a deterministic safe patch rule matched. */
  auto_apply_safe: boolean
  patch: OptimizePatchV0 | null
}

export type OptimizeResultV0 = {
  schema: 'optimize_result_v0'
  contract_status: 'optimizer_provider_local_v0'
  project_id: string
  project_dir: string
  findings_considered: number
  proposals: OptimizeProposalV0[]
  stats: {
    proposals: number
    auto_apply_safe: number
    by_mechanism: Record<string, number>
    by_action_kind: Record<string, number>
  }
  notes: string[]
  verification?: VerificationResultV0
  apply?: OptimizeApplyResultV0
}

export type VerifyGateId = 'syntax' | 'typecheck' | 'test' | 'build'

export type VerifyGateOutcome = {
  gate: VerifyGateId
  status: 'pass' | 'fail' | 'skipped' | 'not_applicable'
  detail: string
  command?: string
  duration_ms?: number
}

export type VerificationResultV0 = {
  schema: 'verification_result_v0'
  provider_id: string
  provider_version: string
  project_dir: string
  ok: boolean
  gates: VerifyGateOutcome[]
  notes: string[]
}

export type OptimizeApplyResultV0 = {
  schema: 'optimize_apply_result_v0'
  applied: Array<{ proposal_id: string; path: string; rule_id: string }>
  skipped: Array<{ proposal_id: string; reason: string }>
  rolled_back: boolean
  verification_before_ok: boolean
  verification_after_ok: boolean | null
}
