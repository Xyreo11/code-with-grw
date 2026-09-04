import 'dotenv/config'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { TwelveDataSource } from '../src/lib/sources/twelvedata'
import { TiingoSource } from '../src/lib/sources/tiingo'
import type { RawBar } from '../src/lib/sources/types'
import { validateBars } from '../src/lib/ingest/validate'
import { reconcileSeries } from '../src/lib/ingest/reconcile'
import { ALL_SYMBOLS, EQUITIES } from '../src/lib/universe'

/**
 * One-time historical backfill.
 *
 * Pulls full daily history from both providers, validates, reconciles, writes
 * to Postgres, and commits compact fixtures so the whole app can be run later
 * with FIXTURE_MODE=1 and no keys at all.
 *
 * Committing fixtures is not just convenience. It makes the demo deterministic,
 * makes the repo runnable by a reviewer who has no accounts, and means a
 * provider outage or a quota exhaustion can never break a demo.
 */

const FROM = '2019-01-01'
const TO = new Date().toISOString().slice(0, 10)

// Twelve Data free tier allows 8 requests/minute. Leave headroom.
const TWELVE_DATA_DELAY_MS = 8_500
// Tiingo free tier is ~50 requests/hour; 26 symbols is comfortable.
const TIINGO_DELAY_MS = 1_500

const FIXTURE_DIR = path.join(process.cwd(), 'fixtures', 'bars')

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
const db = new PrismaClient({ adapter })

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Compact fixture rows: [date, open, high, low, close, closeAdj, volume]. */
type CompactBar = [string, number, number, number, number, number, number]

function toCompact(bars: RawBar[]): CompactBar[] {
  return bars.map((b) => [
    b.date,
    b.open,
    b.high,
    b.low,
    b.close,
    b.closeAdj,
    b.volume,
  ])
}

function fromCompact(rows: CompactBar[]): RawBar[] {
  return rows.map(([date, open, high, low, close, closeAdj, volume]) => ({
    date,
    open,
    high,
    low,
    close,
    closeAdj,
    volume,
  }))
}

/**
 * Load a previously committed fixture for one source.
 *
 * Re-running reconciliation should not cost API quota. On the free tiers in use
 * here (Twelve Data 800/day, Tiingo 50/hour) a couple of careless re-runs would
 * exhaust the budget, so anything already captured is replayed from disk.
 */
async function readFixtureSource(
  symbol: string,
  sourceId: 'twelvedata' | 'tiingo',
): Promise<RawBar[] | null> {
  try {
    const raw = await readFile(path.join(FIXTURE_DIR, `${symbol}.json`), 'utf8')
    const parsed = JSON.parse(raw) as {
      sources?: Record<string, CompactBar[]>
    }
    const rows = parsed.sources?.[sourceId]
    return rows && rows.length ? fromCompact(rows) : null
  } catch {
    return null
  }
}

async function fetchAll(
  label: string,
  symbols: string[],
  delayMs: number,
  fetchOne: (symbol: string) => Promise<RawBar[]>,
  reuse?: (symbol: string) => Promise<RawBar[] | null>,
): Promise<Map<string, RawBar[]>> {
  const out = new Map<string, RawBar[]>()
  let index = 0

  for (const symbol of symbols) {
    index++
    const prefix = `  [${label}] ${String(index).padStart(2)}/${symbols.length} ${symbol.padEnd(6)}`

    if (reuse) {
      const cached = await reuse(symbol)
      if (cached) {
        out.set(symbol, cached)
        console.log(`${prefix} ${cached.length} bars (fixture)`)
        continue
      }
    }

    // One retry with a long backoff: the free tiers rate-limit by the hour, and
    // losing a symbol to a transient 429 would silently degrade reconciliation
    // to single-source for that name.
    let attempt = 0
    while (attempt < 2) {
      attempt++
      try {
        const bars = await fetchOne(symbol)
        out.set(symbol, bars)
        console.log(
          `${prefix} ${bars.length} bars ${bars[0]?.date}..${bars[bars.length - 1]?.date}`,
        )
        break
      } catch (e) {
        const message = (e as Error).message
        if (attempt < 2) {
          console.log(`${prefix} retry after: ${message}`)
          await sleep(30_000)
        } else {
          console.log(`${prefix} FAILED: ${message}`)
        }
      }
    }

    if (index < symbols.length) await sleep(delayMs)
  }

  return out
}

async function main() {
  console.log(`Backfill ${FROM} .. ${TO} for ${ALL_SYMBOLS.length} symbols\n`)
  await mkdir(FIXTURE_DIR, { recursive: true })

  const td = new TwelveDataSource(process.env.TWELVE_DATA_API_KEY!)
  const tg = new TiingoSource(process.env.TIINGO_API_KEY!)

  const runTd = await db.ingestRun.create({
    data: { sourceId: 'twelvedata', status: 'running' },
  })

  const reusePrimary = process.argv.includes('--reuse-primary')
  const reuseSecondary = process.argv.includes('--reuse-secondary')

  console.log(
    `Fetching primary source (Twelve Data, 8 req/min)${reusePrimary ? ' — reusing fixtures where present' : ''}...`,
  )
  const primary = await fetchAll(
    'td',
    ALL_SYMBOLS,
    TWELVE_DATA_DELAY_MS,
    (s) => td.fetchDailyBars(s, { from: FROM, to: TO }),
    reusePrimary ? (s) => readFixtureSource(s, 'twelvedata') : undefined,
  )

  await db.ingestRun.update({
    where: { id: runTd.id },
    data: {
      finishedAt: new Date(),
      status: primary.size === ALL_SYMBOLS.length ? 'ok' : 'partial',
      rowsIn: [...primary.values()].reduce((a, b) => a + b.length, 0),
    },
  })

  const runTg = await db.ingestRun.create({
    data: { sourceId: 'tiingo', status: 'running' },
  })

  console.log('\nFetching secondary source (Tiingo) for reconciliation...')
  const secondary = await fetchAll(
    'tg',
    ALL_SYMBOLS,
    TIINGO_DELAY_MS,
    (s) => tg.fetchDailyBars(s, { from: FROM, to: TO }),
    reuseSecondary ? (s) => readFixtureSource(s, 'tiingo') : undefined,
  )

  await db.ingestRun.update({
    where: { id: runTg.id },
    data: {
      finishedAt: new Date(),
      status: secondary.size === ALL_SYMBOLS.length ? 'ok' : 'partial',
      rowsIn: [...secondary.values()].reduce((a, b) => a + b.length, 0),
    },
  })

  console.log('\nValidating, reconciling and persisting...')

  let totalBars = 0
  let totalConflicts = 0
  let totalRejected = 0
  let totalUnconfirmed = 0

  for (const symbol of ALL_SYMBOLS) {
    const instrument = await db.instrument.findUnique({
      where: { symbol },
      select: { id: true },
    })
    if (!instrument) {
      console.log(`  ${symbol.padEnd(6)} SKIPPED (not seeded)`)
      continue
    }

    const rawPrimary = primary.get(symbol) ?? []
    const rawSecondary = secondary.get(symbol) ?? []
    if (rawPrimary.length === 0 && rawSecondary.length === 0) {
      console.log(`  ${symbol.padEnd(6)} SKIPPED (no data from any source)`)
      continue
    }

    const vPrimary = validateBars(rawPrimary)
    const vSecondary = validateBars(rawSecondary)
    totalRejected += vPrimary.rejected.length + vSecondary.rejected.length

    for (const r of [...vPrimary.rejected, ...vSecondary.rejected]) {
      await db.deadLetter.create({
        data: {
          sourceId: 'backfill',
          symbol,
          payload: r.bar as unknown as object,
          reason: r.reason,
        },
      })
    }

    const series = []
    if (vPrimary.valid.length)
      series.push({ sourceId: 'twelvedata', trustRank: 1, bars: vPrimary.valid })
    if (vSecondary.valid.length)
      series.push({ sourceId: 'tiingo', trustRank: 2, bars: vSecondary.valid })

    const { bars, conflicts } = reconcileSeries(series)

    // Chunked createMany: a single 1900-row insert per symbol is fine, but
    // skipDuplicates keeps the whole script idempotent across re-runs.
    await db.dailyBar.createMany({
      data: bars.map((r) => ({
        instrumentId: instrument.id,
        barDate: new Date(`${r.bar.date}T00:00:00Z`),
        open: r.bar.open,
        high: r.bar.high,
        low: r.bar.low,
        close: r.bar.close,
        closeAdj: r.bar.closeAdj,
        volume: BigInt(Math.round(r.bar.volume)),
        source: r.source,
        asOf: new Date(`${r.bar.date}T21:00:00Z`),
        confidence: r.confidence,
        confirmed: r.confirmed,
      })),
      skipDuplicates: true,
    })

    if (conflicts.length) {
      await db.barConflict.createMany({
        data: conflicts.map((c) => ({
          instrumentId: instrument.id,
          barDate: new Date(`${c.date}T00:00:00Z`),
          field: c.field,
          sourceA: c.sourceA,
          valueA: c.valueA,
          sourceB: c.sourceB,
          valueB: c.valueB,
          deltaPct: c.deltaPct,
          resolvedTo: c.resolvedTo,
        })),
        skipDuplicates: true,
      })
    }

    const unconfirmed = bars.filter((b) => !b.confirmed).length
    totalBars += bars.length
    totalConflicts += conflicts.length
    totalUnconfirmed += unconfirmed

    await writeFile(
      path.join(FIXTURE_DIR, `${symbol}.json`),
      JSON.stringify({
        symbol,
        from: FROM,
        to: TO,
        fields: ['date', 'open', 'high', 'low', 'close', 'closeAdj', 'volume'],
        sources: {
          twelvedata: toCompact(vPrimary.valid),
          tiingo: toCompact(vSecondary.valid),
        },
      }),
    )

    console.log(
      `  ${symbol.padEnd(6)} ${String(bars.length).padStart(5)} bars  ${String(conflicts.length).padStart(4)} conflicts  ${String(unconfirmed).padStart(4)} unconfirmed`,
    )
  }

  // --- forward earnings (Finnhub free tier serves forward dates only) -------
  console.log('\nFetching forward earnings calendar (Finnhub)...')
  const runFh = await db.ingestRun.create({
    data: { sourceId: 'finnhub', status: 'running' },
  })

  let earningsRows = 0
  try {
    const to = new Date()
    to.setUTCDate(to.getUTCDate() + 120)
    const url = new URL('https://finnhub.io/api/v1/calendar/earnings')
    url.searchParams.set('from', TO)
    url.searchParams.set('to', to.toISOString().slice(0, 10))
    url.searchParams.set('token', process.env.FINNHUB_API_KEY!)

    const res = await fetch(url)
    const body = (await res.json()) as {
      earningsCalendar?: Array<{
        symbol: string
        date: string
        hour?: string
        epsEstimate?: number | null
        epsActual?: number | null
      }>
    }

    const wanted = new Set(EQUITIES.map((e) => e.symbol))
    const rows = (body.earningsCalendar ?? []).filter((r) => wanted.has(r.symbol))

    for (const r of rows) {
      const instrument = await db.instrument.findUnique({
        where: { symbol: r.symbol },
        select: { id: true },
      })
      if (!instrument) continue

      await db.earningsEvent.upsert({
        where: {
          instrumentId_reportDate: {
            instrumentId: instrument.id,
            reportDate: new Date(`${r.date}T00:00:00Z`),
          },
        },
        create: {
          instrumentId: instrument.id,
          reportDate: new Date(`${r.date}T00:00:00Z`),
          session: r.hour || null,
          epsEstimate: r.epsEstimate ?? null,
          epsActual: r.epsActual ?? null,
          source: 'finnhub',
        },
        update: {
          session: r.hour || null,
          epsEstimate: r.epsEstimate ?? null,
        },
      })
      earningsRows++
      console.log(`  ${r.symbol.padEnd(6)} reports ${r.date} ${r.hour || ''}`)
    }

    await db.ingestRun.update({
      where: { id: runFh.id },
      data: { finishedAt: new Date(), status: 'ok', rowsIn: earningsRows },
    })
  } catch (e) {
    console.log(`  earnings FAILED: ${(e as Error).message}`)
    await db.ingestRun.update({
      where: { id: runFh.id },
      data: { finishedAt: new Date(), status: 'failed', note: String(e) },
    })
  }

  for (const [sourceId, kind] of [
    ['twelvedata', 'bar'],
    ['tiingo', 'bar'],
    ['finnhub', 'earnings'],
  ] as const) {
    await db.dataFreshness.upsert({
      where: { sourceId_kind: { sourceId, kind } },
      create: { sourceId, kind, lastSuccess: new Date(), lastAttempt: new Date() },
      update: { lastSuccess: new Date(), lastAttempt: new Date(), consecutiveFailures: 0 },
    })
  }

  console.log('\n--- summary ---')
  console.log(`bars persisted     ${totalBars}`)
  console.log(`conflicts recorded ${totalConflicts}`)
  console.log(`unconfirmed bars   ${totalUnconfirmed}`)
  console.log(`rows rejected      ${totalRejected}`)
  console.log(`earnings rows      ${earningsRows}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
