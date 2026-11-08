// Single project endpoints (require login).
// PATCH  /api/projects/:id  -> rename { name }
// DELETE /api/projects/:id  -> delete project; its cards move to 未分类 ("").
//                              Query ?moveTo=<projectId> moves cards to that
//                              project instead.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!name) return NextResponse.json({ error: '项目名称不能为空' }, { status: 400 })
    const project = await db.project.update({ where: { id }, data: { name } })
    return NextResponse.json(project)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[PATCH /api/projects/:id] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
    const { id } = await params
    const moveTo = req.nextUrl.searchParams.get('moveTo') ?? ''
    // 二次确认在前端完成；这里把项目里的卡片移动到目标分类（默认未分类）。
    await db.card.updateMany({ where: { categoryId: id }, data: { categoryId: moveTo } })
    await db.project.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[DELETE /api/projects/:id] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
