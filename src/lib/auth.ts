// Server-only auth helpers: scrypt password hashing + httpOnly cookie sessions.
// Uses the `sb_session` cookie; sessions live 30 days in the Session table.
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import { db } from '@/lib/db'

export const SESSION_COOKIE = 'sb_session'
const SESSION_MAX_AGE = 60 * 60 * 24 * 30 // 30 days in seconds

export interface SessionUser {
  id: string
  username: string
  avatar: string
}

// ---------- passwords ----------

/** Hash a password as `salt:hash` (hex) using scrypt. */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(pw, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

/** Constant-time password verification against a `salt:hash` string. */
export function verifyPassword(pw: string, stored: string): boolean {
  try {
    const [salt, hash] = stored.split(':')
    if (!salt || !hash) return false
    const expected = Buffer.from(hash, 'hex')
    const actual = scryptSync(pw, salt, expected.length)
    return timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

// ---------- sessions ----------

/** Create a 30-day session row for the account and return the raw token. */
export async function createSession(accountId: string): Promise<string> {
  const token = randomUUID() + randomUUID()
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE * 1000)
  await db.session.create({ data: { token, accountId, expiresAt } })
  return token
}

/** Serialized Set-Cookie value for a fresh session. */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`
}

/** Serialized Set-Cookie value that clears the session cookie. */
export function clearCookieValue(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

/** Current logged-in account from the session cookie (null if none/expired). */
export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const store = await cookies()
    const token = store.get(SESSION_COOKIE)?.value
    if (!token) return null

    const session = await db.session.findUnique({ where: { token } })
    if (!session) return null
    if (session.expiresAt.getTime() < Date.now()) {
      // Expired: clean up the row and treat as logged out.
      await db.session.delete({ where: { token } }).catch(() => {})
      return null
    }

    const account = await db.account.findUnique({ where: { id: session.accountId } })
    if (!account) return null
    return { id: account.id, username: account.username, avatar: account.avatar }
  } catch {
    return null
  }
}

/** Alias used by route handlers. */
export async function requireAccount(): Promise<SessionUser | null> {
  return getSessionUser()
}

/** Delete a session row by token (idempotent). */
export async function destroySession(token: string): Promise<void> {
  if (!token) return
  try {
    await db.session.delete({ where: { token } })
  } catch {
    // already gone
  }
}
