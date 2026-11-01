/**
 * Collect structured external-API declarations for Analyze output.
 *
 * Twin of Python ``declared_external_apis.py``: seeds the server catalog via
 * ``POST /findings/batch`` when a caller uploads. Node Analyze CLI remains
 * ``upload=never``; this only builds the payload (package.json + static imports).
 *
 * See ``docs/EXTERNAL_API_PR_TO_RELEASE.md``.
 */

export type DeclaredExternalApiEntry = {
  provider_key: string
  detection_method: string
  module_roots: string[]
  file_paths: string[]
}

/**
 * npm / import package roots → catalog ``provider_key``
 * (aligned with Python ``_IMPORT_ROOT_TO_PROVIDER`` + server DEFAULT_PROVIDERS).
 */
const PACKAGE_ROOT_TO_PROVIDER: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  '@anthropic-ai/sdk': 'anthropic',
  stripe: 'stripe',
  twilio: 'twilio',
  sendgrid: 'sendgrid',
  '@sendgrid/mail': 'sendgrid',
  '@sendgrid/client': 'sendgrid',
  boto3: 'boto3',
  botocore: 'boto3',
  google: 'google',
  googleapis: 'google',
  '@google/generative-ai': 'google',
  '@google-cloud/vertexai': 'google',
  generativelanguage: 'google',
  cohere: 'cohere',
  'cohere-ai': 'cohere',
  huggingface: 'huggingface',
  '@huggingface/inference': 'huggingface',
  '@huggingface/transformers': 'huggingface',
  '@xenova/transformers': 'huggingface',
  azure: 'azure_document_intelligence',
  '@azure/ai-form-recognizer': 'azure_document_intelligence',
  'azure-ai-form-recognizer': 'azure_document_intelligence',
  '@aws-sdk/client-textract': 'aws_textract',
}

/** Known paid roots used when map miss but name is still a paid SDK (Python PAID_API_MODULE_ROOTS twin). */
const PAID_PACKAGE_ROOTS = new Set<string>([
  ...Object.keys(PACKAGE_ROOT_TO_PROVIDER),
  '@aws-sdk/client-bedrock-runtime',
  '@aws-sdk/client-sagemaker-runtime',
])

const IMPORT_RE =
  /(?:from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*\(\s*['"]([^'"]+)['"]\s*\))/g

function normalizePackageRoot(spec: string): string {
  const text = String(spec || '')
    .trim()
    .replace(/\\/g, '/')
  if (!text || text.startsWith('.') || text.startsWith('/') || text.startsWith('node:')) {
    return ''
  }
  // Strip subpath: openai/resources → openai; @scope/pkg/sub → @scope/pkg
  if (text.startsWith('@')) {
    const parts = text.split('/')
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`.toLowerCase()
    return text.toLowerCase()
  }
  return text.split('/')[0]!.toLowerCase()
}

function providerForPackageRoot(root: string): string | null {
  if (!root) return null
  const mapped = PACKAGE_ROOT_TO_PROVIDER[root]
  if (mapped) return mapped
  if (root.startsWith('@aws-sdk/client-textract')) return 'aws_textract'
  if (root.startsWith('@aws-sdk/')) return 'boto3'
  if (root.startsWith('@google-cloud/')) return 'google'
  if (PAID_PACKAGE_ROOTS.has(root)) {
    return PACKAGE_ROOT_TO_PROVIDER[root] ?? root.replace(/^@/, '').split('/')[0] ?? root
  }
  return null
}

type AccRow = {
  provider_key: string
  detection_methods: Set<string>
  module_roots: Set<string>
  file_paths: Set<string>
}

function ensureRow(providers: Map<string, AccRow>, providerKey: string): AccRow {
  let row = providers.get(providerKey)
  if (!row) {
    row = {
      provider_key: providerKey,
      detection_methods: new Set(),
      module_roots: new Set(),
      file_paths: new Set(),
    }
    providers.set(providerKey, row)
  }
  return row
}

function addPackage(
  providers: Map<string, AccRow>,
  packageRoot: string,
  relPath: string,
  detectionMethod: string,
): void {
  const root = normalizePackageRoot(packageRoot)
  const providerKey = providerForPackageRoot(root)
  if (!providerKey) return
  const row = ensureRow(providers, providerKey)
  row.detection_methods.add(detectionMethod)
  row.module_roots.add(root)
  if (relPath) row.file_paths.add(relPath.replace(/\\/g, '/'))
}

/** Extract package specs from JS/TS import / require / dynamic import. */
export function extractImportPackageRoots(source: string): string[] {
  const roots = new Set<string>()
  IMPORT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IMPORT_RE.exec(source)) != null) {
    const spec = m[1] || m[2] || m[3] || ''
    const root = normalizePackageRoot(spec)
    if (root) roots.add(root)
  }
  return [...roots]
}

export type CollectDeclaredExternalApisInput = {
  /** path → source (repo-relative keys). */
  sources?: Record<string, string>
  /** Parsed package.json dependencies (merged deps + optional peer/optional). */
  packageDependencies?: Record<string, string> | null
  /** Label for package.json file_paths (default ``package.json``). */
  packageJsonPath?: string
}

/**
 * Build ``declared_external_apis`` rows for analyze / findings-batch.
 */
export function collectDeclaredExternalApis(
  input: CollectDeclaredExternalApisInput = {},
): DeclaredExternalApiEntry[] {
  const providers = new Map<string, AccRow>()

  const deps = input.packageDependencies
  if (deps && typeof deps === 'object') {
    const pkgPath = (input.packageJsonPath || 'package.json').replace(/\\/g, '/')
    for (const name of Object.keys(deps)) {
      addPackage(providers, name, pkgPath, 'package_json')
    }
  }

  const sources = input.sources
  if (sources && typeof sources === 'object') {
    for (const [relPath, source] of Object.entries(sources)) {
      if (typeof source !== 'string') continue
      for (const root of extractImportPackageRoots(source)) {
        addPackage(providers, root, relPath, 'static_import')
      }
    }
  }

  const out: DeclaredExternalApiEntry[] = []
  for (const key of [...providers.keys()].sort()) {
    const row = providers.get(key)!
    // Prefer static_import when both package.json and source imports saw the provider.
    const method = row.detection_methods.has('static_import')
      ? 'static_import'
      : row.detection_methods.has('package_json')
        ? 'package_json'
        : 'static_import'

    out.push({
      provider_key: row.provider_key,
      detection_method: method,
      module_roots: [...row.module_roots].sort(),
      file_paths: [...row.file_paths].sort(),
    })
  }
  return out
}

/** Read dependency map from a package.json object. */
export function dependencyMapFromPackageJson(
  pkg: unknown,
): Record<string, string> | null {
  if (!pkg || typeof pkg !== 'object') return null
  const o = pkg as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const block = o[key]
    if (!block || typeof block !== 'object') continue
    for (const [name, ver] of Object.entries(block as Record<string, unknown>)) {
      if (typeof name === 'string' && name) out[name] = String(ver ?? '')
    }
  }
  return Object.keys(out).length ? out : null
}
