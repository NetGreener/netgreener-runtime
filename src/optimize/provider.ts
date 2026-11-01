/**
 * Local JS/TS OptimizerProvider — proposals + optional deterministic safe patches.
 *
 * Authority: OPTIMIZE_STUB.md / MULTI_LANGUAGE_PLATFORM_PLAN MP4.
 * Explicit non-goals: LLM /optimize/function, silent patches without VerificationProvider.
 */

import { createHash } from 'node:crypto'

import type { ResourceFindingCandidateV1 } from '../analyze/resourceFindingCandidate.js'
import { tryBuildSafePatch } from './safePatches.js'
import type {
  OptimizeActionKind,
  OptimizeProposalV0,
  OptimizeResultV0,
} from './types.js'

export type OptimizerProvider = {
  readonly id: string
  readonly version: string
  proposeFromFindings(
    findings: ResourceFindingCandidateV1[],
    opts: { projectId: string; projectDir: string },
  ): OptimizeResultV0
}

const GUIDANCE: Record<string, { action: OptimizeActionKind; text: string }> = {
  unbounded_parallelism: {
    action: 'review_and_limit',
    text:
      'Cap concurrency (p-limit / Promise pool / worker count). Prefer bounded ' +
      'queues over unbounded Promise.all on large collections.',
  },
  retry_amplification: {
    action: 'backoff_or_cap',
    text:
      'Add exponential backoff, jitter, and a hard retry ceiling. Avoid nested ' +
      'retries that multiply outbound calls under failure.',
  },
  external_api_overconsumption: {
    action: 'batch_or_debounce',
    text:
      'Batch or debounce outbound calls, reuse connections, and cache idempotent ' +
      'reads. Prefer one request per logical unit of work.',
  },
  per_item_instead_of_batch: {
    action: 'batch_or_debounce',
    text:
      'Replace per-item remote/DB work with a batch API or a single query. ' +
      'Keep N+1 patterns out of hot paths.',
  },
  repeated_work: {
    action: 'cache_or_memoize',
    text:
      'Memoize or cache repeated pure/expensive work within the request/task ' +
      'scope. Deduplicate identical lookups.',
  },
  polling_or_idle_work: {
    action: 'idle_or_event',
    text:
      'Replace tight polling with event-driven waits, longer intervals, or ' +
      'backoff when idle. Avoid busy-spin loops.',
  },
  memory_retention_or_materialization: {
    action: 'stream_or_bound',
    text:
      'Stream or page large payloads instead of materializing full arrays. ' +
      'Bound caches and clear references after use.',
  },
  process_or_runtime_churn: {
    action: 'manual_review',
    text:
      'Reduce process spawn / worker churn — reuse long-lived workers or pool ' +
      'them. Confirm the spawn is required per unit of work.',
  },
}

function proposalId(findingId: string, mechanism: string): string {
  return createHash('sha256')
    .update(`opt:${findingId}:${mechanism}`)
    .digest('hex')
    .slice(0, 16)
}

function guidanceFor(mechanismId: string): { action: OptimizeActionKind; text: string } {
  return (
    GUIDANCE[mechanismId] || {
      action: 'manual_review' as const,
      text:
        'Admitted resource candidate — review the indicated scope and apply a ' +
        'bounded resource fix. Automatic patches require a matching safe rule + VerificationProvider.',
    }
  )
}

export function createLocalJsTsOptimizerProvider(): OptimizerProvider {
  return {
    id: 'local_js_ts_optimizer_v0',
    version: '0.2.0',
    proposeFromFindings(findings, opts) {
      const proposals: OptimizeProposalV0[] = []
      const by_mechanism: Record<string, number> = {}
      const by_action_kind: Record<string, number> = {}
      let auto_apply_safe = 0

      for (const f of findings) {
        if (f.evidence_state !== 'candidate') continue
        const g = guidanceFor(f.mechanism_id)
        const safe = tryBuildSafePatch(f, opts.projectDir)
        const proposal: OptimizeProposalV0 = {
          schema: 'optimize_proposal_v0',
          proposal_id: proposalId(f.finding_id, f.mechanism_id),
          finding_id: f.finding_id,
          mechanism_id: f.mechanism_id,
          primary_domain: f.primary_domain,
          title: f.title,
          action_kind: g.action,
          guidance: g.text,
          scope: f.scope,
          auto_apply_safe: Boolean(safe),
          patch: safe?.patch ?? null,
        }
        if (safe) auto_apply_safe += 1
        proposals.push(proposal)
        by_mechanism[f.mechanism_id] = (by_mechanism[f.mechanism_id] || 0) + 1
        by_action_kind[g.action] = (by_action_kind[g.action] || 0) + 1
      }

      return {
        schema: 'optimize_result_v0',
        contract_status: 'optimizer_provider_local_v0',
        project_id: opts.projectId,
        project_dir: opts.projectDir,
        findings_considered: findings.length,
        proposals,
        stats: {
          proposals: proposals.length,
          auto_apply_safe,
          by_mechanism,
          by_action_kind,
        },
        notes: [
          'Local JS/TS OptimizerProvider — guidance for all admitted candidates.',
          'auto_apply_safe patches are deterministic only (no LLM / no /optimize/*).',
          'File writes require --apply + VerificationProvider gates.',
          'No measured energy/cost savings claimed.',
        ],
      }
    },
  }
}
