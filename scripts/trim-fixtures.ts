import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * Produce the committed fixture set.
 *
 * The full backfill is ~5MB of JSON across 26 symbols and seven years, which is
 * more than belongs in a repository. This trims it to the windows that are
 * actually needed and commits THOSE, so a reviewer with no API keys can clone,
 * `docker compose up`, seed, and get a working app with real market data.
 *
 * Three windows are kept, and each earns its place:
 *   - recent history, for the live demo and calibration
 *   - the 2025 semiconductor selloff scenario
 *   - the 2020 COVID crash scenario
 *
 * Each window is padded backwards by 320 sessions so the engine has the
 * trailing history its feature vectors need. Without the pad, a scenario would
 * open with several weeks of "insufficient history" and demo nothing.
 */

type CompactBar = [string, number, number, number, number, number, number]

const SOURCE_DIR = path.join(process.cwd(), 'fixtures', 'bars')
const OUT_DIR = path.join(process.cwd(), 'fixtures', 'bars-trimmed')

/** Trading sessions of lead-in required before the first usable feature vector. */
const PAD_SESSIONS = 320

const WINDOWS: Array<{ name: string; from: string; to: string }> = [
  { name: 'covid-crash', from: '2020-02-24', to: '2020-03-31' },
  { name: 'semis-selloff', from: '2025-01-15', to: '2025-02-07' },
  { name: 'recent', from: '2024-01-01', to: '2100-01-01' },
]

function keepIndices(dates: string[]): Set<number> {
  const keep = new Set<number>()

  for (const w of WINDOWS) {
    const start = dates.findIndex((d) => d >= w.from)
    if (start === -1) continue
    const padded = Math.max(0, start - PAD_SESSIONS)
    for (let i = padded; i < dates.length; i++) {
      if (dates[i] > w.to) break
      keep.add(i)
    }
  }

  return keep
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const files = (await readdir(SOURCE_DIR)).filter((f) => f.endsWith('.json'))

  let totalIn = 0
  let totalOut = 0

  for (const file of files) {
    const raw = await readFile(path.join(SOURCE_DIR, file), 'utf8')
    const parsed = JSON.parse(raw) as {
      symbol: string
      fields: string[]
      sources: Record<string, CompactBar[]>
    }

    const trimmed: Record<string, CompactBar[]> = {}

    for (const [sourceId, rows] of Object.entries(parsed.sources)) {
      if (!rows?.length) {
        trimmed[sourceId] = []
        continue
      }
      totalIn += rows.length
      const dates = rows.map((r) => r[0])
      const keep = keepIndices(dates)
      const kept = rows.filter((_, i) => keep.has(i))
      trimmed[sourceId] = kept
      totalOut += kept.length
    }

    await writeFile(
      path.join(OUT_DIR, file),
      JSON.stringify({
        symbol: parsed.symbol,
        fields: parsed.fields,
        windows: WINDOWS,
        note: 'Trimmed from a full 2019-present backfill. Regenerate with scripts/backfill.ts.',
        sources: trimmed,
      }),
    )
  }

  console.log(`trimmed ${files.length} symbols`)
  console.log(`rows ${totalIn.toLocaleString()} -> ${totalOut.toLocaleString()}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
