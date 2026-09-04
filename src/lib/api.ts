import { NextResponse } from 'next/server'
import { z } from 'zod'
import { UnauthorizedError } from './auth'

/**
 * Route-handler helpers.
 *
 * Errors are RFC 9457 problem+json so a client sees the same shape whether a
 * request failed validation, authorisation, or something unforeseen - and so an
 * unexpected exception can never leak a stack trace or a database message to
 * the network.
 */

export interface Problem {
  type: string
  title: string
  status: number
  detail?: string
}

export function problem(
  status: number,
  title: string,
  detail?: string,
): NextResponse {
  const body: Problem = {
    type: `https://sitrep.local/problems/${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    status,
    ...(detail ? { detail } : {}),
  }
  return NextResponse.json(body, {
    status,
    headers: { 'content-type': 'application/problem+json' },
  })
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init)
}

/** Wrap a handler so thrown errors become problem responses, never stack traces. */
export function handler(
  fn: (req: Request, ctx: unknown) => Promise<NextResponse>,
) {
  return async (req: Request, ctx: unknown): Promise<NextResponse> => {
    try {
      return await fn(req, ctx)
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        return problem(401, 'Unauthorized', 'Sign in to continue.')
      }
      if (e instanceof z.ZodError) {
        return problem(400, 'Invalid request', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
      }
      const message = e instanceof Error ? e.message : 'Unexpected error'
      console.error('[api]', message)
      return problem(400, 'Request failed', message)
    }
  }
}

export async function parseBody<T extends z.ZodTypeAny>(
  req: Request,
  schema: T,
): Promise<z.infer<T>> {
  const raw = await req.json().catch(() => {
    throw new Error('Body must be valid JSON')
  })
  return schema.parse(raw)
}
