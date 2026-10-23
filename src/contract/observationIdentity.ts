/**
 * Observation identity-preimage helpers (ADR 0008 D3 twin).
 *
 * Additive helper for golden parity. Does not mint IDs in emit/upload paths.
 */
import { createHash } from 'node:crypto'

export const DOMAINS = {
  runtime_instance: 'netgreener.observation.v1/runtime-instance',
  event: 'netgreener.observation.v1/event',
  batch: 'netgreener.observation.v1/batch',
  runtime_window: 'netgreener.observation.v1/runtime-window',
} as const

const PREFIX_BY_DOMAIN: Record<string, string> = {
  [DOMAINS.runtime_instance]: 'rti',
  [DOMAINS.event]: 'evt',
  [DOMAINS.batch]: 'bat',
  [DOMAINS.runtime_window]: 'rtw',
}

export function lengthPrefixed(parts: Array<string | Buffer>): Buffer {
  const chunks: Buffer[] = []
  for (const part of parts) {
    const raw = typeof part === 'string' ? Buffer.from(part, 'utf8') : part
    const header = Buffer.alloc(4)
    header.writeUInt32BE(raw.length, 0)
    chunks.push(header, raw)
  }
  return Buffer.concat(chunks)
}

export function identityDigest(domain: string, ...components: string[]): string {
  return createHash('sha256')
    .update(lengthPrefixed([domain, ...components]))
    .digest('hex')
}

export function formatId(prefix: string, digestHex: string): string {
  if (digestHex.length !== 64 || !/^[0-9a-f]+$/.test(digestHex)) {
    throw new Error('digest must be 64 lowercase hex chars')
  }
  return `${prefix}_${digestHex}`
}

export function identityId(
  prefix: string,
  domain: string,
  components: string[],
): string {
  return formatId(prefix, identityDigest(domain, ...components))
}

export function prefixForDomain(domain: string): string {
  const prefix = PREFIX_BY_DOMAIN[domain]
  if (!prefix) throw new Error(`unknown identity domain: ${domain}`)
  return prefix
}
