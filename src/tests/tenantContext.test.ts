import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ServiceRuntimeAggregator } from '../aggregator.js'
import {
  attachWindowTenantToRunContext,
  loadTenantConfig,
  normalizeTenantId,
  resolveTenantFromHttpRequest,
  runWithTenantContext,
} from '../tenantContext.js'

describe('tenantContext', () => {
  it('normalizeTenantId rejects email-like values', () => {
    assert.equal(normalizeTenantId('org_abc'), 'org_abc')
    assert.equal(normalizeTenantId('jane@acme.com'), null)
  })

  it('resolveTenantFromHttpRequest reads header', () => {
    const config = loadTenantConfig({
      NETGREENER_TENANT_SOURCE: 'header',
      NETGREENER_TENANT_HEADER: 'X-Organization-Id',
    })
    const ctx = resolveTenantFromHttpRequest(
      { headers: { 'X-Organization-Id': 'org_beta' } },
      config,
    )
    assert.deepEqual(ctx, { tenantId: 'org_beta', tenantSource: 'header:X-Organization-Id' })
  })

  it('attachWindowTenantToRunContext stamps single-tenant windows', () => {
    const runContext: Record<string, unknown> = {}
    attachWindowTenantToRunContext(runContext, {
      runtimeV0: {
        by_tenant: {
          org_a: { tenant_id: 'org_a', calls: 1, errors: 0, units: [] },
        },
      },
      tenantConfig: loadTenantConfig({ NETGREENER_TENANT_SOURCE: 'header' }),
    })
    assert.equal(runContext.tenant_id, 'org_a')
  })
})

describe('ServiceRuntimeAggregator by_tenant', () => {
  it('records tenant buckets when tenant context is active', () => {
    const agg = new ServiceRuntimeAggregator()
    runWithTenantContext(
      { tenantId: 'org_7f3a9c2b', tenantSource: 'manual' },
      () => {
        agg.record({
          serviceUnit: 'POST /v1/documents/ocr',
          durationMs: 120,
          error: false,
          tenantId: 'org_7f3a9c2b',
        })
      },
    )
    const payload = agg.buildV0({
      collector: 'express_middleware',
      framework: 'express',
      windowEnergyKwh: 0.001,
      windowSeconds: 60,
    })
    assert.ok(payload?.by_tenant?.org_7f3a9c2b)
    assert.equal(payload?.by_tenant?.org_7f3a9c2b.calls, 1)
  })
})
