/** Shared Node Analyze LLM review, extracted from the editor reviewer. */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { toResourceFindingCandidate, type ResourceFindingCandidateV1, type ResourcePrimaryDomain } from './resourceFindingCandidate.js'
import { filterValidResourceFindings } from './validateResourceFinding.js'

const MAX_SOURCE_CHARS = 12_000;

const ALLOWED_MECHANISMS = new Set([
  "per_item_instead_of_batch",
  "retry_amplification",
  "external_api_overconsumption",
  "unbounded_parallelism",
  "polling_or_idle_work",
  "repeated_work",
  "process_or_runtime_churn",
  "memory_retention_or_materialization",
]);

const DEPTH_MAX: Record<"quick" | "standard" | "thorough", number> = {
  quick: 1,
  standard: 5,
  thorough: 10,
};

export type NodeLlmDepth = keyof typeof DEPTH_MAX;

export type LlmConfig = {
  api_key: string;
  provider?: string;
  azure_endpoint?: string;
  model?: string;
  api_version?: string;
};

/** One provider validation path shared by npm and the editor adapter. */
export function resolveNodeLlmConfig(config: LlmConfig): LlmConfig {
  const endpoint = (config.azure_endpoint || '').trim().replace(/\/+$/, '')
  const provider = (config.provider || (/openai\.azure\.com|cognitiveservices\.azure\.com/i.test(endpoint) ? 'azure_openai' : 'openai')).trim().toLowerCase()
  if (!['openai', 'azure_openai', 'anthropic', 'ollama', 'custom'].includes(provider)) {
    throw new Error(`Unsupported Node LLM provider: ${provider}`)
  }
  if (!config.model?.trim()) throw new Error('LLM model is required.')
  if (['openai', 'azure_openai', 'anthropic'].includes(provider) && !config.api_key?.trim()) {
    throw new Error(`LLM provider ${provider} requires an API key.`)
  }
  if (['azure_openai', 'ollama', 'custom'].includes(provider) && !endpoint) {
    throw new Error(`LLM provider ${provider} requires an endpoint.`)
  }
  return { ...config, provider, api_key: (config.api_key || '').trim(), model: config.model.trim(), azure_endpoint: endpoint }
}

type LlmHit = {
  mechanism_id: string;
  title: string;
  primary_domain: string;
  path: string;
  start_line: number | null;
  evidence?: string;
  recommended_fix?: string;
  confidence?: number;
};

function systemPrompt(): string {
  const mechs = [...ALLOWED_MECHANISMS].join(", ");
  return `You are NetGreener Node Analyze (resource scope only).
Find resource-consumption risks in JavaScript/TypeScript that waste CPU, memory, network, or paid external API cost.

Respond with ONE JSON object (no markdown):
{
  "findings": [
    {
      "mechanism_id": one of [${mechs}],
      "primary_domain": "compute.cpu"|"memory.host"|"network.io"|"external_api"|"storage.io",
      "title": "short resource title",
      "start_line": integer or null,
      "evidence": "short quote",
      "recommended_fix": "actionable fix",
      "confidence": 0.0-1.0
    }
  ]
}

Rules:
- Only emit resource mechanisms from the list. Never security, secrets, style, or architecture.
- Do not invent files or lines not present in the payload.
- Treat static code as a potential opportunity, never proof of wasted resources or measured savings.
- Check caching, batching, lifecycle/isolation requirements and surrounding mitigations before suggesting a change.
- Do not infer GPU use, per-sample inputs, or repeated initialization cost from a method name alone.
- Do not invent numerical speedups or cost reductions; omit a finding if its mechanism cannot be grounded in the quoted code.
- Prefer new issues not already listed in static_candidates.
- If nothing resource-relevant, return {"findings":[]}.`;
}

function userPayload(
  filePath: string,
  source: string,
  staticCandidates: ResourceFindingCandidateV1[],
): Record<string, unknown> {
  let code = source;
  const payload: Record<string, unknown> = {
    schema_version: 1,
    task: "node_resource_llm_v0",
    file_path: filePath,
  };
  if (code.length > MAX_SOURCE_CHARS) {
    code = code.slice(0, MAX_SOURCE_CHARS);
    payload.source_code_truncated_note = `truncated to ${MAX_SOURCE_CHARS} chars`;
  }
  payload.source_code = code;
  payload.static_candidates = staticCandidates
    .filter((f) => (f.scope.source_locations[0]?.path || "").replace(/\\/g, "/") === filePath.replace(/\\/g, "/"))
    .map((f) => ({
      mechanism_id: f.mechanism_id,
      title: f.title,
      start_line: f.scope.source_locations[0]?.start_line,
    }));
  return payload;
}

function extractJsonObject(raw: string): unknown {
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  const m = cleaned.match(/\{[\s\S]*\}\s*$/);
  return JSON.parse(m ? m[0] : cleaned);
}

function parseHits(raw: string, filePath: string): LlmHit[] {
  const data = extractJsonObject(raw) as { findings?: unknown };
  if (!data || !Array.isArray(data.findings)) throw new Error("Invalid LLM response: expected findings array");
  const list = data.findings;
  const out: LlmHit[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const mech = String(row.mechanism_id || "").trim();
    if (!ALLOWED_MECHANISMS.has(mech)) continue;
    const title = String(row.title || mech).trim().slice(0, 200);
    if (title.length < 8) continue;
    const domain = String(row.primary_domain || "compute.cpu").trim();
    let line: number | null = null;
    if (typeof row.start_line === "number" && Number.isSafeInteger(row.start_line) && row.start_line > 0) {
      line = row.start_line;
    }
    let conf = 0.5;
    try {
      conf = Math.max(0, Math.min(1, Number(row.confidence ?? 0.5)));
    } catch {
      conf = 0.5;
    }
    out.push({
      mechanism_id: mech,
      title,
      primary_domain: domain,
      path: filePath,
      start_line: line,
      evidence: String(row.evidence || "").slice(0, 500),
      recommended_fix: String(row.recommended_fix || "").slice(0, 500),
      confidence: conf,
    });
  }
  return out;
}

async function chatCompletion(
  cfg: LlmConfig,
  messages: Array<{ role: string; content: string }>,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  const model = cfg.model || "gpt-4o-mini";
  const endpoint = (cfg.azure_endpoint || "").replace(/\/+$/, "");
  let url: string;
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (cfg.provider === 'anthropic') {
    const base = endpoint || 'https://api.anthropic.com/v1'
    const url = base.endsWith('/messages') ? base : `${base.endsWith('/v1') ? base : `${base}/v1`}/messages`
    const response = await fetchImpl(url, {
      method: 'POST', signal,
      headers: { ...headers, 'x-api-key': cfg.api_key, 'anthropic-version': cfg.api_version || '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1800,
        system: messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n'),
        messages: messages.filter(message => message.role !== 'system'),
      }),
    })
    if (!response.ok) throw new Error(`LLM HTTP ${response.status}`)
    const data = await response.json() as { content?: Array<{ type?: string; text?: string }> }
    return (data.content ?? []).filter(block => block.type === 'text').map(block => block.text || '').join('')
  }

  if (cfg.provider === "azure_openai" || (endpoint && /openai\.azure\.com|cognitiveservices\.azure\.com/i.test(endpoint))) {
    url = `${endpoint}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${encodeURIComponent(cfg.api_version || "2024-02-15-preview")}`;
    headers["api-key"] = cfg.api_key;
  } else if (endpoint) {
    const base = cfg.provider === 'ollama' && !/\/v1(?:\/|$)/.test(endpoint) ? `${endpoint}/v1` : endpoint;
    url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
    if (cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;
  } else {
    url = "https://api.openai.com/v1/chat/completions";
    headers.Authorization = `Bearer ${cfg.api_key}`;
  }

  const body: Record<string, unknown> = {
    messages,

  };
  if (/^(o[1-9]|gpt-5|gpt-6)/i.test(model)) {
    body.max_completion_tokens = 1800;
  } else {
    body.max_tokens = 1800;
    body.temperature = 0;
  }
  // Azure deployment path does not need body.model; openai-compat does.
  if (!/\/deployments\//i.test(url)) {
    body.model = model;
  }

  // Azure deployment aliases do not identify their underlying model. Match the
  // Python client's bounded unsupported-parameter fallback, under one timeout.
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetchImpl(url, {
      signal, method: 'POST', headers, body: JSON.stringify(body),
    });
    if (resp.ok) {
      const json = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
      return String(json.choices?.[0]?.message?.content || '');
    }
    if (resp.status === 400 && attempt < 2) {
      const data = await resp.json().catch(() => null) as {
        error?: { param?: unknown; message?: unknown; code?: unknown }
      } | null;
      const parameter = String(data?.error?.param || '').toLowerCase();
      const detail = `${data?.error?.code || ''} ${data?.error?.message || ''}`.toLowerCase();
      if (/unsupported|not supported|only the default/.test(detail)) {
        if ('max_tokens' in body && (parameter === 'max_tokens' || detail.includes('max_tokens'))) {
          body.max_completion_tokens = body.max_tokens;
          delete body.max_tokens;
          delete body.temperature;
          continue;
        }
        if ('temperature' in body && (parameter === 'temperature' || detail.includes('temperature'))) {
          delete body.temperature;
          continue;
        }
      }
    }
    throw new Error(`LLM HTTP ${resp.status}`);
  }
  throw new Error('LLM rejected supported request parameters');
}


export type NodeLlmReviewOptions = {
  projectDir: string
  projectId: string
  staticFindings: ResourceFindingCandidateV1[]
  paths: string[]
  config: LlmConfig
  depth?: NodeLlmDepth
  fetchImpl?: typeof fetch
  timeoutMs?: number
  progress?: (message: string) => void
}

export type NodeLlmReviewResult = {
  findings: ResourceFindingCandidateV1[]
  filesReviewed: number
  filesPlanned: number
  errors: string[]
}

/** Bounded review; static results survive errors, which are always reported. */
export async function runNodeLlmResourceReview(opts: NodeLlmReviewOptions): Promise<NodeLlmReviewResult> {
  const depth = opts.depth ?? 'standard'
  const counts = new Map<string, number>()
  for (const finding of opts.staticFindings) {
    const rel = finding.scope.source_locations[0]?.path
    if (rel) counts.set(rel, (counts.get(rel) ?? 0) + 1)
  }
  const files = [...new Set(opts.paths.map(p => p.replace(/\\/g, '/')))]
    .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b))
    .slice(0, DEPTH_MAX[depth])
  const extra: ResourceFindingCandidateV1[] = []
  const errors: string[] = []
  let config: LlmConfig
  try { config = resolveNodeLlmConfig(opts.config) } catch (err) {
    return { findings: opts.staticFindings, filesReviewed: 0, filesPlanned: files.length, errors: [err instanceof Error ? err.message : String(err)] }
  }
  const root = realpathSync(opts.projectDir)
  let filesReviewed = 0
  for (const rel of files) {
    opts.progress?.(`LLM review (${depth}): ${rel}`)
    try {
      const abs = realpathSync(resolve(root, rel))
      const inside = relative(root, abs)
      if (inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(inside)) {
        throw new Error('source path is outside project')
      }
      if (!statSync(abs).isFile() || statSync(abs).size > 512 * 1024) throw new Error('source file exceeds review limit')
      const source = readFileSync(abs, 'utf8').slice(0, MAX_SOURCE_CHARS)
      const signal = AbortSignal.timeout(Math.min(opts.timeoutMs ?? 30_000, 60_000))
      const raw = await chatCompletion(config, [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: JSON.stringify(userPayload(rel, source, opts.staticFindings)) },
      ], opts.fetchImpl ?? fetch, signal)
      const lines = source.split(/\r?\n/)
      for (const hit of parseHits(raw, rel)) {
        if (!hit.start_line || hit.start_line > lines.length) continue
        if (!['compute.cpu', 'memory.host', 'network.io', 'external_api', 'storage.io'].includes(hit.primary_domain)) continue
        if (!hit.evidence?.trim() || !source.includes(hit.evidence) || !lines[hit.start_line - 1]?.includes(hit.evidence.split('\n')[0]!)) continue
        const duplicate = [...opts.staticFindings, ...extra].some(f =>
          f.mechanism_id === hit.mechanism_id && f.scope.source_locations.some(l => l.path === rel && l.start_line === hit.start_line))
        if (duplicate) continue
        const candidate = toResourceFindingCandidate({
          mechanism_id: hit.mechanism_id,
          primary_domain: hit.primary_domain as ResourcePrimaryDomain,
          admission_domain: hit.primary_domain,
          title: hit.title, rel_path: rel, start_line: hit.start_line, end_line: hit.start_line,
          language: /\.tsx?$/.test(rel) ? 'typescript' : 'javascript',
          detector_id: 'js.llm.resource_review', detector_version: '0.1.0',
        }, opts.projectId)
        if (candidate) {
          if (candidate.optimization && hit.recommended_fix) candidate.optimization.summary = hit.recommended_fix
          extra.push(candidate)
        }
      }
      filesReviewed += 1
    } catch (err) {
      errors.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`)
      // Authentication, provider errors and timeouts should not repeat for every file.
      break
    }
  }
  return { findings: filterValidResourceFindings([...opts.staticFindings, ...extra]), filesReviewed, filesPlanned: files.length, errors }
}
