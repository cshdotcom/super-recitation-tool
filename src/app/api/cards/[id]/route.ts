// Single-card endpoints.
// GET    /api/cards/:id   -> fetch one card
// PATCH  /api/cards/:id   -> partial update (title/content/keywords/strokes/plan)
// DELETE /api/cards/:id   -> remove
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { serializeCard } from '@/lib/card'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
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
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const data: Record<string, string> = {}
    if (typeof body?.title === 'string' && body.title.trim()) {
      data.title = body.title.trim()
    }
    if (typeof body?.content === 'string' && body.content.trim()) {
      data.content = body.content
    }
    if (Array.isArray(body?.keywords)) {
      data.keywords = JSON.stringify(
        body.keywords.filter((k: unknown): k is string => typeof k === 'string')
      )
    }
    // 涂鸦 strokes: array of stroke arrays (normalized 0..1 points), persisted to DB.
    if (Array.isArray(body?.strokes)) {
      const validStrokes = body.strokes.filter(
        (s: unknown) =>
          Array.isArray(s) &&
          s.every(
            (p: unknown) =>
              Array.isArray(p) &&
              p.length === 2 &&
              typeof p[0] === 'number' &&
              typeof p[1] === 'number',
          ),
      )
      data.strokes = JSON.stringify(validStrokes)
    }
    // 今日计划 plan: { goal: number } | null
    if (body?.plan !== undefined) {
      if (body.plan === null) {
        data.plan = ''
      } else if (
        typeof body.plan === 'object' &&
        typeof body.plan.goal === 'number' &&
        Number.isFinite(body.plan.goal)
      ) {
        data.plan = JSON.stringify({ goal: Math.min(200, Math.max(1, Math.round(body.plan.goal))) })
      }
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
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    await db.card.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[DELETE /api/cards/:id] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
