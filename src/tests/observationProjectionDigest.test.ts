/**
 * Admitted projection-digest golden (vendored from contracts observation/v1/vectors).
 * Does not claim dual-view engine exit or upload/emit wiring.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  projectionBytes,
  projectionDigest,
} from '../contract/observationProjection.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures')

test('projection digest golden matches Node helper (ADR 0008 D2)', () => {
  const meta = JSON.parse(
    readFileSync(join(fixtures, 'projection-batch.v1.json'), 'utf8'),
  ) as {
    schema_name: string
    expected_digest: string
    byte_length: number
  }
  const document = JSON.parse(
    readFileSync(join(fixtures, 'projection-batch-document.v1.json'), 'utf8'),
  ) as Record<string, unknown>

  assert.equal(meta.schema_name, 'netgreener.observation.projection_golden.v1')
  assert.equal(projectionDigest(document), meta.expected_digest)
  assert.equal(projectionBytes(document).length, meta.byte_length)
})
