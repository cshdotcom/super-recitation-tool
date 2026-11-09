// Single-share delete (require login).
// DELETE /api/shares/:id -> { ok: true } | 404 { error }
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
    const { id } = await params
    if (!id) return NextResponse.json({ error: '缺少 id' }, { status: 400 })
    const res = await db.share.deleteMany({ where: { id } })
    if (res.count === 0) {
      return NextResponse.json({ error: '分享不存在或已删除' }, { status: 404 })
    }
    return NextResponse.json({ ok: true, deleted: res.count })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[DELETE /api/shares/:id] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
