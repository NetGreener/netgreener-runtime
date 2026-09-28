import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const workspace = path.dirname(root)

async function json(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'))
}

async function exists(candidate) {
  try {
    await access(candidate)
    return true
  } catch {
    return false
  }
}

const lock = await json('netgreener-contracts.lock.json')
const profile = await json('conformance/implementation-profile.json')
const ledger = await json('conformance/implementation-ledger.json')
const packageJson = await json('package.json')
const ignore = await readFile(path.join(root, '.gitignore'), 'utf8')
const pipeline = await readFile(
  path.join(root, 'azure-pipelines-node-runtime-tests.yml'),
  'utf8',
)

assert.equal(lock.schema_name, 'netgreener.contracts_lock.v1')
assert.equal(lock.schema_version, 1)
assert.equal(
  lock.source.repository_url,
  'https://dev.azure.com/nexadeeds/NetGreener/_git/netgreener_contracts',
)
assert.match(lock.source.source_revision, /^[0-9a-f]{40}$/)

assert.equal(profile.schema_name, 'netgreener.implementation_profile.v1')
assert.equal(profile.schema_version, 1)
assert.equal(profile.profile_id, 'nodejs.runtime')
assert.equal(profile.target_id, 'nodejs.runtime')
assert.equal(profile.plane, 'runtime')
assert.equal(profile.implementation.id, ledger.implementation_id)
assert.equal(profile.contracts_lock_path, 'netgreener-contracts.lock.json')
assert.equal(profile.contract_bundle_id, lock.bundle.bundle_id)
assert.equal(profile.catalog_version, lock.bundle.catalog_version)
assert.equal(profile.tck_version, lock.bundle.tck_version)
assert.equal(profile.runner.protocol_version, lock.bundle.runner_protocol_version)
assert.equal(profile.runner.status, 'available')
assert.equal(
  profile.runner.command.filter((value) => value === '{adapter_artifact}').length,
  1,
)
assert.deepEqual(profile.runner.command, ['node', '{adapter_artifact}'])
assert.equal(profile.runner.adapter.id, 'netgreener-node-tck-adapter')
assert.equal(profile.runner.adapter.version, packageJson.version)

const environmentIds = profile.verification_environments.map(
  (environment) => environment.environment_id,
)
assert.equal(new Set(environmentIds).size, environmentIds.length)
for (const environment of profile.verification_environments) {
  assert.equal(environment.runtime, 'Node.js')
  assert.equal(environment.runtime_version, '22.12.0')
  assert.deepEqual(environment.toolchain_versions, ['typescript==5.9.3'])
  assert.equal(environment.architecture, 'x64')
  assert.equal(environment.framework, null)
}

const checkIds = profile.checks.map((check) => check.check_id)
assert.equal(new Set(checkIds).size, checkIds.length)
assert.equal(
  profile.checks.find((check) => check.check_id === 'CHK-Q1.shared-tck')
    ?.applicability,
  'required',
)

assert.equal(ledger.schema_name, 'netgreener.node_implementation_ledger.v1')
assert.equal(ledger.schema_version, 1)
for (const relativePath of [
  ledger.production_entrypoint,
  ...ledger.production_sources,
  'conformance/tck-adapter.mjs',
  'conformance/implementation-profile.json',
]) {
  assert.equal(path.isAbsolute(relativePath), false)
  const resolved = path.resolve(root, relativePath)
  assert.equal(resolved.startsWith(`${root}${path.sep}`), true)
  assert.equal(await exists(resolved), true, `${relativePath} is missing`)
}

const production = await import(new URL('../dist/index.js', import.meta.url))
for (const boundary of ledger.tck_action_boundaries) {
  if (boundary.status === 'not_implemented') {
    assert.equal(boundary.production_module, null)
    assert.notEqual(
      typeof production[boundary.production_export],
      'function',
      `${boundary.production_export} exists but the ledger still says not_implemented`,
    )
  } else {
    assert.equal(boundary.status, 'implemented')
    assert.equal(typeof boundary.production_module, 'string')
    assert.equal(
      ledger.production_sources.includes(boundary.production_module),
      true,
      `${boundary.production_module} must be in the tracked production surface`,
    )
    const committedModule = execFileSync(
      'git',
      ['show', `HEAD:${boundary.production_module}`],
      { cwd: root, encoding: null },
    )
    const workingModule = await readFile(
      path.join(root, boundary.production_module),
    )
    assert.deepEqual(
      workingModule,
      committedModule,
      `${boundary.production_module} bytes must match its tracked Git blob`,
    )
  }
}

assert.match(ignore, /^conformance\/results\/$/m)
assert.match(ignore, /^artifacts\/v1\/$/m)
assert.doesNotMatch(pipeline, /persistCredentials:\s*true/)
assert.match(pipeline, /unset SYSTEM_ACCESSTOKEN/)

const configuredContractsRoot = process.env.NETGREENER_CONTRACTS_ROOT
const contractsRoot = configuredContractsRoot
  ? path.resolve(configuredContractsRoot)
  : path.join(workspace, 'netgreener_contracts')

if (await exists(path.join(contractsRoot, '.git'))) {
  const remoteUrl = execFileSync(
    'git',
    ['remote', 'get-url', 'origin'],
    { cwd: contractsRoot, encoding: 'utf8' },
  ).trim()
  assert.equal(
    [
      lock.source.repository_url,
      'git@ssh.dev.azure.com:v3/nexadeeds/NetGreener/netgreener_contracts',
    ].includes(remoteUrl.replace(/\.git$/, '')),
    true,
    `unexpected contracts origin: ${remoteUrl}`,
  )

  execFileSync(
    'git',
    ['cat-file', '-e', `${lock.source.source_revision}^{commit}`],
    { cwd: contractsRoot, stdio: 'ignore' },
  )

  const bundleBytes = execFileSync(
    'git',
    [
      'show',
      `${lock.source.source_revision}:${lock.bundle.manifest_path}`,
    ],
    { cwd: contractsRoot, encoding: null },
  )
  assert.equal(
    `sha256:${createHash('sha256').update(bundleBytes).digest('hex')}`,
    lock.bundle.manifest_digest,
  )
  const bundle = JSON.parse(bundleBytes.toString('utf8'))
  assert.equal(bundle.bundle_id, lock.bundle.bundle_id)
  assert.equal(bundle.identity.bundle_version, lock.bundle.bundle_version)
  assert.equal(bundle.identity.catalog_version, lock.bundle.catalog_version)
  assert.equal(bundle.identity.tck_version, lock.bundle.tck_version)
  assert.equal(
    bundle.identity.runner_protocol_version,
    lock.bundle.runner_protocol_version,
  )

  const catalog = JSON.parse(
    execFileSync(
      'git',
      [
        'show',
        `${lock.source.source_revision}:capabilities/v1/capability-catalog.json`,
      ],
      { cwd: contractsRoot, encoding: 'utf8' },
    ),
  )
  const expectedCheckIds = catalog.capabilities
    .filter((capability) => capability.mandatory_for.includes(profile.plane))
    .flatMap((capability) => capability.check_ids)
  assert.deepEqual(checkIds, expectedCheckIds)

  const canonicalProfile = JSON.parse(
    execFileSync(
      'git',
      [
        'show',
        `${lock.source.source_revision}:profiles/v1/${profile.profile_id}.json`,
      ],
      { cwd: contractsRoot, encoding: 'utf8' },
    ),
  )
  assert.deepEqual(
    profile,
    canonicalProfile,
    'consumer profile must exactly match the pinned canonical contracts profile',
  )

  const manifest = JSON.parse(
    execFileSync(
      'git',
      [
        'show',
        `${lock.source.source_revision}:tck/v1/manifest.json`,
      ],
      { cwd: contractsRoot, encoding: 'utf8' },
    ),
  )
  for (const gateCheckId of manifest.gate_check_ids) {
    assert.equal(
      profile.checks.find((check) => check.check_id === gateCheckId)
        ?.applicability,
      'required',
    )
  }
}

console.log(
  'Node contracts integration is internally consistent; current production TCK seams remain explicitly not implemented.',
)
