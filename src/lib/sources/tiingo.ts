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
  splitFactor?: number
}

/**
 * Reconstruct a SPLIT-ADJUSTED (not dividend-adjusted) series from Tiingo's raw
 * prices, so it sits on the same basis as Twelve Data.
 *
 * This is the difference between reconciliation working and reconciliation
 * being noise. The three bases in play:
 *
 *   Twelve Data close   split-adjusted, NOT dividend-adjusted
 *   Tiingo close        raw, unadjusted
 *   Tiingo adjClose     split AND dividend adjusted
 *
 * Comparing Twelve Data's close against Tiingo's raw close reports a 90%
 * disagreement on every pre-split NVDA bar; comparing it against adjClose
 * reports a steadily growing one as dividends accumulate. Neither is a real
 * data problem — both are unit mismatches.
 *
 * Split-adjusted is chosen as the canonical basis because it is what the
 * primary source provides natively, and because the product detects the price
 * moves a person would actually see on a chart. Dividend adjustment would
 * smooth away real ex-dividend gaps.
 *
 * Tiingo's `splitFactor` on a row means the split took effect ON that date, so
 * the row itself is already post-split and only OLDER rows need dividing. Hence
 * the backwards walk that applies the running factor before accumulating it.
 */
export function toSplitAdjusted(rows: TiingoRow[]): RawBar[] {
  const ascending = [...rows].sort((a, b) =>
    String(a.date).localeCompare(String(b.date)),
  )

  const out: RawBar[] = new Array(ascending.length)
  let cumulative = 1

  for (let i = ascending.length - 1; i >= 0; i--) {
    const row = ascending[i]

    out[i] = {
      date: String(row.date).slice(0, 10),
      open: Number(row.open) / cumulative,
      high: Number(row.high) / cumulative,
      low: Number(row.low) / cumulative,
      close: Number(row.close) / cumulative,
      closeAdj: Number(row.close) / cumulative,
      // Share counts move inversely to price on a split.
      volume: Number(row.volume ?? 0) * cumulative,
    }

    const factor = Number(row.splitFactor)
    if (Number.isFinite(factor) && factor > 0 && factor !== 1) {
      cumulative *= factor
    }
  }

  return out
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

  const usable = (body as TiingoRow[]).filter(
    (row) =>
      Number.isFinite(Number(row.open)) &&
      Number.isFinite(Number(row.high)) &&
      Number.isFinite(Number(row.low)) &&
      Number.isFinite(Number(row.close)),
  )

  if (usable.length === 0) {
    throw new SourceDataError(sourceId, symbol, 'no usable rows in response')
  }

  const bars = toSplitAdjusted(usable).map((b) => ({
    ...b,
    // Round to a sane precision: reconstruction can otherwise leave long
    // floating tails that look like disagreement at the sixth decimal.
    open: round6(b.open),
    high: round6(b.high),
    low: round6(b.low),
    close: round6(b.close),
    closeAdj: round6(b.closeAdj),
    volume: Math.round(b.volume),
  }))

  return bars
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6
}
