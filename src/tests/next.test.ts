import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  _resetRuntimeForTests,
  getNextRuntime,
  nextRouteTemplate,
  withNetGreenerRoute,
} from '../index.js'
import { loadRuntimeConfig } from '../config.js'

describe('nextRouteTemplate', () => {
  it('prefers explicit routeTemplate', () => {
    assert.equal(
      nextRouteTemplate(
        { method: 'POST', url: 'https://x/api/a/secret-id' },
        '/api/intake/[id]',
      ),
      '/api/intake/[id]',
    )
  })

  it('strips query from url pathname; rejects bad override', () => {
    assert.equal(
      nextRouteTemplate({ url: 'https://x/api/x?token=1' }),
      '/api/x',
    )
    assert.equal(
      nextRouteTemplate({ url: 'https://x/' }, '/api/x?token=1'),
      '/',
    )
  })
})

describe('withNetGreenerRoute', () => {
  it('records http and dry-run flushes', async () => {
    _resetRuntimeForTests()
    const config = loadRuntimeConfig({
      NETGREENER_SERVICE_RUNTIME: '1',
      NETGREENER_TOKEN: 'ngs_test',
      NETGREENER_PROJECT_ID: '1',
      NETGREENER_RUNTIME_DRY_RUN: '1',
    })
    const handler = withNetGreenerRoute(
      async () => new Response(JSON.stringify({ ok: true }), { status: 201 }),
      { config, routeTemplate: '/api/pilot' },
    )
    const res = await handler({
      method: 'POST',
      url: 'https://app.local/api/pilot',
      headers: {},
    })
    assert.equal(res.status, 201)
    const result = await getNextRuntime().flush('manual')
    assert.equal(result?.ok, true)
    assert.equal(result?.dryRun, true)
    _resetRuntimeForTests()
  })
})
