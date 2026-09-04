import { z } from 'zod'
import { requireUser } from '@/lib/auth'
import { db } from '@/lib/db'
import { handler, ok, problem, parseBody } from '@/lib/api'

const addSchema = z.object({
  symbol: z.string().min(1).max(10),
  intent: z
    .enum(['CONSIDERING_BUY', 'HOLDING', 'THEMATIC', 'HEDGE', 'NONE'])
    .optional()
    .default('NONE'),
  priority: z.enum(['HIGH', 'NORMAL', 'LOW']).optional().default('NORMAL'),
})

const patchSchema = z.object({
  symbol: z.string().min(1).max(10),
  intent: z
    .enum(['CONSIDERING_BUY', 'HOLDING', 'THEMATIC', 'HEDGE', 'NONE'])
    .optional(),
  priority: z.enum(['HIGH', 'NORMAL', 'LOW']).optional(),
})

async function watchlistFor(userId: string) {
  const existing = await db.watchlist.findFirst({ where: { userId } })
  if (existing) return existing
  return db.watchlist.create({ data: { userId, name: 'My Watchlist' } })
}

export const GET = handler(async () => {
  const user = await requireUser()
  const watchlist = await watchlistFor(user.id)

  const items = await db.watchlistItem.findMany({
    where: { watchlistId: watchlist.id },
    include: { instrument: true },
    orderBy: { addedAt: 'asc' },
  })

  return ok({
    items: items.map((i) => ({
      symbol: i.instrument.symbol,
      name: i.instrument.name,
      sector: i.instrument.sector,
      intent: i.intent,
      priority: i.priority,
    })),
  })
})

export const POST = handler(async (req) => {
  const user = await requireUser()
  const { symbol, intent, priority } = await parseBody(req, addSchema)

  const instrument = await db.instrument.findUnique({
    where: { symbol: symbol.toUpperCase() },
  })
  if (!instrument) {
    return problem(
      404,
      'Unknown symbol',
      `${symbol.toUpperCase()} is not in the tracked universe.`,
    )
  }

  const watchlist = await watchlistFor(user.id)

  await db.watchlistItem.upsert({
    where: {
      watchlistId_instrumentId: {
        watchlistId: watchlist.id,
        instrumentId: instrument.id,
      },
    },
    create: {
      watchlistId: watchlist.id,
      instrumentId: instrument.id,
      intent,
      priority,
    },
    update: { intent, priority },
  })

  // A newly added name gets a cursor at "now", so it reports what happens from
  // here rather than replaying years of history the user never missed.
  await db.userWatchState.upsert({
    where: {
      userId_instrumentId: { userId: user.id, instrumentId: instrument.id },
    },
    create: {
      userId: user.id,
      instrumentId: instrument.id,
      lastSeenAt: new Date(),
      lastSeenSnap: {},
    },
    update: {},
  })

  return ok({ symbol: instrument.symbol }, { status: 201 })
})

export const PATCH = handler(async (req) => {
  const user = await requireUser()
  const { symbol, intent, priority } = await parseBody(req, patchSchema)

  const watchlist = await watchlistFor(user.id)
  const instrument = await db.instrument.findUnique({
    where: { symbol: symbol.toUpperCase() },
  })
  if (!instrument) return problem(404, 'Unknown symbol')

  await db.watchlistItem.update({
    where: {
      watchlistId_instrumentId: {
        watchlistId: watchlist.id,
        instrumentId: instrument.id,
      },
    },
    data: {
      ...(intent ? { intent } : {}),
      ...(priority ? { priority } : {}),
    },
  })

  return ok({ symbol: instrument.symbol })
})

export const DELETE = handler(async (req) => {
  const user = await requireUser()
  const url = new URL(req.url)
  const symbol = url.searchParams.get('symbol')
  if (!symbol) return problem(400, 'Missing symbol')

  const watchlist = await watchlistFor(user.id)
  const instrument = await db.instrument.findUnique({
    where: { symbol: symbol.toUpperCase() },
  })
  if (!instrument) return problem(404, 'Unknown symbol')

  await db.watchlistItem.deleteMany({
    where: { watchlistId: watchlist.id, instrumentId: instrument.id },
  })

  return ok({ symbol: instrument.symbol })
})
