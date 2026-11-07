// Card collection endpoints (require login).
// GET    /api/cards           -> list active (non-deleted) cards (newest first)
// GET    /api/cards?trash=1   -> list trashed cards (deletedAt desc); auto-purges
//                               cards soft-deleted more than 30 days ago first
// POST   /api/cards           -> create a new card
// POST   /api/cards           -> { action: 'restore-all' } restores every trashed card
// DELETE /api/cards           -> delete ALL cards, active + trashed (storage management)
// DELETE /api/cards?trash=1   -> empty the recycle bin (permanently delete trashed only)
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { serializeCard } from '@/lib/card'

const TRASH_TTL_MS = 30 * 86400 * 1000 // 回收站保留 30 天，过期自动彻底删除

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }
    const isTrash = req.nextUrl.searchParams.get('trash') === '1'
    if (isTrash) {
      // 回收站视图：先把删除超过 30 天的卡片彻底清掉，再列出剩余的已删卡片
      await db.card.deleteMany({
        where: { deletedAt: { lt: new Date(Date.now() - TRASH_TTL_MS) } },
      })
      const cards = await db.card.findMany({
        where: { deletedAt: { not: null } },
        orderBy: { deletedAt: 'desc' },
      })
      return NextResponse.json({ cards: cards.map(serializeCard) })
    }
    const cards = await db.card.findMany({
      where: { deletedAt: null },
      orderBy: { updatedAt: 'desc' },
    })
    return NextResponse.json({ cards: cards.map(serializeCard) })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[GET /api/cards] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }
    const body = await req.json().catch(() => ({}))
    // 动作型请求（回收站「全部恢复」）：{ action: 'restore-all' }
    if (typeof body?.action === 'string') {
      if (body.action !== 'restore-all') {
        return NextResponse.json({ error: '未知操作' }, { status: 400 })
      }
      const res = await db.card.updateMany({
        where: { deletedAt: { not: null } },
        data: { deletedAt: null },
      })
      return NextResponse.json({ restored: res.count })
    }
    const content: string = typeof body?.content === 'string' ? body.content : ''
    if (!content.trim()) {
      return NextResponse.json({ error: '内容不能为空' }, { status: 400 })
    }
    const title: string =
      typeof body?.title === 'string' && body.title.trim() ? body.title.trim() : '未命名卡片'
    const keywords: string[] = Array.isArray(body?.keywords)
      ? body.keywords.filter((k: unknown): k is string => typeof k === 'string')
      : []

    const card = await db.card.create({
      data: {
        title,
        content,
        keywords: JSON.stringify(keywords),
      },
    })
    return NextResponse.json(serializeCard(card), { status: 201 })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/cards] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }
    // ?trash=1 -> 只清空回收站（彻底删除已软删的卡片）；默认清空全部卡片
    const isTrash = req.nextUrl.searchParams.get('trash') === '1'
    if (isTrash) {
      await db.card.deleteMany({ where: { deletedAt: { not: null } } })
    } else {
      await db.card.deleteMany({})
    }
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[DELETE /api/cards] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
