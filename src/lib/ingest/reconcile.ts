import type { RawBar } from '../sources/types'

/**
 * Cross-source reconciliation.
 *
 * Two providers describing the same session will not always agree. Silently
 * picking one and showing it as fact is the failure this module exists to
 * prevent: a watchlist that quietly renders a disputed price as though it were
 * settled is worse than one that admits it does not know.
 *
 * Policy, in short:
 *   - agree within tolerance  -> take the higher-trust value, fully confirmed
 *   - disagree beyond it      -> keep both, mark UNCONFIRMED, record the conflict
 *   - only one source has it  -> use it, slightly reduced confidence, no conflict
 *
 * The `confirmed` flag and reduced `confidence` both flow downstream: the scorer
 * multiplies by confidence and hard-caps severity for unconfirmed bars, and the
 * UI renders an amber badge. A disputed price can never produce a CRITICAL.
 */

export interface SourcedBar {
  sourceId: string
  trustRank: number
  bar: RawBar
}

export interface FieldConflict {
  field: 'close' | 'open' | 'high' | 'low' | 'volume'
  sourceA: string
  valueA: number
  sourceB: string
  valueB: number
  deltaPct: number
  resolvedTo: string
}

export interface ReconciledBar {
  bar: RawBar
  source: string
  /** 0..1. Feeds the scorer's data-quality multiplier. */
  confidence: number
  /** False only when trusted sources actively disagree on a PRICE field. */
  confirmed: boolean
  conflicts: FieldConflict[]
  contributingSources: string[]
}

/**
 * Tolerances, per field family.
 *
 * Prices are tight: legitimate providers should agree on a daily close to well
 * within a third of a percent, so a wider gap is a genuine data problem.
 *
 * Volume is deliberately loose. Providers routinely differ by double digits on
 * daily share volume because some report consolidated tape and others only the
 * primary listing. Holding volume to a price-like tolerance would flag almost
 * every bar and train everyone to ignore the badge — the exact alert-fatigue
 * failure this product is built to avoid.
 */
export const TOLERANCE = {
  price: 0.003,
  volume: 0.25,
} as const

/**
 * Volume disagreement is RECORDED but does not mark a bar unconfirmed.
 *
 * A consolidated-vs-primary volume difference is a known accounting difference
 * between vendors, not evidence that the session is in doubt. Letting it set
 * `confirmed = false` would suppress severity on perfectly good data.
 */
const UNCONFIRMING_FIELDS = new Set(['close', 'open', 'high', 'low'])

function relativeDelta(a: number, b: number): number {
  const denom = Math.max(Math.abs(a), Math.abs(b))
  if (denom === 0) return 0
  return Math.abs(a - b) / denom
}

/**
 * Reconcile one calendar date across however many sources supplied it.
 *
 * Returns `null` when no source has the bar at all — the caller records that as
 * a gap rather than inventing a value.
 */
export function reconcileBar(candidates: SourcedBar[]): ReconciledBar | null {
  if (candidates.length === 0) return null

  // Lower trustRank wins. Stable sort keeps behaviour deterministic when two
  // sources share a rank.
  const ranked = [...candidates].sort((a, b) => a.trustRank - b.trustRank)
  const primary = ranked[0]

  if (ranked.length === 1) {
    return {
      bar: primary.bar,
      source: primary.sourceId,
      // Not disputed, but not corroborated either. A single source is worth
      // slightly less than two that agree, and the score should reflect that.
      confidence: 0.9,
      confirmed: true,
      conflicts: [],
      contributingSources: [primary.sourceId],
    }
  }

  const conflicts: FieldConflict[] = []
  const fields: FieldConflict['field'][] = ['open', 'high', 'low', 'close', 'volume']

  for (const other of ranked.slice(1)) {
    for (const field of fields) {
      const a = primary.bar[field]
      const b = other.bar[field]
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue

      const delta = relativeDelta(a, b)
      const tolerance = field === 'volume' ? TOLERANCE.volume : TOLERANCE.price

      if (delta > tolerance) {
        conflicts.push({
          field,
          sourceA: primary.sourceId,
          valueA: a,
          sourceB: other.sourceId,
          valueB: b,
          deltaPct: delta,
          resolvedTo: primary.sourceId,
        })
      }
    }
  }

  const priceConflicts = conflicts.filter((c) => UNCONFIRMING_FIELDS.has(c.field))
  const confirmed = priceConflicts.length === 0

  return {
    bar: primary.bar,
    source: primary.sourceId,
    confidence: confidenceFor(priceConflicts),
    confirmed,
    conflicts,
    contributingSources: ranked.map((r) => r.sourceId),
  }
}

/**
 * Confidence degrades with the size of the worst price disagreement, floored at
 * 0.5 so a disputed bar still contributes something rather than vanishing.
 *
 * A 0.5% disagreement is a nuisance; a 20% disagreement means one provider is
 * plainly wrong and nothing derived from that bar should be trusted much.
 */
function confidenceFor(priceConflicts: FieldConflict[]): number {
  if (priceConflicts.length === 0) return 1

  const worst = Math.max(...priceConflicts.map((c) => c.deltaPct))
  // Linear from 1.0 at the tolerance boundary down to 0.5 at a 10% gap.
  const scaled = 1 - (worst - TOLERANCE.price) / (0.1 - TOLERANCE.price) / 2
  return Math.min(1, Math.max(0.5, Number(scaled.toFixed(3))))
}

export interface ReconcileSeriesResult {
  bars: ReconciledBar[]
  conflicts: Array<FieldConflict & { date: string }>
  /** Dates present in a secondary source but missing from the primary. */
  gapsFilled: string[]
}

/**
 * Reconcile whole series, joined on market date.
 *
 * Joined by DATE, never by position. Providers differ on holiday handling, so
 * positional pairing would silently offset one series against the other and
 * corrupt every downstream return.
 */
export function reconcileSeries(
  series: Array<{ sourceId: string; trustRank: number; bars: RawBar[] }>,
): ReconcileSeriesResult {
  const byDate = new Map<string, SourcedBar[]>()
  const primaryRank = Math.min(...series.map((s) => s.trustRank))
  const primaryDates = new Set<string>()

  for (const s of series) {
    for (const bar of s.bars) {
      const list = byDate.get(bar.date) ?? []
      list.push({ sourceId: s.sourceId, trustRank: s.trustRank, bar })
      byDate.set(bar.date, list)
      if (s.trustRank === primaryRank) primaryDates.add(bar.date)
    }
  }

  const bars: ReconciledBar[] = []
  const conflicts: Array<FieldConflict & { date: string }> = []
  const gapsFilled: string[] = []

  for (const date of [...byDate.keys()].sort()) {
    const reconciled = reconcileBar(byDate.get(date)!)
    if (!reconciled) continue

    bars.push(reconciled)
    for (const c of reconciled.conflicts) conflicts.push({ ...c, date })

    // A session the primary missed but a secondary has is a filled gap, not a
    // conflict — worth recording so freshness reporting can show it.
    if (!primaryDates.has(date)) gapsFilled.push(date)
  }

  return { bars, conflicts, gapsFilled }
}
