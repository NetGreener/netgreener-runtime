/**
 * N4 / N5 missingness inventory — Node Runtime (direct emitter).
 *
 * Documents what is measured vs proxy vs not measured. Does not invent
 * cgroup/process-tree values or change the upload pipeline.
 */

import {
  CPU_SOURCE_PROCESS,
  MEMORY_SOURCE_PROCESS,
} from '../processResources.js'

export type MeasurementStatus =
  | 'measured'
  | 'proxy'
  | 'derived_estimate'
  | 'not_measured'
  | 'absent'

export type MissingnessEntry = {
  signal_id: string
  status: MeasurementStatus
  /** Provenance string when present on session_metadata (e.g. cpu_source). */
  provenance?: string
  notes: string
}

export { CPU_SOURCE_PROCESS, MEMORY_SOURCE_PROCESS }

/** Fallback when a sample omits measured CPU (tests / bare recordHttp). */
export const CPU_SOURCE_DURATION_PROXY = 'request_duration_proxy'

/** Frozen inventory for `@netgreener/runtime` default direct path (2026-09-24). */
export const NODE_DIRECT_MISSINGNESS_INVENTORY: readonly MissingnessEntry[] = [
  {
    signal_id: 'service_unit.calls_errors_duration',
    status: 'measured',
    notes: 'Adapter samples from HTTP middleware / BullMQ / process helpers',
  },
  {
    signal_id: 'tenant.by_tenant',
    status: 'measured',
    notes: 'When tenant bind is configured; otherwise absent',
  },
  {
    signal_id: 'external_api_v0',
    status: 'measured',
    notes: 'When outbound instrumentation is installed',
  },
  {
    signal_id: 'unit.cpu_seconds_total',
    status: 'measured',
    provenance: CPU_SOURCE_PROCESS,
    notes:
      'process.cpuUsage delta on Express/Fastify/BullMQ/process hooks; duration proxy only if sample omits CPU',
  },
  {
    signal_id: 'unit.peak_rss_kb_max',
    status: 'measured',
    provenance: MEMORY_SOURCE_PROCESS,
    notes: 'process.memoryUsage().rss at sample end (KiB)',
  },
  {
    signal_id: 'unit.energy_kwh_carbon_g',
    status: 'derived_estimate',
    notes:
      'Emitter-side TDP util estimate (prefers measured CPU when present); cloud policy ownership open',
  },
  {
    signal_id: 'collector.process_tree_cgroup',
    status: 'not_measured',
    notes: 'Requires shared MP2 collector sampler + Node launcher — still open',
  },
  {
    signal_id: 'runtime_health_v0',
    status: 'measured',
    notes:
      'Export attempt/ok/fail/in-flight-skip counters + hooks_active on each flush (CAP-R5 honesty)',
  },
  {
    signal_id: 'host_gpu_energy_meters',
    status: 'not_measured',
    notes: 'Out of thin-adapter scope',
  },
] as const

export function missingnessByStatus(
  status: MeasurementStatus,
): MissingnessEntry[] {
  return NODE_DIRECT_MISSINGNESS_INVENTORY.filter((e) => e.status === status)
}

export function assertNoFalseCgroupClaim(cpuSource: string | undefined): boolean {
  if (!cpuSource) return true
  const lowered = cpuSource.toLowerCase()
  if (lowered.includes('cgroup') || lowered.includes('process_tree')) {
    return false
  }
  return true
}
