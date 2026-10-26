import type {
  ExternalApiV0,
  MeasurementProvenance,
  RuntimeSessionMetadata,
  ServiceRuntimeV0,
} from '../types.js'

export type ContractIssue = {
  path: string
  message: string
}

export type ContractResult = {
  ok: boolean
  issues: ContractIssue[]
}

function issue(path: string, message: string): ContractIssue {
  return { path, message }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type NumberRequirements = {
  nonNegative?: boolean
  integer?: boolean
  maximum?: number
}

function requireNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: ContractIssue[],
  requirements: NumberRequirements = {},
) {
  const value = obj[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(issue(`${path}.${key}`, 'expected number'))
    return
  }
  if (requirements.nonNegative && value < 0) {
    issues.push(issue(`${path}.${key}`, 'expected non-negative number'))
  }
  if (requirements.integer && !Number.isSafeInteger(value)) {
    issues.push(issue(`${path}.${key}`, 'expected safe integer'))
  }
  if (requirements.maximum !== undefined && value > requirements.maximum) {
    issues.push(issue(`${path}.${key}`, `expected number at most ${requirements.maximum}`))
  }
}

function optionalNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: ContractIssue[],
  requirements: NumberRequirements = {},
) {
  if (obj[key] !== undefined) {
    requireNumber(obj, key, path, issues, requirements)
  }
}

function errorsDoNotExceedCalls(
  obj: Record<string, unknown>,
  path: string,
  issues: ContractIssue[],
) {
  if (
    typeof obj.calls === 'number' &&
    Number.isFinite(obj.calls) &&
    typeof obj.errors === 'number' &&
    Number.isFinite(obj.errors) &&
    obj.errors > obj.calls
  ) {
    issues.push(issue(`${path}.errors`, 'must not exceed calls'))
  }
}

function requireString(obj: Record<string, unknown>, key: string, path: string, issues: ContractIssue[]) {
  if (typeof obj[key] !== 'string' || !(obj[key] as string).trim()) {
    issues.push(issue(`${path}.${key}`, 'expected non-empty string'))
  }
}

/** Validate the legacy Python-compatible v0 scaffold. MP0 remains the authority. */
export function validateServiceRuntimeV0(value: unknown, path = 'service_runtime_v0'): ContractResult {
  const issues: ContractIssue[] = []
  if (!isObject(value)) {
    return { ok: false, issues: [issue(path, 'expected object')] }
  }
  requireString(value, 'collector', path, issues)
  requireNumber(value, 'window_seconds', path, issues, { nonNegative: true })
  requireString(value, 'attribution', path, issues)
  requireString(value, 'accuracy', path, issues)
  if (!Array.isArray(value.units)) {
    issues.push(issue(`${path}.units`, 'expected array'))
  } else {
    value.units.forEach((unit, index) => {
      const up = `${path}.units[${index}]`
      if (!isObject(unit)) {
        issues.push(issue(up, 'expected object'))
        return
      }
      requireString(unit, 'service_unit', up, issues)
      requireString(unit, 'unit_type', up, issues)
      requireNumber(unit, 'calls', up, issues, { nonNegative: true, integer: true })
      requireNumber(unit, 'errors', up, issues, { nonNegative: true, integer: true })
      errorsDoNotExceedCalls(unit, up, issues)
      requireNumber(unit, 'cpu_seconds_total', up, issues, { nonNegative: true })
      requireNumber(unit, 'energy_kwh', up, issues, { nonNegative: true })
      requireNumber(unit, 'carbon_g', up, issues, { nonNegative: true })
      optionalNumber(unit, 'peak_rss_kb_max', up, issues, { nonNegative: true })
      optionalNumber(unit, 'cpu_percent_hours', up, issues, { nonNegative: true })
      optionalNumber(unit, 'ram_gb_hours', up, issues, { nonNegative: true })
      optionalNumber(unit, 'process_gpu_hours', up, issues, { nonNegative: true })
      if (!isObject(unit.duration_ms)) {
        issues.push(issue(`${up}.duration_ms`, 'expected object'))
      } else {
        requireNumber(unit.duration_ms, 'avg', `${up}.duration_ms`, issues, {
          nonNegative: true,
        })
        requireNumber(unit.duration_ms, 'max', `${up}.duration_ms`, issues, {
          nonNegative: true,
        })
      }
    })
  }
  if (value.allocation_reconciliation_v0 !== undefined) {
    const reconciliationPath = `${path}.allocation_reconciliation_v0`
    if (!isObject(value.allocation_reconciliation_v0)) {
      issues.push(issue(reconciliationPath, 'expected object'))
    } else {
      const reconciliation = value.allocation_reconciliation_v0
      requireNumber(reconciliation, 'schema_version', reconciliationPath, issues, {
        nonNegative: true,
        integer: true,
      })
      requireNumber(reconciliation, 'window_energy_kwh', reconciliationPath, issues, {
        nonNegative: true,
      })
      requireNumber(reconciliation, 'allocated_energy_kwh', reconciliationPath, issues, {
        nonNegative: true,
      })
      requireNumber(reconciliation, 'residual_energy_kwh', reconciliationPath, issues)
      requireNumber(reconciliation, 'tolerance_kwh', reconciliationPath, issues, {
        nonNegative: true,
      })
      if (
        reconciliation.endpoint_capture_coverage !== null &&
        reconciliation.endpoint_capture_coverage !== undefined
      ) {
        requireNumber(reconciliation, 'endpoint_capture_coverage', reconciliationPath, issues, {
          nonNegative: true,
          maximum: 1,
        })
      }
    }
  }
  return { ok: issues.length === 0, issues }
}

/** Validate external_api_v0 including optional by_model buckets. */
export function validateExternalApiV0(value: unknown, path = 'external_api_v0'): ContractResult {
  const issues: ContractIssue[] = []
  if (!isObject(value)) {
    return { ok: false, issues: [issue(path, 'expected object')] }
  }
  requireString(value, 'collector', path, issues)
  if (!Array.isArray(value.providers)) {
    issues.push(issue(`${path}.providers`, 'expected array'))
    return { ok: false, issues }
  }
  value.providers.forEach((provider, index) => {
    const pp = `${path}.providers[${index}]`
    if (!isObject(provider)) {
      issues.push(issue(pp, 'expected object'))
      return
    }
    requireString(provider, 'provider_key', pp, issues)
    requireNumber(provider, 'calls', pp, issues, { nonNegative: true, integer: true })
    requireNumber(provider, 'errors', pp, issues, { nonNegative: true, integer: true })
    errorsDoNotExceedCalls(provider, pp, issues)
    optionalNumber(provider, 'duration_ms_avg', pp, issues, { nonNegative: true })
    optionalNumber(provider, 'input_tokens', pp, issues, { nonNegative: true, integer: true })
    optionalNumber(provider, 'output_tokens', pp, issues, { nonNegative: true, integer: true })
    optionalNumber(provider, 'total_tokens', pp, issues, { nonNegative: true, integer: true })
    if (provider.by_model !== undefined) {
      if (!Array.isArray(provider.by_model)) {
        issues.push(issue(`${pp}.by_model`, 'expected array'))
      } else {
        provider.by_model.forEach((row, mi) => {
          const mp = `${pp}.by_model[${mi}]`
          if (!isObject(row)) {
            issues.push(issue(mp, 'expected object'))
            return
          }
          requireString(row, 'model', mp, issues)
          requireNumber(row, 'calls', mp, issues, { nonNegative: true, integer: true })
          requireNumber(row, 'errors', mp, issues, { nonNegative: true, integer: true })
          errorsDoNotExceedCalls(row, mp, issues)
          optionalNumber(row, 'input_tokens', mp, issues, { nonNegative: true, integer: true })
          optionalNumber(row, 'output_tokens', mp, issues, { nonNegative: true, integer: true })
          optionalNumber(row, 'total_tokens', mp, issues, { nonNegative: true, integer: true })
        })
      }
    }
  })
  return { ok: issues.length === 0, issues }
}

export function validateMeasurementProvenance(
  value: unknown,
  path = 'measurement_provenance',
): ContractResult {
  const issues: ContractIssue[] = []
  if (!isObject(value)) {
    return { ok: false, issues: [issue(path, 'expected object')] }
  }
  const carbonFactor = value.carbon_factor
  if (carbonFactor !== undefined) {
    if (!isObject(carbonFactor)) {
      issues.push(issue(`${path}.carbon_factor`, 'expected object'))
    } else if (carbonFactor.value !== null) {
      requireNumber(carbonFactor, 'value', `${path}.carbon_factor`, issues, {
        nonNegative: true,
      })
    }
  }
  const grades = value.evidence_grades
  if (grades !== undefined) {
    if (!isObject(grades)) {
      issues.push(issue(`${path}.evidence_grades`, 'expected object'))
    } else {
      requireNumber(grades, 'schema_version', `${path}.evidence_grades`, issues, {
        nonNegative: true,
        integer: true,
      })
      requireString(grades, 'policy_version', `${path}.evidence_grades`, issues)
      requireString(grades, 'combined_floor_grade', `${path}.evidence_grades`, issues)
      if (!isObject(grades.metrics)) {
        issues.push(issue(`${path}.evidence_grades.metrics`, 'expected object'))
      }
    }
  }
  return { ok: issues.length === 0, issues }
}

/**
 * Validate a session_metadata fragment Node will upload.
 * Requires at least service_runtime_v0 or external_api_v0.
 */
export function validateRuntimeSessionMetadata(value: unknown): ContractResult {
  const issues: ContractIssue[] = []
  if (!isObject(value)) {
    return { ok: false, issues: [issue('session_metadata', 'expected object')] }
  }

  const hasRuntime = value.service_runtime_v0 !== undefined
  const hasExternal = value.external_api_v0 !== undefined
  if (!hasRuntime && !hasExternal) {
    issues.push(
      issue(
        'session_metadata',
        'expected service_runtime_v0 and/or external_api_v0',
      ),
    )
  }
  if (hasRuntime) {
    issues.push(...validateServiceRuntimeV0(value.service_runtime_v0).issues)
  }
  if (hasExternal) {
    issues.push(...validateExternalApiV0(value.external_api_v0).issues)
  }
  if (value.measurement_provenance !== undefined) {
    issues.push(...validateMeasurementProvenance(value.measurement_provenance).issues)
  }
  return { ok: issues.length === 0, issues }
}

export type {
  ExternalApiV0,
  MeasurementProvenance,
  RuntimeSessionMetadata,
  ServiceRuntimeV0,
}
