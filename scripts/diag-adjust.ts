import 'dotenv/config'

/**
 * Diagnostic: are the two providers' daily series on the same adjustment basis?
 *
 * NVDA did a 10:1 split in June 2024 and XLE pays quarterly distributions, so a
 * pre-split / pre-distribution date exposes both split and dividend adjustment
 * differences immediately.
 */
async function twelveData(symbol: string, from: string, to: string) {
  const url = new URL('https://api.twelvedata.com/time_series')
  url.searchParams.set('symbol', symbol)
  url.searchParams.set('interval', '1day')
  url.searchParams.set('start_date', from)
  url.searchParams.set('end_date', to)
  url.searchParams.set('apikey', process.env.TWELVE_DATA_API_KEY!)
  const res = await fetch(url)
  return (await res.json()) as Record<string, unknown>
}

async function tiingo(symbol: string, from: string, to: string) {
  const url = new URL(
    `https://api.tiingo.com/tiingo/daily/${symbol.toLowerCase()}/prices`,
  )
  url.searchParams.set('startDate', from)
  url.searchParams.set('endDate', to)
  const res = await fetch(url, {
    headers: { Authorization: `Token ${process.env.TIINGO_API_KEY!}` },
  })
  return (await res.json()) as Array<Record<string, unknown>>
}

async function compare(symbol: string, from: string, to: string) {
  console.log(`\n=== ${symbol}  ${from}..${to} ===`)

  const td = await twelveData(symbol, from, to)
  const values = (td.values as Array<Record<string, string>>) ?? []
  const tdFirst = values[values.length - 1] // Twelve Data defaults to DESC
  console.log('twelvedata:', JSON.stringify(tdFirst))

  const tg = await tiingo(symbol, from, to)
  console.log('tiingo    :', JSON.stringify(tg[0]))

  if (tdFirst && tg[0]) {
    const tdClose = Number(tdFirst.close)
    const tgClose = Number(tg[0].close)
    const tgAdjClose = Number(tg[0].adjClose)
    console.log(
      `  td.close=${tdClose}  tg.close=${tgClose}  tg.adjClose=${tgAdjClose}`,
    )
    console.log(
      `  td.close vs tg.close    delta ${(Math.abs(tdClose / tgClose - 1) * 100).toFixed(2)}%`,
    )
    console.log(
      `  td.close vs tg.adjClose delta ${(Math.abs(tdClose / tgAdjClose - 1) * 100).toFixed(2)}%`,
    )
  }
}

async function main() {
  // Pre-split NVDA (10:1 on 2024-06-10).
  await compare('NVDA', '2024-01-02', '2024-01-04')
  // ETF with quarterly distributions, well in the past.
  await compare('XLE', '2019-02-01', '2019-02-05')
  // A name with no recent split, as a control.
  await compare('MSFT', '2019-02-01', '2019-02-05')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
