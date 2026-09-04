import { destroySession } from '@/lib/auth'
import { handler, ok } from '@/lib/api'

export const POST = handler(async () => {
  await destroySession()
  return ok({ ok: true })
})
