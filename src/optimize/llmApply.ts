/**
 * Build VerificationProvider-gated writes from an LLM optimize session.
 *
 * Owner OK 2026-10-02 (LLM) + apply-verified OK (chat).
 * Does NOT mark patches auto_apply_safe. Does not invent savings.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { VerifiedPatchWrite } from './apply.js'
import type { LlmOptimizeSessionItem, LlmOptimizeSessionV0 } from './llmSession.js'

export function spliceSnippetIntoFile(
  fullText: string,
  lineStart: number,
  lineEnd: number,
  newSnippet: string,
): string {
  const lines = fullText.split(/\r?\n/)
  const start = Math.max(1, Math.floor(lineStart))
  const end = Math.max(start, Math.floor(lineEnd))
  const before = lines.slice(0, start - 1)
  const after = lines.slice(end)
  const mid = newSnippet.replace(/\r\n/g, '\n').split('\n')
  // Preserve trailing newline style of original when file ended with \n.
  const joined = [...before, ...mid, ...after].join('\n')
  if (fullText.endsWith('\n') && !joined.endsWith('\n')) return `${joined}\n`
  return joined
}

export function llmItemEligibleForVerifiedApply(
  item: LlmOptimizeSessionItem,
): { ok: true } | { ok: false; reason: string } {
  if (!item.ok || !item.result) {
    return { ok: false, reason: item.error || 'llm call failed' }
  }
  const r = item.result
  if (r.no_change_needed) {
    return { ok: false, reason: 'no_change_needed' }
  }
  if (r.review_passed === false) {
    return { ok: false, reason: 'review_passed=false' }
  }
  if (r.apply_recommended === false) {
    return { ok: false, reason: 'apply_recommended=false' }
  }
  if (!String(r.optimized_code || '').trim()) {
    return { ok: false, reason: 'empty optimized_code' }
  }
  if (!item.line_start || !item.line_end) {
    return { ok: false, reason: 'missing snippet line range' }
  }
  return { ok: true }
}

export function buildVerifiedPatchesFromLlmSession(
  projectDir: string,
  session: LlmOptimizeSessionV0,
): {
  patches: VerifiedPatchWrite[]
  skipped: Array<{ proposal_id: string; reason: string }>
} {
  const patches: VerifiedPatchWrite[] = []
  const skipped: Array<{ proposal_id: string; reason: string }> = []
  // Last eligible write wins per path.
  const byPath = new Map<string, VerifiedPatchWrite>()

  for (const item of session.items) {
    const proposalId = `llm:${item.finding_id}`
    const gate = llmItemEligibleForVerifiedApply(item)
    if (!gate.ok) {
      skipped.push({ proposal_id: proposalId, reason: gate.reason })
      continue
    }
    const rel = item.file_path.replace(/\\/g, '/')
    let full: string
    try {
      full = readFileSync(join(projectDir, rel), 'utf8')
    } catch {
      skipped.push({ proposal_id: proposalId, reason: 'file unreadable' })
      continue
    }
    const newContent = spliceSnippetIntoFile(
      full,
      item.line_start!,
      item.line_end!,
      item.result!.optimized_code,
    )
    if (newContent === full) {
      skipped.push({ proposal_id: proposalId, reason: 'splice produced no change' })
      continue
    }
    byPath.set(rel, {
      proposal_id: proposalId,
      path: rel,
      new_content: newContent,
      rule_id: 'llm_optimize_function',
    })
  }

  for (const p of byPath.values()) patches.push(p)
  return { patches, skipped }
}
