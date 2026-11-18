import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ServiceRuntimeAggregator } from '../aggregator.js'
import {
  attachWindowTenantToRunContext,
  loadTenantConfig,
  normalizeTenantId,
  resolveTenantFromHttpRequest,
  runWithTenantContext,
  getTenantContext,
  setTenantContext,
} from '../tenantContext.js'

describe('tenantContext', () => {
  it('normalizeTenantId rejects email-like values', () => {
    assert.equal(normalizeTenantId('org_abc'), 'org_abc')
    assert.equal(normalizeTenantId('jane@acme.com'), null)
  })

  it('rejects long tenant IDs instead of merging distinct customers', () => {
    assert.equal(normalizeTenantId('a'.repeat(128)), 'a'.repeat(128))
    assert.equal(normalizeTenantId('a'.repeat(128) + 'x'), null)
    assert.equal(normalizeTenantId('a'.repeat(128) + 'y'), null)
  })

  it('manual bindings validate identity and nested scopes restore outer context', () => {
    runWithTenantContext({ tenantId: 'outer', tenantSource: 'manual' }, () => {
      assert.throws(() => setTenantContext({ tenantId: 'x'.repeat(129), tenantSource: 'manual' }))
      assert.equal(getTenantContext()?.tenantId, 'outer')
      runWithTenantContext({ tenantId: 'inner', tenantSource: 'manual' }, () => {
        assert.equal(getTenantContext()?.tenantId, 'inner')
      })
      assert.equal(getTenantContext()?.tenantId, 'outer')
    })
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
