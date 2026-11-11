// 错题本 + 收藏题目 + 答题报告 — server-side quiz item store.
//
// POST   /api/quiz-items  report an answer: { cardId, cardTitle, type, question,
//            answer, options, result: 'wrong'|'right', autoRemove, durationSec }
//            - wrong: upsert (wrongCount++, rightStreak=0) + ReviewLog quiz-wrong
//            - right: bump rightStreak; auto-removed at threshold + ReviewLog quiz-right
// GET    /api/quiz-items?wrong=1        -> active wrong-question list
// GET    /api/quiz-items?favorite=1     -> favorite list
// GET    /api/quiz-items?stats=1        -> WrongStats buckets
// GET    /api/quiz-items?report=1       -> QuizReportStats (last 30 days)
// PATCH  /api/quiz-items  { id, favorite?, removed? }
// DELETE /api/quiz-items?id=.. | ?wrong=1 (清空错题)
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAccount } from '@/lib/auth'
import type { QuizReportStats, QuizType, WrongStats } from '@/lib/types'

const QUIZ_TYPES: readonly string[] = ['fill', 'short', 'choice']

/** tzOffsetMin = Date#getTimezoneOffset()（UTC+8 为 -480），当地墙上时间 = UTC − tzOffsetMin
 *  （原实现 `+ tzOffsetMin` 方向反了：东八区 0:00-8:00 的答题被记到前一天，与 /api/review 同款修正）。 */
function dayKey(d: Date, tzOffsetMin: number): string {
  return new Date(d.getTime() - tzOffsetMin * 60000).toISOString().slice(0, 10)
}

function serializeItem(row: {
  id: string
  cardId: string
  cardTitle: string
  type: string
  question: string
  answer: string
  options: string
  wrongCount: number
  rightCount: number
  favorite: boolean
  createdAt: Date
  updatedAt: Date
}) {
  let options: string[] = []
  try {
    const parsed = JSON.parse(row.options || '[]')
    if (Array.isArray(parsed)) options = parsed.map(String)
  } catch {}
  return {
    id: row.id,
    cardId: row.cardId,
    cardTitle: row.cardTitle,
    type: (QUIZ_TYPES.includes(row.type) ? row.type : 'fill') as QuizType,
    question: row.question,
    answer: row.answer,
    options,
    wrongCount: row.wrongCount,
    rightCount: row.rightCount,
    favorite: row.favorite,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function POST(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })

  try {
    const body = await req.json()
    const favorite = body?.favorite === true
    const unfavorite = body?.favorite === false
    const result = body?.result === 'right' ? 'right' : 'wrong'
    const cardId = String(body?.cardId || '')
    const question = String(body?.question || '').slice(0, 500)
    if (!question) return NextResponse.json({ error: '缺少题目' }, { status: 400 })
    const duration = Math.min(3600, Math.max(0, Math.round(Number(body?.durationSec) || 0)))

    // 收藏/取消收藏：upsert the question row and toggle its favorite flag.
    // No ReviewLog is written (favoriting is not an answer).
    if (favorite || unfavorite) {
      const existing = cardId
        ? await db.quizItem.findFirst({ where: { cardId, question } })
        : null
      if (existing) {
        await db.quizItem.update({
          where: { id: existing.id },
          data: { favorite, removed: false },
        })
        return NextResponse.json({ id: existing.id, favorite })
      }
      if (!favorite) return NextResponse.json({ id: null, favorite: false })
      const row = await db.quizItem.create({
        data: {
          cardId,
          cardTitle: String(body?.cardTitle || '').slice(0, 120),
          type: QUIZ_TYPES.includes(body?.type) ? body.type : 'fill',
          question,
          answer: String(body?.answer || '').slice(0, 1000),
          options: JSON.stringify(
            Array.isArray(body?.options) ? body.options.map(String).slice(0, 8) : [],
          ),
          favorite: true,
        },
      })
      return NextResponse.json({ id: row.id, favorite: true })
    }

    // Record the answer in ReviewLog for the 答题报告.
    await db.reviewLog.create({
      data: {
        cardId,
        cardTitle: String(body?.cardTitle || '').slice(0, 120),
        action: result === 'right' ? 'quiz-right' : 'quiz-wrong',
        durationSec: duration,
      },
    })

    const existing = question
      ? await db.quizItem.findFirst({ where: { cardId, question } })
      : null

    if (result === 'wrong') {
      if (existing) {
        await db.quizItem.update({
          where: { id: existing.id },
          data: { wrongCount: { increment: 1 }, rightStreak: 0, removed: false },
        })
      } else {
        await db.quizItem.create({
          data: {
            cardId,
            cardTitle: String(body?.cardTitle || '').slice(0, 120),
            type: QUIZ_TYPES.includes(body?.type) ? body.type : 'fill',
            question,
            answer: String(body?.answer || '').slice(0, 1000),
            options: JSON.stringify(
              Array.isArray(body?.options) ? body.options.map(String).slice(0, 8) : [],
            ),
            wrongCount: 1,
          },
        })
      }
      return NextResponse.json({ ok: true })
    }

    // right
    if (existing) {
      const rightStreak = existing.rightStreak + 1
      const threshold = Math.min(5, Math.max(1, Math.round(Number(body?.autoRemove) || 2)))
      await db.quizItem.update({
        where: { id: existing.id },
        data: {
          rightCount: { increment: 1 },
          rightStreak,
          removed: rightStreak >= threshold ? true : existing.removed,
        },
      })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[POST /api/quiz-items] failed:', err)
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

    if (sp.get('stats')) {
      const tzOffset = Math.min(840, Math.max(-840, Number(sp.get('tzOffset')) || 0))
      const [items, logs] = await Promise.all([
        db.quizItem.findMany({ where: { removed: false, wrongCount: { gt: 0 } } }),
        db.reviewLog.findMany({
          where: { action: { in: ['quiz-right', 'quiz-wrong'] } },
        }),
      ])
      const today = dayKey(new Date(), tzOffset)
      let todayRight = 0
      let todayWrong = 0
      for (const l of logs) {
        if (dayKey(l.createdAt, tzOffset) !== today) continue
        if (l.action === 'quiz-right') todayRight += 1
        else todayWrong += 1
      }
      const stats: WrongStats = {
        rate:
          todayRight + todayWrong > 0
            ? Math.round((todayWrong / (todayRight + todayWrong)) * 100)
            : 0,
        wrongCount: items.length,
        todayWrong,
        multiWrong: items.filter((i) => i.wrongCount >= 2).length,
        buckets: {
          fivePlus: items.filter((i) => i.wrongCount >= 5).length,
          three: items.filter((i) => i.wrongCount === 3).length,
          two: items.filter((i) => i.wrongCount === 2).length,
          one: items.filter((i) => i.wrongCount === 1).length,
        },
      }
      return NextResponse.json(stats)
    }

    if (sp.get('report')) {
      const tzOffset = Math.min(840, Math.max(-840, Number(sp.get('tzOffset')) || 0))
      const logs = await db.reviewLog.findMany({
        where: { action: { in: ['quiz-right', 'quiz-wrong'] } },
        orderBy: { createdAt: 'asc' },
      })
      const today = dayKey(new Date(), tzOffset)
      const days: { date: string; answered: number; wrong: number }[] = []
      for (let i = 29; i >= 0; i--) {
        const key = dayKey(new Date(Date.now() - i * 86400000), tzOffset)
        const dayLogs = logs.filter((l) => dayKey(l.createdAt, tzOffset) === key)
        days.push({
          date: key,
          answered: dayLogs.length,
          wrong: dayLogs.filter((l) => l.action === 'quiz-wrong').length,
        })
      }
      const todayLogs = logs.filter((l) => dayKey(l.createdAt, tzOffset) === today)
      const stats: QuizReportStats = {
        todayAnswered: todayLogs.length,
        todaySeconds: todayLogs.reduce((s, l) => s + l.durationSec, 0),
        days,
      }
      return NextResponse.json(stats)
    }

    const items = await db.quizItem.findMany({
      where: sp.get('favorite') ? { favorite: true, removed: false } : { removed: false },
      orderBy: { updatedAt: 'desc' },
    })
    return NextResponse.json({ items: items.map(serializeItem) })
  } catch (err) {
    console.error('[GET /api/quiz-items] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '加载失败' },
      { status: 500 },
    )
  }
}

export async function PATCH(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })

  try {
    const body = await req.json()
    const id = String(body?.id || '')
    if (!id) return NextResponse.json({ error: '缺少 id' }, { status: 400 })
    const data: { favorite?: boolean; removed?: boolean } = {}
    if (typeof body?.favorite === 'boolean') data.favorite = body.favorite
    if (typeof body?.removed === 'boolean') data.removed = body.removed
    await db.quizItem.update({ where: { id }, data })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[PATCH /api/quiz-items] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '更新失败' },
      { status: 500 },
    )
  }
}

export async function DELETE(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })

  try {
    const sp = req.nextUrl.searchParams
    if (sp.get('wrong')) {
      await db.quizItem.updateMany({ where: { removed: false }, data: { removed: true } })
      return NextResponse.json({ ok: true })
    }
    const id = sp.get('id')
    if (!id) return NextResponse.json({ error: '缺少 id' }, { status: 400 })
    await db.quizItem.delete({ where: { id } }).catch(() => {})
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[DELETE /api/quiz-items] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '删除失败' },
      { status: 500 },
    )
  }
}
