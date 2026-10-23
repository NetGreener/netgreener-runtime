import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import {
  assertUploadForMode,
  createVendorAwareFetch,
  extractPersistedRunId,
  hostnameMatchesVendor,
  isConfiguredApiDestination,
  parseFetchHostname,
  sessionMetadataForDogfood,
  shouldStubVendorFetch,
} from '../dogfood/tenantDogfoodGates.js'

describe('tenant dogfood gates', () => {
  it('stubs only explicit vendor hosts', () => {
    assert.equal(
      shouldStubVendorFetch(
        'https://eastus.api.cognitive.microsoft.com/formrecognizer/v2.1/prebuilt/receipt/analyze',
      ),
      true,
    )
    assert.equal(
      shouldStubVendorFetch('https://myacct.cognitiveservices.azure.com/documentintelligence/analyze'),
      true,
    )
    assert.equal(shouldStubVendorFetch('https://api.openai.com/v1/chat/completions'), true)
    assert.equal(
      shouldStubVendorFetch('https://my-resource.openai.azure.com/openai/deployments/x/chat/completions'),
      true,
    )
  })

  it('does not stub configured API hosts (localhost or remote)', () => {
    assert.equal(shouldStubVendorFetch('http://127.0.0.1:8000/api/v1/runsessions/'), false)
    assert.equal(shouldStubVendorFetch('http://localhost:8000/api/v1/runsessions/'), false)
    assert.equal(
      shouldStubVendorFetch('https://api.staging.netgreener.example/api/v1/runsessions/'),
      false,
    )
    assert.equal(
      shouldStubVendorFetch('https://netgreener-api.azurewebsites.net/api/v1/runsessions/'),
      false,
    )
  })

  it('does not stub when vendor name appears only in path or query', () => {
    assert.equal(
      shouldStubVendorFetch('https://api.example.com/proxy/openai.com/v1/chat'),
      false,
    )
    assert.equal(
      shouldStubVendorFetch('https://collector.example/path/cognitive.microsoft.com/analyze'),
      false,
    )
    assert.equal(
      shouldStubVendorFetch('https://hooks.example.com/callback?vendor=openai.com'),
      false,
    )
    assert.equal(
      shouldStubVendorFetch(
        'https://netgreener.example/api/v1/runsessions/?note=cognitiveservices.azure.com',
      ),
      false,
    )
  })

  it('rejects lookalike hosts outside vendor DNS boundaries', () => {
    assert.equal(hostnameMatchesVendor('not-openai.com'), false)
    assert.equal(hostnameMatchesVendor('openai.com.evil.example'), false)
    assert.equal(hostnameMatchesVendor('evilopenai.com'), false)
    assert.equal(hostnameMatchesVendor('api.openai.com.attacker.com'), false)
    assert.equal(hostnameMatchesVendor('cognitive.microsoft.com.evil.net'), false)
    assert.equal(hostnameMatchesVendor('mycognitiveservices.azure.com.fake'), false)
    assert.equal(shouldStubVendorFetch('https://not-openai.com/v1/chat'), false)
    assert.equal(shouldStubVendorFetch('https://openai.com.evil.example/v1'), false)
    assert.equal(shouldStubVendorFetch('https://api.openai.com.attacker.com/v1'), false)
  })

  it('parses hostname from URL string, URL object, and Request', () => {
    assert.equal(parseFetchHostname('https://API.OpenAI.com/v1/x'), 'api.openai.com')
    assert.equal(parseFetchHostname(new URL('https://EastUS.api.cognitive.microsoft.com/a')), 'eastus.api.cognitive.microsoft.com')
    assert.equal(parseFetchHostname(new Request('https://api.openai.com/v1/chat')), 'api.openai.com')
    assert.equal(parseFetchHostname('/relative/openai.com/path'), null)
    assert.equal(shouldStubVendorFetch(new URL('https://api.openai.com/v1/chat')), true)
    assert.equal(shouldStubVendorFetch(new Request('https://api.openai.com/v1/chat')), true)
    assert.equal(shouldStubVendorFetch(new Request('https://hooks.example/?q=openai.com')), false)
  })

  it('API destination precedence never stubs the configured API host', () => {
    const api = 'https://api.openai.com'
    assert.equal(isConfiguredApiDestination('api.openai.com', api), true)
    assert.equal(shouldStubVendorFetch('https://api.openai.com/v1/chat/completions', { apiBaseUrl: api }), false)
    assert.equal(
      shouldStubVendorFetch('https://eastus.api.cognitive.microsoft.com/analyze', { apiBaseUrl: api }),
      true,
    )
    assert.equal(
      shouldStubVendorFetch('http://127.0.0.1:8000/api/v1/runsessions/', {
        apiBaseUrl: 'http://127.0.0.1:8000',
      }),
      false,
    )
  })

  it('createVendorAwareFetch uses real HTTP for API hosts and stubs vendors', async () => {
    const realFetch = mock.fn(async () => new Response(JSON.stringify({ run_id: 42 }), { status: 201 }))
    const wrapped = createVendorAwareFetch(realFetch, {
      apiBaseUrl: 'https://api.staging.example',
    })

    const apiRes = await wrapped('https://api.staging.example/api/v1/runsessions/', {
      method: 'POST',
      body: '{}',
    })
    assert.equal(realFetch.mock.callCount(), 1)
    assert.equal(apiRes.status, 201)
    assert.deepEqual(await apiRes.json(), { run_id: 42 })

    const vendorRes = await wrapped('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: '{}',
    })
    assert.equal(realFetch.mock.callCount(), 1)
    assert.equal(vendorRes.status, 200)
    const vendorBody = await vendorRes.json()
    assert.equal(vendorBody.usage.prompt_tokens, 120)

    // Path contains vendor name but host is API — still real HTTP.
    await wrapped('https://api.staging.example/mirror/openai.com/chat', { method: 'POST' })
    assert.equal(realFetch.mock.callCount(), 2)

    // Request object to vendor is stubbed; Request to API is not.
    await wrapped(new Request('https://api.openai.com/v1/chat'))
    assert.equal(realFetch.mock.callCount(), 2)
    await wrapped(new Request('https://api.staging.example/api/v1/runsessions/'), { method: 'POST' })
    assert.equal(realFetch.mock.callCount(), 3)
  })

  it('live mode fails when upload is not ok', () => {
    const gate = assertUploadForMode(
      'acme',
      { ok: false, error: 'HTTP 401', status: 401 },
      { live: true },
    )
    assert.equal(gate.ok, false)
    assert.match(gate.reason || '', /live upload failed/)
  })

  it('live mode rejects dry-run results and non-2xx', () => {
    assert.equal(
      assertUploadForMode('acme', { ok: true, status: 200, dryRun: true }, { live: true }).ok,
      false,
    )
    assert.equal(assertUploadForMode('acme', { ok: true, status: 500 }, { live: true }).ok, false)
  })

  it('live mode never accepts local payload as substitute for failed upload', () => {
    const resolved = sessionMetadataForDogfood({
      live: true,
      flushResult: { ok: false, error: 'network down', status: 0 },
      flushPayload: {
        session_metadata: {
          external_api_v0: {
            by_tenant: { org_acme: { calls: 2 } },
          },
        },
      },
    })
    assert.equal(resolved.uploadGate.ok, false)
    assert.equal(resolved.sessionMetadata, null)
  })

  it('live mode requires successful upload then uses payload metadata', () => {
    const resolved = sessionMetadataForDogfood({
      live: true,
      flushResult: { ok: true, status: 201, body: { run_id: 99 } },
      flushPayload: {
        session_metadata: {
          external_api_v0: {
            by_tenant: { org_acme: { calls: 2 } },
          },
        },
      },
    })
    assert.equal(resolved.uploadGate.ok, true)
    assert.ok(resolved.sessionMetadata?.external_api_v0)
    assert.equal(extractPersistedRunId({ run_id: 99 }), 99)
  })

  it('dry-run may use flush body session_metadata', () => {
    const resolved = sessionMetadataForDogfood({
      live: false,
      flushResult: {
        ok: true,
        status: 200,
        dryRun: true,
        body: {
          session_metadata: {
            external_api_v0: { by_tenant: { org_beta: { calls: 1 } } },
          },
        },
      },
    })
    assert.equal(resolved.uploadGate.ok, true)
    assert.equal(
      (
        resolved.sessionMetadata?.external_api_v0 as {
          by_tenant: Record<string, { calls: number }>
        }
      ).by_tenant.org_beta.calls,
      1,
    )
  })
})
