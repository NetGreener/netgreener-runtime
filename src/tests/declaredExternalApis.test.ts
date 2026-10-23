import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { buildResourceAnalyzeResultFromPaths } from '../analyze/buildResourceFindings.js'
import {
  collectDeclaredExternalApis,
  dependencyMapFromPackageJson,
  extractImportPackageRoots,
} from '../analyze/declaredExternalApis.js'

test('extractImportPackageRoots finds openai / anthropic / stripe', () => {
  const source = `
    import OpenAI from 'openai'
    import Anthropic from '@anthropic-ai/sdk'
    const stripe = require('stripe')
    await import('@sendgrid/mail')
  `
  const roots = new Set(extractImportPackageRoots(source))
  assert.ok(roots.has('openai'))
  assert.ok(roots.has('@anthropic-ai/sdk'))
  assert.ok(roots.has('stripe'))
  assert.ok(roots.has('@sendgrid/mail'))
})

test('collectDeclaredExternalApis from imports maps provider keys', () => {
  const declared = collectDeclaredExternalApis({
    sources: {
      'services/llm.ts': `import OpenAI from 'openai'\n`,
      'billing/checkout.ts': `import Stripe from 'stripe'\n`,
    },
  })
  const keys = new Set(declared.map((r) => r.provider_key))
  assert.deepEqual(keys, new Set(['openai', 'stripe']))
  const openai = declared.find((r) => r.provider_key === 'openai')!
  assert.ok(openai.file_paths.includes('services/llm.ts'))
  assert.equal(openai.detection_method, 'static_import')
})

test('collectDeclaredExternalApis empty when no paid packages', () => {
  const declared = collectDeclaredExternalApis({
    sources: { 'app.ts': `import express from 'express'\n` },
  })
  assert.deepEqual(declared, [])
})

test('collectDeclaredExternalApis deduplicates providers across files', () => {
  const declared = collectDeclaredExternalApis({
    sources: {
      'a.ts': `import OpenAI from 'openai'\n`,
      'b.ts': `const OpenAI = require('openai')\n`,
    },
  })
  assert.equal(declared.length, 1)
  assert.deepEqual(new Set(declared[0]!.file_paths), new Set(['a.ts', 'b.ts']))
})

test('collectDeclaredExternalApis from package.json dependencies', () => {
  const declared = collectDeclaredExternalApis({
    packageDependencies: {
      openai: '^4.0.0',
      express: '^4.0.0',
      '@anthropic-ai/sdk': '^0.20.0',
    },
  })
  const keys = new Set(declared.map((r) => r.provider_key))
  assert.deepEqual(keys, new Set(['openai', 'anthropic']))
  assert.equal(declared.find((r) => r.provider_key === 'openai')!.detection_method, 'package_json')
})

test('dependencyMapFromPackageJson merges dep blocks', () => {
  const map = dependencyMapFromPackageJson({
    dependencies: { openai: '1' },
    peerDependencies: { stripe: '2' },
    optionalDependencies: { lodash: '3' },
    devDependencies: { vitest: '4' },
  })
  assert.ok(map)
  assert.equal(map!.openai, '1')
  assert.equal(map!.stripe, '2')
  assert.equal(map!.lodash, '3')
  assert.equal(map!.vitest, undefined)
})

test('buildResourceAnalyzeResultFromPaths includes declared_external_apis', () => {
  const root = mkdtempSync(join(tmpdir(), 'ng-declared-'))
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'tmp',
      dependencies: { openai: '^4.0.0', express: '^4.18.0' },
    }),
  )
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'client.ts'), `import Stripe from 'stripe'\n`)

  const result = buildResourceAnalyzeResultFromPaths(root, ['src/client.ts'], {
    projectId: 'local',
  })
  assert.ok(Array.isArray(result.declared_external_apis))
  const keys = new Set(result.declared_external_apis.map((r) => r.provider_key))
  assert.ok(keys.has('openai'), 'package.json openai')
  assert.ok(keys.has('stripe'), 'import stripe')
  assert.equal(result.stats.declared_external_apis, result.declared_external_apis.length)
})
