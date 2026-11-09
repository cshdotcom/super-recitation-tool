// Settings endpoints (require login).
// GET    /api/settings   -> current settings (singleton)
// PATCH  /api/settings   -> upsert partial settings
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { getSettings, parseSettings } from '@/lib/settings'
import { DEFAULT_TOOLS, type ToolToggles } from '@/lib/types'

const ID = 'singleton'

export async function GET() {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }
    return NextResponse.json(await getSettings())
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[GET /api/settings] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    const body = await req.json().catch(() => ({}))

    // If no fields supplied, just return current settings.
    if (
      body === null ||
      typeof body !== 'object' ||
      Object.keys(body).length === 0
    ) {
      return NextResponse.json(await getSettings())
    }

    const data: Record<string, string | boolean | number> = {}

    if (typeof body?.clozeStyle === 'string') {
      // 挖空显示样式：下划线/模糊/星号/空白/高亮/圈圈
      data.clozeStyle = ['underline', 'blur', 'star', 'blank', 'highlight', 'circle'].includes(
        body.clozeStyle,
      )
        ? body.clozeStyle
        : 'circle'
    }
    if (typeof body?.showAnswers === 'boolean') {
      data.showAnswers = body.showAnswers
    }
    if (body?.tools && typeof body.tools === 'object') {
      const merged: ToolToggles = { ...DEFAULT_TOOLS }
      for (const key of Object.keys(DEFAULT_TOOLS) as (keyof ToolToggles)[]) {
        if (typeof body.tools[key] === 'boolean') {
          merged[key] = body.tools[key]
        }
      }
      data.tools = JSON.stringify(merged)
    }
    if (typeof body?.fontSize === 'number' && Number.isFinite(body.fontSize)) {
      const size = Math.round(body.fontSize)
      data.fontSize = Math.min(32, Math.max(12, size))
    }
    if (body?.pageMode === 'scroll' || body?.pageMode === 'paged') {
      data.pageMode = body.pageMode
    }
    // App theme: light | dark | green(护眼) | sepia(羊皮纸) | system
    if (
      typeof body?.theme === 'string' &&
      ['light', 'dark', 'green', 'sepia', 'system'].includes(body.theme)
    ) {
      data.theme = body.theme
    }
    // Per-context voice defaults: shallow-merge the submitted context keys.
    if (body?.voicePrefs && typeof body.voicePrefs === 'object') {
      const current = await db.settings.findUnique({ where: { id: ID } })
      let merged: Record<string, unknown> = {}
      try {
        if (current?.voicePrefs) merged = JSON.parse(current.voicePrefs)
      } catch {}
      for (const [ctx, pref] of Object.entries(body.voicePrefs as Record<string, unknown>)) {
        if (pref && typeof pref === 'object') merged[ctx] = pref
      }
      data.voicePrefs = JSON.stringify(merged)
    }
    if (typeof body?.aiProvider === 'string') {
      data.aiProvider = body.aiProvider === 'custom' ? 'custom' : 'zai'
    }
    if (typeof body?.aiBaseURL === 'string') {
      data.aiBaseURL = body.aiBaseURL
    }
    if (typeof body?.aiApiKey === 'string') {
      data.aiApiKey = body.aiApiKey
    }
    if (typeof body?.aiModel === 'string') {
      data.aiModel = body.aiModel
    }
    // TTS provider: zai | custom(OpenAI 兼容) | browser(Web Speech API)
    if (typeof body?.ttsProvider === 'string') {
      data.ttsProvider =
        body.ttsProvider === 'custom' || body.ttsProvider === 'browser'
          ? body.ttsProvider
          : 'zai'
    }
    if (typeof body?.ttsBaseURL === 'string') {
      data.ttsBaseURL = body.ttsBaseURL
    }
    if (typeof body?.ttsApiKey === 'string') {
      data.ttsApiKey = body.ttsApiKey
    }
    if (typeof body?.ttsModel === 'string') {
      data.ttsModel = body.ttsModel
    }
    // 全局默认 TTS 音色/倍速（per-context voicePrefs 未设置时回退到此）
    if (typeof body?.ttsVoice === 'string') {
      data.ttsVoice = body.ttsVoice
    }
    if (typeof body?.ttsSpeed === 'number' && Number.isFinite(body.ttsSpeed)) {
      // 0.5-3，与 clampSpeed 一致
      data.ttsSpeed = Math.min(3, Math.max(0.5, body.ttsSpeed))
    }
    // ASR provider: same options as TTS
    if (typeof body?.asrProvider === 'string') {
      data.asrProvider =
        body.asrProvider === 'custom' || body.asrProvider === 'browser'
          ? body.asrProvider
          : 'zai'
    }
    if (typeof body?.asrBaseURL === 'string') {
      data.asrBaseURL = body.asrBaseURL
    }
    if (typeof body?.asrApiKey === 'string') {
      data.asrApiKey = body.asrApiKey
    }
    if (typeof body?.asrModel === 'string') {
      data.asrModel = body.asrModel
    }
    // 错题本：答对后自动移除 — 答对N次后 (1/2/3/5)
    if (typeof body?.quizAutoRemove === 'number' && [1, 2, 3, 5].includes(body.quizAutoRemove)) {
      data.quizAutoRemove = body.quizAutoRemove
    }
    // 导入时 AI 自动挖空
    if (typeof body?.aiAutoCloze === 'boolean') {
      data.aiAutoCloze = body.aiAutoCloze
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json(await getSettings())
    }

    const row = await db.settings.upsert({
      where: { id: ID },
      update: data,
      create: { id: ID, ...data },
    })
    return NextResponse.json(parseSettings(row as never))
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[PATCH /api/settings] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
