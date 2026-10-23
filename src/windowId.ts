import { createHash, randomBytes } from 'node:crypto'

/** api_server pattern: rtw_ + 64 lowercase hex (68 chars total). */
export function newRuntimeWindowId(): string {
  const material = `${Date.now()}-${randomBytes(32).toString('hex')}`
  const digest = createHash('sha256').update(material).digest('hex')
  return `rtw_${digest}`
}
