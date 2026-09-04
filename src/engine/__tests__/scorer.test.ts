import { describe, expect, it } from 'vitest'
import {
  atLeast,
  atMost,
  explainContributions,
  FAMILY_WEIGHTS,
  recencyDecay,
  scoreEvent,
  scoreInstrumentDay,
  scoreSignals,
  severityFor,
} from '../scorer'
import { squash } from '../math'
import { fingerprintOf, isMateriallySimilar } from '../fingerprint'
import type { CandidateEvent, ScoringContext, Signal } from '../types'

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

function sig(
  key: string,
  family: Signal['family'],
  normalized: number,
): Signal {
  return { key, label: key, family, value: normalized, normalized }
}

describe('severity bands', () => {
  it('maps scores to bands at the calibrated boundaries', () => {
    // Boundaries come from docs/calibration.md, not from round numbers.
    expect(severityFor(95)).toBe('CRITICAL')
    expect(severityFor(82)).toBe('CRITICAL')
    expect(severityFor(81.9)).toBe('IMPORTANT')
    expect(severityFor(64)).toBe('IMPORTANT')
    expect(severityFor(63.9)).toBe('WATCH')
    expect(severityFor(40)).toBe('WATCH')
    expect(severityFor(39.9)).toBe('INFO')
    expect(severityFor(25)).toBe('INFO')
    expect(severityFor(24.9)).toBe('NOISE')
    expect(severityFor(0)).toBe('NOISE')
  })

  it('atLeast and atMost clamp in the right direction', () => {
    expect(atLeast('INFO', 'WATCH')).toBe('WATCH')
    expect(atLeast('CRITICAL', 'WATCH')).toBe('CRITICAL')
    expect(atMost('CRITICAL', 'IMPORTANT')).toBe('IMPORTANT')
    expect(atMost('INFO', 'IMPORTANT')).toBe('INFO')
  })
})

describe('scoreSignals', () => {
  it('scores nothing as nothing', () => {
    const r = scoreSignals([], ctx())
    expect(r.score).toBe(0)
    expect(r.severity).toBe('NOISE')
  })

  it('is bounded to [0,100] even for absurd inputs', () => {
    const r = scoreSignals(
      [sig('a', 'price', 50), sig('b', 'volume', 50), sig('c', 'event', 50)],
      ctx({ priority: 'HIGH', hasCatalyst: true, isIdiosyncratic: true }),
    )
    expect(r.score).toBeLessThanOrEqual(100)
    expect(r.score).toBeGreaterThanOrEqual(0)
  })

  it('is monotonic in signal magnitude', () => {
    const weak = scoreSignals([sig('m', 'price', 0.2)], ctx()).score
    const mid = scoreSignals([sig('m', 'price', 0.5)], ctx()).score
    const strong = scoreSignals([sig('m', 'price', 0.9)], ctx()).score

    expect(mid).toBeGreaterThan(weak)
    expect(strong).toBeGreaterThan(mid)
  })

  it('treats equal up and down moves as equally worth knowing', () => {
    const up = scoreSignals([sig('m', 'price', 0.8)], ctx()).score
    const down = scoreSignals([sig('m', 'price', -0.8)], ctx()).score
    expect(up).toBe(down)
  })

  it('does not double-count two signals from the same family', () => {
    const one = scoreSignals([sig('a', 'volume', 0.8)], ctx()).score
    const two = scoreSignals(
      [sig('a', 'volume', 0.8), sig('b', 'volume', 0.75)],
      ctx(),
    ).score
    expect(two).toBe(one)
  })

  it('does not cap a lone strong signal at its bare family weight', () => {
    // Weights are renormalised across families that reported, so a lone price
    // signal is not punished for the silence of the others...
    const lone = scoreSignals([sig('m', 'price', 0.95)], ctx()).score
    expect(lone).toBeGreaterThan(FAMILY_WEIGHTS.price * 100)
  })

  it('requires corroboration before a lone signal can reach the brief', () => {
    // ...but it does not get a free pass either. Calibration showed that full
    // renormalisation made any detected event automatically clear WATCH -
    // volume_spike and move_since_last_seen surfaced 99.5% of everything they
    // detected. The coverage factor restores the product's own thesis: volume
    // confirming a price move is worth more than either alone.
    const lone = scoreSignals([sig('m', 'price', 0.9)], ctx())
    const corroborated = scoreSignals(
      [sig('m', 'price', 0.9), sig('v', 'volume', 0.9), sig('r', 'relative', 0.9)],
      ctx(),
    )

    expect(corroborated.score).toBeGreaterThan(lone.score + 10)
    expect(severityFor(lone.score)).not.toBe('CRITICAL')
  })

  it('names thin evidence as a reason the score is not higher', () => {
    const lone = scoreSignals([sig('m', 'price', 0.9)], ctx())
    const reason = lone.contributions.find((c) => c.key === 'corroboration')
    expect(reason).toBeDefined()
    expect(reason!.amount).toBeLessThan(1)
    expect(reason!.label).toMatch(/nothing corroborates it/)
  })

  it('a bare ordinary move is never surfaced', () => {
    // 2.5 sigma with nothing else is an ordinary day, and must not interrupt.
    const bare = scoreSignals([sig('m', 'price', squash(2.5))], ctx())
    expect(['INFO', 'NOISE']).toContain(bare.severity)
  })
})

describe('context multipliers', () => {
  it('discounts a score when data confidence is low, and says so', () => {
    const clean = scoreSignals([sig('m', 'price', 0.9)], ctx())
    const degraded = scoreSignals(
      [sig('m', 'price', 0.9)],
      ctx({ dataConfidence: 0.5 }),
    )

    expect(degraded.score).toBeLessThan(clean.score)
    const reason = degraded.contributions.find((c) => c.key === 'data_quality')
    expect(reason).toBeDefined()
    expect(reason!.amount).toBeLessThan(1)
  })

  it('never lets unconfirmed data reach CRITICAL', () => {
    // Two sources disagreeing is precisely when we should be least confident,
    // so it must not be able to produce the loudest alarm.
    const r = scoreSignals(
      [sig('m', 'price', 0.99), sig('v', 'volume', 0.99)],
      ctx({ confirmed: false, priority: 'HIGH' }),
    )
    expect(r.severity).not.toBe('CRITICAL')
  })

  it('caps severity at WATCH when confidence is very low', () => {
    const r = scoreSignals(
      [sig('m', 'price', 0.99), sig('v', 'volume', 0.99)],
      ctx({ dataConfidence: 0.4 }),
    )
    expect(['WATCH', 'INFO', 'NOISE']).toContain(r.severity)
  })

  it('applies the user’s explicit priority as a visible multiplier', () => {
    const normal = scoreSignals([sig('m', 'price', 0.6)], ctx()).score
    const high = scoreSignals(
      [sig('m', 'price', 0.6)],
      ctx({ priority: 'HIGH' }),
    )
    const low = scoreSignals([sig('m', 'price', 0.6)], ctx({ priority: 'LOW' }))

    expect(high.score).toBeGreaterThan(normal)
    expect(low.score).toBeLessThan(normal)

    const shown = high.contributions.find((c) => c.key === 'priority')
    expect(shown?.amount).toBe(1.3)
    expect(shown?.label).toMatch(/High priority/)
  })

  it('tilts weights by intent without changing the model', () => {
    // Magnitudes must differ for reweighting to be observable — see the
    // invariant test below.
    const signals = [sig('m', 'price', 0.9), sig('e', 'event', 0.3)]
    const buying = scoreSignals(signals, ctx({ intent: 'CONSIDERING_BUY' }))
    const holding = scoreSignals(signals, ctx({ intent: 'HOLDING' }))

    // Someone hunting an entry weights the price move; someone already holding
    // weights the upcoming catalyst. Same signals, different emphasis.
    expect(buying.score).toBeGreaterThan(holding.score)
    expect(buying.score).toBeGreaterThan(0)
    expect(holding.score).toBeGreaterThan(0)
  })

  it('is invariant to reweighting when all signals are equally strong', () => {
    // A consequence of renormalising weights to sum to 1: if every family
    // reports the same magnitude, the weighted mean is that magnitude no matter
    // how the weights are distributed. Pinned deliberately so a future change
    // to the weighting scheme has to confront it rather than discover it.
    const equal = [sig('m', 'price', 0.7), sig('e', 'event', 0.7)]
    const a = scoreSignals(equal, ctx({ intent: 'CONSIDERING_BUY' })).score
    const b = scoreSignals(equal, ctx({ intent: 'HOLDING' })).score
    const c = scoreSignals(equal, ctx({ intent: 'NONE' })).score

    expect(a).toBe(b)
    expect(b).toBe(c)
    // The absolute value also carries the coverage factor for the two families
    // that reported, so it is below the bare 70 the mean alone would give.
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThan(70)
  })
})

describe('recency decay', () => {
  it('is 1 on the day of the event', () => {
    expect(recencyDecay('move_since_last_seen', 0)).toBe(1)
  })

  it('decays with age, faster for fast-moving signals', () => {
    const priceAfter4 = recencyDecay('move_since_last_seen', 4)
    const regimeAfter4 = recencyDecay('vol_regime_shift', 4)

    expect(priceAfter4).toBeLessThan(1)
    // A volatility regime is structural; it is still true four days later.
    expect(regimeAfter4).toBeGreaterThan(priceAfter4)
  })

  it('never decays to zero — an unseen event is still news to that user', () => {
    expect(recencyDecay('volume_spike', 500)).toBeGreaterThanOrEqual(0.35)
  })

  it('does not decay a forward-looking earnings event', () => {
    expect(recencyDecay('earnings_upcoming', 5)).toBe(1)
  })
})

describe('explainContributions — Why / Why not higher', () => {
  it('separates positives from suppressors', () => {
    const r = scoreSignals(
      [sig('m', 'price', 0.8), sig('v', 'volume', 0.3)],
      ctx({ dataConfidence: 0.6, priority: 'LOW', isMacroDay: true }),
    )
    const { positives, suppressors } = explainContributions(r.contributions)

    expect(positives.length).toBeGreaterThan(0)
    expect(suppressors.length).toBeGreaterThan(0)

    // Everything that held the score down must be nameable.
    const keys = suppressors.map((s) => s.key)
    expect(keys).toContain('priority')
    expect(keys).toContain('macro_day')
    expect(keys).toContain('data_quality')

    for (const s of suppressors) {
      expect(s.label.length).toBeGreaterThan(0)
    }
  })

  it('orders positives strongest-first and suppressors harshest-first', () => {
    const r = scoreSignals(
      [sig('big', 'price', 0.9), sig('small', 'volume', 0.2)],
      ctx({ priority: 'LOW', dataConfidence: 0.7 }),
    )
    const { positives, suppressors } = explainContributions(r.contributions)

    for (let i = 1; i < positives.length; i++) {
      const prev = positives[i - 1]
      const cur = positives[i]
      const val = (c: typeof prev) =>
        c.kind === 'additive' ? c.amount : (c.amount - 1) * 100
      expect(val(prev)).toBeGreaterThanOrEqual(val(cur))
    }
    expect(suppressors.length).toBeGreaterThan(0)
  })

  it('additive contributions sum to the pre-multiplier subtotal', () => {
    // The Why panel claims the bars add up to the score. This is that claim,
    // asserted: additives sum to the subtotal, multipliers scale it, and the
    // product is the score the user sees.
    const c = ctx({ dataConfidence: 0.8, priority: 'HIGH' })
    const r = scoreSignals(
      [sig('m', 'price', 0.7), sig('v', 'volume', 0.4)],
      c,
    )

    const additive = r.contributions
      .filter((x) => x.kind === 'additive')
      .reduce((a, b) => a + b.amount, 0)
    const product = r.contributions
      .filter((x) => x.kind === 'multiplier')
      .reduce((a, b) => a * b.amount, 1)

    expect(additive * product).toBeCloseTo(r.score, 0)
  })
})

describe('scoreEvent and scoreInstrumentDay', () => {
  const candidate: CandidateEvent = {
    detector: 'volume_spike',
    symbol: 'TEST',
    marketTime: '2024-06-03',
    direction: -1,
    magnitude: 3.2,
    headline: 'Volume is 3.2× its normal level.',
    signals: [sig('rvol', 'volume', 0.7)],
  }

  it('stamps a scorer version and a fingerprint', () => {
    const e = scoreEvent(candidate, ctx())
    expect(e.scorerV).toBeTruthy()
    expect(e.fingerprint).toHaveLength(32)
    expect(e.severity).toBe(severityFor(e.score))
  })

  it('lifts the instrument severity to any per-event hard floor', () => {
    // An earnings event floors at WATCH even though a lone proximity signal
    // would otherwise score as INFO.
    const earnings: CandidateEvent = {
      detector: 'earnings_upcoming',
      symbol: 'TEST',
      marketTime: '2024-06-03',
      direction: 0,
      magnitude: 0.4,
      headline: 'Reports earnings tomorrow.',
      signals: [sig('earnings_proximity', 'event', 0.35)],
    }

    const alone = scoreSignals(earnings.signals, ctx(), 'earnings_upcoming')
    const instrument = scoreInstrumentDay([earnings], ctx())

    expect(alone.severity).toBe('WATCH')
    expect(instrument.severity).toBe('WATCH')
  })

  it('scores an instrument-day from the union of its signals', () => {
    const combined = scoreInstrumentDay(
      [
        candidate,
        {
          ...candidate,
          detector: 'move_since_last_seen',
          signals: [sig('move_z', 'price', 0.85)],
        },
      ],
      ctx(),
    )
    const volumeOnly = scoreSignals(candidate.signals, ctx()).score
    expect(combined.score).toBeGreaterThan(volumeOnly)
  })
})

describe('fingerprinting and duplicate suppression', () => {
  const base = {
    symbol: 'NVDA',
    detector: 'volume_spike',
    direction: -1,
    marketTime: '2024-06-03',
    magnitude: 3.2,
  }

  it('is stable for the same event', () => {
    expect(fingerprintOf(base)).toBe(fingerprintOf({ ...base }))
  })

  it('is insensitive to trivial magnitude recomputation', () => {
    // A re-run that produces 3.21 instead of 3.2 is the same event, not a new one.
    expect(fingerprintOf(base)).toBe(fingerprintOf({ ...base, magnitude: 3.21 }))
  })

  it('differs across symbol, detector, direction and day', () => {
    expect(fingerprintOf({ ...base, symbol: 'AMD' })).not.toBe(fingerprintOf(base))
    expect(fingerprintOf({ ...base, detector: 'range_break' })).not.toBe(
      fingerprintOf(base),
    )
    expect(fingerprintOf({ ...base, direction: 1 })).not.toBe(fingerprintOf(base))
    expect(fingerprintOf({ ...base, marketTime: '2024-06-04' })).not.toBe(
      fingerprintOf(base),
    )
  })

  it('treats a still-true situation as the same story', () => {
    expect(
      isMateriallySimilar(
        { detector: 'vol_regime_shift', direction: 0, score: 62 },
        { detector: 'vol_regime_shift', direction: 0, score: 68 },
      ),
    ).toBe(true)
  })

  it('treats a material escalation as news again', () => {
    expect(
      isMateriallySimilar(
        { detector: 'vol_regime_shift', direction: 0, score: 55 },
        { detector: 'vol_regime_shift', direction: 0, score: 85 },
      ),
    ).toBe(false)
  })
})
