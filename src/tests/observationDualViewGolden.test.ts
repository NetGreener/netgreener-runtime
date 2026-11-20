/**
 * Dual-view projection golden parity (vendored from contracts).
 * Additive validators only; no upload or TCK default flip.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { projectSemanticEnvelopeToProtobufView } from '../contract/observation-v1.mjs'
import { projectValue } from '../contract/observationProjection.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures')

function projectionDigest(document: Record<string, unknown>): string {
  const projected = projectValue(document)
  const raw = Buffer.from(JSON.stringify(projected), 'utf8')
  return 'sha256:' + createHash('sha256').update(raw).digest('hex')
}

test('dual-view golden: Node projection digest matches admitted golden', () => {
  const golden = JSON.parse(
    readFileSync(join(fixtures, 'dual-view-projection.v1.json'), 'utf8'),
  ) as {
    semantic_envelope: Record<string, unknown>
    expected_projection_digest: string
    expected_byte_length: number
  }
  const result = projectSemanticEnvelopeToProtobufView(golden.semantic_envelope)
  assert.equal(result.accepted, true, String(result.errorCodes))
  assert.ok(result.document)
  const digest = projectionDigest(result.document as Record<string, unknown>)
  assert.equal(digest, golden.expected_projection_digest)
  const bytes = Buffer.from(JSON.stringify(projectValue(result.document)), 'utf8')
  assert.equal(bytes.length, golden.expected_byte_length)
})
