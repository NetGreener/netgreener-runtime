/**
 * MP4 Node twin of Python resource-candidate IR (``resource_finding_v1``).
 *
 * Emits **candidates** only (evidence_state=candidate). Does not upload, does not
 * change RunSession, and does not claim Optimize / verified savings.
 */

import { createHash } from 'node:crypto'

import { admitAnalyzeCandidate } from './resourceAdmission.js'

/** Contract primary_domain values used by Node Analyze candidates. */
export type ResourcePrimaryDomain =
  | 'compute.cpu'
  | 'compute.gpu'
  | 'memory.host'
  | 'memory.gpu'
  | 'storage.io'
  | 'network.io'
  | 'external_api'

export type ResourceFindingCandidateV1 = {
  schema_version: 'resource_finding_v1'
  finding_id: string
  project_id: string
  evidence_state: 'candidate'
  comparison_origin: 'none'
  lifecycle_status: 'pending_admission'
  verification_outcome: 'not_run'
  primary_domain: ResourcePrimaryDomain
  mechanism_id: string
  title: string
  scope: {
    kind: 'function' | 'service_unit' | 'task' | 'script'
    id: string
    language: 'javascript' | 'typescript'
    runtime: 'nodejs'
    source_locations: Array<{
      path: string
      start_line: number
      end_line: number
      symbol?: string
    }>
  }
  lineage: {
    detector_id: string
    detector_version: string
    policy_version: string
    observation_ids: string[]
    benchmark_result_ids: string[]
  }
}

export type ResourceCandidateHit = {
  mechanism_id: string
  primary_domain: ResourcePrimaryDomain
  /** Short domain key for local admission stub (e.g. external_api). */
  admission_domain: string
  title: string
  rel_path: string
  start_line: number
  end_line: number
  symbol?: string
  language: 'javascript' | 'typescript'
  detector_id: string
  detector_version: string
  legacy_issue_type?: string
  /** Optional reject category — when set, must pass default-deny. */
  category?: string
}

const POLICY_VERSION = '0.1.0'

function languageFromPath(relPath: string): 'javascript' | 'typescript' {
  const lower = relPath.toLowerCase()
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript'
  return 'javascript'
}

function stableFindingId(hit: ResourceCandidateHit, projectId: string): string {
  const preimage = [
    projectId,
    hit.mechanism_id,
    hit.rel_path,
    String(hit.start_line),
    hit.detector_id,
  ].join('|')
  const digest = createHash('sha256').update(preimage).digest('hex').slice(0, 12)
  return `rf_${hit.mechanism_id.slice(0, 24)}_${digest}`
}

/**
 * Shape a detector hit into ``resource_finding_v1`` candidate, or null if denied.
 */
export function toResourceFindingCandidate(
  hit: ResourceCandidateHit,
  projectId = 'local',
): ResourceFindingCandidateV1 | null {
  const decision = admitAnalyzeCandidate({
    domain: hit.admission_domain,
    category: hit.category,
  })
  if (!decision.admitted) return null

  const language = hit.language || languageFromPath(hit.rel_path)
  const scopeId = (hit.symbol || hit.rel_path).slice(0, 200)
  return {
    schema_version: 'resource_finding_v1',
    finding_id: stableFindingId(hit, projectId).slice(0, 128),
    project_id: String(projectId || 'local').slice(0, 64),
    evidence_state: 'candidate',
    comparison_origin: 'none',
    lifecycle_status: 'pending_admission',
    verification_outcome: 'not_run',
    primary_domain: hit.primary_domain,
    mechanism_id: hit.mechanism_id,
    title: hit.title.slice(0, 200),
    scope: {
      kind: hit.symbol ? 'function' : 'script',
      id: scopeId,
      language,
      runtime: 'nodejs',
      source_locations: [
        {
          path: hit.rel_path.replace(/\\/g, '/').slice(0, 512),
          start_line: Math.max(1, hit.start_line),
          end_line: Math.max(hit.start_line, hit.end_line),
          ...(hit.symbol ? { symbol: hit.symbol.slice(0, 120) } : {}),
        },
      ],
    },
    lineage: {
      detector_id: hit.detector_id,
      detector_version: hit.detector_version,
      policy_version: POLICY_VERSION,
      observation_ids: [],
      benchmark_result_ids: [],
    },
  }
}

export function languageForPath(relPath: string): 'javascript' | 'typescript' {
  return languageFromPath(relPath)
}
