import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'

import {
  loadTenantConfig,
  resolveTenantFromTaskData,
} from '../tenantContext.js'
import {
  getBullMqRuntime,
  netgreenerBullMqProcessor,
  runBullMqJobWithNetGreener,
} from '../bullmq.js'
import {
  runWithProcessTenant,
  startProcessRuntime,
} from '../processRuntime.js'
import {
  _resetRuntimeForTests,
  getRuntime,
} from '../runtime.js'
import { getExternalAggregator, clearExternalAggregator } from '../externalApiMeter.js'
import { validateServiceRuntimeV0 } from '../contract/validate.js'

describe('resolveTenantFromTaskData', () => {
  it('reads organization_id when task_kwarg is configured', () => {
    const config = loadTenantConfig({
      NETGREENER_TENANT_SOURCE: 'task_kwarg',
      NETGREENER_TENANT_TASK_KWARG: 'organization_id',
    } as NodeJS.ProcessEnv)
    const ctx = resolveTenantFromTaskData(
      { organization_id: 'org_acme', document_id: 'd1' },
      config,
    )
    assert.ok(ctx)
    assert.equal(ctx!.tenantId, 'org_acme')
    assert.equal(ctx!.tenantSource, 'task_kwarg:organization_id')
  })

  it('returns null when source is not task_kwarg', () => {
    const config = loadTenantConfig({
      NETGREENER_TENANT_SOURCE: 'jwt_claim',
    } as NodeJS.ProcessEnv)
    assert.equal(
      resolveTenantFromTaskData({ organization_id: 'org_acme' }, config),
      null,
    )
  })
})

describe('netgreenerBullMqProcessor', () => {
  beforeEach(() => {
    _resetRuntimeForTests()
    clearExternalAggregator()
    process.env.NETGREENER_SERVICE_RUNTIME = '1'
    process.env.NETGREENER_TOKEN = 'ngs_test'
    process.env.NETGREENER_PROJECT_ID = '42'
    process.env.NETGREENER_RUNTIME_DRY_RUN = '1'
    process.env.NETGREENER_TENANT_SOURCE = 'task_kwarg'
    process.env.NETGREENER_TENANT_TASK_KWARG = 'organization_id'
  })

  afterEach(() => {
    _resetRuntimeForTests()
    clearExternalAggregator()
    delete process.env.NETGREENER_SERVICE_RUNTIME
    delete process.env.NETGREENER_TOKEN
    delete process.env.NETGREENER_PROJECT_ID
    delete process.env.NETGREENER_RUNTIME_DRY_RUN
    delete process.env.NETGREENER_TENANT_SOURCE
    delete process.env.NETGREENER_TENANT_TASK_KWARG
  })

  it('records task sample and by_tenant on flush', async () => {
    const payloads: unknown[] = []
    const wrapped = netgreenerBullMqProcessor(
      async (job) => {
        assert.equal(job.data?.organization_id, 'org_acme')
        return { ok: true }
      },
      {
        onFlush: (_r, payload) => {
          payloads.push(payload.session_metadata)
        },
      },
    )

    const result = await wrapped({
      id: '1',
      name: 'analyze_document',
      data: { organization_id: 'org_acme', document_id: 'd1' },
    })
    assert.deepEqual(result, { ok: true })

    await getBullMqRuntime().flush('manual')
    assert.equal(payloads.length, 1)
    const meta = payloads[0] as {
      service_runtime_v0?: {
        collector: string
        units: Array<{ service_unit: string; unit_type: string; calls: number }>
        by_tenant?: Record<string, { calls: number }>
      }
    }
    assert.equal(meta.service_runtime_v0?.collector, 'bullmq_worker')
    const unit = meta.service_runtime_v0?.units.find(
      (u) => u.service_unit === 'task:analyze_document',
    )
    assert.ok(unit)
    assert.equal(unit!.unit_type, 'task')
    assert.equal(unit!.calls, 1)
    assert.equal(meta.service_runtime_v0?.by_tenant?.org_acme.calls, 1)
    assert.equal(validateServiceRuntimeV0(meta.service_runtime_v0).ok, true)
  })

  it('marks error outcome on thrown processor', async () => {
    const payloads: unknown[] = []
    const wrapped = netgreenerBullMqProcessor(
      async () => {
        throw new Error('boom')
      },
      {
        onFlush: (_r, payload) => {
          payloads.push(payload.session_metadata)
        },
      },
    )
    await assert.rejects(() =>
      wrapped({ name: 'fail_job', data: { organization_id: 'org_beta' } }),
    )
    await getBullMqRuntime().flush('manual')
    const meta = payloads[0] as {
      service_runtime_v0?: { units: Array<{ service_unit: string; errors: number }> }
    }
    const fail = meta.service_runtime_v0?.units.find(
      (u) => u.service_unit === 'task:fail_job',
    )
    assert.ok(fail)
    assert.equal(fail!.errors, 1)
  })
})

describe('runBullMqJobWithNetGreener', () => {
  beforeEach(() => {
    _resetRuntimeForTests()
    clearExternalAggregator()
    process.env.NETGREENER_SERVICE_RUNTIME = '1'
    process.env.NETGREENER_TOKEN = 'ngs_test'
    process.env.NETGREENER_PROJECT_ID = '7'
    process.env.NETGREENER_RUNTIME_DRY_RUN = '1'
    process.env.NETGREENER_TENANT_SOURCE = 'task_kwarg'
  })
  afterEach(() => {
    _resetRuntimeForTests()
    clearExternalAggregator()
    delete process.env.NETGREENER_SERVICE_RUNTIME
    delete process.env.NETGREENER_TOKEN
    delete process.env.NETGREENER_PROJECT_ID
    delete process.env.NETGREENER_RUNTIME_DRY_RUN
    delete process.env.NETGREENER_TENANT_SOURCE
  })

  it('binds tenant for nested fetch attribution scope', async () => {
    await runBullMqJobWithNetGreener(
      { name: 'ocr', data: { organization_id: 'org_x' } },
      async () => {
        getExternalAggregator().record({
          host: 'api.openai.com',
          durationMs: 12,
        })
        return 1
      },
    )
    const ext = getExternalAggregator().buildV0()
    assert.equal(ext?.by_tenant?.org_x.calls, 1)
  })
})

describe('processRuntime', () => {
  beforeEach(() => {
    _resetRuntimeForTests()
    process.env.NETGREENER_SERVICE_RUNTIME = '1'
    process.env.NETGREENER_TOKEN = 'ngs_test'
    process.env.NETGREENER_PROJECT_ID = '9'
    process.env.NETGREENER_RUNTIME_DRY_RUN = '1'
  })
  afterEach(() => {
    _resetRuntimeForTests()
    delete process.env.NETGREENER_SERVICE_RUNTIME
    delete process.env.NETGREENER_TOKEN
    delete process.env.NETGREENER_PROJECT_ID
    delete process.env.NETGREENER_RUNTIME_DRY_RUN
  })

  it('records batch job under tenant without HTTP middleware', async () => {
    const payloads: unknown[] = []
    startProcessRuntime({
      onFlush: (_r, p) => {
        payloads.push(p.session_metadata)
      },
    })
    await runWithProcessTenant('org_batch', async () => 'done', {
      serviceUnit: 'task:nightly_report',
    })
    await getRuntime({ collector: 'node_process', framework: 'node' }).flush('manual')
    assert.equal(payloads.length, 1)
    const sr = (
      payloads[0] as {
        service_runtime_v0?: {
          collector: string
          by_tenant?: Record<string, { calls: number }>
          units: Array<{ service_unit: string }>
        }
      }
    ).service_runtime_v0
    assert.equal(sr?.collector, 'node_process')
    assert.ok(sr?.units.some((u) => u.service_unit === 'task:nightly_report'))
    assert.equal(sr?.by_tenant?.org_batch.calls, 1)
  })
})
