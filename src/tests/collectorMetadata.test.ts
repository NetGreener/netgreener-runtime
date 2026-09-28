import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  COLLECTOR_METADATA_NOTES,
  COMPATIBLE_COLLECTOR_METADATA,
  isCompatibleCollectorMetadata,
} from '../collectorMetadata.js'

test('COMPATIBLE_COLLECTOR_METADATA covers known Node emitters', () => {
  assert.ok(COMPATIBLE_COLLECTOR_METADATA.includes('express_middleware'))
  assert.ok(COMPATIBLE_COLLECTOR_METADATA.includes('fastify_middleware'))
  assert.ok(COMPATIBLE_COLLECTOR_METADATA.includes('node_process'))
  assert.ok(COMPATIBLE_COLLECTOR_METADATA.includes('bullmq_worker'))
  assert.ok(COMPATIBLE_COLLECTOR_METADATA.includes('outbound_http'))
  assert.ok(COMPATIBLE_COLLECTOR_METADATA.includes('nest_express_middleware'))
  assert.ok(COMPATIBLE_COLLECTOR_METADATA.includes('nest_fastify_middleware'))
  for (const id of COMPATIBLE_COLLECTOR_METADATA) {
    assert.equal(isCompatibleCollectorMetadata(id), true)
    assert.ok(COLLECTOR_METADATA_NOTES[id].length > 0)
  }
  assert.equal(isCompatibleCollectorMetadata('datadog_apm'), false)
  assert.equal(isCompatibleCollectorMetadata(''), false)
})
