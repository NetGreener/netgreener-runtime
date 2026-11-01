import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runCheckCli } from '../cli/checkCli.js'
import { NetGreenerClient } from '../sdk/client.js'

// Vendored from netgreener_contracts/external-api-gate/v1/scenarios.json.
const vectors = JSON.parse(readFileSync(new URL('../../fixtures/external-api-gate/scenarios.v1.json', import.meta.url), 'utf8')) as {
  scenarios: Array<{ name: string; budgets: Record<string, number | string>; passed: boolean }>
}
const env = { NETGREENER_TOKEN: 'test-token', NETGREENER_ORG_ID: '7', NETGREENER_PROJECT_ID: '1', NETGREENER_API_URL: 'https://example.test' }

test('Node CLI forwards shared scenarios and respects server verdicts', async () => {
  for (const scenario of vectors.scenarios) {
    let called = false
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      called = true
      assert.equal(String(url), 'https://example.test/api/v1/runsessions/99/external-gate')
      assert.equal(init?.method, 'POST')
      assert.deepEqual(JSON.parse(String(init?.body)), scenario.budgets)
      assert.equal((init?.headers as Record<string, string>)['X-Organization-ID'], '7')
      return Response.json({ run_id: 99, project_id: 1, passed: scenario.passed,
        checks: Object.entries(scenario.budgets).filter(([key]) => key.startsWith('max_')).map(([name, limit]) => ({
          name, limit, actual: scenario.passed ? 0 : null, passed: scenario.passed, detail: scenario.name,
        })), current: {}, warnings: [], exit_code: scenario.passed ? 0 : 1, gate_version: 1 })
    }) as typeof fetch
    const flags = Object.entries(scenario.budgets).flatMap(([key, value]) => ['--' + key.replaceAll('_', '-'), String(value)])
    assert.equal(await runCheckCli(['--run-id', '99', ...flags, '--output-json'], env, fetchImpl), scenario.passed ? 0 : 1, scenario.name)
    assert.equal(called, true)
  }
})

test('Node rejects invalid budgets and missing identity before requests', async () => {
  const fetchImpl = (async () => { throw new Error('must not request') }) as typeof fetch
  for (const flags of [[], ['--max-total-tokens', '-1'], ['--max-total-tokens', '1.5'],
    ['--max-external-cost-usd', 'NaN'], ['--max-external-cost-usd', 'Infinity'], ['--external-provider', 'openai'], ['--made-up', '1']]) {
    assert.equal(await runCheckCli(['--run-id', '99', ...flags], env, fetchImpl), 2)
  }
  assert.equal(await runCheckCli(['--max-total-tokens', '1'], env, fetchImpl), 2)
})

test('Node warns only for budget failures; API or malformed replies still fail', async () => {
  const args = ['--run-id', '99', '--max-total-tokens', '10', '--warn-only']
  const failure = { run_id: 99, project_id: 1, checks: [{ name: 'max_total_tokens', limit: 10, actual: null, passed: false, detail: 'Missing usage' }], warnings: [] }
  assert.equal(await runCheckCli(args, env, (async () => Response.json(failure)) as typeof fetch), 0)
  assert.equal(await runCheckCli(args, env, (async () => new Response('not available', { status: 404 })) as typeof fetch), 2)
  assert.equal(await runCheckCli(args, env, (async () => Response.json({ ...failure, checks: [] })) as typeof fetch), 2)
  assert.equal(await runCheckCli(args, env, (async () => Response.json({ ...failure, project_id: 2 })) as typeof fetch), 2)
})

test('Node SDK calls the shared gate endpoint', async () => {
  const budgets = { max_total_tokens: 100, max_external_api_calls: 0 }
  const client = new NetGreenerClient({ baseUrl: 'https://example.test/api/v1', token: 'test', fetchImpl: (async (url, init) => {
    assert.equal(String(url), 'https://example.test/api/v1/runsessions/99/external-gate')
    assert.deepEqual(JSON.parse(String(init?.body)), budgets)
    return Response.json({ passed: false })
  }) as typeof fetch })
  assert.equal((await client.evaluateExternalApiGate(99, budgets)).passed, false)
})
