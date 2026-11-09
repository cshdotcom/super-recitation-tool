// 待复习（due for review）—— SM-2 间隔复习驱动：
// GET  /api/review/due -> { cards: [{ id, title, lastAction, lastActionAt, daysSince, nextReviewAt }] }
//   规则：卡片 nextReviewAt <= now（到期待复习）或 nextReviewAt 为空（从未复习的新导入卡片）。
//   复习后 POST /api/review 会更新 nextReviewAt = now + interval，卡片自动离开待复习队列。
//   跳过提醒免打扰未到期（AppState review:snooze:<cardId>）的卡片。
//   按 nextReviewAt 升序（最该复习的在前），无 nextReviewAt 的（新卡）排最前。
// POST /api/review/due { cardIds, days } -> { ok: true }  N 天免打扰
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAccount } from '@/lib/auth'

export const runtime = 'nodejs'

const SCORE_ACTIONS = ['familiar', 'fuzzy', 'forget'] as const
const SNOOZE_PREFIX = 'review:snooze:'
const DAY_MS = 86400000

export async function GET() {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })

  try {
    const now = new Date()
    const [logs, cards, snoozes] = await Promise.all([
      db.reviewLog.findMany({ orderBy: { createdAt: 'asc' } }),
      db.card.findMany({
        where: { deletedAt: null },
        select: {
          id: true,
          title: true,
          nextReviewAt: true,
          lastReviewedAt: true,
          interval: true,
          createdAt: true, // fallback 显示用（lastAction 为空时取创建时间）
        },
      }),
      db.appState.findMany({ where: { key: { startsWith: SNOOZE_PREFIX } } }),
    ])

    // 最新一次评分动作（用于显示上次复习状态）
    const latestByCard = new Map<string, { action: string; at: Date }>()
    for (const l of logs) {
      if (!(SCORE_ACTIONS as readonly string[]).includes(l.action)) continue
      latestByCard.set(l.cardId, { action: l.action, at: l.createdAt })
    }

    // 免打扰到期时间
    const snoozeUntil = new Map<string, number>()
    for (const s of snoozes) {
      const t = new Date(s.value).getTime()
      if (!Number.isNaN(t)) snoozeUntil.set(s.key.slice(SNOOZE_PREFIX.length), t)
    }

    const due: {
      id: string
      title: string
      lastAction: string
      lastActionAt: string
      daysSince: number
      nextReviewAt: string | null
      isNew: boolean
    }[] = []

    const nowMs = now.getTime()
    for (const c of cards) {
      // 免打扰未到期 → 跳过
      const until = snoozeUntil.get(c.id)
      if (until !== undefined && until > nowMs) continue

      const last = latestByCard.get(c.id)
      // 待复习条件：nextReviewAt 为空（从未复习的新卡）或 nextReviewAt <= now（到期）
      const nr = c.nextReviewAt
      const isDue = nr === null || nr.getTime() <= nowMs
      if (!isDue) continue

      // 防御：fallback 时间全部可选链 + 兜底 now，绝不再因缺字段崩溃
      const createdAtMs = c.createdAt ? new Date(c.createdAt).getTime() : nowMs
      const lastActionAtIso =
        last?.at?.toISOString?.() ??
        (c.lastReviewedAt ? new Date(c.lastReviewedAt).toISOString() : new Date(createdAtMs).toISOString())
      const daysSince = last
        ? Math.max(0, Math.floor((nowMs - (last.at?.getTime?.() ?? nowMs)) / DAY_MS))
        : Math.max(0, Math.floor((nowMs - createdAtMs) / DAY_MS))

      due.push({
        id: c.id,
        title: c.title,
        lastAction: last?.action ?? 'none',
        lastActionAt: lastActionAtIso,
        daysSince,
        nextReviewAt: nr ? nr.toISOString() : null,
        isNew: nr === null,
      })
    }

    // 排序：新卡（无 nextReviewAt）排最前，其次按 nextReviewAt 升序（最该复习的在前）
    due.sort((a, b) => {
      if (a.isNew && !b.isNew) return -1
      if (!a.isNew && b.isNew) return 1
      if (a.nextReviewAt && b.nextReviewAt) return a.nextReviewAt.localeCompare(b.nextReviewAt)
      return 0
    })

    return NextResponse.json({ cards: due })
  } catch (err) {
    console.error('[GET /api/review/due] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '加载失败' },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })

  try {
    const body = await req.json()
    const rawIds: unknown[] = Array.isArray(body?.cardIds) ? body.cardIds : []
    const cardIds = rawIds.map((id) => String(id)).filter(Boolean).slice(0, 500)
    if (cardIds.length === 0) {
      return NextResponse.json({ error: '缺少 cardIds' }, { status: 400 })
    }
    // 提醒天数限制在 1-3650 天
    const days = Math.min(3650, Math.max(1, Math.round(Number(body?.days) || 0)))
    const until = new Date(Date.now() + days * DAY_MS).toISOString()

    await Promise.all(
      cardIds.map((cardId) =>
        db.appState.upsert({
          where: { key: `${SNOOZE_PREFIX}${cardId}` },
          update: { value: until },
          create: { key: `${SNOOZE_PREFIX}${cardId}`, value: until },
        }),
      ),
    )

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[POST /api/review/due] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '保存失败' },
      { status: 500 },
    )
  }
}
