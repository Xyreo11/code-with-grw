import 'dotenv/config'
import { TwelveDataSource } from '../src/lib/sources/twelvedata'
import { TiingoSource } from '../src/lib/sources/tiingo'

/**
 * One-symbol probe against every live provider.
 *
 * Run before any bulk backfill. Discovering a payload shape or auth problem on
 * request 1 costs one request; discovering it on request 26 costs a day's quota
 * on the tightest free tier.
 */
async function main() {
  const from = '2024-01-02'
  const to = '2024-01-12'

  const td = new TwelveDataSource(process.env.TWELVE_DATA_API_KEY!)
  const tg = new TiingoSource(process.env.TIINGO_API_KEY!)

  for (const [name, run] of [
    ['twelvedata', () => td.fetchDailyBars('AAPL', { from, to })],
    ['tiingo', () => tg.fetchDailyBars('AAPL', { from, to })],
  ] as const) {
    try {
      const bars = await run()
      const first = bars[0]
      const last = bars[bars.length - 1]
      console.log(
        `${name.padEnd(12)} OK  ${bars.length} bars  ${first.date}..${last.date}  close ${first.close} -> ${last.close}`,
      )
    } catch (e) {
      console.log(`${name.padEnd(12)} FAIL ${(e as Error).message}`)
    }
  }

  // Finnhub earnings calendar — the only thing we use Finnhub for.
  try {
    const url = new URL('https://finnhub.io/api/v1/calendar/earnings')
    url.searchParams.set('from', '2024-01-01')
    url.searchParams.set('to', '2024-03-31')
    url.searchParams.set('symbol', 'AAPL')
    url.searchParams.set('token', process.env.FINNHUB_API_KEY!)

    const res = await fetch(url)
    const body = (await res.json()) as {
      earningsCalendar?: Array<Record<string, unknown>>
    }
    const rows = body.earningsCalendar ?? []
    console.log(
      `finnhub      ${res.ok ? 'OK ' : 'FAIL'} ${rows.length} earnings rows`,
    )
    if (rows[0]) console.log('             sample:', JSON.stringify(rows[0]))
  } catch (e) {
    console.log(`finnhub      FAIL ${(e as Error).message}`)
  }
}

main()
