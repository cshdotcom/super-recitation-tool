// Review plan template endpoints (require login).
// GET    /api/plans              -> list all plans (built-in first, then oldest custom); seeds the built-in 标准艾宾浩斯 when the table is empty
// GET    /api/plans?assignments=1 -> { assignments: Record<cardId, planId> } 仅返回绑定了 activePlanId 的卡片
// POST   /api/plans              -> create a custom plan { name, days }
// PATCH  /api/plans              -> update a custom plan { id, name?, days? } (built-in plans are rejected)
// PATCH  /api/plans { action: 'assign', id, cardIds } -> 把计划应用到所选卡片（设置 activePlanId）
// PATCH  /api/plans { action: 'clear', cardIds }      -> 清除所选卡片的 activePlanId（回到 FSRS 调度）
// DELETE /api/plans?id=          -> delete a custom plan (built-in plans are rejected)
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

/** 校验 cardIds 入参：string[]，去重，最多 2000 个。 */
function validateCardIds(raw: unknown): Valid<string[]> | Invalid {
  if (!Array.isArray(raw)) return { ok: false, error: 'cardIds 必须为数组' }
  const ids = raw
    .map((id) => (typeof id === 'string' ? id : ''))
    .filter(Boolean)
  if (ids.length === 0) return { ok: false, error: '请至少选择一张卡片' }
  const unique = Array.from(new Set(ids)).slice(0, 2000)
  return { ok: true, value: unique }
}

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    // 分支：?assignments=1 返回卡片→计划绑定映射（仅含已绑定 activePlanId 的卡片）。
    if (req.nextUrl.searchParams.get('assignments') === '1') {
      const rows = await db.card.findMany({
        where: { activePlanId: { not: null } },
        select: { id: true, activePlanId: true },
      })
      const assignments: Record<string, string> = {}
      for (const c of rows) {
        if (c.activePlanId) assignments[c.id] = c.activePlanId
      }
      return NextResponse.json({ assignments })
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

    // ---- 动作分支：assign / clear（应用到卡片 / 从卡片移除）----
    // assign：把计划绑定到所选卡片（activePlanId = planId），下次评分时由计划驱动调度。
    // clear ：清除所选卡片的 activePlanId（回到 FSRS 调度）。
    if (body?.action === 'assign' || body?.action === 'clear') {
      const cardIdsRes = validateCardIds(body?.cardIds)
      if (!cardIdsRes.ok) {
        return NextResponse.json({ error: cardIdsRes.error }, { status: 400 })
      }
      const cardIds = cardIdsRes.value

      if (body.action === 'assign') {
        const planId = typeof body?.id === 'string' ? body.id : ''
        if (!planId) {
          return NextResponse.json({ error: '缺少计划ID' }, { status: 400 })
        }
        const plan = await db.reviewPlan.findUnique({ where: { id: planId } })
        if (!plan) {
          return NextResponse.json({ error: '计划不存在' }, { status: 404 })
        }
        await db.card.updateMany({
          where: { id: { in: cardIds } },
          data: { activePlanId: planId },
        })
        return NextResponse.json({ ok: true, assigned: cardIds.length, planId })
      }

      // clear
      await db.card.updateMany({
        where: { id: { in: cardIds } },
        data: { activePlanId: null },
      })
      return NextResponse.json({ ok: true, cleared: cardIds.length })
    }

    // ---- 常规更新：name / days ----
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
