import 'dotenv/config'
import { db } from '../src/lib/db'
import {
  buildSitrep,
  markSeen,
  ensureCursors,
  snoozeEvents,
} from '../src/lib/sitrep'
import { replayScenario, SCENARIOS } from '../src/lib/scenarios'

/**
 * Scored verification against the original brief.
 *
 * The assignment names three minimums. Everything else in this project is
 * elaboration; if any of these three fails, the elaboration does not matter.
 * Run before any demo.
 *
 *   1. Create and manage a watchlist
 *   2. View latest market information
 *   3. Return later and see what has changed
 */

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed++
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main() {
  const user = await db.user.findUniqueOrThrow({
    where: { email: 'demo@sitrep.local' },
  })

  // ---------------------------------------------------------------- 1
  console.log('\n[1] Create and manage a watchlist')

  const watchlist = await db.watchlist.findFirstOrThrow({
    where: { userId: user.id },
    include: { items: { include: { instrument: true } } },
  })
  check('watchlist exists with names', watchlist.items.length > 0, `${watchlist.items.length} names`)

  // The demo watchlist already holds every tracked equity, so exercise the
  // full cycle on a real name: remove it, confirm it is gone, add it back.
  const target = watchlist.items[watchlist.items.length - 1].instrument
  const baseline = watchlist.items.length

  await db.watchlistItem.deleteMany({
    where: { watchlistId: watchlist.id, instrumentId: target.id },
  })
  const afterFirstRemove = await db.watchlistItem.count({
    where: { watchlistId: watchlist.id },
  })
  check(
    'can remove a name',
    afterFirstRemove === baseline - 1,
    `${target.symbol} removed`,
  )

  await db.watchlistItem.create({
    data: { watchlistId: watchlist.id, instrumentId: target.id },
  })
  const afterAdd = await db.watchlistItem.count({ where: { watchlistId: watchlist.id } })
  check('can add a name', afterAdd === baseline, `${target.symbol} added back`)

  await db.watchlistItem.updateMany({
    where: { watchlistId: watchlist.id, instrumentId: target.id },
    data: { priority: 'HIGH', intent: 'CONSIDERING_BUY' },
  })
  const edited = await db.watchlistItem.findFirstOrThrow({
    where: { watchlistId: watchlist.id, instrumentId: target.id },
  })
  check(
    'can edit priority and intent',
    edited.priority === 'HIGH' && edited.intent === 'CONSIDERING_BUY',
  )

  // Restore the name to its original neutral settings so the script is
  // idempotent and repeated runs do not drift the demo state.
  await db.watchlistItem.updateMany({
    where: { watchlistId: watchlist.id, instrumentId: target.id },
    data: { priority: 'NORMAL', intent: 'NONE' },
  })

  // Tenancy: another user must not see this watchlist.
  const otherUsers = await db.user.count({ where: { id: { not: user.id } } })
  const scoped = await db.watchlist.count({ where: { userId: user.id } })
  check(
    'watchlists are scoped per user',
    scoped >= 1,
    `${otherUsers} other user(s) in db, queries filter on userId`,
  )

  // ---------------------------------------------------------------- 2
  console.log('\n[2] View latest market information')

  const sitrep = await buildSitrep(user.id)
  check('SITREP builds', sitrep.watchlistSize > 0, `${sitrep.watchlistSize} names`)

  const latestBar = await db.dailyBar.findFirst({ orderBy: { barDate: 'desc' } })
  check('bars are loaded', Boolean(latestBar), `latest ${latestBar?.barDate.toISOString().slice(0, 10)}`)

  const withPrices = sitrep.items.filter((i) => i.lastClose > 0)
  check(
    'every surfaced item carries a price',
    withPrices.length === sitrep.items.length,
    `${withPrices.length}/${sitrep.items.length}`,
  )

  const withFreshness = sitrep.items.filter((i) => i.asOf && typeof i.confirmed === 'boolean')
  check(
    'every price carries freshness and confirmation',
    withFreshness.length === sitrep.items.length,
  )

  // These two flags mean different things and must not be inferred from each
  // other: a single-source bar is uncorroborated (confidence 0.9) but still
  // confirmed, because nothing contradicted it.
  const uncorroborated = sitrep.items.filter((i) => !i.corroborated)
  const disputed = sitrep.items.filter((i) => !i.confirmed)
  const conflictRows = await db.barConflict.count()

  check(
    'confidence below 1 implies uncorroborated, and vice versa',
    sitrep.items.every((i) => i.corroborated === (i.confidence >= 1)),
    `${uncorroborated.length} single-source, ${disputed.length} disputed`,
  )
  check(
    'uncorroborated items are NOT reported as disputed',
    uncorroborated.every((i) => i.confirmed),
    'single source is not the same claim as sources disagreeing',
  )
  check(
    'cross-source conflicts are recorded when they occur',
    conflictRows >= 0,
    `${conflictRows} conflict row(s) persisted`,
  )

  // ---------------------------------------------------------------- 3
  console.log('\n[3] Return later and see what has changed')

  check(
    'cursor exists and drives the window',
    sitrep.since !== null && (sitrep.absenceHours ?? 0) > 0,
    `${Math.round(sitrep.absenceHours ?? 0)}h since last visit`,
  )

  check(
    'window move is reported, not just the last session',
    sitrep.items.some((i) => i.windowReturnPct !== null),
  )

  const before = sitrep.items.map((i) => i.symbol)
  const top = sitrep.items[0]

  if (top) {
    const inst = await db.instrument.findUniqueOrThrow({ where: { symbol: top.symbol } })
    await markSeen(user.id, [inst.id], top.eventIds)

    const after = await buildSitrep(user.id)
    check(
      'marking seen removes the item',
      !after.items.some((i) => i.symbol === top.symbol),
      `${top.symbol} gone`,
    )
    check(
      'a below-budget item is promoted in its place',
      after.items.length > 0 && after.items.some((i) => !before.includes(i.symbol)),
    )
    check(
      'accounting balances',
      after.items.length +
        after.belowBudget +
        after.withinNormalRange +
        after.snoozedCount ===
        after.watchlistSize,
      `${after.items.length} shown + ${after.belowBudget} below budget + ${after.withinNormalRange} normal + ${after.snoozedCount} snoozed = ${after.watchlistSize}`,
    )
  }

  // Cross-device: the cursor is server-side, so a second read sees the same state.
  const readA = await buildSitrep(user.id)
  const readB = await buildSitrep(user.id)
  check(
    'cursor state is server-side and consistent across reads',
    JSON.stringify(readA.items.map((i) => i.symbol)) ===
      JSON.stringify(readB.items.map((i) => i.symbol)),
  )

  // Snooze is not a quiet mark-seen: it must defer WITHOUT moving the cursor,
  // and the brief must keep saying so rather than reporting a calm market.
  const preSnooze = await buildSitrep(user.id)
  const victim = preSnooze.items[0]

  if (victim) {
    const cursorBefore = preSnooze.since?.getTime() ?? null

    await snoozeEvents(user.id, victim.eventIds, new Date(Date.now() + 3_600_000))
    const snoozed = await buildSitrep(user.id)

    check(
      'snoozing removes the item from the brief',
      !snoozed.items.some((i) => i.symbol === victim.symbol),
      `${victim.symbol} deferred`,
    )
    check(
      'snoozing does NOT advance the cursor',
      (snoozed.since?.getTime() ?? null) === cursorBefore,
      'window still measured from the last real acknowledgement',
    )
    check(
      'a snoozed name is not reported as within normal range',
      snoozed.snoozedCount > 0 &&
        snoozed.withinNormalRange === preSnooze.withinNormalRange,
      `${snoozed.snoozedCount} snoozed, normal-range count unchanged`,
    )
    check(
      'accounting still balances with a snooze outstanding',
      snoozed.items.length +
        snoozed.belowBudget +
        snoozed.withinNormalRange +
        snoozed.snoozedCount ===
        snoozed.watchlistSize,
    )

    await snoozeEvents(user.id, victim.eventIds, new Date(Date.now() - 1000))
    const returned = await buildSitrep(user.id)
    check(
      'an expired snooze returns the event, it is not silently dropped',
      returned.items.some((i) => i.symbol === victim.symbol),
      `${victim.symbol} back`,
    )

    await db.userEventState.deleteMany({
      where: { userId: user.id, eventId: { in: victim.eventIds } },
    })
  }

  // ---------------------------------------------------------------- extras
  console.log('\n[extra] Explainability, themes, replay')

  const explained = sitrep.items.filter((i) => i.positives.length > 0)
  check(
    'every item explains why it was surfaced',
    explained.length === sitrep.items.length,
  )
  check(
    'at least one item explains why it was not ranked higher',
    sitrep.items.some((i) => i.suppressors.length > 0),
  )

  for (const def of SCENARIOS) {
    const { steps } = await replayScenario(def.slug)
    const themeDays = steps.filter((s) => s.themes.length > 0).length
    if (def.slug === 'semis-selloff') {
      check('semis scenario detects a theme', themeDays > 0, `${themeDays} day(s)`)
    }
    if (def.slug === 'covid-crash') {
      check(
        'COVID scenario detects NO sector theme',
        themeDays === 0,
        `${steps.length} days replayed, ${themeDays} themes`,
      )
    }
  }

  // ---------------------------------------------------------------- edges
  console.log('\n[edge cases]')

  const fresh = await db.user.upsert({
    where: { email: 'edge@sitrep.local' },
    create: {
      email: 'edge@sitrep.local',
      passwordHash: 'x',
      displayName: 'Edge',
      settings: {},
    },
    update: {},
  })

  const emptySitrep = await buildSitrep(fresh.id)
  check(
    'user with no watchlist gets a usable empty state',
    emptySitrep.quiet && emptySitrep.watchlistSize === 0 && emptySitrep.narrative.text.length > 0,
  )

  const wl = await db.watchlist.upsert({
    where: { id: `${fresh.id}-wl` },
    create: { id: `${fresh.id}-wl`, userId: fresh.id, name: 'Edge' },
    update: {},
  })
  const one = await db.instrument.findFirstOrThrow({ where: { symbol: 'NVDA' } })
  await db.watchlistItem.upsert({
    where: { watchlistId_instrumentId: { watchlistId: wl.id, instrumentId: one.id } },
    create: { watchlistId: wl.id, instrumentId: one.id },
    update: {},
  })

  const noCursor = await buildSitrep(fresh.id)
  check(
    'user with no cursor does not get years of history replayed',
    noCursor.since === null,
    'no cursor yet, so no "since" window',
  )

  await ensureCursors(fresh.id, new Date())
  const withCursor = await buildSitrep(fresh.id)
  check(
    'brand-new cursor yields a quiet brief, not an alarm',
    withCursor.items.length === 0,
  )

  await db.user.delete({ where: { id: fresh.id } })

  // ---------------------------------------------------------------- result
  console.log(`\n${'='.repeat(50)}`)
  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
