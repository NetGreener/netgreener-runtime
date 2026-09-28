/**
 * Shared CLI help / version copy for the Node ``netgreener`` scaffold.
 * Upload remains off; run/optimize stay stubs.
 */

export const CLI_VERSION = '0.1.0'

export function formatRootHelp(): string {
  return `NetGreener Node CLI ${CLI_VERSION} (scaffold)

Usage:
  netgreener <command> [options]
  netgreener help [command]

Commands:
  analyze <projectDir>   Local resource Analyze (manifest + resource_finding_v1)
  run                    (stub) Not implemented — will not upload
  optimize               (stub) Not implemented — will not upload
  help [command]         Show this help or a command's help
  version                Show version

Global:
  -h, --help             Show this help
  -V, --version          Show version

Examples:
  netgreener analyze ./my-app
  netgreener analyze ./my-app --json-summary
  netgreener analyze ./my-app --fail-on any --max-at-or-above 0
  netgreener analyze ./my-app --paths src/hot.ts,src/retry.ts --findings-only
  netgreener-analyze ./my-app          # alias bin (same Analyze path)

Notes:
  • Analyze prints local candidates only (upload=never).
  • optimize / run are stubs (exit 2) — see OPTIMIZE_STUB.md; no upload / no patches.
  • Does not modify RunSession / metering pipelines.
  • VS Code: Node-first folders use this local Analyze path (same guarantee).

Analyze options:  netgreener help analyze
  Optimize stub:    netgreener help optimize
`
}

export function formatAnalyzeHelp(): string {
  return `Usage: netgreener analyze <projectDir> [options]
   (alias) netgreener-analyze <projectDir> [options]

Print NetGreener Analyze scaffold output:
  service_manifest_v0 + resource_finding_v1 candidates (JSON on stdout).

Does not upload and does not modify RunSession / metering pipelines.

Options:
  --project-id <id>              Stamp project_id on candidates (default: local)
  --paths a,b                    Explicit repo-relative source paths (comma-separated)
  --findings-only                Emit findings JSON array only
  --manifest-only                Emit service_manifest_v0 JSON only
  --json-summary                 Emit netgreener_analyze_gate_summary_v0 only (CI)
  --fail-on any|<mechanism>[,…]  Fail (exit 1) when matching candidates exceed cap
  --max-at-or-above <n>          With --fail-on: allow up to N matches (default 0)
  --quiet                        No stderr status lines
  -h, --help                     Show this help

Examples:
  netgreener analyze ./fixtures/analyze-sample
  netgreener analyze ./app --project-id 42 --quiet
  netgreener analyze ./app --json-summary
  netgreener analyze ./app --fail-on retry_amplification,external_api_overconsumption
  netgreener analyze ./app --fail-on any --max-at-or-above 5
  netgreener analyze ./app --paths src/server.ts --findings-only
  netgreener-analyze ./app --manifest-only

CI tip: pair --json-summary with --fail-on for gate annotations without upload.
`
}

export function formatStubHelp(command: 'run' | 'optimize'): string {
  if (command === 'optimize') {
    return `netgreener optimize: not implemented yet in the Node CLI scaffold.

This is an intentional stub (MP4 / N5), not a silent no-op:
  • exit code 2 when invoked as a command
  • no upload, no LLM call, no patch apply, no tree writes
  • no api_server /optimize/* wiring

Until a real JS/TS OptimizerProvider + VerificationProvider land behind the
shared MP4 interfaces, use local Analyze only:

  netgreener analyze <projectDir>
  netgreener analyze <projectDir> --fail-on any --json-summary
  netgreener help analyze

Boundary doc: OPTIMIZE_STUB.md (in the @netgreener/runtime package root).
`
  }
  return `netgreener ${command}: not implemented yet in the Node CLI scaffold.

No upload is performed. Use local Analyze instead:

  netgreener analyze <projectDir>
  netgreener help analyze
`
}
