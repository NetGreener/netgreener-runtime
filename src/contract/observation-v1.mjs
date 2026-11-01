/**
 * Public producer-validation and pair-identity boundaries for the pinned MP0 draft.
 * No collector, cloud upload, fixture oracle, or conformance result generation lives here.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let shapeValidator
let protobufViewValidator
function validateShape(document) {
  // Legacy runtime imports should not compile or load the draft validator eagerly.
  if (!shapeValidator) {
    const Ajv2020 = require('ajv/dist/2020.js').default
    const addFormats = require('ajv-formats').default
    const schema = JSON.parse(readFileSync(new URL('./observation-envelope.schema.json', import.meta.url), 'utf8'))
    // Disable strict schema-authoring warnings, not producer/format validation.
    const ajv = new Ajv2020({ strict: false, strictNumbers: true, allErrors: false, ownProperties: true })
    addFormats(ajv, ['date-time'])
    shapeValidator = ajv.compile(schema)
  }
  return shapeValidator(document)
}
function validateProtobufViewShape(document) {
  if (!protobufViewValidator) {
    const Ajv2020 = require('ajv/dist/2020.js').default
    const addFormats = require('ajv-formats').default
    const schema = JSON.parse(readFileSync(new URL('./observation-protobuf-view.schema.json', import.meta.url), 'utf8'))
    const ajv = new Ajv2020({ strict: false, strictNumbers: true, allErrors: false, ownProperties: true })
    addFormats(ajv, ['date-time'])
    protobufViewValidator = ajv.compile(schema)
  }
  return protobufViewValidator(document)
}

const PROTOCOL_MAJOR = 1
const PROTOCOL_MINOR = 0
/** Mirrors observation/v1/json-semantic-mapping.v1.json (dual-view migration). */
const ENUM_MAPS = {
  deployment_mode: {
    vm: 'DEPLOYMENT_MODE_VM', container: 'DEPLOYMENT_MODE_CONTAINER',
    kubernetes: 'DEPLOYMENT_MODE_KUBERNETES', ci_job: 'DEPLOYMENT_MODE_CI_JOB',
    serverless_thin: 'DEPLOYMENT_MODE_SERVERLESS_THIN', local: 'DEPLOYMENT_MODE_LOCAL',
    unknown: 'DEPLOYMENT_MODE_UNKNOWN',
  },
  content_capture: { none: 'CONTENT_CAPTURE_NONE' },
  dimension_policy: { allowlist: 'DIMENSION_POLICY_ALLOWLIST' },
  route_policy: { template_or_unknown: 'ROUTE_POLICY_TEMPLATE_OR_UNKNOWN' },
  window_state: { open: 'WINDOW_STATE_OPEN', closed: 'WINDOW_STATE_CLOSED', thin: 'WINDOW_STATE_THIN' },
  clock_source: {
    runtime_monotonic: 'CLOCK_SOURCE_RUNTIME_MONOTONIC',
    process_monotonic: 'CLOCK_SOURCE_PROCESS_MONOTONIC',
    unavailable: 'CLOCK_SOURCE_UNAVAILABLE',
  },
  operation_kind: {
    'http.server': 'OPERATION_KIND_HTTP_SERVER', task: 'OPERATION_KIND_TASK',
    process: 'OPERATION_KIND_PROCESS', script: 'OPERATION_KIND_SCRIPT',
    cron: 'OPERATION_KIND_CRON', background: 'OPERATION_KIND_BACKGROUND',
    unattributed: 'OPERATION_KIND_UNATTRIBUTED',
  },
  operation_unit: {
    http_route: 'OPERATION_UNIT_HTTP_ROUTE', task: 'OPERATION_UNIT_TASK',
    process: 'OPERATION_UNIT_PROCESS', script: 'OPERATION_UNIT_SCRIPT',
    cron: 'OPERATION_UNIT_CRON', background: 'OPERATION_UNIT_BACKGROUND',
    unattributed: 'OPERATION_UNIT_UNATTRIBUTED',
  },
  identity_source: {
    framework_template: 'IDENTITY_SOURCE_FRAMEWORK_TEMPLATE',
    declared: 'IDENTITY_SOURCE_DECLARED', generated: 'IDENTITY_SOURCE_GENERATED',
    unknown_bucket: 'IDENTITY_SOURCE_UNKNOWN_BUCKET',
  },
  operation_phase: {
    start: 'OPERATION_PHASE_START', finish: 'OPERATION_PHASE_FINISH',
    heartbeat: 'OPERATION_PHASE_HEARTBEAT',
  },
  outcome: {
    ok: 'OUTCOME_OK', error: 'OUTCOME_ERROR', cancelled: 'OUTCOME_CANCELLED',
    unknown: 'OUTCOME_UNKNOWN',
  },
  usage_source: {
    provider_response: 'USAGE_SOURCE_PROVIDER_RESPONSE',
    documented_header: 'USAGE_SOURCE_DOCUMENTED_HEADER',
    sdk_callback: 'USAGE_SOURCE_SDK_CALLBACK', declared: 'USAGE_SOURCE_DECLARED',
  },
  resource_scope: {
    process: 'RESOURCE_SCOPE_PROCESS', process_tree: 'RESOURCE_SCOPE_PROCESS_TREE',
    container: 'RESOURCE_SCOPE_CONTAINER', cgroup: 'RESOURCE_SCOPE_CGROUP',
    host: 'RESOURCE_SCOPE_HOST', device: 'RESOURCE_SCOPE_DEVICE',
  },
  sample_kind: {
    start: 'SAMPLE_KIND_START', periodic: 'SAMPLE_KIND_PERIODIC',
    end: 'SAMPLE_KIND_END', snapshot: 'SAMPLE_KIND_SNAPSHOT',
  },
  measurement_name: {
    'process.cpu.time': 'MEASUREMENT_NAME_PROCESS_CPU_TIME',
    'process.memory.rss': 'MEASUREMENT_NAME_PROCESS_MEMORY_RSS',
    'system.energy': 'MEASUREMENT_NAME_SYSTEM_ENERGY',
    'gpu.energy': 'MEASUREMENT_NAME_GPU_ENERGY',
    'gpu.utilization': 'MEASUREMENT_NAME_GPU_UTILIZATION',
  },
  measurement_unit: {
    ns: 'MEASUREMENT_UNIT_NS', By: 'MEASUREMENT_UNIT_BY',
    J: 'MEASUREMENT_UNIT_J', '1': 'MEASUREMENT_UNIT_RATIO',
  },
  temporality: {
    cumulative: 'TEMPORALITY_CUMULATIVE', delta: 'TEMPORALITY_DELTA', gauge: 'TEMPORALITY_GAUGE',
  },
  health_component: {
    adapter: 'HEALTH_COMPONENT_ADAPTER', exporter: 'HEALTH_COMPONENT_EXPORTER',
    sampler: 'HEALTH_COMPONENT_SAMPLER', collector: 'HEALTH_COMPONENT_COLLECTOR',
  },
  health_status: {
    ok: 'HEALTH_STATUS_OK', degraded: 'HEALTH_STATUS_DEGRADED',
    error: 'HEALTH_STATUS_ERROR', disabled: 'HEALTH_STATUS_DISABLED',
  },
}

const contentFields = new Set(['authorization', 'body', 'completion', 'cookie', 'database_statement', 'error_text', 'headers', 'prompt', 'request_body', 'response_body', 'secret'])
const derivedFields = new Set(['carbon', 'carbon_factor', 'carbon_g', 'co2e', 'cost', 'cost_usd', 'currency', 'energy_estimate', 'energy_kwh', 'estimated_energy', 'estimated_energy_j', 'price', 'pricing'])
const knownCapabilities = new Set(['CAP-R1', 'CAP-R2', 'CAP-R3', 'CAP-R4', 'CAP-R5', 'CAP-R6', 'CAP-A1', 'CAP-A2', 'CAP-A3', 'CAP-O1', 'CAP-O2', 'CAP-P1', 'CAP-P2', 'CAP-Q1'])
const operationKinds = new Set(['http.server', 'task', 'process', 'script', 'cron', 'background', 'unattributed'])
const recordCapabilities = new Map([['external_call', 'CAP-R3'], ['resource_sample', 'CAP-R4'], ['adapter_health', 'CAP-R5']])
const measurementShapes = new Map([
  ['process.cpu.time', ['ns', ['cumulative', 'delta']]],
  ['process.memory.rss', ['By', ['gauge']]],
  ['system.energy', ['J', ['cumulative', 'delta']]],
  ['gpu.energy', ['J', ['cumulative', 'delta']]],
  ['gpu.utilization', ['1', ['gauge']]],
])
const uint64Max = (1n << 64n) - 1n
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const array = (value) => Array.isArray(value) ? value : []
const has = (value, key) => Object.hasOwn(value, key)
const integer = (value) => {
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) return BigInt(value)
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return BigInt(value)
  return null
}

function checkRange(value, codes) {
  const parsed = integer(value)
  if (parsed !== null && (parsed < 0n || parsed > uint64Max)) codes.add('UINT64_OUT_OF_RANGE')
}

function repeated(values) {
  return new Set(values).size !== values.length
}

function strictTimestamp(value) {
  // Match the draft Python checker on leap seconds/year zero, while rejecting its
  // trailing-newline quirk. Calendar validity remains the schema format check.
  return typeof value === 'string' && !/\s/.test(value) &&
    /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-5][0-9](?:\.[0-9]+)?(?:[Zz]|[+-][0-9]{2}:[0-9]{2})$/.test(value)
}

// Reject native values/cycles before handing an arbitrary caller's input to Ajv.
// Error codes never contain customer values or validation-library error messages.
function inspectJson(value, codes, ancestors = new Set(), depth = 0) {
  if (depth > 64) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) { codes.add('NONFINITE_NUMBER'); return false }
    return true
  }
  if (!object(value) && !Array.isArray(value)) return false
  if (ancestors.has(value)) return false
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  ancestors.add(value)
  let valid = true
  for (const [key, child] of Object.entries(value)) {
    const lower = key.toLowerCase()
    if (contentFields.has(lower)) codes.add('FORBIDDEN_CONTENT_FIELD')
    if (derivedFields.has(lower)) codes.add('FORBIDDEN_DERIVED_FIELD')
    valid = inspectJson(child, codes, ancestors, depth + 1) && valid
  }
  ancestors.delete(value)
  return valid
}

function checkOperation(operation, codes) {
  if (!object(operation)) return
  const expectedUnit = operation.kind === 'http.server' ? 'http_route' : operation.kind
  if (operationKinds.has(operation.kind) && operation.unit_type !== expectedUnit) codes.add('OPERATION_KIND_UNIT_MISMATCH')
  if (operation.kind !== 'http.server') return
  const source = operation.identity_source
  const route = operation.route_template
  const name = operation.name
  const allowedSource = ['framework_template', 'declared', 'generated', 'unknown_bucket'].includes(source)
  const rawRoute = typeof route !== 'string' || /[?#]/.test(route) ||
    (source === 'generated' && /(?:^|\/)(?:[0-9]{4,}|[0-9a-f]{8}-[0-9a-f-]{27,})(?:\/|$)/i.test(route))
  if (!allowedSource || rawRoute || (typeof name === 'string' && /[?#]/.test(name)) ||
    (source === 'unknown_bucket' && route !== '__unknown__') ||
    (route === '__unknown__' && source !== 'unknown_bucket')) codes.add('RAW_ROUTE_IDENTITY_FORBIDDEN')
}

function checkFacts(event, codes) {
  const facts = event.facts
  if (!object(facts)) return
  if (event.record_type === 'operation_summary') {
    if (Number.isInteger(facts.calls) && Number.isInteger(facts.errors) && facts.errors > facts.calls) codes.add('INVALID_COUNTER_RELATIONSHIP')
    const sum = integer(facts.duration_ns_sum)
    const max = integer(facts.duration_ns_max)
    if (sum !== null && max !== null && max > sum) codes.add('INVALID_DURATION_RELATIONSHIP')
    checkRange(facts.duration_ns_sum, codes)
    checkRange(facts.duration_ns_max, codes)
  } else if (event.record_type === 'operation_event') {
    if (typeof event.execution_id !== 'string') codes.add('LIFECYCLE_EXECUTION_ID_REQUIRED')
    if ((facts.phase === 'start' && (facts.outcome !== 'unknown' || has(facts, 'duration_ns'))) ||
      (facts.phase === 'finish' && !has(facts, 'duration_ns'))) codes.add('LIFECYCLE_PHASE_FACT_MISMATCH')
    if (has(facts, 'duration_ns')) checkRange(facts.duration_ns, codes)
  } else if (event.record_type === 'external_call') {
    if (Number.isInteger(facts.attempts) && Number.isInteger(facts.errors) && facts.errors > facts.attempts) codes.add('INVALID_COUNTER_RELATIONSHIP')
    checkRange(facts.duration_ns, codes)
    const usage = array(facts.usage).filter(object)
    if (repeated(usage.map((entry) => entry.unit))) codes.add('DUPLICATE_USAGE_UNIT')
    for (const entry of usage) checkRange(entry.value, codes)
  } else if (event.record_type === 'resource_sample') {
    const measurements = array(facts.measurements).filter(object)
    if (repeated(measurements.map((entry) => entry.name))) codes.add('DUPLICATE_MEASUREMENT')
    for (const entry of measurements) {
      const shape = measurementShapes.get(entry.name)
      if (shape && (entry.unit !== shape[0] || !shape[1].includes(entry.temporality))) codes.add('INVALID_MEASUREMENT_SHAPE')
      if (entry.name === 'process.cpu.time') {
        checkRange(entry.value, codes)
        if (/request_duration|wall|elapsed|proxy/i.test(String(entry.source ?? ''))) codes.add('CPU_SOURCE_WALL_DURATION')
      }
    }
  }
}

/** @param {unknown} document @returns {{accepted: boolean, errorCodes: string[]}} */
export function validateObservationEnvelope(document) {
  const codes = new Set()
  try {
    if (!inspectJson(document, codes)) {
      codes.add('SCHEMA_VALIDATION_ERROR')
      return { accepted: false, errorCodes: [...codes].sort() }
    }
    if (!validateShape(document)) codes.add('SCHEMA_VALIDATION_ERROR')
    if (!object(document)) return { accepted: false, errorCodes: [...codes].sort() }
    if (!strictTimestamp(document.emitted_at)) codes.add('SCHEMA_VALIDATION_ERROR')
    if (object(document.window)) {
      if (!strictTimestamp(document.window.start_time) ||
        (document.window.end_time != null && !strictTimestamp(document.window.end_time))) codes.add('SCHEMA_VALIDATION_ERROR')
    }
    checkRange(document.batch_sequence, codes)
    const capabilities = new Set(array(document.source?.capability_ids).filter((id) => typeof id === 'string'))
    if ([...capabilities].some((id) => !knownCapabilities.has(id))) codes.add('UNKNOWN_CAPABILITY_ID')
    const events = array(document.events).filter(object)
    const ids = events.map((event) => event.event_id).filter((id) => typeof id === 'string')
    const idSet = new Set(ids)
    const sequences = events.map((event) => integer(event.sequence)).filter((value) => value !== null)
    if (repeated(ids)) codes.add('DUPLICATE_EVENT_ID')
    if (repeated(sequences)) codes.add('DUPLICATE_SEQUENCE')
    if (sequences.some((value, index) => index > 0 && value <= sequences[index - 1])) codes.add('INVALID_SEQUENCE_ORDER')
    for (const event of events) {
      for (const field of ['sequence', 'wall_time_unix_nano', 'monotonic_time_ns']) checkRange(event[field], codes)
      if (typeof event.traceparent === 'string') {
        const parts = event.traceparent.split('-')
        if (parts.length !== 4 || parts[0] === 'ff' || parts[1] === '0'.repeat(32) || parts[2] === '0'.repeat(16)) codes.add('INVALID_TRACEPARENT')
      }
      if (event.parent_operation_event_id != null && !idSet.has(event.parent_operation_event_id)) codes.add('UNKNOWN_PARENT_EVENT')
      checkOperation(event.operation, codes)
      checkFacts(event, codes)
      if (object(event.facts)) {
        const capability = ['operation_event', 'operation_summary'].includes(event.record_type)
          ? (event.operation?.kind === 'http.server' ? 'CAP-R1' : 'CAP-R2')
          : recordCapabilities.get(event.record_type)
        if (capability && !capabilities.has(capability)) codes.add('SOURCE_CAPABILITY_MISMATCH')
      }
      const windowId = object(document.window) ? document.window.runtime_window_id : null
      if (windowId) {
        if (event.runtime_window_id == null) codes.add('WINDOW_ID_MISSING')
        else if (event.runtime_window_id !== windowId) codes.add('WINDOW_ID_MISMATCH')
      }
      if (event.clock_source === 'unavailable' && event.monotonic_time_ns !== '0') codes.add('CLOCK_SOURCE_MISMATCH')
    }
    const window = document.window
    if (object(window) && ((window.state === 'open' && window.end_time != null) ||
      (window.state === 'closed' && window.end_time == null))) codes.add('WINDOW_STATE_TIME_MISMATCH')
  } catch {
    codes.add('SCHEMA_VALIDATION_ERROR')
  }
  return { accepted: codes.size === 0, errorCodes: [...codes].sort() }
}

function semanticEqual(left, right) {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => semanticEqual(value, right[index]))
  }
  if (!object(left) || !object(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => has(right, key) && semanticEqual(left[key], right[key]))
}

/**
 * Pair comparison only, with both complete documents validated first.
 * Object order is ignored and array order preserved. Decoded number equality is
 * provisional: this is not RFC 8785 or the still-open MP0 numeric/wire policy.
 * @param {unknown} first
 * @param {unknown} second
 * @returns {{classification: 'duplicate'|'conflict'|'reject', errorCodes: string[]}}
 */
export function classifyObservationDelivery(first, second) {
  const errorCodes = [...new Set([
    ...validateObservationEnvelope(first).errorCodes,
    ...validateObservationEnvelope(second).errorCodes,
  ])].sort()
  if (errorCodes.length) return { classification: 'reject', errorCodes }
  if (first.batch_id !== second.batch_id) return { classification: 'conflict', errorCodes: ['PAIR_BATCH_ID_MISMATCH'] }
  return semanticEqual(first, second)
    ? { classification: 'duplicate', errorCodes: [] }
    : { classification: 'conflict', errorCodes: ['ID_PAYLOAD_CONFLICT'] }
}

function mapEnum(table, value, codes) {
  const mapped = typeof value === 'string' ? ENUM_MAPS[table][value] : undefined
  if (mapped === undefined) codes.add('PROJECTION_UNMAPPED_ENUM')
  return mapped
}

function asUint64String(value, codes, required = false) {
  if (value == null) {
    if (required) codes.add('PROJECTION_SHAPE_ERROR')
    return undefined
  }
  if (typeof value === 'boolean') {
    codes.add('PROJECTION_SHAPE_ERROR')
    return undefined
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return String(value)
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return value
  codes.add('PROJECTION_SHAPE_ERROR')
  return undefined
}

function asCoverageString(value, codes) {
  if (typeof value === 'boolean') {
    codes.add('PROJECTION_SHAPE_ERROR')
    return undefined
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
    if (value === 0 || value === 1) return String(value)
    const text = value.toFixed(12).replace(/0+$/, '').replace(/\.$/, '')
    if (!/^0\.[0-9]{0,11}[1-9]$/.test(text)) {
      codes.add('PROJECTION_SHAPE_ERROR')
      return undefined
    }
    return text
  }
  if (typeof value === 'string' && /^(0|1|0\.[0-9]{0,11}[1-9])$/.test(value)) return value
  codes.add('PROJECTION_SHAPE_ERROR')
  return undefined
}

function projectOperation(operation, codes) {
  const projected = {
    kind: mapEnum('operation_kind', operation.kind, codes),
    unit_type: mapEnum('operation_unit', operation.unit_type, codes),
    name: operation.name,
    identity_source: mapEnum('identity_source', operation.identity_source, codes),
  }
  if (has(operation, 'http_method')) projected.http_method = operation.http_method
  if (has(operation, 'route_template')) projected.route_template = operation.route_template
  return projected
}

function projectEvent(event, codes) {
  const projected = {
    event_id: event.event_id,
    sequence: asUint64String(event.sequence, codes, true),
    wall_time_unix_nano: asUint64String(event.wall_time_unix_nano, codes, true),
    clock_source: mapEnum('clock_source', event.clock_source, codes),
  }
  if (has(event, 'monotonic_time_ns')) projected.monotonic_time_ns = asUint64String(event.monotonic_time_ns, codes)
  for (const key of ['execution_id', 'runtime_window_id', 'traceparent', 'clock_epoch_id']) {
    if (event[key] != null) projected[key] = event[key]
  }
  const facts = object(event.facts) ? event.facts : {}
  const parent = event.parent_operation_event_id
  if (event.record_type === 'operation_event') {
    const body = {
      operation: projectOperation(object(event.operation) ? event.operation : {}, codes),
      phase: mapEnum('operation_phase', facts.phase, codes),
    }
    if (has(facts, 'outcome')) body.outcome = mapEnum('outcome', facts.outcome, codes)
    if (has(facts, 'duration_ns')) body.duration_ns = asUint64String(facts.duration_ns, codes)
    if (facts.status_code != null) body.status_code = facts.status_code
    projected.operation_event = body
  } else if (event.record_type === 'operation_summary') {
    projected.operation_summary = {
      operation: projectOperation(object(event.operation) ? event.operation : {}, codes),
      calls: asUint64String(facts.calls, codes, true),
      errors: asUint64String(facts.errors, codes, true),
      duration_ns_sum: asUint64String(facts.duration_ns_sum, codes, true),
      duration_ns_max: asUint64String(facts.duration_ns_max, codes, true),
      ...(facts.concurrency_max != null ? { concurrency_max: facts.concurrency_max } : {}),
    }
  } else if (event.record_type === 'external_call') {
    const body = {
      service: facts.service,
      operation: facts.operation,
      attempts: asUint64String(facts.attempts, codes, true),
      errors: asUint64String(facts.errors, codes, true),
      duration_ns: asUint64String(facts.duration_ns, codes, true),
    }
    if (parent != null) body.parent_operation_event_id = parent
    for (const key of ['provider', 'model', 'destination_domain']) {
      if (facts[key] != null) body[key] = facts[key]
    }
    if (has(facts, 'usage')) {
      body.usage = array(facts.usage).filter(object).map((entry) => ({
        unit: entry.unit,
        value: asUint64String(entry.value, codes, true),
        source: mapEnum('usage_source', entry.source, codes),
      }))
    }
    projected.external_call = body
  } else if (event.record_type === 'resource_sample') {
    const measurements = array(facts.measurements).filter(object).map((entry) => {
      const measurement = {
        name: mapEnum('measurement_name', entry.name, codes),
        value: typeof entry.value === 'string' ? entry.value
          : (typeof entry.value === 'number' && Number.isFinite(entry.value) ? String(entry.value) : undefined),
        unit: mapEnum('measurement_unit', entry.unit, codes),
        temporality: mapEnum('temporality', entry.temporality, codes),
        source: entry.source,
        coverage: asCoverageString(entry.coverage, codes),
      }
      if (measurement.value === undefined) codes.add('PROJECTION_SHAPE_ERROR')
      if (entry.counter_epoch_id != null) measurement.counter_epoch_id = entry.counter_epoch_id
      return measurement
    })
    const body = {
      scope: mapEnum('resource_scope', facts.scope, codes),
      sample_kind: mapEnum('sample_kind', facts.sample_kind, codes),
      subject_id: facts.subject_id,
      measurements,
    }
    if (parent != null) body.parent_operation_event_id = parent
    projected.resource_sample = body
  } else if (event.record_type === 'adapter_health') {
    const countersIn = object(facts.counters) ? facts.counters : {}
    const counters = Object.fromEntries(
      Object.keys(countersIn).map((key) => [key, asUint64String(countersIn[key], codes, true)]),
    )
    projected.adapter_health = {
      component: mapEnum('health_component', facts.component, codes),
      status: mapEnum('health_status', facts.status, codes),
      reason_codes: array(facts.reason_codes),
      counters,
    }
  } else {
    codes.add('PROJECTION_SHAPE_ERROR')
  }
  return projected
}

/**
 * Project semantic authoring envelope → Protobuf JSON view without mutating input.
 * @param {unknown} observation
 * @returns {{accepted: boolean, document: object|null, errorCodes: string[]}}
 */
export function projectSemanticEnvelopeToProtobufView(observation) {
  const codes = new Set()
  if (!object(observation)) {
    return { accepted: false, document: null, errorCodes: ['PROJECTION_SHAPE_ERROR'] }
  }
  try {
    const source = object(observation.source) ? observation.source : {}
    const routing = object(observation.routing) ? observation.routing : {}
    const privacy = object(observation.privacy) ? observation.privacy : {}
    const document = {
      protocol_major: PROTOCOL_MAJOR,
      protocol_minor: PROTOCOL_MINOR,
      batch_id: observation.batch_id,
      batch_sequence: asUint64String(observation.batch_sequence, codes, true),
      emitted_at: observation.emitted_at,
      source: {
        language: source.language,
        runtime_name: source.runtime_name,
        runtime_version: source.runtime_version,
        adapter_name: source.adapter_name,
        adapter_version: source.adapter_version,
        runtime_instance_id: source.runtime_instance_id,
        capability_ids: array(source.capability_ids).filter((id) => typeof id === 'string'),
        deployment_mode: mapEnum('deployment_mode', source.deployment_mode, codes),
        ...(source.framework != null ? { framework: source.framework } : {}),
      },
      routing: {
        project_id: asUint64String(routing.project_id, codes, true),
        workload_id: routing.workload_id,
        service_name: routing.service_name,
        ...(routing.organization_id != null
          ? { organization_id: asUint64String(routing.organization_id, codes, true) }
          : {}),
        ...(routing.environment != null ? { environment: routing.environment } : {}),
        ...(routing.release_tag != null ? { release_tag: routing.release_tag } : {}),
      },
      privacy: {
        content_capture: mapEnum('content_capture', privacy.content_capture, codes),
        dimension_policy: mapEnum('dimension_policy', privacy.dimension_policy, codes),
        route_policy: mapEnum('route_policy', privacy.route_policy, codes),
        dropped_dimension_count: asUint64String(privacy.dropped_dimension_count, codes, true),
      },
      events: array(observation.events).filter(object).map((event) => projectEvent(event, codes)),
    }
    if (object(observation.window)) {
      const window = observation.window
      document.window = {
        state: mapEnum('window_state', window.state, codes),
        start_time: window.start_time,
        ...(window.runtime_window_id != null ? { runtime_window_id: window.runtime_window_id } : {}),
        ...(window.end_time != null ? { end_time: window.end_time } : {}),
      }
    }
    if (codes.size) return { accepted: false, document: null, errorCodes: [...codes].sort() }
    return { accepted: true, document, errorCodes: [] }
  } catch {
    return { accepted: false, document: null, errorCodes: ['PROJECTION_SHAPE_ERROR'] }
  }
}

/** @param {unknown} document @returns {{accepted: boolean, errorCodes: string[]}} */
export function validateObservationProtobufView(document) {
  const codes = new Set()
  try {
    if (!inspectJson(document, codes)) {
      codes.add('SCHEMA_VALIDATION_ERROR')
      return { accepted: false, errorCodes: [...codes].sort() }
    }
    if (!validateProtobufViewShape(document)) codes.add('SCHEMA_VALIDATION_ERROR')
  } catch {
    codes.add('SCHEMA_VALIDATION_ERROR')
  }
  return { accepted: codes.size === 0, errorCodes: [...codes].sort() }
}

/**
 * Additive dual-view gate: semantic envelope must validate and project to a valid protobuf view.
 * Does not replace validateObservationEnvelope for TCK.
 * @param {unknown} observation
 * @returns {{accepted: boolean, errorCodes: string[]}}
 */
export function validateObservationDualView(observation) {
  const envelope = validateObservationEnvelope(observation)
  if (!envelope.accepted) return envelope
  const projected = projectSemanticEnvelopeToProtobufView(observation)
  if (!projected.accepted || !projected.document) {
    return { accepted: false, errorCodes: projected.errorCodes.length ? projected.errorCodes : ['PROJECTION_SHAPE_ERROR'] }
  }
  return validateObservationProtobufView(projected.document)
}
