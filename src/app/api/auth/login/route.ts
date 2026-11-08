// POST /api/auth/login  { username, password } -> 200 { account } + session cookie
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { createSession, sessionCookie, verifyPassword } from '@/lib/auth'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const username = typeof body?.username === 'string' ? body.username.trim() : ''
    const password = typeof body?.password === 'string' ? body.password : ''

    const account = await db.account.findUnique({ where: { username } })
    if (!account || !verifyPassword(password, account.passwordHash)) {
      return NextResponse.json({ error: '用户名或密码错误' }, { status: 401 })
    }

    const token = await createSession(account.id)
    const res = NextResponse.json({
      account: { id: account.id, username: account.username, avatar: account.avatar },
    })
    res.headers.append('Set-Cookie', sessionCookie(token))
    return res
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/auth/login] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
