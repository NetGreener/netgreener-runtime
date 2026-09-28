/**
 * Orchestrate resource-candidate emission from in-memory sources or disk.
 * Prefer TypeScript AST when available; heuristics otherwise.
 * Additive Analyze path — never touches RunSession upload.
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { collectPreferAstHits } from './preferAstDetectors.js'
import {
  buildServiceManifestFromPaths,
  listCandidateSourceFiles,
  type ListCandidateSourceFilesOptions,
} from './projectScan.js'
import {
  toResourceFindingCandidate,
  type ResourceCandidateHit,
  type ResourceFindingCandidateV1,
} from './resourceFindingCandidate.js'
import type { ServiceManifestV0 } from './serviceDiscovery.js'
import { filterValidResourceFindings } from './validateResourceFinding.js'
import { isTypescriptAnalyzeAvailable } from './loadTypescript.js'

export type BuildResourceFindingsOptions = ListCandidateSourceFilesOptions & {
  projectId?: string
  /** Max candidate findings to return (default 50). */
  maxFindings?: number
}

export type ResourceAnalyzeResultV0 = {
  schema: 'resource_analyze_result_v0'
  contract_status: 'mp4_scaffold'
  project_id: string
  manifest: ServiceManifestV0
  findings: ResourceFindingCandidateV1[]
  stats: {
    files_scanned: number
    findings: number
    by_mechanism: Record<string, number>
  }
  notes: string[]
}

function collectHitsFromSources(sources: Record<string, string>): ResourceCandidateHit[] {
  const hits: ResourceCandidateHit[] = []
  for (const [rel, source] of Object.entries(sources)) {
    hits.push(...collectPreferAstHits(source, rel))
  }
  return hits
}

/**
 * Build admitted ``resource_finding_v1`` candidates from path→source map.
 */
export function buildResourceFindingsFromSources(
  sources: Record<string, string>,
  opts: BuildResourceFindingsOptions = {},
): ResourceFindingCandidateV1[] {
  const maxFindings = Math.max(1, opts.maxFindings ?? 50)
  const projectId = opts.projectId ?? 'local'
  const out: ResourceFindingCandidateV1[] = []
  for (const hit of collectHitsFromSources(sources)) {
    const finding = toResourceFindingCandidate(hit, projectId)
    if (!finding) continue
    out.push(finding)
    if (out.length >= maxFindings) break
  }
  return filterValidResourceFindings(out)
}

/**
 * Walk project (or explicit paths), emit candidates + service manifest together.
 */
export function buildResourceAnalyzeResultFromPaths(
  projectDir: string,
  relPaths?: Iterable<string> | null,
  opts: BuildResourceFindingsOptions = {},
): ResourceAnalyzeResultV0 {
  const projectId = opts.projectId ?? 'local'
  const maxFileBytes = Math.max(1024, opts.maxFileBytes ?? 512 * 1024)
  const paths = relPaths
    ? [...relPaths].filter(Boolean).map((p) => String(p).replace(/\\/g, '/'))
    : listCandidateSourceFiles(projectDir, opts)

  const sources: Record<string, string> = {}
  for (const rel of paths) {
    try {
      const abs = join(projectDir, rel)
      const st = statSync(abs)
      if (!st.isFile() || st.size > maxFileBytes) continue
      sources[rel.replace(/\\/g, '/')] = readFileSync(abs, { encoding: 'utf8' })
    } catch {
      continue
    }
  }

  const findings = buildResourceFindingsFromSources(sources, opts)
  const by_mechanism: Record<string, number> = {}
  for (const f of findings) {
    by_mechanism[f.mechanism_id] = (by_mechanism[f.mechanism_id] || 0) + 1
  }

  const manifest = buildServiceManifestFromPaths(projectDir, Object.keys(sources), opts)

  return {
    schema: 'resource_analyze_result_v0',
    contract_status: 'mp4_scaffold',
    project_id: projectId,
    manifest,
    findings,
    stats: {
      files_scanned: Object.keys(sources).length,
      findings: findings.length,
      by_mechanism,
    },
    notes: [
      'MP4 scaffold: TypeScript AST preferred for all current RD0 twins; heuristics fallback when typescript absent',
      'Stable mechanism_id/evidence_state aligned to resource_finding_v1 + RD0 disposition',
      'Does not modify RunSession upload, CLI, or VSCE wiring',
      'Detectors: retry_amplification, external_api_overconsumption, unbounded_parallelism, polling_or_idle_work, repeated_work, process_or_runtime_churn (subprocess + model_load), memory_retention_or_materialization, per_item_instead_of_batch (nested lookup + inference_inside_loop)',
      `typescript AST available=${isTypescriptAnalyzeAvailable()}`,
      'Candidates are fail-closed filtered through vendored resource_finding_v1 JSON Schema (Ajv)',
      'Skipped RD0 context-only: http_call_without_timeout; skipped low-energy print_in_loop; skipped ML-only excess_training_work / accelerator_underutilization',
    ],
  }
}
