import { db } from './db'
import { runPipeline, toEngineBars } from './pipeline'
import { detectThemes, type ThemeMember } from '@/engine/theme'
import { buildNarrative } from '@/engine/narrative'
import { scoreSignals, explainContributions } from '@/engine/scorer'
import type { Bar, Contribution, Severity } from '@/engine/types'
import { MARKET_BENCHMARK } from './universe'

/**
 * Historical replay.
 *
 * A judge should not have to wait for the market to do something interesting.
 * Replay steps a curated historical window forward one trading day at a time
 * and shows the same chain the live product runs: events appear, a theme forms,
 * the narrative changes.
 *
 * The hard requirement — and the interesting one — is POINT-IN-TIME
 * CORRECTNESS. At step date T the engine must see exactly what it would have
 * seen on T and nothing after, even though the whole series is sitting in the
 * database. `runPipeline` already guarantees this by construction (it can only
 * read the array it is handed), and `assertNoLookahead` in the tests proves
 * output at T is identical whether or not future bars exist.
 */

export interface ScenarioDefinition {
  slug: string
  name: string
  description: string
  /** What the scenario is meant to demonstrate. Shown in the UI. */
  teaches: string
  startDate: string
  endDate: string
  symbols: string[]
}

/**
 * Two scenarios, chosen as a PAIR.
 *
 * One alone would look cherry-picked. Together they make the argument the
 * product rests on: the engine distinguishes a sector-specific story from a
 * market-wide one, and correctly declines to invent a theme in the second case.
 */
export const SCENARIOS: ScenarioDefinition[] = [
  {
    slug: 'semis-selloff',
    name: 'Semiconductor selloff',
    description:
      'Late January 2025. Semiconductor names fall hard together while the broader market holds up.',
    teaches:
      'A theme forms on 27 Jan with high distinctness, and the narrative identifies the semiconductors as LEADING the selloff rather than merely following the market down. The components are printed on the theme card — compare them with the COVID window, where distinctness collapses and no theme fires.',
    startDate: '2025-01-15',
    endDate: '2025-02-07',
    symbols: ['NVDA', 'AMD', 'AVGO', 'MU', 'INTC', 'QCOM'],
  },
  {
    slug: 'covid-crash',
    name: 'COVID crash',
    description:
      'March 2020. Everything falls at once, across every sector, on enormous volume.',
    teaches:
      'No sector theme is reported. Distinctness collapses when the market explains the move, so the engine says "broad market decline" instead of inventing a story about semiconductors.',
    startDate: '2020-02-24',
    endDate: '2020-03-31',
    symbols: [
      'NVDA',
      'AMD',
      'AVGO',
      'MU',
      'INTC',
      'QCOM',
      'AAPL',
      'MSFT',
      'AMZN',
      'TSLA',
    ],
  },
]

export interface ReplayStep {
  date: string
  /** Instruments that reached the brief on this date. */
  items: Array<{
    symbol: string
    name: string
    sector: string | null
    attentionScore: number
    severity: Severity
    headline: string
    positives: Contribution[]
    suppressors: Contribution[]
    returnPct: number
    sparkline: number[]
  }>
  themes: Array<{
    scopeKey: string
    confidence: number
    cohesion: number
    timing: number
    size: number
    distinctness: number
    members: string[]
    summary: string
    characteristics: string[]
    direction: -1 | 1
  }>
  narrative: { ruleId: string; text: string }
  marketReturnPct: number
  quietCount: number
}

const SURFACED: Severity[] = ['CRITICAL', 'IMPORTANT', 'WATCH']

/**
 * Replay an entire scenario window, one trading day at a time.
 *
 * Computed in a single pass and returned as an array of steps because the
 * window is small (a few weeks) and stepping should feel instant. The cost of
 * recomputing on every click would show.
 */
export async function replayScenario(slug: string): Promise<{
  scenario: ScenarioDefinition
  steps: ReplayStep[]
}> {
  const scenario = SCENARIOS.find((s) => s.slug === slug)
  if (!scenario) throw new Error(`Unknown scenario: ${slug}`)

  const instruments = await db.instrument.findMany({
    where: { symbol: { in: [...scenario.symbols, MARKET_BENCHMARK] } },
    include: { sectorEtf: { select: { symbol: true } } },
  })

  const proxySymbols = [
    ...new Set(
      instruments
        .map((i) => i.sectorEtf?.symbol)
        .filter((s): s is string => Boolean(s)),
    ),
  ]

  const proxies = await db.instrument.findMany({
    where: { symbol: { in: proxySymbols } },
  })

  const seriesFor = new Map<string, Bar[]>()
  for (const inst of [...instruments, ...proxies]) {
    const rows = await db.dailyBar.findMany({
      where: {
        instrumentId: inst.id,
        // Everything needed for a 300-bar feature window plus the scenario, and
        // nothing after the window's end - the replay must not be able to see
        // its own future even in memory.
        barDate: { lte: new Date(`${scenario.endDate}T23:59:59Z`) },
      },
      orderBy: { barDate: 'asc' },
    })
    seriesFor.set(inst.symbol, toEngineBars(rows))
  }

  const benchmark = seriesFor.get(MARKET_BENCHMARK) ?? []

  // Every instrument-day in the window, computed once.
  const dayMap = new Map<string, ReplayStep['items']>()
  const memberMap = new Map<string, ThemeMember[]>()

  for (const inst of instruments) {
    if (inst.symbol === MARKET_BENCHMARK) continue
    const bars = seriesFor.get(inst.symbol) ?? []
    if (bars.length === 0) continue

    const sectorBars = inst.sectorEtf
      ? (seriesFor.get(inst.sectorEtf.symbol) ?? [])
      : []

    const { days } = runPipeline(
      {
        instrument: { symbol: inst.symbol, sector: inst.sector, bars },
        benchmark,
        sector: sectorBars,
      },
      { from: scenario.startDate, to: scenario.endDate, sessionsSinceLastSeen: 1 },
    )

    const barByDate = new Map(bars.map((b, i) => [b.date, i]))

    for (const day of days) {
      if (!SURFACED.includes(day.severity)) continue

      const idx = barByDate.get(day.date)
      if (idx === undefined || idx < 1) continue

      const returnPct = bars[idx].closeAdj / bars[idx - 1].closeAdj - 1
      const { positives, suppressors } = explainContributions(day.contributions)

      // Same rule the live brief uses: lead with the event that owns the
      // top-ranked reason, so the headline and the reasoning underneath it
      // never name different things. Kept in step deliberately - replay exists
      // to show the real engine, not a second presentation of it.
      const top = positives.find((c) => c.kind === 'additive')
      const byScore = [...day.events].sort((a, b) => b.score - a.score)
      const lead =
        (top &&
          byScore.find((e) =>
            e.signals.some(
              (sig) => sig.key === top.key && sig.label === top.label,
            ),
          )) ||
        byScore[0]

      const list = dayMap.get(day.date) ?? []
      list.push({
        symbol: inst.symbol,
        name: inst.name,
        sector: inst.sector,
        attentionScore: Math.round(day.score),
        severity: day.severity,
        headline: lead.headline,
        positives,
        suppressors,
        returnPct,
        sparkline: bars.slice(Math.max(0, idx - 19), idx + 1).map((b) => b.closeAdj),
      })
      dayMap.set(day.date, list)

      const member = themeMemberFor(inst.sector, inst.symbol, bars, benchmark, idx, day.score)
      if (member) {
        const members = memberMap.get(day.date) ?? []
        members.push(member)
        memberMap.set(day.date, members)
      }
    }
  }

  const benchmarkByDate = new Map(benchmark.map((b, i) => [b.date, i]))

  const steps: ReplayStep[] = []
  const dates = [...new Set([...dayMap.keys(), ...tradingDatesIn(benchmark, scenario)])].sort()

  for (const date of dates) {
    const items = (dayMap.get(date) ?? []).sort(
      (a, b) => b.attentionScore - a.attentionScore,
    )
    const members = memberMap.get(date) ?? []
    const themes = members.length >= 3 ? detectThemes(members, date, date) : []

    const bIdx = benchmarkByDate.get(date)
    const marketReturnPct =
      bIdx !== undefined && bIdx > 0
        ? benchmark[bIdx].closeAdj / benchmark[bIdx - 1].closeAdj - 1
        : 0

    const marketSigmas = benchmarkSigmas(benchmark, bIdx)

    const narrative = buildNarrative({
      themes,
      topEventSectors: items.slice(0, 5).map((i) => i.sector ?? ''),
      marketReturn: marketReturnPct,
      marketSigmas,
      breadth:
        scenario.symbols.length > 0 ? items.length / scenario.symbols.length : 0,
      watchlistSize: scenario.symbols.length,
      notableCount: items.length,
    })

    steps.push({
      date,
      items: items.slice(0, 5),
      themes: themes.map((t) => ({
        scopeKey: t.scopeKey,
        confidence: t.confidence,
        cohesion: t.cohesion,
        timing: t.timing,
        size: t.size,
        distinctness: t.distinctness,
        members: t.members,
        summary: t.summary,
        characteristics: t.characteristics,
        direction: t.direction,
      })),
      narrative: { ruleId: narrative.ruleId, text: narrative.text },
      marketReturnPct,
      quietCount: scenario.symbols.length - items.length,
    })
  }

  return { scenario, steps }
}

function tradingDatesIn(benchmark: Bar[], scenario: ScenarioDefinition): string[] {
  return benchmark
    .filter((b) => b.date >= scenario.startDate && b.date <= scenario.endDate)
    .map((b) => b.date)
}

/** How unusual the benchmark's own move was, for the narrative rules. */
function benchmarkSigmas(benchmark: Bar[], idx: number | undefined): number {
  if (idx === undefined || idx < 21) return 0
  const window = benchmark.slice(idx - 20, idx + 1)
  const rets: number[] = []
  for (let i = 1; i < window.length; i++) {
    rets.push(Math.log(window[i].closeAdj / window[i - 1].closeAdj))
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  const variance =
    rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1)
  const sigma = Math.sqrt(variance)
  return sigma > 0 ? rets[rets.length - 1] / sigma : 0
}

function themeMemberFor(
  sector: string | null,
  symbol: string,
  bars: Bar[],
  benchmark: Bar[],
  idx: number,
  score: number,
): ThemeMember | null {
  if (!sector || idx < 91) return null

  const benchmarkByDate = new Map(benchmark.map((b) => [b.date, b]))
  const self: number[] = []
  const proxy: number[] = []

  for (let k = Math.max(1, idx - 90); k <= idx; k++) {
    const cur = benchmarkByDate.get(bars[k].date)
    const prev = benchmarkByDate.get(bars[k - 1]?.date ?? '')
    if (!cur || !prev) continue
    self.push(Math.log(bars[k].closeAdj / bars[k - 1].closeAdj))
    proxy.push(Math.log(cur.closeAdj / prev.closeAdj))
  }
  if (self.length < 20) return null

  const meanX = proxy.reduce((a, b) => a + b, 0) / proxy.length
  const meanY = self.reduce((a, b) => a + b, 0) / self.length
  let cov = 0
  let varx = 0
  for (let k = 0; k < self.length; k++) {
    const dx = proxy[k] - meanX
    cov += dx * (self[k] - meanY)
    varx += dx * dx
  }
  if (varx === 0) return null

  const beta = cov / varx
  const alpha = meanY - beta * meanX
  const ret = bars[idx].closeAdj / bars[idx - 1].closeAdj - 1

  return {
    symbol,
    sector,
    direction: ret < 0 ? -1 : 1,
    marketTime: bars[idx].date,
    score,
    residualSeries: self.map((y, k) => y - (alpha + beta * proxy[k])),
    ret,
    moveSigmas: moveInSigmas(bars, idx),
    marketExplained: beta * proxy[proxy.length - 1],
  }
}

/** A single session's return in units of the instrument's own 20-day volatility. */
function moveInSigmas(bars: Bar[], idx: number): number {
  if (idx < 21) return 0
  const window = bars.slice(idx - 20, idx + 1)
  const rets: number[] = []
  for (let i = 1; i < window.length; i++) {
    rets.push(Math.log(window[i].closeAdj / window[i - 1].closeAdj))
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  const variance =
    rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1)
  const sigma = Math.sqrt(variance)
  return sigma > 0 ? rets[rets.length - 1] / sigma : 0
}

export { scoreSignals }
