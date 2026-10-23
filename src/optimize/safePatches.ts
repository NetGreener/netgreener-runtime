/**
 * Deterministic safe patch rules for Node Optimize.
 *
 * Only exact, local transforms — no LLM, no api_server /optimize/*.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import type { ResourceFindingCandidateV1 } from '../analyze/resourceFindingCandidate.js'
import type { OptimizePatchV0 } from './types.js'

export type SafePatchMatch = {
  patch: OptimizePatchV0
  reason: string
}

function patchOf(
  relPath: string,
  new_content: string,
  rule_id: string,
  summary: string,
  reason: string,
): SafePatchMatch {
  return {
    patch: {
      schema: 'optimize_patch_v0',
      path: relPath,
      new_content,
      rule_id,
      summary,
    },
    reason,
  }
}

/**
 * Promise.all(arr.map(x => fetch(x))) and async variants → sequential awaits.
 * Also matches leading ``return`` / ``await``.
 */
function tryPromiseAllFetchMap(
  source: string,
  relPath: string,
): SafePatchMatch | null {
  const re =
    /(return\s+|await\s+)?Promise\.all\(\s*(\w+)\.map\(\s*(?:async\s*)?\(\s*(\w+)\s*\)\s*=>\s*fetch\(\s*\3\s*\)\s*\)\s*\)/
  const m = source.match(re)
  if (!m) return null
  const prefix = (m[1] || '').trim()
  const arr = m[2]!
  const item = m[3]!

  let replacement: string
  if (prefix === 'await') {
    replacement =
      `await (async () => {\n` +
      `    const __ng_out: Response[] = []\n` +
      `    for (const ${item} of ${arr}) {\n` +
      `      __ng_out.push(await fetch(${item}))\n` +
      `    }\n` +
      `    return __ng_out\n` +
      `  })()`
  } else {
    // return … or bare expression used as return body
    replacement =
      `const __ng_out: Response[] = []\n` +
      `  for (const ${item} of ${arr}) {\n` +
      `    __ng_out.push(await fetch(${item}))\n` +
      `  }\n` +
      `  return __ng_out`
  }

  const new_content = source.replace(re, replacement)
  if (new_content === source) return null
  return patchOf(
    relPath,
    new_content,
    'promise_all_fetch_map_to_sequential',
    'Replace unbounded Promise.all(fetch map) with sequential awaits (no new deps).',
    'unbounded_parallelism / external_api_overconsumption safe rewrite',
  )
}

/** Hoist ``new RegExp(...)`` out of for-of when args ignore the loop variable. */
function tryHoistRegExpInForLoop(
  source: string,
  relPath: string,
): SafePatchMatch | null {
  const re =
    /for\s*\(\s*const\s+(\w+)\s+of\s+(\w+)\s*\)\s*\{\s*\r?\n(\s*)const\s+(\w+)\s*=\s*new\s+RegExp\(([^)]+)\)\s*\r?\n/
  const m = source.match(re)
  if (!m) return null
  const loopVar = m[1]!
  const indent = m[3]!
  const reVar = m[4]!
  const reArgs = m[5]!
  if (new RegExp(`\\b${loopVar}\\b`).test(reArgs)) return null

  const forOpen = `for (const ${loopVar} of ${m[2]}) {\n`
  const new_content = source.replace(
    re,
    `${indent}const ${reVar} = new RegExp(${reArgs})\n${forOpen}`,
  )
  if (new_content === source) return null
  return patchOf(
    relPath,
    new_content,
    'hoist_regexp_out_of_loop',
    'Hoist RegExp compile out of for-loop (repeated_work).',
    'repeated_work safe rewrite',
  )
}

/**
 * Retry loop with fetch: insert capped exponential backoff before attempts > 0.
 * Only when the body does not already contain setTimeout/backoff.
 */
function tryRetryFetchAddBackoff(
  source: string,
  relPath: string,
): SafePatchMatch | null {
  if (/setTimeout|backoff|AbortSignal\.timeout/i.test(source)) return null
  const re =
    /for\s*\(\s*let\s+(\w+)\s*=\s*0\s*;\s*\1\s*<\s*(\d+)\s*;\s*\1\+\+\s*\)\s*\{\r?\n(\s*)const\s+(\w+)\s*=\s*await\s+fetch\(/
  const m = source.match(re)
  if (!m || m.index == null) return null
  const attempt = m[1]!
  const limit = m[2]!
  const indent = m[3]!
  const resVar = m[4]!

  const head = `for (let ${attempt} = 0; ${attempt} < ${limit}; ${attempt}++) {\n`
  const injected =
    head +
    `${indent}if (${attempt} > 0) {\n` +
    `${indent}  await new Promise((r) => setTimeout(r, Math.min(1000, 50 * 2 ** (${attempt} - 1))))\n` +
    `${indent}}\n` +
    `${indent}const ${resVar} = await fetch(`

  const new_content =
    source.slice(0, m.index) + injected + source.slice(m.index + m[0].length)
  if (new_content === source) return null
  return patchOf(
    relPath,
    new_content,
    'retry_fetch_add_backoff',
    'Add capped exponential backoff between fetch retries (retry_amplification).',
    'retry_amplification safe rewrite',
  )
}

/**
 * Nested ``arr.find(x => x.id === outer.id)`` → Set.has (O(n) → O(1) membership).
 */
function tryNestedFindToSet(
  source: string,
  relPath: string,
): SafePatchMatch | null {
  // for (const a of left) { ... right.find((x) => x.id === a.id)
  const findRe =
    /(\w+)\.find\(\s*\(\s*(\w+)\s*\)\s*=>\s*\2\.id\s*===\s*(\w+)\.id\s*\)/
  const m = source.match(findRe)
  if (!m) return null
  const arr = m[1]!
  const outer = m[3]!

  // Require an enclosing for-of over ``outer``.
  const forRe = new RegExp(
    `for\\s*\\(\\s*const\\s+${outer}\\s+of\\s+(\\w+)\\s*\\)`,
  )
  if (!forRe.test(source)) return null

  const setName = `__ng_${arr}_ids`
  if (source.includes(setName)) return null

  // Insert Set before the first for that uses outer, and replace find calls.
  const forMatch = source.match(forRe)
  if (!forMatch || forMatch.index == null) return null
  const insertAt = forMatch.index
  const insert =
    `const ${setName} = new Set(${arr}.map((x) => x.id))\n`
  let new_content =
    source.slice(0, insertAt) + insert + source.slice(insertAt)
  new_content = new_content.replace(
    new RegExp(
      `${arr}\\.find\\(\\s*\\(\\s*(\\w+)\\s*\\)\\s*=>\\s*\\1\\.id\\s*===\\s*${outer}\\.id\\s*\\)`,
      'g',
    ),
    `${setName}.has(${outer}.id)`,
  )
  if (new_content === source) return null
  return patchOf(
    relPath,
    new_content,
    'nested_array_find_to_set',
    'Replace nested array.find(id) with Set.has for membership checks.',
    'per_item_instead_of_batch / repeated_work safe rewrite',
  )
}

/**
 * ``JSON.parse(readFileSync(path, 'utf8'))`` stays one-shot — no change.
 * ``while (!check()) { setTimeout(() => {}, N) }`` busy-poll → await sleep (async).
 * Only rewrite when the function is already ``async``.
 */
function tryBusyPollToAwaitSleep(
  source: string,
  relPath: string,
): SafePatchMatch | null {
  if (!/\basync\s+function\b/.test(source) && !/\basync\s*\(/.test(source)) {
    // Only safe if we can await — require async in file near the while.
    // Conservative: require `export async function` or `async function` in source.
    return null
  }
  const re =
    /while\s*\(\s*!\s*(\w+)\(\)\s*\)\s*\{\s*\r?\n\s*setTimeout\(\s*\(\)\s*=>\s*\{\s*\}\s*,\s*(\d+)\s*\)\s*\r?\n\s*\}/
  const m = source.match(re)
  if (!m) return null
  // Without making the enclosing function async, await is invalid.
  // Only apply when the match sits inside an async function (heuristic: previous 200 chars).
  const idx = source.search(re)
  if (idx < 0) return null
  const window = source.slice(Math.max(0, idx - 200), idx)
  if (!/\basync\s+function\b|\basync\s*\(/.test(window)) return null

  const check = m[1]!
  const ms = m[2]!
  const replacement =
    `while (!${check}()) {\n` +
    `    await new Promise((r) => setTimeout(r, ${ms}))\n` +
    `  }`
  const new_content = source.replace(re, replacement)
  if (new_content === source) return null
  return patchOf(
    relPath,
    new_content,
    'busy_poll_settimeout_to_await_sleep',
    'Replace fire-and-forget setTimeout busy-poll with awaited sleep (polling_or_idle_work).',
    'polling_or_idle_work safe rewrite',
  )
}

/**
 * ``for (const x of xs) { out.push(await fetch(x)) }`` already sequential — no op.
 * Cap ``Promise.all(xs.map(...))`` with non-fetch body stays guidance-only.
 *
 * ``readFileSync`` in loop: cache identical path reads within the function.
 */
function tryCacheReadFileSyncInLoop(
  source: string,
  relPath: string,
): SafePatchMatch | null {
  // for (const p of paths) { ... readFileSync(p, 'utf8')
  const re =
    /for\s*\(\s*const\s+(\w+)\s+of\s+(\w+)\s*\)\s*\{([\s\S]*?)readFileSync\(\s*\1\s*,\s*['"]utf-?8['"]\s*\)/
  const m = source.match(re)
  if (!m) return null
  if (/__ng_read_cache/.test(source)) return null
  const item = m[1]!
  const arr = m[2]!

  // Insert cache + helper read before the for-loop; replace readFileSync(item, 'utf8').
  const forRe = new RegExp(
    `for\\s*\\(\\s*const\\s+${item}\\s+of\\s+${arr}\\s*\\)`,
  )
  const forMatch = source.match(forRe)
  if (!forMatch || forMatch.index == null) return null

  const insert =
    `const __ng_read_cache = new Map<string, string>()\n` +
    `  const __ng_read = (p: string) => {\n` +
    `    let v = __ng_read_cache.get(p)\n` +
    `    if (v === undefined) {\n` +
    `      v = readFileSync(p, 'utf8')\n` +
    `      __ng_read_cache.set(p, v)\n` +
    `    }\n` +
    `    return v\n` +
    `  }\n  `
  let new_content =
    source.slice(0, forMatch.index) + insert + source.slice(forMatch.index)
  new_content = new_content.replace(
    new RegExp(`readFileSync\\(\\s*${item}\\s*,\\s*['"]utf-?8['"]\\s*\\)`, 'g'),
    `__ng_read(${item})`,
  )
  if (new_content === source) return null
  return patchOf(
    relPath,
    new_content,
    'cache_readfilesync_in_loop',
    'Cache readFileSync(utf8) results across loop iterations (repeated_work / io).',
    'repeated_work / memory_retention safe rewrite',
  )
}

const MECHANISM_RULES: Record<
  string,
  Array<(source: string, rel: string) => SafePatchMatch | null>
> = {
  unbounded_parallelism: [tryPromiseAllFetchMap],
  external_api_overconsumption: [tryPromiseAllFetchMap, tryRetryFetchAddBackoff],
  repeated_work: [
    tryHoistRegExpInForLoop,
    tryNestedFindToSet,
    tryCacheReadFileSyncInLoop,
  ],
  retry_amplification: [tryRetryFetchAddBackoff],
  per_item_instead_of_batch: [tryNestedFindToSet],
  polling_or_idle_work: [tryBusyPollToAwaitSleep],
  memory_retention_or_materialization: [tryCacheReadFileSyncInLoop],
}

/** Exported for unit tests — apply rules without a finding. */
export function trySafePatchRulesOnSource(
  source: string,
  relPath: string,
  mechanismId: string,
): SafePatchMatch | null {
  const rules = MECHANISM_RULES[mechanismId] || []
  for (const rule of rules) {
    const hit = rule(source, relPath)
    if (hit) return hit
  }
  return null
}

/**
 * Attempt a deterministic safe patch for one admitted finding.
 * Returns null when no rule matches (proposal stays guidance-only).
 */
export function tryBuildSafePatch(
  finding: ResourceFindingCandidateV1,
  projectDir: string,
): SafePatchMatch | null {
  const loc = finding.scope.source_locations[0]
  if (!loc?.path) return null
  const rel = loc.path.replace(/\\/g, '/')
  if (
    /(^|\/)(node_modules|dist|build|out|\.git|vendor)(\/|$)/i.test(rel) ||
    rel.includes('..')
  ) {
    return null
  }
  const abs = join(projectDir, rel)
  if (!existsSync(abs)) return null
  let source: string
  try {
    source = readFileSync(abs, 'utf8')
  } catch {
    return null
  }

  return trySafePatchRulesOnSource(source, rel, finding.mechanism_id)
}
