import { z } from 'zod'
import { login } from '@/lib/auth'
import { handler, ok, parseBody } from '@/lib/api'

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export const POST = handler(async (req) => {
  const { email, password } = await parseBody(req, schema)
  const user = await login(email, password)
  return ok({ user })
})
