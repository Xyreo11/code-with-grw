import { createHash } from 'node:crypto'
import type { CandidateEvent } from './types'

/**
 * Event deduplication.
 *
 * The same real-world event can be detected more than once: a re-run of
 * ingestion, a late-arriving bar that re-triggers the pipeline, or two sources
 * reporting the same session. Without a stable identity the brief fills up with
 * the same story repeated, which is precisely the alert fatigue the product
 * exists to prevent.
 *
 * The fingerprint is deliberately coarse on magnitude. An exact-value hash would
 * treat a 3.11-sigma and a 3.12-sigma recomputation of the same move as two
 * different events, defeating the purpose. Bucketing to half-sigma means a
 * genuine escalation still produces a new fingerprint while noise does not.
 */
export function fingerprintOf(event: {
  symbol: string
  detector: string
  direction: number
  marketTime: string
  magnitude: number
}): string {
  const dayBucket = event.marketTime.slice(0, 10)
  const magnitudeBucket = Math.round(event.magnitude * 2) / 2

  const key = [
    event.symbol,
    event.detector,
    event.direction,
    dayBucket,
    magnitudeBucket.toFixed(1),
  ].join('|')

  return createHash('sha256').update(key).digest('hex').slice(0, 32)
}

/**
 * Whether a newly detected event is materially the same story as one already
 * shown to this user.
 *
 * Distinct from the fingerprint: that catches exact re-detection, this catches
 * "the same situation, still true, one session later". An escalation of more
 * than `escalationPoints` is treated as news again — "it got worse" is worth
 * surfacing even when "it is still bad" is not.
 */
export function isMateriallySimilar(
  a: { detector: string; direction: number; score: number },
  b: { detector: string; direction: number; score: number },
  escalationPoints = 15,
): boolean {
  if (a.detector !== b.detector) return false
  if (a.direction !== b.direction) return false
  return Math.abs(a.score - b.score) < escalationPoints
}

export function fingerprintFromCandidate(c: CandidateEvent): string {
  return fingerprintOf(c)
}
