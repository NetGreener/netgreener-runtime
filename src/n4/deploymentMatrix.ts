/**
 * CAP-R6 deployment-mode matrix (Node Runtime production scope).
 *
 * Freezes what we **claim** vs **exercise** vs **exclude**. Does not invent
 * Kubernetes/container live evidence. Does not flip export defaults.
 */

export type DeployModeStatus =
  | 'claimed_and_exercised'
  | 'documented_degraded'
  | 'not_claimed'
  | 'open'

export type DeployModeEntry = {
  check_id: string
  mode: string
  status: DeployModeStatus
  evidence: string
  notes: string
}

/**
 * Production claim scope for Node Runtime (2026-09-24):
 * long-running process / VM-like host with default ``direct`` export.
 * Container/K8s/CI/serverless are **not** silently included.
 */
export const NODE_DEPLOYMENT_MATRIX: readonly DeployModeEntry[] = [
  {
    check_id: 'CHK-R6.vm-process',
    mode: 'long_running_process',
    status: 'claimed_and_exercised',
    evidence:
      'LIVE_ACCEPTANCE_EVIDENCE.md (HTTP dogfood, BullMQ 40654/55, process 40660/61)',
    notes: 'Primary production claim surface for Node Runtime',
  },
  {
    check_id: 'CHK-R6.container',
    mode: 'container',
    status: 'not_claimed',
    evidence: 'none retained as production gate',
    notes: 'May work identically to process; do not claim until dedicated live gate',
  },
  {
    check_id: 'CHK-R6.kubernetes',
    mode: 'kubernetes',
    status: 'not_claimed',
    evidence: 'none',
    notes: 'Out of Node Runtime production claim until exercised',
  },
  {
    check_id: 'CHK-R6.ci-job',
    mode: 'ci_job',
    status: 'documented_degraded',
    evidence: 'unit/integration in CI; not a customer Runtime deployment claim',
    notes: 'CI proves library; not a production Runtime deploy mode',
  },
  {
    check_id: 'CHK-R6.serverless-degraded',
    mode: 'serverless_thin',
    status: 'documented_degraded',
    evidence: 'serverlessHints unit tests; EXPORT_MODE=thin explicit only',
    notes: 'Best-effort thin flush; no auto-cutover; not durable collector',
  },
] as const

export function claimedDeployModes(): DeployModeEntry[] {
  return NODE_DEPLOYMENT_MATRIX.filter((e) => e.status === 'claimed_and_exercised')
}

export function assertProductionScopeIsExplicit(): boolean {
  const claimed = claimedDeployModes()
  if (claimed.length !== 1) return false
  return claimed[0].mode === 'long_running_process'
}
