// POST /api/media-ai — 富媒体代码 AI 生成/修改（编辑器 AI 助理 + AI 修复）。
// body: { kind, currentCode, instruction, history? }
//   kind ∈ mermaid | svg | table | formula | code
//   currentCode 空 = 从零生成；非空 = 在现有代码上按指令修改
//   history: [{role:'user'|'assistant', content}] 最多 20 条（临时会话由前端持有）
// 返回: { code } — 已剥掉 markdown 围栏的纯代码。
// 超时 60s；session 鉴权（getSessionUser）。
import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getAIConfig } from '@/lib/settings'
import { mediaCodegen, type MediaCodegenKind } from '@/lib/ai'

export const runtime = 'nodejs'

const KINDS: MediaCodegenKind[] = ['mermaid', 'svg', 'table', 'formula', 'code']
const MAX_HISTORY = 20
const TIMEOUT_MS = 60_000
const MAX_CODE_LEN = 20_000

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    const body = await req.json().catch(() => ({}))
    const kind = body?.kind
    if (typeof kind !== 'string' || !KINDS.includes(kind as MediaCodegenKind)) {
      return NextResponse.json({ error: '不支持的富媒体类型' }, { status: 400 })
    }
    const instruction = typeof body?.instruction === 'string' ? body.instruction.trim() : ''
    if (!instruction) {
      return NextResponse.json({ error: '请描述你想让 AI 做什么' }, { status: 400 })
    }
    const currentCode =
      typeof body?.currentCode === 'string' ? body.currentCode.slice(0, MAX_CODE_LEN) : ''
    const history = Array.isArray(body?.history)
      ? (body.history as unknown[])
          .filter(
            (m): m is { role: 'user' | 'assistant'; content: string } =>
              !!m &&
              typeof m === 'object' &&
              ((m as { role?: unknown }).role === 'user' ||
                (m as { role?: unknown }).role === 'assistant') &&
              typeof (m as { content?: unknown }).content === 'string',
          )
          .slice(-MAX_HISTORY)
      : []

    const config = await getAIConfig()
    // 60s 超时（mediaCodegen 内部不再计时）
    const code = await Promise.race([
      mediaCodegen(
        { kind: kind as MediaCodegenKind, currentCode, instruction, history },
        config,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('AI 响应超时（60 秒），请重试')), TIMEOUT_MS),
      ),
    ])

    if (!code || !code.trim()) {
      return NextResponse.json({ error: 'AI 返回为空，请重试' }, { status: 502 })
    }
    return NextResponse.json({ code })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/media-ai] failed:', err)
    return NextResponse.json({ error: msg.slice(0, 300) }, { status: 500 })
  }
}
