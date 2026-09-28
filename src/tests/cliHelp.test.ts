import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runNetgreenerCli } from '../cli/netgreener.js'
import {
  CLI_VERSION,
  formatAnalyzeHelp,
  formatRootHelp,
  formatStubHelp,
} from '../cli/helpText.js'

test('root help includes examples and upload=never note', () => {
  const text = formatRootHelp()
  assert.match(text, /Examples:/)
  assert.match(text, /upload=never/)
  assert.match(text, /help analyze/)
  assert.match(text, new RegExp(CLI_VERSION.replace(/\./g, '\\.')))
})

test('analyze help includes CI gate examples', () => {
  const text = formatAnalyzeHelp()
  assert.match(text, /--json-summary/)
  assert.match(text, /--fail-on/)
  assert.match(text, /Examples:/)
  assert.match(text, /CI tip/)
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

test('stub help for run points at analyze', () => {
  assert.match(formatStubHelp('run'), /netgreener analyze/)
  assert.match(formatStubHelp('run'), /No upload/)
})

test('stub help for optimize documents MP4 boundary', () => {
  const text = formatStubHelp('optimize')
  assert.match(text, /OPTIMIZE_STUB\.md/)
  assert.match(text, /no upload/i)
  assert.match(text, /no LLM/i)
  assert.match(text, /OptimizerProvider/)
  assert.match(text, /netgreener analyze/)
  assert.match(text, /--json-summary/)
})
