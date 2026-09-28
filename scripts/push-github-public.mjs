/**
 * Push a sanitized public mirror to GitHub (provenance publish remote).
 *
 * Azure `origin` keeps full private plans. This script force-updates `github`
 * with an allowlisted tree only: code + TUTORIAL (+ slim README/CHANGELOG).
 *
 *   node scripts/push-github-public.mjs
 *
 * Does NOT publish to npm. Does NOT change Azure history.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const githubRemote = 'git@github.com:NetGreener/netgreener-runtime.git'

/** Paths copied into the public mirror (relative to repo root). */
const ALLOW_DIRS = [
  'src',
  'examples',
  'fixtures',
  'scripts',
  'conformance',
  '.github',
]

const ALLOW_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  '.gitignore',
  '.gitattributes',
  '.env.example',
  'netgreener-contracts.lock.json',
  'TUTORIAL.md',
]

const PUBLIC_README = `# @netgreener/runtime

NetGreener Node.js Runtime — thin adapter that meters Express / Fastify / Nest /
BullMQ / process workloads and uploads RunSessions to the NetGreener API.

## Docs

- **Tutorial:** [TUTORIAL.md](./TUTORIAL.md)
- **Changelog:** [CHANGELOG.md](./CHANGELOG.md)

## Install (when published)

\`\`\`bash
npm install @netgreener/runtime
\`\`\`

## Develop

\`\`\`bash
npm ci
npm test
\`\`\`

## License

See package \`license\` field. Source of truth for internal engineering remains
on the private Azure DevOps repository; this GitHub repo is the public publish
mirror used for npm provenance.
`

const PUBLIC_CHANGELOG = `# Changelog — @netgreener/runtime

## [0.1.5] — 2026-09-27

### Fixed
- Split CI gate steps for clearer Trusted Publisher publish diagnostics

## [0.1.4] — 2026-09-27

### Fixed
- Trusted Publisher OIDC: publish job no longer uses a GitHub Environment claim

## [0.1.3] — 2026-09-27

### Fixed
- CI setup-node pin (v4 + Node 24) for Trusted Publisher OIDC

## [0.1.2] — 2026-09-27

### Fixed
- Trusted Publisher OIDC publish hardening (Node 24, npm latest, no empty auth token)

## [0.1.1] — 2026-09-27

### Fixed
- Trusted Publisher OIDC publish (Node >= 22.14, npm >= 11.5.1)
- Guard against re-publishing an existing npm version

## [0.1.0] — 2026-09-24

### Added
- Express / Fastify / Nest-via-adapter middleware with tenant attribution
- Outbound \`fetch\` metering (\`external_api_v0\`), optional axios/undici wraps
- BullMQ processor wrap and process/cron helpers
- Default \`NETGREENER_EXPORT_MODE=direct\` upload to NetGreener API
- Opt-in collector IPC and thin-flush documentation in the tutorial
- Local \`netgreener analyze\` scaffold (\`run\` / \`optimize\` stubs)

### Notes
- First public npm release with provenance from this repository
- Process CPU/RSS are measured on instrumented hooks; cgroup/process-tree
  sampling is not claimed in this version
`

function run(cmd, args, cwd) {
  // Do not use shell:true — Windows splits -m commit messages on spaces.
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function copyPath(rel) {
  const from = join(root, rel)
  if (!existsSync(from)) return
  const to = join(stage, rel)
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true })
}

const stage = mkdtempSync(join(tmpdir(), 'ng-runtime-public-'))
console.log(`--- staging public mirror in ${stage} ---`)

try {
  for (const d of ALLOW_DIRS) copyPath(d)
  for (const f of ALLOW_FILES) copyPath(f)

  // Public docs only (never copy PRODUCTION_*, STACK, agent checklists, etc.)
  writeFileSync(join(stage, 'README.md'), PUBLIC_README, 'utf8')
  writeFileSync(join(stage, 'CHANGELOG.md'), PUBLIC_CHANGELOG, 'utf8')

  // Slim package.json "files" for npm pack — tutorial + changelog + code only
  const pkgPath = join(stage, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.files = [
    'dist',
    '!dist/tests',
    '!dist/tests/**',
    'fixtures',
    'examples',
    'README.md',
    'TUTORIAL.md',
    'CHANGELOG.md',
  ]
  // Public mirror is the npm publish surface (Azure origin stays private:true).
  pkg.private = false
  pkg.publishConfig = { access: 'public' }
  // Exact GitHub repo URL — Trusted Publisher + npm normalize to git+https://…
  pkg.repository = {
    type: 'git',
    url: 'git+https://github.com/NetGreener/netgreener-runtime.git',
  }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

  // Drop private Azure pipelines from public mirror if copied via scripts globs — none in ALLOW
  assert.ok(existsSync(join(stage, 'TUTORIAL.md')), 'TUTORIAL.md required')
  assert.ok(!existsSync(join(stage, 'PRODUCTION_GOAL.md')), 'plan docs must not ship')
  assert.ok(!existsSync(join(stage, 'STACK.md')), 'STACK.md must not ship')
  assert.ok(!existsSync(join(stage, 'OVERHEAD_BUDGET_FREEZE_PROPOSAL.md')), 'freeze proposal must not ship')

  run('git', ['init'], stage)
  run('git', ['checkout', '-b', 'main'], stage)
  run('git', ['config', 'user.email', 'release@netgreener.com'], stage)
  run('git', ['config', 'user.name', 'NetGreener Release'], stage)
  run('git', ['add', '-A'], stage)
  run('git', ['commit', '-m', 'Public mirror: runtime package + tutorial only.'], stage)
  run('git', ['remote', 'add', 'github', githubRemote], stage)
  console.log('--- force-pushing sanitized tree to github/main (replaces public history) ---')
  run('git', ['push', '-f', 'github', 'main'], stage)

  const version = pkg.version
  const tag = `runtime-v${version}`
  const pushTag = process.argv.includes('--push-release-tag')
  if (pushTag) {
    // Delay so the main force-push event is not coalesced with the tag event.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000)
    run('git', ['tag', '-f', '-a', tag, '-m', `Release ${version}`], stage)
    // Push only the tag ref (explicit) so Actions sees refs/tags/runtime-v*.
    run('git', ['push', '-f', 'github', `refs/tags/${tag}`], stage)
    console.log(`RELEASE TAG PUSHED: ${tag} (triggers npm-publish-provenance)`)
  } else {
    console.log(
      `PUBLIC GITHUB MIRROR UPDATED (for a release: node scripts/push-github-public.mjs --push-release-tag)`,
    )
  }
} finally {
  rmSync(stage, { recursive: true, force: true })
}
