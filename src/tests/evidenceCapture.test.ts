import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { validateEvidenceMetadata, validateRuntimeSessionMetadata } from '../contract/validate.js'
import { NetGreenerClient } from '../sdk/client.js'

// Vendored from netgreener_contracts/fixtures for standalone package tests.
const fixture = JSON.parse(readFileSync(new URL('../../fixtures/evidence_capture_v1.json', import.meta.url), 'utf8')) as {
  metadata_cases: Array<{ name: string; valid: boolean; metadata: Record<string, unknown> }>
  recommendation_outcome: Record<string, unknown>
}

test('vendored evidence scenarios match the shared contract when available', () => {
  const canonical = new URL('../../../netgreener_contracts/fixtures/evidence_capture_v1.json', import.meta.url)
  if (existsSync(canonical)) assert.deepEqual(fixture, JSON.parse(readFileSync(canonical, 'utf8')))
})

for (const scenario of fixture.metadata_cases) {
  test(`shared evidence contract: ${scenario.name}`, () => {
    const result = validateEvidenceMetadata(scenario.metadata)
    assert.equal(result.ok, scenario.valid, JSON.stringify(result.issues))
    // Exercise the uploader's full validator as well as the isolated fragment.
    const runtime = validateRuntimeSessionMetadata({ ...scenario.metadata,
      external_api_v0: { collector: 'test', providers: [] },
    })
    assert.equal(runtime.ok, scenario.valid, JSON.stringify(runtime.issues))
  })
}

test('Node SDK preserves evidence metadata and recommendation outcome payloads', async () => {
  const calls: Array<{ url: string; body: unknown }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const client = new NetGreenerClient({ baseUrl: 'https://example.test/api/v1', token: 'test', fetchImpl })
  const payload = { project_id: 1, session_metadata: fixture.metadata_cases[0].metadata }
  await client.postRunSession(payload)
  const feedback = { verdict: 'confirmed', note: 'Measured result', recommendation_outcome: fixture.recommendation_outcome }
  await client.submitFindingFeedback(7, feedback)
  assert.deepEqual(calls[0].body, payload)
  assert.deepEqual(calls[1].body, feedback)
  assert.ok(calls[1].url.endsWith('/findings/7/feedback'))
})
