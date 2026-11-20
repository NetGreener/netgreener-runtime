#!/usr/bin/env node
/**
 * Thin Node Analyze CLI — print ``service_manifest_v0`` + ``resource_finding_v1``
 * candidates for a project path. Reviews JS/TS with static checks and LLM; never uploads findings or touches RunSession.
 *
 *   npx netgreener-analyze ./my-app
 *   npm run example:analyze-cli -- ./fixtures/analyze-sample
 *
 * Options:
 *   --project-id <id>          project_id stamped on candidates (default: local)
 *   --paths a.ts,b.ts          explicit repo-relative paths (skip auto-walk)
 *   --findings-only            print findings array only
 *   --manifest-only            print service manifest only
 *   --json-summary             print machine-readable gate summary only (CI)
 *   --fail-on any|<mechanism>[,…]   CI gate (exit 1 when exceeded)
 *   --max-at-or-above <n>      with --fail-on: allow up to N matches (default 0)
 *   --depth quick|standard|thorough  AI review depth (default standard)
 *   --quiet                    suppress non-JSON status lines on stderr
 */

import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  buildAnalyzeGateSummary,
  findingsExceedFailThreshold,
  formatAnalyzeGateFailureMessage,
  resolveAnalyzeGateLimit,
} from './analyzeGate.js'
import { buildResourceAnalyzeResultFromPaths } from './buildResourceFindings.js'
import { formatAnalyzeHelp } from '../cli/helpText.js'

import { listCandidateSourceFiles } from './projectScan.js'
import { resolveNodeLlmConfig, runNodeLlmResourceReview, type LlmConfig } from './llmResourceReview.js'
import { loadAnalyzeRepositoryConfig } from './repoConfig.js'
import { writeAnalyzeCompletion } from './analyzeReport.js'
import { NetGreenerClient } from '../sdk/client.js'
import { loadRuntimeConfig } from '../config.js'

const LLM_DEPTHS = new Set(['quick', 'standard', 'thorough'])

type Flags = {
  outputFile: string | null
  projectId: string
  paths: string[] | null
  findingsOnly: boolean
  manifestOnly: boolean
  jsonSummary: boolean
  failOn: string | null
  maxAtOrAbove: number | null
  llm: boolean | null
  depth: 'quick' | 'standard' | 'thorough'
  quiet: boolean
  help: boolean
  positional: string[]
}

function printHelp(): void {
  process.stdout.write(formatAnalyzeHelp())
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
    outputFile: null,
    projectId: 'local',
    paths: null,
    findingsOnly: false,
    manifestOnly: false,
    jsonSummary: false,
    failOn: null,
    maxAtOrAbove: null,
    depth: 'standard',
    llm: null,
    quiet: false,
    help: false,
    positional: [],
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    if (arg === '-h' || arg === '--help') {
      flags.help = true
      continue
    }
    if (arg === '--findings-only') {
      flags.findingsOnly = true
      continue
    }
    if (arg === '--manifest-only') {
      flags.manifestOnly = true
      continue
    }
    if (arg === '--json-summary') {
      flags.jsonSummary = true
      continue
    }
    if (arg === '--depth') {
      const value = String(argv[++i] || '')
        .trim()
        .toLowerCase()
      if (!LLM_DEPTHS.has(value)) {
        throw new Error(
          `Invalid --depth ${value || '(empty)'}. Use quick, standard, or thorough.`,
        )
      }
      flags.depth = value as Flags['depth']
      continue
    }
    if (arg.startsWith('--depth=')) {
      const value = arg.slice('--depth='.length).trim().toLowerCase()
      if (!LLM_DEPTHS.has(value)) {
        throw new Error(
          `Invalid --depth ${value || '(empty)'}. Use quick, standard, or thorough.`,
        )
      }
      flags.depth = value as Flags['depth']
      continue
    }
    if (arg === '--llm' || arg === '--no-llm') {
      flags.llm = arg === '--llm'
      continue
    }
    if (arg === '--no-upload') continue
    if (arg === '--output-file' || arg.startsWith('--output-file=')) {
      const value = arg === '--output-file' ? argv[++i] : arg.slice('--output-file='.length)
      if (!value || value.startsWith('-')) throw new Error('--output-file requires a path.')
      flags.outputFile = value
      continue
    }
    if (arg === '--quiet') {
      flags.quiet = true
      continue
    }
    if (arg === '--project-id') {
      const value = argv[++i]
      if (!value || value.startsWith('-')) throw new Error('--project-id requires a value.')
      flags.projectId = value
      continue
    }
    if (arg.startsWith('--project-id=')) {
      flags.projectId = arg.slice('--project-id='.length)
      if (!flags.projectId.trim()) throw new Error('--project-id requires a value.')
      continue
    }
    if (arg === '--paths') {
      const raw = String(argv[++i] || '')
      flags.paths = [...(flags.paths ?? []), ...raw
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)]
      continue
    }
    if (arg.startsWith('--paths=')) {
      flags.paths = [...(flags.paths ?? []), ...arg
        .slice('--paths='.length)
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)]
      continue
    }
    if (arg === '--fail-on') {
      flags.failOn = String(argv[++i] || '').trim() || null
      continue
    }
    if (arg.startsWith('--fail-on=')) {
      flags.failOn = arg.slice('--fail-on='.length).trim() || null
      continue
    }
    if (arg === '--max-at-or-above') {
      flags.maxAtOrAbove = Number(argv[++i])
      continue
    }
    if (arg.startsWith('--max-at-or-above=')) {
      flags.maxAtOrAbove = Number(arg.slice('--max-at-or-above='.length))
      continue
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    }
    flags.positional.push(arg)
  }
  return flags
}

/** Run analyze subcommand; ``argv`` is args after ``analyze`` / bin name. */
export async function runAnalyzeCli(
  argv: string[],
  options: {
    env?: NodeJS.ProcessEnv
    fetchImpl?: typeof fetch
    configDir?: string
    stdout?: { write: (text: string) => unknown }
    stderr?: { write: (text: string) => unknown; isTTY?: boolean }
  } = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  let flags: Flags
  try {
    flags = parseArgs(argv)
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    printHelp()
    return 2
  }

  if (flags.help) {
    printHelp()
    return 0
  }
  if (flags.positional.length > 1) {
    stderr.write('Analyze accepts one project directory. Use --paths to select files.\n')
    return 2
  }
  const modeCount = [flags.findingsOnly, flags.manifestOnly, flags.jsonSummary].filter(Boolean)
    .length
  if (modeCount > 1) {
    stderr.write(
      'Choose at most one of --findings-only / --manifest-only / --json-summary\n',
    )
    return 2
  }
  if (flags.maxAtOrAbove != null && flags.failOn == null) {
    stderr.write('--max-at-or-above requires --fail-on\n')
    return 2
  }
  if (flags.maxAtOrAbove != null && (!Number.isFinite(flags.maxAtOrAbove) || flags.maxAtOrAbove < 0)) {
    stderr.write('--max-at-or-above must be a non-negative number\n')
    return 2
  }

  const projectDir = resolve(flags.positional[0] || '.')
  try {
    accessSync(projectDir, constants.R_OK)
    if (!statSync(projectDir).isDirectory()) {
      throw new Error('not a directory')
    }
  } catch {
    stderr.write(`Project path is not a readable directory: ${projectDir}\n`)
    return 2
  }

  const env = options.env ?? process.env
  const configDir = options.configDir ?? join(homedir(), '.netgreener')
  const saved: Record<string, Record<string, unknown>> = {}
  for (const name of ['config', 'credentials']) {
    try {
      saved[name] = JSON.parse(readFileSync(join(configDir, `${name}.json`), 'utf8'))
    } catch { saved[name] = {} }
  }
  let repo: ReturnType<typeof loadAnalyzeRepositoryConfig>
  try { repo = loadAnalyzeRepositoryConfig(projectDir) } catch (err) {
    stderr.write(`Analyze failed: ${err instanceof Error ? err.message : String(err)}\n`)
    if (flags.outputFile) {
      try { writeAnalyzeCompletion(projectDir, flags.outputFile, { error: err instanceof Error ? err.message : String(err) }) } catch { /* Preserve the analysis error. */ }
    }
    return 2
  }
  const cfg = loadRuntimeConfig({
    ...env,
    NETGREENER_TOKEN: env.NETGREENER_TOKEN || env.NETGREENER_SERVICE_TOKEN || String(saved.credentials?.access_token || ''),
    NETGREENER_API_URL: env.NETGREENER_API_URL || repo.apiUrl || String(saved.config?.api_url || 'https://core-api.netgreener.com'),
    NETGREENER_ORG_ID: env.NETGREENER_ORG_ID || String(saved.config?.organization_id || ''),
    NETGREENER_ORG_SLUG: env.NETGREENER_ORG_SLUG || repo.orgSlug || String(saved.config?.organization_slug || ''),
  })
  if (flags.projectId === 'local') flags.projectId = env.NETGREENER_PROJECT_ID?.trim() || repo.projectId || 'local'
  const large = (saved.config?.llm_large ?? {}) as Record<string, unknown>
  const byokKey = env.NETGREENER_LLM_KEY || String(large.key || saved.config?.llm_key || '')
  const byokModel = env.NETGREENER_LLM_MODEL || String(large.model || saved.config?.llm_model || '')
  const byokProvider = env.NETGREENER_LLM_PROVIDER || String(large.provider || saved.config?.llm_provider || '')
  const byokEndpoint = env.NETGREENER_LLM_ENDPOINT || String(large.endpoint || saved.config?.llm_endpoint || '')
  const byokConfigured = Boolean(byokKey || byokModel || byokProvider || byokEndpoint)
  const useLlm = flags.llm ?? Boolean(cfg.token || byokConfigured)
  const started = Date.now()
  let currentStage = 'Preparing analysis'
  const progress = (message: string): void => {
    currentStage = message
    if (!flags.quiet) stderr.write(`${message}\n`)
  }
  const ticker = !flags.quiet && stderr.isTTY ? setInterval(() => {
    stderr.write(`\r\x1b[2K${['|', '/', '-', '\\'][Math.floor((Date.now() - started) / 150) % 4]} ${currentStage} (${Math.floor((Date.now() - started) / 1000)}s)\r`)
  }, 150) : undefined
  ticker?.unref()
  let result
  let llmReview: { filesReviewed: number; filesPlanned: number; errors: string[] } | undefined
  try {
    let llmConfig: LlmConfig | undefined
    if (useLlm) {
      if (!byokConfigured && !cfg.token) throw new Error('LLM review requires login or a BYOK profile; use --no-llm for static analysis.')
      if (byokConfigured) {
        llmConfig = resolveNodeLlmConfig({ api_key: byokKey, model: byokModel, provider: byokProvider || undefined, azure_endpoint: byokEndpoint })
      }
      const fetchImpl: typeof fetch = (input, init) => (options.fetchImpl ?? fetch)(input, {
        ...init, signal: init?.signal ?? AbortSignal.timeout(15_000),
      })
      const client = new NetGreenerClient({
        token: cfg.token, baseUrl: cfg.apiUrl.endsWith('/api/v1') ? cfg.apiUrl : `${cfg.apiUrl}/api/v1`,
        orgId: cfg.organizationId ?? undefined, fetchImpl,
        environment: env.NETGREENER_ENV || repo.environment || String(saved.config?.environment || 'prod'),
      })
      if (cfg.token && cfg.organizationSlug) await client.resolveOrgSlug(cfg.organizationSlug)
      if (flags.projectId !== 'local') {
        const projectId = Number(flags.projectId)
        if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error('LLM review requires a positive numeric project ID.')
        if (cfg.token) {
          progress(`Checking project #${projectId} ...`)
          await client.getProject(projectId)
        }
      }
      if (!llmConfig) {
        progress('Loading managed LLM configuration ...')
        llmConfig = await client.getLlmConfig() as LlmConfig
        if (!llmConfig.api_key || !llmConfig.model || !llmConfig.azure_endpoint) throw new Error('Managed LLM configuration is incomplete.')
      }
    } else if (flags.llm !== false) {
      progress('LLM review skipped: no login or BYOK configured. Set NETGREENER_TOKEN or NETGREENER_LLM_KEY + NETGREENER_LLM_MODEL.')
    }
    progress('Scanning JavaScript/TypeScript files ...')
    const paths = flags.paths ?? listCandidateSourceFiles(projectDir)
    result = buildResourceAnalyzeResultFromPaths(projectDir, paths, { projectId: flags.projectId, onProgress: progress })
    if (llmConfig) {
      const review = await runNodeLlmResourceReview({
        projectDir, projectId: flags.projectId, paths, staticFindings: result.findings,
        config: llmConfig, depth: flags.depth, fetchImpl: options.fetchImpl, progress,
      })
      llmReview = { filesReviewed: review.filesReviewed, filesPlanned: review.filesPlanned, errors: review.errors }
      result.findings = review.findings
      result.stats.findings = result.findings.length
      result.stats.by_mechanism = {}
      for (const finding of result.findings) result.stats.by_mechanism[finding.mechanism_id] = (result.stats.by_mechanism[finding.mechanism_id] ?? 0) + 1
      for (const error of review.errors) stderr.write(`LLM review failed: ${error}\n`)
      progress(`LLM review complete (${flags.depth}) (${Math.floor((Date.now() - started) / 1000)}s)`)
    }
  } catch (err) {
    stderr.write(`Analyze failed: ${err instanceof Error ? err.message : String(err)}\n`)
    if (flags.outputFile) {
      try { writeAnalyzeCompletion(projectDir, flags.outputFile, { error: err instanceof Error ? err.message : String(err) }) } catch { /* Preserve the analysis error. */ }
    }
    return 2
  } finally {
    if (ticker) { clearInterval(ticker); stderr.write('\r\x1b[2K') }
  }

  const summary = buildAnalyzeGateSummary({
    projectId: flags.projectId,
    filesScanned: result.stats.files_scanned,
    findings: result.findings,
    failOn: flags.failOn,
    maxAtOrAbove: flags.maxAtOrAbove,
  })

  const report = { ...result, ...(llmReview ? { llm_review: llmReview } : {}) }
  if (flags.outputFile) {
    try {
      writeAnalyzeCompletion(projectDir, flags.outputFile, {
        report, error: llmReview?.errors.length ? llmReview.errors.join('; ') : undefined,
      })
    } catch (err) {
      stderr.write(`Could not save Analyze report: ${err instanceof Error ? err.message : String(err)}\n`)
      return 2
    }
  }
  const outputSummary = llmReview?.errors.length ? { ...summary, ok: false, exit_code: 2, errors: llmReview.errors } : summary
  const payload = flags.jsonSummary
    ? outputSummary
    : flags.findingsOnly
      ? result.findings
      : flags.manifestOnly
        ? result.manifest
        : report

  stdout.write(`${JSON.stringify(payload, null, 2)}\n`)

  if (!flags.quiet && !flags.jsonSummary) {
    stderr.write(
      `netgreener analyze: files=${result.stats.files_scanned} findings=${result.stats.findings} declared_apis=${result.stats.declared_external_apis} upload=never\n`,
    )
  }

  if (llmReview?.errors.length) return 2
  const limit = resolveAnalyzeGateLimit(flags.failOn, flags.maxAtOrAbove)
  if (flags.failOn && limit != null) {
    if (findingsExceedFailThreshold(result.findings, flags.failOn, limit)) {
      if (!flags.jsonSummary) {
        stderr.write(
          `${formatAnalyzeGateFailureMessage(result.findings, flags.failOn, limit)}\n`,
        )
      }
      return 1
    }
  }

  return llmReview?.errors.length ? 2 : summary.exit_code
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  pathToFileURL(resolve(process.argv[1]!)).href === import.meta.url

if (invokedDirectly) {
  runAnalyzeCli(process.argv.slice(2)).then(code => { process.exitCode = code }).catch(err => {
    process.stderr.write(`Analyze failed: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 2
  })
}
