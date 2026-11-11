// PUBLIC share-view endpoint (no auth).
// GET /api/share/:token -> { card, share } | { conversation, messages, share }
//                       | { paper, share } | 404 { error } | 410 { error }
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

function parseKeywords(json: string): unknown[] {
  try {
    const parsed = JSON.parse(json || '[]')
    if (!Array.isArray(parsed)) return []
    // 位置感知挖空条目：string | { t, occ } 原样返回（客户端 normKeywordEntries 解析）
    return parsed.filter(
      (k: unknown) => typeof k === 'string' || (k && typeof k === 'object'),
    )
  } catch {
    return []
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params
    const share = await db.share.findUnique({ where: { token } })
    if (!share) {
      return NextResponse.json({ error: '分享不存在或已取消' }, { status: 404 })
    }
    if (share.expiresAt && share.expiresAt.getTime() < Date.now()) {
      return NextResponse.json({ error: '分享链接已过期' }, { status: 410 })
    }

    // ---- AI 对话分享 ----
    if (share.kind === 'conversation') {
      const conv = await db.conversation.findUnique({ where: { id: share.refId } })
      if (!conv) {
        return NextResponse.json({ error: '分享不存在或已取消' }, { status: 404 })
      }
      const messages = await db.chatMessage.findMany({
        where: { conversationId: conv.id },
        orderBy: { createdAt: 'asc' },
      })
      return NextResponse.json({
        conversation: {
          id: conv.id,
          title: conv.title,
          type: conv.type,
          createdAt: conv.createdAt.toISOString(),
        },
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
        share: {
          token: share.token,
          expiresAt: share.expiresAt ? share.expiresAt.toISOString() : null,
          createdAt: share.createdAt.toISOString(),
        },
      })
    }

    // ---- 试卷分享（refId 指向 source='shared' 的快照试卷，只读快照内容）----
    if (share.kind === 'paper') {
      const paper = await db.paper.findUnique({ where: { id: share.refId } })
      if (!paper) {
        return NextResponse.json({ error: '分享不存在或已取消' }, { status: 404 })
      }
      let items: unknown[] = []
      try {
        const parsed: unknown = JSON.parse(paper.items)
        if (Array.isArray(parsed)) items = parsed
      } catch {
        items = []
      }
      return NextResponse.json({
        paper: {
          title: paper.title,
          cardTitle: paper.cardTitle,
          count: items.length,
          items,
          createdAt: paper.createdAt.toISOString(),
        },
        share: {
          kind: 'paper',
          title: share.title || paper.title,
          token: share.token,
          expiresAt: share.expiresAt ? share.expiresAt.toISOString() : null,
          createdAt: share.createdAt.toISOString(),
        },
      })
    }

    const card = await db.card.findUnique({ where: { id: share.cardId } })
    if (!card) {
      return NextResponse.json({ error: '分享不存在或已取消' }, { status: 404 })
    }

    return NextResponse.json({
      card: {
        id: card.id,
        title: card.title,
        content: card.content,
        keywords: parseKeywords(card.keywords),
        createdAt: card.createdAt.toISOString(),
        updatedAt: card.updatedAt.toISOString(),
      },
      share: {
        token: share.token,
        expiresAt: share.expiresAt ? share.expiresAt.toISOString() : null,
        createdAt: share.createdAt.toISOString(),
      },
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[GET /api/share/:token] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
