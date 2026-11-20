/** Python-compatible Analyze repository identity and API configuration. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

export function loadAnalyzeRepositoryConfig(projectDir: string): {
  projectId?: string
  orgSlug?: string
  apiUrl?: string
  environment?: string
} {
  const documents: Record<string, Record<string, unknown>> = {}
  for (const name of ['project', 'config']) {
    const path = ['yaml', 'yml', 'json'].map(ext => join(projectDir, '.netgreener', `${name}.${ext}`))
      .find(candidate => existsSync(candidate))
    if (!path) continue
    let data: unknown
    try {
      const raw = readFileSync(path, 'utf8')
      data = path.endsWith('.json') ? JSON.parse(raw) : parse(raw)
    } catch {
      throw new Error(`Cannot read Analyze repository configuration: ${path}`)
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`Analyze repository configuration must be an object: ${path}`)
    }
    documents[name] = data as Record<string, unknown>
  }
  const projectId = documents.project?.project_id
  if (projectId != null && (typeof projectId !== 'string' && typeof projectId !== 'number'
    || !/^\d+$/.test(String(projectId).trim()) || !Number.isSafeInteger(Number(projectId)) || Number(projectId) <= 0)) {
    throw new Error('Repository project_id must be a positive integer.')
  }
  let apiUrl = typeof documents.config?.api_url === 'string' ? documents.config.api_url.trim() : undefined
  if (!apiUrl) {
    for (const name of ['.env', '.env.local']) {
      const path = join(projectDir, name)
      if (!existsSync(path)) continue
      const match = readFileSync(path, 'utf8').match(/^\s*NETGREENER_API_URL\s*=\s*(.*?)\s*$/m)
      if (match) { apiUrl = match[1]!.replace(/^["']|["']$/g, '').trim(); break }
    }
  }
  return {
    projectId: projectId == null ? undefined : String(Number(projectId)),
    orgSlug: typeof documents.project?.org_slug === 'string' ? documents.project.org_slug.trim().toLowerCase() : undefined,
    apiUrl: apiUrl?.replace(/\/+$/, ''),
    environment: typeof documents.config?.environment === 'string' ? documents.config.environment.trim().toLowerCase() : undefined,
  }
}
