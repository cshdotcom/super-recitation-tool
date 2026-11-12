// 算法配置：全局默认 / 单卡覆盖
// GET  /api/algorithms/config?cardId=...  -> 解析后的生效配置（全局 → 单卡覆盖合并）
// PUT  /api/algorithms/config  { scope:'global'|'card', cardId?, algorithm?, config?, enabled? }
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAccount } from '@/lib/auth'
import {
  type AlgorithmConfig,
  type AlgorithmType,
  defaultConfig,
  isValidAlgType,
  mergeConfig,
  resolveConfig,
} from '@/lib/spaced-repetition'

export async function GET(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const sp = req.nextUrl.searchParams
    const cardId = sp.get('cardId') || ''
    const settings = await db.settings.findUnique({ where: { id: 'singleton' } })
    const globalAlg: AlgorithmType = isValidAlgType(settings?.globalAlgorithm)
      ? (settings.globalAlgorithm as AlgorithmType)
      : 'fsrs'
    const globalCfg: AlgorithmConfig = mergeConfig(settings?.globalAlgConfig)
    const globalEnabled: string[] = safeStrArr(settings?.globalAlgEnabled, ['fsrs'])

    let cardOverride: { algoType: string | null; algoConfig: string; algoEnabled: string } | null = null
    if (cardId) {
      const c = await db.card.findUnique({
        where: { id: cardId },
        select: { algoType: true, algoConfig: true, algoEnabled: true },
      })
      if (c) cardOverride = c
    }
    const resolved = resolveConfig(
      globalAlg,
      globalCfg,
      cardOverride?.algoType,
      cardOverride?.algoConfig,
    )
    const cardEnabled: string[] =
      cardOverride && cardOverride.algoEnabled !== '[]'
        ? safeStrArr(cardOverride.algoEnabled, globalEnabled)
        : globalEnabled
    return NextResponse.json({
      resolved,
      global: { algorithm: globalAlg, config: globalCfg, enabled: globalEnabled },
      card: cardOverride
        ? {
            algorithm: cardOverride.algoType,
            config: mergeConfig(cardOverride.algoConfig),
            enabled: cardEnabled,
          }
        : null,
    })
  } catch (err) {
    console.error('[GET /api/algorithms/config] failed:', err)
    return NextResponse.json({ error: '加载失败' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const body = await req.json()
    const scope = body?.scope === 'card' ? 'card' : 'global'
    const algorithm = isValidAlgType(body?.algorithm) ? (body.algorithm as AlgorithmType) : undefined
    const config: AlgorithmConfig | undefined =
      body?.config !== undefined ? mergeConfig(body.config) : undefined
    const enabled: string[] | undefined = Array.isArray(body?.enabled)
      ? (body.enabled as unknown[]).filter((v) => isValidAlgType(v)).map(String)
      : undefined

    if (scope === 'global') {
      const data: Record<string, string> = {}
      if (algorithm) data.globalAlgorithm = algorithm
      if (config) data.globalAlgConfig = JSON.stringify(config)
      if (enabled) data.globalAlgEnabled = JSON.stringify(enabled)
      await db.settings.upsert({
        where: { id: 'singleton' },
        update: data,
        create: { id: 'singleton', ...data },
      })
      return NextResponse.json({ ok: true })
    }
    // card scope
    const cardId = String(body?.cardId || '')
    if (!cardId) return NextResponse.json({ error: '缺少 cardId' }, { status: 400 })
    const data: Record<string, string | null> = {}
    if (algorithm !== undefined) data.algoType = algorithm
    if (config !== undefined) data.algoConfig = JSON.stringify(config)
    if (enabled !== undefined) data.algoEnabled = JSON.stringify(enabled)
    await db.card.update({ where: { id: cardId }, data })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[PUT /api/algorithms/config] failed:', err)
    return NextResponse.json({ error: '保存失败' }, { status: 500 })
  }
}

function safeStrArr(json: string | null | undefined, def: string[]): string[] {
  if (!json) return def
  try {
    const p = JSON.parse(json)
    if (Array.isArray(p)) return p.filter((v) => isValidAlgType(v)).map(String)
  } catch {}
  return def
}

// 抑制未用导入告警（defaultConfig 在其他路由通过 mergeConfig 间接使用）
void defaultConfig
