import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { validateRuntimeSessionMetadata } from '../contract/validate.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(here, '../../fixtures/session_metadata_runtime_v0.json')

test('golden fixture validates as runtime session_metadata', () => {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>
  // emitter / schema_note are fixture metadata, not upload fields
  const { emitter: _e, schema_note: _s, ...sessionMetadata } = raw
  const result = validateRuntimeSessionMetadata(sessionMetadata)
  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2))
  assert.equal((sessionMetadata.service_runtime_v0 as { collector: string }).collector, 'express_middleware')
  const providers = (sessionMetadata.external_api_v0 as { providers: { by_model?: unknown[] }[] })
    .providers
  assert.ok(providers[0].by_model && providers[0].by_model.length === 2)
})

test('rejects metadata missing runtime blocks', () => {
  const result = validateRuntimeSessionMetadata({ run_context: { client: 'x' } })
  assert.equal(result.ok, false)
})

test('rejects provider row without provider_key', () => {
  const result = validateRuntimeSessionMetadata({
    external_api_v0: {
      collector: 'outbound_http',
      providers: [{ calls: 1, errors: 0 }],
    },
  })
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((i) => i.path.includes('provider_key')))
})

test('rejects non-finite, negative, fractional, and inconsistent runtime counters', () => {
  const result = validateRuntimeSessionMetadata({
    service_runtime_v0: {
      collector: 'express_middleware',
      window_seconds: Number.POSITIVE_INFINITY,
      attribution: 'duration_share',
      accuracy: 'trend',
      units: [
        {
          service_unit: 'GET /health',
          unit_type: 'http_route',
          calls: 1.5,
          errors: 2,
          cpu_seconds_total: Number.NaN,
          energy_kwh: -1,
          carbon_g: Number.POSITIVE_INFINITY,
          duration_ms: { avg: -1, max: Number.NaN },
        },
      ],
      allocation_reconciliation_v0: {
        schema_version: 1.5,
        window_energy_kwh: Number.POSITIVE_INFINITY,
        allocated_energy_kwh: -1,
        residual_energy_kwh: Number.NaN,
        tolerance_kwh: -1,
        passed: false,
        scope: 'service_runtime_v0.units',
        endpoint_capture_coverage: 2,
        capture_completeness: 'partial',
      },
    },
    measurement_provenance: {
      carbon_factor: {
        value: Number.POSITIVE_INFINITY,
        unit: 'kg_co2e_per_kwh',
        source: 'invalid-test-value',
      },
    },
  })

  assert.equal(result.ok, false)
  const paths = result.issues.map((item) => item.path)
  assert.ok(paths.includes('service_runtime_v0.window_seconds'))
  assert.ok(paths.includes('service_runtime_v0.units[0].calls'))
  assert.ok(paths.includes('service_runtime_v0.units[0].errors'))
  assert.ok(paths.includes('service_runtime_v0.units[0].cpu_seconds_total'))
  assert.ok(paths.includes('service_runtime_v0.units[0].energy_kwh'))
  assert.ok(paths.includes('service_runtime_v0.units[0].carbon_g'))
  assert.ok(paths.includes('service_runtime_v0.units[0].duration_ms.avg'))
  assert.ok(paths.includes('service_runtime_v0.units[0].duration_ms.max'))
  assert.ok(paths.includes('service_runtime_v0.allocation_reconciliation_v0.schema_version'))
  assert.ok(paths.includes('service_runtime_v0.allocation_reconciliation_v0.window_energy_kwh'))
  assert.ok(paths.includes('service_runtime_v0.allocation_reconciliation_v0.allocated_energy_kwh'))
  assert.ok(paths.includes('service_runtime_v0.allocation_reconciliation_v0.residual_energy_kwh'))
  assert.ok(paths.includes('service_runtime_v0.allocation_reconciliation_v0.tolerance_kwh'))
  assert.ok(paths.includes('service_runtime_v0.allocation_reconciliation_v0.endpoint_capture_coverage'))
  assert.ok(paths.includes('measurement_provenance.carbon_factor.value'))
})

test('rejects invalid optional external API measurements and inconsistent counters', () => {
  const result = validateRuntimeSessionMetadata({
    external_api_v0: {
      collector: 'outbound_http',
      providers: [
        {
          provider_key: 'example',
          calls: 1,
          errors: 2,
          duration_ms_avg: Number.POSITIVE_INFINITY,
          input_tokens: -1,
          output_tokens: 1.5,
          total_tokens: Number.MAX_SAFE_INTEGER + 1,
          by_model: [
            {
              model: 'example-model',
              calls: 0,
              errors: 1,
              input_tokens: Number.NaN,
              output_tokens: -1,
              total_tokens: 0.5,
            },
          ],
        },
      ],
    },
  })

  assert.equal(result.ok, false)
  const paths = result.issues.map((item) => item.path)
  assert.ok(paths.includes('external_api_v0.providers[0].errors'))
  assert.ok(paths.includes('external_api_v0.providers[0].duration_ms_avg'))
  assert.ok(paths.includes('external_api_v0.providers[0].input_tokens'))
  assert.ok(paths.includes('external_api_v0.providers[0].output_tokens'))
  assert.ok(paths.includes('external_api_v0.providers[0].total_tokens'))
  assert.ok(paths.includes('external_api_v0.providers[0].by_model[0].errors'))
  assert.ok(paths.includes('external_api_v0.providers[0].by_model[0].input_tokens'))
  assert.ok(paths.includes('external_api_v0.providers[0].by_model[0].output_tokens'))
  assert.ok(paths.includes('external_api_v0.providers[0].by_model[0].total_tokens'))
})
