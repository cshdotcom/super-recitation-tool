// 通用 KV 状态（服务端持久化）— 答题草稿、作答记录、每日背诵计划进度、
// 眼睛按钮位置、涂鸦调色板、TTS 音色记忆等原本散落在 localStorage 的用户
// 数据统一搬到服务端，保证「所有数据都存在服务端」。
// GET    /api/state?key=<k1>&key=<k2>...  -> { values: { [key]: value|null } }
// GET    /api/state?prefix=quiz:draft:    -> { values: { [key]: value } }（前缀批量）
// PUT    /api/state  { key, value } 或 { entries: [{key,value},...] }  -> { ok: true }
// DELETE /api/state?key=<k> | ?prefix=<p>
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAccount } from '@/lib/auth'

const MAX_VALUE = 400_000 // 单值上限（草稿含题目 JSON 足够）

export async function GET(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })

  try {
    const sp = req.nextUrl.searchParams
    const keys = sp.getAll('key').filter(Boolean)
    const prefix = sp.get('prefix') || ''
    if (keys.length === 0 && !prefix) {
      return NextResponse.json({ error: '缺少 key 或 prefix' }, { status: 400 })
    }

    const values: Record<string, string | null> = {}
    if (keys.length > 0) {
      const rows = await db.appState.findMany({ where: { key: { in: keys } } })
      const byKey = new Map(rows.map((r) => [r.key, r.value]))
      for (const k of keys) values[k] = byKey.get(k) ?? null
    }
    if (prefix) {
      const rows = await db.appState.findMany({ where: { key: { startsWith: prefix } } })
      for (const r of rows) values[r.key] = r.value
    }
    return NextResponse.json({ values })
  } catch (err) {
    console.error('[GET /api/state] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '加载失败' },
      { status: 500 },
    )
  }
}

export async function PUT(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })

  try {
    const body = await req.json()
    const entries: { key: string; value: string }[] = []
    if (typeof body?.key === 'string' && body.key) {
      entries.push({ key: body.key, value: String(body?.value ?? '') })
    }
    if (Array.isArray(body?.entries)) {
      for (const e of body.entries) {
        if (e && typeof e.key === 'string' && e.key) {
          entries.push({ key: e.key, value: String(e.value ?? '') })
        }
      }
    }
    if (entries.length === 0) {
      return NextResponse.json({ error: '缺少 key' }, { status: 400 })
    }

    await Promise.all(
      entries.slice(0, 50).map((e) =>
        db.appState.upsert({
          where: { key: e.key },
          update: { value: e.value.slice(0, MAX_VALUE) },
          create: { key: e.key, value: e.value.slice(0, MAX_VALUE) },
        }),
      ),
    )
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[PUT /api/state] failed:', err)
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
    const key = sp.get('key')
    if (key) {
      await db.appState.deleteMany({ where: { key } })
      return NextResponse.json({ ok: true })
    }
    const prefix = sp.get('prefix')
    if (prefix) {
      await db.appState.deleteMany({ where: { key: { startsWith: prefix } } })
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ error: '缺少 key 或 prefix' }, { status: 400 })
  } catch (err) {
    console.error('[DELETE /api/state] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '删除失败' },
      { status: 500 },
    )
  }
}
