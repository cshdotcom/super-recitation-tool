// AI 对话管理 — 侧边栏列表 + 全局搜索。
// GET  /api/conversations              -> { conversations }（置顶优先，更新时间倒序）
// GET  /api/conversations?q=<关键词>    -> 全局搜索（标题 + 全部消息内容），带匹配片段
// GET  /api/conversations?q=<k>&conversationId=<id> -> 单对话内搜索（仅当前对话消息）
// POST /api/conversations              -> 新建 { title?, type?, cardId? } -> { conversation }
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAccount } from '@/lib/auth'

async function listConversations() {
  const rows = await db.conversation.findMany({
    orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
  })
  const ids = rows.map((r) => r.id)
  const msgRows = ids.length
    ? await db.chatMessage.findMany({
        where: { conversationId: { in: ids } },
        orderBy: { createdAt: 'desc' },
        select: { conversationId: true, role: true, content: true, createdAt: true },
      })
    : []
  const byConv = new Map<string, { count: number; last?: string; lastAt?: string }>()
  for (const m of msgRows) {
    const cur = byConv.get(m.conversationId) ?? { count: 0 }
    cur.count++
    if (!cur.last) {
      cur.last = m.content.slice(0, 80)
      cur.lastAt = m.createdAt.toISOString()
    }
    byConv.set(m.conversationId, cur)
  }
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    pinned: r.pinned,
    cardId: r.cardId,
    messageCount: byConv.get(r.id)?.count ?? 0,
    lastMessage: byConv.get(r.id)?.last ?? '',
    lastAt: byConv.get(r.id)?.lastAt ?? r.createdAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }))
}

export async function GET(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const sp = req.nextUrl.searchParams
    const q = (sp.get('q') ?? '').trim()
    const conversationId = sp.get('conversationId') ?? ''
    if (!q) {
      return NextResponse.json({ conversations: await listConversations() })
    }
    // ---- 搜索（大小写不敏感子串匹配）----
    const kw = q.toLowerCase()
    const searchMessages = async (convFilter?: string) => {
      const rows = await db.chatMessage.findMany({
        where: convFilter ? { conversationId: convFilter } : undefined,
        orderBy: { createdAt: 'desc' },
        select: { id: true, conversationId: true, role: true, content: true, createdAt: true },
      })
      const hits = rows.filter((m) => m.content.toLowerCase().includes(kw))
      return hits.map((m) => {
        const idx = m.content.toLowerCase().indexOf(kw)
        const from = Math.max(0, idx - 20)
        return {
          messageId: m.id,
          conversationId: m.conversationId,
          role: m.role,
          snippet: m.content.slice(from, from + kw.length + 60),
          createdAt: m.createdAt.toISOString(),
        }
      })
    }
    if (conversationId) {
      // 单对话内搜索
      return NextResponse.json({ messageHits: await searchMessages(conversationId) })
    }
    // 全局：标题匹配 + 消息内容匹配
    const convs = await listConversations()
    const titleHits = convs.filter((c) => c.title.toLowerCase().includes(kw))
    const messageHits = await searchMessages()
    const hitConvIds = new Set([...titleHits.map((c) => c.id), ...messageHits.map((m) => m.conversationId)])
    return NextResponse.json({
      conversations: convs.filter((c) => hitConvIds.has(c.id)),
      titleHits: titleHits.map((c) => c.id),
      messageHits,
    })
  } catch (err) {
    console.error('[GET /api/conversations] failed:', err)
    return NextResponse.json({ error: '加载对话失败' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const body = await req.json().catch(() => ({}))
    const title = typeof body?.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : ''
    const type = typeof body?.type === 'string' ? body.type.slice(0, 20) : 'chat'
    const cardId = typeof body?.cardId === 'string' ? body.cardId : ''
    const conv = await db.conversation.create({
      data: {
        title: title || '新对话',
        type,
        cardId,
      },
    })
    return NextResponse.json({
      conversation: { ...conv, createdAt: conv.createdAt.toISOString(), updatedAt: conv.updatedAt.toISOString() },
    })
  } catch (err) {
    console.error('[POST /api/conversations] failed:', err)
    return NextResponse.json({ error: '新建对话失败' }, { status: 500 })
  }
}
