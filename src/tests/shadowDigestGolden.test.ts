/**
 * Shared MP2 shadow-digest golden (vendored from contracts planning).
 * Digest-only; no dual-POST or upload cutover claim.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { canonicalPayloadDigest } from '../exporter.js'

const goldenPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'mp2_shadow_digest_golden.v1.json',
)

test('MP2 shadow digest golden matches Node canonicalPayloadDigest', () => {
  const doc = JSON.parse(readFileSync(goldenPath, 'utf8')) as {
    cases: Array<{
      id: string
      kind: string
      payload: Record<string, unknown>
      payload_sha256: string
    }>
  }
  assert.ok(doc.cases.length >= 2)
  for (const caseItem of doc.cases) {
    assert.equal(
      canonicalPayloadDigest(caseItem.payload),
      caseItem.payload_sha256,
      caseItem.id,
    )
  }
})
