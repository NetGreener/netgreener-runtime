/**
 * Shared CLI help / version copy for the Node ``netgreener`` CLI.
 */

import { existsSync, readFileSync } from 'node:fs'

// The extension bundles this module beside its own package metadata.
const bundledPackage = new URL('./package.json', import.meta.url)
const packageUrl = existsSync(bundledPackage) ? bundledPackage : new URL('../../package.json', import.meta.url)
export const CLI_VERSION: string = JSON.parse(readFileSync(packageUrl, 'utf8')).version

export function formatRootHelp(): string {
  return `NetGreener Node CLI ${CLI_VERSION}

Usage:
  netgreener <command> [options]
  netgreener help [command]

Commands:
  runtime status [--json]        Check local runtime configuration (no network)
  analyze <projectDir>           Local resource Analyze (manifest + findings)
  run <script> [projectDir]      Execute script with process metering (+ optional upload)
  check --run-id <id> [options]  Post-run token, API call, and estimated cost gates
  optimize <projectDir>          Local proposals; --llm for api_server optimize session
  optimize <projectDir> --apply  Safe local patches only (VerificationProvider)
  optimize <projectDir> --llm    Shared LLM /optimize/function (token + project-id)
  optimize … --llm --apply-verified  LLM splice + VerificationProvider (not --apply)
  help [command]                 Show this help or a command's help
  version                        Show version

Global:
  -h, --help             Show this help
  -V, --version          Show version

Examples:
  netgreener analyze ./my-app
  netgreener analyze ./my-app --json-summary --fail-on any
  netgreener run ./jobs/report.mjs . --no-upload
  netgreener optimize ./my-app
  netgreener-analyze ./my-app

Notes:
  • Analyze runs static checks + LLM review when logged in/BYOK configured; --no-llm stays offline.
  • run meters via process runtime; default EXPORT_MODE stays direct.
  • optimize emits proposals; --apply only for auto_apply_safe + VerificationProvider.
  • --llm uses shared api_server /optimize/function; --apply-verified for VP-gated writes.
  • Same api_server brain as Python — no Node server fork.

Analyze:   netgreener help analyze
  Run:       netgreener help run
  Optimize:  netgreener help optimize
`
}

export function formatAnalyzeHelp(): string {
  return `Usage: netgreener analyze [projectDir] [options]
   (alias) netgreener-analyze [projectDir] [options]

Analyze JavaScript/TypeScript with static checks and bounded LLM review:
  service_manifest_v0 + resource_finding_v1 candidates (JSON on stdout).

LLM review sends selected source files to your configured provider. Findings are not stored.
Does not modify RunSession / metering pipelines.

Options:
  --project-id <id>              Override env/repository project ID (default: local)
  --paths a,b                    Explicit repo-relative source paths (comma-separated)
  --findings-only                Emit findings JSON array only
  --manifest-only                Emit service_manifest_v0 JSON only
  --json-summary                 Emit netgreener_analyze_gate_summary_v0 only (CI)
  --fail-on any|<mechanism>[,…]  Fail (exit 1) when matching candidates exceed cap
  --max-at-or-above <n>          With --fail-on: allow up to N matches (default 0)
  --depth quick|standard|thorough  AI review depth (default standard)
  --llm                          Require LLM review (managed login or BYOK)
  --no-llm                       Static analysis only; no network calls
  --output-file <path>           Save full local report and notify the editor on completion
  --no-upload                    Accepted; findings are never uploaded
  --quiet                        No stderr progress (errors still reported)
  -h, --help                     Show this help

Examples:
  netgreener analyze ./fixtures/analyze-sample
  netgreener analyze ./app --project-id 42 --quiet
  netgreener analyze ./app --json-summary
  netgreener analyze ./app --fail-on retry_amplification,external_api_overconsumption
  netgreener analyze ./app --fail-on any --max-at-or-above 5
  netgreener analyze ./app --paths src/server.ts --findings-only
  netgreener-analyze ./app --manifest-only

Configuration:
  Project directory defaults to the current folder, like Python Analyze.
  Identity: --project-id > NETGREENER_PROJECT_ID > .netgreener/project.yaml|yml|json.
  API URL: NETGREENER_API_URL > .netgreener/config.yaml|yml|json > project .env > global config.
  Managed login or BYOK: NETGREENER_LLM_PROVIDER, MODEL, KEY, ENDPOINT.
  Providers: openai, azure_openai, anthropic, ollama, custom.
  Ollama/custom endpoints may run without a key. LLM calls time out after 30s.

CI tip: pair --json-summary with --fail-on for gate annotations without upload.
`
}

/** @deprecated Prefer formatOptimizeHelp / formatRunHelp. Kept for older tests. */
export function formatStubHelp(command: 'run' | 'optimize'): string {
  if (command === 'optimize') {
    return `netgreener optimize: local OptimizerProvider + optional --llm (see OPTIMIZE_STUB.md).

Default (local):
  • --apply only writes auto_apply_safe patches (verify before+after; rollback on fail)
  • no invented savings
  • no upload

Opt-in LLM (owner OK):
  netgreener optimize <projectDir> --llm --project-id N
  • requires NETGREENER_TOKEN
  • POST /optimize/function — prints optimize_llm_session_v0
  • --llm --apply-verified for VerificationProvider-gated LLM writes (not --apply)

  netgreener optimize <projectDir>
  netgreener optimize <projectDir> --apply --skip-test
  netgreener optimize <projectDir> --llm --apply-verified --project-id N
  netgreener analyze <projectDir> --json-summary

`
  }
  return `netgreener run: use \`netgreener help run\` for the metered script runner.

  netgreener run <script> [projectDir] [--no-upload]

`
}
