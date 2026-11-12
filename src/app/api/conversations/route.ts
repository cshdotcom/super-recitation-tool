// AI 对话管理 — 侧边栏列表 + 全局搜索 + 主对话 + 自定义排序。
// GET   /api/conversations              -> { conversations }（置顶优先，更新时间倒序；
//                                         含 ord / isMain；不含 type='shared' 分享快照）
// GET   /api/conversations?q=<关键词>    -> 全局搜索（标题 + 全部消息内容），带匹配片段
// GET   /api/conversations?q=<k>&conversationId=<id> -> 单对话内搜索（仅当前对话消息）
// POST  /api/conversations              -> 新建 { title?, type?, cardId? } -> { conversation }
// POST  /api/conversations { action:'ensure-main' }
//                                     -> 返回主对话「AI问问」（不存在则创建：
//                                        title 'AI问问' / isMain / pinned / ord -1000000）
// PATCH /api/conversations { action:'reorder', ids:[...] }
//                                     -> 按数组顺序持久化 ord（0,1,2…；主对话不参与）
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAccount } from '@/lib/auth'

/** 分享所选消息时生成的快照对话类型（不出现在对话列表/搜索中；
 *  shares/route.ts 创建快照时使用同一字面量 'shared'）。 */
const SHARED_SNAPSHOT_TYPE = 'shared'

/** 主对话固定 ord（自定义排序永远排最前）。 */
const MAIN_ORD = -1_000_000

async function listConversations() {
  const rows = await db.conversation.findMany({
    where: { type: { not: SHARED_SNAPSHOT_TYPE } },
    orderBy: [{ pinned: 'desc' }, { ord: 'asc' }, { updatedAt: 'desc' }],
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
    ord: r.ord,
    isMain: r.isMain,
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
    // ---- 搜索（大小写不敏感子串匹配；排除分享快照对话）----
    const kw = q.toLowerCase()
    const snapshotRows = await db.conversation.findMany({
      where: { type: SHARED_SNAPSHOT_TYPE },
      select: { id: true },
    })
    const snapshotIds = snapshotRows.map((r) => r.id)
    const searchMessages = async (convFilter?: string) => {
      const rows = await db.chatMessage.findMany({
        where: {
          ...(convFilter
            ? { conversationId: convFilter }
            : { conversationId: { notIn: snapshotIds } }),
        },
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

    // ---- 主对话 ensure-main：返回主对话（不存在则创建） ----
    if (body?.action === 'ensure-main') {
      const existing = await db.conversation.findFirst({ where: { isMain: true } })
      if (existing) {
        return NextResponse.json({
          conversation: {
            ...existing,
            createdAt: existing.createdAt.toISOString(),
            updatedAt: existing.updatedAt.toISOString(),
          },
        })
      }
      const created = await db.conversation.create({
        data: {
          title: 'AI问问',
          type: 'chat',
          isMain: true,
          pinned: true,
          ord: MAIN_ORD,
        },
      })
      return NextResponse.json({
        conversation: {
          ...created,
          createdAt: created.createdAt.toISOString(),
          updatedAt: created.updatedAt.toISOString(),
        },
      })
    }

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

// PATCH /api/conversations { action:'reorder', ids:[...] } — 自定义拖动排序持久化。
export async function PATCH(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const body = await req.json().catch(() => ({}))
    if (body?.action !== 'reorder') {
      return NextResponse.json({ error: '不支持的操作' }, { status: 400 })
    }
    const ids: string[] = Array.isArray(body?.ids)
      ? body.ids.filter((x: unknown): x is string => typeof x === 'string' && x.length > 0)
      : []
    if (ids.length === 0) {
      return NextResponse.json({ error: '缺少 ids' }, { status: 400 })
    }
    // 按数组顺序写 ord（0,1,2…）；updateMany 带 isMain:false 守卫，主对话永不参与
    await db.$transaction(
      ids.map((id, i) =>
        db.conversation.updateMany({
          where: { id, isMain: false },
          data: { ord: i },
        }),
      ),
    )
    // updateMany 不返回逐条结果，读回实际命中的数量
    const updated = await db.conversation.findMany({
      where: { id: { in: ids }, isMain: false },
      select: { id: true },
    })
    return NextResponse.json({ ok: true, count: updated.length })
  } catch (err) {
    console.error('[PATCH /api/conversations] failed:', err)
    return NextResponse.json({ error: '保存排序失败' }, { status: 500 })
  }
}
