// 试卷夹 — 按书本（Card）独立划分的试卷管理。
// GET    /api/papers?cardId=<id>  -> { papers }（cardId 省略 = 全部，按创建时间倒序）
// POST   /api/papers              -> 新建 { cardId, title, items?, source? }
// PUT    /api/papers              -> 更新 { id, title?, items? }（items 全量替换）
// DELETE /api/papers?id= | ?ids=a,b | ?cardId=<id> -> 删除
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAccount } from '@/lib/auth'

const MAX_ITEMS = 800_000 // items JSON 上限（100 题富媒体足够）

export async function GET(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const cardId = req.nextUrl.searchParams.get('cardId') ?? ''
    const papers = await db.paper.findMany({
      where: cardId ? { cardId } : undefined,
      orderBy: { createdAt: 'desc' },
    })
    return NextResponse.json({
      papers: papers.map((p) => ({
        id: p.id,
        cardId: p.cardId,
        cardTitle: p.cardTitle,
        title: p.title,
        source: p.source,
        count: (() => {
          try {
            const arr = JSON.parse(p.items)
            return Array.isArray(arr) ? arr.length : 0
          } catch {
            return 0
          }
        })(),
        items: (() => {
          try {
            return JSON.parse(p.items)
          } catch {
            return []
          }
        })(),
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      })),
    })
  } catch (err) {
    console.error('[GET /api/papers] failed:', err)
    return NextResponse.json({ error: '加载试卷失败' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const body = await req.json().catch(() => ({}))
    const cardId = typeof body?.cardId === 'string' ? body.cardId : ''
    if (!cardId) return NextResponse.json({ error: '缺少 cardId' }, { status: 400 })
    const card = await db.card.findUnique({ where: { id: cardId }, select: { title: true } })
    if (!card) return NextResponse.json({ error: '书本不存在' }, { status: 404 })
    let items = '[]'
    if (Array.isArray(body?.items)) {
      const s = JSON.stringify(body.items)
      if (s.length > MAX_ITEMS) return NextResponse.json({ error: '题目内容过大' }, { status: 413 })
      items = s
    }
    const title =
      typeof body?.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : ''
    const source = typeof body?.source === 'string' ? body.source.slice(0, 20) : 'ai'
    const paper = await db.paper.create({
      data: {
        cardId,
        cardTitle: card.title,
        title: title || `试卷 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        items,
        source,
      },
    })
    return NextResponse.json({ paper: { ...paper, items: JSON.parse(paper.items), createdAt: paper.createdAt.toISOString(), updatedAt: paper.updatedAt.toISOString() } })
  } catch (err) {
    console.error('[POST /api/papers] failed:', err)
    return NextResponse.json({ error: '创建试卷失败' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const body = await req.json().catch(() => ({}))
    const id = typeof body?.id === 'string' ? body.id : ''
    if (!id) return NextResponse.json({ error: '缺少 id' }, { status: 400 })
    const data: { title?: string; items?: string } = {}
    if (typeof body?.title === 'string') data.title = body.title.trim().slice(0, 120)
    if (Array.isArray(body?.items)) {
      const s = JSON.stringify(body.items)
      if (s.length > MAX_ITEMS) return NextResponse.json({ error: '题目内容过大' }, { status: 413 })
      data.items = s
    }
    const paper = await db.paper.update({ where: { id }, data })
    return NextResponse.json({ ok: true, updatedAt: paper.updatedAt.toISOString() })
  } catch (err) {
    console.error('[PUT /api/papers] failed:', err)
    return NextResponse.json({ error: '更新试卷失败' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const sp = req.nextUrl.searchParams
    const cardId = sp.get('cardId')
    if (cardId) {
      const res = await db.paper.deleteMany({ where: { cardId } })
      return NextResponse.json({ deleted: res.count })
    }
    const ids = (sp.get('ids') ?? sp.get('id') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (ids.length === 0) return NextResponse.json({ error: '缺少 id' }, { status: 400 })
    const res = await db.paper.deleteMany({ where: { id: { in: ids } } })
    return NextResponse.json({ deleted: res.count })
  } catch (err) {
    console.error('[DELETE /api/papers] failed:', err)
    return NextResponse.json({ error: '删除试卷失败' }, { status: 500 })
  }
}
