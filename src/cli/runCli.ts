/**
 * ``netgreener run <script> [projectDir]`` — execute a Node script with process metering.
 *
 * Twin intent of Python ``netgreener run <script> .``: really run the script and
 * measure. Child process loads ``runPreload`` so metering happens inside the
 * workload process. Uploads to existing api_server (default direct).
 */

import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { runAnalyzeCli } from '../analyze/cli.js'
import { configReady, loadRuntimeConfig, type RuntimeConfig } from '../config.js'
import {
  childEnvForManagedCollector,
  normalizedCollectorMode,
  startManagedCollector,
  type ManagedCollectorHandle,
} from '../managedCollectorLauncher.js'

const preloadHref = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), 'runPreload.js'),
).href

export type RunCliFlags = {
  script: string
  projectDir: string
  noUpload: boolean
  dryRun: boolean
  noAnalyze: boolean
  help: boolean
  scriptArgs: string[]
}

export function formatRunHelp(): string {
  return `Usage: netgreener run <script> [projectDir] [--] [scriptArgs...]

Really execute a Node script and meter the process window (CPU/RSS via
node_process_*). Uploads a RunSession to the existing NetGreener api_server
when credentials are set (same brain as Python — no Node api_server).

Arguments:
  script                 Entry file (.js / .mjs / .cjs)
  projectDir             Working directory (default: script's directory)

Options:
  --no-upload            Do not upload (forces dry-run flush)
  --dry-run              Same as --no-upload for metering payload
  --no-analyze           Skip local Analyze pass after the script exits
  -h, --help             Show this help

Env (live upload):
  NETGREENER_SERVICE_RUNTIME=1
  NETGREENER_TOKEN=ngs_…
  NETGREENER_PROJECT_ID=<id>
  NETGREENER_API_URL=…          (optional)
  NETGREENER_EXPORT_MODE=direct (default — do not flip without owner OK)
  NETGREENER_COLLECTOR_MODE=managed  (opt-in: start sibling collector; child uses EXPORT_MODE=collector)

Examples:
  netgreener run ./jobs/report.mjs .
  netgreener run ./jobs/report.mjs ./my-app --no-upload
  netgreener run ./server.mjs . -- --port 3000

Notes:
  • Analyze after run is local only (upload=never), same as \`netgreener analyze\`.
  • .ts entrypoints: compile first or use a TS runner; metered .ts wrap comes later.
  • Managed collector needs Python \`netgreener.collector_server\` on PATH; Windows = tcp:// only.
`
}

export function parseRunArgs(argv: string[]): RunCliFlags {
  const flags: RunCliFlags = {
    script: '',
    projectDir: '',
    noUpload: false,
    dryRun: false,
    noAnalyze: false,
    help: false,
    scriptArgs: [],
  }
  const positionals: string[] = []
  let passthrough = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    if (passthrough) {
      flags.scriptArgs.push(arg)
      continue
    }
    if (arg === '--') {
      passthrough = true
      continue
    }
    if (arg === '-h' || arg === '--help') {
      flags.help = true
      continue
    }
    if (arg === '--no-upload') {
      flags.noUpload = true
      continue
    }
    if (arg === '--dry-run') {
      flags.dryRun = true
      continue
    }
    if (arg === '--no-analyze') {
      flags.noAnalyze = true
      continue
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    }
    positionals.push(arg)
  }
  flags.script = positionals[0] || ''
  flags.projectDir = positionals[1] || ''
  return flags
}

function assertJsEntrypoint(scriptPath: string): void {
  const lower = scriptPath.toLowerCase()
  if (lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.mts')) {
    throw new Error(
      'TypeScript entrypoints are not metered yet. Compile to .js/.mjs first.',
    )
  }
}

function buildChildEnv(flags: RunCliFlags): NodeJS.ProcessEnv {
  const dry = flags.noUpload || flags.dryRun || process.env.NETGREENER_RUNTIME_DRY_RUN === '1'
  const config: RuntimeConfig = loadRuntimeConfig({
    ...process.env,
    NETGREENER_SERVICE_RUNTIME: process.env.NETGREENER_SERVICE_RUNTIME || '1',
    ...(dry
      ? {
          NETGREENER_RUNTIME_DRY_RUN: '1',
          NETGREENER_TOKEN: process.env.NETGREENER_TOKEN || 'ngs_local_dry_run',
          NETGREENER_PROJECT_ID: process.env.NETGREENER_PROJECT_ID || '1',
        }
      : {}),
  })
  const ready = configReady(config)
  if (!ready.ok) {
    throw new Error(
      `runtime config not ready (${ready.reason}). ` +
        `Set NETGREENER_TOKEN + NETGREENER_PROJECT_ID, or pass --no-upload / --dry-run.`,
    )
  }
  return {
    ...process.env,
    NETGREENER_SERVICE_RUNTIME: '1',
    NETGREENER_TOKEN: config.token,
    NETGREENER_PROJECT_ID: String(config.projectId),
    NETGREENER_API_URL: config.apiUrl,
    ...(config.dryRun ? { NETGREENER_RUNTIME_DRY_RUN: '1' } : {}),
    ...(config.organizationId != null
      ? { NETGREENER_ORG_ID: String(config.organizationId) }
      : {}),
    ...(config.organizationId == null && config.organizationSlug
      ? { NETGREENER_ORG_SLUG: config.organizationSlug }
      : {}),
  }
}

function spawnScript(
  scriptAbs: string,
  cwd: string,
  scriptArgs: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(
      process.execPath,
      ['--import', preloadHref, scriptAbs, ...scriptArgs],
      {
        cwd,
        stdio: 'inherit',
        env,
        windowsHide: true,
      },
    )
    child.on('error', (err) => {
      process.stderr.write(`netgreener run: failed to start script: ${err.message}\n`)
      resolveExit(1)
    })
    child.on('exit', (code, signal) => {
      if (signal) {
        process.stderr.write(`netgreener run: script terminated by ${signal}\n`)
        resolveExit(1)
        return
      }
      resolveExit(typeof code === 'number' ? code : 1)
    })
  })
}

/** Run the metered script CLI. Returns process exit code. */
export async function runRunCli(argv: string[]): Promise<number> {
  let flags: RunCliFlags
  try {
    flags = parseRunArgs(argv)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n`)
    process.stdout.write(formatRunHelp())
    return 2
  }
  if (flags.help) {
    process.stdout.write(formatRunHelp())
    return 0
  }
  if (!flags.script) {
    process.stderr.write('netgreener run: missing <script>\n\n')
    process.stdout.write(formatRunHelp())
    return 2
  }

  const scriptAbs = isAbsolute(flags.script)
    ? flags.script
    : resolve(process.cwd(), flags.script)
  try {
    accessSync(scriptAbs, constants.R_OK)
    if (!statSync(scriptAbs).isFile()) throw new Error('not a file')
  } catch {
    process.stderr.write(`netgreener run: script not found: ${scriptAbs}\n`)
    return 2
  }

  try {
    assertJsEntrypoint(scriptAbs)
  } catch (err) {
    process.stderr.write(`netgreener run: ${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }

  const projectAbs = flags.projectDir
    ? isAbsolute(flags.projectDir)
      ? flags.projectDir
      : resolve(process.cwd(), flags.projectDir)
    : resolve(scriptAbs, '..')

  let childEnv: NodeJS.ProcessEnv
  try {
    childEnv = buildChildEnv(flags)
  } catch (err) {
    process.stderr.write(
      `netgreener run: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 2
  }

  let managed: ManagedCollectorHandle | null = null
  if (normalizedCollectorMode(childEnv) === 'managed') {
    try {
      process.stderr.write(
        'netgreener run: COLLECTOR_MODE=managed — starting sibling collector…\n',
      )
      managed = await startManagedCollector({ env: childEnv })
      if (managed) {
        childEnv = childEnvForManagedCollector(childEnv, managed.endpoint)
        process.stderr.write(
          `netgreener run: collector ready at ${managed.endpoint}\n`,
        )
      }
    } catch (err) {
      process.stderr.write(
        `netgreener run: managed collector failed: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      )
      return 2
    }
  }

  const dry = childEnv.NETGREENER_RUNTIME_DRY_RUN === '1'
  const exportMode = (childEnv.NETGREENER_EXPORT_MODE || 'direct').toLowerCase()
  process.stderr.write(
    `netgreener run: metering ${scriptAbs} (cwd=${projectAbs}` +
      `${dry ? ', dry-run' : ', upload'}, export=${exportMode})…\n`,
  )

  let exitCode = 1
  try {
    exitCode = await spawnScript(scriptAbs, projectAbs, flags.scriptArgs, childEnv)
  } finally {
    if (managed) {
      process.stderr.write('netgreener run: draining managed collector…\n')
      await managed.stop()
    }
  }

  if (!flags.noAnalyze) {
    process.stderr.write('netgreener run: local analyze (upload=never)…\n')
    const analyzeCode = runAnalyzeCli([projectAbs, '--quiet'])
    if (analyzeCode !== 0) {
      process.stderr.write(`netgreener run: analyze exited ${analyzeCode}\n`)
    }
  }

  return exitCode
}
