import { requireUser } from '@/lib/auth'
import { buildSitrep } from '@/lib/sitrep'
import { handler, ok } from '@/lib/api'

export const dynamic = 'force-dynamic'

export const GET = handler(async () => {
  const user = await requireUser()
  const sitrep = await buildSitrep(user.id)
  return ok(sitrep, {
    headers: { 'cache-control': 'private, max-age=30' },
  })
})
