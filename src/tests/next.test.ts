import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  _resetRuntimeForTests,
  getNextRuntime,
  nextRouteTemplate,
  withNetGreenerRoute,
} from '../index.js'
import { loadRuntimeConfig } from '../config.js'
import {
  _setInvokeFlushQuietMsForTests,
  _setNextAfterForTests,
} from '../next.js'

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

  it('ephemeral flush waits for after() and does not upload in finally', async () => {
    _resetRuntimeForTests()
    _setInvokeFlushQuietMsForTests(0)
    const tasks: Array<() => Promise<unknown> | unknown> = []
    _setNextAfterForTests((task) => {
      tasks.push(task)
    })
    let flushes = 0
    const config = loadRuntimeConfig({
      NETGREENER_SERVICE_RUNTIME: '1',
      NETGREENER_TOKEN: 'ngs_test',
      NETGREENER_PROJECT_ID: '1',
      NETGREENER_RUNTIME_DRY_RUN: '1',
    })
    const handler = withNetGreenerRoute(
      async () => new Response('ok', { status: 200 }),
      {
        config,
        runtimeMode: 'ephemeral',
        routeTemplate: '/api/pilot',
        onFlush: () => {
          flushes += 1
        },
      },
    )
    await handler({ method: 'POST', url: 'https://app.local/api/pilot', headers: {} })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(flushes, 0)
    assert.equal(tasks.length, 1)
    await tasks[0]()
    assert.equal(flushes, 1)
    _setNextAfterForTests(undefined)
    _setInvokeFlushQuietMsForTests(25)
    _resetRuntimeForTests()
  })

  it('uses request waitUntil when after() is unavailable', async () => {
    _resetRuntimeForTests()
    _setInvokeFlushQuietMsForTests(0)
    _setNextAfterForTests(null)
    let flushes = 0
    let waited: Promise<unknown> | null = null
    const config = loadRuntimeConfig({
      NETGREENER_SERVICE_RUNTIME: '1',
      NETGREENER_TOKEN: 'ngs_test',
      NETGREENER_PROJECT_ID: '1',
      NETGREENER_RUNTIME_DRY_RUN: '1',
    })
    const handler = withNetGreenerRoute(
      async () => new Response(null, { status: 204 }),
      {
        config,
        runtimeMode: 'ephemeral',
        routeTemplate: '/api/pilot',
        onFlush: () => {
          flushes += 1
        },
      },
    )
    await handler({
      method: 'GET',
      url: 'https://app.local/api/pilot',
      headers: {},
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise
      },
    })
    assert.ok(waited)
    await waited
    assert.equal(flushes, 1)
    _setNextAfterForTests(undefined)
    _setInvokeFlushQuietMsForTests(25)
    _resetRuntimeForTests()
  })
})
