// Focus session log — one row per completed/abandoned focus session.
// All records live server-side (multi-device visible).
//
// POST   /api/focus/log  { contentId?, name?, seconds }   (seconds int 1-86400)
//          -> contentId optional: free-focus sessions (no content chosen)
//             are stored with name only ("自由专注" default).
// GET    /api/focus/log?tzOffset=-480
//          -> { logs: [{ id, name, seconds, at }] }  today's sessions asc.
// DELETE /api/focus/log?id=<logId>
//          -> { ok: true }
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'

const NAME_MAX = 30

/** Day key 'YYYY-MM-DD' shifted by the client's timezone (same as /api/focus). */
function dayKey(d: Date, tzOffsetMin: number): string {
  return new Date(d.getTime() + tzOffsetMin * 60000).toISOString().slice(0, 10)
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.json({ error: '未登录' }, { status: 401 })
  }
  try {
    const body = await req.json().catch(() => ({}))
    const rawContentId = String(body?.contentId || '')
    const seconds = Math.round(Number(body?.seconds))
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86400) {
      return NextResponse.json({ error: '无效的专注时长' }, { status: 400 })
    }
    const name = (typeof body?.name === 'string' && body.name.trim()
      ? body.name.trim()
      : '自由专注'
    ).slice(0, NAME_MAX)

    if (rawContentId) {
      const content = await db.focusContent.findUnique({
        where: { id: rawContentId },
        select: { id: true },
      })
      if (!content) {
        return NextResponse.json({ error: '专注内容不存在' }, { status: 404 })
      }
      await db.focusLog.create({
        data: { contentId: rawContentId, name, seconds },
      })
    } else {
      // 自由专注（未选内容）——只记名字
      await db.focusLog.create({ data: { name, seconds } })
    }
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/focus/log] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.json({ error: '未登录' }, { status: 401 })
  }
  try {
    const tz = Number(req.nextUrl.searchParams.get('tzOffset') ?? '0')
    const off = Number.isFinite(tz) ? tz : 0
    const today = dayKey(new Date(), off)
    const logs = await db.focusLog.findMany({
      where: {
        createdAt: {
          gte: new Date(`${today}T00:00:00.000Z`),
          lt: new Date(`${today}T23:59:59.999Z`),
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    })
    return NextResponse.json({
      logs: logs.map((l) => ({
        id: l.id,
        name: l.name || '自由专注',
        seconds: l.seconds,
        at: l.createdAt.getTime(),
      })),
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[GET /api/focus/log] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.json({ error: '未登录' }, { status: 401 })
  }
  try {
    const id = req.nextUrl.searchParams.get('id') || ''
    if (!id) {
      return NextResponse.json({ error: '缺少记录 id' }, { status: 400 })
    }
    await db.focusLog.delete({ where: { id } }).catch(() => null)
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[DELETE /api/focus/log] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
