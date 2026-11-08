// Share management (require login).
// GET    /api/shares          -> list all shares with card titles
// POST   /api/shares          -> batch extend expiry { ids: string[], days: number } (days=0 → 永久)
// DELETE /api/shares?ids=a,b  -> batch cancel shares
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'

export async function GET() {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
    const shares = await db.share.findMany({ orderBy: { createdAt: 'desc' } })
    // Share 模型没有 card 关联，批量取标题
    const cardIds = Array.from(new Set(shares.map((s) => s.cardId)))
    const cardRows = await db.card.findMany({
      where: { id: { in: cardIds } },
      select: { id: true, title: true },
    })
    const titleMap = new Map(cardRows.map((c) => [c.id, c.title]))
    return NextResponse.json({
      shares: shares.map((s) => ({
        id: s.id,
        token: s.token,
        cardId: s.cardId,
        cardTitle: titleMap.get(s.cardId) ?? '（卡片已删除）',
        expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
        createdAt: s.createdAt.toISOString(),
      })),
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[GET /api/shares] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
    const body = await req.json().catch(() => ({}))
    const ids: string[] = Array.isArray(body?.ids)
      ? body.ids.filter((x: unknown): x is string => typeof x === 'string')
      : []
    const days = typeof body?.days === 'number' && Number.isFinite(body.days) ? Math.round(body.days) : null
    if (ids.length === 0 || days === null) {
      return NextResponse.json({ error: '参数不完整' }, { status: 400 })
    }
    const expiresAt = days === 0 ? null : new Date(Date.now() + days * 86400 * 1000)
    const res = await db.share.updateMany({ where: { id: { in: ids } }, data: { expiresAt } })
    return NextResponse.json({ updated: res.count })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/shares] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
    const idsParam = req.nextUrl.searchParams.get('ids') ?? ''
    const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean)
    if (ids.length === 0) return NextResponse.json({ error: '缺少 ids' }, { status: 400 })
    const res = await db.share.deleteMany({ where: { id: { in: ids } } })
    return NextResponse.json({ deleted: res.count })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[DELETE /api/shares] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
