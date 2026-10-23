import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { buildResourceAnalyzeResultFromPaths } from '../analyze/buildResourceFindings.js'
import { runNetgreenerCli } from '../cli/netgreener.js'
import {
  CLI_VERSION,
  formatAnalyzeHelp,
  formatRootHelp,
  formatStubHelp,
} from '../cli/helpText.js'
import { applySafeProposals } from '../optimize/apply.js'
import { formatOptimizeHelp, parseOptimizeArgs, runOptimizeCli } from '../optimize/cli.js'
import { createLocalJsTsOptimizerProvider } from '../optimize/provider.js'
import { tryBuildSafePatch } from '../optimize/safePatches.js'
import { createLocalJsTsVerificationProvider } from '../optimize/verification.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures')

test('root help includes optimize command', () => {
  const text = formatRootHelp()
  assert.match(text, /optimize <projectDir>/)
  assert.match(text, new RegExp(CLI_VERSION.replace(/\./g, '\\.')))
})

test('analyze help includes CI gate examples', () => {
  const text = formatAnalyzeHelp()
  assert.match(text, /--json-summary/)
  assert.match(text, /--fail-on/)
})

test('runNetgreenerCli help analyze exits 0', () => {
  const writes: string[] = []
  const orig = process.stdout.write.bind(process.stdout)
  ;(process.stdout as { write: typeof process.stdout.write }).write = ((
    chunk: string | Uint8Array,
  ) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  try {
    assert.equal(runNetgreenerCli(['help', 'analyze']), 0)
  } finally {
    process.stdout.write = orig
  }
  assert.match(writes.join(''), /--fail-on/)
})

test('optimize help documents VerificationProvider and --apply', () => {
  const text = formatOptimizeHelp()
  assert.match(text, /OPTIMIZE_STUB\.md/)
  assert.match(text, /VerificationProvider/)
  assert.match(text, /--apply/)
  assert.match(text, /auto_apply_safe/)
})

test('optimize stub help keeps upload/savings boundary', () => {
  const text = formatStubHelp('optimize')
  assert.match(text, /OPTIMIZE_STUB\.md/)
  assert.match(text, /no upload/i)
  assert.match(text, /apply-verified/)
})

test('parseOptimizeArgs reads apply and verify flags', () => {
  const flags = parseOptimizeArgs(['./app', '--apply', '--verify', '--skip-test'])
  assert.equal(flags.apply, true)
  assert.equal(flags.verifyOnly, true)
  assert.equal(flags.skipTest, true)
})

test('safe patch matches Promise.all(fetch map)', () => {
  const sample = resolve(fixtures, 'analyze-sample')
  const analyze = buildResourceAnalyzeResultFromPaths(sample, ['fanOutClient.ts'], {
    projectId: 'test',
  })
  const fan = analyze.findings.find(
    (f) =>
      f.mechanism_id === 'unbounded_parallelism' ||
      f.mechanism_id === 'external_api_overconsumption',
  )
  assert.ok(fan, 'expected fan-out finding')
  const hit = tryBuildSafePatch(fan!, sample)
  assert.ok(hit, 'expected safe patch')
  assert.equal(hit!.patch.rule_id, 'promise_all_fetch_map_to_sequential')
  assert.match(hit!.patch.new_content, /__ng_out/)
  assert.doesNotMatch(hit!.patch.new_content, /Promise\.all\(\s*urls\.map/)
})

test('optimizer marks matching proposals auto_apply_safe', () => {
  const sample = resolve(fixtures, 'analyze-sample')
  const analyze = buildResourceAnalyzeResultFromPaths(sample, null, {
    projectId: 'test',
  })
  const result = createLocalJsTsOptimizerProvider().proposeFromFindings(
    analyze.findings,
    { projectId: 'test', projectDir: sample },
  )
  assert.ok(result.stats.auto_apply_safe >= 1)
  assert.ok(result.proposals.some((p) => p.auto_apply_safe && p.patch))
})

test('VerificationProvider returns ok when no failing gates', () => {
  const sample = resolve(fixtures, 'analyze-sample')
  const v = createLocalJsTsVerificationProvider().verify(sample, {
    skipTest: true,
    skipBuild: true,
  })
  assert.equal(v.schema, 'verification_result_v0')
  assert.equal(v.ok, true)
})

test('applySafeProposals writes and can leave file changed', () => {
  const sample = resolve(fixtures, 'analyze-sample')
  const tmp = mkdtempSync(join(tmpdir(), 'ng-opt-'))
  try {
    cpSync(sample, tmp, { recursive: true })
    writeFileSync(
      join(tmp, 'package.json'),
      JSON.stringify({ name: 'tmp-opt', private: true }, null, 2),
    )
    const analyze = buildResourceAnalyzeResultFromPaths(tmp, ['fanOutClient.ts'], {
      projectId: 'tmp',
    })
    const result = createLocalJsTsOptimizerProvider().proposeFromFindings(
      analyze.findings,
      { projectId: 'tmp', projectDir: tmp },
    )
    const before = readFileSync(join(tmp, 'fanOutClient.ts'), 'utf8')
    assert.match(before, /Promise\.all/)
    const { apply, verification_before } = applySafeProposals(tmp, result.proposals, {
      skipTest: true,
      skipBuild: true,
    })
    assert.equal(verification_before.ok, true)
    assert.ok(apply.applied.length >= 1)
    assert.equal(apply.rolled_back, false)
    const after = readFileSync(join(tmp, 'fanOutClient.ts'), 'utf8')
    assert.match(after, /__ng_out/)
    assert.doesNotMatch(after, /Promise\.all\(\s*urls\.map/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('runOptimizeCli --verify exits 0 on analyze-sample', () => {
  const sample = resolve(fixtures, 'analyze-sample')
  const out: string[] = []
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  ;(process.stdout as { write: typeof process.stdout.write }).write = ((
    chunk: string | Uint8Array,
  ) => {
    out.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  ;(process.stderr as { write: typeof process.stderr.write }).write = (() =>
    true) as typeof process.stderr.write
  try {
    assert.equal(runOptimizeCli([sample, '--verify', '--quiet']), 0)
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
  const parsed = JSON.parse(out.join(''))
  assert.equal(parsed.schema, 'verification_result_v0')
  assert.equal(parsed.ok, true)
})
