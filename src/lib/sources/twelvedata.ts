import type { BarSource, FetchBarsOptions, RawBar } from './types'
import { SourceDataError } from './types'

/**
 * Twelve Data — primary bar source.
 *
 * Free tier: 800 requests/day, 8/minute, 5000 data points per request, daily
 * history back to first trade. Twenty-six symbols is 26 requests, so a full
 * history backfill costs well under one day's budget.
 *
 * Chosen as primary after Stooq (keyless CSV) began serving a JavaScript
 * proof-of-work bot challenge, and after confirming Finnhub gates
 * `/stock/candle` behind a paid plan.
 */
export class TwelveDataSource implements BarSource {
  readonly id = 'twelvedata'
  readonly trustRank = 1

  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error('TWELVE_DATA_API_KEY is not set')
    }
  }

  async fetchDailyBars(
    symbol: string,
    opts: FetchBarsOptions = {},
  ): Promise<RawBar[]> {
    const url = new URL('https://api.twelvedata.com/time_series')
    url.searchParams.set('symbol', symbol)
    url.searchParams.set('interval', '1day')
    url.searchParams.set('outputsize', '5000')
    url.searchParams.set('order', 'ASC')
    url.searchParams.set('apikey', this.apiKey)
    if (opts.from) url.searchParams.set('start_date', opts.from)
    if (opts.to) url.searchParams.set('end_date', opts.to)

    const res = await fetch(url)
    if (!res.ok) {
      throw new SourceDataError(this.id, symbol, `HTTP ${res.status}`)
    }

    const body = (await res.json()) as TwelveDataResponse
    return parseTwelveData(body, symbol, this.id)
  }
}

interface TwelveDataValue {
  datetime: string
  open: string
  high: string
  low: string
  close: string
  volume: string
}

interface TwelveDataResponse {
  status?: string
  code?: number
  message?: string
  values?: TwelveDataValue[]
}

/**
 * Exported so fixtures replay through the same parser as live responses.
 *
 * Twelve Data signals errors in the JSON body with HTTP 200 (rate limits and
 * unknown symbols both arrive this way), so the status field has to be checked
 * explicitly rather than trusting the response code.
 */
export function parseTwelveData(
  body: TwelveDataResponse,
  symbol: string,
  sourceId = 'twelvedata',
): RawBar[] {
  if (body.status === 'error' || body.code) {
    throw new SourceDataError(
      sourceId,
      symbol,
      body.message ?? `error code ${body.code}`,
    )
  }

  if (!Array.isArray(body.values) || body.values.length === 0) {
    throw new SourceDataError(sourceId, symbol, 'no values in response')
  }

  const bars: RawBar[] = []
  for (const v of body.values) {
    const bar: RawBar = {
      date: v.datetime.slice(0, 10),
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
      // Twelve Data's daily series is split-adjusted; no separate adjusted close
      // is offered on this endpoint.
      closeAdj: Number(v.close),
      volume: Number(v.volume ?? 0),
    }

    if (
      !Number.isFinite(bar.open) ||
      !Number.isFinite(bar.high) ||
      !Number.isFinite(bar.low) ||
      !Number.isFinite(bar.close)
    ) {
      continue
    }
    if (!Number.isFinite(bar.volume)) bar.volume = 0

    bars.push(bar)
  }

  if (bars.length === 0) {
    throw new SourceDataError(sourceId, symbol, 'no usable rows in response')
  }

  bars.sort((a, b) => a.date.localeCompare(b.date))
  return bars
}
