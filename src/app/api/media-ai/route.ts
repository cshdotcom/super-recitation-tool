// POST /api/media-ai — 富媒体代码 AI 生成/修改（编辑器 AI 助理 + AI 修复）。
// body: { kind, currentCode, instruction, history?, images?, temperature? }
//   kind ∈ mermaid | svg | html | table | formula | code
//   currentCode 空 = 从零生成；非空 = 在现有代码上按指令修改
//   history: [{role:'user'|'assistant', content}] 最多 20 条（临时会话由前端持有）
//   images: 可选附图（data:image/ URI，最多 2 张、单张 base64 ≤2MB）—
//     走视觉模型（chatComplete 检测到 images 自动升级 createVision），
//     AI 可「看图生成代码」（如根据手绘草图生成 SVG / mermaid）
//   temperature: 可选采样温度（0~1.5）；不传走服务端默认
// 返回: { code } — 已剥掉 markdown 围栏的纯代码（html 额外剥离 script/on* 事件 / js:）。
// 超时 60s；session 鉴权（getSessionUser）。
import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getAIConfig } from '@/lib/settings'
import { mediaCodegen, type MediaCodegenKind } from '@/lib/ai'

export const runtime = 'nodejs'

const KINDS: MediaCodegenKind[] = ['mermaid', 'svg', 'html', 'table', 'formula', 'code']
const MAX_HISTORY = 20
const TIMEOUT_MS = 60_000
const MAX_CODE_LEN = 20_000
const MAX_IMAGES = 2
const MAX_IMAGE_B64_LENGTH = 2 * 1024 * 1024

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

    // 附图（可选）：仅接受 data:image/ URI 数组，最多 2 张、单张 base64 ≤2MB
    const images = Array.isArray(body?.images)
      ? (body.images as unknown[])
          .filter(
            (img): img is string =>
              typeof img === 'string' && img.startsWith('data:image/'),
          )
          .slice(0, MAX_IMAGES)
      : []
    if (images.some((img) => img.length > MAX_IMAGE_B64_LENGTH)) {
      return NextResponse.json({ error: '单张图片过大（base64 超过 2MB）' }, { status: 400 })
    }

    // 采样温度（可选）：有限数字才透传（mediaCodegen 内部还有一道裁剪）
    const temperature =
      typeof body?.temperature === 'number' && Number.isFinite(body.temperature)
        ? Math.min(1.5, Math.max(0, body.temperature))
        : undefined

    const config = await getAIConfig()
    // 60s 超时（mediaCodegen 内部不再计时）
    const code = await Promise.race([
      mediaCodegen(
        {
          kind: kind as MediaCodegenKind,
          currentCode,
          instruction,
          history,
          ...(images.length > 0 ? { images } : {}),
          ...(temperature != null ? { temperature } : {}),
        },
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
