// 待复习（due for review）：
// GET  /api/review/due -> { cards: [{ id, title, lastAction, lastActionAt, daysSince }] }
//   规则：取每张卡最近一次打分动作（familiar/fuzzy/forget）作为「上次复习」；
//   有动作即视为待复习；跳过提醒免打扰未到期（AppState review:snooze:<cardId>）的卡片。
//   按上次复习时间升序（最久未复习在前）。
// POST /api/review/due { cardIds: string[], days: number } -> { ok: true }
//   为卡片设置 N 天提醒免打扰（AppState key: review:snooze:<cardId>，value: 到期 ISO 时间）。
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
    // Single-user app: datasets are small, aggregate in memory.
    const [logs, cards, snoozes] = await Promise.all([
      db.reviewLog.findMany({ orderBy: { createdAt: 'asc' } }),
      db.card.findMany({
        where: { deletedAt: null },
        select: { id: true, title: true },
      }),
      db.appState.findMany({ where: { key: { startsWith: SNOOZE_PREFIX } } }),
    ])

    // Latest score action per card (logs are asc → last write wins).
    const latestByCard = new Map<string, { action: string; at: Date }>()
    for (const l of logs) {
      if (!(SCORE_ACTIONS as readonly string[]).includes(l.action)) continue
      latestByCard.set(l.cardId, { action: l.action, at: l.createdAt })
    }

    // 提醒免打扰：cardId -> snoozeUntil (ms)
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
    }[] = []

    for (const c of cards) {
      const last = latestByCard.get(c.id)
      if (!last) continue
      const until = snoozeUntil.get(c.id)
      if (until !== undefined && until > now.getTime()) continue
      due.push({
        id: c.id,
        title: c.title,
        lastAction: last.action,
        lastActionAt: last.at.toISOString(),
        daysSince: Math.max(0, Math.floor((now.getTime() - last.at.getTime()) / DAY_MS)),
      })
    }

    // 最久未复习的排前面
    due.sort((a, b) => a.lastActionAt.localeCompare(b.lastActionAt))

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
