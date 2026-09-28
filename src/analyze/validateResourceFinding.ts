/**
 * Validate Analyze candidates against vendored ``resource_finding_v1`` JSON Schema.
 * Mirrors observation-v1 Ajv usage; does not upload or change RunSession.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import type { ResourceFindingCandidateV1 } from './resourceFindingCandidate.js'

const require = createRequire(import.meta.url)

export type ResourceFindingValidationError = {
  instancePath: string
  message: string
}

export type ResourceFindingValidation = {
  ok: boolean
  errors: ResourceFindingValidationError[]
}

type AjvValidateFn = ((document: unknown) => boolean) & {
  errors?: Array<{ instancePath?: string; message?: string | null }> | null
}

let shapeValidator: AjvValidateFn | null = null

function getValidator(): AjvValidateFn {
  if (!shapeValidator) {
    const Ajv2020 = require('ajv/dist/2020.js').default
    const addFormats = require('ajv-formats').default
    const schema = JSON.parse(
      readFileSync(new URL('./schemas/resource-finding.schema.json', import.meta.url), 'utf8'),
    )
    const ajv = new Ajv2020({
      strict: false,
      strictNumbers: true,
      allErrors: true,
      ownProperties: true,
    })
    addFormats(ajv, ['date-time'])
    shapeValidator = ajv.compile(schema) as AjvValidateFn
  }
  return shapeValidator
}

/** Shape-check a single ``resource_finding_v1`` document. */
export function validateResourceFindingCandidate(
  document: unknown,
): ResourceFindingValidation {
  const validate = getValidator()
  const ok = Boolean(validate(document))
  const errors = (validate.errors || []).map((e) => ({
    instancePath: e.instancePath || '',
    message: e.message || 'invalid',
  }))
  return { ok, errors }
}

/** Keep only schema-valid candidates (fail-closed for malformed emitter output). */
export function filterValidResourceFindings(
  findings: ResourceFindingCandidateV1[],
): ResourceFindingCandidateV1[] {
  return findings.filter((f) => validateResourceFindingCandidate(f).ok)
}

/** True when every finding validates. */
export function allResourceFindingsValid(
  findings: Iterable<ResourceFindingCandidateV1>,
): boolean {
  for (const f of findings) {
    if (!validateResourceFindingCandidate(f).ok) return false
  }
  return true
}
