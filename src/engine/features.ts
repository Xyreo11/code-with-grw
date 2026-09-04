import type { Bar, FeatureVector } from './types'
import {
  atr,
  linreg,
  logReturn,
  logReturns,
  median,
  realisedVol,
  sma,
  stdev,
} from './math'

/**
 * Minimum bars needed before any feature vector is meaningful. Below this the
 * rolling statistics are too noisy to normalise against and we return `null`
 * rather than emitting a confident-looking vector built on 5 data points.
 */
export const MIN_HISTORY = 60

/** Window used for the rolling market/sector regressions. */
const BETA_WINDOW = 90

/**
 * Compute the feature vector for the LAST bar in `bars`.
 *
 * Point-in-time by construction: this function can only see the array it is
 * given, and the caller is responsible for passing history truncated at the
 * as-of date. That is what makes historical replay honest — there is no code
 * path here that could reach a future bar even if one existed in the database.
 *
 * `benchmarkBars` and `sectorBars` must be aligned to the same trading dates;
 * they are intersected on date before regressing so a missing session in one
 * series cannot silently shift the pairing.
 */
export function computeFeatures(
  symbol: string,
  bars: Bar[],
  benchmarkBars: Bar[] = [],
  sectorBars: Bar[] = [],
): FeatureVector | null {
  if (bars.length < MIN_HISTORY) return null

  const last = bars[bars.length - 1]
  const prev = bars[bars.length - 2]

  const closes = bars.map((b) => b.closeAdj)
  const highs = bars.map((b) => b.high)
  const lows = bars.map((b) => b.low)
  const volumes = bars.map((b) => b.volume)

  const logRet1d = logReturn(prev.closeAdj, last.closeAdj)
  if (logRet1d === null) return null
  const ret1d = last.closeAdj / prev.closeAdj - 1

  const sigma20 = realisedVol(closes, 20)
  if (sigma20 === null) return null

  const rv10 = realisedVol(closes, 10)
  const rv60 = realisedVol(closes, 60)
  const atr14 = atr(highs, lows, closes, 14)
  if (atr14 === null) return null

  const window = (arr: number[], n: number) => arr.slice(Math.max(0, arr.length - n))

  const recent20 = window(closes, 20)
  const recent60 = window(closes, 60)
  const recent252 = window(closes, 252)

  const vol20 = window(volumes, 20)
  const medianVolume20 = median(vol20) ?? 0
  // A median of zero means the name did not trade; treat RVOL as 1 (neutral)
  // rather than dividing by zero and reporting an infinite volume spike.
  const rvol = medianVolume20 > 0 ? last.volume / medianVolume20 : 1

  const marketReg = regressAgainst(bars, benchmarkBars)
  const sectorReg = regressAgainst(bars, sectorBars)

  // Confidence and confirmation propagate from the bars this vector actually
  // depends on. Worst case wins: one unconfirmed bar in the window taints the
  // vector, which in turn caps the severity of any event derived from it.
  const relevant = window(bars, BETA_WINDOW)
  const confidence = Math.min(...relevant.map((b) => b.confidence))
  const confirmed = relevant.every((b) => b.confirmed)

  return {
    symbol,
    date: last.date,
    close: last.closeAdj,
    ret1d,
    logRet1d,
    sigma20,
    rv10: rv10 ?? sigma20,
    rv60: rv60 ?? sigma20,
    atr14,
    sma20: sma(closes, 20) ?? last.closeAdj,
    sma50: sma(closes, 50) ?? last.closeAdj,
    high20: Math.max(...window(highs, 20)),
    low20: Math.min(...window(lows, 20)),
    high60: Math.max(...window(highs, 60)),
    low60: Math.min(...window(lows, 60)),
    high52w: Math.max(...window(highs, 252)),
    low52w: Math.min(...window(lows, 252)),
    rvol,
    medianVolume20,
    betaSpy: marketReg?.beta ?? null,
    residSpy: marketReg?.residualToday ?? null,
    residSpyStd: marketReg?.residualStd ?? null,
    betaSector: sectorReg?.beta ?? null,
    residSector: sectorReg?.residualToday ?? null,
    residSectorStd: sectorReg?.residualStd ?? null,
    confidence: Number.isFinite(confidence) ? confidence : 1,
    confirmed,
  }
}

interface RegressionSummary {
  beta: number
  residualToday: number
  residualStd: number | null
}

/**
 * Regress the instrument's log returns on a proxy's log returns over the beta
 * window, and report today's residual.
 *
 * Dates are intersected rather than assumed aligned. If a proxy is missing a
 * session (holiday handling differs between providers), naive positional
 * pairing would offset every subsequent return by one day and produce a
 * confidently wrong beta.
 */
function regressAgainst(
  bars: Bar[],
  proxyBars: Bar[],
): RegressionSummary | null {
  if (proxyBars.length < 20) return null

  const proxyByDate = new Map(proxyBars.map((b) => [b.date, b.closeAdj]))

  const pairedDates: string[] = []
  const selfCloses: number[] = []
  const proxyCloses: number[] = []

  for (const bar of bars) {
    const proxyClose = proxyByDate.get(bar.date)
    if (proxyClose === undefined) continue
    pairedDates.push(bar.date)
    selfCloses.push(bar.closeAdj)
    proxyCloses.push(proxyClose)
  }

  if (selfCloses.length < 21) return null

  // Only regress if today's bar actually paired — otherwise "today's residual"
  // would silently describe some earlier session.
  if (pairedDates[pairedDates.length - 1] !== bars[bars.length - 1].date) {
    return null
  }

  const take = Math.min(BETA_WINDOW + 1, selfCloses.length)
  const y = logReturns(selfCloses.slice(selfCloses.length - take))
  const x = logReturns(proxyCloses.slice(proxyCloses.length - take))

  const reg = linreg(y, x)
  if (!reg) return null

  return {
    beta: reg.beta,
    residualToday: reg.residuals[reg.residuals.length - 1],
    residualStd: reg.residualStd,
  }
}

/**
 * Return over the last `n` trading sessions, in units of the instrument's own
 * expected move over that horizon (sigma * sqrt(n)).
 *
 * This is the core normalisation of the whole product: it is what makes a 3%
 * move in a quiet utility rank above a 3% move in a volatile small-cap, and
 * what makes "down 6% over the five days you were away" comparable to "down 2%
 * today".
 */
export function moveInSigmas(
  bars: Bar[],
  sessions: number,
  sigma20: number,
): number | null {
  if (sessions < 1 || bars.length < sessions + 1) return null
  if (!(sigma20 > 0)) return null

  const from = bars[bars.length - 1 - sessions].closeAdj
  const to = bars[bars.length - 1].closeAdj
  const r = logReturn(from, to)
  if (r === null) return null

  return r / (sigma20 * Math.sqrt(sessions))
}

/** Historical distribution of |1-day log return|, for percentile comparisons. */
export function absReturnSample(bars: Bar[], lookback = 90): number[] {
  const closes = bars.slice(Math.max(0, bars.length - lookback - 1)).map((b) => b.closeAdj)
  return logReturns(closes).map(Math.abs)
}

/** Historical RVOL distribution, used to normalise today's volume spike. */
export function rvolSample(bars: Bar[], lookback = 90): number[] {
  const out: number[] = []
  for (let i = Math.max(20, bars.length - lookback); i < bars.length; i++) {
    const window = bars.slice(i - 20, i).map((b) => b.volume)
    const med = median(window)
    if (med && med > 0) out.push(bars[i].volume / med)
  }
  return out
}

/** Standard deviation of daily log returns over an arbitrary window. */
export function volOver(bars: Bar[], sessions: number): number | null {
  if (bars.length < sessions + 1) return null
  const closes = bars.slice(bars.length - sessions - 1).map((b) => b.closeAdj)
  return stdev(logReturns(closes))
}
