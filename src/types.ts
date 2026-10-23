/** Shared shapes for NetGreener runtime session_metadata (Node emitter). */

export type DurationMs = {
  avg: number
  max: number
}

export type ServiceRuntimeUnit = {
  service_unit: string
  unit_type: string
  calls: number
  errors: number
  cpu_seconds_total: number
  energy_kwh: number
  carbon_g: number
  duration_ms: DurationMs
  peak_rss_kb_max?: number
  cpu_percent_hours?: number
  ram_gb_hours?: number
  process_gpu_hours?: number
  /** Concurrency-normalized occupancy seconds (when OccupancyTracker wired). */
  occupancy_seconds?: number
}

export type AllocationReconciliationV0 = {
  schema_version: number
  window_energy_kwh: number
  allocated_energy_kwh: number
  residual_energy_kwh: number
  tolerance_kwh: number
  passed: boolean
  scope: string
  endpoint_capture_coverage: number | null
  capture_completeness: string
}

/** Downstream B2B customer company id (not NetGreener org, not end-user). */
export type TenantId = string

export type ServiceRuntimeTenantBucket = {
  tenant_id: TenantId
  calls: number
  errors: number
  units: ServiceRuntimeUnit[]
}

export type AttributionDetailV0 = {
  cpu?: { method: string; kind: string }
  ram?: { method: string; kind: string }
  gpu?: { method: string; kind: string }
  energy?: Record<string, string>
}

export type ServiceRuntimeV0 = {
  framework?: string | null
  collector: string
  window_seconds: number
  attribution: string
  /** Optional detail for anomaly runtime_evidence (additive). */
  attribution_detail?: AttributionDetailV0
  accuracy: string
  units: ServiceRuntimeUnit[]
  by_tenant?: Record<TenantId, ServiceRuntimeTenantBucket>
  allocation_reconciliation_v0?: AllocationReconciliationV0
  /** Idle / in-flight occupancy not yet attributed to a unit. */
  unattributed?: {
    occupancy_seconds?: number
    idle_seconds?: number
    in_flight_seconds?: number
    /** Occupancy-share of window RAM when ``ram_gb_hours`` is allocated. */
    ram_gb_hours?: number
  }
}

export type ExternalApiModelBucket = {
  model: string
  calls: number
  errors: number
  calls_with_usage?: number
  /** Calls seen with no provider usage. Not a per-call price. */
  calls_unknown?: number
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
}

export type ExternalApiProvider = {
  provider_key: string
  calls: number
  errors: number
  calls_with_usage?: number
  /** Calls seen with no provider usage. Not a per-call price. */
  calls_unknown?: number
  duration_ms_avg?: number
  hosts?: string[]
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  models?: string[]
  by_model?: ExternalApiModelBucket[]
}

export type ExternalApiTenantBucket = {
  tenant_id: TenantId
  calls: number
  errors: number
  providers: ExternalApiProvider[]
}

export type ExternalApiV0 = {
  collector: string
  providers: ExternalApiProvider[]
  by_service_unit?: Record<string, unknown>
  by_tenant?: Record<TenantId, ExternalApiTenantBucket>
}

export type EvidenceMetric = {
  metric: string
  grade: string
  reasons: string[]
}

export type EvidenceGrades = {
  schema_version: number
  policy_version: string
  metrics: {
    local_energy: EvidenceMetric
    local_carbon: EvidenceMetric
  }
  combined_floor_grade: string
  notes?: string[]
}

export type MeasurementProvenance = {
  cpu_source?: string
  memory_source?: string
  energy_model?: string
  gpu_scope?: string
  gpu_source?: string
  carbon_factor?: {
    value: number | null
    unit?: string
    source?: string
    version?: string
    location?: string | null
  }
  evidence_grades?: EvidenceGrades
  [key: string]: unknown
}

export type RunContext = {
  deploy_environment?: string
  client?: string
  release_tag?: string
  git_sha?: string
  deploy_id?: string
  is_ci?: boolean
  ci?: boolean
  continuous_integration?: boolean
  ci_provider?: string
  /** Downstream customer company org id when tenant attribution is enabled. */
  tenant_id?: TenantId
  /** e.g. jwt_claim:organization_id */
  tenant_source?: string
  /** Optional display label; not a billing key. */
  tenant_label?: string
  [key: string]: unknown
}

/** session_metadata fragment Node must be able to upload. */
export type RuntimeSessionMetadata = {
  run_context?: RunContext
  service_runtime_v0?: ServiceRuntimeV0
  external_api_v0?: ExternalApiV0
  /** Same-process MCP tool series. Not an API cost and not a second bill. */
  mcp_tool_v0?: Record<string, unknown>
  /** Wall time beside MCP and HTTP durations. Overlap is marked, not stacked. */
  mcp_latency_v0?: Record<string, unknown>
  measurement_provenance?: MeasurementProvenance
  [key: string]: unknown
}
