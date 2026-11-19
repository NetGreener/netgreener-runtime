/**
 * Admitted identity-preimage golden (vendored from contracts observation/v1/vectors).
 * Does not claim production ID minting or L2 SEM engine exit.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  DOMAINS,
  identityId,
  prefixForDomain,
} from '../contract/observationIdentity.js'

const goldenPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'identity-preimages.v1.json',
)

test('identity-preimage goldens match Node helper (ADR 0008 D3)', () => {
  const doc = JSON.parse(readFileSync(goldenPath, 'utf8')) as {
    schema_name: string
    cases: Array<{
      name: string
      domain: string
      components: string[]
      expected_id: string
    }>
  }
  assert.equal(doc.schema_name, 'netgreener.observation.identity_preimages.v1')
  assert.equal(doc.cases.length, 4)
  const domainValues = new Set(Object.values(DOMAINS))
  for (const caseItem of doc.cases) {
    assert.ok(domainValues.has(caseItem.domain as (typeof DOMAINS)[keyof typeof DOMAINS]))
    const prefix = prefixForDomain(caseItem.domain)
    assert.equal(
      identityId(prefix, caseItem.domain, caseItem.components),
      caseItem.expected_id,
      caseItem.name,
    )
  }
})
