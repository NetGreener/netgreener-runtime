/**
 * ``netgreener optimize <projectDir>`` — local OptimizerProvider + VerificationProvider.
 *
 * Default: local proposals (no LLM).
 * ``--llm``: opt-in shared api_server ``POST /optimize/function`` (owner OK 2026-10-02).
 * ``--apply``: only auto_apply_safe local patches (not LLM results).
 * ``--llm --apply-verified``: LLM splice writes gated by VerificationProvider (owner OK).
 * Does not invent measured savings. Does not flip EXPORT_MODE.
 */

import { accessSync, constants, statSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildResourceAnalyzeResultFromPaths } from '../analyze/buildResourceFindings.js'
import { applySafeProposals, applyVerifiedPatches } from './apply.js'
import { buildVerifiedPatchesFromLlmSession } from './llmApply.js'
import { runLlmOptimizeSession } from './llmSession.js'
import { createLocalJsTsOptimizerProvider } from './provider.js'
import { createLocalJsTsVerificationProvider } from './verification.js'

export type OptimizeCliFlags = {
  projectDir: string
  projectId: string
  paths: string[] | null
  apply: boolean
  /** LLM-only: write reviewed splices via VerificationProvider. */
  applyVerified: boolean
  verifyOnly: boolean
  skipTest: boolean
  quiet: boolean
  help: boolean
  llm: boolean
  maxLlm: number
}

export function formatOptimizeHelp(): string {
  return `Usage: netgreener optimize <projectDir> [options]

Local JS/TS OptimizerProvider + VerificationProvider (default):
  1. Run Analyze (upload=never) for resource_finding_v1 candidates
  2. Emit optimize_result_v0 proposals (guidance; some may include safe patches)
  3. Optional --apply: write only auto_apply_safe patches after verify gates

LLM session (opt-in, same api_server brain as Python/VSCE):
  --llm                 Call POST /optimize/function for top candidates
                        Requires NETGREENER_TOKEN + numeric --project-id
  --llm --apply-verified
                        After LLM session: splice reviewed code, VerificationProvider
                        before+after, rollback on fail (NOT the same as --apply)

Does NOT:
  • invent measured energy/cost savings
  • flip NETGREENER_EXPORT_MODE
  • apply LLM patches via --apply (use --apply-verified with --llm)

Options:
  --project-id <id>     Stamp project_id (default: local; required numeric for --llm)
  --paths a,b           Explicit repo-relative paths (skip auto-walk)
  --apply               Apply auto_apply_safe patches (verify before+after; rollback on fail)
  --apply-verified      With --llm only: apply LLM splices via VerificationProvider
  --verify              Run VerificationProvider only (no proposals apply)
  --llm                 Shared LLM optimize session (api_server)
  --max-llm <n>         Max findings for --llm (default 5, max 20)
  --skip-test           Do not run npm test during verification
  --quiet               Suppress stderr status lines
  -h, --help            Show this help

Env (--llm):
  NETGREENER_TOKEN / NETGREENER_SERVICE_TOKEN
  NETGREENER_API_URL   (optional)
  NETGREENER_PROJECT_ID (optional alias for --project-id)

Examples:
  netgreener optimize ./fixtures/analyze-sample
  netgreener optimize ./my-app --verify
  netgreener optimize ./my-app --apply --skip-test
  netgreener optimize ./my-app --llm --project-id 97
  netgreener optimize ./my-app --llm --apply-verified --project-id 97 --skip-test

See OPTIMIZE_STUB.md for MP4 boundaries.
`
}

export function parseOptimizeArgs(argv: string[]): OptimizeCliFlags {
  const flags: OptimizeCliFlags = {
    projectDir: '',
    projectId: 'local',
    paths: null,
    apply: false,
    applyVerified: false,
    verifyOnly: false,
    skipTest: false,
    quiet: false,
    help: false,
    llm: false,
    maxLlm: 5,
  }
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    if (arg === '-h' || arg === '--help') {
      flags.help = true
      continue
    }
    if (arg === '--quiet') {
      flags.quiet = true
      continue
    }
    if (arg === '--apply') {
      flags.apply = true
      continue
    }
    if (arg === '--apply-verified') {
      flags.applyVerified = true
      continue
    }
    if (arg === '--verify') {
      flags.verifyOnly = true
      continue
    }
    if (arg === '--llm') {
      flags.llm = true
      continue
    }
    if (arg === '--skip-test') {
      flags.skipTest = true
      continue
    }
    if (arg === '--max-llm') {
      const n = Number(argv[++i] || '5')
      flags.maxLlm = Number.isFinite(n) ? n : 5
      continue
    }
    if (arg.startsWith('--max-llm=')) {
      const n = Number(arg.slice('--max-llm='.length) || '5')
      flags.maxLlm = Number.isFinite(n) ? n : 5
      continue
    }
    if (arg === '--project-id') {
      flags.projectId = String(argv[++i] || 'local')
      continue
    }
    if (arg.startsWith('--project-id=')) {
      flags.projectId = arg.slice('--project-id='.length) || 'local'
      continue
    }
    if (arg === '--paths') {
      const raw = String(argv[++i] || '')
      flags.paths = raw
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
      continue
    }
    if (arg.startsWith('--paths=')) {
      flags.paths = arg
        .slice('--paths='.length)
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
      continue
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown optimize option: ${arg}`)
    }
    positionals.push(arg)
  }
  flags.projectDir = positionals[0] || ''
  return flags
}

export function runOptimizeCli(argv: string[]): number | Promise<number> {
  let flags: OptimizeCliFlags
  try {
    flags = parseOptimizeArgs(argv)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.stderr.write(formatOptimizeHelp())
    return 2
  }

  if (flags.help || !flags.projectDir) {
    process.stdout.write(formatOptimizeHelp())
    return flags.help ? 0 : 2
  }

  if (flags.llm && flags.apply) {
    process.stderr.write(
      'netgreener optimize: --llm cannot be combined with --apply ' +
        '(local safe rules only). Use --llm --apply-verified for VerificationProvider LLM writes.\n',
    )
    return 2
  }
  if (flags.applyVerified && !flags.llm) {
    process.stderr.write(
      'netgreener optimize: --apply-verified requires --llm ' +
        '(for local safe rules use --apply).\n',
    )
    return 2
  }

  const projectDir = resolve(flags.projectDir)
  try {
    accessSync(projectDir, constants.R_OK)
    if (!statSync(projectDir).isDirectory()) {
      process.stderr.write(`Not a directory: ${projectDir}\n`)
      return 2
    }
  } catch {
    process.stderr.write(`Cannot read projectDir: ${projectDir}\n`)
    return 2
  }

  if (flags.verifyOnly) {
    if (!flags.quiet) {
      process.stderr.write(`netgreener optimize --verify: ${projectDir}\n`)
    }
    const verification = createLocalJsTsVerificationProvider().verify(projectDir, {
      skipTest: flags.skipTest,
      skipBuild: true,
    })
    process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`)
    return verification.ok ? 0 : 1
  }

  if (flags.llm) {
    return runLlmOptimizeCli(projectDir, flags)
  }

  if (!flags.quiet) {
    process.stderr.write(
      `netgreener optimize: Analyze + local proposals for ${projectDir} (upload=never)…\n`,
    )
  }

  const analyze = buildResourceAnalyzeResultFromPaths(
    projectDir,
    flags.paths,
    { projectId: flags.projectId },
  )
  const provider = createLocalJsTsOptimizerProvider()
  const result = provider.proposeFromFindings(analyze.findings, {
    projectId: flags.projectId,
    projectDir,
  })

  if (flags.apply) {
    if (!flags.quiet) {
      process.stderr.write(
        `netgreener optimize --apply: ${result.stats.auto_apply_safe} safe patch(es); verifying…\n`,
      )
    }
    const { apply, verification_before, verification_after } = applySafeProposals(
      projectDir,
      result.proposals,
      { skipTest: flags.skipTest, skipBuild: true },
    )
    result.verification = verification_after || verification_before
    result.notes = [
      ...result.notes,
      apply.rolled_back
        ? 'Apply rolled back after verification_after failure.'
        : apply.applied.length
          ? `Applied ${apply.applied.length} safe patch(es).`
          : 'No safe patches applied.',
    ]
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!flags.quiet) {
      process.stderr.write(
        `netgreener optimize --apply: applied=${apply.applied.length} ` +
          `rolled_back=${apply.rolled_back} verify_ok=${result.verification?.ok}\n`,
      )
    }
    if (!apply.verification_before_ok) return 1
    if (apply.rolled_back) return 1
    return 0
  }

  result.verification = createLocalJsTsVerificationProvider().verify(projectDir, {
    skipTest: true,
    skipBuild: true,
  })

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!flags.quiet) {
    process.stderr.write(
      `netgreener optimize: ${result.stats.proposals} proposal(s), ` +
        `${result.stats.auto_apply_safe} auto_apply_safe — no patches applied ` +
        `(use --apply).\n`,
    )
  }
  return 0
}

async function runLlmOptimizeCli(
  projectDir: string,
  flags: OptimizeCliFlags,
): Promise<number> {
  const token = (
    process.env.NETGREENER_TOKEN ||
    process.env.NETGREENER_SERVICE_TOKEN ||
    ''
  ).trim()
  if (!token) {
    process.stderr.write(
      'netgreener optimize --llm: set NETGREENER_TOKEN (or NETGREENER_SERVICE_TOKEN).\n',
    )
    return 2
  }
  const projectIdRaw =
    flags.projectId !== 'local'
      ? flags.projectId
      : (process.env.NETGREENER_PROJECT_ID || '').trim()
  const projectId = Number(projectIdRaw)
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    process.stderr.write(
      'netgreener optimize --llm: require numeric --project-id or NETGREENER_PROJECT_ID.\n',
    )
    return 2
  }

  if (!flags.quiet) {
    process.stderr.write(
      `netgreener optimize --llm: Analyze + api_server /optimize/function ` +
        `(project=${projectId}, max=${flags.maxLlm})…\n`,
    )
  }

  const analyze = buildResourceAnalyzeResultFromPaths(projectDir, flags.paths, {
    projectId: String(projectId),
  })
  const apiUrl = (process.env.NETGREENER_API_URL || '').trim() || undefined
  const session = await runLlmOptimizeSession({
    projectDir,
    projectId,
    findings: analyze.findings,
    token,
    apiUrl,
    maxFindings: flags.maxLlm,
    byok: {
      provider: process.env.NETGREENER_LLM_PROVIDER || undefined,
      key: process.env.NETGREENER_LLM_KEY || undefined,
      endpoint: process.env.NETGREENER_LLM_ENDPOINT || undefined,
      model: process.env.NETGREENER_LLM_MODEL || undefined,
    },
  })

  if (!flags.applyVerified) {
    process.stdout.write(`${JSON.stringify(session, null, 2)}\n`)
    const okCount = session.items.filter((i) => i.ok).length
    if (!flags.quiet) {
      process.stderr.write(
        `netgreener optimize --llm: ${okCount}/${session.items.length} ok ` +
          `(of ${session.candidates_considered} candidates). Review JSON; ` +
          `or re-run with --apply-verified.\n`,
      )
    }
    return session.items.length === 0 || okCount > 0 ? 0 : 1
  }

  if (!flags.quiet) {
    process.stderr.write(
      'netgreener optimize --llm --apply-verified: splicing reviewed items; verifying…\n',
    )
  }
  const { patches, skipped } = buildVerifiedPatchesFromLlmSession(projectDir, session)
  const { apply, verification_before, verification_after } = applyVerifiedPatches(
    projectDir,
    patches,
    { skipTest: flags.skipTest, skipBuild: true, preSkipped: skipped },
  )
  const out = {
    schema: 'optimize_llm_apply_verified_v0' as const,
    session,
    apply,
    verification_before,
    verification_after,
    notes: [
      'LLM splices applied only when review_passed/apply_recommended allow.',
      'VerificationProvider before+after; rollback on fail.',
      'Not auto_apply_safe. No measured savings claimed.',
    ],
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
  if (!flags.quiet) {
    process.stderr.write(
      `netgreener optimize --llm --apply-verified: applied=${apply.applied.length} ` +
        `skipped=${apply.skipped.length} rolled_back=${apply.rolled_back}\n`,
    )
  }
  if (!apply.verification_before_ok) return 1
  if (apply.rolled_back) return 1
  return apply.applied.length > 0 || patches.length === 0 ? 0 : 1
}
