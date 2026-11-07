// PATCH /api/auth/profile  { username?, avatar?, currentPassword?, newPassword? }
// Requires a session. Returns { account }.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser, hashPassword, verifyPassword } from '@/lib/auth'

export async function PATCH(req: NextRequest) {
  try {
    const session = await getSessionUser()
    if (!session) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    const body = await req.json().catch(() => ({}))
    const data: { username?: string; avatar?: string; passwordHash?: string } = {}

    if (body?.username !== undefined) {
      if (typeof body.username !== 'string') {
        return NextResponse.json({ error: '用户名需为2-32个字符' }, { status: 400 })
      }
      const username = body.username.trim()
      if (username.length < 2 || username.length > 32) {
        return NextResponse.json({ error: '用户名需为2-32个字符' }, { status: 400 })
      }
      data.username = username
    }

    if (body?.avatar !== undefined) {
      if (
        typeof body.avatar !== 'string' ||
        (body.avatar !== '' &&
          (!body.avatar.startsWith('data:image/') || body.avatar.length >= 300000))
      ) {
        return NextResponse.json({ error: '头像格式不正确' }, { status: 400 })
      }
      data.avatar = body.avatar
    }

    if (body?.currentPassword !== undefined || body?.newPassword !== undefined) {
      const current = typeof body?.currentPassword === 'string' ? body.currentPassword : ''
      const next = typeof body?.newPassword === 'string' ? body.newPassword : ''
      if (!current || !next) {
        return NextResponse.json({ error: '修改密码需提供当前密码和新密码' }, { status: 400 })
      }
      const row = await db.account.findUnique({ where: { id: session.id } })
      if (!row || !verifyPassword(current, row.passwordHash)) {
        return NextResponse.json({ error: '当前密码错误' }, { status: 400 })
      }
      if (next.length < 6) {
        return NextResponse.json({ error: '新密码至少6位' }, { status: 400 })
      }
      data.passwordHash = hashPassword(next)
    }

    if (Object.keys(data).length > 0) {
      try {
        await db.account.update({ where: { id: session.id }, data })
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === 'P2002') {
          return NextResponse.json({ error: '用户名已存在' }, { status: 409 })
        }
        throw err
      }
    }

    const updated = await db.account.findUnique({ where: { id: session.id } })
    const account = updated
      ? { id: updated.id, username: updated.username, avatar: updated.avatar }
      : session
    return NextResponse.json({ account })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[PATCH /api/auth/profile] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
