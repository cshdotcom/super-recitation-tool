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

    // ---- SM-2 间隔复习调度 ----
    // 根据本次评分(familiar/fuzzy/forget) + 卡片当前 ease/interval 计算下次复习时间，
    // 并更新 Card 的复习字段。这样复习过的卡片不会立即再次出现在待复习队列。
    const card = await db.card.findUnique({
      where: { id: cardId },
      select: { ease: true, interval: true, reviewCount: true },
    })
    let ease = card?.ease ?? 2.5
    let interval = card?.interval ?? 0
    const reps = (card?.reviewCount ?? 0) + 1

    // 评分映射到 SM-2 quality：熟悉=5(完美) 模糊=3(模糊) 忘记=1(忘记但认得)
    const q = action === 'familiar' ? 5 : action === 'fuzzy' ? 3 : 1
    // 更新 ease：ease += 0.1 - (5-q)*(0.08+(5-q)*0.02)，下限 1.3
    ease = Math.max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))
    // 计算新间隔
    if (q < 3) {
      // 忘记/模糊：重置间隔为 1 天（重新开始）
      interval = 1
    } else if (reps === 1) {
      interval = 1
    } else if (reps === 2) {
      interval = action === 'familiar' ? 3 : 2
    } else {
      // 后续：interval = round(interval * ease)，熟悉上限 30 天，模糊上限 7 天
      const nextInt = Math.round(interval * ease)
      interval = action === 'familiar' ? Math.min(30, nextInt) : Math.min(7, nextInt)
    }
    const nextReviewAt = new Date(Date.now() + interval * 86400000)

    // 并行：写日志 + 更新卡片复习调度
    const [log] = await Promise.all([
      db.reviewLog.create({
        data: {
          cardId,
          cardTitle: String(body?.cardTitle || '').slice(0, 120),
          action,
          durationSec: duration,
        },
      }),
      db.card.update({
        where: { id: cardId },
        data: {
          ease,
          interval,
          reviewCount: reps,
          lastReviewedAt: new Date(),
          nextReviewAt,
        },
      }),
    ])
    return NextResponse.json({ id: log.id, nextReviewAt, interval })
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
