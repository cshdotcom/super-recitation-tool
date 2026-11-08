// PUBLIC share-view endpoint (no auth).
// GET /api/share/:token -> { card, share } | 404 { error } | 410 { error }
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

function parseKeywords(json: string): string[] {
  try {
    const parsed = JSON.parse(json || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((k: unknown): k is string => typeof k === 'string')
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
