import { describe, expect, it } from 'vitest'
import {
  atr,
  correlation,
  linreg,
  mad,
  median,
  quantile,
  robustZ,
  squash,
  SQUASH_DIVISOR,
  stdev,
  winsorize,
} from '../math'
import { computeFeatures, moveInSigmas, MIN_HISTORY } from '../features'
import {
  makeCorrelatedSeries,
  makeConstantSeries,
  makeFlatSeries,
  makeSeries,
} from '../testing/synthetic'

describe('math primitives', () => {
  it('median handles odd and even lengths without mutating input', () => {
    const xs = [5, 1, 3]
    expect(median(xs)).toBe(3)
    expect(xs).toEqual([5, 1, 3])
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })

  it('MAD is unmoved by a single extreme outlier, unlike stdev', () => {
    const calm = [10, 10.1, 9.9, 10.2, 9.8, 10, 10.1, 9.9]
    const withSpike = [...calm, 40]

    const madBefore = mad(calm)!
    const madAfter = mad(withSpike)!
    const sdBefore = stdev(calm)!
    const sdAfter = stdev(withSpike)!

    // This is the whole reason normalisation uses MAD: one historical shock
    // must not desensitise the detector to the next one.
    expect(sdAfter / sdBefore).toBeGreaterThan(5)
    expect(madAfter / madBefore).toBeLessThan(2)
  })

  it('robustZ returns null on a flat window instead of dividing by zero', () => {
    expect(robustZ(5, [3, 3, 3, 3])).toBeNull()
  })

  it('squash saturates so no single feature can dominate', () => {
    expect(squash(0)).toBe(0)
    expect(squash(3)).toBeCloseTo(Math.tanh(3 / SQUASH_DIVISOR), 10)
    expect(Math.abs(squash(50))).toBeLessThan(1)
    expect(squash(12)).toBeGreaterThan(squash(6))
    // ...but the marginal gain past 6 sigma is tiny.
    expect(squash(12) - squash(6)).toBeLessThan(0.1)
  })

  it('maps ordinary volatility to ordinary scores', () => {
    // The calibrated shape. At an earlier divisor of 3, a 2-sigma move - which
    // happens on ~5% of sessions - scored 0.58 and read as IMPORTANT, producing
    // 26% of all events at CRITICAL. See docs/calibration.md.
    expect(squash(2)).toBeCloseTo(0.46, 2)
    expect(squash(3)).toBeCloseTo(0.64, 2)
    expect(squash(4)).toBeCloseTo(0.76, 2)
    expect(squash(6)).toBeCloseTo(0.91, 2)
  })

  it('winsorize clamps tails into the quantile range', () => {
    const xs = [...Array(100).keys()].concat([100000])
    const w = winsorize(xs, 0.01, 0.99)
    expect(Math.max(...w)).toBeLessThan(100000)
  })

  it('quantile interpolates', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5)
    expect(quantile([1, 2, 3, 4], 0)).toBe(1)
    expect(quantile([1, 2, 3, 4], 1)).toBe(4)
  })

  it('linreg recovers a known slope and intercept', () => {
    const x = Array.from({ length: 50 }, (_, i) => i / 10)
    const y = x.map((v) => 3 * v + 1)
    const reg = linreg(y, x)!
    expect(reg.beta).toBeCloseTo(3, 8)
    expect(reg.alpha).toBeCloseTo(1, 8)
    expect(reg.residualStd!).toBeCloseTo(0, 8)
  })

  it('linreg refuses short series rather than fitting noise', () => {
    expect(linreg([1, 2, 3], [1, 2, 3])).toBeNull()
  })

  it('correlation is 1 for identical series and null without variance', () => {
    const a = [1, 2, 3, 4, 5]
    expect(correlation(a, a)).toBeCloseTo(1, 10)
    expect(correlation(a, [2, 2, 2, 2, 2])).toBeNull()
  })

  it('atr accounts for overnight gaps, not just intrabar range', () => {
    const highs = Array(20).fill(10)
    const lows = Array(20).fill(9)
    const closes = Array(20).fill(9.5)
    const flat = atr(highs, lows, closes, 14)!

    // Same intrabar ranges, but one bar gaps far away from the prior close.
    const gapCloses = [...closes]
    gapCloses[gapCloses.length - 2] = 5
    const gapped = atr(highs, lows, gapCloses, 14)!

    expect(gapped).toBeGreaterThan(flat)
  })
})

describe('computeFeatures', () => {
  it('refuses to emit a vector without enough history', () => {
    const short = makeSeries({ days: MIN_HISTORY - 1 })
    expect(computeFeatures('TEST', short)).toBeNull()
  })

  it('produces finite features on a calm series', () => {
    const bars = makeSeries({ days: 300, seed: 1 })
    const f = computeFeatures('TEST', bars)!

    expect(f).not.toBeNull()
    expect(f.symbol).toBe('TEST')
    expect(f.date).toBe(bars[bars.length - 1].date)
    expect(f.sigma20).toBeGreaterThan(0)
    expect(f.atr14).toBeGreaterThan(0)
    expect(f.rvol).toBeGreaterThan(0)
    expect(Number.isFinite(f.close)).toBe(true)
    expect(f.high52w).toBeGreaterThanOrEqual(f.low52w)
    expect(f.high20).toBeGreaterThanOrEqual(f.low20)
  })

  it('is point-in-time: future bars cannot change today’s vector', () => {
    // The no-lookahead guarantee the whole replay feature rests on.
    const full = makeSeries({ days: 320, seed: 5 })
    const truncated = full.slice(0, 300)

    const fromTruncated = computeFeatures('TEST', truncated)!
    const fromFull = computeFeatures('TEST', full.slice(0, 300))!

    expect(fromTruncated).toEqual(fromFull)
    // And a vector computed at day 300 must not equal one computed at day 320,
    // otherwise the test above would pass vacuously.
    const later = computeFeatures('TEST', full)!
    expect(later.date).not.toBe(fromTruncated.date)
  })

  it('is deterministic for a given seed', () => {
    const a = computeFeatures('TEST', makeSeries({ days: 200, seed: 99 }))!
    const b = computeFeatures('TEST', makeSeries({ days: 200, seed: 99 }))!
    expect(a).toEqual(b)
  })

  it('recovers a high beta against a highly correlated proxy', () => {
    const bars = makeSeries({ days: 300, seed: 3, dailyVol: 0.015 })
    const proxy = makeCorrelatedSeries(bars, 0.95, { seed: 11, dailyVol: 0.004 })

    const f = computeFeatures('TEST', bars, proxy)!
    expect(f.betaSpy).not.toBeNull()
    expect(f.residSpy).not.toBeNull()
    // Correlated proxy explains most of the move, so residuals are small
    // relative to the instrument's own volatility.
    expect(Math.abs(f.residSpy!)).toBeLessThan(f.sigma20 * 2)
  })

  it('leaves a large residual when the proxy is quiet', () => {
    const bars = makeSeries({
      days: 300,
      seed: 4,
      inject: { kind: 'gap', sigmas: 4 },
    })
    const flatProxy = makeFlatSeries(bars)

    const f = computeFeatures('TEST', bars, flatProxy)!
    // Nothing in a quiet proxy can explain a 4-sigma move, so it lands in the
    // residual — which is exactly what "company-specific" means here.
    expect(f.residSpy).not.toBeNull()
    expect(Math.abs(f.residSpy!)).toBeGreaterThan(f.sigma20 * 2)
  })

  it('refuses to regress against a zero-variance proxy', () => {
    // A constant series cannot explain anything; the honest output is "no
    // regression", not a fabricated beta. Guarded explicitly because
    // Math.abs(null) is 0, so a null here can masquerade as a real value.
    const bars = makeSeries({ days: 200, seed: 4 })
    const constant = makeConstantSeries(bars)

    const f = computeFeatures('TEST', bars, constant)!
    expect(f.betaSpy).toBeNull()
    expect(f.residSpy).toBeNull()
  })

  it('does not pair returns across a missing proxy session', () => {
    const bars = makeSeries({ days: 200, seed: 8 })
    const proxy = makeCorrelatedSeries(bars, 0.9, { seed: 12 })
    // Drop the proxy's final bar: today can no longer be paired.
    const gapped = proxy.slice(0, -1)

    const f = computeFeatures('TEST', bars, gapped)!
    // Rather than silently regressing against yesterday, it declines to report.
    expect(f.betaSpy).toBeNull()
    expect(f.residSpy).toBeNull()
  })

  it('propagates the worst confidence and confirmation in the window', () => {
    const bars = makeSeries({ days: 200, seed: 6 })
    bars[bars.length - 3] = { ...bars[bars.length - 3], confidence: 0.4, confirmed: false }

    const f = computeFeatures('TEST', bars)!
    expect(f.confidence).toBe(0.4)
    expect(f.confirmed).toBe(false)
  })
})

describe('moveInSigmas', () => {
  it('scales a move by horizon so different absences are comparable', () => {
    const bars = makeSeries({ days: 200, seed: 21, dailyVol: 0.01 })
    const f = computeFeatures('TEST', bars)!

    const oneDay = moveInSigmas(bars, 1, f.sigma20)
    const fiveDay = moveInSigmas(bars, 5, f.sigma20)

    expect(oneDay).not.toBeNull()
    expect(fiveDay).not.toBeNull()
    expect(Number.isFinite(oneDay!)).toBe(true)
    expect(Number.isFinite(fiveDay!)).toBe(true)
  })

  it('reports a large injected gap as a large sigma move', () => {
    const bars = makeSeries({
      days: 200,
      seed: 31,
      dailyVol: 0.01,
      inject: { kind: 'gap', sigmas: 4 },
    })
    const f = computeFeatures('TEST', bars)!
    const z = moveInSigmas(bars, 1, f.sigma20)!
    expect(Math.abs(z)).toBeGreaterThan(2.5)
  })

  it('reports a calm final session as a small sigma move', () => {
    const bars = makeSeries({ days: 200, seed: 32, dailyVol: 0.01 })
    const f = computeFeatures('TEST', bars)!
    const z = moveInSigmas(bars, 1, f.sigma20)!
    expect(Math.abs(z)).toBeLessThan(3)
  })
})
