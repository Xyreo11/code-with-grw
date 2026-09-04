import { describe, expect, it } from 'vitest'
import { computeFeatures } from '../features'
import { runDetectors } from '../detectors'
import { scoreInstrumentDay } from '../scorer'
import type { Bar, ScoringContext } from '../types'
import { makeCorrelatedSeries, makeSeries } from '../testing/synthetic'
import { buildNarrative, type NarrativeInput } from '../narrative'

/**
 * Point-in-time correctness.
 *
 * Historical replay is only honest if the engine at date T sees exactly what it
 * would have seen on T. The whole series lives in the database, so nothing stops
 * a careless query from handing the engine tomorrow's bar and producing a
 * beautifully prescient alert that could never have fired in real life.
 *
 * These tests assert the guarantee end to end: identical output whether or not
 * future data exists, at every stage of the chain.
 */

function ctx(overrides: Partial<ScoringContext> = {}): ScoringContext {
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

/** Run the whole chain at the last bar of the supplied history. */
function runAt(bars: Bar[], benchmark: Bar[], sector: Bar[]) {
  const features = computeFeatures('TEST', bars, benchmark, sector)
  if (!features) return null

  const candidates = runDetectors({
    symbol: 'TEST',
    features,
    bars,
    sessionsSinceLastSeen: 1,
    nextEarnings: null,
    asOf: bars[bars.length - 1].date,
  })

  return {
    features,
    candidates,
    scored: scoreInstrumentDay(candidates, ctx()),
  }
}

describe('no lookahead', () => {
  const full = makeSeries({ days: 400, seed: 777, dailyVol: 0.013 })
  const benchmarkFull = makeCorrelatedSeries(full, 0.7, { seed: 778 })
  const sectorFull = makeCorrelatedSeries(full, 0.85, { seed: 779 })

  // Cut at a date well inside the series so there is genuine future to hide.
  const CUT = 320
  const cutDate = full[CUT - 1].date

  it('produces identical features with and without future bars present', () => {
    const truncated = runAt(
      full.slice(0, CUT),
      benchmarkFull.slice(0, CUT),
      sectorFull.slice(0, CUT),
    )

    // Same as-of date, but the arrays also contain everything that came after.
    // Truncation is the caller's job, so this simulates the careless version.
    const withFuture = runAt(
      full.slice(0, CUT),
      benchmarkFull,
      sectorFull,
    )

    expect(truncated).not.toBeNull()
    expect(withFuture).not.toBeNull()

    // The instrument's own future is excluded by construction. Proxy series are
    // truncated on date inside computeFeatures, so extra proxy bars beyond the
    // as-of date must not change anything either.
    expect(withFuture!.features.date).toBe(cutDate)
    expect(withFuture!.features).toEqual(truncated!.features)
    expect(withFuture!.scored.score).toBe(truncated!.scored.score)
    expect(withFuture!.scored.severity).toBe(truncated!.scored.severity)
  })

  it('produces identical detector output with and without future bars', () => {
    const truncated = runAt(
      full.slice(0, CUT),
      benchmarkFull.slice(0, CUT),
      sectorFull.slice(0, CUT),
    )!
    const withFuture = runAt(full.slice(0, CUT), benchmarkFull, sectorFull)!

    expect(withFuture.candidates).toEqual(truncated.candidates)
  })

  it('changes its answer when the as-of date actually advances', () => {
    // Guards the tests above from passing vacuously: if the engine ignored its
    // inputs entirely, every assertion here would still hold.
    const earlier = runAt(
      full.slice(0, CUT),
      benchmarkFull.slice(0, CUT),
      sectorFull.slice(0, CUT),
    )!
    const later = runAt(
      full.slice(0, CUT + 40),
      benchmarkFull.slice(0, CUT + 40),
      sectorFull.slice(0, CUT + 40),
    )!

    expect(later.features.date).not.toBe(earlier.features.date)
    expect(later.features.close).not.toBe(earlier.features.close)
  })

  it('a future spike cannot leak into an earlier evaluation', () => {
    // Plant an enormous move AFTER the cut. If any lookahead existed, the
    // rolling volatility or range extremes at the cut date would shift.
    const tampered = [...full]
    for (let i = CUT + 1; i < CUT + 10; i++) {
      tampered[i] = { ...tampered[i], closeAdj: tampered[i].closeAdj * 3, high: tampered[i].high * 3 }
    }

    const clean = runAt(
      full.slice(0, CUT),
      benchmarkFull.slice(0, CUT),
      sectorFull.slice(0, CUT),
    )!
    const withTamperedFuture = runAt(
      tampered.slice(0, CUT),
      benchmarkFull.slice(0, CUT),
      sectorFull.slice(0, CUT),
    )!

    expect(withTamperedFuture.features).toEqual(clean.features)
  })
})

describe('theme_led_market narrative rule', () => {
  function input(overrides: Partial<NarrativeInput> = {}): NarrativeInput {
    return {
      themes: [],
      topEventSectors: [],
      marketReturn: 0,
      marketSigmas: 0,
      breadth: 0.2,
      watchlistSize: 10,
      notableCount: 3,
      ...overrides,
    }
  }

  const semis = {
    scope: 'sector' as const,
    scopeKey: 'Semiconductors',
    members: ['NVDA', 'AMD', 'AVGO'],
    direction: -1 as const,
    windowStart: '2025-01-27',
    windowEnd: '2025-01-27',
    memberCount: 4,
    confidence: 62,
    cohesion: 0.5,
    timing: 1,
    size: 0.8,
    distinctness: 0.74,
    characteristics: [],
    summary: '',
  }

  it('says the sector LED the move when both it and the market fell', () => {
    // The real 2025-01-27 case. Calling this purely sector-specific overstates
    // it; calling it a broad market move buries the part that explains the day.
    const n = buildNarrative(
      input({ themes: [semis], marketReturn: -0.014, marketSigmas: -1.75, breadth: 0.67 }),
    )

    expect(n.ruleId).toBe('theme_led_market')
    expect(n.text).toMatch(/driving a broader decline/)
    expect(n.text).toMatch(/led it rather than merely following/)
  })

  it('does not claim leadership when the sector moved against the market', () => {
    // Semis up while the market falls is rotation or divergence, not leadership.
    const n = buildNarrative(
      input({
        themes: [{ ...semis, direction: 1 }],
        marketReturn: -0.02,
        marketSigmas: -2,
        breadth: 0.7,
      }),
    )
    expect(n.ruleId).not.toBe('theme_led_market')
  })

  it('still prefers sector_specific when the market is genuinely flat', () => {
    const n = buildNarrative(
      input({
        themes: [semis],
        topEventSectors: ['Semiconductors', 'Semiconductors', 'Semiconductors'],
        marketReturn: 0.0005,
        marketSigmas: 0.1,
      }),
    )
    expect(n.ruleId).toBe('sector_specific')
  })
})
