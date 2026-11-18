/**
 * Source transform for the Next.js config wrapper.
 *
 * Turns route, page, and `'use server'` exports into calls to the public
 * runtime helpers. Does not read Next.js internals. Client modules are left
 * unchanged so the server runtime is not pulled into the browser bundle.
 */

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

const IMPORT_LINE =
  "import { observeNextAction as __ngObserveAction, observeNextPage as __ngObservePage, observeNextRoute as __ngObserveRoute } from '@netgreener/runtime/next'\n"

export function routeTemplateFromAppFile(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/')
  const marker = '/app/'
  const idx = norm.lastIndexOf(marker)
  if (idx < 0) {
    const base = norm.split('/').pop() || 'module'
    return `/${base.replace(/\.(tsx?|jsx?)$/, '')}`
  }
  let rel = norm.slice(idx + marker.length - 1)
  rel = rel.replace(/\/(route|page)\.(tsx?|jsx?)$/, '')
  rel = rel.replace(/\/\([^/]+\)/g, '')
  if (!rel.startsWith('/')) rel = `/${rel}`
  if (rel.length > 1) rel = rel.replace(/\/+$/, '')
  return rel || '/'
}

export function transformNextEntrySource(source: string, filePath: string): string {
  if (isClientModule(source)) return source
  if (source.includes('__ngObserveRoute') || source.includes('withNetGreenerRoute')) {
    return source
  }
  const norm = filePath.replace(/\\/g, '/')
  const isRoute = /\/route\.(tsx?|jsx?)$/.test(norm)
  const isPage = /\/page\.(tsx?|jsx?)$/.test(norm)
  const isAction = isServerActionModule(source)
  if (!isRoute && !isPage && !isAction) return source

  const template = routeTemplateFromAppFile(filePath)
  let next = source
  const tails: string[] = []

  if (isRoute) {
    const cron = template === '/api/cron' || template.startsWith('/api/cron/')
    for (const method of HTTP_METHODS) {
      const wrapped = wrapHttpExport(next, method, template, cron)
      if (!wrapped) continue
      next = wrapped.code
      tails.push(wrapped.tail)
    }
  }

  if (isPage) {
    const wrapped = wrapDefaultPage(next, template)
    if (wrapped) {
      next = wrapped.code
      tails.push(wrapped.tail)
    }
  }

  if (isAction && !isRoute && !isPage) {
    const wrapped = wrapServerActions(next, template)
    next = wrapped.code
    tails.push(...wrapped.tails)
  }

  if (!tails.length) return source
  return `${insertImport(next)}\n${tails.join('\n')}\n`
}

function insertImport(source: string): string {
  const directive = /^(\uFEFF?\s*['"]use server['"]\s*;?\s*)/
  const match = directive.exec(source)
  if (!match) return `${IMPORT_LINE}${source}`
  return `${source.slice(0, match[0].length)}${IMPORT_LINE}${source.slice(match[0].length)}`
}

function isClientModule(source: string): boolean {
  return /^\uFEFF?\s*['"]use client['"]/.test(source)
}

function isServerActionModule(source: string): boolean {
  return /^\uFEFF?\s*['"]use server['"]/.test(source)
}

function jsString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function wrapHttpExport(
  source: string,
  method: string,
  template: string,
  cron: boolean,
): { code: string; tail: string } | null {
  const fn = new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`)
  const fnMatch = fn.exec(source)
  if (fnMatch) {
    const code = source.replace(fn, `${fnMatch[1] || ''}function __ng_${method}`)
    const tail = `export const ${method} = __ngObserveRoute(__ng_${method}, ${jsString(method)}, ${jsString(template)}, { cron: ${cron ? 'true' : 'false'} })`
    return { code, tail }
  }
  const decl = new RegExp(`export\\s+const\\s+${method}\\s*=\\s*`)
  const declMatch = decl.exec(source)
  if (!declMatch || declMatch.index === undefined) return null
  const exprStart = declMatch.index + declMatch[0].length
  const exprEnd = endOfAssignment(source, exprStart)
  const expr = source.slice(exprStart, exprEnd).replace(/;\s*$/, '')
  const code =
    source.slice(0, declMatch.index) +
    `const __ng_${method} = ${expr}\n` +
    source.slice(exprEnd)
  const tail = `export const ${method} = __ngObserveRoute(__ng_${method}, ${jsString(method)}, ${jsString(template)}, { cron: ${cron ? 'true' : 'false'} })`
  return { code, tail }
}

function wrapDefaultPage(
  source: string,
  template: string,
): { code: string; tail: string } | null {
  const fn = /export\s+default\s+(async\s+)?function\s+([A-Za-z0-9_]+)\b/
  const fnMatch = fn.exec(source)
  if (fnMatch) {
    const code = source.replace(fn, `${fnMatch[1] || ''}function ${fnMatch[2]}`)
    return {
      code,
      tail: `export default __ngObservePage(${fnMatch[2]}, ${jsString(template)})`,
    }
  }
  const ident = /export\s+default\s+([A-Za-z0-9_]+)\s*;?/
  const identMatch = ident.exec(source)
  if (!identMatch) return null
  const code = source.replace(ident, '')
  return {
    code,
    tail: `export default __ngObservePage(${identMatch[1]}, ${jsString(template)})`,
  }
}

function wrapServerActions(
  source: string,
  template: string,
): { code: string; tails: string[] } {
  let code = source
  const tails: string[] = []
  const fn = /export\s+(async\s+)?function\s+([A-Za-z0-9_]+)\b/g
  const names: Array<{ name: string; asyncKw: string }> = []
  for (const match of code.matchAll(fn)) {
    const name = match[2]
    if (!name || HTTP_METHODS.includes(name as (typeof HTTP_METHODS)[number])) continue
    names.push({ name, asyncKw: match[1] || '' })
  }
  for (const { name, asyncKw } of names) {
    const one = new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b`)
    if (!one.test(code)) continue
    code = code.replace(one, `${asyncKw}function __ng_action_${name}`)
    tails.push(
      `export const ${name} = __ngObserveAction(__ng_action_${name}, ${jsString(name)}, ${jsString(template)})`,
    )
  }
  return { code, tails }
}

function endOfAssignment(source: string, exprStart: number): number {
  let i = exprStart
  let depth = 0
  let quote: string | null = null
  while (i < source.length) {
    const c = source[i]
    if (quote) {
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === quote) quote = null
      i += 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      i += 1
      continue
    }
    if (c === '(' || c === '[' || c === '{') {
      depth += 1
      i += 1
      continue
    }
    if (c === ')' || c === ']' || c === '}') {
      depth = Math.max(0, depth - 1)
      i += 1
      continue
    }
    if (depth === 0 && (c === ';' || c === '\n')) return i
    i += 1
  }
  return source.length
}
