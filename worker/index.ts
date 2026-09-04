import 'dotenv/config'
import { Worker, type Job } from 'bullmq'
import { db } from '../src/lib/db'
import {
  QUEUE_NAMES,
  redisConnection,
  getComputeQueue,
  getIngestQueue,
  type ComputeJob,
  type IngestJob,
} from '../src/lib/queue'
import { computeAndPersist } from '../src/lib/compute'
import { TwelveDataSource } from '../src/lib/sources/twelvedata'
import { TiingoSource } from '../src/lib/sources/tiingo'
import { validateBars } from '../src/lib/ingest/validate'
import { reconcileSeries } from '../src/lib/ingest/reconcile'
import { FixtureSource, fixtureMode } from '../src/lib/sources/fixture'
import type { RawBar } from '../src/lib/sources/types'

/**
 * The worker process.
 *
 * Runs the same ingestion and compute code the scripts do — deliberately, so
 * there is exactly one implementation of each and no chance of the queued path
 * drifting from the one that was calibrated.
 *
 * Started separately from the web app (`npm run worker`). The web process only
 * ever enqueues; it never does provider I/O on a request thread.
 */

const CONCURRENCY = {
  // Bounded by provider rate limits, not by CPU. Twelve Data allows 8/min and
  // Tiingo 50/hour, so more parallelism here buys nothing but 429s.
  ingest: 1,
  // Compute is pure arithmetic over in-memory arrays; this is CPU-bound.
  compute: 2,
}

async function handleIngest(job: Job<IngestJob>) {
  const { symbol, from, to } = job.data

  const instrument = await db.instrument.findUnique({
    where: { symbol },
    select: { id: true },
  })
  if (!instrument) throw new Error(`unknown symbol ${symbol}`)

  const run = await db.ingestRun.create({
    data: { sourceId: 'twelvedata', status: 'running', note: `queued:${symbol}` },
  })

  const series: Array<{ sourceId: string; trustRank: number; bars: RawBar[] }> = []
  let rejected = 0

  // Each source is attempted independently: losing the secondary degrades the
  // bar to single-source rather than failing the whole job.
  for (const [sourceId, trustRank, fetcher] of sources()) {
    try {
      const bars = await fetcher(symbol, from, to)
      const validated = validateBars(bars)
      rejected += validated.rejected.length
      for (const r of validated.rejected) {
        await db.deadLetter.create({
          data: {
            sourceId,
            symbol,
            payload: r.bar as unknown as object,
            reason: r.reason,
          },
        })
      }
      if (validated.valid.length) {
        series.push({ sourceId, trustRank, bars: validated.valid })
      }
    } catch (e) {
      await db.dataFreshness.upsert({
        where: { sourceId_kind: { sourceId, kind: 'bar' } },
        create: {
          sourceId,
          kind: 'bar',
          lastAttempt: new Date(),
          lastError: (e as Error).message.slice(0, 300),
          consecutiveFailures: 1,
        },
        update: {
          lastAttempt: new Date(),
          lastError: (e as Error).message.slice(0, 300),
          consecutiveFailures: { increment: 1 },
        },
      })
      // Rethrow only if NO source produced anything; a partial result is still
      // worth persisting.
      if (series.length === 0 && sourceId === 'tiingo') throw e
    }
  }

  if (series.length === 0) {
    await db.ingestRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), status: 'failed', rowsRejected: rejected },
    })
    throw new Error(`no usable data for ${symbol}`)
  }

  const { bars, conflicts } = reconcileSeries(series)

  await db.dailyBar.createMany({
    data: bars.map((r) => ({
      instrumentId: instrument.id,
      barDate: new Date(`${r.bar.date}T00:00:00Z`),
      open: r.bar.open,
      high: r.bar.high,
      low: r.bar.low,
      close: r.bar.close,
      closeAdj: r.bar.closeAdj,
      volume: BigInt(Math.round(r.bar.volume)),
      source: r.source,
      asOf: new Date(`${r.bar.date}T21:00:00Z`),
      confidence: r.confidence,
      confirmed: r.confirmed,
    })),
    skipDuplicates: true,
  })

  if (conflicts.length) {
    await db.barConflict.createMany({
      data: conflicts.map((c) => ({
        instrumentId: instrument.id,
        barDate: new Date(`${c.date}T00:00:00Z`),
        field: c.field,
        sourceA: c.sourceA,
        valueA: c.valueA,
        sourceB: c.sourceB,
        valueB: c.valueB,
        deltaPct: c.deltaPct,
        resolvedTo: c.resolvedTo,
      })),
      skipDuplicates: true,
    })
  }

  await db.ingestRun.update({
    where: { id: run.id },
    data: {
      finishedAt: new Date(),
      status: series.length === 2 ? 'ok' : 'partial',
      rowsIn: bars.length,
      rowsRejected: rejected,
    },
  })

  for (const s of series) {
    await db.dataFreshness.upsert({
      where: { sourceId_kind: { sourceId: s.sourceId, kind: 'bar' } },
      create: {
        sourceId: s.sourceId,
        kind: 'bar',
        lastSuccess: new Date(),
        lastAttempt: new Date(),
      },
      update: {
        lastSuccess: new Date(),
        lastAttempt: new Date(),
        consecutiveFailures: 0,
        lastError: null,
        breakerState: 'CLOSED',
      },
    })
  }

  return { symbol, bars: bars.length, conflicts: conflicts.length }
}

function sources(): Array<
  [string, number, (s: string, from?: string, to?: string) => Promise<RawBar[]>]
> {
  const out: Array<
    [string, number, (s: string, from?: string, to?: string) => Promise<RawBar[]>]
  > = []

  // FIXTURE_MODE is a hard gate, checked before the keys are even read.
  //
  // It used to be documented and unimplemented: with keys present the worker
  // made live calls regardless, and clone-and-run worked only because a keyless
  // checkout produced an empty source list. A promise of "no network" that
  // depends on the absence of credentials is not a promise.
  if (fixtureMode()) {
    const td = new FixtureSource('twelvedata', 1)
    const tg = new FixtureSource('tiingo', 2)
    out.push(['twelvedata', 1, (sym, from, to) => td.fetchDailyBars(sym, { from, to })])
    out.push(['tiingo', 2, (sym, from, to) => tg.fetchDailyBars(sym, { from, to })])
    return out
  }

  if (process.env.TWELVE_DATA_API_KEY) {
    const td = new TwelveDataSource(process.env.TWELVE_DATA_API_KEY)
    out.push(['twelvedata', 1, (s, from, to) => td.fetchDailyBars(s, { from, to })])
  }
  if (process.env.TIINGO_API_KEY) {
    const tg = new TiingoSource(process.env.TIINGO_API_KEY)
    out.push(['tiingo', 2, (s, from, to) => tg.fetchDailyBars(s, { from, to })])
  }

  return out
}

async function handleCompute(job: Job<ComputeJob>) {
  const { from, replace } = job.data
  const result = await computeAndPersist({ from, replace })
  return result
}

/**
 * BullMQ forbids ":" in a custom job id, so natural keys are hyphen-separated.
 *
 * Deliberately unique per settled batch rather than bucketed by hour. Hourly
 * ids looked like sensible deduplication and were in fact a correctness bug:
 * the first (premature) compute of an hour claimed the id, so the real
 * follow-up recompute after the batch finished was silently swallowed as a
 * duplicate. Debouncing is what prevents redundant computes now; the id only
 * has to be unique.
 */
function computeJobId(): string {
  return `compute-${Date.now()}`
}

async function main() {
  const connection = redisConnection()

  const ingestWorker = new Worker<IngestJob>(QUEUE_NAMES.ingest, handleIngest, {
    connection,
    concurrency: CONCURRENCY.ingest,
  })

  const computeWorker = new Worker<ComputeJob>(
    QUEUE_NAMES.compute,
    handleCompute,
    { connection, concurrency: CONCURRENCY.compute },
  )

  for (const [name, worker] of [
    ['ingest', ingestWorker],
    ['compute', computeWorker],
  ] as const) {
    worker.on('completed', (job, result) => {
      console.log(`[${name}] ${job.id} done`, JSON.stringify(result))
    })
    worker.on('failed', (job, err) => {
      console.error(`[${name}] ${job?.id} failed: ${err.message}`)
    })
    worker.on('error', (err) => {
      // Worker-level errors (connection blips) are logged, not fatal.
      console.error(`[${name}] worker error: ${err.message}`)
    })
  }

  // Recompute once, after the whole batch has actually landed.
  //
  // `drained` is the obvious hook and it is the wrong one. BullMQ emits it
  // whenever the WAIT list empties, which happens repeatedly mid-batch while
  // jobs are still active - a 26-symbol run fired it after 9. Compute then read
  // a two-thirds-updated universe, which is exactly the thing the batching
  // exists to prevent, and the hourly job id turned the correct follow-up into
  // a no-op duplicate.
  //
  // So: debounce on completion, then verify the queue is genuinely empty before
  // enqueueing. Features for one instrument depend on the benchmark and sector
  // proxies, so a partial universe is not merely stale, it is wrong.
  const SETTLE_MS = 3_000
  let ingestedSinceCompute = 0
  let settleTimer: NodeJS.Timeout | null = null

  async function scheduleCompute() {
    if (settleTimer) clearTimeout(settleTimer)

    settleTimer = setTimeout(() => {
      settleTimer = null
      void (async () => {
        // An unhandled rejection in a timer takes the whole process down - which
        // is what happened here on the first run, from the old `drained`
        // handler. A failed follow-up must not kill a healthy worker.
        try {
          const queue = getIngestQueue()
          const [waiting, active, delayed] = await Promise.all([
            queue.getWaitingCount(),
            queue.getActiveCount(),
            queue.getDelayedCount(),
          ])
          if (waiting + active + delayed > 0) {
            // Still working. Re-arm rather than computing against a partial set.
            void scheduleCompute()
            return
          }
          if (ingestedSinceCompute === 0) return

          const count = ingestedSinceCompute
          ingestedSinceCompute = 0

          console.log(`[ingest] batch settled: ${count} symbols, enqueueing compute`)
          await getComputeQueue().add(
            'compute-all',
            { from: '2024-01-01', replace: true },
            { jobId: computeJobId() },
          )
        } catch (e) {
          console.error(
            `[ingest] could not enqueue compute: ${(e as Error).message}`,
          )
        }
      })()
    }, SETTLE_MS)
  }

  ingestWorker.on('completed', () => {
    ingestedSinceCompute++
    void scheduleCompute()
  })

  console.log('worker up')
  console.log(
    fixtureMode()
      ? '  sources  FIXTURE MODE - committed history, no network'
      : `  sources  live (${sources().map(([id]) => id).join(', ') || 'none configured'})`,
  )
  console.log(`  ingest   concurrency ${CONCURRENCY.ingest}`)
  console.log(`  compute  concurrency ${CONCURRENCY.compute}`)

  const shutdown = async () => {
    if (settleTimer) clearTimeout(settleTimer)
    console.log('\nshutting down')
    await Promise.all([ingestWorker.close(), computeWorker.close()])
    await db.$disconnect()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
