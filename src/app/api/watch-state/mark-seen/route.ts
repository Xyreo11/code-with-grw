import { z } from 'zod'
import { requireUser } from '@/lib/auth'
import { markSeen } from '@/lib/sitrep'
import { db } from '@/lib/db'
import { handler, ok, parseBody } from '@/lib/api'

const schema = z.object({
  symbols: z.array(z.string()).optional(),
  eventIds: z.array(z.string()).optional().default([]),
  /** Acknowledge everything currently in the brief. */
  all: z.boolean().optional().default(false),
})

export const POST = handler(async (req) => {
  const user = await requireUser()
  const { symbols, eventIds, all } = await parseBody(req, schema)

  // Resolve symbols through this user's own watchlist, so a request naming a
  // symbol they do not watch cannot move a cursor they do not own.
  const watchlist = await db.watchlist.findFirst({
    where: { userId: user.id },
    include: { items: { include: { instrument: true } } },
  })

  const owned = watchlist?.items ?? []
  const instrumentIds = all
    ? owned.map((i) => i.instrumentId)
    : owned
        .filter((i) => (symbols ?? []).includes(i.instrument.symbol))
        .map((i) => i.instrumentId)

  const result = await markSeen(user.id, instrumentIds, eventIds)
  return ok(result)
})
