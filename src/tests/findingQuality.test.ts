import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { test } from 'node:test'
import { detectAllHitsAst } from '../analyze/astDetectors.js'
import { collectPreferAstHits } from '../analyze/preferAstDetectors.js'
import { toResourceFindingCandidate } from '../analyze/resourceFindingCandidate.js'

const fixture = JSON.parse(readFileSync(new URL('../../fixtures/finding_quality_v1.json', import.meta.url), 'utf8')) as {
  cases: Array<{ id: string; javascript: string; model_load: boolean; inference: boolean; file_reads?: boolean }>
}
const sharedFixture = new URL('../../../fixtures/finding_quality_v1.json', import.meta.url)
if (existsSync(sharedFixture)) assert.deepEqual(fixture, JSON.parse(readFileSync(sharedFixture, 'utf8')))

for (const language of ['javascript', 'typescript'] as const) {
  for (const scenario of fixture.cases) {
    test(`${language}: ${scenario.id}`, () => {
      const hits = detectAllHitsAst(scenario.javascript, language === 'typescript' ? 'main.ts' : 'main.js')
      assert.ok(hits)
      assert.equal(hits.modelLoad.length > 0, scenario.model_load)
      assert.equal(hits.inference.length > 0, scenario.inference)
      if (scenario.file_reads !== undefined) assert.equal(hits.fileReads.length > 0, scenario.file_reads)
      for (const hit of [...hits.modelLoad, ...hits.inference]) {
        const candidate = toResourceFindingCandidate(hit)
        assert.equal(candidate?.evidence_state, 'candidate')
        assert.equal(candidate?.verification_outcome, 'not_run')
      }
    })
  }
}

test('function scope is restored and immediate execution still belongs to the loop', () => {
  const source = `for (const item of items) {
    const later = () => loadModel('deferred');
    (() => loadModel('immediate'))();
    loadModel('repeated');
  }`
  const hits = detectAllHitsAst(source, 'main.ts')
  assert.deepEqual(hits?.modelLoad.map(hit => hit.start_line), [3, 4])
})

test('invalid syntax fails the scan instead of falling back to regex matches', () => {
  assert.throws(() => collectPreferAstHits('for (const item of', 'main.ts'), /scan is incomplete/)
})

test('explicit batched prediction is not a missing-batching opportunity', () => {
  const hits = detectAllHitsAst('for (const batch of batches) { model.predictOnBatch(batch); }', 'main.ts')
  assert.equal(hits?.inference.length, 0)
})
