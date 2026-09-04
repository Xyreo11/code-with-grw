/**
 * Numerical primitives for the engine.
 *
 * All pure, all total: every function returns a finite number or `null` rather
 * than NaN/Infinity, because a NaN that escapes into a score is silent and a
 * `null` is not. Callers must handle insufficient-history explicitly.
 */

/** Arithmetic mean. `null` for an empty series. */
export function mean(xs: number[]): number | null {
  if (xs.length === 0) return null
  let sum = 0
  for (const x of xs) sum += x
  return sum / xs.length
}

/** Sample standard deviation (n-1). Needs >= 2 points. */
export function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null
  const m = mean(xs)!
  let acc = 0
  for (const x of xs) acc += (x - m) ** 2
  return Math.sqrt(acc / (xs.length - 1))
}

/** Median. Does not mutate the input. */
export function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Median absolute deviation, scaled by 1.4826 so it estimates the standard
 * deviation of a normal distribution.
 *
 * Used instead of stdev for normalisation because a single prior 8-sigma print
 * inflates stdev enough to make every later move look unremarkable. MAD does
 * not care about the tail, which is exactly what we want when the whole job is
 * deciding whether today is unusual.
 */
export function mad(xs: number[]): number | null {
  const m = median(xs)
  if (m === null) return null
  const deviations = xs.map((x) => Math.abs(x - m))
  const md = median(deviations)
  if (md === null) return null
  return md * 1.4826
}

/**
 * Robust z-score: (x - median) / MAD.
 *
 * Returns `null` when MAD is zero (a perfectly flat window) rather than
 * dividing by zero — a flat window means "no information", not "infinitely
 * surprising".
 */
export function robustZ(x: number, sample: number[]): number | null {
  const m = median(sample)
  const s = mad(sample)
  if (m === null || s === null || s === 0 || !Number.isFinite(s)) return null
  return (x - m) / s
}

/** Fraction of `sample` that is <= x, in [0,1]. `null` for an empty sample. */
export function percentileRank(x: number, sample: number[]): number | null {
  if (sample.length === 0) return null
  let count = 0
  for (const v of sample) if (v <= x) count++
  return count / sample.length
}

/** Value at the given quantile (0..1) using linear interpolation. */
export function quantile(xs: number[], q: number): number | null {
  if (xs.length === 0) return null
  if (xs.length === 1) return xs[0]
  const s = [...xs].sort((a, b) => a - b)
  const pos = (s.length - 1) * Math.min(Math.max(q, 0), 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return s[lo]
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

/**
 * Clamp a series into its own [qLow, qHigh] quantile range.
 * Applied to raw inputs before normalisation so one bad tick cannot move a
 * median or blow out a scale.
 */
export function winsorize(xs: number[], qLow = 0.005, qHigh = 0.995): number[] {
  const lo = quantile(xs, qLow)
  const hi = quantile(xs, qHigh)
  if (lo === null || hi === null) return [...xs]
  return xs.map((x) => (x < lo ? lo : x > hi ? hi : x))
}

/**
 * Squash an unbounded z-score into (-1, 1).
 *
 * Deliberately saturating: a 12-sigma print and a 6-sigma print both mean "off
 * the charts", and letting one feature run to +12 would let it swamp every
 * other signal in a weighted sum.
 *
 * The divisor is calibrated, not chosen for tidiness. At `z/3` a 2-sigma move —
 * which happens on roughly 5% of sessions — scored 58 points and landed near
 * IMPORTANT, producing 5.88 surfaced events per name per month against a target
 * of 2-4, and 26% of all events rated CRITICAL. `z/4` spreads the curve so
 * ordinary volatility reads as ordinary:
 *
 *   2 sigma -> 0.46    4 sigma -> 0.76
 *   3 sigma -> 0.64    6 sigma -> 0.91
 *
 * See docs/calibration.md for the measured effect.
 */
export const SQUASH_DIVISOR = 4

export function squash(z: number): number {
  if (!Number.isFinite(z)) return 0
  return Math.tanh(z / SQUASH_DIVISOR)
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

/** Natural log return between two positive prices. */
export function logReturn(from: number, to: number): number | null {
  if (!(from > 0) || !(to > 0)) return null
  return Math.log(to / from)
}

/** Element-wise log returns of a price series. Length is `prices.length - 1`. */
export function logReturns(prices: number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < prices.length; i++) {
    const r = logReturn(prices[i - 1], prices[i])
    if (r !== null) out.push(r)
  }
  return out
}

export interface Regression {
  /** Slope: sensitivity of y to x. */
  beta: number
  /** Intercept. */
  alpha: number
  /** y - (alpha + beta*x) for each input pair. */
  residuals: number[]
  /** Sample standard deviation of the residuals. */
  residualStd: number | null
}

/**
 * Ordinary least squares of y on x.
 *
 * Used to strip the market (or sector) component out of a move. What is left —
 * the residual — is the part the company itself is responsible for, and that is
 * what makes a move worth a user's attention rather than just weather.
 *
 * Returns `null` when the series are too short or x has no variance.
 */
export function linreg(y: number[], x: number[]): Regression | null {
  const n = Math.min(y.length, x.length)
  if (n < 20) return null

  const ys = y.slice(y.length - n)
  const xs = x.slice(x.length - n)

  const mx = mean(xs)!
  const my = mean(ys)!

  let cov = 0
  let varx = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    cov += dx * (ys[i] - my)
    varx += dx * dx
  }
  if (varx === 0) return null

  const beta = cov / varx
  const alpha = my - beta * mx
  const residuals = ys.map((yi, i) => yi - (alpha + beta * xs[i]))

  return { beta, alpha, residuals, residualStd: stdev(residuals) }
}

/**
 * Average True Range over `period` bars.
 *
 * True Range accounts for overnight gaps, which a simple high-low range misses —
 * and gaps are exactly when meaningful things happen. ATR gives us a per-symbol
 * unit of "normal daily movement", so a threshold like "0.5 ATR beyond the
 * range" means the same thing on a $12 stock and a $900 one.
 *
 * Uses a simple mean of True Range rather than Wilder's smoothing: it is
 * order-independent over the window, which makes it trivially reproducible in
 * tests and in historical replay. Thresholds are calibrated against this
 * definition, so the two choices are consistent.
 */
export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): number | null {
  const n = Math.min(highs.length, lows.length, closes.length)
  if (n < period + 1) return null

  const trueRanges: number[] = []
  for (let i = n - period; i < n; i++) {
    const prevClose = closes[i - 1]
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - prevClose),
      Math.abs(lows[i] - prevClose),
    )
    trueRanges.push(tr)
  }
  return mean(trueRanges)
}

/** Simple moving average of the last `period` values. */
export function sma(xs: number[], period: number): number | null {
  if (xs.length < period) return null
  return mean(xs.slice(xs.length - period))
}

/** Realised volatility: stdev of log returns over the last `period` returns. */
export function realisedVol(prices: number[], period: number): number | null {
  if (prices.length < period + 1) return null
  const rets = logReturns(prices.slice(prices.length - period - 1))
  return stdev(rets)
}

/** Mean pairwise Pearson correlation across a set of equal-length series. */
export function meanPairwiseCorrelation(series: number[][]): number | null {
  const usable = series.filter((s) => s.length >= 2)
  if (usable.length < 2) return null

  const n = Math.min(...usable.map((s) => s.length))
  const trimmed = usable.map((s) => s.slice(s.length - n))

  let total = 0
  let pairs = 0
  for (let i = 0; i < trimmed.length; i++) {
    for (let j = i + 1; j < trimmed.length; j++) {
      const c = correlation(trimmed[i], trimmed[j])
      if (c !== null) {
        total += c
        pairs++
      }
    }
  }
  return pairs === 0 ? null : total / pairs
}

/** Pearson correlation coefficient. `null` if either series has no variance. */
export function correlation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length)
  if (n < 2) return null

  const as = a.slice(a.length - n)
  const bs = b.slice(b.length - n)
  const ma = mean(as)!
  const mb = mean(bs)!

  let cov = 0
  let va = 0
  let vb = 0
  for (let i = 0; i < n; i++) {
    const da = as[i] - ma
    const dbv = bs[i] - mb
    cov += da * dbv
    va += da * da
    vb += dbv * dbv
  }
  if (va === 0 || vb === 0) return null
  return cov / Math.sqrt(va * vb)
}
