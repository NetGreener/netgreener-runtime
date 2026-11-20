import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  runWithExecution, currentExecutionContext, newExecutionContext, executionCarrier,
  executionHeaders, EXECUTION_HEADER, type ExecutionContext,
  validateExecutionContext,
} from '../requestContext.js'
import { ExternalApiAggregator, StreamUsageMeter, getExternalAggregator, clearExternalAggregator } from '../externalApiMeter.js'
import { runWithTenantContext } from '../tenantContext.js'
import { validateExternalApiV0, validateExecutionCallsV1 } from '../contract/validate.js'

const fixture = JSON.parse(readFileSync(new URL('../../fixtures/execution_attribution_v1.json', import.meta.url), 'utf8')) as {
  carrier_cases: Array<{ name: string; carrier: unknown; state: string }>
  context_cases: Array<{ name: string; value: unknown; valid: boolean }>
  call_cases: Array<{ name: string; value: unknown; valid: boolean; repeat_calls?: number }>
}

for (const scenario of fixture.context_cases) test(`execution context validation: ${scenario.name}`, () => {
  assert.equal(Boolean(validateExecutionContext(scenario.value)), scenario.valid)
})
for (const scenario of fixture.call_cases) test(`execution call validation: ${scenario.name}`, () => {
  let input = scenario.value
  if (scenario.repeat_calls) {
    const obj = input as { calls: unknown[] }
    input = { ...obj, calls: Array(scenario.repeat_calls).fill(obj.calls[0]) }
  }
  const result = validateExecutionCallsV1(input)
  assert.equal(result.ok, scenario.valid, JSON.stringify(result.issues))
})

for (const scenario of fixture.carrier_cases) test(`execution boundary: ${scenario.name}`, () => {
  runWithExecution({ carrier: scenario.carrier, boundary: true }, () => {
    const context = currentExecutionContext()!
    assert.equal(context.link_state, scenario.state)
    if (scenario.state === 'propagated') {
      const carrier = typeof scenario.carrier === 'string' ? JSON.parse(scenario.carrier) : scenario.carrier as Record<string, unknown>
      assert.equal(context.execution_id, carrier.execution_id)
      assert.equal(context.parent_step_id, carrier.step_id)
    } else assert.equal(context.parent_step_id, null)
  })
  assert.equal(currentExecutionContext(), null)
})

test('nested concurrent scopes isolate identities and clean up after rejection', async () => {
  await Promise.all(['a'.repeat(32), 'b'.repeat(32)].map(executionId => runWithExecution({ executionId }, async () => {
    const root = currentExecutionContext()!
    await runWithExecution({}, async () => {
      const step = currentExecutionContext()!
      await Promise.resolve()
      assert.equal(step.execution_id, executionId)
      assert.equal(step.parent_step_id, root.step_id)
      assert.equal(currentExecutionContext(), step)
    })
    assert.equal(currentExecutionContext(), root)
    await assert.rejects(runWithExecution({}, async () => { throw new Error('cancelled') }), /cancelled/)
    assert.equal(currentExecutionContext(), root)
  })))
  assert.equal(currentExecutionContext(), null)
})

test('carrier and explicit HTTP headers contain correlation only', () => {
  runWithExecution({}, () => {
    const ctx = currentExecutionContext()!
    const carrier = executionCarrier()!
    assert.deepEqual(Object.keys(carrier).sort(), ['execution_id', 'schema_version', 'step_id'])
    assert.deepEqual(JSON.parse(executionHeaders()[EXECUTION_HEADER]), carrier)
    ;(carrier as { execution_id: string }).execution_id = 'b'.repeat(32)
    assert.equal(currentExecutionContext(), ctx)
    assert.notEqual(executionCarrier()!.execution_id, carrier.execution_id)
  })
  assert.deepEqual(executionHeaders(), {})
})

test('stream completion retains original execution and tenant after scope exit', () => {
  clearExternalAggregator()
  let root: ExecutionContext
  let stream!: StreamUsageMeter
  runWithExecution({ executionId: 'a'.repeat(32) }, () => {
    root = currentExecutionContext()!
    stream = new StreamUsageMeter({ host: 'api.openai.com', url: 'https://api.openai.com/v1/responses',
      start: performance.now(), error: false, serviceUnit: 'task:agent', tenantId: 'tenant-a',
      executionContext: newExecutionContext() })
  })
  runWithTenantContext({ tenantId: 'tenant-b', tenantSource: 'manual' }, () => runWithExecution({ executionId: 'b'.repeat(32) }, () => {
    stream.feed('data: {"usage":{"input_tokens":7,"output_tokens":3}}\n\n')
    stream.finish()
    stream.finish()
  }))
  const payload = getExternalAggregator().buildV0()!
  const row = payload.execution_calls_v1!.calls[0]
  assert.equal(row.execution_context.execution_id, root!.execution_id)
  assert.equal(row.execution_context.parent_step_id, root!.step_id)
  assert.equal(row.tenant_id, 'tenant-a')
  assert.equal(row.input_tokens, 7)
  assert.equal(payload.providers[0].calls, 1)
  assert.equal(validateExternalApiV0(payload).ok, true)
  clearExternalAggregator()
})

test('linked evidence is bounded and snapshot restore does not change billing counts', () => {
  const agg = new ExternalApiAggregator()
  runWithExecution({}, () => {
    for (let index = 0; index < 205; index++) agg.record({ host: 'api.openai.com', inputTokens: 2, executionContext: newExecutionContext() })
  })
  const snapshot = agg.takeSnapshot()
  assert.equal(agg.buildV0(), null)
  agg.mergeSnapshot(snapshot)
  const payload = agg.buildV0()!
  assert.equal(payload.providers[0].calls, 205)
  assert.equal(payload.execution_calls_v1!.calls.length, 200)
  assert.equal(payload.execution_calls_v1!.dropped, 5)
  assert.equal(payload.execution_calls_v1!.coverage, 'partial')
  assert.equal(validateExternalApiV0(payload).ok, true)
  agg.clear()
  assert.equal(agg.buildV0(), null)
  agg.record({ host: 'api.openai.com', executionContext: newExecutionContext() })
  assert.equal(agg.buildV0()!.execution_calls_v1!.calls[0].token_usage_status, 'unknown_or_zero')
})
