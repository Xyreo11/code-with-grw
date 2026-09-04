/**
 * Engine types.
 *
 * Everything in `src/engine` is PURE: no database, no network, no clock reads
 * beyond what is passed in. That is what makes the engine unit-testable against
 * synthetic fixtures and replayable over history at a pinned version.
 */

/** Bump whenever detector or scorer behaviour changes. Stamped onto every event. */
export const ENGINE_VERSION = 'v1'
export const SCORER_VERSION = 'v1'

// ---------------------------------------------------------------- input

/** One daily OHLCV bar, already normalised and split/dividend adjusted. */
export interface Bar {
  /** ISO date, `YYYY-MM-DD`. Market date, not ingest date. */
  date: string
  open: number
  high: number
  low: number
  close: number
  /** Split/dividend adjusted close — all returns are computed from this. */
  closeAdj: number
  volume: number
  /** 0..1. Degraded by staleness or cross-source disagreement. */
  confidence: number
  /** False when two sources disagreed beyond tolerance. Caps event severity. */
  confirmed: boolean
}

export type Severity = 'CRITICAL' | 'IMPORTANT' | 'WATCH' | 'INFO' | 'NOISE'
export type Priority = 'HIGH' | 'NORMAL' | 'LOW'
export type Intent =
  | 'CONSIDERING_BUY'
  | 'HOLDING'
  | 'THEMATIC'
  | 'HEDGE'
  | 'NONE'

// ---------------------------------------------------------------- features

/**
 * The feature vector for one instrument on one date.
 *
 * Raw values live here; normalisation to comparable units happens in
 * `normalize.ts`. Keeping them separate means a detector can express its
 * threshold in natural units (ATR, sigma, x-normal) and stay readable.
 */
export interface FeatureVector {
  symbol: string
  date: string

  /** Latest adjusted close. */
  close: number
  /** Simple return over the previous session. */
  ret1d: number
  /** Log return over the previous session. */
  logRet1d: number

  /** Annualisation-free daily volatility over 20 sessions (stdev of log returns). */
  sigma20: number
  /** Realised vol over 10 and 60 sessions — their ratio is the regime signal. */
  rv10: number
  rv60: number
  /** Average True Range over 14 sessions, in price units. */
  atr14: number

  sma20: number
  sma50: number

  /** Rolling extremes used for range-break detection. */
  high20: number
  low20: number
  high60: number
  low60: number
  high52w: number
  low52w: number

  /** Today's volume ÷ median volume over 20 sessions. */
  rvol: number
  /** Median volume over 20 sessions, in shares. */
  medianVolume20: number

  /** Rolling 90-session regression vs the market proxy (SPY). */
  betaSpy: number | null
  /** Today's residual return vs the market: r - (alpha + beta*r_spy). */
  residSpy: number | null
  /** Standard deviation of that residual over the regression window. */
  residSpyStd: number | null

  /** Same, but against the instrument's sector ETF. */
  betaSector: number | null
  residSector: number | null
  residSectorStd: number | null

  /**
   * Correlation with the sector ETF over 20 and 120 sessions. The GAP between
   * them is the signal: a name that tracked its peers for six months and stops
   * doing so has changed in a way no price move describes.
   */
  corrSectorShort: number | null
  corrSectorLong: number | null

  /**
   * Where today's 10-session volatility sits in the name's own trailing year,
   * 0..1. Near zero means unusually still - which is itself a change.
   */
  rv10Pct: number | null

  /** Worst-case data confidence across the bars this vector depends on. */
  confidence: number
  confirmed: boolean
}

// ---------------------------------------------------------------- events

export type DetectorId =
  | 'move_since_last_seen'
  | 'volume_spike'
  | 'sector_divergence'
  | 'range_break'
  | 'vol_regime_shift'
  | 'earnings_upcoming'
  | 'correlation_break'
  | 'quiet_regime'

/**
 * A candidate event emitted by a detector, before scoring.
 * `magnitude` is in the detector's own natural unit and is documented per detector.
 */
export interface CandidateEvent {
  detector: DetectorId
  symbol: string
  /** Market time the event refers to. */
  marketTime: string
  /** -1 down, +1 up, 0 directionless (e.g. volatility expansion). */
  direction: -1 | 0 | 1
  magnitude: number
  /** Human-readable one-liner, numbers already substituted. */
  headline: string
  /**
   * Named raw signals this detector observed. These become score contributions,
   * so the name is user-visible — write it for a person, not a debugger.
   */
  signals: Signal[]
}

/**
 * One named, normalised input to the score.
 *
 * `value` is the raw observation (for display), `normalized` is the squashed
 * [-1,1] version the scorer actually multiplies by a weight.
 */
export interface Signal {
  key: string
  /** Shown in the Why panel, e.g. "Volume 3.2x normal". */
  label: string
  family: SignalFamily
  value: number
  normalized: number
}

export type SignalFamily =
  | 'price'
  | 'volume'
  | 'volatility'
  | 'relative'
  | 'event'

/**
 * A signed contribution to the final score.
 *
 * Positive entries answer "why am I seeing this?"; negative entries answer
 * "why not higher?". Multiplier entries (`kind: 'multiplier'`) scale the
 * subtotal rather than adding to it, and are rendered as "x0.8" in the UI.
 */
export interface Contribution {
  key: string
  label: string
  family: SignalFamily | 'context'
  kind: 'additive' | 'multiplier'
  /** Points added, or the multiplier applied. */
  amount: number
}

/** A fully scored event, ready to persist. */
export interface ScoredEvent {
  detector: DetectorId
  symbol: string
  marketTime: string
  direction: -1 | 0 | 1
  magnitude: number
  headline: string
  /** 0..100 */
  score: number
  severity: Severity
  contributions: Contribution[]
  signals: Signal[]
  scorerV: string
  confidence: number
  /**
   * Whether two sources agreed. Distinct from `confidence`: a single-source bar
   * is uncorroborated but not disputed, and telling a user that sources
   * disagree when only one reported would be a lie.
   */
  confirmed: boolean
  fingerprint: string
}

// ---------------------------------------------------------------- scoring context

/**
 * Everything the scorer needs beyond the signals themselves.
 * Passed explicitly so scoring stays a pure function of its inputs.
 */
export interface ScoringContext {
  /** User-set relevance for this instrument. */
  priority: Priority
  intent: Intent
  /** Worst-case data confidence backing this event, 0..1. */
  dataConfidence: number
  /** False when sources disagreed — hard-caps severity at IMPORTANT. */
  confirmed: boolean
  /** Trading days since the event occurred; drives recency decay. */
  ageTradingDays: number
  /** True when a catalyst (e.g. earnings) coincides with a price/volume anomaly. */
  hasCatalyst: boolean
  /** True when the move is unexplained by the market factor. */
  isIdiosyncratic: boolean
  /** True on known macro days (CPI/FOMC) — discounts move-only events. */
  isMacroDay: boolean
}
