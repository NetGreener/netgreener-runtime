import { spawnSync } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const workspace = path.dirname(root)
const contractsRoot = path.resolve(
  process.env.NETGREENER_CONTRACTS_ROOT ||
    path.join(workspace, 'netgreener_contracts'),
)

async function exists(candidate) {
  try {
    await access(candidate)
    return true
  } catch {
    return false
  }
}

const profile = JSON.parse(
  await readFile(
    path.join(root, 'conformance/implementation-profile.json'),
    'utf8',
  ),
)
const packageJson = JSON.parse(
  await readFile(path.join(root, 'package.json'), 'utf8'),
)
const typescriptPackage = JSON.parse(
  await readFile(path.join(root, 'node_modules/typescript/package.json'), 'utf8'),
)
const deploymentMode =
  process.env.TF_BUILD?.trim().toLowerCase() === 'true'
    ? 'azure-pipelines'
    : 'local'
const framework = null
const toolchainVersions = [`typescript==${typescriptPackage.version}`]
const environment = profile.verification_environments.find(
  (candidate) =>
    candidate.runtime === 'Node.js' &&
    candidate.runtime_version === process.versions.node &&
    candidate.os === process.platform &&
    candidate.architecture === process.arch &&
    candidate.deployment_mode === deploymentMode &&
    candidate.framework === framework &&
    JSON.stringify(candidate.toolchain_versions) ===
      JSON.stringify(toolchainVersions),
)

if (!environment) {
  throw new Error(
    `no declared verification environment matches Node ${process.versions.node} / TypeScript ${typescriptPackage.version} / ${process.platform} / ${process.arch} / ${deploymentMode}`,
  )
}

const runner = path.join(contractsRoot, 'tools/run_tck_conformance.py')
if (!(await exists(runner))) {
  throw new Error(
    `pinned contracts checkout is missing at ${contractsRoot}; set NETGREENER_CONTRACTS_ROOT`,
  )
}

const python =
  process.env.NETGREENER_PYTHON ||
  (process.platform === 'win32' ? 'python' : 'python3')

const args = [
  runner,
  '--contracts-root',
  contractsRoot,
  '--consumer-root',
  root,
  '--lock',
  'netgreener-contracts.lock.json',
  '--profile',
  'conformance/implementation-profile.json',
  '--environment-id',
  environment.environment_id,
  '--implementation-version',
  packageJson.version,
  '--implementation-artifact',
  'conformance/implementation-ledger.json',
  '--implementation-media-type',
  'application/json',
  '--adapter-artifact',
  'conformance/tck-adapter.mjs',
]
if (process.env.NETGREENER_REQUIRE_SHARED_TCK_PASS === '1') {
  args.push('--require-shared-tck-pass')
}

const result = spawnSync(python, args, { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
