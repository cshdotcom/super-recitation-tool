// POST /api/auth/logout -> destroy the session, clear the cookie
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { clearCookieValue, destroySession, SESSION_COOKIE } from '@/lib/auth'

export async function POST() {
  try {
    const store = await cookies()
    const token = store.get(SESSION_COOKIE)?.value
    if (token) await destroySession(token)
    const res = NextResponse.json({ ok: true })
    res.headers.append('Set-Cookie', clearCookieValue())
    return res
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/auth/logout] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
