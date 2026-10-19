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
  return firstEnv(env, [
    'NETGREENER_RELEASE_TAG',
    'RELEASE_TAG',
    'IMAGE_TAG',
    'DOCKER_IMAGE_TAG',
    'DOCKER_TAG',
    'CONTAINER_IMAGE_TAG',
    'APP_VERSION',
    'CI_COMMIT_TAG',
    'BUILD_BUILDNUMBER',
  ])
}

/**
 * Attach release identity + CI flags onto an existing run_context object.
 * Never overwrites an already-set ``release_tag`` / ``git_sha`` / ``deploy_id``.
 */
export function enrichRunContextForAnomaly(
  ctx: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
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
    ])
    if (sha) ctx.git_sha = sha.slice(0, 64)
  }

  if (!(typeof ctx.deploy_id === 'string' && ctx.deploy_id.trim())) {
    const deployId = firstEnv(env, [
      'NETGREENER_DEPLOY_ID',
      'DEPLOY_ID',
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
