import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { BarSource, FetchBarsOptions, RawBar } from './types'
import { SourceDataError } from './types'

/**
 * A provider backed by committed history instead of the network.
 *
 * This exists so `FIXTURE_MODE=1` is a real guarantee rather than a claim in a
 * comment. It implements `BarSource` like any other provider, so the queued
 * ingest path runs its own validation, reconciliation and persistence
 * unchanged — a fixture mode that bypassed those would prove nothing about the
 * live path and would let the two drift apart silently.
 *
 * Both providers are replayed from the same file, so cross-source
 * reconciliation (and the disagreements it finds) still exercises for real.
 */

type CompactBar = [string, number, number, number, number, number, number]

interface FixtureFile {
  symbol: string
  sources: Record<string, CompactBar[]>
}

const FIXTURE_DIR = path.join(process.cwd(), 'fixtures', 'bars-trimmed')

/** Parsed files are cached: a 26-symbol batch would otherwise re-read each one. */
const cache = new Map<string, FixtureFile>()

async function load(symbol: string): Promise<FixtureFile> {
  const hit = cache.get(symbol)
  if (hit) return hit

  let raw: string
  try {
    raw = await readFile(path.join(FIXTURE_DIR, `${symbol}.json`), 'utf8')
  } catch {
    throw new SourceDataError('fixture', symbol, 'no committed fixture')
  }

  const parsed = JSON.parse(raw) as FixtureFile
  cache.set(symbol, parsed)
  return parsed
}

export class FixtureSource implements BarSource {
  constructor(
    readonly id: string,
    readonly trustRank: number,
  ) {}

  async fetchDailyBars(
    symbol: string,
    opts: FetchBarsOptions = {},
  ): Promise<RawBar[]> {
    const file = await load(symbol)
    const rows = file.sources[this.id]
    if (!rows) {
      throw new SourceDataError('fixture', symbol, `no ${this.id} series`)
    }

    return rows
      .filter(([date]) => {
        if (opts.from && date < opts.from) return false
        if (opts.to && date > opts.to) return false
        return true
      })
      .map(([date, open, high, low, close, closeAdj, volume]) => ({
        date,
        open,
        high,
        low,
        close,
        closeAdj,
        volume,
      }))
  }
}

/** True when the app must not touch the network, whatever keys happen to be set. */
export function fixtureMode(): boolean {
  const v = process.env.FIXTURE_MODE
  return v === '1' || v === 'true'
}
