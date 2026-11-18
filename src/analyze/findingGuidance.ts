/**
 * Candidate-safe guidance for Node Analyze findings.
 *
 * resource_finding_v1 forbids extra top-level fields. Guidance belongs on
 * optional ``optimization.{hypothesis_id,summary,risk}`` — never a new property.
 * Does not upload, verify, or claim measured savings.
 */

export type MechanismGuidance = {
  hypothesis_id: string
  summary: string
  risk: 'low' | 'medium' | 'high'
}

export const MECHANISM_GUIDANCE: Record<string, MechanismGuidance> = {
  retry_amplification: {
    hypothesis_id: 'cap_retries_jitter',
    summary:
      'Cap retry attempts and add exponential backoff with jitter so failed calls do not multiply paid traffic.',
    risk: 'medium',
  },
  external_api_overconsumption: {
    hypothesis_id: 'batch_or_cache_api',
    summary:
      'Batch requests, cache stable responses, or move the call outside the hot path so cost does not scale with every item.',
    risk: 'medium',
  },
  unbounded_parallelism: {
    hypothesis_id: 'limit_concurrency',
    summary:
      'Bound concurrency with a pool or semaphore so fan-out cannot exhaust sockets, workers, or provider rate limits.',
    risk: 'high',
  },
  polling_or_idle_work: {
    hypothesis_id: 'replace_poll_sleep',
    summary:
      'Replace tight poll/sleep loops with a webhook, queue, or backoff so idle wait does not burn CPU and outbound calls.',
    risk: 'medium',
  },
  repeated_work: {
    hypothesis_id: 'reuse_computed_result',
    summary:
      'Hoist or cache repeated reads and identical work so the same payload is not fetched or recomputed every iteration.',
    risk: 'low',
  },
  process_or_runtime_churn: {
    hypothesis_id: 'reuse_runtime_process',
    summary:
      'Reuse a long-lived process or loaded model instead of spawning or reloading on every request or loop iteration.',
    risk: 'high',
  },
  memory_retention_or_materialization: {
    hypothesis_id: 'stream_or_chunk',
    summary:
      'Stream or chunk the dataset instead of materializing the full collection in memory on the hot path.',
    risk: 'medium',
  },
  per_item_instead_of_batch: {
    hypothesis_id: 'batch_per_item_work',
    summary:
      'Replace per-item lookups or inference with a batched API or join so work grows with batches, not each row.',
    risk: 'medium',
  },
}

export function optimizationForMechanism(mechanismId: string): MechanismGuidance | null {
  return MECHANISM_GUIDANCE[mechanismId] ?? null
}
