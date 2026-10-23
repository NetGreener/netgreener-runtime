import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  routeTemplateFromAppFile,
  transformNextEntrySource,
} from '../nextEntryTransform.js'

describe('routeTemplateFromAppFile', () => {
  it('drops route groups and the route filename', () => {
    assert.equal(
      routeTemplateFromAppFile(
        'C:/app/repo/app/[locale]/(dashboard)/overview/page.tsx',
      ),
      '/[locale]/overview',
    )
    assert.equal(
      routeTemplateFromAppFile('C:/repo/app/api/cron/email-backfill/route.ts'),
      '/api/cron/email-backfill',
    )
  })
})

describe('transformNextEntrySource', () => {
  it('wraps an exported route function and marks crons', () => {
    const source = `export async function GET() {\n  return Response.json({ ok: true })\n}\n`
    const out = transformNextEntrySource(
      source,
      'C:/repo/app/api/cron/email-backfill/route.ts',
    )
    assert.match(out, /function __ng_GET/)
    assert.match(out, /observeNextRoute as __ngObserveRoute/)
    assert.match(out, /cron: true/)
    assert.match(out, /'\/api\/cron\/email-backfill'/)
  })

  it('wraps export const POST = createAgentToolRoute(...)', () => {
    const source = `export const POST = createAgentToolRoute({\n  name: 'search',\n})\n`
    const out = transformNextEntrySource(source, 'C:/repo/app/api/internal/agent-tools/search/route.ts')
    assert.match(out, /const __ng_POST = createAgentToolRoute/)
    assert.match(out, /export const POST = __ngObserveRoute\(__ng_POST/)
  })

  it('leaves use client modules unchanged', () => {
    const source = `'use client'\nexport default function Page() { return null }\n`
    const out = transformNextEntrySource(source, 'C:/repo/app/en/overview/page.tsx')
    assert.equal(out, source)
  })

  it('keeps the use server directive first', () => {
    const source = `'use server'\nexport async function saveTitle(id: string) {\n  return id\n}\n`
    const out = transformNextEntrySource(source, 'C:/repo/lib/chat/actions.ts')
    assert.match(out, /^'use server'\nimport /)
    assert.match(out, /function __ng_action_saveTitle/)
    assert.match(out, /__ngObserveAction\(__ng_action_saveTitle, 'saveTitle'/)
  })
})
