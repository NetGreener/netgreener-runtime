/**
 * Compatible ``service_runtime_v0.collector`` metadata values for
 * ``@netgreener/runtime`` observation origins in legacy RunSession projections.
 *
 * These identify *where the observation came from* inside the Node emitter —
 * not separate general-purpose collectors, and not APM/vendor products.
 *
 * N6 packaging doc twin: ``PACKAGING.md``.
 */

/** Known collector metadata strings emitted by this package. */
export const COMPATIBLE_COLLECTOR_METADATA = [
  'express_middleware',
  'fastify_middleware',
  'nest_express_middleware',
  'nest_fastify_middleware',
  'node_process',
  'bullmq_worker',
  'outbound_http',
] as const

export type CompatibleCollectorMetadata =
  (typeof COMPATIBLE_COLLECTOR_METADATA)[number]

const COLLECTOR_SET = new Set<string>(COMPATIBLE_COLLECTOR_METADATA)

export function isCompatibleCollectorMetadata(value: string): boolean {
  return COLLECTOR_SET.has(String(value || '').trim())
}

/** Short descriptions for packaging / dogfood docs (not user-facing UI copy). */
export const COLLECTOR_METADATA_NOTES: Record<CompatibleCollectorMetadata, string> = {
  express_middleware: 'Express middleware request/response metering origin',
  fastify_middleware: 'Fastify plugin request/response metering origin',
  nest_express_middleware: 'Nest on Express adapter middleware origin',
  nest_fastify_middleware: 'Nest on Fastify adapter middleware origin',
  node_process: 'Process/cron helper origin (no HTTP framework)',
  bullmq_worker: 'BullMQ worker job flush origin',
  outbound_http: 'Outbound fetch/axios/undici external API meter origin',
}
