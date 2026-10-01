/**
 * MP4 Analyze deepen demo — disk scan + resource_finding_v1 candidates.
 *
 *   npm run example:analyze-manifest
 *
 * Still not CLI/VSCE wired; candidates only (no Optimize / verified savings).
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildResourceAnalyzeResultFromPaths,
  isServiceProject,
} from '../dist/analyze/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/analyze-sample')
const result = buildResourceAnalyzeResultFromPaths(root, null, { projectId: '42' })

console.log(JSON.stringify(result, null, 2))
console.log(
  isServiceProject(result.manifest)
    ? 'ANALYZE MANIFEST PASS (service project)'
    : 'ANALYZE MANIFEST: no service units detected',
)
console.log(
  result.findings.length > 0
    ? `ANALYZE FINDINGS PASS (${result.findings.length} resource_finding_v1 candidate(s))`
    : 'ANALYZE FINDINGS: no candidates (unexpected for fixtures/analyze-sample)',
)
