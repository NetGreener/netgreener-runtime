import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it, beforeEach, afterEach } from 'node:test'

import {
  ExternalApiAggregator,
  _awaitPendingUsageParses,
  _resetOutboundInstrumentationForTests,
  clearExternalAggregator,
  extractUsageFromResponse,
  getExternalAggregator,
  installOutboundInstrumentation,
  providerForHost,
  tokensFromUsage,
  usageFromClientBody,
  usageFromSseText,
} from '../externalApiMeter.js'
import { runWithTenantContext } from '../tenantContext.js'
import { runWithRequestAttribution } from '../requestContext.js'
import { validateExternalApiV0 } from '../contract/validate.js'

const requireFromTest = createRequire(import.meta.url)

describe('providerForHost', () => {
  it('maps known OCR and LLM hosts', () => {
    assert.equal(
      providerForHost('eastus.api.cognitive.microsoft.com'),
      'azure_document_intelligence',
    )
    assert.equal(providerForHost('api.openai.com'), 'openai')
    assert.equal(providerForHost('textract.us-east-1.amazonaws.com'), 'aws_textract')
  })

  it('falls back to registered domain', () => {
    assert.equal(providerForHost('api.example-vendor.com'), 'example-vendor.com')
  })
})

describe('tokensFromUsage', () => {
  it('reads OpenAI chat usage', () => {
    const [input, output] = tokensFromUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
    })
    assert.equal(input, 10)
    assert.equal(output, 5)
  })

  it('prefers non-zero input_tokens over empty prompt_tokens', () => {
    const [input, output] = tokensFromUsage({
      prompt_tokens: 0,
      completion_tokens: 0,
      input_tokens: 1200,
      output_tokens: 80,
    })
    assert.equal(input, 1200)
    assert.equal(output, 80)
  })
})

describe('usageFromSseText', () => {
  it('reads OpenAI chat usage from the last SSE chunk', () => {
    const extracted = usageFromSseText(
      'data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}\n' +
        'data: {"id":"1","model":"gpt-4o-mini","usage":{"prompt_tokens":10,"completion_tokens":3}}\n' +
        'data: [DONE]\n',
    )
    assert.equal(extracted.input, 10)
    assert.equal(extracted.output, 3)
    assert.equal(extracted.model, 'gpt-4o-mini')
  })

  it('reads nested OpenAI Responses usage', () => {
    const extracted = usageFromSseText(
      'event: response.completed\n' +
        'data: {"type":"response.completed","response":{"model":"gpt-4.1-mini",' +
        '"usage":{"input_tokens":21,"output_tokens":8,"total_tokens":29}}}\n\n',
    )
    assert.equal(extracted.input, 21)
    assert.equal(extracted.output, 8)
    assert.equal(extracted.model, 'gpt-4.1-mini')
  })

  it('keeps split Anthropic input and output events', () => {
    const extracted = usageFromSseText(
      'data: {"type":"message_start","message":{"model":"claude-3-5-sonnet",' +
        '"usage":{"input_tokens":17,"output_tokens":0}}}\n' +
        'data: {"type":"message_delta","usage":{"output_tokens":6}}\n',
    )
    assert.equal(extracted.input, 17)
    assert.equal(extracted.output, 6)
    assert.equal(extracted.model, 'claude-3-5-sonnet')
  })
})

describe('extractUsageFromResponse', () => {
  it('reads Gemini usageMetadata from JSON', async () => {
    const response = new Response(
      JSON.stringify({
        modelVersion: 'gemini-2.0-flash',
        usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 12, totalTokenCount: 52 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
    const extracted = await extractUsageFromResponse(response, 'https://generativelanguage.googleapis.com/v1/models')
    assert.equal(extracted.input, 40)
    assert.equal(extracted.output, 12)
    assert.equal(extracted.model, 'gemini-2.0-flash')
  })

  it('reads usage from SSE even when content-type is not JSON', async () => {
    const body =
      'data: {"id":"1","model":"gpt-4o-mini","usage":{"prompt_tokens":4,"completion_tokens":2}}\n' +
      'data: [DONE]\n'
    const response = new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    const extracted = await extractUsageFromResponse(response, 'https://api.openai.com/v1/chat/completions')
    assert.equal(extracted.input, 4)
    assert.equal(extracted.output, 2)
    assert.equal(extracted.model, 'gpt-4o-mini')
  })

  it('reads usage from HTTP error JSON bodies', async () => {
    const response = new Response(
      JSON.stringify({ usage: { prompt_tokens: 9, completion_tokens: 1 } }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    )
    const extracted = await extractUsageFromResponse(response, 'https://api.openai.com/v1/chat/completions')
    assert.equal(extracted.input, 9)
    assert.equal(extracted.output, 1)
  })
})

describe('ExternalApiAggregator by_tenant', () => {
  beforeEach(() => {
    clearExternalAggregator()
  })

  it('buckets providers per tenant from context', () => {
    runWithTenantContext(
      { tenantId: 'org_acme', tenantSource: 'manual' },
      () => {
        getExternalAggregator().record({
          host: 'eastus.api.cognitive.microsoft.com',
          durationMs: 120,
          error: false,
          serviceUnit: 'POST /v1/documents/ocr',
        })
      },
    )
    runWithTenantContext(
      { tenantId: 'org_beta', tenantSource: 'manual' },
      () => {
        getExternalAggregator().record({
          host: 'eastus.api.cognitive.microsoft.com',
          durationMs: 80,
          error: false,
          serviceUnit: 'POST /v1/documents/ocr',
        })
        getExternalAggregator().record({
          host: 'eastus.api.cognitive.microsoft.com',
          durationMs: 90,
          error: true,
          serviceUnit: 'POST /v1/documents/ocr',
        })
      },
    )

    const payload = getExternalAggregator().buildV0()
    assert.ok(payload)
    assert.equal(payload!.collector, 'outbound_http')
    assert.equal(payload!.providers[0].provider_key, 'azure_document_intelligence')
    assert.equal(payload!.providers[0].calls, 3)
    assert.ok(payload!.by_tenant)
    assert.equal(payload!.by_tenant!.org_acme.calls, 1)
    assert.equal(payload!.by_tenant!.org_beta.calls, 2)
    assert.equal(payload!.by_tenant!.org_beta.errors, 1)
    assert.ok(payload!.by_service_unit)
    assert.equal(
      (payload!.by_service_unit!['POST /v1/documents/ocr'] as { calls: number }).calls,
      3,
    )

    const validated = validateExternalApiV0(payload)
    assert.equal(validated.ok, true, JSON.stringify(validated.issues))
  })

  it('skips localhost and excluded hosts', () => {
    const agg = new ExternalApiAggregator()
    agg.setExcludedHosts(['core-api.netgreener.com'])
    agg.record({ host: 'localhost', durationMs: 1 })
    agg.record({ host: 'core-api.netgreener.com', durationMs: 1 })
    agg.record({ host: 'api.openai.com', durationMs: 10 })
    const payload = agg.buildV0()
    assert.ok(payload)
    assert.equal(payload!.providers.length, 1)
    assert.equal(payload!.providers[0].provider_key, 'openai')
  })

  it('counts calls with usage separately from token-less streams', () => {
    const agg = new ExternalApiAggregator()
    agg.record({
      host: 'api.openai.com',
      durationMs: 10,
      inputTokens: 100,
      outputTokens: 50,
      model: 'gpt-4o-mini',
    })
    agg.record({ host: 'api.openai.com', durationMs: 8, model: 'gpt-4o-mini' })
    const payload = agg.buildV0()
    assert.ok(payload)
    assert.equal(payload!.providers[0].calls, 2)
    assert.equal(payload!.providers[0].calls_with_usage, 1)
    assert.equal(payload!.providers[0].by_model?.[0].calls, 2)
    assert.equal(payload!.providers[0].by_model?.[0].calls_with_usage, 1)
  })

  it('attributes service unit from request ALS', () => {
    clearExternalAggregator()
    runWithRequestAttribution({ serviceUnit: 'GET /health' }, () => {
      getExternalAggregator().record({
        host: 'api.stripe.com',
        durationMs: 5,
      })
    })
    const payload = getExternalAggregator().buildV0()
    assert.ok(payload?.by_service_unit?.['GET /health'])
  })

  it('preserves explicit tenantless and unknown call-entry snapshots', () => {
    clearExternalAggregator()
    runWithTenantContext({ tenantId: 'org_late', tenantSource: 'verified-auth' }, () => {
      runWithRequestAttribution({ serviceUnit: 'GET /after-auth' }, () => {
        getExternalAggregator().record({
          host: 'api.openai.com',
          durationMs: 10,
          serviceUnit: null,
          tenantId: null,
        })
      })
    })
    const payload = getExternalAggregator().buildV0()
    assert.ok(payload)
    assert.equal(payload!.by_tenant, undefined)
    assert.ok(payload!.by_service_unit?.__unknown__)
    assert.equal(
      (payload!.by_service_unit!.__unknown__ as { calls: number }).calls,
      1,
    )
  })
})

describe('installOutboundInstrumentation', () => {
  beforeEach(() => {
    _resetOutboundInstrumentationForTests()
  })
  afterEach(() => {
    _resetOutboundInstrumentationForTests()
  })

  it('wraps fetch and records outbound calls', async () => {
    installOutboundInstrumentation({ excludedHosts: [] })
    const prev = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ usage: { prompt_tokens: 2, completion_tokens: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    // Re-install over our stub is wrong — instead call aggregator via wrapped path:
    // Reset and wrap a custom base by temporarily assigning fetch then installing.
    _resetOutboundInstrumentationForTests()
    const stubFetch = (async () =>
      new Response(JSON.stringify({ usage: { prompt_tokens: 2, completion_tokens: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    globalThis.fetch = stubFetch
    installOutboundInstrumentation()

    const res = await runWithTenantContext(
      { tenantId: 'org_acme', tenantSource: 'manual' },
      () => fetch('https://api.openai.com/v1/chat/completions'),
    )
    assert.equal(res.status, 200)

    const payload = getExternalAggregator().buildV0()
    assert.ok(payload)
    assert.equal(payload!.providers[0].provider_key, 'openai')
    assert.equal(payload!.providers[0].input_tokens, 2)
    assert.equal(payload!.by_tenant?.org_acme.calls, 1)

    globalThis.fetch = prev
  })

  it('records SSE usage without blocking the caller on headers', async () => {
    const prev = globalThis.fetch
    _resetOutboundInstrumentationForTests()
    const sse =
      'data: {"id":"1","model":"gpt-4o-mini","usage":{"prompt_tokens":8,"completion_tokens":3}}\n' +
      'data: [DONE]\n'
    globalThis.fetch = (async () =>
      new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch
    installOutboundInstrumentation()

    const res = await fetch('https://api.openai.com/v1/chat/completions')
    assert.equal(res.status, 200)
    await _awaitPendingUsageParses()

    const payload = getExternalAggregator().buildV0()
    assert.ok(payload)
    assert.equal(payload!.providers[0].provider_key, 'openai')
    assert.equal(payload!.providers[0].input_tokens, 8)
    assert.equal(payload!.providers[0].output_tokens, 3)

    globalThis.fetch = prev
  })

  it('records tokens from 429 JSON bodies', async () => {
    const prev = globalThis.fetch
    _resetOutboundInstrumentationForTests()
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ usage: { prompt_tokens: 9, completion_tokens: 1 } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    installOutboundInstrumentation()

    const res = await fetch('https://api.openai.com/v1/chat/completions')
    assert.equal(res.status, 429)

    const payload = getExternalAggregator().buildV0()
    assert.ok(payload)
    assert.equal(payload!.providers[0].errors, 1)
    assert.equal(payload!.providers[0].input_tokens, 9)
    assert.equal(payload!.providers[0].output_tokens, 1)

    globalThis.fetch = prev
  })
})

describe('usageFromClientBody', () => {
  it('reads OpenAI usage from axios-style JSON objects', () => {
    const extracted = usageFromClientBody(
      { model: 'gpt-4o-mini', usage: { prompt_tokens: 4, completion_tokens: 2 } },
      'https://api.openai.com/v1/chat/completions',
    )
    assert.equal(extracted.input, 4)
    assert.equal(extracted.output, 2)
    assert.equal(extracted.model, 'gpt-4o-mini')
  })

  it('does not consume stream-shaped bodies', () => {
    const streamLike = { pipe() {} }
    const extracted = usageFromClientBody(
      streamLike,
      'https://api.openai.com/v1/chat/completions',
    )
    assert.equal(extracted.input, 0)
    assert.equal(extracted.output, 0)
  })
})

describe('axios and undici soft wraps', () => {
  beforeEach(() => {
    _resetOutboundInstrumentationForTests()
  })
  afterEach(() => {
    _resetOutboundInstrumentationForTests()
  })

  it('meters axios when the optional peer is installed', async () => {
    let axios: import('axios').AxiosStatic
    try {
      axios = requireFromTest('axios') as import('axios').AxiosStatic
    } catch {
      // Optional peer missing in some environments — skip without failing the suite.
      return
    }

    installOutboundInstrumentation({ excludedHosts: [] })

    // Stub the http adapter so we never hit the network.
    const originalAdapter = axios.defaults.adapter
    axios.defaults.adapter = async (config: import('axios').InternalAxiosRequestConfig) => {
      return {
        data: { usage: { prompt_tokens: 11, completion_tokens: 3 }, model: 'gpt-4o-mini' },
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        config,
        request: {},
      }
    }

    try {
      await runWithTenantContext({ tenantId: 'org_axios', tenantSource: 'manual' }, () =>
        axios.get('https://api.openai.com/v1/chat/completions'),
      )

      const payload = getExternalAggregator().buildV0()
      assert.ok(payload)
      assert.equal(payload!.providers[0].provider_key, 'openai')
      assert.equal(payload!.providers[0].input_tokens, 11)
      assert.equal(payload!.providers[0].output_tokens, 3)
      assert.equal(payload!.by_tenant?.org_axios.calls, 1)
    } finally {
      axios.defaults.adapter = originalAdapter
    }
  })

  it('does not double-count when axios uses the fetch adapter', async () => {
    let axios: import('axios').AxiosStatic
    try {
      axios = requireFromTest('axios') as import('axios').AxiosStatic
    } catch {
      return
    }

    const prevFetch = globalThis.fetch
    let fetchHits = 0
    globalThis.fetch = (async () => {
      fetchHits += 1
      return new Response(
        JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 1 }, model: 'gpt-4o-mini' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch

    try {
      installOutboundInstrumentation({ excludedHosts: [] })
      const originalAdapter = axios.defaults.adapter
      axios.defaults.adapter = 'fetch'

      try {
        await axios.get('https://api.openai.com/v1/chat/completions')
        const payload = getExternalAggregator().buildV0()
        assert.ok(payload)
        assert.equal(fetchHits, 1)
        assert.equal(payload!.providers[0].calls, 1, 'axios+fetch must count once')
        assert.equal(payload!.providers[0].input_tokens, 5)
      } finally {
        axios.defaults.adapter = originalAdapter
      }
    } finally {
      globalThis.fetch = prevFetch
    }
  })

  it('meters undici.request call/error without consuming the body', async () => {
    type UndiciMod = {
      request: (url: string) => Promise<{ statusCode: number; body: { dump: () => Promise<unknown> } }>
      MockAgent: new () => {
        disableNetConnect: () => void
        get: (origin: string) => {
          intercept: (opts: { path: string; method: string }) => {
            reply: (
              status: number,
              body: unknown,
              opts?: { headers?: Record<string, string> },
            ) => void
          }
        }
        close: () => Promise<void>
      }
      setGlobalDispatcher: (d: unknown) => void
      getGlobalDispatcher: () => unknown
    }
    let undici: UndiciMod
    try {
      // Must use the same CJS resolve path installOutboundInstrumentation patches.
      undici = requireFromTest('undici') as UndiciMod
    } catch {
      return
    }

    installOutboundInstrumentation({ excludedHosts: [] })

    const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } = undici
    const previous = getGlobalDispatcher()
    const agent = new MockAgent()
    agent.disableNetConnect()
    setGlobalDispatcher(agent)
    const pool = agent.get('https://api.openai.com')
    pool
      .intercept({ path: '/v1/models', method: 'GET' })
      .reply(200, { data: [] }, { headers: { 'content-type': 'application/json' } })

    try {
      const res = await undici.request('https://api.openai.com/v1/models')
      assert.equal(res.statusCode, 200)
      await res.body.dump()

      const payload = getExternalAggregator().buildV0()
      assert.ok(payload)
      assert.equal(payload!.providers[0].provider_key, 'openai')
      assert.equal(payload!.providers[0].calls, 1)
      // Undici path records call/error/duration only; zero tokens are omitted from the row.
      assert.equal(payload!.providers[0].input_tokens ?? 0, 0)
      assert.equal(payload!.providers[0].output_tokens ?? 0, 0)
    } finally {
      setGlobalDispatcher(previous)
      await agent.close()
    }
  })
})
