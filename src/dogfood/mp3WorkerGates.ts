/**
 * MP3 worker-gate helpers (BullMQ concurrency + restart; process restart).
 *
 * Pure assertions over flushed session_metadata — no Redis required in unit tests.
 * Does not claim production support or change export defaults.
 */

export type Mp3WorkerGateFlush = {
  sessionMetadata?: {
    service_runtime_v0?: {
      collector?: string
      units?: Array<{ service_unit?: string; calls?: number; unit_type?: string }>
      by_tenant?: Record<string, unknown>
    }
  } | null
  /** Number of jobs the harness observed as completed. */
  completedJobs: number
  /** Expected minimum completed jobs for this phase. */
  minCompletedJobs: number
  /** Optional tenant key that must appear when tenants are configured. */
  expectedTenant?: string
  /** Optional task unit name (e.g. task:analyze_document). */
  expectedTaskUnit?: string
  phase: 'concurrency' | 'restart' | 'process_restart'
  /** Expected collector metadata (default bullmq_worker). */
  expectedCollector?: string
}

export type Mp3WorkerGateResult =
  | { ok: true; phase: string }
  | { ok: false; phase: string; reason: string }

function taskUnitCalls(
  meta: NonNullable<Mp3WorkerGateFlush['sessionMetadata']>,
  serviceUnit: string,
): number {
  const units = meta.service_runtime_v0?.units || []
  const hit = units.find((u) => u.service_unit === serviceUnit)
  return Number(hit?.calls || 0)
}

/**
 * Concurrency phase: enough jobs completed and expected collector metadata present.
 * When expectedTaskUnit is set, recorded calls must be ≥ 1 (unit must exist).
 */
export function assertMp3ConcurrencyGate(input: Mp3WorkerGateFlush): Mp3WorkerGateResult {
  const phase = input.phase || 'concurrency'
  const expectedCollector = input.expectedCollector || 'bullmq_worker'
  if (input.completedJobs < input.minCompletedJobs) {
    return {
      ok: false,
      phase,
      reason: `completedJobs=${input.completedJobs} < minCompletedJobs=${input.minCompletedJobs}`,
    }
  }
  const meta = input.sessionMetadata
  if (!meta?.service_runtime_v0) {
    return { ok: false, phase, reason: 'missing service_runtime_v0 after concurrency flush' }
  }
  const collector = meta.service_runtime_v0.collector
  if (collector !== expectedCollector) {
    return {
      ok: false,
      phase,
      reason: `collector=${collector ?? '(none)'} expected ${expectedCollector}`,
    }
  }
  if (input.expectedTaskUnit) {
    const calls = taskUnitCalls(meta, input.expectedTaskUnit)
    if (calls < 1) {
      return {
        ok: false,
        phase,
        reason: `missing task unit ${input.expectedTaskUnit} (calls=${calls})`,
      }
    }
  }
  if (input.expectedTenant) {
    const tenants = meta.service_runtime_v0.by_tenant || {}
    if (!(input.expectedTenant in tenants)) {
      return {
        ok: false,
        phase,
        reason: `missing by_tenant.${input.expectedTenant}`,
      }
    }
  }
  return { ok: true, phase }
}

/**
 * Restart phase: a second worker generation completed jobs and still emits
 * expected collector metadata (proves wrap survives worker.close → new Worker).
 */
export function assertMp3RestartGate(input: Mp3WorkerGateFlush): Mp3WorkerGateResult {
  const phase = input.phase || 'restart'
  const base = assertMp3ConcurrencyGate({ ...input, phase })
  if (!base.ok) return base
  return { ok: true, phase }
}

/**
 * Process/cron restart: after `_resetRuntimeForTests` + new `startProcessRuntime`,
 * flush still emits ``node_process`` with tenant/task samples.
 */
export function assertMp3ProcessRestartGate(input: Mp3WorkerGateFlush): Mp3WorkerGateResult {
  return assertMp3ConcurrencyGate({
    ...input,
    phase: input.phase || 'process_restart',
    expectedCollector: input.expectedCollector || 'node_process',
  })
}

export function formatMp3GateFailure(result: Mp3WorkerGateResult): string {
  if (result.ok) return `MP3 ${result.phase} gate PASS`
  return `MP3 ${result.phase} gate FAIL: ${result.reason}`
}
