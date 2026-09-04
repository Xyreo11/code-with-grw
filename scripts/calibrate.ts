import 'dotenv/config'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { runPipeline, toEngineBars, type InstrumentSeries } from '../src/lib/pipeline'
import type { InstrumentDay, PipelineEvent } from '../src/lib/pipeline'
import { THRESHOLDS } from '../src/engine/detectors'
import { FAMILY_WEIGHTS } from '../src/engine/scorer'
import { ENGINE_VERSION, SCORER_VERSION, type Bar, type Severity } from '../src/engine/types'
import { EQUITIES, MARKET_BENCHMARK } from '../src/lib/universe'

/**
 * Calibration.
 *
 * Replays the entire detector-and-scorer chain over real history and measures
 * what it would actually have surfaced. Without this the weights and thresholds
 * in the engine are assertions; with it they are measurements.
 *
 * The target is an ATTENTION BUDGET, not an accuracy score. A watchlist product
 * lives or dies on how often it interrupts someone: roughly 2-4 surfaced events
 * per name per month is a brief worth opening, while 20 is a feed people learn
 * to ignore. Precision proxies are reported alongside, but the budget is the
 * thing being tuned.
 */

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
const db = new PrismaClient({ adapter })

/** Calibrate over a recent window; older regimes are less representative. */
const FROM = '2023-01-01'

/**
 * Target surfaced instrument-days per name per month.
 *
 * Derived from brief size rather than picked. For the reference user — 17 names,
 * checking about twice a week — a rate of R per name per month puts
 * `17 x R / 8.7 visits` items in a typical brief:
 *
 *     R = 0.7  ->  1.4 items   too sparse; the brief feels empty
 *     R = 1.5  ->  2.9 items   a brief worth opening
 *     R = 2.5  ->  4.9 items   at the attention budget every visit
 *     R = 4.0  ->  7.8 items   over budget; the ranking stops mattering
 *
 * An earlier target of 2-4 was wrong in a way worth recording: the detectors
 * only fire on ~2.35 days per name per month in total, so demanding 2-4
 * SURFACED would have meant showing essentially everything detected, leaving
 * severity with nothing to do.
 */
const TARGET_MIN_PER_NAME_PER_MONTH = 1.0
const TARGET_MAX_PER_NAME_PER_MONTH = 2.0

/** Reference user, used to translate the rate into an expected brief size. */
const REFERENCE_WATCHLIST_SIZE = 17
const REFERENCE_VISITS_PER_MONTH = 8.7

const SURFACED: Severity[] = ['CRITICAL', 'IMPORTANT', 'WATCH']

interface SymbolSeries {
  symbol: string
  sector: string | null
  sectorEtf: string | null
  bars: Bar[]
}

async function loadSeries(): Promise<Map<string, SymbolSeries>> {
  const instruments = await db.instrument.findMany({
    include: { sectorEtf: { select: { symbol: true } } },
  })

  const out = new Map<string, SymbolSeries>()

  for (const inst of instruments) {
    const rows = await db.dailyBar.findMany({
      where: { instrumentId: inst.id },
      orderBy: { barDate: 'asc' },
    })
    out.set(inst.symbol, {
      symbol: inst.symbol,
      sector: inst.sector,
      sectorEtf: inst.sectorEtf?.symbol ?? null,
      bars: toEngineBars(rows),
    })
  }

  return out
}

function monthsSpanned(bars: Bar[], from: string): number {
  const inWindow = bars.filter((b) => b.date >= from)
  if (inWindow.length < 2) return 0
  const start = new Date(`${inWindow[0].date}T00:00:00Z`).getTime()
  const end = new Date(`${inWindow[inWindow.length - 1].date}T00:00:00Z`).getTime()
  return (end - start) / (1000 * 60 * 60 * 24 * 30.44)
}

/**
 * Precision proxy: of the events we would have surfaced, how many were followed
 * by a move large enough to matter?
 *
 * This is a proxy, not ground truth. Nobody labelled these events, and "did the
 * user care?" is unmeasurable before the product has users. What it does test
 * is whether an alert carried information about the near future rather than
 * being a restatement of noise that had already passed.
 */
function followThroughRate(
  events: PipelineEvent[],
  bars: Bar[],
  horizon = 3,
  sigmaThreshold = 1.5,
): { checked: number; followed: number } {
  const byDate = new Map(bars.map((b, i) => [b.date, i]))
  let checked = 0
  let followed = 0

  for (const e of events) {
    const i = byDate.get(e.marketTime)
    if (i === undefined || i + horizon >= bars.length) continue

    const window = bars.slice(Math.max(0, i - 20), i + 1)
    const rets: number[] = []
    for (let k = 1; k < window.length; k++) {
      rets.push(Math.log(window[k].closeAdj / window[k - 1].closeAdj))
    }
    const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length)
    const variance =
      rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1)
    const sigma = Math.sqrt(variance)
    if (!(sigma > 0)) continue

    const forward = Math.log(
      bars[i + horizon].closeAdj / bars[i].closeAdj,
    )
    checked++
    if (Math.abs(forward) / (sigma * Math.sqrt(horizon)) >= sigmaThreshold) {
      followed++
    }
  }

  return { checked, followed }
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`
}

async function main() {
  console.log(`Calibrating from ${FROM} (engine ${ENGINE_VERSION}, scorer ${SCORER_VERSION})\n`)

  const series = await loadSeries()
  const benchmark = series.get(MARKET_BENCHMARK)?.bars ?? []
  if (benchmark.length === 0) {
    throw new Error(`benchmark ${MARKET_BENCHMARK} has no bars — run backfill first`)
  }

  const allEvents: PipelineEvent[] = []
  const allDays: InstrumentDay[] = []
  const perSymbol: Array<{
    symbol: string
    events: number
    days: number
    surfaced: number
    months: number
    perMonth: number
  }> = []

  for (const equity of EQUITIES) {
    const s = series.get(equity.symbol)
    if (!s || s.bars.length === 0) continue

    const sectorBars = equity.sectorEtf
      ? (series.get(equity.sectorEtf)?.bars ?? [])
      : []

    const instrument: InstrumentSeries = {
      symbol: s.symbol,
      sector: s.sector,
      bars: s.bars,
    }

    // Earnings deliberately omitted: the free Finnhub tier serves forward dates
    // only, so no historical earnings calendar exists to calibrate against. The
    // earnings detector is therefore live-only and excluded from these numbers.
    const { events, days } = runPipeline(
      { instrument, benchmark, sector: sectorBars },
      { from: FROM, sessionsSinceLastSeen: 1 },
    )

    // The budget is spent on NAMES appearing in the brief, not on raw events.
    // A day where three detectors fire on one name is one interruption, not
    // three, so instrument-days are the unit being tuned.
    const surfacedDays = days.filter((d) => SURFACED.includes(d.severity))
    const months = monthsSpanned(s.bars, FROM)

    allEvents.push(...events)
    allDays.push(...days)
    perSymbol.push({
      symbol: s.symbol,
      events: events.length,
      days: days.length,
      surfaced: surfacedDays.length,
      months,
      perMonth: months > 0 ? surfacedDays.length / months : 0,
    })

    console.log(
      `  ${s.symbol.padEnd(6)} ${String(events.length).padStart(5)} events  ${String(days.length).padStart(4)} active days  ${String(surfacedDays.length).padStart(4)} surfaced  ${(months > 0 ? surfacedDays.length / months : 0).toFixed(2)}/month`,
    )
  }

  const bySeverity = new Map<Severity, number>()
  const byDetector = new Map<string, { total: number; surfaced: number }>()

  for (const d of allDays) {
    bySeverity.set(d.severity, (bySeverity.get(d.severity) ?? 0) + 1)
  }

  // Detector attribution is measured against the instrument-day that contained
  // it: "when this detector fired, how often did the name reach the brief?"
  for (const day of allDays) {
    const reached = SURFACED.includes(day.severity)
    for (const e of day.events) {
      const d = byDetector.get(e.detector) ?? { total: 0, surfaced: 0 }
      d.total++
      if (reached) d.surfaced++
      byDetector.set(e.detector, d)
    }
  }

  const avgPerMonth =
    perSymbol.reduce((a, b) => a + b.perMonth, 0) / Math.max(1, perSymbol.length)

  // Follow-through, measured only on what we would actually have shown.
  let checked = 0
  let followed = 0
  let baseChecked = 0
  let baseFollowed = 0

  for (const equity of EQUITIES) {
    const s = series.get(equity.symbol)
    if (!s) continue
    const symbolDays = allDays
      .filter((d) => d.symbol === equity.symbol && SURFACED.includes(d.severity))
      .map((d) => ({ marketTime: d.date }) as PipelineEvent)
    const r = followThroughRate(symbolDays, s.bars)
    checked += r.checked
    followed += r.followed

    // Baseline: the same measurement on every session, so the alert rate can be
    // compared against simply looking every day.
    const everyDay = s.bars
      .filter((b) => b.date >= FROM)
      .map((b) => ({ marketTime: b.date }) as PipelineEvent)
    const b = followThroughRate(everyDay, s.bars)
    baseChecked += b.checked
    baseFollowed += b.followed
  }

  const inBudget =
    avgPerMonth >= TARGET_MIN_PER_NAME_PER_MONTH &&
    avgPerMonth <= TARGET_MAX_PER_NAME_PER_MONTH

  const lines: string[] = []
  lines.push('# Calibration report')
  lines.push('')
  lines.push(`Generated ${new Date().toISOString().slice(0, 10)} · engine \`${ENGINE_VERSION}\` · scorer \`${SCORER_VERSION}\``)
  lines.push('')
  lines.push(`Window: **${FROM} → present** · ${EQUITIES.length} equities · ${allEvents.length} events across ${allDays.length} active instrument-days`)
  lines.push('')
  lines.push('## The number being tuned')
  lines.push('')
  const itemsPerBrief =
    (avgPerMonth * REFERENCE_WATCHLIST_SIZE) / REFERENCE_VISITS_PER_MONTH
  lines.push(`**${avgPerMonth.toFixed(2)} surfaced instrument-days per name per month** (target ${TARGET_MIN_PER_NAME_PER_MONTH}–${TARGET_MAX_PER_NAME_PER_MONTH}) — ${inBudget ? 'within budget' : 'OUTSIDE BUDGET'}`)
  lines.push('')
  lines.push(`For the reference user (${REFERENCE_WATCHLIST_SIZE} names, ~${REFERENCE_VISITS_PER_MONTH} visits/month) that is **${itemsPerBrief.toFixed(1)} items in a typical brief**, against an attention budget of 5.`)
  lines.push('')
  lines.push('The unit is an instrument-DAY, not an event: a day on which three')
  lines.push('detectors fire on one name is a single interruption, not three.')
  lines.push('"Surfaced" means the day reached CRITICAL, IMPORTANT or WATCH. INFO and')
  lines.push('NOISE days are stored but never shown, so they spend no attention.')
  lines.push('')
  lines.push('The target is an attention budget rather than an accuracy figure. A')
  lines.push('watchlist that interrupts someone twenty times a month is one they stop')
  lines.push('opening, regardless of how correct each alert was.')
  lines.push('')
  lines.push('## Severity distribution')
  lines.push('')
  lines.push('| Severity | Instrument-days | Share |')
  lines.push('|---|---:|---:|')
  for (const sev of ['CRITICAL', 'IMPORTANT', 'WATCH', 'INFO', 'NOISE'] as Severity[]) {
    const n = bySeverity.get(sev) ?? 0
    lines.push(`| ${sev} | ${n} | ${pct(n, allDays.length)} |`)
  }
  lines.push('')
  lines.push('## By detector')
  lines.push('')
  lines.push('| Detector | Fired | On a surfaced day | Share |')
  lines.push('|---|---:|---:|---:|')
  for (const [name, d] of [...byDetector.entries()].sort((a, b) => b[1].total - a[1].total)) {
    lines.push(`| \`${name}\` | ${d.total} | ${d.surfaced} | ${pct(d.surfaced, d.total)} |`)
  }
  lines.push('')
  lines.push('## Follow-through (precision proxy)')
  lines.push('')
  lines.push(`Share of surfaced events followed by a ≥1.5σ move within 3 sessions:`)
  lines.push('')
  lines.push(`- **surfaced events: ${pct(followed, checked)}** (${followed}/${checked})`)
  lines.push(`- every session, as a baseline: ${pct(baseFollowed, baseChecked)} (${baseFollowed}/${baseChecked})`)
  lines.push('')
  const lift =
    baseChecked > 0 && checked > 0
      ? (followed / checked) / (baseFollowed / baseChecked)
      : 0
  lines.push(`Lift over "look every day": **${lift.toFixed(2)}×**`)
  lines.push('')
  lines.push('This is a proxy, not ground truth — nobody labelled these events, and')
  lines.push('"did the user care?" cannot be measured before the product has users.')
  lines.push('What it does test is whether an alert carried information about the')
  lines.push('near future rather than restating noise that had already passed. A lift')
  lines.push('at or below 1.0 would mean the engine is no better than looking daily.')
  lines.push('')
  lines.push('## Per symbol')
  lines.push('')
  lines.push('| Symbol | Events | Active days | Surfaced days | Per month |')
  lines.push('|---|---:|---:|---:|---:|')
  for (const p of [...perSymbol].sort((a, b) => b.perMonth - a.perMonth)) {
    lines.push(`| ${p.symbol} | ${p.events} | ${p.days} | ${p.surfaced} | ${p.perMonth.toFixed(2)} |`)
  }
  lines.push('')
  lines.push('## Parameters in force')
  lines.push('')
  lines.push('```')
  lines.push('detector thresholds')
  for (const [k, v] of Object.entries(THRESHOLDS)) {
    lines.push(`  ${k.padEnd(32)} ${v}`)
  }
  lines.push('')
  lines.push('scorer family weights')
  for (const [k, v] of Object.entries(FAMILY_WEIGHTS)) {
    lines.push(`  ${k.padEnd(32)} ${v}`)
  }
  lines.push('```')
  lines.push('')
  lines.push('## Known limitation')
  lines.push('')
  lines.push('The `earnings_upcoming` detector is absent from these numbers. The free')
  lines.push('Finnhub tier serves forward-looking earnings dates only — historical')
  lines.push('windows return zero rows — so there is no historical calendar to')
  lines.push('calibrate against. That detector is live-only, and its contribution to')
  lines.push('the attention budget is therefore not measured here.')
  lines.push('')

  await mkdir(path.join(process.cwd(), 'docs'), { recursive: true })
  await writeFile(path.join(process.cwd(), 'docs', 'calibration.md'), lines.join('\n'))

  console.log('\n--- summary ---')
  console.log(`events detected        ${allEvents.length}`)
  console.log(`active instrument-days ${allDays.length}`)
  console.log(`surfaced per name/mo   ${avgPerMonth.toFixed(2)}  (target ${TARGET_MIN_PER_NAME_PER_MONTH}-${TARGET_MAX_PER_NAME_PER_MONTH})  ${inBudget ? 'IN BUDGET' : 'OUT OF BUDGET'}`)
  console.log(`items per typical brief ${((avgPerMonth * REFERENCE_WATCHLIST_SIZE) / REFERENCE_VISITS_PER_MONTH).toFixed(1)}  (attention budget 5)`)
  console.log(`follow-through         ${pct(followed, checked)} vs ${pct(baseFollowed, baseChecked)} baseline  (lift ${lift.toFixed(2)}x)`)
  for (const sev of ['CRITICAL', 'IMPORTANT', 'WATCH', 'INFO', 'NOISE'] as Severity[]) {
    console.log(`  ${sev.padEnd(10)} ${String(bySeverity.get(sev) ?? 0).padStart(6)}`)
  }
  console.log('\nwrote docs/calibration.md')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
