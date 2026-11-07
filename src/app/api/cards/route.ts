// Card collection endpoints (require login).
// GET    /api/cards          -> list all cards (newest first)
// POST   /api/cards          -> create a new card
// DELETE /api/cards          -> delete ALL cards (storage management)
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { serializeCard } from '@/lib/card'

export async function GET() {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }
    const cards = await db.card.findMany({ orderBy: { updatedAt: 'desc' } })
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

export async function DELETE() {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }
    await db.card.deleteMany({})
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[DELETE /api/cards] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
