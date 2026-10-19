/**
 * Thin Node HTTP client twin of Python ``netgreener_sdk.NetGreenerClient``.
 *
 * Same api_server brain — no Node server fork. Does not flip EXPORT_MODE.
 */

import { normalizeGitUrl } from './gitUrl.js'

export class ApiError extends Error {
  readonly statusCode: number
  readonly detail: string

  constructor(statusCode: number, detail: string) {
    super(`HTTP ${statusCode}: ${detail}`)
    this.name = 'ApiError'
    this.statusCode = statusCode
    this.detail = detail
  }
}

export type NetGreenerSdkOptions = {
  token?: string
  /** API root including ``/api/v1`` */
  baseUrl?: string
  orgId?: number
  environment?: string
  userId?: number
  fetchImpl?: typeof fetch
}

const DEFAULT_BASE = 'https://dashboard.netgreener.com/api/v1'

type ProjectRow = Record<string, unknown> & {
  project_id?: number
  name?: string
  directory?: string
  git_url?: string | null
}

export class NetGreenerClient {
  baseUrl: string
  private token: string | undefined
  private orgId: number | undefined
  private environment: string | undefined
  private userId: number | undefined
  private readonly fetchImpl: typeof fetch

  constructor(opts: NetGreenerSdkOptions = {}) {
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE).replace(/\/$/, '')
    this.token = opts.token
    this.orgId = opts.orgId
    this.environment = opts.environment
    this.userId = opts.userId
    this.fetchImpl = opts.fetchImpl || globalThis.fetch.bind(globalThis)
  }

  setToken(token: string | undefined): void {
    this.token = token
  }

  getAccessToken(): string | undefined {
    return this.token
  }

  setOrgContext(orgId: number | undefined, environment?: string): void {
    this.orgId = orgId
    if (environment !== undefined) this.environment = environment
  }

  getOrgContext(): { orgId: number | undefined; environment: string | undefined } {
    return { orgId: this.orgId, environment: this.environment }
  }

  /** GET /organizations/by-slug/{slug} (OP2). */
  async getOrganizationBySlug(slug: string): Promise<Record<string, unknown>> {
    const cleaned = String(slug || '')
      .trim()
      .toLowerCase()
    if (cleaned.length < 2) throw new ApiError(400, 'Invalid organization slug')
    return this.request<Record<string, unknown>>(
      'GET',
      `/organizations/by-slug/${encodeURIComponent(cleaned)}`,
    )
  }

  /** Resolve slug → orgId and set client org context. */
  async resolveOrgSlug(slug: string): Promise<number> {
    const org = await this.getOrganizationBySlug(slug)
    const orgId = Number(org.org_id)
    if (!Number.isFinite(orgId) || orgId <= 0) {
      throw new ApiError(500, 'Organization response missing org_id')
    }
    this.setOrgContext(orgId, this.environment)
    return orgId
  }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {}
    if (json) h['Content-Type'] = 'application/json'
    if (this.token) h.Authorization = `Bearer ${this.token}`
    if (this.orgId != null) h['X-Organization-ID'] = String(this.orgId)
    if (this.environment) h['X-Environment'] = this.environment
    return h
  }

  private async raise(resp: Response): Promise<void> {
    if (resp.ok) return
    let detail = await resp.text()
    try {
      const body = JSON.parse(detail) as { detail?: unknown }
      if (body.detail != null) detail = String(body.detail)
    } catch {
      /* keep text */
    }
    throw new ApiError(resp.status, detail)
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
    const resp = await this.fetchImpl(url, {
      method,
      headers: this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    await this.raise(resp)
    if (resp.status === 204) return undefined as T
    return (await resp.json()) as T
  }

  async login(email: string, password: string): Promise<Record<string, unknown>> {
    const data = await this.request<Record<string, unknown>>('POST', '/auth/login', {
      email,
      password,
    })
    const token = data.access_token
    if (typeof token === 'string') this.token = token
    const user = data.user
    if (user && typeof user === 'object' && 'user_id' in user) {
      const uid = (user as { user_id?: unknown }).user_id
      if (uid != null) this.userId = Number(uid)
    }
    return data
  }

  async getMe(): Promise<Record<string, unknown>> {
    return this.request('GET', '/auth/me')
  }

  async postRunSession(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('POST', '/runsessions/', payload)
  }

  async getRunSession(runId: number): Promise<Record<string, unknown>> {
    return this.request('GET', `/runsessions/${runId}`)
  }

  async getRunOutcome(runId: number): Promise<Record<string, unknown>> {
    return this.request('GET', `/runsessions/${runId}/outcome`)
  }

  async attachRunOutcome(
    runId: number,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request('PUT', `/runsessions/${runId}/outcome`, payload)
  }

  async getRunSessions(opts?: {
    projectId?: number
    ciOnly?: boolean
    branch?: string
  }): Promise<unknown[]> {
    const params = new URLSearchParams()
    if (opts?.projectId != null) params.set('project_id', String(opts.projectId))
    if (opts?.ciOnly) params.set('ci_only', 'true')
    if (opts?.branch) params.set('branch', opts.branch)
    const q = params.toString()
    const data = await this.request<unknown>(
      'GET',
      q ? `/runsessions?${q}` : '/runsessions',
    )
    return Array.isArray(data) ? data : []
  }

  async createServiceToken(
    orgId: number,
    scopes: string[],
    opts?: { environment?: string; expiresInHours?: number },
  ): Promise<Record<string, unknown>> {
    return this.request('POST', '/auth/service-token', {
      org_id: orgId,
      environment: opts?.environment ?? 'dev',
      scopes,
      expires_in_hours: opts?.expiresInHours ?? 24 * 30,
    })
  }

  async listServiceTokens(orgId: number): Promise<Record<string, unknown>> {
    return this.request('GET', `/auth/service-tokens?org_id=${orgId}`)
  }

  async revokeServiceToken(
    orgId: number,
    tokenId: number,
  ): Promise<Record<string, unknown>> {
    return this.request(
      'POST',
      `/auth/service-token/${tokenId}/revoke?org_id=${orgId}`,
    )
  }

  async getProjects(opts?: { isActive?: boolean }): Promise<ProjectRow[]> {
    const q =
      opts?.isActive === undefined ? '' : `?is_active=${opts.isActive ? 'true' : 'false'}`
    const data = await this.request<unknown>('GET', `/projects${q}`)
    return Array.isArray(data) ? (data as ProjectRow[]) : []
  }

  async createProject(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('POST', '/projects/', payload)
  }

  async updateProject(
    projectId: number,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request('PUT', `/projects/${projectId}`, payload)
  }

  async getProject(projectId: number): Promise<Record<string, unknown>> {
    return this.request('GET', `/projects/${projectId}`)
  }

  private async ensureUserId(): Promise<number> {
    if (this.userId != null) return this.userId
    const me = await this.getMe()
    const uid = me.user_id
    if (uid == null) throw new ApiError(401, 'Could not resolve user_id from /auth/me')
    this.userId = Number(uid)
    return this.userId
  }

  private async maybeSyncProject(
    project: ProjectRow,
    directory: string,
    gitUrl: string | null,
  ): Promise<Record<string, unknown>> {
    const projectId = project.project_id
    if (!projectId) return project

    const normDir = directory.replace(/\\/g, '/').replace(/\/+$/, '')
    const currentDir = String(project.directory || '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
    const normGit = normalizeGitUrl(gitUrl)
    const currentGit = normalizeGitUrl(project.git_url)

    const patch: Record<string, unknown> = {}
    if (normDir && currentDir !== normDir) patch.directory = normDir
    if (normGit && !currentGit) patch.git_url = normGit
    if (!Object.keys(patch).length) return project
    try {
      return await this.updateProject(Number(projectId), patch)
    } catch {
      return project
    }
  }

  /**
   * Match by git_url → directory → name; create when none match.
   * Same order as Python SDK / CLI.
   */
  async getOrCreateProject(
    name: string,
    directory: string,
    opts?: { gitUrl?: string | null; userId?: number; language?: string },
  ): Promise<Record<string, unknown>> {
    const projects = await this.getProjects()
    const normDir = directory.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const normGit = normalizeGitUrl(opts?.gitUrl)

    if (normGit) {
      for (const project of projects) {
        if (normalizeGitUrl(project.git_url) === normGit) {
          return this.maybeSyncProject(project, directory, normGit)
        }
      }
    }

    for (const project of projects) {
      const projectDir = String(project.directory || '')
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase()
      if (projectDir && projectDir === normDir) {
        return this.maybeSyncProject(project, directory, normGit)
      }
    }

    for (const project of projects) {
      if (project.name === name) {
        return this.maybeSyncProject(project, directory, normGit)
      }
    }

    const userId = opts?.userId ?? (await this.ensureUserId())
    const payload: Record<string, unknown> = {
      name,
      directory: directory.replace(/\\/g, '/').replace(/\/+$/, ''),
      language: opts?.language ?? 'JavaScript',
      user_id: userId,
    }
    if (normGit) payload.git_url = normGit
    return this.createProject(payload)
  }

  async getReportSettings(orgId: number): Promise<Record<string, unknown>> {
    return this.request('GET', `/organizations/${orgId}/reports/settings`)
  }

  async updateReportSettings(
    orgId: number,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request('PUT', `/organizations/${orgId}/reports/settings`, payload)
  }

  async previewReport(
    orgId: number,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request('POST', `/organizations/${orgId}/reports/preview`, payload)
  }

  async generateReport(
    orgId: number,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request('POST', `/organizations/${orgId}/reports/generate`, payload)
  }

  async getReportHistory(
    orgId: number,
    opts?: { limit?: number },
  ): Promise<unknown[]> {
    const limit = opts?.limit ?? 50
    const data = await this.request<unknown>(
      'GET',
      `/organizations/${orgId}/reports/history?limit=${limit}`,
    )
    return Array.isArray(data) ? data : []
  }

  async getEnergyBaseline(
    projectId: number,
    opts?: { branch?: string },
  ): Promise<Record<string, unknown>> {
    const q = opts?.branch
      ? `?project_id=${projectId}&branch=${encodeURIComponent(opts.branch)}`
      : `?project_id=${projectId}`
    return this.request('GET', `/energy/baseline${q}`)
  }

  async rotateServiceToken(
    orgId: number,
    tokenId: number,
    opts?: { expiresInHours?: number },
  ): Promise<Record<string, unknown>> {
    return this.request(
      'POST',
      `/auth/service-token/${tokenId}/rotate?org_id=${orgId}`,
      { expires_in_hours: opts?.expiresInHours ?? 24 * 30 },
    )
  }

  async quoteReportAiSummary(
    orgId: number,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request(
      'POST',
      `/organizations/${orgId}/reports/ai-summary/quote`,
      payload,
    )
  }

  async downloadReport(
    orgId: number,
    reportId: number,
    opts?: { format?: string },
  ): Promise<Record<string, unknown>> {
    const fmt = opts?.format ? `?format=${encodeURIComponent(opts.format)}` : ''
    return this.request(
      'GET',
      `/organizations/${orgId}/reports/${reportId}/download${fmt}`,
    )
  }

  async quoteCredits(
    orgId: number,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request(
      'POST',
      `/billing/organizations/${orgId}/credit-quote`,
      payload,
    )
  }

  async estimateRun(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('POST', '/runs/estimate', payload)
  }

  async estimateProject(
    projectId: number,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request('POST', `/runs/projects/${projectId}/estimate`, payload)
  }

  async getRunEstimate(runId: number): Promise<Record<string, unknown>> {
    return this.request('GET', `/runs/${runId}/estimate`)
  }

  async analyzeProjectFiles(
    projectId: number,
    perFile: Array<{ rel_path: string; features: unknown }>,
  ): Promise<unknown[]> {
    const files = perFile
      .filter((e) => e && typeof e.rel_path === 'string')
      .map((e) => ({ path: e.rel_path, features: e.features }))
    if (!files.length) return []
    const data = await this.request<Record<string, unknown>>('POST', '/analyze/project', {
      project_id: projectId,
      files,
    })
    return Array.isArray(data.findings) ? data.findings : []
  }

  async getProjectFindings(projectId: number): Promise<unknown[]> {
    const data = await this.request<unknown>(
      'GET',
      `/findings/project/${projectId}`,
    )
    return Array.isArray(data) ? data : []
  }

  /**
   * POST /findings/batch — optional ``declared_external_apis`` seeds the org
   * external-API catalog (Python analyze twin). Findings may be empty.
   */
  async postFindingsBatch(
    findings: Record<string, unknown>[],
    options?: {
      projectId?: number
      replaceExisting?: boolean
      scopeFilePaths?: string[]
      declaredExternalApis?: Array<{
        provider_key: string
        detection_method?: string
        module_roots?: string[]
        file_paths?: string[]
      }>
      detectionContext?: Record<string, unknown>
    },
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { findings }
    if (options?.projectId != null) payload.project_id = options.projectId
    if (options?.replaceExisting) payload.replace_existing = true
    if (options?.scopeFilePaths != null) payload.scope_file_paths = options.scopeFilePaths
    if (options?.declaredExternalApis?.length) {
      payload.declared_external_apis = options.declaredExternalApis
    }
    if (options?.detectionContext && Object.keys(options.detectionContext).length) {
      payload.detection_context = options.detectionContext
    }
    return this.request('POST', '/findings/batch', payload)
  }

  async submitFindingFeedback(
    findingId: number,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request('POST', `/findings/${findingId}/feedback`, payload)
  }

  async getProjectDataSources(projectId: number): Promise<unknown[]> {
    const data = await this.request<unknown>(
      'GET',
      `/projects/${projectId}/data-sources`,
    )
    return Array.isArray(data) ? data : []
  }

  async createProjectDataSource(
    projectId: number,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request('POST', `/projects/${projectId}/data-sources`, payload)
  }

  async linkProjectDataSource(
    projectId: number,
    sourceId: number,
    opts?: { isDefault?: boolean },
  ): Promise<Record<string, unknown>> {
    return this.request(
      'POST',
      `/projects/${projectId}/data-sources/${sourceId}/link`,
      { is_default: opts?.isDefault ?? false },
    )
  }

  async updateDataSource(
    sourceId: number,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request('PUT', `/data-sources/${sourceId}`, payload)
  }

  async deleteDataSource(sourceId: number): Promise<Record<string, unknown>> {
    return this.request('DELETE', `/data-sources/${sourceId}`)
  }

  async getRunDataSources(runId: number): Promise<unknown[]> {
    const data = await this.request<unknown>(
      'GET',
      `/runsessions/${runId}/data-sources`,
    )
    return Array.isArray(data) ? data : []
  }

  async getProjectFeatureMetadata(
    projectId: number,
  ): Promise<Record<string, unknown>> {
    return this.request(
      'GET',
      `/features/project/${projectId}/feature-metadata`,
    )
  }

  async postProjectFeatureMetadata(
    projectId: number,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request(
      'POST',
      `/features/project/${projectId}/feature-metadata`,
      payload,
    )
  }

  async listFeatureDefinitions(): Promise<unknown[]> {
    const data = await this.request<unknown>('GET', '/features/definitions')
    return Array.isArray(data) ? data : []
  }

  /** POST ``/optimize/function`` — shared LLM optimize brain (Python/VSCE twin). */
  async optimizeFunction(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request('POST', '/optimize/function', payload)
  }

  /** POST ``/optimize/plan`` — ranked optimization plan. */
  async createOptimizationPlan(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request('POST', '/optimize/plan', payload)
  }

  async getOptimizationPlan(planId: number): Promise<Record<string, unknown>> {
    return this.request('GET', `/optimize/plan/${planId}`)
  }

  async listOptimizationPlans(
    projectId: number,
    opts?: { limit?: number },
  ): Promise<unknown[]> {
    const limit = opts?.limit ?? 20
    const data = await this.request<unknown>(
      'GET',
      `/optimize/plan/project/${projectId}?limit=${limit}`,
    )
    return Array.isArray(data) ? data : []
  }

  /** GET ``/developer/me/anomaly-briefs/pending`` — same brain as VSCE poll. */
  async listPendingAnomalyBriefs(): Promise<unknown[]> {
    const data = await this.request<unknown>(
      'GET',
      '/developer/me/anomaly-briefs/pending',
    )
    return Array.isArray(data) ? data : []
  }

  async getAnomalyBrief(briefId: string): Promise<Record<string, unknown>> {
    return this.request(
      'GET',
      `/developer/me/anomaly-briefs/${encodeURIComponent(briefId)}`,
    )
  }

  async claimAnomalyBrief(
    briefId: string,
    opts?: { claimedByDevice?: string },
  ): Promise<Record<string, unknown>> {
    const body =
      opts?.claimedByDevice != null
        ? { claimed_by_device: opts.claimedByDevice }
        : {}
    return this.request(
      'POST',
      `/developer/me/anomaly-briefs/${encodeURIComponent(briefId)}/claim`,
      body,
    )
  }

  async updateAnomalyBrief(
    briefId: string,
    status: 'completed' | 'cancelled',
  ): Promise<Record<string, unknown>> {
    return this.request(
      'PATCH',
      `/developer/me/anomaly-briefs/${encodeURIComponent(briefId)}`,
      { status },
    )
  }
}
