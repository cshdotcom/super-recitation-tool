// Focus content CRUD (require login).
// GET    /api/focus?tzOffset=-480 -> all FocusContent (ord asc, createdAt desc)
//                                  each with todaySeconds / totalSeconds / focusCount
// POST   /api/focus  { name, minutes, bg }
// PATCH  /api/focus  { id, name?, minutes?, bg?, ord? }
// DELETE /api/focus  { id }         -> delete content + its logs
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import type { FocusContentData } from '@/lib/types'

const MAX_BG_LENGTH = 400000
const NAME_MAX = 30

/** Day key 'YYYY-MM-DD' for a date shifted by the client's timezone offset
 *  (same pattern as /api/review). */
function dayKey(d: Date, tzOffsetMin: number): string {
  return new Date(d.getTime() + tzOffsetMin * 60000).toISOString().slice(0, 10)
}

type FocusRow = {
  id: string
  name: string
  minutes: number
  bg: string
  ord: number
  createdAt: Date
  updatedAt: Date
}

function serialize(
  row: FocusRow,
  agg: { todaySeconds: number; totalSeconds: number; focusCount: number },
): FocusContentData {
  return {
    id: row.id,
    name: row.name,
    minutes: row.minutes,
    bg: row.bg,
    ord: row.ord,
    todaySeconds: agg.todaySeconds,
    totalSeconds: agg.totalSeconds,
    focusCount: agg.focusCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Clamp/validate `minutes` (int 1-240, default 25). */
function parseMinutes(v: unknown, fallback = 25): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(240, Math.max(1, n))
}

/** Validate `bg` (string ≤ 400000 chars, default ''). */
function parseBg(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v.slice(0, MAX_BG_LENGTH)
}

/** Validate `name` (non-empty after trim, ≤ 30 chars). */
function parseName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const name = v.trim().slice(0, NAME_MAX)
  return name || null
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.json({ error: '未登录' }, { status: 401 })
  }
  try {
    const tzOffset = Math.min(
      840,
      Math.max(-840, Number(req.nextUrl.searchParams.get('tzOffset')) || 0),
    )

    // Single-user app: datasets are small, aggregate in memory.
    const [contents, logs] = await Promise.all([
      db.focusContent.findMany({ orderBy: [{ ord: 'asc' }, { createdAt: 'desc' }] }),
      db.focusLog.findMany({ orderBy: { createdAt: 'asc' } }),
    ])

    const today = dayKey(new Date(), tzOffset)
    const agg = new Map<string, { todaySeconds: number; totalSeconds: number; focusCount: number }>()
    for (const c of contents) {
      agg.set(c.id, { todaySeconds: 0, totalSeconds: 0, focusCount: 0 })
    }
    // 自由专注（无 contentId）不计入内容卡片聚合，但计入全局 totals
    const totals = { todaySeconds: 0, totalSeconds: 0, focusCount: 0 }
    for (const l of logs) {
      totals.totalSeconds += l.seconds
      totals.focusCount += 1
      if (dayKey(l.createdAt, tzOffset) === today) totals.todaySeconds += l.seconds
      if (!l.contentId) continue
      const a = agg.get(l.contentId)
      if (!a) continue
      a.totalSeconds += l.seconds
      a.focusCount += 1
      if (dayKey(l.createdAt, tzOffset) === today) a.todaySeconds += l.seconds
    }

    return NextResponse.json({
      contents: contents.map((c) =>
        serialize(c, agg.get(c.id) ?? { todaySeconds: 0, totalSeconds: 0, focusCount: 0 }),
      ),
      totals,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[GET /api/focus] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.json({ error: '未登录' }, { status: 401 })
  }
  try {
    const body = await req.json().catch(() => ({}))
    const name = parseName(body?.name)
    if (!name) {
      return NextResponse.json({ error: '名称不能为空' }, { status: 400 })
    }
    const minutes = parseMinutes(body?.minutes)
    const bg = parseBg(body?.bg)

    // ord = (max ord) + 1
    const top = await db.focusContent.findFirst({ orderBy: { ord: 'desc' }, select: { ord: true } })
    const row = await db.focusContent.create({
      data: { name, minutes, bg, ord: (top?.ord ?? 0) + 1 },
    })
    return NextResponse.json(serialize(row, { todaySeconds: 0, totalSeconds: 0, focusCount: 0 }), {
      status: 201,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/focus] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.json({ error: '未登录' }, { status: 401 })
  }
  try {
    const body = await req.json().catch(() => ({}))
    const id = String(body?.id || '')
    if (!id) {
      return NextResponse.json({ error: '缺少 id' }, { status: 400 })
    }
    const existing = await db.focusContent.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: '专注内容不存在' }, { status: 404 })
    }

    const data: { name?: string; minutes?: number; bg?: string; ord?: number } = {}
    if (body?.name !== undefined) {
      const name = parseName(body.name)
      if (!name) return NextResponse.json({ error: '名称不能为空' }, { status: 400 })
      data.name = name
    }
    if (body?.minutes !== undefined) data.minutes = parseMinutes(body.minutes, existing.minutes)
    if (body?.bg !== undefined) data.bg = parseBg(body.bg)
    if (body?.ord !== undefined) {
      const n = Math.round(Number(body.ord))
      if (Number.isFinite(n)) data.ord = Math.max(0, n)
    }

    const row = await db.focusContent.update({ where: { id }, data })

    // Recompute aggregates for the updated row only.
    const logs = await db.focusLog.findMany({ where: { contentId: id }, orderBy: { createdAt: 'asc' } })
    const tzOffset = Math.min(
      840,
      Math.max(-840, Number(req.nextUrl.searchParams.get('tzOffset')) || 0),
    )
    const today = dayKey(new Date(), tzOffset)
    let todaySeconds = 0
    let totalSeconds = 0
    for (const l of logs) {
      totalSeconds += l.seconds
      if (dayKey(l.createdAt, tzOffset) === today) todaySeconds += l.seconds
    }
    return NextResponse.json(serialize(row, { todaySeconds, totalSeconds, focusCount: logs.length }))
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[PATCH /api/focus] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.json({ error: '未登录' }, { status: 401 })
  }
  try {
    const body = await req.json().catch(() => ({}))
    const id = String(body?.id || '')
    if (!id) {
      return NextResponse.json({ error: '缺少 id' }, { status: 400 })
    }
    await db.focusLog.deleteMany({ where: { contentId: id } })
    await db.focusContent.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[DELETE /api/focus] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
