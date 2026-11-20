/** Shared JS/TS bounded-upload transport. Detection and billing stay server-side. */
import { createHash, randomUUID } from 'node:crypto'

export type AnalysisUploadOptions = {
  /** Reuse with identical input to resume within the server retention window. */
  analysisId?: string
  onProgress?: (status: { analysis_id: string; received: number; total: number }) => void
}

type Request = (method: string, path: string, body?: unknown) => Promise<Record<string, unknown>>
const BATCH_LIMIT = 2 * 1024 * 1024
const LEGACY_LIMIT = 10 * 1024 * 1024
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

export async function analyzeFiles(
  request: Request, projectId: number, files: Array<{ path: string; features: unknown }>,
  options: AnalysisUploadOptions = {},
): Promise<unknown[]> {
  if (!files.length) return []
  const payload = { project_id: projectId, files }
  const legacy = async (): Promise<unknown[]> => {
    const data = await request('POST', '/analyze/project', payload)
    return Array.isArray(data.findings) ? data.findings : []
  }
  if (bytes(payload) <= BATCH_LIMIT && !options.analysisId) return legacy()
  const retry: Request = async (method, path, body) => {
    for (let attempt = 0; ; attempt++) {
      try { return await request(method, path, body) }
      catch (error) {
        const status = (error as { statusCode?: number }).statusCode
        if (attempt >= 2 || (!(error instanceof TypeError) &&
            ![408, 429, 500, 502, 503, 504].includes(status ?? 0))) throw error
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt))
      }
    }
  }
  let capabilities: Record<string, unknown>
  try { capabilities = await retry('GET', '/analyze/upload-capabilities') }
  catch (error) {
    if (![404, 405].includes((error as { statusCode: number }).statusCode)) throw error
    capabilities = {}
  }
  if (capabilities.protocol !== 'analysis_upload_v1' || !capabilities.enabled) {
    if (options.analysisId || bytes(payload) > LEGACY_LIMIT) {
      throw new Error('Server does not support batched analysis uploads. Enable analysis_upload_v1 on an updated server, or reduce the scan using --paths. No files were dropped.')
    }
    return legacy()
  }
  const limit = Math.min(BATCH_LIMIT, Number(capabilities.max_batch_bytes))
  const batches: Array<{ raw: string; count: number }> = []
  let current: string[] = []
  let size = 2
  for (const file of files) {
    const item = JSON.stringify(file)
    const itemSize = bytes(item) - 2
    if (itemSize + 32 > limit) throw new Error(`File ${file.path} exceeds the upload batch limit; no source was truncated`)
    if (current.length && size + itemSize + 1 + 32 > limit) {
      batches.push({ raw: `[${current.join(',')}]`, count: current.length })
      current = []; size = 2
    }
    current.push(item); size += itemSize + 1
  }
  if (current.length) batches.push({ raw: `[${current.join(',')}]`, count: current.length })
  const manifest = batches.map(({ raw, count }) => ({
    sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
    byte_count: Buffer.byteLength(raw, 'utf8'), file_count: count,
  }))
  if (batches.length > Number(capabilities.max_batches) || files.length > Number(capabilities.max_files) ||
      manifest.reduce((sum, batch) => sum + batch.byte_count, 0) > Number(capabilities.max_total_bytes)) {
    throw new Error('Analysis exceeds server upload quota; reduce the scan using --paths')
  }
  const analysisId = options.analysisId ?? randomUUID()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(analysisId)) {
    throw new Error('analysisId must be a UUID')
  }
  options.onProgress?.({ analysis_id: analysisId, received: 0, total: batches.length })
  const base = `/analyze/uploads/${analysisId}`
  try {
    const status = await retry('PUT', base, { project_id: projectId, batches: manifest })
    const received = new Set(status.received_batches as number[])
    for (const [index, batch] of batches.entries()) {
      if (!received.has(index)) {
        await retry('PUT', `${base}/batches/${index}`, { files_json: batch.raw })
        received.add(index)
      }
      options.onProgress?.({ analysis_id: analysisId, received: received.size, total: batches.length })
    }
    await retry('POST', `${base}/finalize`, {})
    const findings: unknown[] = []
    for (let index = 0; index < batches.length; index++) {
      const result = await retry('GET', `${base}/results/${index}`)
      if (!Array.isArray(result.findings)) throw new Error('Invalid analysis results; partial findings were not returned')
      for (const finding of result.findings) findings.push(finding)
    }
    return findings
  } catch (error) {
    if (error instanceof Error) error.message += `; Resume analysisId=${analysisId} with the same input within 24 hours`
    throw error
  }
}
