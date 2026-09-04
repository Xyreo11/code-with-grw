import { describe, expect, it } from 'vitest'
import {
  computeThemeConfidence,
  confidenceBand,
  detectThemes,
  MIN_THEME_CONFIDENCE,
  MIN_THEME_DISTINCTNESS,
  MIN_THEME_MEMBERS,
  type ThemeMember,
} from '../theme'
import { buildNarrative, type NarrativeInput } from '../narrative'
import { rng } from '../testing/synthetic'

/**
 * The decisive property of theme detection is not that it groups things — it is
 * that it refuses to group things when the whole market is moving. These tests
 * are built around that contrast.
 */

/** Residual series that genuinely co-move, as a real sector cluster would. */
function correlatedResiduals(count: number, n = 90, seed = 1): number[][] {
  const next = rng(seed)
  const common: number[] = []
  for (let i = 0; i < n; i++) common.push((next() - 0.5) * 0.02)

  return Array.from({ length: count }, (_, k) => {
    const noise = rng(seed + k + 1)
    return common.map((c) => c * 0.85 + (noise() - 0.5) * 0.006)
  })
}

/** Residual series that are mutually independent — no shared story. */
function independentResiduals(count: number, n = 90, seed = 50): number[][] {
  return Array.from({ length: count }, (_, k) => {
    const next = rng(seed + k * 17)
    return Array.from({ length: n }, () => (next() - 0.5) * 0.02)
  })
}

function members(
  symbols: string[],
  opts: {
    sector?: string
    direction?: -1 | 1
    date?: string
    ret: number
    marketExplained: number
    residuals: number[][]
  },
): ThemeMember[] {
  const {
    sector = 'Semiconductors',
    direction = -1,
    date = '2024-03-08',
    ret,
    marketExplained,
    residuals,
  } = opts

  return symbols.map((symbol, i) => ({
    symbol,
    sector,
    direction,
    marketTime: date,
    score: 70 - i,
    residualSeries: residuals[i],
    ret,
    // Test members are constructed as genuine participants unless a test says
    // otherwise; the participation gate is exercised separately below.
    moveSigmas: ret < 0 ? -3 : 3,
    marketExplained,
  }))
}

describe('computeThemeConfidence', () => {
  it('is high for a tight, simultaneous, market-independent cluster', () => {
    const c = computeThemeConfidence(
      members(['NVDA', 'AMD', 'AVGO', 'MU'], {
        ret: -0.06,
        // The market explains almost none of a 6% drop.
        marketExplained: -0.004,
        residuals: correlatedResiduals(4),
      }),
      '2024-03-08',
      '2024-03-08',
    )

    expect(c.cohesion).toBeGreaterThan(0.5)
    expect(c.timing).toBe(1)
    expect(c.distinctness).toBeGreaterThan(0.8)
    expect(c.confidence).toBeGreaterThan(75)
    expect(confidenceBand(c.confidence)).toBe('High')
  })

  it('collapses distinctness when the market explains the move', () => {
    // The COVID case: these names did fall together, but so did everything.
    const c = computeThemeConfidence(
      members(['NVDA', 'AMD', 'AVGO', 'MU'], {
        ret: -0.09,
        marketExplained: -0.085,
        residuals: correlatedResiduals(4),
      }),
      '2020-03-16',
      '2020-03-16',
    )

    expect(c.distinctness).toBeLessThan(0.15)
    expect(c.confidence).toBeLessThan(75)
  })

  it('penalises members whose events straggle across the window', () => {
    const base = members(['NVDA', 'AMD', 'AVGO'], {
      ret: -0.05,
      marketExplained: -0.003,
      residuals: correlatedResiduals(3),
    })
    const staggered = base.map((m, i) => ({
      ...m,
      marketTime: ['2024-03-01', '2024-03-06', '2024-03-11'][i],
    }))

    const tight = computeThemeConfidence(base, '2024-03-01', '2024-03-11')
    const loose = computeThemeConfidence(staggered, '2024-03-01', '2024-03-11')

    expect(loose.timing).toBeLessThan(tight.timing)
    expect(loose.confidence).toBeLessThan(tight.confidence)
  })

  it('rewards more corroborating members up to saturation', () => {
    const three = computeThemeConfidence(
      members(['A', 'B', 'C'], {
        ret: -0.05,
        marketExplained: -0.003,
        residuals: correlatedResiduals(3),
      }),
      '2024-03-08',
      '2024-03-08',
    )
    const five = computeThemeConfidence(
      members(['A', 'B', 'C', 'D', 'E'], {
        ret: -0.05,
        marketExplained: -0.003,
        residuals: correlatedResiduals(5),
      }),
      '2024-03-08',
      '2024-03-08',
    )

    expect(five.size).toBeGreaterThan(three.size)
    expect(five.size).toBe(1)
  })

  it('gives low cohesion to names that do not actually move together', () => {
    const c = computeThemeConfidence(
      members(['A', 'B', 'C', 'D'], {
        ret: -0.05,
        marketExplained: -0.003,
        residuals: independentResiduals(4),
      }),
      '2024-03-08',
      '2024-03-08',
    )
    expect(c.cohesion).toBeLessThan(0.4)
  })
})

describe('detectThemes', () => {
  it('detects a semiconductor theme on a calm market day', () => {
    const themes = detectThemes(
      members(['NVDA', 'AMD', 'AVGO', 'MU'], {
        ret: -0.062,
        marketExplained: -0.004,
        residuals: correlatedResiduals(4),
      }),
      '2024-03-08',
      '2024-03-08',
    )

    expect(themes).toHaveLength(1)
    const t = themes[0]
    expect(t.scopeKey).toBe('Semiconductors')
    expect(t.direction).toBe(-1)
    expect(t.memberCount).toBe(4)
    expect(t.members).toContain('NVDA')
    expect(t.confidence).toBeGreaterThan(MIN_THEME_CONFIDENCE)
    expect(t.summary).toMatch(/selling pressure/)
    expect(t.characteristics.length).toBeGreaterThan(0)
  })

  it('does NOT report a sector theme when the whole market is falling', () => {
    // The single most important assertion in theme detection. On a day like
    // 2020-03-16 every sector "moves together"; calling that a semiconductor
    // story would be confidently wrong and actively misleading.
    const themes = detectThemes(
      members(['NVDA', 'AMD', 'AVGO', 'MU', 'INTC'], {
        ret: -0.11,
        marketExplained: -0.105,
        residuals: correlatedResiduals(5),
        date: '2020-03-16',
      }),
      '2020-03-16',
      '2020-03-16',
    )

    expect(themes).toHaveLength(0)
  })

  it('vetoes on distinctness alone, even when every other component is perfect', () => {
    // Guards the specific failure mode: cohesion, timing and size alone carry a
    // weighted sum past the confidence floor, so distinctness has to be able to
    // veto rather than merely vote.
    const marketWide = members(['NVDA', 'AMD', 'AVGO', 'MU', 'INTC'], {
      ret: -0.11,
      marketExplained: -0.108,
      residuals: correlatedResiduals(5),
      date: '2020-03-16',
    })

    const conf = computeThemeConfidence(marketWide, '2020-03-16', '2020-03-16')
    // Every other component is at or near its maximum...
    expect(conf.timing).toBe(1)
    expect(conf.size).toBe(1)
    expect(conf.cohesion).toBeGreaterThan(0.5)
    // ...and the weighted total still clears the confidence floor.
    expect(conf.confidence).toBeGreaterThan(MIN_THEME_CONFIDENCE)
    // The gate is what stops it.
    expect(conf.distinctness).toBeLessThan(MIN_THEME_DISTINCTNESS)
    expect(detectThemes(marketWide, '2020-03-16', '2020-03-16')).toHaveLength(0)
  })

  it('excludes a name that barely moved, even in the right direction', () => {
    // The real 2025-01-27 case: QCOM closed -0.5% while its sector fell double
    // digits. The sign matches the theme, but the name did not take part, and
    // including it both overstated the theme and contradicted QCOM's own card,
    // which said it OUTPERFORMED its sector.
    const participants = members(['NVDA', 'AMD', 'AVGO'], {
      ret: -0.09,
      marketExplained: -0.005,
      residuals: correlatedResiduals(3),
    })
    const bystander = {
      ...participants[0],
      symbol: 'QCOM',
      ret: -0.005,
      moveSigmas: -0.3,
    }

    const themes = detectThemes(
      [...participants, bystander],
      '2025-01-27',
      '2025-01-27',
    )

    expect(themes).toHaveLength(1)
    expect(themes[0].members).not.toContain('QCOM')
    expect(themes[0].memberCount).toBe(3)
  })

  it('requires a minimum number of members', () => {
    const themes = detectThemes(
      members(['NVDA', 'AMD'], {
        ret: -0.06,
        marketExplained: -0.003,
        residuals: correlatedResiduals(2),
      }),
      '2024-03-08',
      '2024-03-08',
    )
    expect(MIN_THEME_MEMBERS).toBe(3)
    expect(themes).toHaveLength(0)
  })

  it('does not merge opposite directions into one theme', () => {
    const down = members(['NVDA', 'AMD', 'AVGO'], {
      ret: -0.06,
      marketExplained: -0.003,
      residuals: correlatedResiduals(3, 90, 2),
      direction: -1,
    })
    const up = members(['MU', 'INTC', 'QCOM'], {
      ret: 0.06,
      marketExplained: 0.003,
      residuals: correlatedResiduals(3, 90, 9),
      direction: 1,
    })

    const themes = detectThemes([...down, ...up], '2024-03-08', '2024-03-08')
    for (const t of themes) {
      const isDown = t.direction === -1
      expect(t.members.every((m) => (isDown ? down : up).some((x) => x.symbol === m))).toBe(true)
    }
  })

  it('stores every confidence component, not just the total', () => {
    // A theme has to be explainable the same way an event is.
    const [t] = detectThemes(
      members(['NVDA', 'AMD', 'AVGO', 'MU'], {
        ret: -0.062,
        marketExplained: -0.004,
        residuals: correlatedResiduals(4),
      }),
      '2024-03-08',
      '2024-03-08',
    )

    expect(t.cohesion).toBeGreaterThanOrEqual(0)
    expect(t.timing).toBeGreaterThanOrEqual(0)
    expect(t.size).toBeGreaterThanOrEqual(0)
    expect(t.distinctness).toBeGreaterThanOrEqual(0)
  })
})

describe('buildNarrative', () => {
  function input(overrides: Partial<NarrativeInput> = {}): NarrativeInput {
    return {
      themes: [],
      topEventSectors: [],
      marketReturn: 0.001,
      marketSigmas: 0.2,
      breadth: 0.1,
      watchlistSize: 17,
      notableCount: 3,
      ...overrides,
    }
  }

  const semisTheme = {
    scope: 'sector' as const,
    scopeKey: 'Semiconductors',
    members: ['NVDA', 'AMD', 'AVGO'],
    direction: -1 as const,
    windowStart: '2024-03-08',
    windowEnd: '2024-03-08',
    memberCount: 3,
    confidence: 88,
    cohesion: 0.8,
    timing: 1,
    size: 0.6,
    distinctness: 0.9,
    characteristics: [],
    summary: '',
  }

  it('says nothing needs attention when nothing does', () => {
    const n = buildNarrative(input({ notableCount: 0 }))
    expect(n.ruleId).toBe('quiet')
    expect(n.text).toMatch(/Nothing in your watchlist needs attention/)
  })

  it('does not call a muted watchlist a calm one', () => {
    const n = buildNarrative(
      input({ notableCount: 0, watchlistSize: 17, snoozedCount: 1 }),
    )

    expect(n.ruleId).toBe('quiet')
    // 16 were genuinely quiet; the 17th was silenced by the user. Claiming all
    // 17 moved normally would assert something the engine never concluded.
    expect(n.text).not.toMatch(/All 17 names/)
    expect(n.text).toMatch(/16 names moved/)
    expect(n.text).toMatch(/1 is snoozed rather than resolved/)
  })

  it('speaks in the singular when exactly one name is notable', () => {
    const n = buildNarrative(input({ notableCount: 1 }))

    expect(n.ruleId).toBe('isolated')
    // The scattered rule's plural phrasing is nonsense about one stock: a
    // single name cannot fail to "share a common driver" with anything.
    expect(n.text).not.toMatch(/they do not share/)
    expect(n.text).not.toMatch(/These look like/)
    expect(n.text).toMatch(/One name needs attention/)
  })

  it('falls back to scattered only when several names move independently', () => {
    const n = buildNarrative(input({ notableCount: 4 }))
    expect(n.ruleId).toBe('scattered')
    expect(n.text).toMatch(/4 names/)
  })

  it('calls out sector-specific pressure when the market is flat', () => {
    const n = buildNarrative(
      input({
        themes: [semisTheme],
        topEventSectors: [
          'Semiconductors',
          'Semiconductors',
          'Semiconductors',
          'Information Technology',
        ],
        marketReturn: 0.001,
        marketSigmas: 0.1,
      }),
    )

    expect(n.ruleId).toBe('sector_specific')
    expect(n.text).toMatch(/concentrated Semiconductors weakness/)
    expect(n.text).toMatch(/rather than a broad market move/)
  })

  it('calls a broad market move what it is', () => {
    const n = buildNarrative(
      input({
        themes: [],
        marketReturn: -0.032,
        marketSigmas: -2.4,
        breadth: 0.82,
      }),
    )

    expect(n.ruleId).toBe('broad_market')
    expect(n.text).toMatch(/broad market move/)
    expect(n.text).toMatch(/82%/)
  })

  it('does not claim sector-specificity when the market is also moving hard', () => {
    // Same theme, but the market is down 2.4 sigma. The conclusion must change.
    const n = buildNarrative(
      input({
        themes: [semisTheme],
        topEventSectors: ['Semiconductors', 'Semiconductors', 'Semiconductors'],
        marketReturn: -0.032,
        marketSigmas: -2.4,
        breadth: 0.85,
      }),
    )
    expect(n.ruleId).not.toBe('sector_specific')
  })

  it('describes rotation when sectors move in opposite directions', () => {
    const n = buildNarrative(
      input({
        themes: [semisTheme, { ...semisTheme, scopeKey: 'Energy', direction: 1 }],
      }),
    )
    expect(n.ruleId).toBe('sector_rotation')
    expect(n.text).toMatch(/rotation/)
  })

  it('falls back to scattered when there is no common driver', () => {
    const n = buildNarrative(input({ themes: [], notableCount: 4, breadth: 0.2 }))
    expect(n.ruleId).toBe('scattered')
    expect(n.text).toMatch(/do not share a common driver/)
  })

  it('records the inputs behind every conclusion', () => {
    // The narrative has to be auditable after the fact, not just plausible.
    const n = buildNarrative(
      input({ themes: [], marketReturn: -0.032, marketSigmas: -2.4, breadth: 0.82 }),
    )
    expect(n.inputs).toMatchObject({ breadth: 0.82, marketSigmas: -2.4 })
  })
})
