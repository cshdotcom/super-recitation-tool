// AI问问 / AI督背 对话历史 — 服务端持久化。
// GET    /api/chat-log?cardId=<id>&mode=ask|supervise  -> { messages: [{id,role,content,images,createdAt}] }
// POST   /api/chat-log  { cardId, mode, role, content, images? }  -> { id }
// DELETE /api/chat-log?id=<rowId>          删除单条（连同其相邻 user 消息由前端再调一次）
//        /api/chat-log?cardId=<id>&mode=.. 清空该卡片该模式全部对话
//        /api/chat-log?all=1               清空全部对话记录
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAccount } from '@/lib/auth'

const MODES = ['ask', 'supervise'] as const
const ROLES = ['user', 'assistant'] as const
/** 单条消息附图总体上限（dataURL 压缩后仍可能较大，防止 SQLite 行过大）。 */
const MAX_IMAGES_BYTES = 1_500_000

export async function GET(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })

  try {
    const sp = req.nextUrl.searchParams
    const cardId = String(sp.get('cardId') || '')
    const mode = String(sp.get('mode') || '')
    if (!cardId || !MODES.includes(mode as (typeof MODES)[number])) {
      return NextResponse.json({ error: '缺少 cardId 或 mode' }, { status: 400 })
    }
    const rows = await db.chatLog.findMany({
      where: { cardId, mode },
      orderBy: { createdAt: 'asc' },
    })
    return NextResponse.json({
      messages: rows.map((r) => {
        let images: string[] = []
        try {
          const parsed = JSON.parse(r.images) as unknown
          if (Array.isArray(parsed)) {
            images = parsed.filter((x): x is string => typeof x === 'string')
          }
        } catch {}
        return { id: r.id, role: r.role, content: r.content, images, createdAt: r.createdAt }
      }),
    })
  } catch (err) {
    console.error('[GET /api/chat-log] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '加载失败' },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })

  try {
    const body = await req.json()
    const mode = String(body?.mode || '')
    const role = String(body?.role || '')
    const content = String(body?.content || '')
    if (!MODES.includes(mode as (typeof MODES)[number])) {
      return NextResponse.json({ error: '无效的对话模式' }, { status: 400 })
    }
    if (!ROLES.includes(role as (typeof ROLES)[number])) {
      return NextResponse.json({ error: '无效的角色' }, { status: 400 })
    }
    if (!content.trim()) {
      return NextResponse.json({ error: '消息内容为空' }, { status: 400 })
    }

    // 附图（仅 user 消息）：过滤非法项并做总体积限制
    let images: string[] = []
    if (Array.isArray(body?.images)) {
      const cand = (body.images as unknown[]).filter(
        (x): x is string => typeof x === 'string' && x.startsWith('data:image/'),
      )
      let total = 0
      for (const img of cand) {
        if (total + img.length > MAX_IMAGES_BYTES) break
        images.push(img)
        total += img.length
      }
    }

    const row = await db.chatLog.create({
      data: {
        cardId: String(body?.cardId || ''),
        mode,
        role,
        content: content.slice(0, 20000),
        images: JSON.stringify(images),
      },
    })
    return NextResponse.json({ id: row.id })
  } catch (err) {
    console.error('[POST /api/chat-log] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '保存失败' },
      { status: 500 },
    )
  }
}

export async function DELETE(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })

  try {
    const sp = req.nextUrl.searchParams
    const id = sp.get('id')
    if (id) {
      await db.chatLog.deleteMany({ where: { id } })
      return NextResponse.json({ ok: true })
    }
    const cardId = sp.get('cardId')
    const mode = sp.get('mode')
    if (cardId && mode && MODES.includes(mode as (typeof MODES)[number])) {
      await db.chatLog.deleteMany({ where: { cardId, mode } })
      return NextResponse.json({ ok: true })
    }
    if (sp.get('all')) {
      await db.chatLog.deleteMany({})
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ error: '缺少删除参数' }, { status: 400 })
  } catch (err) {
    console.error('[DELETE /api/chat-log] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '删除失败' },
      { status: 500 },
    )
  }
}
