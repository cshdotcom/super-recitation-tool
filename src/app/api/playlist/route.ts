// 待播放列表（全局朗读队列，跨书本）— 服务端持久化。
// GET    /api/playlist                     -> { items: PlayItem[] }（按 ord 升序）
// POST   /api/playlist                     -> 添加 { cardId, label?, startText?, endText? }（可批量 items[]）
// PUT    /api/playlist                     -> 重排序 { ids: string[] }（数组顺序即新顺序）
// DELETE /api/playlist?id=<id> | ?ids=a,b | ?cardId=<id> | ?all=1 -> 删除
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAccount } from '@/lib/auth'

export async function GET() {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const items = await db.playItem.findMany({
      orderBy: [{ ord: 'asc' }, { createdAt: 'asc' }],
    })
    return NextResponse.json({
      items: items.map((x) => ({
        id: x.id,
        cardId: x.cardId,
        cardTitle: x.cardTitle,
        label: x.label,
        startText: x.startText,
        endText: x.endText,
        ord: x.ord,
        createdAt: x.createdAt.toISOString(),
      })),
    })
  } catch (err) {
    console.error('[GET /api/playlist] failed:', err)
    return NextResponse.json({ error: '加载播放列表失败' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const body = await req.json().catch(() => ({}))
    const raw = Array.isArray(body?.items) ? body.items : [body]
    const entries = raw
      .map((e: Record<string, unknown>) => ({
        cardId: typeof e.cardId === 'string' ? e.cardId : '',
        label: typeof e.label === 'string' ? e.label.slice(0, 120) : '',
        startText: typeof e.startText === 'string' ? e.startText.slice(0, 120) : '',
        endText: typeof e.endText === 'string' ? e.endText.slice(0, 120) : '',
      }))
      .filter((e: { cardId: string }) => e.cardId)
    if (entries.length === 0) {
      return NextResponse.json({ error: '缺少 cardId' }, { status: 400 })
    }
    const cards = await db.card.findMany({
      where: { id: { in: entries.map((e: { cardId: string }) => e.cardId) } },
      select: { id: true, title: true },
    })
    const titleMap = new Map(cards.map((c) => [c.id, c.title]))
    const last = await db.playItem.findFirst({ orderBy: { ord: 'desc' }, select: { ord: true } })
    const baseOrd = (last?.ord ?? 0) + 1
    const created: Array<{
      id: string
      cardId: string
      cardTitle: string
      label: string
      startText: string
      endText: string
      ord: number
      createdAt: Date
    }> = []
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (!titleMap.has(e.cardId)) continue // 卡片不存在则跳过
      created.push(
        await db.playItem.create({
          data: { ...e, cardTitle: titleMap.get(e.cardId) ?? '', ord: baseOrd + i },
        }),
      )
    }
    return NextResponse.json({
      items: created.map((x) => ({ ...x, createdAt: x.createdAt.toISOString() })),
    })
  } catch (err) {
    console.error('[POST /api/playlist] failed:', err)
    return NextResponse.json({ error: '添加到播放列表失败' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const body = await req.json().catch(() => ({}))
    const ids: string[] = Array.isArray(body?.ids)
      ? body.ids.filter((x: unknown): x is string => typeof x === 'string')
      : []
    if (ids.length === 0) {
      return NextResponse.json({ error: '缺少 ids' }, { status: 400 })
    }
    for (let i = 0; i < ids.length; i++) {
      await db.playItem.updateMany({ where: { id: ids[i] }, data: { ord: i + 1 } })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[PUT /api/playlist] failed:', err)
    return NextResponse.json({ error: '排序失败' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const sp = req.nextUrl.searchParams
    if (sp.get('all')) {
      const res = await db.playItem.deleteMany({})
      return NextResponse.json({ deleted: res.count })
    }
    const cardId = sp.get('cardId')
    if (cardId) {
      const res = await db.playItem.deleteMany({ where: { cardId } })
      return NextResponse.json({ deleted: res.count })
    }
    const ids = (sp.get('ids') ?? sp.get('id') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (ids.length === 0) return NextResponse.json({ error: '缺少 id' }, { status: 400 })
    const res = await db.playItem.deleteMany({ where: { id: { in: ids } } })
    return NextResponse.json({ deleted: res.count })
  } catch (err) {
    console.error('[DELETE /api/playlist] failed:', err)
    return NextResponse.json({ error: '删除失败' }, { status: 500 })
  }
}
