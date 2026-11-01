/**
 * Local JS/TS VerificationProvider — formatter/typecheck/test gates (MP4).
 *
 * Never invents energy/cost savings. Missing scripts → not_applicable (not fail).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { VerificationResultV0, VerifyGateOutcome } from './types.js'

export type VerificationProvider = {
  readonly id: string
  readonly version: string
  verify(
    projectDir: string,
    opts?: { paths?: string[]; skipTest?: boolean; skipBuild?: boolean },
  ): VerificationResultV0
}

type PackageJson = {
  scripts?: Record<string, string>
}

function readPackageJson(projectDir: string): PackageJson | null {
  const p = join(projectDir, 'package.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as PackageJson
  } catch {
    return null
  }
}

function runCmd(
  command: string,
  args: string[],
  cwd: string,
): { status: number; detail: string; duration_ms: number } {
  const started = Date.now()
  const r = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    env: process.env,
  })
  const duration_ms = Date.now() - started
  const detail = ((r.stderr || '') + (r.stdout || '')).trim().slice(0, 2000)
  return { status: r.status ?? 1, detail: detail || `exit ${r.status ?? 1}`, duration_ms }
}

function syntaxGate(projectDir: string, paths?: string[]): VerifyGateOutcome {
  const targets = (paths || []).filter((p) => /\.(m?js|cjs)$/i.test(p))
  if (targets.length === 0) {
    // TS-only / no JS touch — syntax gate N/A (typecheck covers when present).
    return {
      gate: 'syntax',
      status: 'not_applicable',
      detail: 'No .js/.mjs/.cjs paths to syntax-check',
    }
  }
  for (const rel of targets) {
    const abs = join(projectDir, rel)
    if (!existsSync(abs)) {
      return {
        gate: 'syntax',
        status: 'fail',
        detail: `Missing file: ${rel}`,
        command: `node --check ${rel}`,
      }
    }
    const r = runCmd(process.execPath, ['--check', abs], projectDir)
    if (r.status !== 0) {
      return {
        gate: 'syntax',
        status: 'fail',
        detail: `${rel}: ${r.detail}`,
        command: `node --check ${rel}`,
        duration_ms: r.duration_ms,
      }
    }
  }
  return {
    gate: 'syntax',
    status: 'pass',
    detail: `node --check ok (${targets.length} file(s))`,
    command: 'node --check <paths>',
  }
}

function scriptGate(
  gate: 'typecheck' | 'test' | 'build',
  projectDir: string,
  pkg: PackageJson | null,
  scriptNames: string[],
  skip?: boolean,
): VerifyGateOutcome {
  if (skip) {
    return { gate, status: 'skipped', detail: 'Skipped by flag' }
  }
  if (!pkg?.scripts) {
    return {
      gate,
      status: 'not_applicable',
      detail: 'No package.json scripts',
    }
  }
  const name = scriptNames.find((n) => typeof pkg.scripts?.[n] === 'string')
  if (!name) {
    return {
      gate,
      status: 'not_applicable',
      detail: `No ${scriptNames.join('/')} script`,
    }
  }
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const r = runCmd(npmCmd, ['run', name, '--silent'], projectDir)
  return {
    gate,
    status: r.status === 0 ? 'pass' : 'fail',
    detail: r.detail || `npm run ${name}`,
    command: `npm run ${name}`,
    duration_ms: r.duration_ms,
  }
}

/**
 * Prefer package.json typecheck; else `tsc --noEmit` when tsconfig exists and tsc is resolvable.
 */
function typecheckGate(projectDir: string, pkg: PackageJson | null): VerifyGateOutcome {
  const fromScript = scriptGate('typecheck', projectDir, pkg, [
    'typecheck',
    'type-check',
    'tsc',
  ])
  if (fromScript.status !== 'not_applicable') return fromScript

  const tsconfig = existsSync(join(projectDir, 'tsconfig.json'))
  if (!tsconfig) {
    return {
      gate: 'typecheck',
      status: 'not_applicable',
      detail: 'No typecheck script and no tsconfig.json',
    }
  }

  const tscLocal = join(
    projectDir,
    'node_modules',
    'typescript',
    'bin',
    'tsc',
  )
  const tscCmd = existsSync(tscLocal) ? process.execPath : null
  if (tscCmd) {
    const r = runCmd(tscCmd, [tscLocal, '--noEmit', '-p', 'tsconfig.json'], projectDir)
    return {
      gate: 'typecheck',
      status: r.status === 0 ? 'pass' : 'fail',
      detail: r.detail,
      command: 'node node_modules/typescript/bin/tsc --noEmit',
      duration_ms: r.duration_ms,
    }
  }

  return {
    gate: 'typecheck',
    status: 'not_applicable',
    detail: 'tsconfig.json present but local typescript/tsc not installed',
  }
}

export function createLocalJsTsVerificationProvider(): VerificationProvider {
  return {
    id: 'local_js_ts_verification_v0',
    version: '0.1.0',
    verify(projectDir, opts = {}) {
      const pkg = readPackageJson(projectDir)
      const gates: VerifyGateOutcome[] = [
        syntaxGate(projectDir, opts.paths),
        typecheckGate(projectDir, pkg),
        scriptGate('test', projectDir, pkg, ['test'], opts.skipTest),
        scriptGate('build', projectDir, pkg, ['build'], opts.skipBuild ?? true),
      ]

      const hardFail = gates.some((g) => g.status === 'fail')
      const notes = [
        'VerificationProvider (local JS/TS) — no measured savings claimed.',
        'fail fails the gate; not_applicable/skipped do not.',
        'Default: skip build (opt-in later); test runs when npm script exists.',
      ]

      return {
        schema: 'verification_result_v0',
        provider_id: 'local_js_ts_verification_v0',
        provider_version: '0.1.0',
        project_dir: projectDir,
        ok: !hardFail,
        gates,
        notes,
      }
    },
  }
}
