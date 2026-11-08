// 挖空背诵成绩记录 — 语音背诵打分后落库，服务端可查「背诵记录」。
// GET    /api/recite-log?cardId=<id>&limit=20 -> { logs: [{id,score,text,missed,matched,createdAt}] }
//        /api/recite-log?all=1                -> 全部卡片最近记录（背诵记录总览）
// POST   /api/recite-log  { cardId, cardTitle, score, text, missed, matched } -> { id }
// DELETE /api/recite-log?id=<rowId> | ?cardId=<id> | ?all=1
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAccount } from '@/lib/auth'

function parseList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string').slice(0, 100)
}

export async function GET(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })

  try {
    const sp = req.nextUrl.searchParams
    const limit = Math.min(100, Math.max(1, Number(sp.get('limit')) || 20))
    const where = sp.get('all')
      ? {}
      : { cardId: String(sp.get('cardId') || '') }
    if (!sp.get('all') && !(where as { cardId: string }).cardId) {
      return NextResponse.json({ error: '缺少 cardId' }, { status: 400 })
    }
    const rows = await db.reciteLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    return NextResponse.json({
      logs: rows.map((r) => {
        let missed: string[] = []
        let matched: string[] = []
        try {
          missed = parseList(JSON.parse(r.missed))
          matched = parseList(JSON.parse(r.matched))
        } catch {}
        return {
          id: r.id,
          cardId: r.cardId,
          cardTitle: r.cardTitle,
          score: r.score,
          text: r.text,
          missed,
          matched,
          createdAt: r.createdAt,
        }
      }),
    })
  } catch (err) {
    console.error('[GET /api/recite-log] failed:', err)
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
    const cardId = String(body?.cardId || '')
    if (!cardId) return NextResponse.json({ error: '缺少 cardId' }, { status: 400 })
    const score = Math.min(100, Math.max(0, Math.round(Number(body?.score) || 0)))
    const row = await db.reciteLog.create({
      data: {
        cardId,
        cardTitle: String(body?.cardTitle || '').slice(0, 120),
        score,
        text: String(body?.text || '').slice(0, 5000),
        missed: JSON.stringify(parseList(body?.missed)),
        matched: JSON.stringify(parseList(body?.matched)),
      },
    })
    return NextResponse.json({ id: row.id })
  } catch (err) {
    console.error('[POST /api/recite-log] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '保存失败' },
      { status: 500 },
    )
  }
}

export async function DELETE(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })

  try {
    const sp = req.nextUrl.searchParams
    const id = sp.get('id')
    if (id) {
      await db.reciteLog.deleteMany({ where: { id } })
      return NextResponse.json({ ok: true })
    }
    const cardId = sp.get('cardId')
    if (cardId) {
      await db.reciteLog.deleteMany({ where: { cardId } })
      return NextResponse.json({ ok: true })
    }
    if (sp.get('all')) {
      await db.reciteLog.deleteMany({})
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ error: '缺少删除参数' }, { status: 400 })
  } catch (err) {
    console.error('[DELETE /api/recite-log] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '删除失败' },
      { status: 500 },
    )
  }
}
