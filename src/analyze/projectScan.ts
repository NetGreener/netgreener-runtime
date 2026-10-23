/**
 * Bounded project walk for MP4 Analyze scaffold.
 * Never touches RunSession upload. Skips node_modules / dist / .git by default.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import {
  buildServiceManifest,
  nextFileRoutePath,
  type ServiceManifestV0,
} from './serviceDiscovery.js'

/** Default Analyze walk cap — large enough for Next App Router trees. */
export const DEFAULT_MAX_SOURCE_FILES = 5000
const WALK_SAFETY_CAP = 20_000

const DEFAULT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'])

const DEFAULT_SKIP_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  'out',
])

export type ListCandidateSourceFilesOptions = {
  /** Max files to return (default 5000). */
  maxFiles?: number
  /** Max bytes to read per file when building a manifest (default 512 KiB). */
  maxFileBytes?: number
  extensions?: Iterable<string>
  skipDirNames?: Iterable<string>
}

function normalizeRel(path: string): string {
  return path.split(sep).join('/')
}

function scanRank(rel: string): number {
  const n = rel.replace(/\\/g, '/')
  if (nextFileRoutePath(n)) return 0
  if (
    n.startsWith('app/') ||
    n.startsWith('src/app/') ||
    n.startsWith('pages/') ||
    n.startsWith('src/pages/')
  ) {
    return 1
  }
  if (n.startsWith('src/')) return 2
  return 3
}

/**
 * List repo-relative JS/TS source paths under ``projectDir`` (bounded).
 * Never throws — returns [] on errors.
 */
export function listCandidateSourceFiles(
  projectDir: string,
  opts: ListCandidateSourceFilesOptions = {},
): string[] {
  const maxFiles = Math.max(1, opts.maxFiles ?? DEFAULT_MAX_SOURCE_FILES)
  const extensions = new Set(
    [...(opts.extensions ?? DEFAULT_EXTENSIONS)].map((e) => e.toLowerCase()),
  )
  const skip = new Set(
    [...(opts.skipDirNames ?? DEFAULT_SKIP_DIR_NAMES)].map((n) => n.toLowerCase()),
  )
  const out: string[] = []

  const walk = (absDir: string): void => {
    if (out.length >= WALK_SAFETY_CAP) return
    let entries
    try {
      entries = readdirSync(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= WALK_SAFETY_CAP) return
      const name = entry.name
      if (name.startsWith('.') && name !== '.env.example') {
        // skip hidden dirs/files except harmless examples
        if (entry.isDirectory()) continue
      }
      const abs = join(absDir, name)
      if (entry.isDirectory()) {
        if (skip.has(name.toLowerCase())) continue
        walk(abs)
        continue
      }
      if (!entry.isFile()) continue
      const lower = name.toLowerCase()
      const dot = lower.lastIndexOf('.')
      if (dot < 0) continue
      const ext = lower.slice(dot)
      if (!extensions.has(ext)) continue
      out.push(normalizeRel(relative(projectDir, abs)))
    }
  }

  try {
    const st = statSync(projectDir)
    if (!st.isDirectory()) return []
  } catch {
    return []
  }
  walk(projectDir)
  out.sort((a, b) => scanRank(a) - scanRank(b) || a.localeCompare(b))
  return out.slice(0, maxFiles)
}

/**
 * Read supplied repo-relative paths (or auto-walk) and build ``service_manifest_v0``.
 * Never throws — empty-but-shaped manifest on any error.
 */
export function buildServiceManifestFromPaths(
  projectDir: string,
  relPaths?: Iterable<string> | null,
  opts: ListCandidateSourceFilesOptions = {},
): ServiceManifestV0 {
  try {
    const maxFileBytes = Math.max(1024, opts.maxFileBytes ?? 512 * 1024)
    const paths = relPaths
      ? [...relPaths].filter(Boolean).map((p) => normalizeRel(String(p)))
      : listCandidateSourceFiles(projectDir, opts)
    const sources: Record<string, string> = {}
    for (const rel of paths) {
      try {
        const abs = join(projectDir, rel)
        const st = statSync(abs)
        if (!st.isFile() || st.size > maxFileBytes) continue
        sources[rel] = readFileSync(abs, { encoding: 'utf8' })
      } catch {
        continue
      }
    }
    const manifest = buildServiceManifest(sources)
    const scanned = Object.keys(sources).length
    const maxFiles = Math.max(1, opts.maxFiles ?? DEFAULT_MAX_SOURCE_FILES)
    manifest.notes = [
      ...manifest.notes,
      `scanned_files=${scanned}`,
      relPaths ? 'paths=explicit' : 'paths=auto_walk',
      ...( !relPaths && scanned >= maxFiles
        ? [`scan_truncated=true max_files=${maxFiles}`]
        : []),
    ]
    return manifest
  } catch {
    return buildServiceManifest({})
  }
}
