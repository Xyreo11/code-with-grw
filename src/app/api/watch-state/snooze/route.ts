import { z } from 'zod'
import { requireUser } from '@/lib/auth'
import { snoozeEvents } from '@/lib/sitrep'
import { handler, ok, parseBody } from '@/lib/api'

/**
 * "Not now."
 *
 * Distinct from mark-seen by design: this defers an event without moving the
 * cursor, so the absence window keeps growing and the event returns, unchanged,
 * when the snooze lapses.
 *
 * The duration is bounded server-side. An unbounded snooze is indistinguishable
 * from a dismissal, and a brief that can be silenced forever stops being a
 * brief.
 */
const MAX_SNOOZE_HOURS = 24 * 14

/**
 * Ownership scoping already means a foreign id writes nothing, but an unbounded
 * array still buys an attacker a 20,000-value IN clause for the cost of one
 * request. The cap is far above anything the UI sends and turns that into a
 * validation error instead of a query.
 */
const MAX_IDS = 500

const schema = z.object({
  eventIds: z.array(z.string()).min(1).max(MAX_IDS),
  hours: z.number().int().positive().max(MAX_SNOOZE_HOURS).default(24),
})

export const POST = handler(async (req) => {
  const user = await requireUser()
  const { eventIds, hours } = await parseBody(req, schema)

  const until = new Date(Date.now() + hours * 3_600_000)
  const result = await snoozeEvents(user.id, eventIds, until)

  return ok({ ...result, until: until.toISOString() })
})
