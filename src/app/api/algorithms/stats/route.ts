// 算法统计仪表盘（v2.8.0+）
// GET /api/algorithms/stats -> 全局统计：状态分布 / 间隔直方图 / 回忆率趋势 /
//   复习热力图 / 7 天负载预测 / 高遗忘风险卡片列表
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAccount } from '@/lib/auth'
import {
  stateDistribution,
  intervalHistogram,
  recallRateTrend,
  reviewHeatmap,
  forecast,
} from '@/lib/spaced-repetition'
import { retrievability, elapsedDays } from '@/lib/spaced-repetition'
import { parseMemory } from '@/lib/spaced-repetition'

export async function GET(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const sp = req.nextUrl.searchParams
    const tzOffset = Math.min(840, Math.max(-840, Number(sp.get('tzOffset')) || 0))
    void tzOffset
    const now = new Date()
    const [cards, logs] = await Promise.all([
      db.card.findMany({
        where: { deletedAt: null },
        select: { id: true, title: true, srsState: true, nextReviewAt: true, ease: true },
      }),
      db.reviewLog.findMany({
        where: { action: { in: ['familiar', 'fuzzy', 'forget'] } },
        select: { createdAt: true, action: true, cardId: true },
        orderBy: { createdAt: 'asc' },
      }),
    ])

    const dist = stateDistribution(cards.map((c) => ({ srsState: c.srsState, nextReviewAt: c.nextReviewAt })))
    const hist = intervalHistogram(
      cards.map((c) => ({ srsState: c.srsState, nextReviewAt: c.nextReviewAt })),
      now,
    )
    const trend = recallRateTrend(logs, 30, now)
    const heat = reviewHeatmap(logs, 12, now)
    const fc = forecast(
      cards.map((c) => ({
        id: c.id,
        title: c.title,
        nextReviewAt: c.nextReviewAt,
        memory: parseMemory(c.srsState),
        interval: 0,
        lastReviewedAt: null,
      })),
      7,
      now,
    )

    // 高遗忘风险卡片（R < 0.7）
    const risk: { id: string; title: string; r: number; s: number; d: number; state: string }[] = []
    for (const c of cards) {
      const m = parseMemory(c.srsState)
      if (m.state === 'suspended' || m.state === 'new') continue
      const r = retrievability(m.s, elapsedDays(m, now))
      if (r < 0.7) risk.push({ id: c.id, title: c.title, r, s: m.s, d: m.d, state: m.state })
    }
    risk.sort((a, b) => a.r - b.r)

    // 今日复习量 + 答对率
    const todayKey = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
    const todayLogs = logs.filter((l) => {
      const k = new Date(l.createdAt.getTime() - l.createdAt.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
      return k === todayKey
    })
    const todayRight = todayLogs.filter((l) => l.action === 'familiar').length

    return NextResponse.json({
      dist,
      hist,
      trend,
      heat,
      forecast: fc,
      risk: risk.slice(0, 50),
      today: { total: todayLogs.length, right: todayRight },
      targetRetention: 0.9,
      cardsTotal: cards.length,
    })
  } catch (err) {
    console.error('[GET /api/algorithms/stats] failed:', err)
    return NextResponse.json({ error: '加载失败' }, { status: 500 })
  }
}
