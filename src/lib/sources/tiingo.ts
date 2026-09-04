import type { BarSource, FetchBarsOptions, RawBar } from './types'
import { SourceDataError } from './types'

/**
 * Tiingo — second bar source, used only for cross-source reconciliation.
 *
 * Free tier: ~50 symbols/hour, 500/month, EOD history back decades. That is
 * plenty for a one-off backfill of 26 names plus periodic spot checks, but not
 * enough to be the primary feed — hence the split.
 *
 * Reconciliation needs two genuinely INDEPENDENT feeds. Comparing a provider
 * against itself, or against a fixture derived from it, proves nothing; the
 * whole point is that two organisations sourcing and adjusting prices
 * differently will sometimes disagree, and we want to catch that.
 *
 * Tiingo does publish an adjusted close, so unlike Twelve Data it can populate
 * `closeAdj` properly.
 */
export class TiingoSource implements BarSource {
  readonly id = 'tiingo'
  readonly trustRank = 2

  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error('TIINGO_API_KEY is not set')
    }
  }

  async fetchDailyBars(
    symbol: string,
    opts: FetchBarsOptions = {},
  ): Promise<RawBar[]> {
    const url = new URL(
      `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(symbol.toLowerCase())}/prices`,
    )
    if (opts.from) url.searchParams.set('startDate', opts.from)
    if (opts.to) url.searchParams.set('endDate', opts.to)

    const res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Token ${this.apiKey}`,
      },
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new SourceDataError(
        this.id,
        symbol,
        `HTTP ${res.status}${detail ? `: ${detail.slice(0, 120)}` : ''}`,
      )
    }

    const body = (await res.json()) as unknown
    return parseTiingo(body, symbol, this.id)
  }
}

interface TiingoRow {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  adjClose?: number
}

export function parseTiingo(
  body: unknown,
  symbol: string,
  sourceId = 'tiingo',
): RawBar[] {
  if (!Array.isArray(body)) {
    throw new SourceDataError(sourceId, symbol, 'expected an array of prices')
  }
  if (body.length === 0) {
    throw new SourceDataError(sourceId, symbol, 'no rows in response')
  }

  const bars: RawBar[] = []
  for (const row of body as TiingoRow[]) {
    const bar: RawBar = {
      date: String(row.date).slice(0, 10),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      closeAdj: Number(row.adjClose ?? row.close),
      volume: Number(row.volume ?? 0),
    }

    if (
      !Number.isFinite(bar.open) ||
      !Number.isFinite(bar.high) ||
      !Number.isFinite(bar.low) ||
      !Number.isFinite(bar.close)
    ) {
      continue
    }
    if (!Number.isFinite(bar.closeAdj)) bar.closeAdj = bar.close
    if (!Number.isFinite(bar.volume)) bar.volume = 0

    bars.push(bar)
  }

  if (bars.length === 0) {
    throw new SourceDataError(sourceId, symbol, 'no usable rows in response')
  }

  bars.sort((a, b) => a.date.localeCompare(b.date))
  return bars
}
