import assert from 'node:assert/strict'
import { test } from 'node:test'

import { exportModeFromEnv, resolveObservationExporter } from '../exporter.js'
import {
  detectServerlessPlatformSignals,
  flushModeRequestsThin,
} from '../serverlessHints.js'

test('FLUSH_MODE=thin aliases export mode thin when EXPORT_MODE unset', () => {
  assert.equal(exportModeFromEnv({ NETGREENER_FLUSH_MODE: 'thin' }), 'thin')
  assert.equal(
    resolveObservationExporter({ NETGREENER_FLUSH_MODE: 'thin' }).mode,
    'thin',
  )
  assert.equal(flushModeRequestsThin({ NETGREENER_FLUSH_MODE: 'thin' }), true)
})

test('explicit EXPORT_MODE=direct wins over FLUSH_MODE=thin', () => {
  assert.equal(
    exportModeFromEnv({
      NETGREENER_EXPORT_MODE: 'direct',
      NETGREENER_FLUSH_MODE: 'thin',
    }),
    'direct',
  )
})

test('explicit EXPORT_MODE=collector wins over FLUSH_MODE=thin', () => {
  assert.equal(
    exportModeFromEnv({
      NETGREENER_EXPORT_MODE: 'collector',
      NETGREENER_FLUSH_MODE: 'thin',
    }),
    'collector',
  )
})

test('default remains direct when FLUSH_MODE unset', () => {
  assert.equal(exportModeFromEnv({}), 'direct')
  assert.equal(flushModeRequestsThin({}), false)
})

test('AWS Lambda signal suggests thin without applying it', () => {
  const hint = detectServerlessPlatformSignals({
    AWS_LAMBDA_FUNCTION_NAME: 'my-fn',
  })
  assert.equal(hint.detected, true)
  assert.deepEqual(hint.signals, ['aws_lambda'])
  assert.equal(hint.suggestedExportMode, 'thin')
  assert.ok(hint.notes.some((n) => /auto-cutover is not applied/i.test(n)))
  // Detection alone must not flip export mode.
  assert.equal(
    exportModeFromEnv({ AWS_LAMBDA_FUNCTION_NAME: 'my-fn' }),
    'direct',
  )
})

test('Azure Functions and Vercel signals are detected', () => {
  assert.deepEqual(
    detectServerlessPlatformSignals({ FUNCTIONS_WORKER_RUNTIME: 'node' }).signals,
    ['azure_functions'],
  )
  assert.deepEqual(
    detectServerlessPlatformSignals({ VERCEL: '1' }).signals,
    ['vercel'],
  )
})
