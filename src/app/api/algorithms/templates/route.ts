// 复习算法模板 CRUD（v2.8.0+）
// GET  /api/algorithms/templates -> 模板列表（含内置 seed）
// POST /api/algorithms/templates { name, type, config, description } -> 新建自定义模板
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAccount } from '@/lib/auth'
import { BUILTIN_PRESETS, mergeConfig, presetToTemplate } from '@/lib/spaced-repetition'
import type { AlgorithmTemplateData, AlgorithmType } from '@/lib/spaced-repetition'

async function seedBuiltins() {
  const existing = await db.algorithmTemplate.count({ where: { builtIn: true } })
  if (existing > 0) return
  await db.algorithmTemplate.createMany({
    data: BUILTIN_PRESETS.map((p) => ({
      name: p.name,
      type: p.type,
      config: JSON.stringify(mergeConfig(p.config)),
      description: p.description,
      builtIn: true,
    })),
  })
}

function rowToData(r: {
  id: string
  name: string
  type: string
  config: string
  description: string
  builtIn: boolean
  createdAt: Date
  updatedAt: Date
}): AlgorithmTemplateData {
  return {
    id: r.id,
    name: r.name,
    type: r.type as AlgorithmType,
    config: mergeConfig(r.config),
    description: r.description,
    builtIn: r.builtIn,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

export async function GET() {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    await seedBuiltins()
    const rows = await db.algorithmTemplate.findMany({ orderBy: [{ builtIn: 'desc' }, { createdAt: 'asc' }] })
    return NextResponse.json({ templates: rows.map(rowToData) })
  } catch (err) {
    console.error('[GET /api/algorithms/templates] failed:', err)
    return NextResponse.json({ error: '加载失败' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const body = await req.json()
    const name = String(body?.name || '').trim().slice(0, 40)
    if (!name) return NextResponse.json({ error: '请输入模板名称' }, { status: 400 })
    const type = String(body?.type || 'fsrs')
    const validTypes = ['fsrs', 'sm2', 'fixed', 'simple', 'custom']
    if (!validTypes.includes(type)) return NextResponse.json({ error: '无效算法类型' }, { status: 400 })
    const config = JSON.stringify(mergeConfig(body?.config))
    const description = String(body?.description || '').slice(0, 200)
    const row = await db.algorithmTemplate.create({
      data: { name, type, config, description, builtIn: false },
    })
    return NextResponse.json({ template: rowToData(row) })
  } catch (err) {
    console.error('[POST /api/algorithms/templates] failed:', err)
    return NextResponse.json({ error: '保存失败' }, { status: 500 })
  }
}

export { presetToTemplate }
