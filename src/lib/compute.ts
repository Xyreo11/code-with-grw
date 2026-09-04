import { db } from './db'
import { runPipeline, toEngineBars, type InstrumentDay, type PipelineEvent } from './pipeline'
import { detectThemes, type ThemeMember } from '@/engine/theme'
import type { Bar, Severity } from '@/engine/types'
import { MARKET_BENCHMARK } from './universe'

/**
 * Compute and persist: bars -> events -> themes.
 *
 * Runs ONCE PER INSTRUMENT and stores the result for everybody. Nothing here is
 * user-specific: events are scored under a neutral context (normal priority, no
 * intent) and per-user weighting is applied at read time in sitrep.ts.
 *
 * That split is the load-bearing scalability decision. Adding a user adds a
 * filter over rows that already exist; it never adds analytical work.
 */

/**
 * Which DAYS are worth storing.
 *
 * Filtering by the individual event's severity would be wrong, and subtly so.
 * A single detector reports one signal family, so its coverage - and therefore
 * its standalone score - is always low; a volume spike that is NOISE by itself
 * can be the difference between WATCH and CRITICAL once combined with a price
 * move and a sector divergence. Dropping it here would destroy signal the
 * SITREP needs to recombine, and did: persisting by event severity stored zero
 * CRITICAL events on a window where calibration measured 21 critical
 * instrument-days.
 *
 * So the unit of the decision is the DAY. If a day matters, every signal from
 * that day is kept.
 */
const PERSISTED_DAYS: Severity[] = ['CRITICAL', 'IMPORTANT', 'WATCH', 'INFO']
const SURFACED: Severity[] = ['CRITICAL', 'IMPORTANT', 'WATCH']

export interface ComputeOptions {
  from?: string
  to?: string
  /** Wipe previously computed events in range before recomputing. */
  replace?: boolean
  onProgress?: (message: string) => void
}

interface LoadedInstrument {
  id: string
  symbol: string
  sector: string | null
  sectorEtfSymbol: string | null
  bars: Bar[]
}

async function loadAll(): Promise<Map<string, LoadedInstrument>> {
  const instruments = await db.instrument.findMany({
    include: { sectorEtf: { select: { symbol: true } } },
  })

  const out = new Map<string, LoadedInstrument>()
  for (const inst of instruments) {
    const rows = await db.dailyBar.findMany({
      where: { instrumentId: inst.id },
      orderBy: { barDate: 'asc' },
    })
    out.set(inst.symbol, {
      id: inst.id,
      symbol: inst.symbol,
      sector: inst.sector,
      sectorEtfSymbol: inst.sectorEtf?.symbol ?? null,
      bars: toEngineBars(rows),
    })
  }
  return out
}

export async function computeAndPersist(options: ComputeOptions = {}) {
  const { from, to, replace = false, onProgress = () => {} } = options

  const loaded = await loadAll()
  const benchmark = loaded.get(MARKET_BENCHMARK)?.bars ?? []
  if (benchmark.length === 0) {
    throw new Error(`benchmark ${MARKET_BENCHMARK} has no bars - run backfill first`)
  }

  if (replace) {
    await db.event.deleteMany({ where: { scenarioId: null } })
    await db.theme.deleteMany({ where: { scenarioId: null } })
  }

  const earningsRows = await db.earningsEvent.findMany({
    orderBy: { reportDate: 'asc' },
  })
  const earningsByInstrument = new Map<
    string,
    Array<{ date: string; session: string | null }>
  >()
  for (const e of earningsRows) {
    const list = earningsByInstrument.get(e.instrumentId) ?? []
    list.push({ date: e.reportDate.toISOString().slice(0, 10), session: e.session })
    earningsByInstrument.set(e.instrumentId, list)
  }

  const allDays: Array<{ instrument: LoadedInstrument; day: InstrumentDay }> = []
  let persisted = 0

  for (const inst of loaded.values()) {
    // Benchmarks and sector proxies are ingested so they can explain other
    // instruments; they are not themselves watchable, so they get no events.
    if (!inst.sector || inst.sectorEtfSymbol === null) continue

    const sectorBars = loaded.get(inst.sectorEtfSymbol)?.bars ?? []

    const { days } = runPipeline(
      {
        instrument: { symbol: inst.symbol, sector: inst.sector, bars: inst.bars },
        benchmark,
        sector: sectorBars,
        earnings: earningsByInstrument.get(inst.id) ?? [],
      },
      { from, to, sessionsSinceLastSeen: 1 },
    )

    for (const day of days) {
      allDays.push({ instrument: inst, day })
      if (!PERSISTED_DAYS.includes(day.severity)) continue
      const rows = day.events
      if (rows.length === 0) continue

      await db.event.createMany({
        data: rows.map((e) => eventRow(inst.id, e)),
        skipDuplicates: true,
      })
      persisted += rows.length
    }

    onProgress(`${inst.symbol.padEnd(6)} ${days.length} active days`)
  }

  const themeCount = await persistThemes(allDays, loaded, benchmark)

  return { events: persisted, themes: themeCount, activeDays: allDays.length }
}

function eventRow(instrumentId: string, e: PipelineEvent) {
  return {
    instrumentId,
    marketTime: new Date(`${e.marketTime}T21:00:00Z`),
    type: e.detector,
    direction: e.direction,
    magnitude: e.magnitude,
    // Raw signals are stored, not just rendered contributions, so an event can
    // be re-scored under a different user's priority and intent without
    // recomputing features from bars.
    features: { signals: e.signals } as object,
    contributions: e.contributions as unknown as object,
    score: e.score,
    severity: e.severity,
    scorerV: e.scorerV,
    sources: ['twelvedata'],
    confidence: e.confidence,
    confirmed: e.confirmed,
    headline: e.headline,
    fingerprint: e.fingerprint,
  }
}

/**
 * Group each session's events by sector and persist any that clear the theme
 * gates, linking member events back to the theme.
 */
async function persistThemes(
  allDays: Array<{ instrument: LoadedInstrument; day: InstrumentDay }>,
  loaded: Map<string, LoadedInstrument>,
  benchmark: Bar[],
): Promise<number> {
  const byDate = new Map<
    string,
    Array<{ instrument: LoadedInstrument; day: InstrumentDay }>
  >()
  for (const entry of allDays) {
    const list = byDate.get(entry.day.date) ?? []
    list.push(entry)
    byDate.set(entry.day.date, list)
  }

  const benchmarkByDate = new Map(benchmark.map((b) => [b.date, b]))
  let created = 0

  for (const [date, entries] of byDate) {
    const members: ThemeMember[] = []

    for (const { instrument, day } of entries) {
      // Only days that would reach the brief can anchor a theme; a theme built
      // out of noise is noise with a title.
      if (!SURFACED.includes(day.severity)) continue

      const barIndex = instrument.bars.findIndex((b) => b.date === date)
      if (barIndex < 91) continue

      const ret = instrument.bars[barIndex].closeAdj / instrument.bars[barIndex - 1].closeAdj - 1
      const reg = regressWindow(instrument.bars, benchmarkByDate, barIndex, 90)
      if (!reg) continue

      members.push({
        symbol: instrument.symbol,
        sector: instrument.sector ?? '',
        direction: ret < 0 ? -1 : 1,
        marketTime: date,
        score: day.score,
        residualSeries: reg.residuals,
        ret,
        moveSigmas: moveInSigmas(instrument.bars, barIndex),
        marketExplained: reg.marketExplained,
      })
    }

    if (members.length < 3) continue

    for (const t of detectThemes(members, date, date)) {
      const theme = await db.theme.create({
        data: {
          scope: t.scope,
          scopeKey: t.scopeKey,
          windowStart: new Date(`${t.windowStart}T00:00:00Z`),
          windowEnd: new Date(`${t.windowEnd}T23:59:59Z`),
          memberCount: t.memberCount,
          confidence: t.confidence,
          cohesion: t.cohesion,
          timing: t.timing,
          size: t.size,
          distinctness: t.distinctness,
          characteristics: t.characteristics,
          summary: t.summary,
        },
      })

      const memberIds = t.members
        .map((symbol) => loaded.get(symbol)?.id)
        .filter((id): id is string => Boolean(id))

      await db.event.updateMany({
        where: {
          instrumentId: { in: memberIds },
          marketTime: {
            gte: new Date(`${date}T00:00:00Z`),
            lte: new Date(`${date}T23:59:59Z`),
          },
        },
        data: { themeId: theme.id },
      })
      created++
    }
  }

  return created
}

/**
 * A single session's return in units of the instrument's own 20-day volatility.
 *
 * Used as the theme participation gate: direction alone is not participation.
 */
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

/**
 * Rolling regression of the instrument against the market benchmark.
 *
 * Returns both the residual series (theme cohesion) and the market-explained
 * component of the latest move (theme distinctness). Computed here the same way
 * the feature vector does it, rather than approximated, so the theme gate and
 * the event scores describe the same reality.
 */
function regressWindow(
  bars: Bar[],
  benchmarkByDate: Map<string, Bar>,
  i: number,
  window: number,
): { residuals: number[]; marketExplained: number } | null {
  const self: number[] = []
  const proxy: number[] = []

  for (let k = Math.max(1, i - window); k <= i; k++) {
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

  return {
    residuals: self.map((y, k) => y - (alpha + beta * proxy[k])),
    marketExplained: beta * proxy[proxy.length - 1],
  }
}
