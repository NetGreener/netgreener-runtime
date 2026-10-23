import { inspectRuntimeSetup } from '../runtimeHealth.js'

export function formatRuntimeHelp(): string {
  return `Usage: netgreener runtime status [--json]

Check local runtime configuration without contacting the API.
Use NETGREENER_TOKEN and NETGREENER_PROJECT_ID; NETGREENER_SERVICE_RUNTIME=0 disables monitoring.
This does not verify running hooks, tenant binding, provider coverage, authentication, or uploads.

Options:
  --json        Print a credential-free JSON report
  -h, --help    Show this help
`
}

export function runRuntimeCli(argv: string[]): number {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(formatRuntimeHelp())
    return 0
  }
  if (argv[0] !== 'status' || argv.slice(1).some(arg => arg !== '--json')) {
    process.stderr.write(formatRuntimeHelp())
    return 2
  }
  const report = inspectRuntimeSetup()
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } else {
    process.stdout.write('NetGreener runtime status (local configuration only)\n')
    for (const check of report.checks) {
      process.stdout.write(`  ${check.name}: ${check.status} — ${check.detail}\n`)
    }
    process.stdout.write(report.ready ? 'Local configuration is ready; live verification is still required.\n' : 'Runtime upload is not ready.\n')
  }
  return report.ready ? 0 : 1
}
