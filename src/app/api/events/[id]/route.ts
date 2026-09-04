import { requireUser } from '@/lib/auth'
import { db } from '@/lib/db'
import { handler, ok, problem } from '@/lib/api'
import { explainContributions } from '@/engine/scorer'
import type { Contribution } from '@/engine/types'

/**
 * Full attribution for one event: what pushed the score up, and what held it
 * down. Powers "Why am I seeing this?" and "Why not higher?".
 */
export const GET = handler(async (_req, ctx) => {
  const user = await requireUser()
  const { id } = await (ctx as { params: Promise<{ id: string }> }).params

  const event = await db.event.findUnique({
    where: { id },
    include: { instrument: true, theme: true },
  })
  if (!event) return problem(404, 'Not found', 'No such event.')

  // Scope check: an event is only readable if this user actually watches the
  // instrument it belongs to.
  const watched = await db.watchlistItem.findFirst({
    where: {
      instrumentId: event.instrumentId,
      watchlist: { userId: user.id },
    },
  })
  if (!watched) return problem(404, 'Not found', 'No such event.')

  const contributions = (event.contributions ?? []) as unknown as Contribution[]
  const { positives, suppressors } = explainContributions(contributions)

  return ok({
    id: event.id,
    symbol: event.instrument.symbol,
    name: event.instrument.name,
    type: event.type,
    headline: event.headline,
    marketTime: event.marketTime,
    score: event.score,
    severity: event.severity,
    scorerV: event.scorerV,
    confidence: event.confidence,
    positives,
    suppressors,
    theme: event.theme
      ? {
          scopeKey: event.theme.scopeKey,
          confidence: event.theme.confidence,
          cohesion: event.theme.cohesion,
          timing: event.theme.timing,
          size: event.theme.size,
          distinctness: event.theme.distinctness,
          characteristics: event.theme.characteristics,
          summary: event.theme.summary,
        }
      : null,
  })
})
