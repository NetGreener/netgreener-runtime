import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { trySafePatchRulesOnSource } from '../optimize/safePatches.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures')

test('promise_all_fetch_map_to_sequential on fanOutClient', () => {
  const src = readFileSync(resolve(fixtures, 'analyze-sample/fanOutClient.ts'), 'utf8')
  const hit = trySafePatchRulesOnSource(
    src,
    'fanOutClient.ts',
    'unbounded_parallelism',
  )
  assert.ok(hit)
  assert.equal(hit!.patch.rule_id, 'promise_all_fetch_map_to_sequential')
  assert.match(hit!.patch.new_content, /__ng_out/)
  assert.doesNotMatch(hit!.patch.new_content, /Promise\.all\(\s*urls\.map/)
})

test('hoist_regexp_out_of_loop on cpuHotPaths', () => {
  const src = readFileSync(resolve(fixtures, 'analyze-sample/cpuHotPaths.ts'), 'utf8')
  const hit = trySafePatchRulesOnSource(src, 'cpuHotPaths.ts', 'repeated_work')
  assert.ok(hit)
  assert.equal(hit!.patch.rule_id, 'hoist_regexp_out_of_loop')
  assert.match(hit!.patch.new_content, /const re = new RegExp\(needle, 'i'\)\s*\n\s*for/)
})

test('retry_fetch_add_backoff on retryClient', () => {
  const src = readFileSync(resolve(fixtures, 'analyze-sample/retryClient.ts'), 'utf8')
  const hit = trySafePatchRulesOnSource(src, 'retryClient.ts', 'retry_amplification')
  assert.ok(hit)
  assert.equal(hit!.patch.rule_id, 'retry_fetch_add_backoff')
  assert.match(hit!.patch.new_content, /setTimeout/)
  assert.match(hit!.patch.new_content, /attempt > 0/)
})

test('nested_array_find_to_set on nestedLookup', () => {
  const src = readFileSync(resolve(fixtures, 'analyze-sample/nestedLookup.ts'), 'utf8')
  const hit = trySafePatchRulesOnSource(
    src,
    'nestedLookup.ts',
    'per_item_instead_of_batch',
  )
  assert.ok(hit)
  assert.equal(hit!.patch.rule_id, 'nested_array_find_to_set')
  assert.match(hit!.patch.new_content, /__ng_right_ids/)
  assert.match(hit!.patch.new_content, /\.has\(a\.id\)/)
  assert.doesNotMatch(hit!.patch.new_content, /right\.find\(/)
})

test('cache_readfilesync_in_loop on memoryIoHotPaths', () => {
  const src = readFileSync(
    resolve(fixtures, 'analyze-sample/memoryIoHotPaths.ts'),
    'utf8',
  )
  const hit = trySafePatchRulesOnSource(src, 'memoryIoHotPaths.ts', 'repeated_work')
  assert.ok(hit)
  assert.equal(hit!.patch.rule_id, 'cache_readfilesync_in_loop')
  assert.match(hit!.patch.new_content, /__ng_read_cache/)
  assert.match(hit!.patch.new_content, /__ng_read\(p\)/)
})

test('async map fetch variant is handled', () => {
  const src = `
export async function fetchAll(urls: string[]) {
  return Promise.all(urls.map(async (url) => fetch(url)))
}
`
  const hit = trySafePatchRulesOnSource(src, 'x.ts', 'unbounded_parallelism')
  assert.ok(hit)
  assert.match(hit!.patch.new_content, /for \(const url of urls\)/)
})

test('busy poll only when async enclosing function', () => {
  const syncSrc = `
export function pollUntilReady(check: () => boolean): void {
  while (!check()) {
    setTimeout(() => {}, 50)
  }
}
`
  assert.equal(
    trySafePatchRulesOnSource(syncSrc, 'x.ts', 'polling_or_idle_work'),
    null,
  )

  const asyncSrc = `
export async function pollUntilReady(check: () => boolean): Promise<void> {
  while (!check()) {
    setTimeout(() => {}, 50)
  }
}
`
  const hit = trySafePatchRulesOnSource(
    asyncSrc,
    'x.ts',
    'polling_or_idle_work',
  )
  assert.ok(hit)
  assert.equal(hit!.patch.rule_id, 'busy_poll_settimeout_to_await_sleep')
  assert.match(hit!.patch.new_content, /await new Promise/)
})
