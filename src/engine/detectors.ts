import type { Bar, CandidateEvent, FeatureVector, Signal } from './types'
import { absReturnSample, moveInSigmas, rvolSample } from './features'
import { robustZ, squash } from './math'

/**
 * The six core detectors.
 *
 * Each is a pure predicate over a feature vector plus the history behind it.
 * Together they cover every signal family the scorer weights — price, volume,
 * relative performance, volatility, and scheduled events. More detectors would
 * add coverage within those families, not new structure, which is why this set
 * is the floor rather than a starting point.
 *
 * A detector's job is to answer "did this specific thing happen, and how far
 * outside normal was it". Deciding whether the user should care is the scorer's
 * job, and nothing here should reason about severity or ranking.
 */

export interface DetectorInput {
  symbol: string
  features: FeatureVector
  /** History up to and including the as-of date. Never contains future bars. */
  bars: Bar[]
  /**
   * Trading sessions since this user last looked at this name.
   * `null` means "no cursor yet" — a first visit, where "since you last checked"
   * is meaningless and the detector must stay silent rather than invent a window.
   */
  sessionsSinceLastSeen: number | null
  nextEarnings: { date: string; session: string | null } | null
  /** As-of date, `YYYY-MM-DD`. */
  asOf: string
}

// Thresholds are calibrated (see scripts/calibrate.ts), not guessed. They are
// named constants so the calibration report can reference them directly.
export const THRESHOLDS = {
  moveSigmas: 2.5,
  rvol: 2.5,
  sectorDivergenceZ: 2.0,
  /**
   * A divergence must also be economically real, not merely statistically
   * significant. When a name tracks its sector very closely the residual
   * distribution is extremely tight, so an unexplained move of 0.16% can score
   * 1.6σ. Requiring the residual to be at least this fraction of the
   * instrument's own daily volatility keeps those off the brief.
   */
  sectorDivergenceMinVolFraction: 0.5,
  rangeBreakAtr: 0.5,
  volRegimeRatio: 2.0,
  earningsHours: 48,

  /**
   * Correlation break. Two gates: the relationship has to have existed
   * (`corrBreakBaseline`) before it can be said to have broken, and the fall
   * has to be large (`corrBreakDrop`). Without the first gate every pair that
   * never correlated would "break" constantly.
   */
  corrBreakBaseline: 0.6,
  corrBreakDrop: 0.45,

  /**
   * Anomalous quiet. Bottom decile of the name's own trailing year, AND a
   * short-vs-long contraction, so a name in a permanently sleepy regime does
   * not report itself as newly still every single day.
   */
  quietPercentile: 0.1,
  quietContraction: 0.7,
} as const

function pct(x: number): string {
  return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`
}

function signal(
  key: string,
  label: string,
  family: Signal['family'],
  value: number,
  normalized: number,
): Signal {
  return { key, label, family, value, normalized }
}

/**
 * 1. Move since the user last looked.
 *
 * The signature detector, and the only one that is user-relative: the same
 * market produces a different event for someone who checked yesterday than for
 * someone who checked last month. The move is divided by the instrument's own
 * expected move over that many sessions, so a quiet name drifting 3% over a
 * week can outrank a volatile name doing 3% in a day.
 */
export function detectMoveSinceLastSeen(
  input: DetectorInput,
): CandidateEvent | null {
  const { features: f, bars, sessionsSinceLastSeen } = input
  if (sessionsSinceLastSeen === null || sessionsSinceLastSeen < 1) return null

  const sessions = Math.min(sessionsSinceLastSeen, bars.length - 1)
  if (sessions < 1) return null

  const z = moveInSigmas(bars, sessions, f.sigma20)
  if (z === null || Math.abs(z) < THRESHOLDS.moveSigmas) return null

  const from = bars[bars.length - 1 - sessions].closeAdj
  const to = bars[bars.length - 1].closeAdj
  const changePct = to / from - 1
  const direction = z > 0 ? 1 : -1

  const dayWord = sessions === 1 ? 'session' : `${sessions} sessions`
  const verb = direction > 0 ? 'Rose' : 'Fell'

  return {
    detector: 'move_since_last_seen',
    symbol: input.symbol,
    marketTime: f.date,
    direction,
    magnitude: Math.abs(z),
    headline: `${verb} ${pct(Math.abs(changePct))} since you last checked — ${Math.abs(z).toFixed(1)}σ over ${dayWord}.`,
    signals: [
      signal(
        'move_z',
        `${pct(changePct)} over ${dayWord} (${Math.abs(z).toFixed(1)}σ)`,
        'price',
        z,
        squash(z),
      ),
    ],
  }
}

/**
 * 2. Unusual volume.
 *
 * Volume is the confirmation signal: a price move on normal volume is often
 * noise, while heavy volume means real participation. Normalised against the
 * instrument's own RVOL distribution so a perpetually spiky small-cap does not
 * fire every day.
 */
export function detectVolumeSpike(input: DetectorInput): CandidateEvent | null {
  const { features: f, bars } = input
  if (f.rvol < THRESHOLDS.rvol) return null

  const sample = rvolSample(bars)
  const z = robustZ(f.rvol, sample)
  // Fall back to a bounded proxy when history is too thin to normalise against.
  const normalized = z === null ? squash(Math.log2(f.rvol)) : squash(z)

  return {
    detector: 'volume_spike',
    symbol: input.symbol,
    marketTime: f.date,
    // Volume itself has no direction; the accompanying price move carries it.
    direction: f.ret1d > 0 ? 1 : f.ret1d < 0 ? -1 : 0,
    magnitude: f.rvol,
    headline: `Volume is ${f.rvol.toFixed(1)}× its normal level.`,
    signals: [
      signal(
        'rvol',
        `Volume ${f.rvol.toFixed(1)}× the 20-day median`,
        'volume',
        f.rvol,
        normalized,
      ),
    ],
  }
}

/**
 * 3. Divergence from the sector.
 *
 * The most informative of the six. A name falling with its sector is weather; a
 * name falling while its sector holds up is news about that company. Uses the
 * residual from a rolling regression against the sector ETF, expressed in units
 * of that residual's own standard deviation.
 */
export function detectSectorDivergence(
  input: DetectorInput,
): CandidateEvent | null {
  const { features: f } = input
  if (f.residSector === null || f.residSectorStd === null) return null
  if (!(f.residSectorStd > 0)) return null

  const z = f.residSector / f.residSectorStd
  if (Math.abs(z) < THRESHOLDS.sectorDivergenceZ) return null

  // Two gates, deliberately. The z-score asks "is this unusual for this pair?";
  // this asks "is it big enough for a person to care?". A name that hugs its
  // sector produces a very tight residual distribution, where an ordinary
  // 0.1% wobble clears 1.5σ without meaning anything.
  const economicFloor = f.sigma20 * THRESHOLDS.sectorDivergenceMinVolFraction
  if (Math.abs(f.residSector) < economicFloor) return null

  const direction = z > 0 ? 1 : -1
  const word = direction > 0 ? 'outperformed' : 'underperformed'

  return {
    detector: 'sector_divergence',
    symbol: input.symbol,
    marketTime: f.date,
    direction,
    magnitude: Math.abs(z),
    headline: `Moved against its sector — ${word} by ${pct(Math.abs(f.residSector))} after adjusting for sector beta.`,
    signals: [
      signal(
        'sector_residual',
        `${word.replace('ed', 'ing')} its sector by ${pct(Math.abs(f.residSector))} (${Math.abs(z).toFixed(1)}σ)`,
        'relative',
        z,
        squash(z),
      ),
    ],
  }
}

/**
 * 4. Break of an established range.
 *
 * A close outside the recent high-low band, buffered by half an ATR so a
 * marginal poke through the level does not count. The ATR buffer is what makes
 * one threshold work across a $12 stock and a $900 one.
 */
export function detectRangeBreak(input: DetectorInput): CandidateEvent | null {
  const { features: f } = input
  if (!(f.atr14 > 0)) return null

  const buffer = f.atr14 * THRESHOLDS.rangeBreakAtr

  // Prefer the longer, more meaningful range when both break.
  const candidates: Array<{ window: number; hi: number; lo: number }> = [
    { window: 60, hi: f.high60, lo: f.low60 },
    { window: 20, hi: f.high20, lo: f.low20 },
  ]

  for (const { window, hi, lo } of candidates) {
    const brokeUp = f.close > hi + buffer
    const brokeDown = f.close < lo - buffer

    if (!brokeUp && !brokeDown) continue

    const level = brokeUp ? hi : lo
    const distanceAtr = Math.abs(f.close - level) / f.atr14
    const direction = brokeUp ? 1 : -1
    const word = brokeUp ? 'above' : 'below'

    return {
      detector: 'range_break',
      symbol: input.symbol,
      marketTime: f.date,
      direction,
      magnitude: distanceAtr,
      headline: `Broke ${word} its ${window}-day range for the first time, by ${distanceAtr.toFixed(1)} ATR.`,
      signals: [
        signal(
          'range_break',
          `Closed ${distanceAtr.toFixed(1)} ATR ${word} the ${window}-day range`,
          'price',
          distanceAtr * direction,
          // ATR units are already comparable across instruments, so they go
          // through the same squash as a sigma with no extra amplification.
          squash(distanceAtr * direction),
        ),
      ],
    }
  }

  return null
}

/**
 * 5. Volatility regime shift.
 *
 * Short-horizon realised vol against long-horizon. This is a leading signal:
 * it does not say the price moved, it says the character of the price action
 * changed — which usually precedes the moves worth knowing about.
 */
export function detectVolRegimeShift(
  input: DetectorInput,
): CandidateEvent | null {
  const { features: f } = input
  if (!(f.rv60 > 0)) return null

  const ratio = f.rv10 / f.rv60
  if (ratio < THRESHOLDS.volRegimeRatio) return null

  return {
    detector: 'vol_regime_shift',
    symbol: input.symbol,
    marketTime: f.date,
    direction: 0,
    magnitude: ratio,
    headline: `Volatility regime changed — 10-day volatility is now ${ratio.toFixed(1)}× its 60-day level.`,
    signals: [
      signal(
        'vol_regime',
        `Short-term volatility ${ratio.toFixed(1)}× its normal level`,
        'volatility',
        ratio,
        squash((ratio - 1) * 2),
      ),
    ],
  }
}

/**
 * 6. Scheduled earnings.
 *
 * The only detector that looks forward. It exists because "nothing has happened
 * yet" is precisely the wrong thing to tell someone whose position reports
 * tomorrow — the absence of a move is not the absence of risk.
 */
export function detectEarningsUpcoming(
  input: DetectorInput,
): CandidateEvent | null {
  const { nextEarnings, asOf, features: f } = input
  if (!nextEarnings) return null

  const hours = hoursUntil(asOf, nextEarnings.date, nextEarnings.session)
  if (hours === null || hours < 0 || hours > THRESHOLDS.earningsHours) return null

  const days = Math.round(hours / 24)
  const when =
    days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`

  // Closeness to the event is the magnitude: 48h out is mild, the morning of is not.
  const proximity = 1 - hours / THRESHOLDS.earningsHours

  return {
    detector: 'earnings_upcoming',
    symbol: input.symbol,
    marketTime: f.date,
    direction: 0,
    magnitude: proximity,
    headline: `Reports earnings ${when}${nextEarnings.session === 'amc' ? ' after the close' : nextEarnings.session === 'bmo' ? ' before the open' : ''}.`,
    signals: [
      signal(
        'earnings_proximity',
        `Earnings ${when}`,
        'event',
        hours,
        // Deliberately not squashed through a z-score: this is a known schedule,
        // not a statistical surprise. Proximity maps straight to weight.
        Math.max(0.35, proximity),
      ),
    ],
  }
}

/** Whole hours between the as-of date and an earnings report. */
function hoursUntil(
  asOf: string,
  reportDate: string,
  session: string | null,
): number | null {
  const from = Date.parse(`${asOf}T16:00:00Z`)
  // "bmo" reports land before the next open; "amc" after that day's close.
  const at = Date.parse(
    `${reportDate}T${session === 'bmo' ? '13:30:00' : '21:00:00'}Z`,
  )
  if (Number.isNaN(from) || Number.isNaN(at)) return null
  return (at - from) / 3_600_000
}

/**
 * 7. A relationship that stopped holding.
 *
 * Every other detector answers "did the price do something unusual?". This one
 * asks a different question: has this name stopped behaving like its peers?
 *
 * A stock that tracked its sector at 0.85 for six months and now tracks it at
 * 0.15 has changed in a way no price move describes - the move may be small,
 * or absent, while the thing the position actually depended on has gone. That
 * is meaningful change under any honest definition, and it is invisible to a
 * watchlist that only reads returns.
 *
 * Directionless on purpose: decoupling is not bullish or bearish, it is a
 * statement about structure.
 */
export function detectCorrelationBreak(
  input: DetectorInput,
): CandidateEvent | null {
  const { features: f } = input
  if (f.corrSectorLong === null || f.corrSectorShort === null) return null

  // There has to have been a relationship before it can break.
  if (f.corrSectorLong < THRESHOLDS.corrBreakBaseline) return null

  const drop = f.corrSectorLong - f.corrSectorShort
  if (drop < THRESHOLDS.corrBreakDrop) return null

  return {
    detector: 'correlation_break',
    symbol: input.symbol,
    marketTime: f.date,
    direction: 0,
    magnitude: drop,
    headline:
      `Stopped tracking its sector — 20-day correlation ${f.corrSectorShort.toFixed(2)}, ` +
      `against ${f.corrSectorLong.toFixed(2)} over the last 120 sessions.`,
    signals: [
      signal(
        'correlation_break',
        `Sector correlation fell ${f.corrSectorLong.toFixed(2)} to ${f.corrSectorShort.toFixed(2)}`,
        'relative',
        drop,
        // Already bounded 0..2 by construction; a full inversion is the extreme.
        clamp(drop / 1.5, 0, 1),
      ),
    ],
  }
}

/**
 * 8. Unusual stillness.
 *
 * The one detector that fires on the ABSENCE of movement. A name compressed
 * into the quietest decile of its own year is not "nothing happening" - low
 * realised volatility is the precondition for expansion, and a position that
 * has gone quiet after being active is a change the holder should know about
 * before the expansion, not after.
 *
 * This is the clearest case for the product's central claim: what changed is
 * not the same question as what moved.
 */
export function detectQuietRegime(
  input: DetectorInput,
): CandidateEvent | null {
  const { features: f } = input
  if (f.rv10Pct === null) return null
  if (f.rv10Pct > THRESHOLDS.quietPercentile) return null

  // Second gate: the name must have GONE quiet, not merely be quiet. A stock
  // that sits in the bottom decile permanently would otherwise report the same
  // non-news every session.
  if (!(f.rv60 > 0)) return null
  const contraction = f.rv10 / f.rv60
  if (contraction > THRESHOLDS.quietContraction) return null

  const pctile = Math.round(f.rv10Pct * 100)

  return {
    detector: 'quiet_regime',
    symbol: input.symbol,
    marketTime: f.date,
    direction: 0,
    magnitude: 1 - f.rv10Pct,
    headline:
      `Unusually still — 10-day volatility is quieter than ${100 - pctile}% ` +
      `of the last year, and ${contraction.toFixed(2)}× its 60-day level.`,
    signals: [
      signal(
        'quiet_regime',
        `Volatility in the ${pctile <= 1 ? 'lowest 1%' : `bottom ${pctile}%`} of its own year`,
        'volatility',
        f.rv10Pct,
        // Deeper into the tail means a stronger signal, so invert the rank and
        // stretch the decile across the full 0..1 range.
        clamp((THRESHOLDS.quietPercentile - f.rv10Pct) / THRESHOLDS.quietPercentile, 0, 1),
      ),
    ],
  }
}

export const DETECTORS = [
  detectMoveSinceLastSeen,
  detectVolumeSpike,
  detectSectorDivergence,
  detectRangeBreak,
  detectVolRegimeShift,
  detectEarningsUpcoming,
  detectCorrelationBreak,
  detectQuietRegime,
] as const

/** Run every detector and return whatever fired. Order is stable for testing. */
export function runDetectors(input: DetectorInput): CandidateEvent[] {
  const out: CandidateEvent[] = []
  for (const detect of DETECTORS) {
    const event = detect(input)
    if (event) out.push(event)
  }
  return out
}
