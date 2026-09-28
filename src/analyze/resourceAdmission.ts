/**
 * MP4 default-deny admission stub for Analyze candidates.
 *
 * Used by ``toResourceFindingCandidate`` before emitting ``resource_finding_v1``.
 * Rejects clearly non-resource categories so Node cannot silently copy Python
 * legacy finding types into the resource path. Shared policy / TCK remain
 * authoritative when fully wired.
 */

/** Categories that must never enter the resource Analyze/Optimize path. */
export const NON_RESOURCE_CATEGORIES = [
  'hardcoded_secret',
  'security',
  'sql_injection',
  'architecture',
  'style',
  'maintainability',
  'missing_test',
  'generic_complexity',
  'generic_reliability',
  'generic_correctness',
] as const

export type NonResourceCategory = (typeof NON_RESOURCE_CATEGORIES)[number]

/** Domains allowed to become resource candidates (scaffold allow-list). */
export const RESOURCE_DOMAINS = [
  'cpu',
  'gpu',
  'memory',
  'io',
  'network',
  'energy',
  'external_api',
  'quality_outcome',
  // Contract primary_domain aliases (resource_finding_v1)
  'compute.cpu',
  'compute.gpu',
  'memory.host',
  'memory.gpu',
  'storage.io',
  'network.io',
] as const

export type ResourceDomain = (typeof RESOURCE_DOMAINS)[number]

/** Map contract primary_domain → short admission key when needed. */
const DOMAIN_ALIASES: Record<string, string> = {
  'compute.cpu': 'cpu',
  'compute.gpu': 'gpu',
  'memory.host': 'memory',
  'memory.gpu': 'memory',
  'storage.io': 'io',
  'network.io': 'network',
}

export type AdmissionDecision =
  | {
      admitted: true
      domain: ResourceDomain
      reason: 'resource_domain_allowlisted'
    }
  | {
      admitted: false
      reason: 'non_resource_category' | 'unknown_or_missing_domain' | 'explicit_deny'
      category?: string
      detail?: string
    }

const NON_RESOURCE_SET = new Set<string>(NON_RESOURCE_CATEGORIES)
const RESOURCE_SET = new Set<string>(RESOURCE_DOMAINS)

function normalizeDomain(domain: string): string {
  const d = domain.trim().toLowerCase()
  return DOMAIN_ALIASES[d] || d
}

/**
 * Default-deny: admit only when ``domain`` is a known resource domain and
 * ``category`` (if present) is not a forbidden non-resource class.
 */
export function admitAnalyzeCandidate(input: {
  domain?: string | null
  category?: string | null
}): AdmissionDecision {
  const category = String(input.category || '')
    .trim()
    .toLowerCase()
  if (category && NON_RESOURCE_SET.has(category)) {
    return {
      admitted: false,
      reason: 'non_resource_category',
      category,
      detail: 'legacy/non-resource finding classes are rejected by default-deny',
    }
  }
  const raw = String(input.domain || '')
    .trim()
    .toLowerCase()
  const domain = normalizeDomain(raw)
  if (!domain || (!RESOURCE_SET.has(domain) && !RESOURCE_SET.has(raw))) {
    return {
      admitted: false,
      reason: 'unknown_or_missing_domain',
      detail: 'resource Analyze requires an allowlisted primary domain',
    }
  }
  const admittedDomain = (RESOURCE_SET.has(raw) ? raw : domain) as ResourceDomain
  return {
    admitted: true,
    domain: admittedDomain,
    reason: 'resource_domain_allowlisted',
  }
}

export function isNonResourceCategory(category: string): boolean {
  return NON_RESOURCE_SET.has(String(category || '').trim().toLowerCase())
}
