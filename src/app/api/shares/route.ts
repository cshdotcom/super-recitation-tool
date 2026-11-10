// Share management (require login).
// GET    /api/shares          -> list all shares (kind: card | conversation) with titles
// POST   /api/shares          -> { action: 'create', kind: 'card'|'conversation', cardId?|conversationId?, days? } 创建分享
//                             -> { ids, days } batch extend expiry (days=0 → 永久)
// DELETE /api/shares?ids=a,b  -> batch cancel shares
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'

function genToken(): string {
  return (
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  ).slice(0, 24)
}

export async function GET() {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
    const shares = await db.share.findMany({ orderBy: { createdAt: 'desc' } })
    // 批量取卡片标题（kind=card）
    const cardIds = Array.from(new Set(shares.filter((s) => s.kind === 'card').map((s) => s.cardId)))
    const cardRows = cardIds.length
      ? await db.card.findMany({ where: { id: { in: cardIds } }, select: { id: true, title: true } })
      : []
    const titleMap = new Map(cardRows.map((c) => [c.id, c.title]))
    // 批量取对话标题（kind=conversation）
    const convIds = Array.from(new Set(shares.filter((s) => s.kind === 'conversation').map((s) => s.refId)))
    const convRows = convIds.length
      ? await db.conversation.findMany({ where: { id: { in: convIds } }, select: { id: true, title: true } })
      : []
    const convTitleMap = new Map(convRows.map((c) => [c.id, c.title]))
    return NextResponse.json({
      shares: shares.map((s) => ({
        id: s.id,
        token: s.token,
        kind: s.kind,
        cardId: s.cardId,
        refId: s.refId,
        title:
          s.kind === 'conversation'
            ? s.title || convTitleMap.get(s.refId) || '（对话已删除）'
            : titleMap.get(s.cardId) ?? '（卡片已删除）',
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

    // ---- 创建分享（书籍内容 / AI 对话）----
    if (body?.action === 'create') {
      const kind = body.kind === 'conversation' ? 'conversation' : 'card'
      const days =
        typeof body.days === 'number' && Number.isFinite(body.days)
          ? Math.round(body.days)
          : 0
      const expiresAt = days === 0 ? null : new Date(Date.now() + days * 86400 * 1000)
      if (kind === 'conversation') {
        const conversationId = typeof body.conversationId === 'string' ? body.conversationId : ''
        if (!conversationId) return NextResponse.json({ error: '缺少 conversationId' }, { status: 400 })
        const conv = await db.conversation.findUnique({ where: { id: conversationId } })
        if (!conv) return NextResponse.json({ error: '对话不存在' }, { status: 404 })
        // 已有有效分享则复用
        const existing = await db.share.findFirst({ where: { kind, refId: conversationId } })
        if (existing) {
          const upd = await db.share.update({ where: { id: existing.id }, data: { expiresAt, title: conv.title } })
          return NextResponse.json({ share: { id: upd.id, token: upd.token, kind, refId: conversationId, title: conv.title } })
        }
        const created = await db.share.create({
          data: { token: genToken(), kind, refId: conversationId, cardId: '', title: conv.title, expiresAt },
        })
        return NextResponse.json({ share: { id: created.id, token: created.token, kind, refId: conversationId, title: conv.title } })
      }
      const cardId = typeof body.cardId === 'string' ? body.cardId : ''
      if (!cardId) return NextResponse.json({ error: '缺少 cardId' }, { status: 400 })
      const card = await db.card.findUnique({ where: { id: cardId }, select: { title: true } })
      if (!card) return NextResponse.json({ error: '卡片不存在' }, { status: 404 })
      const existing = await db.share.findFirst({ where: { kind: 'card', cardId } })
      if (existing) {
        const upd = await db.share.update({ where: { id: existing.id }, data: { expiresAt } })
        return NextResponse.json({ share: { id: upd.id, token: upd.token, kind: 'card', cardId } })
      }
      const created = await db.share.create({
        data: { token: genToken(), kind: 'card', cardId, refId: '', title: card.title, expiresAt },
      })
      return NextResponse.json({ share: { id: created.id, token: created.token, kind: 'card', cardId } })
    }

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
