/**
 * Optional TypeScript compiler API loader for Analyze AST detectors.
 * Missing ``typescript`` → callers fall back to heuristics (no hard dep).
 */

import { createRequire } from 'node:module'

export type TypescriptApi = typeof import('typescript')

let cached: TypescriptApi | null | undefined

/** Return typescript module or null when unavailable. */
export function tryLoadTypescript(): TypescriptApi | null {
  if (cached !== undefined) return cached
  try {
    const require = createRequire(import.meta.url)
    cached = require('typescript') as TypescriptApi
    return cached
  } catch {
    cached = null
    return null
  }
}

export function isTypescriptAnalyzeAvailable(): boolean {
  return tryLoadTypescript() !== null
}
