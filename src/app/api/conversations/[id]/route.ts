// 单个 AI 对话 — 详情 / 重命名 / 置顶 / 类型 / 删除。
// GET    /api/conversations/:id -> { conversation, messages }
// PATCH  /api/conversations/:id { title?, pinned?, type?, autoRename?: true }
//        autoRename=true 时由服务端调用 AI 依据首条用户消息生成标题
// DELETE /api/conversations/:id （连同消息级联删除）
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAccount } from '@/lib/auth'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const { id } = await params
    const conv = await db.conversation.findUnique({ where: { id } })
    if (!conv) return NextResponse.json({ error: '对话不存在' }, { status: 404 })
    const messages = await db.chatMessage.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
    })
    return NextResponse.json({
      conversation: { ...conv, createdAt: conv.createdAt.toISOString(), updatedAt: conv.updatedAt.toISOString() },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        images: (() => {
          try {
            return JSON.parse(m.images)
          } catch {
            return []
          }
        })(),
        createdAt: m.createdAt.toISOString(),
      })),
    })
  } catch (err) {
    console.error('[GET /api/conversations/:id] failed:', err)
    return NextResponse.json({ error: '加载对话失败' }, { status: 500 })
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const { id } = await params
    const conv = await db.conversation.findUnique({ where: { id } })
    if (!conv) return NextResponse.json({ error: '对话不存在' }, { status: 404 })
    const body = await req.json().catch(() => ({}))
    const data: { title?: string; pinned?: boolean; type?: string; updatedAt: Date } = {
      updatedAt: new Date(),
    }
    if (typeof body?.title === 'string') data.title = body.title.trim().slice(0, 120) || conv.title
    if (typeof body?.pinned === 'boolean') data.pinned = body.pinned
    if (typeof body?.type === 'string') data.type = body.type.slice(0, 20)

    // AI 自动重命名：依据首条用户消息生成简短标题
    if (body?.autoRename === true) {
      const firstUser = await db.chatMessage.findFirst({
        where: { conversationId: id, role: 'user' },
        orderBy: { createdAt: 'asc' },
      })
      if (firstUser) {
        try {
          const ZAI = (await import('z-ai-web-dev-sdk')).default
          const zai = await ZAI.create()
          const completion = await zai.chat.completions.create({
            messages: [
              {
                role: 'user',
                content: `请用不超过12个字概括以下用户问题的主题，直接输出标题，不要任何标点、引号或解释：\n${firstUser.content.slice(0, 500)}`,
              },
            ],
          })
          const title = (completion.choices[0]?.message?.content ?? '').trim().slice(0, 12)
          if (title) data.title = title
        } catch (err) {
          console.error('[autoRename] AI failed:', err)
        }
      }
    }
    const updated = await db.conversation.update({ where: { id }, data })
    return NextResponse.json({
      conversation: { ...updated, createdAt: updated.createdAt.toISOString(), updatedAt: updated.updatedAt.toISOString() },
    })
  } catch (err) {
    console.error('[PATCH /api/conversations/:id] failed:', err)
    return NextResponse.json({ error: '更新对话失败' }, { status: 500 })
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
    await db.chatMessage.deleteMany({ where: { conversationId: id } })
    await db.conversation.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[DELETE /api/conversations/:id] failed:', err)
    return NextResponse.json({ error: '删除对话失败' }, { status: 500 })
  }
}
