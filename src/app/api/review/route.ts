// Review logs (熟悉/模糊/忘记) + aggregated statistics.
// POST /api/review  { cardId, cardTitle, action?, grade?, durationSec, scheme?, tzOffset? }
//   grade  : again | hard | good | easy （v2.8.0+ FSRS 4 档；优先于 action）
//   action : familiar | fuzzy | forget （旧 3 档，自动映射 grade：familiar→good fuzzy→hard forget→again）
//   scheme : sm2 | fixed | simple （旧方案，映射为 algorithm；新流程由服务端按全局/单卡配置解析）
//   tzOffset: 客户端时区偏移（分钟，Date#getTimezoneOffset()），锚定当日零点 + interval 天
// GET  /api/review?tzOffset=-480 -> ReviewStats (server-side aggregation)
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAccount } from '@/lib/auth'
import { isReviewScheme, scheduleReview } from '@/lib/card'
import {
  type AlgorithmType,
  type CardMemory,
  type Grade,
  computeReview,
  defaultConfig,
  isValidAlgType,
  legacyActionToGrade,
  mergeConfig,
  parseMemory,
  resolveConfig,
  retrievability,
  elapsedDays,
} from '@/lib/spaced-repetition'
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
    const cardId = String(body?.cardId || '')
    if (!cardId) return NextResponse.json({ error: '缺少 cardId' }, { status: 400 })
    const duration = Math.min(3600, Math.max(0, Math.round(Number(body?.durationSec) || 0)))
    const tzOffset = Math.min(840, Math.max(-840, Math.round(Number(body?.tzOffset) || 0)))
    const now = new Date()

    // 解析评分：优先 grade（4 档），其次 action（旧 3 档映射）
    let grade: Grade | null = null
    if (
      body?.grade === 'again' ||
      body?.grade === 'hard' ||
      body?.grade === 'good' ||
      body?.grade === 'easy'
    ) {
      grade = body.grade
    } else if (SCORE_ACTIONS.includes(body?.action)) {
      grade = legacyActionToGrade(String(body.action))
    }
    if (!grade) return NextResponse.json({ error: '无效的评分' }, { status: 400 })

    // 解析生效算法与配置：全局默认 → 单卡覆盖
    const card = await db.card.findUnique({
      where: { id: cardId },
      select: { ease: true, interval: true, reviewCount: true, srsState: true, algoType: true, algoConfig: true },
    })
    if (!card) return NextResponse.json({ error: '卡片不存在' }, { status: 404 })

    const settings = await db.settings.findUnique({ where: { id: 'singleton' } })
    let algorithm: AlgorithmType = 'fsrs'
    let resolvedConfig = defaultConfig()
    // 客户端顶栏选择的 algorithm 优先（覆盖单卡/全局解析的算法类型，但参数仍取全局配置）
    const clientAlg = isValidAlgType(body?.algorithm) ? (body.algorithm as AlgorithmType) : null
    // 旧 scheme 参数兼容：若客户端仍传 scheme 且未配置新算法，用 scheme 作为 algorithm
    const legacyScheme = isReviewScheme(body?.scheme) ? body.scheme : null
    if (clientAlg) {
      algorithm = clientAlg
      const globalCfg = mergeConfig(settings?.globalAlgConfig)
      // 若单卡覆盖的算法类型与客户端选择一致，用单卡覆盖配置；否则用全局配置
      const resolved =
        card.algoType === clientAlg
          ? resolveConfig(clientAlg, globalCfg, card.algoType, card.algoConfig)
          : { algorithm: clientAlg, config: globalCfg }
      resolvedConfig = resolved.config
    } else if (legacyScheme && !card.algoType && !isValidAlgType(settings?.globalAlgorithm)) {
      algorithm = legacyScheme as AlgorithmType
      resolvedConfig = mergeConfig({})
    } else {
      const globalAlg: AlgorithmType = isValidAlgType(settings?.globalAlgorithm)
        ? (settings.globalAlgorithm as AlgorithmType)
        : 'fsrs'
      const globalCfg = mergeConfig(settings?.globalAlgConfig)
      const resolved = resolveConfig(globalAlg, globalCfg, card.algoType, card.algoConfig)
      algorithm = resolved.algorithm
      resolvedConfig = resolved.config
    }

    const memory: CardMemory = parseMemory(card.srsState)
    const prevR = retrievability(memory.s, elapsedDays(memory, now))

    const result = computeReview({
      memory,
      grade,
      config: resolvedConfig,
      algorithm,
      now,
      tzOffsetMin: tzOffset,
      durationSec: duration,
      ease: card.ease ?? undefined,
    })

    // ReviewLog 落库动作（向后兼容旧统计查询：grade→action）
    const logAction: ReviewAction =
      grade === 'again' ? 'forget' : grade === 'hard' ? 'fuzzy' : 'familiar'

    const [log] = await Promise.all([
      db.reviewLog.create({
        data: {
          cardId,
          cardTitle: String(body?.cardTitle || '').slice(0, 120),
          action: logAction,
          durationSec: duration,
        },
      }),
      db.card.update({
        where: { id: cardId },
        data: {
          srsState: JSON.stringify(result.memory),
          ease: result.ease,
          interval: Math.max(0, Math.round(result.interval)),
          reviewCount: result.reviewCount,
          lastReviewedAt: now,
          nextReviewAt: result.nextReviewAt,
        },
      }),
    ])
    return NextResponse.json({
      id: log.id,
      nextReviewAt: result.nextReviewAt,
      interval: result.interval,
      algorithm,
      grade,
      prevR,
      newS: result.memory.s,
      newD: result.memory.d,
      newState: result.memory.state,
      log: result.log,
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
