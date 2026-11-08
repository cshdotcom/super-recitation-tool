// Review logs (熟悉/模糊/忘记) + aggregated statistics.
// POST /api/review  { cardId, cardTitle, action, durationSec }
// GET  /api/review?tzOffset=-480 -> ReviewStats (server-side aggregation)
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAccount } from '@/lib/auth'
import type { Mastery, ReviewStats } from '@/lib/types'

const SCORE_ACTIONS = ['familiar', 'fuzzy', 'forget'] as const

/** Day key 'YYYY-MM-DD' for a date shifted by the client's timezone offset. */
function dayKey(d: Date, tzOffsetMin: number): string {
  return new Date(d.getTime() + tzOffsetMin * 60000).toISOString().slice(0, 10)
}

export async function POST(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })

  try {
    const body = await req.json()
    const action = String(body?.action || '')
    if (!SCORE_ACTIONS.includes(action as (typeof SCORE_ACTIONS)[number])) {
      return NextResponse.json({ error: '无效的复习动作' }, { status: 400 })
    }
    const cardId = String(body?.cardId || '')
    if (!cardId) return NextResponse.json({ error: '缺少 cardId' }, { status: 400 })
    const duration = Math.min(3600, Math.max(0, Math.round(Number(body?.durationSec) || 0)))

    const log = await db.reviewLog.create({
      data: {
        cardId,
        cardTitle: String(body?.cardTitle || '').slice(0, 120),
        action,
        durationSec: duration,
      },
    })
    return NextResponse.json({ id: log.id })
  } catch (err) {
    console.error('[POST /api/review] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '保存失败' },
      { status: 500 },
    )
  }
}

export async function GET(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })

  try {
    const sp = req.nextUrl.searchParams
    const tzOffset = Math.min(840, Math.max(-840, Number(sp.get('tzOffset')) || 0))

    // Single-user app: datasets are small, aggregate in memory.
    const [logs, cards] = await Promise.all([
      db.reviewLog.findMany({ orderBy: { createdAt: 'asc' } }),
      db.card.findMany({ select: { id: true } }),
    ])

    const now = new Date()
    const today = dayKey(now, tzOffset)
    const yesterday = dayKey(new Date(now.getTime() - 86400000), tzOffset)

    const scoreLogs = logs.filter((l) =>
      (SCORE_ACTIONS as readonly string[]).includes(l.action),
    )

    const calendar: Record<string, number> = {}
    let todayCount = 0
    let todaySeconds = 0
    for (const l of scoreLogs) {
      const key = dayKey(l.createdAt, tzOffset)
      calendar[key] = (calendar[key] || 0) + 1
      if (key === today) {
        todayCount += 1
        todaySeconds += l.durationSec
      }
    }

    // Consecutive review days ending today (or yesterday if today has none).
    let streakDays = 0
    let cursor = calendar[today] ? today : yesterday
    while (calendar[cursor]) {
      streakDays += 1
      const prev = new Date(cursor + 'T00:00:00Z')
      prev.setUTCDate(prev.getUTCDate() - 1)
      cursor = prev.toISOString().slice(0, 10)
    }

    // Mastery per card = its latest score action.
    const latestByCard = new Map<string, string>()
    for (const l of scoreLogs) {
      latestByCard.set(l.cardId, l.action)
    }
    const mastery: Record<Mastery, number> = { familiar: 0, fuzzy: 0, forget: 0, none: 0 }
    for (const c of cards) {
      const a = latestByCard.get(c.id)
      if (a === 'familiar' || a === 'fuzzy' || a === 'forget') mastery[a] += 1
      else mastery.none += 1
    }

    const stats: ReviewStats = {
      todayCount,
      streakDays,
      todaySeconds,
      mastery,
      calendar,
    }

    // Per-card mastery map (复习总览 status per card).
    if (sp.get('perCard')) {
      const statuses: Record<string, string> = {}
      for (const c of cards) {
        const a = latestByCard.get(c.id)
        statuses[c.id] = a === 'familiar' || a === 'fuzzy' || a === 'forget' ? a : 'none'
      }
      return NextResponse.json({ ...stats, statuses })
    }

    return NextResponse.json(stats)
  } catch (err) {
    console.error('[GET /api/review] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '加载失败' },
      { status: 500 },
    )
  }
}
