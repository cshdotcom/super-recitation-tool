// One-time account registration (only allowed while no account exists).
// POST /api/auth/register  { username, password, avatar? } -> 201 { account }
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { createSession, hashPassword, sessionCookie } from '@/lib/auth'

function avatarError(avatar: unknown): boolean {
  // Provided avatar must be a small data-URI image; ''/absent means none.
  return (
    typeof avatar !== 'string' ||
    !avatar.startsWith('data:image/') ||
    avatar.length >= 300000
  )
}

export async function POST(req: NextRequest) {
  try {
    const existing = await db.account.findFirst()
    if (existing) {
      return NextResponse.json({ error: '已初始化账号，不可重复注册' }, { status: 403 })
    }

    const body = await req.json().catch(() => ({}))
    const username = typeof body?.username === 'string' ? body.username.trim() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    if (username.length < 2 || username.length > 32) {
      return NextResponse.json({ error: '用户名需为2-32个字符' }, { status: 400 })
    }
    if (password.length < 6) {
      return NextResponse.json({ error: '密码至少6位' }, { status: 400 })
    }
    let avatar = ''
    if (body?.avatar !== undefined && body.avatar !== '') {
      if (avatarError(body.avatar)) {
        return NextResponse.json({ error: '头像格式不正确' }, { status: 400 })
      }
      avatar = body.avatar
    }

    let account
    try {
      account = await db.account.create({
        data: { username, passwordHash: hashPassword(password), avatar },
      })
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2002') {
        return NextResponse.json({ error: '用户名已存在' }, { status: 409 })
      }
      throw err
    }

    const token = await createSession(account.id)
    const res = NextResponse.json(
      { account: { id: account.id, username: account.username, avatar: account.avatar } },
      { status: 201 }
    )
    res.headers.append('Set-Cookie', sessionCookie(token))
    return res
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/auth/register] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
