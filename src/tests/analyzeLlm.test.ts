import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { loadAnalyzeRepositoryConfig } from '../analyze/repoConfig.js'
import { runNodeLlmResourceReview } from '../analyze/llmResourceReview.js'
import { runAnalyzeCli } from '../analyze/cli.js'
import { validateResourceFindingCandidate } from '../analyze/validateResourceFinding.js'

const config = { api_key: 'test-key', model: 'test-model' }
function fixture(count = 1): { root: string; paths: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'netgreener-analyze-llm-'))
  const paths = Array.from({ length: count }, (_, i) => `file${i}.ts`)
  for (const path of paths) writeFileSync(join(root, path), 'const cache = new Map();\n')
  return { root, paths }
}
const completion = (findings: unknown[]) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ findings }) } }] }))
const hit = { mechanism_id: 'memory_retention_or_materialization', primary_domain: 'memory.host', title: 'Unbounded cache retains memory', start_line: 1, evidence: 'const cache = new Map();', recommended_fix: 'Bound cache size.' }

for (const [depth, expected] of [['quick', 1], ['standard', 5], ['thorough', 10]] as const) {
  test(`LLM ${depth} reviews ${expected} files even without static hits`, async () => {
    const { root, paths } = fixture(12)
    const progress: string[] = []
    let calls = 0
    const result = await runNodeLlmResourceReview({ projectDir: root, projectId: '42', paths, staticFindings: [], config, depth,
      progress: message => progress.push(message), fetchImpl: async (_url, init) => {
        assert.ok(init?.signal)
        assert.equal(JSON.parse(String(init?.body)).messages.length, 2)
        calls++
        return completion([hit])
      },
    })
    assert.equal(calls, expected)
    assert.equal(result.filesReviewed, expected)
    assert.equal(result.findings.length, expected)
    assert.equal(progress.length, expected)
    for (const finding of result.findings) assert.equal(validateResourceFindingCandidate(finding).ok, true)
  })
}

test('LLM rejects invented evidence, invalid locations and domains, and duplicate findings', async () => {
  const { root, paths } = fixture()
  const opts = { projectDir: root, projectId: '42', paths, staticFindings: [], config }
  const first = await runNodeLlmResourceReview({ ...opts, fetchImpl: async () => completion([hit]) })
  const result = await runNodeLlmResourceReview({ ...opts, staticFindings: first.findings,
    fetchImpl: async () => completion([hit, { ...hit, start_line: 99 }, { ...hit, start_line: 0 }, { ...hit, evidence: 'invented' }, { ...hit, primary_domain: 'security' }]),
  })
  assert.equal(result.findings.length, 1)
})

test('provider failure stops subsequent files and preserves static findings', async () => {
  const { root, paths } = fixture(5)
  let calls = 0
  const result = await runNodeLlmResourceReview({ projectDir: root, projectId: '42', paths, staticFindings: [], config,
    fetchImpl: async () => { calls++; return new Response('private-provider-error', { status: 429 }) },
  })
  assert.equal(calls, 1)
  assert.equal(result.filesReviewed, 0)
  assert.match(result.errors[0]!, /HTTP 429/)
  assert.doesNotMatch(result.errors[0]!, /private-provider-error/)
})

test('timed out request stops the review without retries', async () => {
  const { root, paths } = fixture(5)
  let calls = 0
  const result = await runNodeLlmResourceReview({ projectDir: root, projectId: '42', paths, staticFindings: [], config, timeoutMs: 10,
    fetchImpl: async (_input, init) => {
      calls++
      await new Promise<void>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('test timeout failed')), 500)
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal?.reason) }, { once: true })
      })
      return completion([])
    },
  })
  assert.equal(calls, 1)
  assert.match(result.errors[0]!, /timeout|timed out/i)
})

test('CLI checks environment project ID before LLM and keeps stdout clean', async () => {
  const { root } = fixture()
  const out: string[] = [], err: string[] = [], requests: string[] = []
  mkdirSync(join(root, '.netgreener'))
  writeFileSync(join(root, '.netgreener/project.yaml'), 'project_id: 142\n')
  const code = await runAnalyzeCli([root, '--project-id', '42', '--depth', 'quick'], {
    env: { NETGREENER_PROJECT_ID: '99', NETGREENER_TOKEN: 'test-token' }, configDir: root,
    stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) },
    fetchImpl: async (input, init) => {
      const url = String(input); requests.push(url)
      if (url.endsWith('/projects/42')) return new Response('{"project_id":42}')
      if (url.endsWith('/config/llm/')) return new Response(JSON.stringify({ ...config, azure_endpoint: 'https://example.openai.azure.com' }))
      assert.match(url, /chat\/completions/)
      assert.ok(init?.signal)
      return completion([hit])
    },
  })
  assert.equal(code, 0)
  const payload = JSON.parse(out.join(''))
  assert.equal(payload.project_id, '42')
  assert.equal(payload.llm_review.filesReviewed, 1)
  assert.equal(payload.findings.length, 1)
  assert.match(err.join(''), /LLM review 1\/1/)
  assert.match(requests[0]!, /projects\/42$/)
})

test('CLI project lookup failure precedes any LLM request', async () => {
  const { root } = fixture()
  const requests: string[] = []
  const code = await runAnalyzeCli([root, '--quiet', '--llm'], { env: { NETGREENER_PROJECT_ID: '42', NETGREENER_TOKEN: 'test' }, configDir: root,
    fetchImpl: async input => { requests.push(String(input)); return new Response('{"detail":"Project not found"}', { status: 404 }) },
  })
  assert.equal(code, 2)
  assert.equal(requests.length, 1)
  assert.match(requests[0]!, /projects\/42$/)
})

test('explicit static mode never calls network even with credentials configured', async () => {
  const { root } = fixture()
  const code = await runAnalyzeCli([root, '--quiet', '--no-llm'], { env: { NETGREENER_TOKEN: 'test' }, configDir: root,
    fetchImpl: async () => { throw new Error('network must not run') },
  })
  assert.equal(code, 0)
})


test('JavaScript BYOK review uses the configured endpoint without managed credentials', async () => {
  const { root } = fixture()
  writeFileSync(join(root, 'entry.js'), 'const cache = new Map();\n')
  let calls = 0
  const result = await runNodeLlmResourceReview({ projectDir: root, projectId: 'local', paths: ['entry.js'], staticFindings: [],
    config: { ...config, azure_endpoint: 'https://provider.example/v1' },
    fetchImpl: async (input, init) => {
      calls++
      assert.equal(String(input), 'https://provider.example/v1/chat/completions')
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-key')
      return completion([hit])
    },
  })
  assert.equal(calls, 1)
  assert.equal(result.findings[0]?.scope.language, 'javascript')
})

test('malformed model response is reported rather than treated as no findings', async () => {
  const { root, paths } = fixture()
  const result = await runNodeLlmResourceReview({ projectDir: root, projectId: 'local', paths, staticFindings: [], config,
    fetchImpl: async () => new Response('{"choices":[{"message":{"content":"{}"}}]}'),
  })
  assert.equal(result.filesReviewed, 0)
  assert.match(result.errors[0]!, /expected findings array/)
})


for (const language of ['js', 'ts']) {
  for (const provider of ['openai', 'azure_openai', 'anthropic', 'ollama', 'custom']) {
    test(`${language}: ${provider} LLM review uses the correct protocol`, async () => {
      const { root } = fixture()
      const file = `review.${language}`
      writeFileSync(join(root, file), 'const cache = new Map();\n')
      const endpoint = provider === 'ollama' ? 'http://localhost:11434' : 'https://provider.example/v1'
      let calls = 0
      const result = await runNodeLlmResourceReview({
        projectDir: root, projectId: '142', paths: [file], staticFindings: [],
        config: { provider, api_key: ['custom', 'ollama'].includes(provider) ? '' : 'test-key', model: 'test-model', azure_endpoint: endpoint },
        fetchImpl: async (input, init) => {
          calls++
          const url = String(input)
          const body = JSON.parse(String(init?.body))
          const headers = init?.headers as Record<string, string>
          assert.ok(init?.signal)
          if (provider === 'anthropic') {
            assert.equal(url, 'https://provider.example/v1/messages')
            assert.equal(headers['x-api-key'], 'test-key')
            assert.equal(headers['anthropic-version'], '2023-06-01')
            assert.equal(body.messages.length, 1)
            assert.match(body.system, /NetGreener/)
            return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ findings: [hit] }) }] }))
          }
          if (provider === 'azure_openai') {
            assert.match(url, /openai\/deployments\/test-model\/chat\/completions/)
            assert.equal(headers['api-key'], 'test-key')
          } else {
            assert.match(url, /\/v1\/chat\/completions$/)
            assert.equal(body.model, 'test-model')
            if (provider === 'ollama' || provider === 'custom') assert.equal(headers.Authorization, undefined)
          }
          return completion([hit])
        },
      })
      assert.deepEqual(result.errors, [])
      assert.equal(calls, 1)
      assert.equal(result.findings[0]?.scope.language, language === 'js' ? 'javascript' : 'typescript')
    })
  }
}

test('repository YAML/JSON identity and API config match Python precedence', () => {
  for (const extension of ['yaml', 'yml', 'json']) {
    const { root } = fixture()
    const dir = join(root, '.netgreener')
    mkdirSync(dir)
    writeFileSync(join(dir, `project.${extension}`), extension === 'json' ? '{"project_id":"142","org_slug":"Acme"}' : 'project_id: "142"\norg_slug: Acme\n')
    writeFileSync(join(dir, `config.${extension}`), extension === 'json' ? '{"api_url":"http://localhost:8000/","environment":"DEV"}' : 'api_url: http://localhost:8000/\nenvironment: DEV\n')
    assert.deepEqual(loadAnalyzeRepositoryConfig(root), { projectId: '142', orgSlug: 'acme', apiUrl: 'http://localhost:8000', environment: 'dev' })
  }
})

test('repository config supports Python project .env API URL fallback', () => {
  const { root } = fixture()
  writeFileSync(join(root, '.env'), 'NETGREENER_API_URL="http://localhost:8000/"\n')
  assert.equal(loadAnalyzeRepositoryConfig(root).apiUrl, 'http://localhost:8000')
})

test('malformed repository identity fails clearly instead of choosing a different project', () => {
  const { root } = fixture()
  mkdirSync(join(root, '.netgreener'))
  writeFileSync(join(root, '.netgreener', 'project.yaml'), 'project_id: false\n')
  assert.throws(() => loadAnalyzeRepositoryConfig(root), /positive integer/)
})

test('CLI performs managed project lookup and LLM review through a real local HTTP server', async () => {
  const { root } = fixture()
  mkdirSync(join(root, '.netgreener'))
  const paths: string[] = []
  let origin = ''
  const server = createServer(async (req, res) => {
    paths.push(req.url || '')
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/v1/projects/142') {
      assert.equal(req.headers.authorization, 'Bearer fake-service-token')
      assert.equal(req.headers['x-environment'], 'dev')
      res.end('{"project_id":142}')
    } else if (req.url === '/api/v1/config/llm/') {
      res.end(JSON.stringify({ ...config, provider: 'azure_openai', azure_endpoint: origin }))
    } else if (req.url?.startsWith('/openai/deployments/test-model/chat/completions')) {
      let body = ''
      for await (const chunk of req) body += String(chunk)
      assert.match(JSON.parse(body).messages[1].content, /const cache/)
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ findings: [hit] }) } }] }))
    } else { res.statusCode = 404; res.end('{"detail":"unexpected request"}') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  writeFileSync(join(root, '.netgreener/project.yaml'), 'project_id: 142\n')
  writeFileSync(join(root, '.netgreener/config.yaml'), `api_url: ${origin}\nenvironment: dev\n`)
  const out: string[] = [], err: string[] = []
  try {
    const code = await runAnalyzeCli([root, '--llm', '--depth', 'quick'], { configDir: root, env: { NETGREENER_TOKEN: 'fake-service-token' }, stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) } })
    assert.equal(code, 0, err.join(''))
    const report = JSON.parse(out.join(''))
    assert.equal(report.project_id, '142')
    assert.equal(report.llm_review.filesReviewed, 1)
    assert.equal(report.findings.length, 1)
    assert.match(err.join(''), /Static checks 1\/1/)
    assert.match(err.join(''), /LLM review 1\/1/)
    assert.equal(paths.length, 3)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('keyless Ollama activates CLI review without managed login or org API calls', async () => {
  const { root } = fixture()
  const code = await runAnalyzeCli([root, '--quiet'], { configDir: root, env: {
    NETGREENER_LLM_PROVIDER: 'ollama', NETGREENER_LLM_ENDPOINT: 'http://localhost:11434', NETGREENER_LLM_MODEL: 'local-model', NETGREENER_ORG_SLUG: 'acme',
  }, fetchImpl: async input => { assert.equal(String(input), 'http://localhost:11434/v1/chat/completions'); return completion([]) } })
  assert.equal(code, 0)
})


test('Analyze defaults to the current folder like Python', async () => {
  const { root } = fixture()
  const previous = process.cwd()
  const output: string[] = []
  try {
    process.chdir(root)
    const code = await runAnalyzeCli(['--no-llm', '--quiet', '--json-summary'], { configDir: root, env: {}, stdout: { write: text => output.push(text) } })
    assert.equal(code, 0)
    assert.equal(JSON.parse(output.join('')).files_scanned, 1)
  } finally { process.chdir(previous) }
})

test('environment identity and API URL override repository configuration', async () => {
  const { root } = fixture()
  mkdirSync(join(root, '.netgreener'))
  writeFileSync(join(root, '.netgreener/project.json'), '{"project_id":142}')
  writeFileSync(join(root, '.netgreener/config.json'), '{"api_url":"https://wrong.example"}')
  const urls: string[] = [], output: string[] = []
  const code = await runAnalyzeCli([root, '--quiet', '--depth', 'quick'], { configDir: root,
    env: { NETGREENER_PROJECT_ID: '99', NETGREENER_API_URL: 'http://configured.example', NETGREENER_TOKEN: 'test' },
    stdout: { write: text => output.push(text) },
    fetchImpl: async input => {
      urls.push(String(input))
      if (String(input).endsWith('/projects/99')) return new Response('{"project_id":99}')
      if (String(input).endsWith('/config/llm/')) return new Response(JSON.stringify({ ...config, azure_endpoint: 'https://llm.example/v1' }))
      assert.equal(String(input), 'https://llm.example/v1/chat/completions')
      return completion([])
    },
  })
  assert.equal(code, 0)
  assert.equal(JSON.parse(output.join('')).project_id, '99')
  assert.equal(urls[0], 'http://configured.example/api/v1/projects/99')
})

test('incomplete BYOK fails before network instead of silently choosing managed LLM', async () => {
  const { root } = fixture()
  const errors: string[] = []
  const code = await runAnalyzeCli([root, '--quiet'], { configDir: root,
    env: { NETGREENER_TOKEN: 'test', NETGREENER_LLM_PROVIDER: 'anthropic', NETGREENER_LLM_MODEL: 'claude-test' },
    stderr: { write: text => errors.push(text) }, fetchImpl: async () => { throw new Error('network should not run') },
  })
  assert.equal(code, 2)
  assert.match(errors.join(''), /requires an API key/)
})


test('managed deployment aliases adapt unsupported token parameters without unbounded retries', async () => {
  const { root, paths } = fixture()
  const bodies: Record<string, unknown>[] = []
  const signals: (AbortSignal | null | undefined)[] = []
  const result = await runNodeLlmResourceReview({ projectDir: root, projectId: '142', paths, staticFindings: [],
    config: { ...config, provider: 'azure_openai', model: 'LLM_Large_NG', azure_endpoint: 'https://example.openai.azure.com' },
    fetchImpl: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body))); signals.push(init?.signal)
      if (bodies.length === 1) return new Response(JSON.stringify({ error: { code: 'unsupported_parameter', param: 'max_tokens', message: "Unsupported parameter: 'max_tokens'. Use max_completion_tokens instead." } }), { status: 400 })
      assert.equal(bodies[1]?.max_tokens, undefined)
      assert.equal(bodies[1]?.temperature, undefined)
      assert.equal(bodies[1]?.max_completion_tokens, 1800)
      return completion([hit])
    },
  })
  assert.equal(bodies.length, 2)
  assert.equal(signals[0], signals[1])
  assert.equal(result.filesReviewed, 1)
  assert.deepEqual(result.errors, [])
})

test('unknown HTTP 400 errors never trigger parameter retries', async () => {
  const { root, paths } = fixture()
  let calls = 0
  const result = await runNodeLlmResourceReview({ projectDir: root, projectId: '142', paths, staticFindings: [], config,
    fetchImpl: async () => { calls++; return new Response('{"error":{"code":"invalid_request","message":"private error"}}', { status: 400 }) },
  })
  assert.equal(calls, 1)
  assert.match(result.errors[0]!, /HTTP 400/)
})


test('terminal Analyze saves complete LLM findings and emits an editor completion event', async () => {
  const { root } = fixture()
  const stdout: string[] = []
  const code = await runAnalyzeCli([root, '--quiet', '--llm', '--findings-only', '--output-file', '.netgreener/node_analyze.json'], {
    env: { NETGREENER_LLM_KEY: 'fake', NETGREENER_LLM_MODEL: 'test-model' }, configDir: root,
    stdout: { write: text => stdout.push(text) }, fetchImpl: async () => completion([hit]),
  })
  assert.equal(code, 0)
  assert.equal(JSON.parse(stdout.join('')).length, 1)
  const report = JSON.parse(readFileSync(join(root, '.netgreener/node_analyze.json'), 'utf8'))
  const event = JSON.parse(readFileSync(join(root, '.netgreener/last_event.json'), 'utf8'))
  assert.equal(report.project_dir, root)
  assert.equal(report.findings.length, 1)
  assert.equal(report.findings[0].lineage.detector_id, 'js.llm.resource_review')
  assert.equal(report.llm_review.filesReviewed, 1)
  assert.equal(event.source, 'node_analyze_local')
  assert.equal(event.status, 'complete')
  assert.equal(event.report_path, '.netgreener/node_analyze.json')
})

test('project preflight failures notify the editor without publishing a stale report', async () => {
  const { root } = fixture()
  const code = await runAnalyzeCli([root, '--quiet', '--llm', '--output-file', '.netgreener/node_analyze.json'], {
    env: {}, configDir: root, stderr: { write: () => undefined }, stdout: { write: () => undefined },
  })
  assert.equal(code, 2)
  const event = JSON.parse(readFileSync(join(root, '.netgreener/last_event.json'), 'utf8'))
  assert.equal(event.status, 'failed')
  assert.equal(event.report_path, undefined)
  assert.match(event.error, /requires login/)
})
