// 算法预览：4 档按钮下次间隔 + R 衰减曲线
// POST /api/algorithms/preview { cardId?, memory?, config?, algorithm?, ease? }
//   - 传 cardId：读取该卡 srsState + 解析生效配置，返回完整预览
//   - 传 memory/config/algorithm：临时预览（配置面板实时调参用）
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAccount } from '@/lib/auth'
import {
  type AlgorithmConfig,
  type AlgorithmType,
  type CardMemory,
  defaultConfig,
  isValidAlgType,
  mergeConfig,
  parseMemory,
  previewCard,
  resolveConfig,
} from '@/lib/spaced-repetition'

export async function POST(req: NextRequest) {
  const account = await requireAccount()
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })
  try {
    const body = await req.json()
    const cardId = String(body?.cardId || '')
    const now = new Date()
    const tzOffset = Math.min(840, Math.max(-840, Math.round(Number(body?.tzOffset) || 0)))

    let memory: CardMemory
    let config: AlgorithmConfig
    let algorithm: AlgorithmType
    let ease: number | undefined

    if (cardId) {
      const card = await db.card.findUnique({
        where: { id: cardId },
        select: { srsState: true, ease: true, algoType: true, algoConfig: true },
      })
      if (!card) return NextResponse.json({ error: '卡片不存在' }, { status: 404 })
      const settings = await db.settings.findUnique({ where: { id: 'singleton' } })
      const globalAlg: AlgorithmType = isValidAlgType(settings?.globalAlgorithm)
        ? (settings.globalAlgorithm as AlgorithmType)
        : 'fsrs'
      const globalCfg = mergeConfig(settings?.globalAlgConfig)
      const resolved = resolveConfig(globalAlg, globalCfg, card.algoType, card.algoConfig)
      memory = parseMemory(card.srsState)
      config = resolved.config
      algorithm = resolved.algorithm
      ease = card.ease ?? undefined
    } else {
      memory = body?.memory ? parseMemory(JSON.stringify(body.memory)) : parseMemory(null)
      config = mergeConfig(body?.config ?? defaultConfig())
      algorithm = isValidAlgType(body?.algorithm) ? (body.algorithm as AlgorithmType) : 'fsrs'
      ease = typeof body?.ease === 'number' ? body.ease : undefined
    }

    const preview = previewCard(memory, config, algorithm, now, tzOffset, ease)
    return NextResponse.json({ preview, algorithm, config })
  } catch (err) {
    console.error('[POST /api/algorithms/preview] failed:', err)
    return NextResponse.json({ error: '预览失败' }, { status: 500 })
  }
}
