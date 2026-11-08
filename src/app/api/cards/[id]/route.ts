// Single-card endpoints (require login).
// GET    /api/cards/:id          -> fetch one card
// PATCH  /api/cards/:id          -> partial update (title/content/keywords/strokes/plan/mindmaps/blocks)
// DELETE /api/cards/:id          -> soft delete (moves the card to the recycle bin, deletedAt=now)
// DELETE /api/cards/:id?hard=1   -> permanent delete (recycle bin 彻底删除)
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { normalizeStrokeInput, serializeCard } from '@/lib/card'
import { normKeywordEntries } from '@/lib/cloze'
import type { Stroke } from '@/lib/types'

export async function GET(
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
    return NextResponse.json(serializeCard(card))
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[GET /api/cards/:id] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const data: Record<string, string | number | boolean> = {}
    if (typeof body?.title === 'string' && body.title.trim()) {
      data.title = body.title.trim()
    }
    if (typeof body?.content === 'string' && body.content.trim()) {
      data.content = body.content
    }
    if (Array.isArray(body?.keywords)) {
      // 位置感知挖空：string（全量）+ {t, occ}（单次出现）都合法
      data.keywords = JSON.stringify(normKeywordEntries(body.keywords))
    }
    // 涂鸦 strokes: accepts both formats — legacy [[x,y],...] point arrays and
    // styled { pts:[[x,y],...], color, width, tool } doodle strokes. Points are
    // normalized 0..1; object widths are clamped to 1..60. Persisted to DB.
    if (Array.isArray(body?.strokes)) {
      const validStrokes = body.strokes
        .map((s: unknown): Stroke | null => normalizeStrokeInput(s))
        .filter((s): s is Stroke => s !== null)
      data.strokes = JSON.stringify(validStrokes)
    }
    // 背书计划 plan: { goal, dailyNew?, reviewTimes? } | null
    if (body?.plan !== undefined) {
      if (body.plan === null) {
        data.plan = ''
      } else if (
        typeof body.plan === 'object' &&
        typeof body.plan.goal === 'number' &&
        Number.isFinite(body.plan.goal)
      ) {
        const planObj: Record<string, number> = {
          goal: Math.min(200, Math.max(1, Math.round(body.plan.goal))),
        }
        if (typeof body.plan.dailyNew === 'number' && Number.isFinite(body.plan.dailyNew)) {
          planObj.dailyNew = Math.min(50, Math.max(1, Math.round(body.plan.dailyNew)))
        }
        if (typeof body.plan.reviewTimes === 'number' && Number.isFinite(body.plan.reviewTimes)) {
          planObj.reviewTimes = Math.min(20, Math.max(1, Math.round(body.plan.reviewTimes)))
        }
        data.plan = JSON.stringify(planObj)
      }
    }
    // 思维导图 mindmaps: array of MindmapDoc objects (persisted JSON)
    if (Array.isArray(body?.mindmaps)) {
      const docs = body.mindmaps.filter(
        (m: unknown) => m && typeof m === 'object'
      )
      data.mindmaps = JSON.stringify(docs.slice(0, 50))
    }
    // 文字编辑工具 Q&A blocks: [{ front, back, hidden? }] (persisted JSON string).
    // Sanitized: max 200 blocks, front/back strings capped at 500000 chars
    // (allows embedded base64 images ~375KB each), hidden stored only when true.
    if (Array.isArray(body?.blocks)) {
      const list = (body.blocks as unknown[]).slice(0, 200)
      const blocks = list.map((raw) => {
        const b = (raw && typeof raw === 'object' ? raw : {}) as {
          front?: unknown
          back?: unknown
          hidden?: unknown
        }
        return {
          front: typeof b.front === 'string' ? b.front.slice(0, 500000) : '',
          back: typeof b.back === 'string' ? b.back.slice(0, 500000) : '',
          ...(b.hidden === true ? { hidden: true } : {}),
        }
      })
      data.blocks = JSON.stringify(blocks)
    }
    // 项目分类 / 置顶 / 自定义排序
    if (typeof body?.categoryId === 'string') {
      data.categoryId = body.categoryId
    }
    if (typeof body?.pinned === 'boolean') {
      data.pinned = body.pinned
    }
    if (typeof body?.ord === 'number' && Number.isFinite(body.ord)) {
      data.ord = Math.round(body.ord)
    }

    const updated = await db.card.update({
      where: { id },
      data,
    })
    return NextResponse.json(serializeCard(updated))
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[PATCH /api/cards/:id] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }
    const { id } = await params
    const card = await db.card.findUnique({ where: { id }, select: { id: true } })
    if (!card) {
      return NextResponse.json({ error: '卡片不存在' }, { status: 404 })
    }
    // ?hard=1 -> 彻底删除；默认软删除（进入回收站，30 天后自动清除）
    const hard = req.nextUrl.searchParams.get('hard') === '1'
    if (hard) {
      await db.card.delete({ where: { id } })
    } else {
      await db.card.update({ where: { id }, data: { deletedAt: new Date() } })
    }
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[DELETE /api/cards/:id] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
