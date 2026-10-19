import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildServiceManifest,
  detectFrameworks,
  extractServiceUnits,
  isServiceProject,
} from '../analyze/serviceDiscovery.js'

test('detects express / fastify / nest / bullmq imports', () => {
  assert.deepEqual(detectFrameworks(`import express from 'express'`), ['express'])
  assert.deepEqual(detectFrameworks(`const fastify = require('fastify')`), ['fastify'])
  assert.ok(detectFrameworks(`import { Controller, Get } from '@nestjs/common'`).includes('nest'))
  assert.ok(detectFrameworks(`import { Worker, Queue } from 'bullmq'`).includes('bullmq'))
})

test('extracts Express route templates as service_unit endpoints', () => {
  const source = `
import express from 'express'
const app = express()
app.get('/health', (req, res) => res.send('ok'))
app.post('/v1/documents/:id', async (req, res) => {})
`
  const extracted = extractServiceUnits(source, 'src/app.ts')
  assert.ok(extracted.frameworks.includes('express'))
  const units = extracted.endpoints.map((e) => e.service_unit).sort()
  assert.deepEqual(units, ['GET /health', 'POST /v1/documents/:id'])
  assert.equal(extracted.endpoints.find((e) => e.path.includes(':id'))?.dynamic, true)
  assert.equal(extracted.endpoints[0]?.evidence, 'heuristic_source')
})

test('extracts Nest decorator routes', () => {
  const source = `
import { Controller, Get, Post } from '@nestjs/common'
@Controller('api')
export class DocsController {
  @Get('health')
  health() {}
  @Post()
  create() {}
}
`
  const extracted = extractServiceUnits(source, 'docs.controller.ts')
  assert.ok(extracted.frameworks.includes('nest'))
  const units = extracted.endpoints.map((e) => e.service_unit).sort()
  assert.ok(units.includes('GET /health'))
  assert.ok(units.includes('POST /'))
})

test('extracts BullMQ queue.add job names as tasks', () => {
  const source = `
import { Queue } from 'bullmq'
const queue = new Queue('ocr')
await queue.add('analyze_document', { organization_id: 'org_acme' })
`
  const extracted = extractServiceUnits(source, 'worker.ts')
  assert.ok(extracted.frameworks.includes('bullmq'))
  assert.equal(extracted.tasks.length, 1)
  assert.equal(extracted.tasks[0]?.service_unit, 'task:analyze_document')
})

test('buildServiceManifest shapes empty and populated projects', () => {
  const empty = buildServiceManifest({})
  assert.equal(empty.schema, 'service_manifest_v0')
  assert.equal(empty.contract_status, 'mp4_scaffold')
  assert.equal(isServiceProject(empty), false)

  const manifest = buildServiceManifest({
    'src/server.ts': `
import express from 'express'
const app = express()
app.get('/ready', () => {})
`,
    'src/jobs.ts': `
import { Queue } from 'bullmq'
await new Queue('q').add('nightly_report', {})
`,
  })
  assert.equal(isServiceProject(manifest), true)
  assert.ok(manifest.frameworks_detected.includes('express'))
  assert.ok(manifest.frameworks_detected.includes('bullmq'))
  assert.ok(manifest.endpoints.some((e) => e.service_unit === 'GET /ready'))
  assert.ok(manifest.tasks.some((t) => t.service_unit === 'task:nightly_report'))
  assert.ok(manifest.notes.some((n) => /scaffold/i.test(n)))
})
