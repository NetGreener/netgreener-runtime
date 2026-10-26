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

function resolveReleaseTagFallback(env: NodeJS.ProcessEnv): string | null {
  const tag = firstEnv(env, [
    'NETGREENER_RELEASE_TAG',
    'RELEASE_TAG',
    'IMAGE_TAG',
    'DOCKER_IMAGE_TAG',
    'DOCKER_TAG',
    'CONTAINER_IMAGE_TAG',
    'APP_VERSION',
    'CI_COMMIT_TAG',
    'RELEASE_RELEASENAME',
    'BUILD_BUILDNUMBER',
  ])
  if (tag) return tag
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
    if (name.includes(':')) return name.slice(name.lastIndexOf(':') + 1).trim() || null
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

/**
 * Attach release identity + CI flags onto an existing run_context object.
 * Never overwrites an already-set ``release_tag`` / ``git_sha`` / ``deploy_id``.
 */
export function enrichRunContextForAnomaly(
  ctx: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
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

  if (detectCi(env)) {
    ctx.is_ci = true
    ctx.ci = true
    ctx.continuous_integration = true
    const provider = resolveCiProvider(env)
    if (provider) ctx.ci_provider = provider
  }

  return ctx
}
