// 撤销上一次复习（v2.8.0+）
// POST /api/review/undo { cardId } -> 恢复 srsState 到上次复习前，删除对应 ReviewLog，
//   重算 nextReviewAt（按恢复后的 S）。支持连续撤销（每次撤销一条）。
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAccount } from '@/lib/auth'
import {
  type CardMemory,
  defaultConfig,
  isValidAlgType,
  mergeConfig,
  parseMemory,
  resolveConfig,
  retrievability,
} from '@/lib/spaced-repetition'
import { nextReviewDate } from '@/lib/card'

function intervalFromRestoredS(s: number, desiredRetention: number, maxInterval: number, minInterval: number): number {
  const raw = 9 * s * (Math.pow(desiredRetention, -1) - 1)
  return Math.min(maxInterval, Math.max(minInterval, raw))
}

export async function POST(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const body = await req.json()
    const cardId = String(body?.cardId || '')
    if (!cardId) return NextResponse.json({ error: '缺少 cardId' }, { status: 400 })
    const tzOffset = Math.min(840, Math.max(-840, Math.round(Number(body?.tzOffset) || 0)))

    const card = await db.card.findUnique({
      where: { id: cardId },
      select: { id: true, srsState: true, algoType: true, algoConfig: true, ease: true },
    })
    if (!card) return NextResponse.json({ error: '卡片不存在' }, { status: 404 })

    const memory: CardMemory = parseMemory(card.srsState)
    if (memory.history.length === 0) {
      return NextResponse.json({ error: '没有可撤销的复习记录' }, { status: 400 })
    }

    // 找到最近一条评分 ReviewLog（与 history 末尾时间匹配）
    const lastLog = await db.reviewLog.findFirst({
      where: { cardId, action: { in: ['familiar', 'fuzzy', 'forget'] } },
      orderBy: { createdAt: 'desc' },
    })

    // 弹出 history 末尾，恢复到上一条状态（或空）
    const newHistory = memory.history.slice(0, -1)
    const restored: CardMemory = {
      ...memory,
      history: newHistory,
    }
    if (newHistory.length > 0) {
      const last = newHistory[newHistory.length - 1]
      restored.s = last.s
      restored.d = last.d
      restored.lastGrade = last.grade
      restored.lastReviewAt = last.at
      // 状态推断：若有遗忘历史则可能 relearn，否则 review
      restored.state = last.grade === 'again' ? 'relearn' : 'review'
      restored.reps = Math.max(0, restored.reps - 1)
    } else {
      // 回到新卡
      restored.s = 0
      restored.d = 5
      restored.reps = 0
      restored.lapses = 0
      restored.state = 'new'
      restored.lastGrade = null
      restored.lastReviewAt = null
      restored.step = 0
    }

    // 解析配置以算间隔
    const settings = await db.settings.findUnique({ where: { id: 'singleton' } })
    const globalAlg = isValidAlgType(settings?.globalAlgorithm) ? (settings.globalAlgorithm as 'fsrs' | 'sm2' | 'fixed' | 'simple' | 'custom') : 'fsrs'
    const globalCfg = mergeConfig(settings?.globalAlgConfig)
    const resolved = resolveConfig(globalAlg, globalCfg, card.algoType, card.algoConfig)
    const cfg = resolved.config

    const now = new Date()
    let nextReviewAt: Date | null
    let interval: number
    if (restored.state === 'new' || restored.s <= 0) {
      nextReviewAt = null
      interval = 0
    } else {
      interval = intervalFromRestoredS(restored.s, cfg.desiredRetention, cfg.maxInterval, cfg.minInterval)
      nextReviewAt = nextReviewDate(now, Math.max(interval, cfg.minInterval), tzOffset)
    }

    const ease = card.ease ?? 2.5

    await Promise.all([
      lastLog ? db.reviewLog.delete({ where: { id: lastLog.id } }) : Promise.resolve(null),
      db.card.update({
        where: { id: cardId },
        data: {
          srsState: JSON.stringify(restored),
          ease,
          interval: Math.max(0, Math.round(interval)),
          reviewCount: restored.reps,
          lastReviewedAt: restored.lastReviewAt ? new Date(restored.lastReviewAt) : null,
          nextReviewAt,
        },
      }),
    ])

    return NextResponse.json({
      ok: true,
      memory: restored,
      nextReviewAt: nextReviewAt ? nextReviewAt.toISOString() : null,
      interval,
      r: restored.s > 0 ? retrievability(restored.s, (now.getTime() - new Date(restored.lastReviewAt || now.toISOString()).getTime()) / 86400000) : 0,
    })
  } catch (err) {
    console.error('[POST /api/review/undo] failed:', err)
    return NextResponse.json({ error: '撤销失败' }, { status: 500 })
  }
}

void defaultConfig
