import 'dotenv/config'
import { db } from '../src/lib/db'
import { buildSitrep, markSeen } from '../src/lib/sitrep'

async function main() {
  const user = await db.user.findUniqueOrThrow({ where: { email: 'demo@sitrep.local' } })

  const before = await buildSitrep(user.id)
  console.log('before:', before.items.map((i) => `${i.symbol}(${i.attentionScore})`).join(' '))

  const top = before.items[0]
  const inst = await db.instrument.findUniqueOrThrow({ where: { symbol: top.symbol } })
  await markSeen(user.id, [inst.id], top.eventIds)
  console.log(`marked ${top.symbol} seen (${top.eventIds.length} events)`)

  const after = await buildSitrep(user.id)
  console.log('after :', after.items.map((i) => `${i.symbol}(${i.attentionScore})`).join(' '))
  console.log(`${top.symbol} still present: ${after.items.some((i) => i.symbol === top.symbol)}`)
  console.log(`withinNormalRange ${before.withinNormalRange} -> ${after.withinNormalRange}`)
  await db.$disconnect()
}
main()
