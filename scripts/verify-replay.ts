import 'dotenv/config'
import { db } from '../src/lib/db'
import { replayScenario, SCENARIOS } from '../src/lib/scenarios'

async function main() {
  for (const def of SCENARIOS) {
    const { scenario, steps } = await replayScenario(def.slug)
    console.log(`\n=== ${scenario.name} (${scenario.startDate}..${scenario.endDate}) ===`)
    console.log(`   teaches: ${scenario.teaches}`)
    console.log(`   ${steps.length} trading days`)

    let themeDays = 0
    for (const step of steps) {
      if (step.themes.length) themeDays++
    }

    const busiest = [...steps].sort((a, b) => b.items.length - a.items.length)[0]
    console.log(`   days with a theme: ${themeDays}`)
    console.log(`   busiest day: ${busiest?.date} with ${busiest?.items.length} names`)

    for (const step of steps) {
      if (step.items.length === 0 && step.themes.length === 0) continue
      const themeStr = step.themes.length
        ? `  THEME ${step.themes[0].scopeKey} ${step.themes[0].confidence.toFixed(0)}% (dist ${step.themes[0].distinctness.toFixed(2)})`
        : ''
      console.log(
        `   ${step.date}  mkt ${(step.marketReturnPct * 100).toFixed(1).padStart(5)}%  ${String(step.items.length).padStart(2)} names  ${step.narrative.ruleId.padEnd(16)}${themeStr}`,
      )
    }
  }
  await db.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
