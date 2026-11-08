// Project (分类文件夹) collection endpoints (require login).
// GET    /api/projects          -> list projects ordered by `ord`
// POST   /api/projects          -> create { name }
// PATCH  /api/projects          -> batch reorder { order: [id, id, ...] }
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'

export async function GET() {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
    const projects = await db.project.findMany({ orderBy: { ord: 'asc' } })
    return NextResponse.json({ projects })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[GET /api/projects] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
    const body = await req.json().catch(() => ({}))
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!name) return NextResponse.json({ error: '项目名称不能为空' }, { status: 400 })
    if (name.length > 30) return NextResponse.json({ error: '项目名称过长' }, { status: 400 })
    const max = await db.project.aggregate({ _max: { ord: true } })
    const project = await db.project.create({
      data: { name, ord: (max._max.ord ?? 0) + 1 },
    })
    return NextResponse.json(project, { status: 201 })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/projects] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })
    const body = await req.json().catch(() => ({}))
    if (Array.isArray(body?.order)) {
      const ids = body.order.filter((x: unknown): x is string => typeof x === 'string')
      await db.$transaction(
        ids.map((id: string, i: number) =>
          db.project.update({ where: { id }, data: { ord: i + 1 } }),
        ),
      )
      const projects = await db.project.findMany({ orderBy: { ord: 'asc' } })
      return NextResponse.json({ projects })
    }
    return NextResponse.json({ error: '未知操作' }, { status: 400 })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[PATCH /api/projects] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
