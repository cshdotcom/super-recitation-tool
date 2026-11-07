// POST /api/cards/:id/restore -> restore a soft-deleted card (回收站恢复, deletedAt=null)
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { serializeCard } from '@/lib/card'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }
    const { id } = await params
    const card = await db.card.findUnique({ where: { id } })
    if (!card) {
      return NextResponse.json({ error: '卡片不存在' }, { status: 404 })
    }
    const restored = await db.card.update({
      where: { id },
      data: { deletedAt: null },
    })
    return NextResponse.json(serializeCard(restored))
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/cards/:id/restore] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
