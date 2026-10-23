/**
 * Git remote normalization — twin of Python ``netgreener.git_context.normalize_git_url``
 * / ``netgreener_sdk.git_url`` (OP1). Golden vectors:
 * ``netgreener_contracts/git/canonical_git_key_vectors.v1.json``.
 */

function stripGitSuffix(path: string): string {
  return path.toLowerCase().endsWith('.git') ? path.slice(0, -4) : path
}

function adoPathSegments(path: string): string[] {
  const parts: string[] = []
  for (const raw of path.replace(/^\/+|\/+$/g, '').split('/')) {
    if (!raw || raw.toLowerCase() === '_git') continue
    parts.push(raw.toLowerCase())
  }
  return parts
}

export function normalizeGitUrl(url: string | null | undefined): string | null {
  if (!url || !String(url).trim()) return null

  let raw = String(url).trim()

  if (raw.startsWith('git@')) {
    const hostPath = raw.slice(4)
    const colon = hostPath.indexOf(':')
    if (colon >= 0) {
      const host = hostPath.slice(0, colon)
      const path = hostPath.slice(colon + 1)
      raw = `https://${host}/${path}`
    }
  }

  if (raw.startsWith('ssh://')) {
    raw = `https://${raw.slice('ssh://'.length)}`
  }

  raw = raw.replace(/\/+$/, '')
  raw = stripGitSuffix(raw)

  if (raw.startsWith('http://')) {
    raw = `https://${raw.slice('http://'.length)}`
  }

  let host = ''
  let path = ''
  try {
    const parsed = new URL(raw)
    host = (parsed.hostname || '').toLowerCase()
    path = stripGitSuffix(parsed.pathname.replace(/^\/+|\/+$/g, ''))
  } catch {
    const cleaned = raw.toLowerCase().replace('://', '/').replace(/^\/+|\/+$/g, '')
    return cleaned || null
  }

  if (!host) {
    const cleaned = raw.toLowerCase().replace('://', '/').replace(/^\/+|\/+$/g, '')
    return cleaned || null
  }

  if (host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com') {
    let parts = adoPathSegments(path)
    if (parts[0] === 'v3') parts = parts.slice(1)
    if (parts.length >= 3) {
      return `dev.azure.com/${parts[0]}/${parts[1]}/${parts[2]}`
    }
    if (parts.length) return `dev.azure.com/${parts.join('/')}`
    return null
  }

  if (host.endsWith('.visualstudio.com')) {
    const org = host.slice(0, -'.visualstudio.com'.length)
    const parts = adoPathSegments(path)
    if (org && parts.length >= 2) {
      return `dev.azure.com/${org}/${parts[0]}/${parts[1]}`
    }
    if (org && parts.length) return `dev.azure.com/${org}/${parts.join('/')}`
    return null
  }

  if (host === 'dev.azure.com') {
    const parts = adoPathSegments(path)
    if (parts.length >= 3) {
      return `dev.azure.com/${parts[0]}/${parts[1]}/${parts[2]}`
    }
    if (parts.length) return `dev.azure.com/${parts.join('/')}`
    return null
  }

  if (path) return `${host}/${path.toLowerCase()}`
  return null
}
