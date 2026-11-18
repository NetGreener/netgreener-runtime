/**
 * Apply verified full-file patches with VerificationProvider gates + rollback.
 *
 * Used by:
 * - ``--apply`` (local auto_apply_safe only)
 * - ``--llm --apply-verified`` (owner-OK LLM splice; not marked auto_apply_safe)
 *
 * Never uploads. Does not flip EXPORT_MODE. Does not invent savings.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type {
  OptimizeApplyResultV0,
  OptimizeProposalV0,
  VerificationResultV0,
} from './types.js'
import { createLocalJsTsVerificationProvider } from './verification.js'

export type VerifiedPatchWrite = {
  proposal_id: string
  path: string
  new_content: string
  rule_id: string
}

function backupRoot(projectDir: string): string {
  return join(projectDir, '.netgreener', 'optimize-backup')
}

function writeWithDirs(abs: string, content: string): void {
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

/**
 * Verify → backup → write → verify-after → rollback on fail.
 * Callers decide which patches are eligible (safe rules vs LLM-gated).
 */
export function applyVerifiedPatches(
  projectDir: string,
  patches: VerifiedPatchWrite[],
  opts?: {
    skipTest?: boolean
    skipBuild?: boolean
    /** Already-skipped rows to include in the result. */
    preSkipped?: OptimizeApplyResultV0['skipped']
  },
): {
  apply: OptimizeApplyResultV0
  verification_before: VerificationResultV0
  verification_after: VerificationResultV0 | null
} {
  const verifier = createLocalJsTsVerificationProvider()
  const skipped: OptimizeApplyResultV0['skipped'] = [...(opts?.preSkipped || [])]
  const touched = [...new Set(patches.map((p) => p.path))]

  const verification_before = verifier.verify(projectDir, {
    paths: touched,
    skipTest: opts?.skipTest,
    skipBuild: opts?.skipBuild ?? true,
  })

  const applied: OptimizeApplyResultV0['applied'] = []

  if (!verification_before.ok) {
    return {
      apply: {
        schema: 'optimize_apply_result_v0',
        applied: [],
        skipped: [
          ...skipped,
          ...patches.map((p) => ({
            proposal_id: p.proposal_id,
            reason: 'verification_before failed',
          })),
        ],
        rolled_back: false,
        verification_before_ok: false,
        verification_after_ok: null,
      },
      verification_before,
      verification_after: null,
    }
  }

  if (patches.length === 0) {
    return {
      apply: {
        schema: 'optimize_apply_result_v0',
        applied: [],
        skipped,
        rolled_back: false,
        verification_before_ok: true,
        verification_after_ok: null,
      },
      verification_before,
      verification_after: null,
    }
  }

  const bakDir = backupRoot(projectDir)
  mkdirSync(bakDir, { recursive: true })
  const backups: Array<{ abs: string; bak: string }> = []

  try {
    // One file may appear in multiple patches — last write wins by path.
    const byPath = new Map<string, VerifiedPatchWrite>()
    for (const p of patches) {
      byPath.set(p.path, p)
    }

    for (const p of byPath.values()) {
      const rel = p.path
      const abs = join(projectDir, rel)
      const bak = join(bakDir, rel.replace(/[\\/]/g, '__'))
      const prev = readFileSync(abs, 'utf8')
      writeWithDirs(bak, prev)
      backups.push({ abs, bak })
      writeFileSync(abs, p.new_content, 'utf8')
      applied.push({
        proposal_id: p.proposal_id,
        path: rel,
        rule_id: p.rule_id,
      })
    }

    const verification_after = verifier.verify(projectDir, {
      paths: touched,
      skipTest: opts?.skipTest,
      skipBuild: opts?.skipBuild ?? true,
    })

    if (!verification_after.ok) {
      for (const { abs, bak } of backups) {
        renameSync(bak, abs)
      }
      try {
        rmSync(bakDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
      return {
        apply: {
          schema: 'optimize_apply_result_v0',
          applied: [],
          skipped: [
            ...skipped,
            ...applied.map((a) => ({
              proposal_id: a.proposal_id,
              reason: 'rolled back: verification_after failed',
            })),
          ],
          rolled_back: true,
          verification_before_ok: true,
          verification_after_ok: false,
        },
        verification_before,
        verification_after,
      }
    }

    try {
      rmSync(bakDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }

    return {
      apply: {
        schema: 'optimize_apply_result_v0',
        applied,
        skipped,
        rolled_back: false,
        verification_before_ok: true,
        verification_after_ok: true,
      },
      verification_before,
      verification_after,
    }
  } catch (err) {
    for (const { abs, bak } of backups) {
      try {
        renameSync(bak, abs)
      } catch {
        /* ignore */
      }
    }
    throw err
  }
}

export function applySafeProposals(
  projectDir: string,
  proposals: OptimizeProposalV0[],
  opts?: { skipTest?: boolean; skipBuild?: boolean },
): {
  apply: OptimizeApplyResultV0
  verification_before: VerificationResultV0
  verification_after: VerificationResultV0 | null
} {
  const safe = proposals.filter((p) => p.auto_apply_safe && p.patch)
  const preSkipped: OptimizeApplyResultV0['skipped'] = []
  for (const p of proposals) {
    if (!p.auto_apply_safe || !p.patch) {
      preSkipped.push({
        proposal_id: p.proposal_id,
        reason: 'not auto_apply_safe (guidance-only)',
      })
    }
  }
  return applyVerifiedPatches(
    projectDir,
    safe.map((p) => ({
      proposal_id: p.proposal_id,
      path: p.patch!.path,
      new_content: p.patch!.new_content,
      rule_id: p.patch!.rule_id,
    })),
    { ...opts, preSkipped },
  )
}
