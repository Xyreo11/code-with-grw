import { cookies } from 'next/headers'
import bcrypt from 'bcryptjs'
import { db } from './db'

/**
 * Minimal session auth: email + password, an opaque session row, an httpOnly
 * cookie. No OAuth, no reset flow, no verification.
 *
 * It exists because the assignment requires state to persist across sessions
 * and devices, which needs an identity — not because the project is about auth.
 * Kept deliberately thin, but not sloppy: passwords are bcrypt-hashed, the
 * cookie is httpOnly/SameSite=Lax, sessions expire, and EVERY query in the app
 * is scoped by the session's user id so one account can never read another's
 * watchlist.
 */

const COOKIE = 'sitrep_session'
const SESSION_DAYS = 30

export interface SessionUser {
  id: string
  email: string
  displayName: string
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10)
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

export async function createSession(userId: string): Promise<string> {
  const expiresAt = new Date()
  expiresAt.setUTCDate(expiresAt.getUTCDate() + SESSION_DAYS)

  const session = await db.session.create({ data: { userId, expiresAt } })

  // Next 16: cookies() is async-only.
  const jar = await cookies()
  jar.set(COOKIE, session.id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  })

  return session.id
}

export async function destroySession(): Promise<void> {
  const jar = await cookies()
  const id = jar.get(COOKIE)?.value
  if (id) {
    await db.session.deleteMany({ where: { id } })
  }
  jar.delete(COOKIE)
}

/** The signed-in user, or null. Expired sessions are treated as absent. */
export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies()
  const id = jar.get(COOKIE)?.value
  if (!id) return null

  const session = await db.session.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, email: true, displayName: true } },
    },
  })

  if (!session) return null
  if (session.expiresAt < new Date()) {
    await db.session.deleteMany({ where: { id } })
    return null
  }

  return session.user
}

/**
 * The user, or a thrown 401.
 *
 * Route handlers call this rather than checking for null themselves, so there
 * is no path where a missing session silently falls through to an unscoped
 * query.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser()
  if (!user) throw new UnauthorizedError()
  return user
}

export class UnauthorizedError extends Error {
  readonly status = 401
  constructor() {
    super('Not signed in')
    this.name = 'UnauthorizedError'
  }
}

export async function register(
  email: string,
  password: string,
  displayName: string,
): Promise<SessionUser> {
  const normalised = email.trim().toLowerCase()

  const existing = await db.user.findUnique({ where: { email: normalised } })
  if (existing) {
    throw new Error('An account with that email already exists')
  }

  const user = await db.user.create({
    data: {
      email: normalised,
      passwordHash: await hashPassword(password),
      displayName: displayName.trim() || normalised.split('@')[0],
      settings: { attentionBudget: 5, timezone: 'America/New_York' },
    },
  })

  await db.watchlist.create({
    data: { userId: user.id, name: 'My Watchlist' },
  })

  await createSession(user.id)
  return { id: user.id, email: user.email, displayName: user.displayName }
}

export async function login(
  email: string,
  password: string,
): Promise<SessionUser> {
  const normalised = email.trim().toLowerCase()
  const user = await db.user.findUnique({ where: { email: normalised } })

  // Same message and comparable work either way, so the response cannot be used
  // to enumerate which addresses have accounts.
  const ok = user
    ? await verifyPassword(password, user.passwordHash)
    : await verifyPassword(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi')

  if (!user || !ok) {
    throw new Error('Incorrect email or password')
  }

  await createSession(user.id)
  return { id: user.id, email: user.email, displayName: user.displayName }
}
