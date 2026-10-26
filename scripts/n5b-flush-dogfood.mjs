/**
 * N5b Linux live flush dogfood — Node process flush → managed collector → enrich.
 *
 * Proves ``emitter_pid`` on the wire and ``collector_resource_sample_v0`` via the
 * same ``run_session_payload_from_ipc`` path the collector uses.
 *
 * - Does **not** flip default EXPORT_MODE (opt-in collector for this process only).
 * - Does **not** upload to api_server.
 * - Non-Linux: module honesty via n5b-linux-gate; flush phase skipped (exit 0)
 *   unless NETGREENER_N5B_REQUIRE_FLUSH=1.
 * - Linux CI: set NETGREENER_N5B_REQUIRE_FLUSH=1 and provide netgreener_cli
 *   (NETGREENER_CLI_ROOT or sibling ../netgreener_cli).
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(here, '..')
const requireFlush =
  String(process.env.NETGREENER_N5B_REQUIRE_FLUSH || '').trim() === '1'
const plat = process.platform

function resolveCliRoot() {
  const fromEnv = String(process.env.NETGREENER_CLI_ROOT || '').trim()
  if (fromEnv && existsSync(join(fromEnv, 'netgreener'))) return resolve(fromEnv)
  const sibling = resolve(root, '..', 'netgreener_cli')
  if (existsSync(join(sibling, 'netgreener'))) return sibling
  return null
}

function runModuleGate() {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'n5b-linux-gate.mjs')], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.status !== 0) {
    throw new Error(`n5b-linux-gate failed (exit ${r.status})`)
  }
}

function pythonCmd() {
  return process.env.NETGREENER_PYTHON || (plat === 'win32' ? 'python' : 'python3')
}

async function runFlushDogfood(cliRoot) {
  const spoolDir = mkdtempSync(join(tmpdir(), 'ng-n5b-spool-'))
  const artifactDir = join(root, 'artifacts', 'n5b-flush')
  mkdirSync(artifactDir, { recursive: true })
  const artifactPath = join(artifactDir, 'latest.json')

  const distImport = (name) => import(pathToFileURL(join(root, 'dist', name)).href)
  const { startManagedCollector } = await distImport('managedCollectorLauncher.js')
  const {
    flushProcessRuntime,
    runWithProcessTenant,
    startProcessRuntime,
  } = await distImport('processRuntime.js')
  const { _resetRuntimeForTests } = await distImport('runtime.js')
  const { clearExternalAggregator } = await distImport('externalApiMeter.js')
  const { DEFAULT_TENANT_RUNTIME_FIELDS } = await distImport('tenantDefaults.js')

  const prev = {
    EXPORT: process.env.NETGREENER_EXPORT_MODE,
    ENDPOINT: process.env.NETGREENER_COLLECTOR_ENDPOINT,
    MODE: process.env.NETGREENER_COLLECTOR_MODE,
    DRY: process.env.NETGREENER_RUNTIME_DRY_RUN,
    PYTHONPATH: process.env.PYTHONPATH,
  }

  let handle = null
  try {
    process.env.PYTHONPATH = [cliRoot, prev.PYTHONPATH].filter(Boolean).join(
      plat === 'win32' ? ';' : ':',
    )
    process.env.NETGREENER_COLLECTOR_MODE = 'managed'
    process.env.NETGREENER_SPOOL_DIR = spoolDir
    process.env.NETGREENER_RUNTIME_DRY_RUN = '0'
    delete process.env.NETGREENER_RUNTIME_DRY_RUN

    handle = await startManagedCollector({
      env: {
        ...process.env,
        NETGREENER_COLLECTOR_MODE: 'managed',
        NETGREENER_SPOOL_DIR: spoolDir,
        PYTHONPATH: process.env.PYTHONPATH,
      },
      pythonCommand: pythonCmd(),
    })
    assert.ok(handle, 'managed collector should start')
    handle.process.stderr?.on('data', (chunk) => {
      process.stderr.write(`[collector] ${chunk}`)
    })

    process.env.NETGREENER_EXPORT_MODE = 'collector'
    process.env.NETGREENER_COLLECTOR_ENDPOINT = handle.endpoint

    clearExternalAggregator()
    _resetRuntimeForTests()

    startProcessRuntime({
      config: {
        enabled: true,
        apiUrl: 'https://n5b-flush.example.test',
        token: 'n5b-flush-dogfood',
        projectId: 1,
        organizationId: null,
        flushIntervalMs: 60_000,
        dryRun: false,
        deployEnvironment: 'n5b_flush_dogfood',
        releaseTag: null,
        estimateTdpWatts: 65,
        ...DEFAULT_TENANT_RUNTIME_FIELDS,
        tenantSource: 'none',
      },
    })

    await runWithProcessTenant('org_n5b', async () => {
      // Burn a little CPU/RSS so process meters are non-empty.
      const h = createHash('sha256')
      for (let i = 0; i < 2000; i++) h.update(String(i))
      return h.digest('hex')
    }, { serviceUnit: 'task:n5b_flush_dogfood' })

    const result = await flushProcessRuntime('manual')
    assert.ok(result, 'flush should return a result')
    assert.equal(result.ok, true, result.ok ? 'ok' : String(result.error))
    assert.equal(result.mode, 'collector')
    assert.ok(result.collectorEventId)

    await handle.stop()
    handle = null

    const inspect = spawnSync(
      pythonCmd(),
      [
        join(root, 'scripts', 'n5b_flush_enrich_inspect.py'),
        '--spool-dir',
        spoolDir,
        '--out',
        artifactPath,
        ...(plat === 'linux' ? ['--require-linux-tree'] : []),
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONPATH: [cliRoot, process.env.PYTHONPATH].filter(Boolean).join(
            plat === 'win32' ? ';' : ':',
          ),
        },
      },
    )
    if (inspect.stdout) process.stdout.write(inspect.stdout)
    if (inspect.stderr) process.stderr.write(inspect.stderr)
    if (inspect.status !== 0) {
      throw new Error(`enrich inspect failed (exit ${inspect.status})`)
    }

    writeFileSync(
      join(artifactDir, 'SUMMARY.md'),
      [
        '# N5b flush dogfood',
        '',
        `- platform: \`${plat}\``,
        `- spool: \`${spoolDir}\``,
        `- artifact: [\`latest.json\`](./latest.json)`,
        `- collector event: \`${result.collectorEventId}\``,
        '',
        'No api_server upload. Default EXPORT_MODE unchanged.',
        '',
      ].join('\n'),
      'utf8',
    )

    console.log(`n5b-flush-dogfood: flush PASS event=${result.collectorEventId}`)
  } finally {
    if (handle) await handle.stop().catch(() => {})
    clearExternalAggregator()
    _resetRuntimeForTests()
    for (const [k, v] of Object.entries({
      NETGREENER_EXPORT_MODE: prev.EXPORT,
      NETGREENER_COLLECTOR_ENDPOINT: prev.ENDPOINT,
      NETGREENER_COLLECTOR_MODE: prev.MODE,
      NETGREENER_RUNTIME_DRY_RUN: prev.DRY,
      PYTHONPATH: prev.PYTHONPATH,
    })) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

async function main() {
  console.log(`n5b-flush-dogfood: platform=${plat} requireFlush=${requireFlush}`)
  runModuleGate()

  const cliRoot = resolveCliRoot()
  if (!cliRoot) {
    const msg =
      'n5b-flush-dogfood: netgreener_cli not found ' +
      '(set NETGREENER_CLI_ROOT or place sibling ../netgreener_cli)'
    if (requireFlush) {
      console.error(`FAIL ${msg}`)
      process.exit(1)
    }
    console.log(`SKIP flush phase — ${msg}`)
    console.log('N5B FLUSH DOGFOOD PASS (module only)')
    return
  }

  console.log(`n5b-flush-dogfood: cliRoot=${cliRoot}`)
  // Flush works on Windows too (psutil tree; cgroup honest unavailable).
  // Linux CI adds --require-linux-tree inside the inspect helper.
  await runFlushDogfood(cliRoot)
  console.log('N5B FLUSH DOGFOOD PASS')
}

main().catch((err) => {
  console.error('n5b-flush-dogfood: FAIL', err instanceof Error ? err.message : err)
  process.exit(1)
})
