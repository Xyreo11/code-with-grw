import { Queue, type ConnectionOptions } from 'bullmq'

/**
 * The job queue.
 *
 * Ingestion and compute are asynchronous for reasons that are real even at this
 * size, not aspirational:
 *
 *   - a provider call can take seconds and must not block an HTTP response
 *   - the free tiers rate-limit by the hour, so work has to be paced and
 *     resumed rather than retried in a tight loop
 *   - compute is per-instrument and independent, so it parallelises trivially
 *   - a failed symbol must not abandon the other 25
 *
 * Every job is keyed by its natural identity (`ingest:AAPL:2026-09-04`), so
 * BullMQ deduplicates a double-enqueue and a retry re-runs an idempotent
 * upsert rather than duplicating rows.
 */

export const QUEUE_NAMES = {
  ingest: 'sitrep-ingest',
  compute: 'sitrep-compute',
} as const

export function redisConnection(): ConnectionOptions {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6380'
  const parsed = new URL(url)
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    // BullMQ requires this; without it a stalled job is retried forever.
    maxRetriesPerRequest: null,
  }
}

export interface IngestJob {
  symbol: string
  from?: string
  to?: string
}

export interface ComputeJob {
  /** Omit to recompute the whole universe. */
  symbol?: string
  from?: string
  replace?: boolean
}

let ingestQueue: Queue<IngestJob> | null = null
let computeQueue: Queue<ComputeJob> | null = null

export function getIngestQueue(): Queue<IngestJob> {
  ingestQueue ??= new Queue<IngestJob>(QUEUE_NAMES.ingest, {
    connection: redisConnection(),
    defaultJobOptions: {
      attempts: 3,
      // Long backoff on purpose: the failure we actually hit is an hourly rate
      // limit, and hammering it costs quota without ever succeeding.
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 100 },
    },
  })
  return ingestQueue
}

export function getComputeQueue(): Queue<ComputeJob> {
  computeQueue ??= new Queue<ComputeJob>(QUEUE_NAMES.compute, {
    connection: redisConnection(),
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 100 },
    },
  })
  return computeQueue
}

/** Queue depth per state, for the ops dashboard. */
export async function queueDepths() {
  try {
    const [ingest, compute] = await Promise.all([
      getIngestQueue().getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      getComputeQueue().getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
    ])
    return { ingest, compute, reachable: true as const }
  } catch {
    // The app must render without Redis. The queue accelerates ingestion; it is
    // not on the read path, and the ops page should say so rather than 500.
    return { ingest: null, compute: null, reachable: false as const }
  }
}

export async function closeQueues() {
  await Promise.all([ingestQueue?.close(), computeQueue?.close()])
  ingestQueue = null
  computeQueue = null
}
