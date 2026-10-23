import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ApiError, NetGreenerClient } from '../sdk/client.js'
import { normalizeGitUrl } from '../sdk/gitUrl.js'

const vectorsPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/git/canonical_git_key_vectors.v1.json',
)

test('normalizeGitUrl matches OP1 golden vectors', () => {
  const data = JSON.parse(readFileSync(vectorsPath, 'utf8')) as {
    vectors: Array<{ in: string; out: string | null; note?: string }>
  }
  for (const row of data.vectors) {
    assert.equal(normalizeGitUrl(row.in), row.out, row.note || row.in)
  }
})

test('normalizeGitUrl matches Python-style keys', () => {
  assert.equal(
    normalizeGitUrl('git@github.com:Org/Repo.git'),
    'github.com/org/repo',
  )
  assert.equal(
    normalizeGitUrl('https://github.com/Org/Repo.git'),
    'github.com/org/repo',
  )
  assert.equal(normalizeGitUrl(''), null)
})

test('NetGreenerClient login stores token and getMe hits /auth/me', async () => {
  const calls: Array<{ url: string; method: string }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method || 'GET'
    calls.push({ url, method })
    if (url.endsWith('/auth/login')) {
      return new Response(
        JSON.stringify({
          access_token: 'tok',
          user: { email: 'a@b.c', user_id: 7 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url.endsWith('/auth/me')) {
      return new Response(JSON.stringify({ email: 'a@b.c', user_id: 7 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('missing', { status: 404 })
  }) as typeof fetch

  const client = new NetGreenerClient({
    baseUrl: 'https://example.test/api/v1',
    fetchImpl,
  })
  await client.login('a@b.c', 'secret')
  assert.equal(client.getAccessToken(), 'tok')
  const me = await client.getMe()
  assert.equal(me.email, 'a@b.c')
  assert.equal(calls.length, 2)
})

test('getOrCreateProject matches by git_url then creates when missing', async () => {
  let projects: Array<Record<string, unknown>> = [
    {
      project_id: 1,
      name: 'Other',
      directory: '/x',
      git_url: 'https://github.com/Org/Repo.git',
    },
  ]
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method || 'GET').toUpperCase()
    if (method === 'GET' && /\/projects\/?(\?|$)/.test(url.replace(/https:\/\/example\.test\/api\/v1/, ''))) {
      return new Response(JSON.stringify(projects), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (method === 'PUT' && url.includes('/projects/1')) {
      const body = JSON.parse(String(init?.body || '{}'))
      projects = projects.map((p) =>
        p.project_id === 1 ? { ...p, ...body } : p,
      )
      return new Response(JSON.stringify(projects[0]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (method === 'POST' && url.endsWith('/projects/')) {
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      const row = { project_id: 9, ...body }
      projects = [...projects, row]
      return new Response(JSON.stringify(row), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ detail: url }), { status: 404 })
  }) as typeof fetch

  const client = new NetGreenerClient({
    baseUrl: 'https://example.test/api/v1',
    userId: 3,
    fetchImpl,
  })
  const matched = await client.getOrCreateProject('App', '/work/app', {
    gitUrl: 'git@github.com:Org/Repo.git',
  })
  assert.equal(matched.project_id, 1)

  const created = await client.getOrCreateProject('Fresh', '/work/fresh', {
    gitUrl: 'git@github.com:Org/Fresh.git',
    language: 'JavaScript',
  })
  assert.equal(created.project_id, 9)
  assert.equal(created.language, 'JavaScript')
})

test('getOrganizationBySlug and resolveOrgSlug hit OP2 path', async () => {
  const calls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/organizations/by-slug/acme')) {
      return new Response(JSON.stringify({ org_id: 9, slug: 'acme', name: 'Acme' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('missing', { status: 404 })
  }) as typeof fetch

  const client = new NetGreenerClient({
    token: 'tok',
    baseUrl: 'https://example.test/api/v1',
    fetchImpl,
  })
  const orgId = await client.resolveOrgSlug('Acme')
  assert.equal(orgId, 9)
  assert.equal(client.getOrgContext().orgId, 9)
  assert.ok(calls.some((u) => u.includes('/organizations/by-slug/acme')))
})

test('ApiError surfaces status and detail', async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ detail: 'nope' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
  const client = new NetGreenerClient({
    baseUrl: 'https://example.test/api/v1',
    token: 'x',
    fetchImpl,
  })
  await assert.rejects(() => client.getMe(), (err: unknown) => {
    assert.ok(err instanceof ApiError)
    assert.equal(err.statusCode, 403)
    assert.match(err.detail, /nope/)
    return true
  })
})

test('expanded SDK methods hit Python-parity paths', async () => {
  const calls: Array<{ method: string; path: string }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const path = url.replace('https://example.test/api/v1', '')
    const method = (init?.method || 'GET').toUpperCase()
    calls.push({ method, path })
    if (path.includes('/findings/project/')) {
      return new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (path === '/features/definitions') {
      return new Response(JSON.stringify([{ name: 'cpu' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (path === '/analyze/project') {
      return new Response(JSON.stringify({ findings: [{ id: 'f1' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  const client = new NetGreenerClient({
    baseUrl: 'https://example.test/api/v1',
    token: 't',
    fetchImpl,
  })

  await client.quoteCredits(3, { units: 1 })
  await client.estimateRun({ feature_values: {} })
  await client.estimateProject(9, {})
  await client.getRunEstimate(42)
  await client.getProjectFindings(9)
  await client.listFeatureDefinitions()
  await client.getProjectFeatureMetadata(9)
  const findings = await client.analyzeProjectFiles(9, [
    { rel_path: 'a.js', features: {} },
  ])
  assert.equal(findings.length, 1)
  await client.listPendingAnomalyBriefs()
  await client.getAnomalyBrief('brief-1')
  await client.claimAnomalyBrief('brief-1', { claimedByDevice: 'vsce' })
  await client.updateAnomalyBrief('brief-1', 'completed')

  const paths = calls.map((c) => `${c.method} ${c.path}`)
  assert.ok(paths.includes('POST /billing/organizations/3/credit-quote'))
  assert.ok(paths.includes('POST /runs/estimate'))
  assert.ok(paths.includes('POST /runs/projects/9/estimate'))
  assert.ok(paths.includes('GET /runs/42/estimate'))
  assert.ok(paths.includes('GET /findings/project/9'))
  assert.ok(paths.includes('GET /features/definitions'))
  assert.ok(paths.includes('GET /features/project/9/feature-metadata'))
  assert.ok(paths.includes('POST /analyze/project'))
  assert.ok(paths.includes('GET /developer/me/anomaly-briefs/pending'))
  assert.ok(paths.includes('GET /developer/me/anomaly-briefs/brief-1'))
  assert.ok(paths.includes('POST /developer/me/anomaly-briefs/brief-1/claim'))
  assert.ok(paths.includes('PATCH /developer/me/anomaly-briefs/brief-1'))
})
