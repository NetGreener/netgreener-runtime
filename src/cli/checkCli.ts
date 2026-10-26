/** External usage budgets share the API evaluator with Python. */
import { loadRuntimeConfig } from '../config.js'
import { NetGreenerClient, type ExternalApiGateBudgets } from '../sdk/client.js'

export function formatCheckHelp(): string {
  return `Usage: netgreener check --run-id <id> [options]

Check an uploaded run's observed token/API usage and estimated costs.
Options:
  --max-total-tokens <n>          Input + output token cap
  --max-input-tokens <n>          Input token cap
  --max-output-tokens <n>         Output token cap
  --max-external-api-calls <n>    Observed outbound call cap
  --max-external-cost-usd <n>     Estimated USD cap (configured server pricing)
  --external-provider <key>       Scope to provider or provider::model
  --project-id <id>               Verify the run belongs to this project
  --run-id <id>                   Run ID (or NETGREENER_LAST_RUN_ID)
  --output-json                  Print structured evaluation
  --warn-only                    Report failures but exit 0
  -h, --help                     Show help

Missing telemetry, incomplete required token coverage, or missing pricing fails.
Empty telemetry does not prove zero usage. OCR pricing is per call, not page.
Exit: 0 pass, 1 budget/data failure, 2 configuration/auth/API failure.
Python resource/baseline flags are not part of this Node command.
`
}

export async function runCheckCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<number> {
  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write(formatCheckHelp())
      return 0
    }
    const budgets: ExternalApiGateBudgets = {}
    const countFlags = new Map<string, keyof ExternalApiGateBudgets>([
      ['--max-total-tokens', 'max_total_tokens'],
      ['--max-input-tokens', 'max_input_tokens'],
      ['--max-output-tokens', 'max_output_tokens'],
      ['--max-external-api-calls', 'max_external_api_calls'],
    ])
    let runId = Number(env.NETGREENER_LAST_RUN_ID || 0)
    let projectId = Number(env.NETGREENER_PROJECT_ID || 0)
    let outputJson = false
    let warnOnly = false
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i]!
      if (flag === '--output-json') { outputJson = true; continue }
      if (flag === '--warn-only') { warnOnly = true; continue }
      if (!countFlags.has(flag) && !['--max-external-cost-usd', '--external-provider', '--run-id', '--project-id'].includes(flag)) {
        throw new Error(`Unknown option: ${flag}`)
      }
      const raw = argv[++i]
      if (raw === undefined || !raw.trim()) throw new Error(`Missing value for ${flag}`)
      if (flag === '--external-provider') { budgets.external_provider = raw; continue }
      const value = Number(raw)
      if (!Number.isFinite(value) || value < 0 || (flag !== '--max-external-cost-usd' && !Number.isSafeInteger(value))) {
        throw new Error(`Invalid nonnegative value for ${flag}`)
      }
      if (flag === '--run-id') runId = value
      else if (flag === '--project-id') projectId = value
      else if (flag === '--max-external-cost-usd') budgets.max_external_cost_usd = value
      else Object.assign(budgets, { [countFlags.get(flag)!]: value })
    }
    if (!Object.keys(budgets).some(key => key.startsWith('max_'))) throw new Error('Set at least one external usage cap')
    if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('Specify --run-id or NETGREENER_LAST_RUN_ID')
    if (!Number.isSafeInteger(projectId) || projectId < 0) throw new Error('Invalid project ID')
    const config = loadRuntimeConfig(env)
    if (!config.token) throw new Error('NETGREENER_TOKEN missing')
    const client = new NetGreenerClient({
      baseUrl: `${config.apiUrl}/api/v1`, token: config.token,
      orgId: config.organizationId ?? undefined, fetchImpl,
    })
    if (config.organizationSlug) await client.resolveOrgSlug(config.organizationSlug)
    const result = await client.evaluateExternalApiGate(runId, budgets)
    if (result.run_id !== runId || (projectId > 0 && result.project_id !== projectId)) {
      throw new Error('Gate response does not match the requested run/project')
    }
    if (!Array.isArray(result.checks) || !result.checks.length || result.checks.some(c => !c || typeof c.passed !== 'boolean' || (c.passed && (typeof c.actual !== 'number' || !Number.isFinite(c.actual))))) {
      throw new Error('Invalid external gate response')
    }
    if (Object.keys(budgets).filter(key => key.startsWith('max_')).some(key => !result.checks.some(c => c.name === key))) {
      throw new Error('External gate response is missing requested checks')
    }
    const passed = result.checks.every(c => c.passed)
    if (!passed && warnOnly) result.warnings = [...(result.warnings || []), 'Gate would have failed (--warn-only)']
    const exitCode = passed || warnOnly ? 0 : 1
    if (outputJson) {
      process.stdout.write(JSON.stringify({ ...result, passed: passed || warnOnly, exit_code: exitCode }) + '\n')
    } else {
      for (const c of result.checks) process.stdout.write(`${c.passed ? 'PASS' : 'FAIL'} ${c.name}: ${c.actual ?? 'unknown'} / ${c.limit} ${c.detail}\n`)
      for (const warning of result.warnings || []) process.stdout.write(`Warning: ${warning}\n`)
    }
    return exitCode
  } catch (error) {
    process.stderr.write(`External gate error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
}
