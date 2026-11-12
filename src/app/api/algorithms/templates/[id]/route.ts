// 单个模板：更新 / 删除（内置不可删不可改 type）
// PATCH /api/algorithms/templates/[id] { name?, type?, config?, description? }
// DELETE /api/algorithms/templates/[id]
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAccount } from '@/lib/auth'
import { mergeConfig } from '@/lib/spaced-repetition'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const { id } = await params
    const row = await db.algorithmTemplate.findUnique({ where: { id } })
    if (!row) return NextResponse.json({ error: '模板不存在' }, { status: 404 })
    const body = await req.json()
    const data: Record<string, unknown> = {}
    if (typeof body?.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 40)
    if (typeof body?.type === 'string' && ['fsrs', 'sm2', 'fixed', 'simple', 'custom'].includes(body.type))
      data.type = body.type
    if (body?.config !== undefined) data.config = JSON.stringify(mergeConfig(body.config))
    if (typeof body?.description === 'string') data.description = body.description.slice(0, 200)
    const updated = await db.algorithmTemplate.update({ where: { id }, data })
    return NextResponse.json({ ok: true, id: updated.id })
  } catch (err) {
    console.error('[PATCH /api/algorithms/templates/[id]] failed:', err)
    return NextResponse.json({ error: '保存失败' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const { id } = await params
    const row = await db.algorithmTemplate.findUnique({ where: { id } })
    if (!row) return NextResponse.json({ error: '模板不存在' }, { status: 404 })
    if (row.builtIn) return NextResponse.json({ error: '内置模板不可删除' }, { status: 400 })
    await db.algorithmTemplate.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[DELETE /api/algorithms/templates/[id]] failed:', err)
    return NextResponse.json({ error: '删除失败' }, { status: 500 })
  }
}
