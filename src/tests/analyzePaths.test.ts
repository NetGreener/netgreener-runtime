import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  admitAnalyzeCandidate,
  buildServiceManifestFromPaths,
  isNonResourceCategory,
  listCandidateSourceFiles,
} from '../analyze/index.js'

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/analyze-sample',
)

test('listCandidateSourceFiles finds JS/TS under fixtures and skips nothing useful', () => {
  const files = listCandidateSourceFiles(fixtureRoot)
  assert.ok(files.includes('server.ts'))
  assert.ok(files.includes('worker.ts'))
})

test('buildServiceManifestFromPaths auto-walks fixture project', () => {
  const manifest = buildServiceManifestFromPaths(fixtureRoot)
  assert.equal(manifest.schema, 'service_manifest_v0')
  assert.ok(manifest.endpoints.some((e) => e.service_unit === 'GET /health'))
  assert.ok(manifest.endpoints.some((e) => e.service_unit === 'POST /v1/items/:id'))
  assert.ok(manifest.tasks.some((t) => t.service_unit === 'task:nightly_report'))
  assert.ok(manifest.notes.some((n) => /auto_walk/.test(n)))
})

test('buildServiceManifestFromPaths respects explicit path list', () => {
  const manifest = buildServiceManifestFromPaths(fixtureRoot, ['server.ts'])
  assert.ok(manifest.endpoints.length >= 1)
  assert.equal(manifest.tasks.length, 0)
  assert.ok(manifest.notes.some((n) => /paths=explicit/.test(n)))
})

test('default-deny rejects non-resource categories', () => {
  assert.equal(isNonResourceCategory('security'), true)
  assert.equal(isNonResourceCategory('style'), true)
  assert.deepEqual(admitAnalyzeCandidate({ domain: 'cpu', category: 'security' }), {
    admitted: false,
    reason: 'non_resource_category',
    category: 'security',
    detail: 'legacy/non-resource finding classes are rejected by default-deny',
  })
  assert.equal(admitAnalyzeCandidate({ domain: 'cpu' }).admitted, true)
  assert.equal(admitAnalyzeCandidate({ domain: 'unknown' }).admitted, false)
  assert.equal(admitAnalyzeCandidate({}).admitted, false)
})
