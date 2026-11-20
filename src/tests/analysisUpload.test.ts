import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { analyzeFiles } from '../sdk/analysisUpload.js'
import { ApiError } from '../sdk/client.js'

const capabilities = {
  protocol: 'analysis_upload_v1', enabled: true, max_batch_bytes: 1024,
  max_batches: 4096, max_files: 100000, max_total_bytes: 268435456,
}

test('standalone JavaScript SDKs use identical shared upload source', (t) => {
  const canonical = readFileSync(new URL('../../src/sdk/analysisUpload.ts', import.meta.url), 'utf8')
  for (const copy of ['../../../netgreener_js_sdk/src/analysisUpload.ts',
    '../../../netgreener_sdk/javascript/src/analysisUpload.ts']) {
    if (!existsSync(new URL(copy, import.meta.url))) {
      t.skip('Workspace source parity requires the sibling SDK distributions')
      return
    }
    assert.equal(readFileSync(new URL(copy, import.meta.url), 'utf8'), canonical)
  }
})

test('bounded upload preserves UTF-8, escaping, order and manifest integrity', async () => {
  const files = Array.from({ length: 8 }, (_, index) => ({
    path: `src/日本語_${index}.ts`, features: { source: '"\\\n🙂'.repeat(20) },
  }))
  let manifest: Array<{ sha256: string; byte_count: number; file_count: number }> = []
  const uploaded: unknown[] = []
  let finalizes = 0
  let lost = false
  const request = async (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => {
    if (body) assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 1024)
    if (path.endsWith('upload-capabilities')) return capabilities
    if (path.includes('/batches/')) {
      const index = Number(path.split('/').at(-1))
      const raw = (body as { files_json: string }).files_json
      assert.equal(createHash('sha256').update(raw).digest('hex'), manifest[index].sha256)
      assert.equal(Buffer.byteLength(raw), manifest[index].byte_count)
      if (!lost) { lost = true; throw new TypeError('response lost') }
      uploaded.push(...JSON.parse(raw))
      return { received: true }
    }
    if (path.includes('/results/')) return { findings: [{ batch: Number(path.split('/').at(-1)) }] }
    if (path.endsWith('/finalize')) { finalizes++; return { state: 'complete' } }
    manifest = (body as { batches: typeof manifest }).batches
    return { received_batches: [] }
  }
  const findings = await analyzeFiles(request, 1, files, { analysisId: randomUUID() })
  assert.deepEqual(uploaded, files)
  assert.ok(manifest.length > 1)
  assert.equal(findings.length, manifest.length)
  assert.equal(finalizes, 1)
})

test('small uploads preserve single-request compatibility', async () => {
  const calls: string[] = []
  const findings = await analyzeFiles(async (_, path) => {
    calls.push(path); return { findings: [{ file_path: 'app.ts' }] }
  }, 1, [{ path: 'app.ts', features: {} }])
  assert.deepEqual(calls, ['/analyze/project'])
  assert.equal(findings.length, 1)
})

test('resume skips received batches and never reads results before successful finalize', async () => {
  const calls: string[] = []
  const id = randomUUID()
  const progress: string[] = []
  await assert.rejects(analyzeFiles(async (_, path) => {
    calls.push(path)
    if (path.endsWith('upload-capabilities')) return capabilities
    if (path.endsWith('finalize')) throw new ApiError(402, 'insufficient credits')
    return { received_batches: [0] }
  }, 1, [{ path: 'app.ts', features: {} }], {
    analysisId: id, onProgress: (status) => progress.push(status.analysis_id),
  }), (error: unknown) => error instanceof ApiError && error.statusCode === 402 && error.message.includes(id))
  assert.ok(progress.every((value) => value === id))
  assert.ok(!calls.some((path) => path.includes('/batches/') || path.includes('/results/')))
})

test('oversized file is rejected explicitly before an upload starts', async () => {
  const calls: string[] = []
  await assert.rejects(analyzeFiles(async (_, path) => {
    calls.push(path); return capabilities
  }, 1, [{ path: 'large.ts', features: { source: 'x'.repeat(2048) } }], { analysisId: randomUUID() }), /no source was truncated/)
  assert.deepEqual(calls, ['/analyze/upload-capabilities'])
})

test('old server rejects an oversized analysis with upgrade guidance', async () => {
  const calls: string[] = []
  await assert.rejects(analyzeFiles(async (_, path) => {
    calls.push(path); throw new ApiError(404, 'unsupported')
  }, 1, [{ path: 'huge.ts', features: { source: 'x'.repeat(11 * 1024 * 1024) } }]), /No files were dropped/)
  assert.deepEqual(calls, ['/analyze/upload-capabilities'])
})
