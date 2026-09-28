#!/usr/bin/env node
/**
 * Thin Node Analyze CLI — print ``service_manifest_v0`` + ``resource_finding_v1``
 * candidates for a project path. Never uploads; never touches RunSession.
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
 *   --quiet                    suppress non-JSON status lines on stderr
 */

import { accessSync, constants, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  buildAnalyzeGateSummary,
  findingsExceedFailThreshold,
  formatAnalyzeGateFailureMessage,
  resolveAnalyzeGateLimit,
} from './analyzeGate.js'
import { buildResourceAnalyzeResultFromPaths } from './buildResourceFindings.js'
import { formatAnalyzeHelp } from '../cli/helpText.js'

type Flags = {
  projectId: string
  paths: string[] | null
  findingsOnly: boolean
  manifestOnly: boolean
  jsonSummary: boolean
  failOn: string | null
  maxAtOrAbove: number | null
  quiet: boolean
  help: boolean
  positional: string[]
}

function printHelp(): void {
  process.stdout.write(formatAnalyzeHelp())
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
    projectId: 'local',
    paths: null,
    findingsOnly: false,
    manifestOnly: false,
    jsonSummary: false,
    failOn: null,
    maxAtOrAbove: null,
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
    if (arg === '--quiet') {
      flags.quiet = true
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
export function runAnalyzeCli(argv: string[]): number {
  let flags: Flags
  try {
    flags = parseArgs(argv)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    printHelp()
    return 2
  }

  if (flags.help || flags.positional.length === 0) {
    printHelp()
    return flags.help ? 0 : 2
  }
  const modeCount = [flags.findingsOnly, flags.manifestOnly, flags.jsonSummary].filter(Boolean)
    .length
  if (modeCount > 1) {
    process.stderr.write(
      'Choose at most one of --findings-only / --manifest-only / --json-summary\n',
    )
    return 2
  }
  if (flags.maxAtOrAbove != null && flags.failOn == null) {
    process.stderr.write('--max-at-or-above requires --fail-on\n')
    return 2
  }
  if (flags.maxAtOrAbove != null && (!Number.isFinite(flags.maxAtOrAbove) || flags.maxAtOrAbove < 0)) {
    process.stderr.write('--max-at-or-above must be a non-negative number\n')
    return 2
  }

  const projectDir = resolve(flags.positional[0]!)
  try {
    accessSync(projectDir, constants.R_OK)
    if (!statSync(projectDir).isDirectory()) {
      throw new Error('not a directory')
    }
  } catch {
    process.stderr.write(`Project path is not a readable directory: ${projectDir}\n`)
    return 2
  }

  const result = buildResourceAnalyzeResultFromPaths(projectDir, flags.paths, {
    projectId: flags.projectId,
  })

  const summary = buildAnalyzeGateSummary({
    projectId: flags.projectId,
    filesScanned: result.stats.files_scanned,
    findings: result.findings,
    failOn: flags.failOn,
    maxAtOrAbove: flags.maxAtOrAbove,
  })

  const payload = flags.jsonSummary
    ? summary
    : flags.findingsOnly
      ? result.findings
      : flags.manifestOnly
        ? result.manifest
        : result

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)

  if (!flags.quiet && !flags.jsonSummary) {
    process.stderr.write(
      `netgreener analyze: files=${result.stats.files_scanned} findings=${result.stats.findings} upload=never\n`,
    )
  }

  const limit = resolveAnalyzeGateLimit(flags.failOn, flags.maxAtOrAbove)
  if (flags.failOn && limit != null) {
    if (findingsExceedFailThreshold(result.findings, flags.failOn, limit)) {
      if (!flags.jsonSummary) {
        process.stderr.write(
          `${formatAnalyzeGateFailureMessage(result.findings, flags.failOn, limit)}\n`,
        )
      }
      return 1
    }
  }

  return summary.exit_code
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  pathToFileURL(resolve(process.argv[1]!)).href === import.meta.url

if (invokedDirectly) {
  process.exitCode = runAnalyzeCli(process.argv.slice(2))
}
