import type {
  CandidateEvent,
  Contribution,
  ScoredEvent,
  ScoringContext,
  Severity,
  Signal,
  SignalFamily,
} from './types'
import { SCORER_VERSION } from './types'
import { clamp } from './math'
import { fingerprintOf } from './fingerprint'

/**
 * The scorer.
 *
 * A transparent linear model over normalised signals, wrapped in rule-based
 * overrides. Linear-and-attributable is a deliberate choice over anything
 * cleverer: every point of the final number traces back to a named signal, which
 * is what makes "Why am I seeing this?" and "Why not higher?" possible at all.
 * A model whose ranking cannot be explained is not shippable in a product whose
 * whole promise is deciding what deserves a person's attention.
 *
 * The same function scores a single event and a whole instrument-day — an
 * instrument's Attention Score is this function applied to the union of its
 * events' signals, so the two can never disagree about what mattered.
 */

/**
 * Base family weights. Sum to 1.
 *
 * Ordering reflects information content, not convenience:
 *  - `event`     a scheduled catalyst changes the thesis, not just the price
 *  - `relative`  an idiosyncratic move is company news; a market-wide one is weather
 *  - `price`     the move itself, but only after volatility normalisation
 *  - `volume`    confirmation — it amplifies or discounts a move, rarely stands alone
 *  - `volatility` regime context; a leading indicator rather than an event
 *
 * These are the starting point, tuned by scripts/calibrate.ts against real
 * history to a target surfaced-event rate. See docs/calibration.md.
 */
export const FAMILY_WEIGHTS: Record<SignalFamily, number> = {
  event: 0.28,
  relative: 0.24,
  price: 0.22,
  volume: 0.14,
  volatility: 0.12,
}

/**
 * Intent tilts which families matter, without changing the model.
 *
 * Someone waiting to buy cares about entry levels and relative weakness;
 * someone already holding cares about deterioration and upcoming catalysts.
 * A static lookup, not a learned model — the user told us their intent, so
 * there is nothing to infer.
 */
const INTENT_TILT: Record<string, Partial<Record<SignalFamily, number>>> = {
  CONSIDERING_BUY: { price: 1.25, relative: 1.15, volatility: 0.9 },
  HOLDING: { event: 1.2, volatility: 1.2, relative: 1.1 },
  THEMATIC: { relative: 1.3, event: 1.1, volume: 0.9 },
  HEDGE: { volatility: 1.3, price: 1.1 },
  NONE: {},
}

const PRIORITY_MULTIPLIER: Record<string, number> = {
  HIGH: 1.3,
  NORMAL: 1.0,
  LOW: 0.7,
}

/** Recency half-lives in trading days, by detector. */
const HALF_LIFE_DAYS: Record<string, number> = {
  move_since_last_seen: 2,
  volume_spike: 2,
  sector_divergence: 3,
  range_break: 4,
  vol_regime_shift: 10,
  // Earnings is handled separately: its importance rises toward the date
  // instead of decaying away from it.
  earnings_upcoming: Infinity,
}

export const SEVERITY_BANDS: Array<{ min: number; severity: Severity }> = [
  { min: 80, severity: 'CRITICAL' },
  { min: 60, severity: 'IMPORTANT' },
  { min: 40, severity: 'WATCH' },
  { min: 20, severity: 'INFO' },
  { min: -Infinity, severity: 'NOISE' },
]

export function severityFor(score: number): Severity {
  for (const band of SEVERITY_BANDS) {
    if (score >= band.min) return band.severity
  }
  return 'NOISE'
}

export interface ScoreResult {
  score: number
  severity: Severity
  contributions: Contribution[]
}

/**
 * Score a set of signals.
 *
 * Weights are renormalised across the families actually present. Without this a
 * lone 5-sigma price move could never exceed 22 points (its family weight) and
 * would be filed as INFO, which is plainly wrong — the absence of a volume
 * signal is not evidence against a move that large. Renormalising asks "given
 * what we can observe, how notable is this?" rather than penalising silence.
 */
export function scoreSignals(
  signals: Signal[],
  ctx: ScoringContext,
  detector?: string,
): ScoreResult {
  const contributions: Contribution[] = []

  if (signals.length === 0) {
    return { score: 0, severity: 'NOISE', contributions }
  }

  const tilt = INTENT_TILT[ctx.intent] ?? {}

  // Strongest signal per family: two volume signals should not double-count.
  const strongest = new Map<SignalFamily, Signal>()
  for (const s of signals) {
    const current = strongest.get(s.family)
    if (!current || Math.abs(s.normalized) > Math.abs(current.normalized)) {
      strongest.set(s.family, s)
    }
  }

  const present = [...strongest.keys()]
  const rawWeights = present.map(
    (family) => FAMILY_WEIGHTS[family] * (tilt[family] ?? 1),
  )
  const weightSum = rawWeights.reduce((a, b) => a + b, 0)

  let subtotal = 0
  present.forEach((family, i) => {
    const signal = strongest.get(family)!
    const weight = rawWeights[i] / weightSum
    // Magnitude drives the score; direction is carried on the event, not here.
    // A 3-sigma drop and a 3-sigma rally are equally worth knowing about.
    const points = Math.abs(signal.normalized) * weight * 100
    subtotal += points
    contributions.push({
      key: signal.key,
      label: signal.label,
      family,
      kind: 'additive',
      amount: round1(points),
    })
  })

  // ---- context multipliers -------------------------------------------------

  const multipliers: Contribution[] = []

  const addMultiplier = (
    key: string,
    label: string,
    amount: number,
  ) => {
    if (Math.abs(amount - 1) < 1e-9) return
    multipliers.push({
      key,
      label,
      family: 'context',
      kind: 'multiplier',
      amount: round2(amount),
    })
  }

  if (ctx.hasCatalyst) {
    // A move that coincides with a scheduled catalyst is worth more than either
    // alone: the catalyst explains the move, which makes it thesis-relevant.
    addMultiplier('catalyst', 'A known catalyst coincides with this move', 1.15)
  }

  if (ctx.isIdiosyncratic) {
    addMultiplier(
      'idiosyncratic',
      'The move is specific to this company, not the market',
      1.1,
    )
  }

  if (ctx.isMacroDay) {
    addMultiplier(
      'macro_day',
      'A market-wide macro event moved everything today',
      0.9,
    )
  }

  // Data quality never flatters a score. A number we are unsure of cannot be
  // allowed to demand attention as loudly as one we trust.
  const dataMultiplier = clamp(0.5 + 0.5 * ctx.dataConfidence, 0.5, 1)
  addMultiplier(
    'data_quality',
    ctx.dataConfidence >= 0.99
      ? 'Data is fresh and confirmed'
      : `Reduced confidence in the underlying data (${Math.round(ctx.dataConfidence * 100)}%)`,
    dataMultiplier,
  )

  if (!ctx.confirmed) {
    addMultiplier(
      'unconfirmed',
      'Sources disagree on this price — treat as provisional',
      0.85,
    )
  }

  const decay = recencyDecay(detector, ctx.ageTradingDays)
  addMultiplier(
    'recency',
    ctx.ageTradingDays <= 0
      ? 'Happened in the latest session'
      : `Happened ${ctx.ageTradingDays} trading day${ctx.ageTradingDays === 1 ? '' : 's'} ago`,
    decay,
  )

  const priority = PRIORITY_MULTIPLIER[ctx.priority] ?? 1
  addMultiplier(
    'priority',
    ctx.priority === 'HIGH'
      ? 'You marked this name High priority'
      : ctx.priority === 'LOW'
        ? 'You marked this name Low priority'
        : 'Normal priority',
    priority,
  )

  let score = subtotal
  for (const m of multipliers) score *= m.amount
  contributions.push(...multipliers)

  score = clamp(score, 0, 100)

  let severity = severityFor(score)

  // ---- hard rules ----------------------------------------------------------
  // Applied last so they cannot be washed out by weighting. These encode
  // judgements the linear model has no way to express.

  if (detector === 'earnings_upcoming' && ctx.ageTradingDays <= 0) {
    // "Nothing has moved yet" is exactly the wrong thing to tell someone whose
    // position reports tomorrow.
    severity = atLeast(severity, 'WATCH')
  }

  if (!ctx.confirmed) {
    // Never let disputed data produce the loudest possible alarm.
    severity = atMost(severity, 'IMPORTANT')
  }

  if (ctx.dataConfidence < 0.6) {
    severity = atMost(severity, 'WATCH')
  }

  return { score: round1(score), severity, contributions }
}

/** Score one candidate event. */
export function scoreEvent(
  candidate: CandidateEvent,
  ctx: ScoringContext,
): ScoredEvent {
  const { score, severity, contributions } = scoreSignals(
    candidate.signals,
    ctx,
    candidate.detector,
  )

  return {
    detector: candidate.detector,
    symbol: candidate.symbol,
    marketTime: candidate.marketTime,
    direction: candidate.direction,
    magnitude: candidate.magnitude,
    headline: candidate.headline,
    score,
    severity,
    contributions,
    signals: candidate.signals,
    scorerV: SCORER_VERSION,
    confidence: ctx.dataConfidence,
    fingerprint: fingerprintOf(candidate),
  }
}

/**
 * The instrument-level Attention Score: this function applied to the union of
 * every signal the instrument produced that day.
 *
 * Computed from signals rather than by combining event scores, so the number on
 * the card and the bars in the Why panel are the same arithmetic.
 */
export function scoreInstrumentDay(
  candidates: CandidateEvent[],
  ctx: ScoringContext,
): ScoreResult {
  const signals = candidates.flatMap((c) => c.signals)
  const result = scoreSignals(signals, ctx)

  // Any hard-rule floor earned by an individual event lifts the instrument too,
  // otherwise a name reporting earnings tomorrow could be filed as INFO.
  let severity = result.severity
  for (const c of candidates) {
    const individual = scoreSignals(c.signals, ctx, c.detector)
    severity = atLeast(severity, individual.severity)
  }

  return { ...result, severity }
}

/**
 * Exponential decay by half-life.
 *
 * Yesterday's spike is history; the market has already re-priced it. The floor
 * of 0.35 exists because an event the user has never seen is still news to
 * them even if it is stale to the market — the cursor, not the clock, decides
 * what is new.
 */
export function recencyDecay(
  detector: string | undefined,
  ageTradingDays: number,
): number {
  if (ageTradingDays <= 0) return 1
  const halfLife = HALF_LIFE_DAYS[detector ?? ''] ?? 3
  if (!Number.isFinite(halfLife)) return 1
  return Math.max(0.35, Math.pow(2, -ageTradingDays / halfLife))
}

const SEVERITY_ORDER: Severity[] = [
  'NOISE',
  'INFO',
  'WATCH',
  'IMPORTANT',
  'CRITICAL',
]

export function atLeast(current: Severity, floor: Severity): Severity {
  return SEVERITY_ORDER.indexOf(current) >= SEVERITY_ORDER.indexOf(floor)
    ? current
    : floor
}

export function atMost(current: Severity, cap: Severity): Severity {
  return SEVERITY_ORDER.indexOf(current) <= SEVERITY_ORDER.indexOf(cap)
    ? current
    : cap
}

/**
 * Split contributions for the UI.
 *
 * `positives` answer "why am I seeing this?"; `suppressors` answer "why not
 * higher?". Suppressors are the more valuable half — a system that can only
 * justify what it surfaced is much easier to fool than one that can also
 * explain what it held back.
 */
export function explainContributions(contributions: Contribution[]): {
  positives: Contribution[]
  suppressors: Contribution[]
} {
  const positives: Contribution[] = []
  const suppressors: Contribution[] = []

  for (const c of contributions) {
    if (c.kind === 'additive') {
      ;(c.amount >= 0 ? positives : suppressors).push(c)
    } else {
      ;(c.amount >= 1 ? positives : suppressors).push(c)
    }
  }

  positives.sort((a, b) => scoreOf(b) - scoreOf(a))
  suppressors.sort((a, b) => scoreOf(a) - scoreOf(b))

  return { positives, suppressors }
}

function scoreOf(c: Contribution): number {
  return c.kind === 'additive' ? c.amount : (c.amount - 1) * 100
}

function round1(x: number): number {
  return Math.round(x * 10) / 10
}

function round2(x: number): number {
  return Math.round(x * 100) / 100
}
