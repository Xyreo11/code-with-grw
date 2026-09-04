import 'dotenv/config'
import { db } from '../src/lib/db'
import { buildSitrep, ensureCursors } from '../src/lib/sitrep'

/**
 * Put the demo account into a realistic returning-user state.
 *
 * An empty app demos nothing. The point of SITREP is what it shows you when you
 * come back, so the demo user needs a cursor planted in the past and a few
 * names marked High/Low priority — otherwise the first screen is a truthful but
 * useless "nothing has changed since you signed up ten seconds ago".
 */

const DAYS_AWAY = Number(
  process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 14,
)

async function main() {
  const user = await db.user.findUniqueOrThrow({
    where: { email: 'demo@sitrep.local' },
  })

  const since = new Date()
  since.setUTCDate(since.getUTCDate() - DAYS_AWAY)

  // Reset any prior demo state so the script is idempotent.
  await db.userWatchState.deleteMany({ where: { userId: user.id } })
  await db.userEventState.deleteMany({ where: { userId: user.id } })

  const planted = await ensureCursors(user.id, since)

  // A little variety in priority, so the Why panel has something to explain
  // beyond the market itself.
  const watchlist = await db.watchlist.findFirstOrThrow({
    where: { userId: user.id },
    include: { items: { include: { instrument: true } } },
  })

  const priorities: Record<string, 'HIGH' | 'LOW'> = {
    NVDA: 'HIGH',
    AMD: 'HIGH',
    INTC: 'LOW',
    ADBE: 'LOW',
  }
  const intents: Record<string, 'CONSIDERING_BUY' | 'HOLDING'> = {
    NVDA: 'HOLDING',
    AMD: 'CONSIDERING_BUY',
    AAPL: 'HOLDING',
    TSLA: 'CONSIDERING_BUY',
  }

  for (const item of watchlist.items) {
    const symbol = item.instrument.symbol
    await db.watchlistItem.update({
      where: { id: item.id },
      data: {
        priority: priorities[symbol] ?? 'NORMAL',
        intent: intents[symbol] ?? 'NONE',
      },
    })
  }

  console.log(`cursor planted ${DAYS_AWAY} days back for ${planted} names`)
  console.log(`  since: ${since.toISOString()}`)

  const sitrep = await buildSitrep(user.id)

  console.log('\n--- SITREP preview ---')
  console.log(`Good morning, ${sitrep.displayName}.`)
  console.log(
    `Since your last visit ${sitrep.absenceHours ? Math.round(sitrep.absenceHours) : '?'}h ago — ${sitrep.items.length} need attention.\n`,
  )

  for (const item of sitrep.items) {
    console.log(
      `${item.symbol.padEnd(6)} ${String(item.attentionScore).padStart(3)}  ${item.severity.padEnd(9)} ${item.headline}`,
    )
    const move =
      item.windowReturnPct !== null
        ? `${(item.windowReturnPct * 100).toFixed(1)}% since you last looked`
        : 'no window move'
    console.log(`       ${move}${item.priority !== 'NORMAL' ? ` · ${item.priority} priority` : ''}`)
    if (item.suppressors.length) {
      console.log(`       why not higher: ${item.suppressors.map((s) => s.label).join(' | ')}`)
    }
  }

  console.log('')
  if (sitrep.belowBudget > 0) {
    console.log(
      `${sitrep.belowBudget} more were flagged but fell below the attention budget.`,
    )
  }
  console.log(`${sitrep.withinNormalRange} others within normal range.`)
  console.log('\nTHE STORY')
  console.log(sitrep.narrative.text)
  console.log(`  (rule: ${sitrep.narrative.ruleId})`)

  if (sitrep.themes.length) {
    console.log('\nTHEMES')
    for (const t of sitrep.themes) {
      console.log(
        `  ${t.scopeKey} — ${t.confidence.toFixed(0)}% confidence, ${t.memberCount} names`,
      )
    }
  }

  console.log('\nATTENTION BUDGET')
  for (const [severity, count] of Object.entries(sitrep.budget)) {
    if (count > 0) console.log(`  ${severity.padEnd(10)} ${'#'.repeat(count)} ${count}`)
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
