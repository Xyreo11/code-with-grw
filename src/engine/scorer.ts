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

/**
 * Severity bands, calibrated against real history (docs/calibration.md).
 *
 * The first cut used 80/60/40/20 and rated 26% of all detected events CRITICAL,
 * which makes the word meaningless. These bands are set so that a lone move has
 * to be genuinely extreme — roughly 6 sigma, or 4 sigma corroborated by volume
 * and a catalyst — before it can interrupt someone as CRITICAL.
 */
export const SEVERITY_BANDS: Array<{ min: number; severity: Severity }> = [
  { min: 82, severity: 'CRITICAL' },
  { min: 64, severity: 'IMPORTANT' },
  { min: 40, severity: 'WATCH' },
  { min: 25, severity: 'INFO' },
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
 * How hard thin evidence is penalised. Calibrated; see the note below.
 *
 * 0 would ignore corroboration entirely (a lone signal scores as high as five
 * agreeing ones); 1 would make a lone signal almost unscoreable regardless of
 * how extreme it is.
 */
export const COVERAGE_EXPONENT = 0.25

/**
 * Score a set of signals.
 *
 * Two things are combined, and keeping them separate is the point:
 *
 *   strength  the weighted mean of the families that DID report, so a lone
 *             extreme move is not punished for the silence of other families
 *   coverage  how much of the total weight reported at all, so corroboration
 *             counts for something
 *
 *     score = 100 x strength x coverage^COVERAGE_EXPONENT
 *
 * An earlier version renormalised fully (coverage ignored). That made the score
 * measure only "how strong is the strongest evidence", which meant any detected
 * event automatically cleared WATCH — calibration showed `volume_spike` and
 * `move_since_last_seen` surfacing 99.5% of everything they detected, with no
 * gradation whatever, and 26% of all events rated CRITICAL.
 *
 * It also silently discarded the product's own thesis: that volume confirming a
 * price move is worth more than either alone. Coverage restores it. The
 * resulting ladder, at strength 0.9:
 *
 *     price only (cov 0.22)            -> 62   WATCH
 *     price + volume + relative (0.60) -> 79   IMPORTANT
 *     all five families (1.00)         -> 90   CRITICAL
 *
 * and a bare 2.5-sigma move with nothing corroborating it lands at 38 — INFO,
 * never surfaced. Which is correct: on its own, it is an ordinary day.
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

  // Coverage is measured against the UNTILTED total, so an intent tilt changes
  // emphasis without inflating how well-corroborated an event looks.
  const totalPossibleWeight = Object.values(FAMILY_WEIGHTS).reduce(
    (a, b) => a + b,
    0,
  )
  const coverage = present.reduce((a, f) => a + FAMILY_WEIGHTS[f], 0) / totalPossibleWeight
  const coverageFactor = Math.pow(coverage, COVERAGE_EXPONENT)

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

  // Applied as a visible multiplier rather than folded into the additive
  // points, so the Why panel can name thin evidence as a reason the score is
  // not higher instead of leaving an unexplained gap in the arithmetic.
  addMultiplier(
    'corroboration',
    present.length === 1
      ? 'Only one kind of signal fired — nothing corroborates it'
      : present.length < 5
        ? `Only ${present.length} of 5 signal families fired`
        : 'Every signal family agrees',
    coverageFactor,
  )

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
    confirmed: ctx.confirmed,
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
