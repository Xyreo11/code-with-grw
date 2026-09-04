import 'dotenv/config'

const token = process.env.FINNHUB_API_KEY!

async function probe(label: string, url: URL) {
  url.searchParams.set('token', token)
  try {
    const res = await fetch(url)
    const text = await res.text()
    let summary = text.slice(0, 200)
    try {
      const json = JSON.parse(text) as Record<string, unknown>
      const cal = json.earningsCalendar
      if (Array.isArray(cal)) {
        summary = `${cal.length} rows${cal[0] ? ` | first: ${JSON.stringify(cal[0])}` : ''}`
      }
    } catch {
      /* keep raw text */
    }
    console.log(`${label.padEnd(34)} [${res.status}] ${summary}`)
  } catch (e) {
    console.log(`${label.padEnd(34)} ERROR ${(e as Error).message}`)
  }
}

function iso(offsetDays: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}

async function main() {
  console.log('today is', iso(0), '\n')

  const base = 'https://finnhub.io/api/v1/calendar/earnings'

  await probe(
    'past window, symbol=AAPL',
    new URL(`${base}?from=2024-01-01&to=2024-03-31&symbol=AAPL`),
  )
  await probe(
    'past window, no symbol',
    new URL(`${base}?from=2024-01-29&to=2024-02-05`),
  )
  await probe(
    'forward 90d, no symbol',
    new URL(`${base}?from=${iso(0)}&to=${iso(90)}`),
  )
  await probe(
    'forward 90d, symbol=AAPL',
    new URL(`${base}?from=${iso(0)}&to=${iso(90)}&symbol=AAPL`),
  )
  await probe('quote AAPL (free tier check)', new URL('https://finnhub.io/api/v1/quote?symbol=AAPL'))
}

main()
