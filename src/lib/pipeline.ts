import type { Bar, CandidateEvent, ScoredEvent, ScoringContext } from '@/engine/types'
import { computeFeatures, MIN_HISTORY } from '@/engine/features'
import { runDetectors, type DetectorInput } from '@/engine/detectors'
import { scoreEvent, scoreInstrumentDay } from '@/engine/scorer'

/**
 * The compute pipeline: bars in, scored events out.
 *
 * Shared by live ingestion, historical calibration, and scenario replay, so all
 * three necessarily agree. If calibration used a different code path from
 * production, its tuned thresholds would describe a system we do not actually
 * ship.
 */

/**
 * Trailing bars handed to the feature computation.
 *
 * The longest lookback any feature needs is 252 sessions (52-week extremes),
 * plus 90 for the rolling regressions. 300 covers both with headroom.
 *
 * This bound is what keeps a full historical replay linear. Passing the entire
 * history on every date would make each of ~1,900 dates do O(n) work over a
 * growing array — around 96M element visits across the universe. Windowing
 * turns that into a constant 300 per date.
 */
const FEATURE_WINDOW = 300

export interface InstrumentSeries {
  symbol: string
  sector: string | null
  bars: Bar[]
}

export interface PipelineInput {
  instrument: InstrumentSeries
  /** Market benchmark bars (SPY), aligned by date internally. */
  benchmark: Bar[]
  /** Sector proxy bars, or empty when the instrument has no proxy. */
  sector: Bar[]
  /** Known earnings dates, ascending. Live mode only; history is unavailable. */
  earnings?: Array<{ date: string; session: string | null }>
}

export interface RunOptions {
  /** Only emit events on or after this date. Features still use prior history. */
  from?: string
  /** Only emit events on or before this date. Enforces point-in-time replay. */
  to?: string
  /**
   * Sessions since the user last looked. Calibration and scenario replay use 1
   * (i.e. "what changed today"); the live brief passes the real cursor gap.
   */
  sessionsSinceLastSeen?: number | null
  scoring?: Partial<ScoringContext>
}

function defaultScoringContext(
  overrides: Partial<ScoringContext> = {},
): ScoringContext {
  return {
    priority: 'NORMAL',
    intent: 'NONE',
    dataConfidence: 1,
    confirmed: true,
    ageTradingDays: 0,
    hasCatalyst: false,
    isIdiosyncratic: false,
    isMacroDay: false,
    ...overrides,
  }
}

/** Trailing slice ending at (and including) index `i`. */
function windowEndingAt(bars: Bar[], i: number, size: number): Bar[] {
  return bars.slice(Math.max(0, i - size + 1), i + 1)
}

/**
 * Trailing slice of a proxy series, truncated at `date`.
 *
 * Truncation is the point-in-time guarantee for the proxies: the regression
 * must not be able to see a benchmark bar that had not printed yet, even though
 * the full series is in memory.
 */
function proxyWindow(bars: Bar[], date: string, size: number): Bar[] {
  let end = bars.length
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].date > date) {
      end = i
      break
    }
  }
  return bars.slice(Math.max(0, end - size), end)
}

export interface PipelineEvent extends ScoredEvent {
  candidate: CandidateEvent
}

/**
 * One instrument on one day, scored over the union of everything that fired.
 *
 * This — not the individual event — is what the product surfaces: the brief
 * ranks NAMES, and a name's Attention Score is the combined case for looking at
 * it. Scoring the union is also the only level at which corroboration is
 * measurable, since a single detector only ever reports one signal family.
 */
export interface InstrumentDay {
  symbol: string
  date: string
  score: number
  severity: ScoredEvent['severity']
  contributions: ScoredEvent['contributions']
  events: PipelineEvent[]
}

export interface PipelineResult {
  events: PipelineEvent[]
  days: InstrumentDay[]
}

/**
 * Run the full chain over one instrument's history.
 *
 * Emits every event the detectors produce, including NOISE. Noise is retained
 * deliberately: calibration needs the full distribution to know where the
 * thresholds actually sit, and discarding it would leave only the events that
 * already passed the filter being tuned.
 */
export function runPipeline(
  input: PipelineInput,
  options: RunOptions = {},
): PipelineResult {
  const { instrument, benchmark, sector, earnings = [] } = input
  const {
    from,
    to,
    sessionsSinceLastSeen = 1,
    scoring = {},
  } = options

  const events: PipelineEvent[] = []
  const days: InstrumentDay[] = []
  const bars = instrument.bars

  for (let i = MIN_HISTORY - 1; i < bars.length; i++) {
    const date = bars[i].date
    if (from && date < from) continue
    if (to && date > to) break

    const window = windowEndingAt(bars, i, FEATURE_WINDOW)
    const features = computeFeatures(
      instrument.symbol,
      window,
      proxyWindow(benchmark, date, FEATURE_WINDOW),
      proxyWindow(sector, date, FEATURE_WINDOW),
    )
    if (!features) continue

    const nextEarnings = earnings.find((e) => e.date >= date) ?? null

    const detectorInput: DetectorInput = {
      symbol: instrument.symbol,
      features,
      bars: window,
      sessionsSinceLastSeen,
      nextEarnings,
      asOf: date,
    }

    const candidates = runDetectors(detectorInput)
    if (candidates.length === 0) continue

    // A catalyst coinciding with a price/volume anomaly is worth more than
    // either alone, so the context is derived from what actually fired together.
    const hasCatalyst = candidates.some((c) => c.detector === 'earnings_upcoming')
    const isIdiosyncratic =
      features.residSpy !== null &&
      features.residSpyStd !== null &&
      features.residSpyStd > 0 &&
      Math.abs(features.residSpy / features.residSpyStd) > 1.5

    const ctx = defaultScoringContext({
      dataConfidence: features.confidence,
      confirmed: features.confirmed,
      hasCatalyst,
      isIdiosyncratic,
      ...scoring,
    })

    const dayEvents = candidates.map((candidate) => ({
      ...scoreEvent(candidate, ctx),
      candidate,
    }))
    events.push(...dayEvents)

    const combined = scoreInstrumentDay(candidates, ctx)
    days.push({
      symbol: instrument.symbol,
      date,
      score: combined.score,
      severity: combined.severity,
      contributions: combined.contributions,
      events: dayEvents,
    })
  }

  return { events, days }
}

/**
 * Convert database bar rows into the engine's `Bar` shape.
 *
 * Prisma returns Decimal and BigInt for the numeric columns; the engine works
 * in plain numbers. Doing the conversion in one place keeps that coercion from
 * being scattered through call sites where a missed `Number()` would silently
 * produce string concatenation instead of arithmetic.
 */
export function toEngineBars(
  rows: Array<{
    barDate: Date
    open: unknown
    high: unknown
    low: unknown
    close: unknown
    closeAdj: unknown
    volume: bigint | number
    confidence: number
    confirmed: boolean
  }>,
): Bar[] {
  return rows.map((r) => ({
    date: r.barDate.toISOString().slice(0, 10),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    closeAdj: Number(r.closeAdj),
    volume: Number(r.volume),
    confidence: r.confidence,
    confirmed: r.confirmed,
  }))
}
