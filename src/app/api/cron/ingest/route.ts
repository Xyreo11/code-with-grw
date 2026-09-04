import { requireCronSecret } from '@/lib/api'
import { handler, ok } from '@/lib/api'
import { getIngestQueue } from '@/lib/queue'
import { db } from '@/lib/db'

/**
 * Enqueue a daily ingest for the whole universe.
 *
 * The route only ENQUEUES. It does no provider I/O, so it returns in
 * milliseconds regardless of how slow or rate-limited the upstream feeds are,
 * and a cron caller never has to hold a connection open for minutes.
 *
 * Guarded by a shared secret rather than a session: it is called by a scheduler,
 * not a person.
 */
export const POST = handler(async (req) => {
  requireCronSecret(req)

  const instruments = await db.instrument.findMany({
    where: { isActive: true },
    select: { symbol: true },
    orderBy: { symbol: 'asc' },
  })

  const today = new Date().toISOString().slice(0, 10)
  // A short trailing window: we want recent sessions and any late corrections,
  // not a full re-backfill on every run.
  const from = new Date()
  from.setUTCDate(from.getUTCDate() - 10)

  const queue = getIngestQueue()
  const jobs = await queue.addBulk(
    instruments.map((i) => ({
      name: 'ingest-symbol',
      data: { symbol: i.symbol, from: from.toISOString().slice(0, 10), to: today },
      // Natural key: re-running the cron on the same day is a no-op rather
      // than a duplicate batch.
      // BullMQ forbids ":" in custom job ids.
      opts: { jobId: `ingest-${i.symbol}-${today}` },
    })),
  )

  return ok({ enqueued: jobs.length, date: today })
})
