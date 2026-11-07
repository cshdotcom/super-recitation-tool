// Review plan template endpoints (require login).
// GET    /api/plans        -> list all plans (built-in first, then oldest custom); seeds the built-in 标准艾宾浩斯 when the table is empty
// POST   /api/plans        -> create a custom plan { name, days }
// PATCH  /api/plans        -> update a custom plan { id, name?, days? } (built-in plans are rejected)
// DELETE /api/plans?id=    -> delete a custom plan (built-in plans are rejected)
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import type { ReviewPlanData } from '@/lib/types'

export const runtime = 'nodejs'

// Built-in Ebbinghaus schedule seeded on first GET.
const BUILTIN_NAME = '标准艾宾浩斯'
const BUILTIN_DAYS = [0, 1, 2, 4, 7, 15]

// Prisma row shape (days is a JSON string).
interface PlanRow {
  id: string
  name: string
  days: string
  builtIn: boolean
  createdAt: Date
  updatedAt: Date
}

// Parse the stored days JSON, keeping only finite numbers.
function parseDays(raw: string): number[] {
  try {
    const parsed: unknown = JSON.parse(raw || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((d): d is number => typeof d === 'number' && Number.isFinite(d))
  } catch {
    return []
  }
}

function serializePlan(p: PlanRow): ReviewPlanData {
  return {
    id: p.id,
    name: p.name,
    days: parseDays(p.days),
    builtIn: p.builtIn,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }
}

// ---------- input validation ----------

type Valid<T> = { ok: true; value: T }
type Invalid = { ok: false; error: string }

/** name: non-empty trimmed string, ≤ 30 chars. */
function validateName(raw: unknown): Valid<string> | Invalid {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: '名称不能为空' }
  }
  const name = raw.trim()
  if (name.length > 30) {
    return { ok: false, error: '名称不能超过30个字符' }
  }
  return { ok: true, value: name }
}

/** days: array of 1-12 integers within 0-365, deduped, ascending. */
function validateDays(raw: unknown): Valid<number[]> | Invalid {
  if (!Array.isArray(raw)) {
    return { ok: false, error: '复习时间安排不能为空' }
  }
  const ints = raw.filter(
    (d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 365,
  )
  if (ints.length !== raw.length) {
    return { ok: false, error: '复习天数需为0-365的整数' }
  }
  const days = Array.from(new Set(ints)).sort((a, b) => a - b)
  if (days.length < 1 || days.length > 12) {
    return { ok: false, error: '复习次数需为1-12次' }
  }
  return { ok: true, value: days }
}

// ---------- handlers ----------

export async function GET() {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    // Seed the built-in Ebbinghaus plan when the table is empty.
    const count = await db.reviewPlan.count()
    if (count === 0) {
      await db.reviewPlan.create({
        data: { name: BUILTIN_NAME, days: JSON.stringify(BUILTIN_DAYS), builtIn: true },
      })
    }

    const rows = await db.reviewPlan.findMany({
      orderBy: [{ builtIn: 'desc' }, { createdAt: 'asc' }],
    })
    return NextResponse.json({ plans: rows.map(serializePlan) })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[GET /api/plans] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }
    const body = await req.json().catch(() => ({}))

    const name = validateName(body?.name)
    if (!name.ok) {
      return NextResponse.json({ error: name.error }, { status: 400 })
    }
    const days = validateDays(body?.days)
    if (!days.ok) {
      return NextResponse.json({ error: days.error }, { status: 400 })
    }

    const row = await db.reviewPlan.create({
      data: { name: name.value, days: JSON.stringify(days.value), builtIn: false },
    })
    return NextResponse.json(serializePlan(row), { status: 201 })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/plans] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }
    const body = await req.json().catch(() => ({}))
    const id: string = typeof body?.id === 'string' ? body.id : ''
    if (!id) {
      return NextResponse.json({ error: '缺少计划ID' }, { status: 400 })
    }

    const existing = await db.reviewPlan.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: '计划不存在' }, { status: 404 })
    }
    if (existing.builtIn) {
      return NextResponse.json({ error: '内置计划不可修改' }, { status: 400 })
    }

    const data: { name?: string; days?: string } = {}
    if (body?.name !== undefined) {
      const name = validateName(body.name)
      if (!name.ok) {
        return NextResponse.json({ error: name.error }, { status: 400 })
      }
      data.name = name.value
    }
    if (body?.days !== undefined) {
      const days = validateDays(body.days)
      if (!days.ok) {
        return NextResponse.json({ error: days.error }, { status: 400 })
      }
      data.days = JSON.stringify(days.value)
    }
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: '未提供修改内容' }, { status: 400 })
    }

    const row = await db.reviewPlan.update({ where: { id }, data })
    return NextResponse.json(serializePlan(row))
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[PATCH /api/plans] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }
    const id = req.nextUrl.searchParams.get('id') || ''
    if (!id) {
      return NextResponse.json({ error: '缺少计划ID' }, { status: 400 })
    }

    const existing = await db.reviewPlan.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: '计划不存在' }, { status: 404 })
    }
    if (existing.builtIn) {
      return NextResponse.json({ error: '内置计划不可删除' }, { status: 400 })
    }

    await db.reviewPlan.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[DELETE /api/plans] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
