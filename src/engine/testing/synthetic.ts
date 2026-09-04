import type { Bar } from '../types'

/**
 * Deterministic synthetic market data for tests and calibration sanity checks.
 *
 * Every detector must be provable in both directions: a series that MUST fire it
 * and a series that MUST NOT. Real market data cannot do that — you cannot ask
 * the market for "a 3.2 sigma gap on otherwise calm tape". Synthetic series can,
 * and being seeded means a failing test fails identically on every machine.
 *
 * These are not a substitute for real data (calibration uses real history); they
 * are how we prove the detectors respond to the thing they claim to detect.
 */

/**
 * mulberry32 — small, fast, well-distributed 32-bit PRNG.
 * Chosen over Math.random purely because it takes a seed.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Box-Muller transform: uniform PRNG -> standard normal. */
function gaussian(next: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = next()
  while (v === 0) v = next()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export type Injection =
  | { kind: 'none' }
  /** A single large gap on the final bar, sized in sigmas. */
  | { kind: 'gap'; sigmas: number }
  /** Multiply final-bar volume by `times` its recent normal. */
  | { kind: 'volumeSpike'; times: number }
  /** Push the final close beyond the recent range by `atrMultiple` ATRs. */
  | { kind: 'rangeBreak'; atrMultiple: number; direction: 1 | -1 }
  /** Raise volatility by `times` over the final `days` sessions. */
  | { kind: 'volRegime'; times: number; days: number }
  /** A steady drift of `dailyPct` per session over the final `days`. */
  | { kind: 'drift'; dailyPct: number; days: number }

export interface SeriesOptions {
  days?: number
  startPrice?: number
  /** Daily log-return standard deviation of the calm baseline. */
  dailyVol?: number
  baseVolume?: number
  seed?: number
  /** First bar date, `YYYY-MM-DD`. Weekends are skipped. */
  startDate?: string
  inject?: Injection
  confidence?: number
  confirmed?: boolean
}

/** Advance to the next weekday, so generated dates look like trading sessions. */
function nextTradingDay(d: Date): Date {
  const out = new Date(d)
  do {
    out.setUTCDate(out.getUTCDate() + 1)
  } while (out.getUTCDay() === 0 || out.getUTCDay() === 6)
  return out
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Build a calm baseline series, then apply the requested injection.
 *
 * The baseline is a geometric random walk with constant volatility, which gives
 * the rolling statistics (sigma20, ATR, median volume) a stable value to settle
 * on. An injection is then a clean, measurable departure from that.
 */
export function makeSeries(opts: SeriesOptions = {}): Bar[] {
  const {
    days = 260,
    startPrice = 100,
    dailyVol = 0.012,
    baseVolume = 1_000_000,
    seed = 42,
    startDate = '2024-01-01',
    inject = { kind: 'none' },
    confidence = 1,
    confirmed = true,
  } = opts

  const next = rng(seed)
  const bars: Bar[] = []

  let price = startPrice
  let date = new Date(`${startDate}T00:00:00Z`)
  if (date.getUTCDay() === 0 || date.getUTCDay() === 6) date = nextTradingDay(date)

  for (let i = 0; i < days; i++) {
    // Volatility regime shift applies to the tail of the series.
    let vol = dailyVol
    if (inject.kind === 'volRegime' && i >= days - inject.days) {
      vol = dailyVol * inject.times
    }

    let logRet = gaussian(next) * vol

    if (inject.kind === 'drift' && i >= days - inject.days) {
      logRet += Math.log(1 + inject.dailyPct)
    }

    price = price * Math.exp(logRet)

    // Intrabar range scaled to the day's volatility so ATR tracks the regime.
    const spread = price * vol * 1.2
    const high = price + Math.abs(gaussian(next)) * spread * 0.5
    const low = price - Math.abs(gaussian(next)) * spread * 0.5
    const open = low + (high - low) * next()

    // Lognormal-ish volume: positive, right-skewed, stable median.
    const volume = Math.round(baseVolume * Math.exp(gaussian(next) * 0.25))

    bars.push({
      date: iso(date),
      open: round2(open),
      high: round2(Math.max(high, open, price)),
      low: round2(Math.min(low, open, price)),
      close: round2(price),
      closeAdj: round2(price),
      volume,
      confidence,
      confirmed,
    })

    date = nextTradingDay(date)
  }

  return applyFinalBarInjection(bars, inject, dailyVol)
}

/**
 * Injections that only affect the final bar are applied after generation so the
 * baseline statistics (which the detector normalises against) stay untouched.
 */
function applyFinalBarInjection(
  bars: Bar[],
  inject: Injection,
  dailyVol: number,
): Bar[] {
  if (bars.length === 0) return bars
  const out = [...bars]
  const lastIdx = out.length - 1
  const last = { ...out[lastIdx] }
  const prevClose = out[lastIdx - 1].closeAdj

  if (inject.kind === 'gap') {
    const target = prevClose * Math.exp(inject.sigmas * dailyVol)
    last.close = round2(target)
    last.closeAdj = round2(target)
    last.open = round2(target)
    last.high = round2(Math.max(target, prevClose) * 1.002)
    last.low = round2(Math.min(target, prevClose) * 0.998)
  }

  if (inject.kind === 'volumeSpike') {
    const recentMedian = medianOf(
      out.slice(Math.max(0, lastIdx - 20), lastIdx).map((b) => b.volume),
    )
    last.volume = Math.round(recentMedian * inject.times)
  }

  if (inject.kind === 'rangeBreak') {
    // 60 bars, matching the longer range the detector prefers. Breaking only
    // the 20-day range would leave the close inside the 60-day one.
    const lookback = out.slice(Math.max(0, lastIdx - 60), lastIdx)
    const hi = Math.max(...lookback.map((b) => b.high))
    const lo = Math.min(...lookback.map((b) => b.low))
    // Approximate ATR from the same window the detector will use.
    const approxAtr =
      lookback.reduce((acc, b) => acc + (b.high - b.low), 0) / lookback.length

    const target =
      inject.direction === 1
        ? hi + approxAtr * inject.atrMultiple
        : lo - approxAtr * inject.atrMultiple

    last.close = round2(target)
    last.closeAdj = round2(target)
    last.high = round2(Math.max(target, last.high))
    last.low = round2(Math.min(target, last.low))
  }

  out[lastIdx] = last
  return out
}

function medianOf(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function round2(x: number): number {
  return Math.round(x * 100) / 100
}

/**
 * Build a proxy series correlated with `base` by `rho`.
 *
 * Needed to test relative-performance detectors honestly: sector divergence
 * should fire when a name moves and its sector does not, and must stay silent
 * when the whole sector moves together. Both cases require a proxy whose
 * relationship to the instrument is something we control.
 */
export function makeCorrelatedSeries(
  base: Bar[],
  rho: number,
  opts: { seed?: number; dailyVol?: number; startPrice?: number } = {},
): Bar[] {
  const { seed = 7, dailyVol = 0.01, startPrice = 100 } = opts
  const next = rng(seed)

  const out: Bar[] = []
  let price = startPrice

  for (let i = 0; i < base.length; i++) {
    let logRet: number
    if (i === 0) {
      logRet = 0
    } else {
      const baseRet = Math.log(base[i].closeAdj / base[i - 1].closeAdj)
      const idiosyncratic = gaussian(next) * dailyVol
      // Standard construction: rho * signal + sqrt(1-rho^2) * independent noise.
      logRet = rho * baseRet + Math.sqrt(Math.max(0, 1 - rho * rho)) * idiosyncratic
    }
    price = price * Math.exp(logRet)

    out.push({
      date: base[i].date,
      open: round2(price),
      high: round2(price * 1.004),
      low: round2(price * 0.996),
      close: round2(price),
      closeAdj: round2(price),
      volume: 5_000_000,
      confidence: 1,
      confirmed: true,
    })
  }

  return out
}

/**
 * A near-flat proxy: the "sector did essentially nothing" case.
 *
 * Deliberately not a constant. A perfectly constant series has zero variance,
 * which makes the regression undefined rather than merely uninformative — and
 * no real sector ETF is ever flat to the tick. Tiny seeded noise keeps this a
 * realistic "quiet sector" while leaving any real move in the residual.
 */
export function makeFlatSeries(base: Bar[], price = 100, seed = 5150): Bar[] {
  const next = rng(seed)
  let p = price

  return base.map((b) => {
    p = p * Math.exp(gaussian(next) * 0.0004)
    return {
      date: b.date,
      open: round2(p),
      high: round2(p * 1.001),
      low: round2(p * 0.999),
      close: round2(p),
      closeAdj: round2(p),
      volume: 5_000_000,
      confidence: 1,
      confirmed: true,
    }
  })
}

/**
 * A literally constant proxy. Only useful for asserting that the engine refuses
 * to regress against a zero-variance series rather than inventing a number.
 */
export function makeConstantSeries(base: Bar[], price = 100): Bar[] {
  return base.map((b) => ({
    date: b.date,
    open: price,
    high: price,
    low: price,
    close: price,
    closeAdj: price,
    volume: 5_000_000,
    confidence: 1,
    confirmed: true,
  }))
}
