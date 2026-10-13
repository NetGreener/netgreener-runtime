/**
 * MP4 Analyze scaffold — JS/TS service discovery (experimental).
 *
 * Twin of Python ``netgreener.service_discovery`` for Node ecosystems.
 * Heuristic / regex extraction only (no TypeScript AST yet). Additive: does
 * **not** wire into CLI upload, VSCE, or the RunSession pipeline.
 *
 * Canonical ``service_unit`` keys match runtime:
 *   - endpoints: ``"<METHOD> <path>"``
 *   - tasks: ``"task:<name>"``
 */

export type ServiceEndpointUnit = {
  service_unit: string
  unit_type: 'endpoint'
  method: string
  path: string
  handler: string
  file: string
  line: number
  end_line: number
  is_async: boolean
  dynamic: boolean
  prefix_resolved: boolean
  /** Heuristic extractor confidence — not measured runtime evidence. */
  evidence: 'heuristic_source'
}

export type ServiceTaskUnit = {
  service_unit: string
  unit_type: 'task'
  name: string
  handler: string
  file: string
  line: number
  end_line: number
  evidence: 'heuristic_source'
}

export type ServiceFileExtraction = {
  frameworks: string[]
  endpoints: ServiceEndpointUnit[]
  tasks: ServiceTaskUnit[]
}

export type ServiceManifestV0 = {
  schema: 'service_manifest_v0'
  contract_status: 'mp4_scaffold'
  framework: string | null
  frameworks_detected: string[]
  entry_files: string[]
  endpoints: ServiceEndpointUnit[]
  tasks: ServiceTaskUnit[]
  stats: {
    endpoints: number
    tasks: number
    files_with_units: number
  }
  notes: string[]
}

const FRAMEWORK_IMPORT_HINTS: Array<{ id: string; pattern: RegExp }> = [
  { id: 'express', pattern: /\bfrom\s+['"]express['"]|\brequire\(\s*['"]express['"]\s*\)/ },
  { id: 'fastify', pattern: /\bfrom\s+['"]fastify['"]|\brequire\(\s*['"]fastify['"]\s*\)/ },
  {
    id: 'nest',
    pattern: /\bfrom\s+['"]@nestjs\/(common|core|platform-express|platform-fastify)['"]/,
  },
  { id: 'bullmq', pattern: /\bfrom\s+['"]bullmq['"]|\brequire\(\s*['"]bullmq['"]\s*\)/ },
  { id: 'next', pattern: /\bfrom\s+['"]next(\/|['"])|\brequire\(\s*['"]next['"]\s*\)/ },
]

const HTTP_ROUTE =
  /\b(?:app|router|server|fastify|instance)\.(get|post|put|delete|patch|head|options)\(\s*['"`]([^'"`]+)['"`]/gi
const NEST_MAPPING =
  /@(Get|Post|Put|Delete|Patch|Head|Options)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g
const BULLMQ_QUEUE_ADD = /\.add\(\s*['"`]([A-Za-z0-9_.:-]+)['"`]/g

function lineOf(source: string, index: number): number {
  if (index <= 0) return 1
  let line = 1
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1
  }
  return line
}

function looksDynamic(path: string): boolean {
  return path.includes(':') || path.includes('*') || path.includes('{')
}

function normalizePath(path: string): string {
  if (!path) return '/'
  return path.startsWith('/') ? path : `/${path}`
}

/** Frameworks whose imports / requires appear in ``source``. */
export function detectFrameworks(source: string): string[] {
  const found: string[] = []
  for (const hint of FRAMEWORK_IMPORT_HINTS) {
    if (hint.pattern.test(source) && !found.includes(hint.id)) {
      found.push(hint.id)
    }
  }
  return found
}

function collectHttpRoutes(source: string, relPath: string): ServiceEndpointUnit[] {
  const endpoints: ServiceEndpointUnit[] = []
  const re = new RegExp(HTTP_ROUTE.source, HTTP_ROUTE.flags)
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    const method = (match[1] || 'get').toUpperCase()
    const path = normalizePath(match[2] || '/')
    const start = lineOf(source, match.index)
    endpoints.push({
      service_unit: `${method} ${path}`,
      unit_type: 'endpoint',
      method,
      path,
      handler: '<heuristic>',
      file: relPath,
      line: start,
      end_line: start,
      is_async: false,
      dynamic: looksDynamic(path),
      prefix_resolved: false,
      evidence: 'heuristic_source',
    })
  }
  return endpoints
}

function collectNestRoutes(source: string, relPath: string): ServiceEndpointUnit[] {
  const endpoints: ServiceEndpointUnit[] = []
  const re = new RegExp(NEST_MAPPING.source, NEST_MAPPING.flags)
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    const method = (match[1] || 'Get').toUpperCase()
    const pathRaw = match[2]
    const path = pathRaw && pathRaw.length ? normalizePath(pathRaw) : '/'
    const start = lineOf(source, match.index)
    endpoints.push({
      service_unit: `${method} ${path}`,
      unit_type: 'endpoint',
      method,
      path,
      handler: '<nest-heuristic>',
      file: relPath,
      line: start,
      end_line: start,
      is_async: false,
      dynamic: looksDynamic(path),
      prefix_resolved: false,
      evidence: 'heuristic_source',
    })
  }
  return endpoints
}

function collectBullMqTasks(source: string, relPath: string): ServiceTaskUnit[] {
  const tasks: ServiceTaskUnit[] = []
  const seen = new Set<string>()
  const re = new RegExp(BULLMQ_QUEUE_ADD.source, BULLMQ_QUEUE_ADD.flags)
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    const name = String(match[1] || '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    const start = lineOf(source, match.index)
    tasks.push({
      service_unit: `task:${name}`,
      unit_type: 'task',
      name,
      handler: '<bullmq-heuristic>',
      file: relPath,
      line: start,
      end_line: start,
      evidence: 'heuristic_source',
    })
  }
  return tasks
}

function dedupeUnits<T extends { service_unit: string; file: string; line: number }>(
  items: T[],
): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const key = `${item.service_unit}|${item.file}|${item.line}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * Extract service units from one JS/TS source string.
 * Never throws on bad source — returns empty collections.
 */
export function extractServiceUnits(
  sourceCode: string,
  relPath = '<unknown>',
): ServiceFileExtraction {
  const source = String(sourceCode || '')
  const frameworks = detectFrameworks(source)
  const endpoints: ServiceEndpointUnit[] = [
    ...collectHttpRoutes(source, relPath),
    ...(frameworks.includes('nest') ? collectNestRoutes(source, relPath) : []),
  ]
  const tasks: ServiceTaskUnit[] =
    frameworks.includes('bullmq') || /\bbullmq\b/.test(source)
      ? collectBullMqTasks(source, relPath)
      : []

  return {
    frameworks,
    endpoints: dedupeUnits(endpoints),
    tasks: dedupeUnits(tasks),
  }
}

/** Project-level ``service_manifest_v0`` from ``{relPath: source}``. */
export function buildServiceManifest(
  fileSources: Record<string, string>,
): ServiceManifestV0 {
  const frameworksDetected: string[] = []
  const endpoints: ServiceEndpointUnit[] = []
  const tasks: ServiceTaskUnit[] = []
  const entryFiles = new Set<string>()

  for (const [relPath, source] of Object.entries(fileSources)) {
    const extracted = extractServiceUnits(source, relPath)
    for (const fw of extracted.frameworks) {
      if (!frameworksDetected.includes(fw)) frameworksDetected.push(fw)
    }
    if (extracted.endpoints.length || extracted.tasks.length) {
      entryFiles.add(relPath)
    }
    endpoints.push(...extracted.endpoints)
    tasks.push(...extracted.tasks)
  }

  let framework: string | null = null
  if (endpoints.length && frameworksDetected.includes('express')) framework = 'express'
  else if (endpoints.length && frameworksDetected.includes('fastify')) framework = 'fastify'
  else if (endpoints.length && frameworksDetected.includes('nest')) framework = 'nest'
  else if (tasks.length && frameworksDetected.includes('bullmq')) framework = 'bullmq'
  else if (frameworksDetected.length) framework = frameworksDetected[0]

  return {
    schema: 'service_manifest_v0',
    contract_status: 'mp4_scaffold',
    framework,
    frameworks_detected: frameworksDetected,
    entry_files: [...entryFiles].sort(),
    endpoints,
    tasks,
    stats: {
      endpoints: endpoints.length,
      tasks: tasks.length,
      files_with_units: entryFiles.size,
    },
    notes: [
      'MP4 scaffold: heuristic JS/TS discovery only — not TypeScript AST, not CLI/VSCE wired, not resource findings',
      'Does not modify RunSession upload or runtime metering pipelines',
    ],
  }
}

export function isServiceProject(manifest: ServiceManifestV0): boolean {
  return Boolean(manifest.stats.endpoints || manifest.stats.tasks)
}
