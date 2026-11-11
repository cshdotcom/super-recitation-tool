// AI knowledge-point extraction — Step 1 of the two-step quiz flow.
// POST /api/quiz-points  { content, images?: string[] }
//   -> { points: [{ text, importance: 'core' | 'secondary' }] }
//
// 图片出题：images 为 `data:image/` URI（最多 5 张，单张 base64 ≤ 400KB）。
// 有图片时走视觉链路（chatComplete 在消息携带 images 时自动升级为
// createVision / OpenAI 多模态，见 src/lib/ai.ts）：先 OCR 识别图中文字，
// 与用户提供的文字合并后再提炼知识点；content 为空时以 OCR 文本作为课文。
// content 里的 `![alt](url)` 图片引用会替换为 `[图片: alt]` 文字提示
//（URL 对模型无意义，实际图片已随 images 走视觉链路）。
import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { chatComplete, extractJSON } from '@/lib/ai'
import { getAIConfig } from '@/lib/settings'
import type { ChatMessage } from '@/lib/types'

const MAX_CONTENT = 6000
const MAX_POINTS = 12
const MAX_IMAGES = 5
// Base64 字符上限（≈300KB 二进制）— 客户端压缩输出不超过该值。
const MAX_IMAGE_B64_LENGTH = 400 * 1024

/** 把 content 里的图片引用 `![alt](url)` 替换为 `[图片: alt]`：alt 并入文字上下文，URL 剥离。 */
function imageRefsToTextHints(content: string): string {
  return content.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m: string, alt: string) => {
    const label = String(alt ?? '').trim()
    return label ? `[图片: ${label}]` : '[图片]'
  })
}

export async function POST(req: NextRequest) {
  try {
    const account = await getSessionUser()
    if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const content: string = typeof body?.content === 'string' ? body.content : ''

    // ---- 图片校验（与 /api/chat 相同 pattern：data:image/ URI 数组）----
    const rawImages: unknown = body?.images
    let images: string[] = []
    if (rawImages != null) {
      if (!Array.isArray(rawImages)) {
        return NextResponse.json(
          { error: '图片格式不正确，需为 data:image/ 开头的 data URI 数组' },
          { status: 400 },
        )
      }
      if (rawImages.length > MAX_IMAGES) {
        return NextResponse.json(
          { error: `图片最多上传 ${MAX_IMAGES} 张` },
          { status: 400 },
        )
      }
      for (const img of rawImages) {
        if (typeof img !== 'string' || !img.startsWith('data:image/')) {
          return NextResponse.json(
            { error: '图片格式不正确，需为 data:image/ 开头的 data URI' },
            { status: 400 },
          )
        }
        if (img.length > MAX_IMAGE_B64_LENGTH) {
          return NextResponse.json(
            { error: '单张图片过大（base64 超过 400KB），请压缩后重试' },
            { status: 400 },
          )
        }
      }
      images = rawImages as string[]
    }

    if (!content.trim() && images.length === 0) {
      return NextResponse.json({ error: '课文内容不能为空' }, { status: 400 })
    }

    const system = `你是语文老师。${
      images.length > 0
        ? '请先用 OCR 识别用户上传图片中的文字内容，与用户提供的文字（如有）合并后，'
        : '请从课文原文中'
    }提炼 6 到 12 个适合用来出题的知识点。每个知识点用一句简洁的话概括（25 字以内）。重要程度标注规则：importance="core" 表示核心考点（中心思想、必背字词、关键句意等必须掌握的内容）；importance="secondary" 表示次要知识点（背景、细节、扩展信息）。角度尽量覆盖全面：字词、句意、段落大意、主旨、修辞、文学常识等。只返回严格 JSON，格式：{"points":[{"text":"知识点描述","importance":"core"}]}，不要任何解释。`

    const user = content.trim()
      ? `课文：\n${imageRefsToTextHints(content).slice(0, MAX_CONTENT)}`
      : '（用户未提供文字，请先识别图片中的文字作为课文内容，再据此提炼知识点。）'

    // images 挂在 user 消息上 — chatComplete 自动升级为视觉请求。
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      images.length > 0
        ? { role: 'user', content: user, images }
        : { role: 'user', content: user },
    ]

    const config = await getAIConfig()
    const raw = await chatComplete(messages, config)
    const parsed = extractJSON<{ points?: { text?: unknown; importance?: unknown }[] }>(raw)
    const list = Array.isArray(parsed?.points) ? parsed.points : []

    const seen = new Set<string>()
    const points: { text: string; importance: 'core' | 'secondary' }[] = []
    for (const p of list) {
      const text =
        typeof p?.text === 'string' ? p.text.trim().replace(/\s+/g, ' ').slice(0, 80) : ''
      if (!text || seen.has(text)) continue
      seen.add(text)
      points.push({ text, importance: p?.importance === 'core' ? 'core' : 'secondary' })
      if (points.length >= MAX_POINTS) break
    }

    return NextResponse.json({ points })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/quiz-points] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
