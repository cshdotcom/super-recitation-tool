// Review logs (熟悉/模糊/忘记) + aggregated statistics.
// POST /api/review  { cardId, cardTitle, action, durationSec, scheme?, tzOffset? }
//   scheme  : sm2(默认，SM-2 艾宾浩斯) | fixed(固定间隔 1/2/4/7/15/30) | simple(会/不会)
//   tzOffset: 客户端时区偏移（分钟，Date#getTimezoneOffset()），
//             下次复习时间锚定到客户端「当日零点 + interval 天」避免时区漂移
// GET  /api/review?tzOffset=-480 -> ReviewStats (server-side aggregation)
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAccount } from '@/lib/auth'
import { isReviewScheme, scheduleReview } from '@/lib/card'
import type { Mastery, ReviewAction, ReviewStats } from '@/lib/types'

const SCORE_ACTIONS = ['familiar', 'fuzzy', 'forget'] as const

/** Day key 'YYYY-MM-DD' in the client's local calendar.
 *  tzOffsetMin = Date#getTimezoneOffset()（UTC+8 为 -480），
 *  当地墙上时间 = UTC - tzOffsetMin（UTC+8 加 8 小时）。
 *  修正说明：原实现是 `+ tzOffsetMin`，方向反了 —— 东八区用户在北京时间
 *  0:00-8:00 的复习会被记到前一天；`- tzOffsetMin` 才是正确的本地日。 */
function dayKey(d: Date, tzOffsetMin: number): string {
  return new Date(d.getTime() - tzOffsetMin * 60000).toISOString().slice(0, 10)
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

    // ---- 间隔复习调度（三种可选方案，纯函数见 src/lib/card.ts） ----
    // 根据本次评分(familiar/fuzzy/forget) + 复习方案 + 卡片当前 ease/interval
    // 计算下次复习时间，并更新 Card 的复习字段。这样复习过的卡片不会立即
    // 再次出现在待复习队列。
    //   sm2    — SM-2 艾宾浩斯（默认）：EF' = EF + (0.1-(5-q)*(0.08+(5-q)*0.02))，
    //             夹 [1.3, 2.5]；忘记重置 repetitions=0、间隔 1 天；
    //             成功序列 1 → 3 → round(上次间隔 × EF')（熟悉封顶 30 / 模糊封顶 7）
    //   fixed  — 固定间隔：1/2/4/7/15/30 天序列，记得前进一格，忘记回到 1 天
    //   simple — 简单模式：会=间隔翻倍（首评 1 天，封顶 365），不会=重置 1 天
    const scheme = isReviewScheme(body?.scheme) ? body.scheme : 'sm2'
    const tzOffset = Math.min(840, Math.max(-840, Math.round(Number(body?.tzOffset) || 0)))

    const card = await db.card.findUnique({
      where: { id: cardId },
      select: { ease: true, interval: true, reviewCount: true },
    })
    const scheduled = scheduleReview({
      action: action as ReviewAction,
      scheme,
      ease: card?.ease ?? 2.5,
      interval: card?.interval ?? 0,
      reviewCount: card?.reviewCount ?? 0,
      now: new Date(),
      tzOffsetMin: tzOffset,
    })

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
          ease: scheduled.ease,
          interval: scheduled.interval,
          reviewCount: scheduled.reviewCount,
          lastReviewedAt: new Date(),
          nextReviewAt: scheduled.nextReviewAt,
        },
      }),
    ])
    return NextResponse.json({
      id: log.id,
      nextReviewAt: scheduled.nextReviewAt,
      interval: scheduled.interval,
      scheme,
    })
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
