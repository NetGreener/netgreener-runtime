import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, join, relative, extname } from 'node:path'

/**
 * Enrich run_context for anomaly / optimize evidence (additive).
 *
 * Twin intent of Python ``attach_release_identity`` + CI flags used by
 * ``anomaly_feature_projection._is_ci``. Does not change EXPORT_MODE or upload path.
 */

function firstEnv(env: NodeJS.ProcessEnv, names: string[]): string | null {
  for (const name of names) {
    const v = (env[name] || '').trim()
    if (v) return v
  }
  return null
}

function detectCi(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    firstEnv(env, [
      'CI',
      'GITHUB_ACTIONS',
      'GITLAB_CI',
      'BUILD_BUILDID',
      'TF_BUILD',
      'CIRCLECI',
      'TRAVIS',
    ]),
  )
}

function resolveCiProvider(env: NodeJS.ProcessEnv): string | null {
  if (firstEnv(env, ['GITHUB_ACTIONS'])) return 'github_actions'
  if (firstEnv(env, ['GITLAB_CI'])) return 'gitlab_ci'
  if (firstEnv(env, ['TF_BUILD', 'BUILD_BUILDID'])) return 'azure_devops'
  if (firstEnv(env, ['CIRCLECI'])) return 'circleci'
  if (firstEnv(env, ['TRAVIS'])) return 'travis'
  if (firstEnv(env, ['CI'])) return 'ci'
  return null
}

export function resolveReleaseTagFallback(env: NodeJS.ProcessEnv): string | null {
  const explicit = firstEnv(env, ['NETGREENER_RELEASE_TAG', 'RELEASE_TAG'])
  if (explicit) return explicit
  const tag = firstEnv(env, [
    'IMAGE_TAG',
    'DOCKER_IMAGE_TAG',
    'DOCKER_TAG',
    'CONTAINER_IMAGE_TAG',
    'APP_VERSION',
    'CI_COMMIT_TAG',
    'RELEASE_RELEASENAME',
    'BUILD_BUILDNUMBER',
  ])
  if (tag && tag.toLowerCase() !== 'latest') return tag
  const image = firstEnv(env, [
    'NETGREENER_K8S_IMAGE', 'K8S_CONTAINER_IMAGE', 'CONTAINER_IMAGE', 'DOCKER_IMAGE', 'IMAGE',
  ])
  if (image) {
    const digestAt = image.toLowerCase().lastIndexOf('@sha256:')
    if (digestAt >= 0) {
      const digest = image.slice(digestAt + 1).trim()
      const hex = digest.slice(7).trim()
      return hex.length >= 12 ? `sha256:${hex.slice(0, 12)}` : digest
    }
    const name = image.split('/').at(-1) || ''
    const imageTag = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1).trim() : null
    if (imageTag && imageTag.toLowerCase() !== 'latest') return imageTag
  }
  const digest = firstEnv(env, ['NETGREENER_K8S_IMAGE_DIGEST', 'K8S_IMAGE_DIGEST', 'IMAGE_DIGEST'])
  if (digest?.toLowerCase().startsWith('sha256:') && digest.slice(7).length >= 12) {
    return `sha256:${digest.slice(7, 19)}`
  }
  if (digest) return digest
  const vercel = firstEnv(env, ['VERCEL_DEPLOYMENT_ID', 'VERCEL_URL'])
  if (vercel) return `vercel:${vercel}`
  const azure = firstEnv(env, ['RELEASE_RELEASEID', 'RELEASE_DEPLOYMENTID'])
  return azure ? `azure:${azure}` : null
}

const applicationIdentities = new Map<string, Record<string, unknown>>()

function detectApplicationReleaseIdentity(projectDir: string): Record<string, unknown> {
  const root = resolve(projectDir)
  const key = `${process.pid}:${root}`
  const cached = applicationIdentities.get(key)
  if (cached) return cached
  let identity: Record<string, unknown> = {}
  let sha: string | undefined
  try {
    if (!statSync(root).isDirectory()) return identity
    const revision = spawnSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', timeout: 500, windowsHide: true, maxBuffer: 1024 * 1024 })
    if (revision.status === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision.stdout.trim())) {
      sha = revision.stdout.trim().toLowerCase()
      const status = spawnSync('git', ['--no-optional-locks', '-C', root, 'status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8', timeout: 500, windowsHide: true, maxBuffer: 1024 * 1024 })
      if (status.status === 0 && !status.stdout.trim()) identity = { git_sha: sha, release_identity_source: 'git_commit' }
    }
    if (!identity.git_sha) {
      const excluded = new Set(['node_modules', 'venv', 'site-packages', '__pycache__', 'coverage', 'logs', 'tmp', 'data', 'datasets', 'artifacts', 'outputs'])
      const extensions = new Set(['.py', '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs'])
      const manifests = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'pyproject.toml', 'requirements.txt', 'poetry.lock', 'uv.lock'])
      const files: string[] = []
      const directories = [root]
      let entries = 0
      let bytes = 0
      const deadline = performance.now() + 500
      while (directories.length) {
        const directory = directories.pop()!
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entry.name.startsWith('.') || entry.isSymbolicLink() || excluded.has(entry.name) && entry.isDirectory()) continue
          if (++entries > 10000 || performance.now() > deadline) throw new Error('source scan limit')
          const file = join(directory, entry.name)
          if (entry.isDirectory()) directories.push(file)
          else if (entry.isFile() && (extensions.has(extname(entry.name).toLowerCase()) || manifests.has(entry.name))) {
            bytes += statSync(file).size
            if (files.length >= 2000 || bytes > 32 * 1024 * 1024) throw new Error('source scan limit')
            files.push(file)
          }
        }
      }
      files.sort((a, b) => Buffer.compare(Buffer.from(relative(root, a).split('\\').join('/')), Buffer.from(relative(root, b).split('\\').join('/'))))
      if (files.length) {
        const digest = createHash('sha256')
        for (const file of files) {
          if (performance.now() > deadline) throw new Error('source scan time limit')
          const name = Buffer.from(relative(root, file).split('\\').join('/'))
          const content = readFileSync(file)
          if (content.length > 32 * 1024 * 1024) throw new Error('source scan limit')
          digest.update(`${name.length}:`).update(name).update(`${content.length}:`).update(content)
        }
        const fingerprint = digest.digest('hex')
        identity = { release_tag: `source:${fingerprint.slice(0, 16)}`, source_revision_sha256: fingerprint, release_identity_source: 'source_fingerprint', ...(sha ? { git_sha: sha } : {}) }
      }
    }
  } catch { identity = {} }
  if (applicationIdentities.size >= 32) applicationIdentities.delete(applicationIdentities.keys().next().value!)
  applicationIdentities.set(key, identity)
  return identity
}

/**
 * Attach release identity + CI flags onto an existing run_context object.
 * Never overwrites an already-set ``release_tag`` / ``git_sha`` / ``deploy_id``.
 */
export function enrichRunContextForAnomaly(
  ctx: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  projectDir: string = process.cwd(),
): Record<string, unknown> {
  if (!(typeof ctx.deploy_environment === 'string' && ctx.deploy_environment.trim())) {
    const explicit = firstEnv(env, ['NETGREENER_DEPLOY_ENVIRONMENT', 'DEPLOY_ENV', 'NETGREENER_ENV'])
    const tier = explicit || firstEnv(env, ['VERCEL_ENV'])
    const normalized = tier?.toLowerCase()
    const mapped = normalized === 'production' ? 'prod'
      : normalized === 'preview' ? 'staging'
      : normalized === 'development' ? 'dev' : normalized
    if (mapped) ctx.deploy_environment = mapped
  }
  if (!(typeof ctx.release_tag === 'string' && ctx.release_tag.trim())) {
    const tag = resolveReleaseTagFallback(env)
    if (tag) ctx.release_tag = tag.slice(0, 255)
  }

  if (!(typeof ctx.git_sha === 'string' && ctx.git_sha.trim())) {
    const sha = firstEnv(env, [
      'NETGREENER_GIT_SHA',
      'GIT_SHA',
      'GITHUB_SHA',
      'BUILD_SOURCEVERSION',
      'VERCEL_GIT_COMMIT_SHA',
      'CI_COMMIT_SHA',
      'CIRCLE_SHA1',
    ])
    if (sha) ctx.git_sha = sha.slice(0, 64)
  }

  if (!(typeof ctx.deploy_id === 'string' && ctx.deploy_id.trim())) {
    const deployId = firstEnv(env, [
      'NETGREENER_DEPLOY_ID',
      'DEPLOY_ID',
      'VERCEL_DEPLOYMENT_ID',
      'VERCEL_URL',
      'RELEASE_DEPLOYMENTID',
      'RELEASE_RELEASEID',
      'BUILD_BUILDID',
    ])
    if (deployId) ctx.deploy_id = deployId.slice(0, 255)
  }

  if (![ctx.release_tag, ctx.git_sha, ctx.deploy_id].some(value => typeof value === 'string' && value.trim())) {
    Object.assign(ctx, detectApplicationReleaseIdentity(projectDir))
  }

  if (detectCi(env)) {
    ctx.is_ci = true
    ctx.ci = true
    ctx.continuous_integration = true
    const provider = resolveCiProvider(env)
    if (provider) ctx.ci_provider = provider
  }

  return ctx
}
