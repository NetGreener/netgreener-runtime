/**
 * Observation semantic-projection helpers (ADR 0008 D2 twin).
 *
 * Additive helper for golden parity. Does not change upload/emit paths.
 */
import { createHash } from 'node:crypto'

export function projectValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) {
      if (obj[key] !== null && obj[key] !== undefined) {
        out[key] = projectValue(obj[key])
      }
    }
    return out
  }
  if (Array.isArray(value)) {
    return value.map((item) => projectValue(item))
  }
  return value
}

export function projectionBytes(document: Record<string, unknown>): Buffer {
  const projected = projectValue(document)
  return Buffer.from(JSON.stringify(projected), 'utf8')
}

export function projectionDigest(document: Record<string, unknown>): string {
  return 'sha256:' + createHash('sha256').update(projectionBytes(document)).digest('hex')
}
