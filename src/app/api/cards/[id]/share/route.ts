// Per-card share-link management (requires auth; one share per card).
// GET    /api/cards/:id/share -> { share } | { share: null }
// POST   /api/cards/:id/share { expiresInDays: number | null } -> { share }
// DELETE /api/cards/:id/share -> { ok: true }
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'

const DAY_MS = 24 * 60 * 60 * 1000

function serializeShare(s: {
  token: string
  expiresAt: Date | null
  createdAt: Date
}) {
  return {
    token: s.token,
    expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const account = await getSessionUser()
    if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })

    const { id } = await params
    const share = await db.share.findFirst({
      where: { cardId: id },
      orderBy: { createdAt: 'desc' },
    })
    return NextResponse.json({ share: share ? serializeShare(share) : null })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[GET /api/cards/:id/share] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const account = await getSessionUser()
    if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })

    const { id } = await params
    const card = await db.card.findUnique({ where: { id } })
    if (!card) {
      return NextResponse.json({ error: '卡片不存在' }, { status: 404 })
    }

    const body = await req.json().catch(() => ({}))
    let expiresAt: Date | null = null
    if (body?.expiresInDays !== null && body?.expiresInDays !== undefined) {
      const days =
        typeof body.expiresInDays === 'number' && Number.isFinite(body.expiresInDays)
          ? Math.floor(body.expiresInDays)
          : NaN
      if (Number.isNaN(days) || days < 1 || days > 3650) {
        return NextResponse.json({ error: '有效期需为1-3650天' }, { status: 400 })
      }
      expiresAt = new Date(Date.now() + days * DAY_MS)
    }

    // One share per card: replace any existing share.
    await db.share.deleteMany({ where: { cardId: id } })
    const token = randomUUID().replace(/-/g, '') + Date.now().toString(36)
    const share = await db.share.create({
      data: { token, cardId: id, expiresAt },
    })
    return NextResponse.json({ share: serializeShare(share) })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/cards/:id/share] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const account = await getSessionUser()
    if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })

    const { id } = await params
    await db.share.deleteMany({ where: { cardId: id } })
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[DELETE /api/cards/:id/share] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
