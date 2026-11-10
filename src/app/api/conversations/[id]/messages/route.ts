// 对话消息追加 / 清空。
// POST   /api/conversations/:id/messages { role, content, images? } -> { message }
//        （支持批量 { messages: [{role,content,images}] }，AI 问答一问一答成对入库）
// DELETE /api/conversations/:id/messages -> 清空当前对话全部消息
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAccount } from '@/lib/auth'

const MAX_CONTENT = 400_000

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const { id } = await params
    const conv = await db.conversation.findUnique({ where: { id }, select: { id: true } })
    if (!conv) return NextResponse.json({ error: '对话不存在' }, { status: 404 })
    const body = await req.json().catch(() => ({}))
    const raw = Array.isArray(body?.messages) ? body.messages : [body]
    const entries = raw
      .map((m: Record<string, unknown>) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m.content === 'string' ? m.content.slice(0, MAX_CONTENT) : '',
        images: Array.isArray(m.images)
          ? JSON.stringify(m.images.filter((x: unknown): x is string => typeof x === 'string').slice(0, 8))
          : '[]',
      }))
      .filter((m: { content: string }) => m.content.length > 0)
    if (entries.length === 0) {
      return NextResponse.json({ error: '消息内容为空' }, { status: 400 })
    }
    const created: Array<{
      id: string
      role: string
      content: string
      images: string
      createdAt: Date
    }> = []
    for (const e of entries) {
      created.push(await db.chatMessage.create({ data: { conversationId: id, ...e } }))
    }
    await db.conversation.update({ where: { id }, data: { updatedAt: new Date() } })
    return NextResponse.json({
      messages: created.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        images: JSON.parse(m.images),
        createdAt: m.createdAt.toISOString(),
      })),
    })
  } catch (err) {
    console.error('[POST /api/conversations/:id/messages] failed:', err)
    return NextResponse.json({ error: '保存消息失败' }, { status: 500 })
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const { id } = await params
    const res = await db.chatMessage.deleteMany({ where: { conversationId: id } })
    await db.conversation.update({ where: { id }, data: { updatedAt: new Date() } })
    return NextResponse.json({ deleted: res.count })
  } catch (err) {
    console.error('[DELETE /api/conversations/:id/messages] failed:', err)
    return NextResponse.json({ error: '清空消息失败' }, { status: 500 })
  }
}
