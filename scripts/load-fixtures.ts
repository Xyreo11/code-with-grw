import 'dotenv/config'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { db } from '../src/lib/db'
import type { RawBar } from '../src/lib/sources/types'
import { validateBars } from '../src/lib/ingest/validate'
import { reconcileSeries } from '../src/lib/ingest/reconcile'

/**
 * Load committed fixtures into the database. No network, no API keys.
 *
 * This is the path a reviewer takes: clone, `docker compose up`, seed, load,
 * compute, done. It deliberately runs the SAME validation and reconciliation
 * code as live ingestion rather than inserting rows directly — a fixture path
 * that skipped those would prove nothing about the real one, and would let the
 * two drift apart silently.
 */

type CompactBar = [string, number, number, number, number, number, number]

const FIXTURE_DIR = path.join(process.cwd(), 'fixtures', 'bars-trimmed')

const TRUST: Record<string, number> = { twelvedata: 1, tiingo: 2 }

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

async function main() {
  let files: string[]
  try {
    files = (await readdir(FIXTURE_DIR)).filter((f) => f.endsWith('.json'))
  } catch {
    console.error(
      `No fixtures at ${FIXTURE_DIR}. Run scripts/backfill.ts (needs API keys) then scripts/trim-fixtures.ts.`,
    )
    process.exit(1)
  }

  const run = await db.ingestRun.create({
    data: { sourceId: 'twelvedata', status: 'running', note: 'fixture load' },
  })

  let totalBars = 0
  let totalConflicts = 0
  let totalRejected = 0

  for (const file of files) {
    const parsed = JSON.parse(
      await readFile(path.join(FIXTURE_DIR, file), 'utf8'),
    ) as { symbol: string; sources: Record<string, CompactBar[]> }

    const instrument = await db.instrument.findUnique({
      where: { symbol: parsed.symbol },
      select: { id: true },
    })
    if (!instrument) {
      console.log(`  ${parsed.symbol.padEnd(6)} SKIPPED (not seeded)`)
      continue
    }

    const series: Array<{ sourceId: string; trustRank: number; bars: RawBar[] }> = []

    for (const [sourceId, rows] of Object.entries(parsed.sources)) {
      if (!rows?.length) continue
      const { valid, rejected } = validateBars(fromCompact(rows))
      totalRejected += rejected.length
      if (valid.length) {
        series.push({
          sourceId,
          trustRank: TRUST[sourceId] ?? 9,
          bars: valid,
        })
      }
    }

    if (series.length === 0) {
      console.log(`  ${parsed.symbol.padEnd(6)} SKIPPED (no usable rows)`)
      continue
    }

    const { bars, conflicts } = reconcileSeries(series)

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

    totalBars += bars.length
    totalConflicts += conflicts.length

    console.log(
      `  ${parsed.symbol.padEnd(6)} ${String(bars.length).padStart(5)} bars  ${String(conflicts.length).padStart(3)} conflicts  ${series.length} source${series.length === 1 ? '' : 's'}`,
    )
  }

  await db.ingestRun.update({
    where: { id: run.id },
    data: { finishedAt: new Date(), status: 'ok', rowsIn: totalBars, rowsRejected: totalRejected },
  })

  for (const [sourceId, kind] of [
    ['twelvedata', 'bar'],
    ['tiingo', 'bar'],
  ] as const) {
    await db.dataFreshness.upsert({
      where: { sourceId_kind: { sourceId, kind } },
      create: { sourceId, kind, lastSuccess: new Date(), lastAttempt: new Date() },
      update: { lastSuccess: new Date(), lastAttempt: new Date() },
    })
  }

  console.log('\n--- loaded from fixtures ---')
  console.log(`bars       ${totalBars.toLocaleString()}`)
  console.log(`conflicts  ${totalConflicts}`)
  console.log(`rejected   ${totalRejected}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
