// Focus session log — one row per completed/abandoned focus session.
// POST /api/focus/log  { contentId, seconds }  (seconds int 1-86400)
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.json({ error: '未登录' }, { status: 401 })
  }
  try {
    const body = await req.json().catch(() => ({}))
    const contentId = String(body?.contentId || '')
    if (!contentId) {
      return NextResponse.json({ error: '缺少 contentId' }, { status: 400 })
    }
    const seconds = Math.round(Number(body?.seconds))
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86400) {
      return NextResponse.json({ error: '无效的专注时长' }, { status: 400 })
    }
    const content = await db.focusContent.findUnique({ where: { id: contentId }, select: { id: true } })
    if (!content) {
      return NextResponse.json({ error: '专注内容不存在' }, { status: 404 })
    }
    await db.focusLog.create({ data: { contentId, seconds } })
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/focus/log] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
