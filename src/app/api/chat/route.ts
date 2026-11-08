// AI chat endpoints — supervise (recitation coach) and ask (comprehension).
// POST /api/chat   { mode: 'supervise' | 'ask', messages: ChatMessage[], content: string }
//
// Vision: each incoming user message may carry `images: string[]` (data URIs).
// Validation: every entry must be a `data:image/` URI, max 4 images per
// message, each base64 payload <= 2MB — otherwise 400. Valid images are
// forwarded through chatComplete (vision-capable payload, see src/lib/ai.ts).
import { NextRequest, NextResponse } from 'next/server'
import { chatComplete } from '@/lib/ai'
import { getAIConfig } from '@/lib/settings'
import type { ChatMessage } from '@/lib/types'

const MAX_IMAGES_PER_MESSAGE = 4
// Base64 character cap per image (≈1.5MB of binary).
const MAX_IMAGE_B64_LENGTH = 2 * 1024 * 1024

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))

    // ---- AI 改题模式：判断学生答案是否可接受（规则匹配过严时的人工兜底） ----
    // 输入 { mode:'grade', question, userAnswer, correctAnswer, type, options? }
    // 输出 { right: boolean, reason: string }
    if (body?.mode === 'grade') {
      const question: string = typeof body?.question === 'string' ? body.question : ''
      const userAnswer: string = typeof body?.userAnswer === 'string' ? body.userAnswer : ''
      const correctAnswer: string = typeof body?.correctAnswer === 'string' ? body.correctAnswer : ''
      const type: string = typeof body?.type === 'string' ? body.type : ''
      if (!question || !correctAnswer) {
        return NextResponse.json({ error: '题目与正确答案不能为空' }, { status: 400 })
      }
      const optionsPart = Array.isArray(body?.options) && body.options.length > 0
        ? `\n选项：${(body.options as string[]).map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('  ')}`
        : ''
      const gradeSystem = `你是严谨的语文判题老师。判断学生的回答相对于标准答案是否正确。
规则：
- 选择题/判断题：答案与标准答案一致才算对（选项文本等价即可，如「A」等价于选项A的全文）。
- 填空题：答案的核心含义与标准答案一致即可，允许标点、同义词、近义表述差异（如「因为」≈「由于」、「地」≈「的」在合理语境下）。
- 简答题：要点覆盖即算对，不要求字面一致；只要学生答出标准答案的关键信息即判对。
- 完全无关/答非所问/空白 → 错。
只返回严格 JSON：{"right": true或false, "reason": "一句话说明判定依据"}，不要任何额外解释。`
      const userMsg = `题型：${type || '未标注'}${optionsPart}
题目：${question}
标准答案：${correctAnswer}
学生答案：${userAnswer || '（未作答）'}
请判定。`
      const config = await getAIConfig()
      const reply = await chatComplete(
        [
          { role: 'system', content: gradeSystem },
          { role: 'user', content: userMsg },
        ],
        config,
      )
      // 从回复里提取 JSON（容忍 ```json 围栏）
      const m = reply.match(/\{[\s\S]*\}/)
      let right = false
      let reason = 'AI 已判定'
      if (m) {
        try {
          const parsed = JSON.parse(m[0]) as { right?: unknown; reason?: unknown }
          right = parsed.right === true
          if (typeof parsed.reason === 'string') reason = parsed.reason
        } catch {
          /* 解析失败用默认值 */
        }
      }
      return NextResponse.json({ right, reason })
    }

    const content: string = typeof body?.content === 'string' ? body.content : ''
    if (!content.trim()) {
      return NextResponse.json({ error: '课文内容不能为空' }, { status: 400 })
    }
    const mode: 'supervise' | 'ask' =
      body?.mode === 'ask' ? 'ask' : 'supervise'

    const rawMessages: unknown[] = Array.isArray(body?.messages)
      ? body.messages
      : []

    // Validate optional per-message image attachments before mapping.
    for (const m of rawMessages) {
      const images = (m as { images?: unknown } | null)?.images
      if (images == null) continue
      if (!Array.isArray(images)) {
        return NextResponse.json(
          { error: '图片格式不正确，需为 data:image/ 开头的 data URI 数组' },
          { status: 400 }
        )
      }
      if (images.length === 0) continue
      if (images.length > MAX_IMAGES_PER_MESSAGE) {
        return NextResponse.json(
          { error: `每条消息最多附带 ${MAX_IMAGES_PER_MESSAGE} 张图片` },
          { status: 400 }
        )
      }
      if (
        images.some(
          (img) => typeof img !== 'string' || !img.startsWith('data:image/')
        )
      ) {
        return NextResponse.json(
          { error: '图片格式不正确，需为 data:image/ 开头的 data URI' },
          { status: 400 }
        )
      }
      if (images.some((img) => (img as string).length > MAX_IMAGE_B64_LENGTH)) {
        return NextResponse.json(
          { error: '单张图片过大（base64 超过 2MB）' },
          { status: 400 }
        )
      }
    }

    const incomingMessages: ChatMessage[] = rawMessages
      .filter(
        (m: unknown): m is ChatMessage =>
          !!m &&
          typeof m === 'object' &&
          (m as ChatMessage).role !== undefined &&
          typeof (m as ChatMessage).content === 'string'
      )
      .map((m) => {
        const role =
          m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user'
        // Images ride on user messages only (already validated above).
        const images = (m as { images?: unknown }).images
        if (
          role === 'user' &&
          Array.isArray(images) &&
          images.length > 0
        ) {
          return { role, content: m.content, images: images as string[] }
        }
        return { role, content: m.content }
      })

    // ```ask block spec (rendered as a visual question card by the frontend):
    // the AI may end a reply with a fenced `ask` block containing JSON
    // {"question":"…","options":["…","…"]} when it needs the user to pick.
    const ASK_PROMPT = `\n\n【可视化提问】当且仅当你需要用户在几个明确选项中做选择时，可以在回复的最末尾追加一个 ask 代码块，格式严格如下：\n\`\`\`ask\n{"question":"你想先弄懂哪一部分？","options":["第一段的论点","文章主旨","某个词语含义"]}\n\`\`\`\n要求：question 一句话；options 为 2~4 个简短选项；ask 块只能作为回复结尾出现且最多一个；不需要提问时千万不要输出该代码块。`

    // 富格式能力告知：前端 RichContent 会原样渲染以下全部格式。
    const FORMAT_PROMPT = `\n\n【输出格式】你的回复会原样渲染，可按需使用最清晰的表达格式：Markdown（标题/列表/表格/加粗）、LaTeX 公式（行内 $...$、展示 $$...$$，支持化学式 \\ce{}）、mermaid 图表（\`\`\`mermaid 代码块：mindmap 思维导图 / 树状图 / 流程图 / 时序图）、HTML 片段、代码块。讲解结构、层次、流程时优先用 mermaid 思维导图或表格；纯文字能说清时不必强用格式。`

    const systemPrompt =
      mode === 'supervise'
        ? `你是一位严格而鼓励人的背书督背老师。用户正在背诵下面这段课文原文。任务：1) 引导用户逐句逐段背诵；2) 对照原文检查用户背诵，精确指出漏字、错字、多字；3) 多给提示而非直接给完整答案，除非用户明确说"想不起来"；4) 适时鼓励。每次回复简短，不超过180字。\n\n【课文原文】\n${content}${FORMAT_PROMPT}${ASK_PROMPT}`
        : `你是这篇课文的阅读理解助手。根据下面这段课文原文回答用户的问题，帮助理解内容、主旨、写作手法、字词含义等。回答简明准确，不超过300字。\n\n【课文原文】\n${content}${FORMAT_PROMPT}${ASK_PROMPT}`

    // 上游要求至少一条 user 消息：空对话历史时补一条开场白，
    // 避免只有 system 消息导致 API 400（messages 参数非法）。
    const opener: ChatMessage[] =
      incomingMessages.length === 0
        ? [
            {
              role: 'user',
              content:
                mode === 'supervise'
                  ? '老师好，请开始引导我背诵这篇课文。'
                  : '请根据这篇课文给我讲讲主旨和重点，并向我提一个理解检查问题。',
            },
          ]
        : []

    const finalMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...opener,
      ...incomingMessages,
    ]

    const config = await getAIConfig()
    const reply = await chatComplete(finalMessages, config)
    return NextResponse.json({ reply })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/chat] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
