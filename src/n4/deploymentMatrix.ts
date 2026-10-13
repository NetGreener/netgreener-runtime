/**
 * CAP-R6 deployment-mode matrix (Node Runtime production scope).
 *
 * Freezes what we **claim** vs **exercise** vs **exclude**.
 * Honesty pass 2026-10-06: ACA + serverless gates exist as code/dry-run only —
 * not production claims until live run_id evidence is retained.
 * Does not flip export defaults for persistent apps.
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
 * Production claim scope (honest): long-running process only.
 * ACA container + serverless thin = gate-ready / pilot until live acceptance.
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
    evidence:
      'examples/aca-container-gate + artifacts/aca-container-gate (dry-run / ACA-shaped); no live ACA run_id yet',
    notes:
      'Gate-ready for Azure Container Apps only. Do not claim until live upload + dashboard run_id retained. AWS/GCP not gated.',
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
    evidence:
      'lifecycle + serverlessHints tests; artifacts/serverless-thin-gate dry-run; Next pilot helpers',
    notes:
      'Pilot / degraded until live Vercel (or Lambda) run_id. Not durable spool. Explicit EXPORT_MODE / NETGREENER_RUNTIME=persistent win.',
  },
] as const

export function claimedDeployModes(): DeployModeEntry[] {
  return NODE_DEPLOYMENT_MATRIX.filter((e) => e.status === 'claimed_and_exercised')
}

/**
 * Production scope must claim exactly long_running_process until live gates land.
 */
export function assertProductionScopeIsExplicit(): boolean {
  const claimed = claimedDeployModes()
  if (claimed.length !== 1) return false
  return claimed[0].mode === 'long_running_process'
}
