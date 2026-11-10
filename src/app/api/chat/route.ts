// AI chat endpoints — supervise (recitation coach) and ask (comprehension).
// POST /api/chat   { mode: 'supervise' | 'ask', messages: ChatMessage[], content: string }
//
// Vision: each incoming user message may carry `images: string[]` (data URIs).
// Validation: every entry must be a `data:image/` URI, max 4 images per
// message, each base64 payload <= 2MB — otherwise 400. Valid images are
// forwarded through chatComplete (vision-capable payload, see src/lib/ai.ts).
import { NextRequest, NextResponse } from 'next/server'
import { chatComplete, type ChatOptions } from '@/lib/ai'
import { getAIConfig } from '@/lib/settings'
import { db } from '@/lib/db'
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
- reason 为一句话中文说明；如涉及数学式可用 LaTeX（$...$ 行内写法），但不要使用表格、图表、代码块等多行格式，确保返回的是合法 JSON。
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

    // ---- 举一反三模式：根据原题生成 N 道相似变式题 ----
    // 输入 { mode:'extend', items: [{question, answer, type?}], count?: number }
    // 输出 { text } — Markdown 编号题目+答案（富媒体渲染）
    if (body?.mode === 'extend') {
      const items = Array.isArray(body?.items)
        ? (body.items as Record<string, unknown>[])
            .map((q) => ({
              question: typeof q?.question === 'string' ? q.question : '',
              answer: typeof q?.answer === 'string' ? q.answer : '',
              type: typeof q?.type === 'string' ? q.type : '',
            }))
            .filter((q) => q.question)
            .slice(0, 8)
        : []
      const count = typeof body?.count === 'number' ? Math.min(10, Math.max(1, Math.round(body.count))) : 3
      if (items.length === 0) {
        return NextResponse.json({ error: '缺少原题' }, { status: 400 })
      }
      const FORMAT_PROMPT_EXT = `输出格式：你的回复会原样渲染，可以使用富文本格式——**加粗**、markdown 表格、LaTeX 公式（$行内$ / $$独立$$，数学/物理/化学题答案必须用 LaTeX）、mermaid 思维导图（\`\`\`mermaid 代码块，适合知识结构梳理）、HTML 片段、SVG、代码块。不要输出图片外链。`
      const sys = `你是优秀的语文/背诵出题老师。根据给出的原题，举一反三生成新题。要求：
- 新题与原题考查相同知识点但角度不同（换语境/换问法/逆向提问）
- 每题附标准答案与简要解析
- 难度与原题相当
${FORMAT_PROMPT_EXT}
输出格式（严格遵循）：
## 第1题
**题目：** ...
**答案：** ...
**解析：** ...
## 第2题
...`
      const userMsg = `原题${items.length > 1 ? `（共${items.length}道）` : ''}：
${items.map((q, i) => `${i + 1}. [${q.type || '未标注'}] ${q.question}\n答案：${q.answer}`).join('\n\n')}

请生成 ${count} 道举一反三的新题。`
      const config = await getAIConfig()
      const reply = await chatComplete(
        [
          { role: 'system', content: sys },
          { role: 'user', content: userMsg },
        ],
        config,
      )
      return NextResponse.json({ text: reply })
    }

    // ---- AI解析模式：对题目/收藏内容做深度讲解 ----
    // 输入 { mode:'analyze', question, answer?, context?, extra? }
    // 输出 { text } — 富媒体讲解（SVG/mindmap/MD/LaTeX/HTML/代码块）
    if (body?.mode === 'analyze') {
      const question: string = typeof body?.question === 'string' ? body.question : ''
      const answer: string = typeof body?.answer === 'string' ? body.answer : ''
      const context: string = typeof body?.context === 'string' ? body.context : ''
      const extra: string = typeof body?.extra === 'string' ? body.extra : ''
      if (!question.trim()) {
        return NextResponse.json({ error: '解析内容不能为空' }, { status: 400 })
      }
      const FORMAT_PROMPT_AN = `输出格式：你的回复会原样渲染，可以使用富文本格式——**加粗**、markdown 表格、LaTeX 公式（$行内$ / $$独立$$，支持化学式 \\ce{}，数学/物理/化学题答案必须用 LaTeX）、mermaid 思维导图（\`\`\`mermaid 代码块，适合知识结构梳理）、SVG（\`\`\`svg 代码块或 <svg>）、HTML 片段、代码块。讲解结构、层次、流程时优先用 mermaid 思维导图或表格。不要输出图片外链。`
      const sys = `你是耐心的全能学科讲解老师。对给出的题目/内容做深度解析，帮助学生真正理解：
- 讲清考点、解题思路（分步骤）
- 易错点提醒、相关知识拓展
- 必要时用思维导图/表格/公式辅助讲解
${FORMAT_PROMPT_AN}`
      const userMsg = `${context ? `【课文上下文】\n${context.slice(0, 3000)}\n\n` : ''}【题目/内容】\n${question}${answer ? `\n\n【标准答案】\n${answer}` : ''}${extra ? `\n\n【补充要求】\n${extra}` : '\n\n请给出完整解析。'}`
      const config = await getAIConfig()
      const reply = await chatComplete(
        [
          { role: 'system', content: sys },
          { role: 'user', content: userMsg },
        ],
        config,
      )
      return NextResponse.json({ text: reply })
    }

    // ---- 智能选题模式：从题库中挑选最有价值的 N 题 ----
    // 输入 { mode:'pick', questions: [{question, reason?}], count }
    // 输出 { indices: number[] } — 选中题目的下标（0-based）
    if (body?.mode === 'pick') {
      const questions = Array.isArray(body?.questions)
        ? (body.questions as unknown[]).map((q) => (typeof q === 'string' ? q : typeof (q as Record<string, unknown>)?.question === 'string' ? String((q as Record<string, unknown>).question) : '')).slice(0, 120)
        : []
      const count = typeof body?.count === 'number' ? Math.min(50, Math.max(1, Math.round(body.count))) : 10
      if (questions.length === 0) {
        return NextResponse.json({ error: '缺少题目列表' }, { status: 400 })
      }
      const sys = `你是智能选题老师。从题目列表中挑选最值得练习的题：优先选高频考点、易错点、经典题型、覆盖不同知识点。只返回严格 JSON：{"indices":[选中的题目下标数组]}，下标从0开始，最多选 ${Math.min(count, questions.length)} 题，不要任何解释。`
      const userMsg = `题目列表：\n${questions.map((q, i) => `${i}. ${q.slice(0, 120)}`).join('\n')}\n\n请挑选 ${count} 题。`
      const config = await getAIConfig()
      const reply = await chatComplete(
        [
          { role: 'system', content: sys },
          { role: 'user', content: userMsg },
        ],
        config,
      )
      const m = reply.match(/\{[\s\S]*\}/)
      let indices: number[] = []
      if (m) {
        try {
          const parsed = JSON.parse(m[0]) as { indices?: unknown }
          if (Array.isArray(parsed.indices)) {
            indices = parsed.indices
              .map((x) => (typeof x === 'number' ? x : parseInt(String(x), 10)))
              .filter((x) => Number.isInteger(x) && x >= 0 && x < questions.length)
              .slice(0, count)
          }
        } catch {
          /* 解析失败返回空 */
        }
      }
      if (indices.length === 0) {
        // 兜底：均匀取样
        const step = Math.max(1, Math.floor(questions.length / count))
        for (let i = 0; i < questions.length && indices.length < count; i += step) indices.push(i)
      }
      return NextResponse.json({ indices: Array.from(new Set(indices)) })
    }

    // ---- 素材生成模式：根据课文生成问答记忆素材 blocks ----
    // 输入 { mode:'blocks', content, count? }
    // 输出 { blocks: [{front, back}] }
    if (body?.mode === 'blocks') {
      const src: string = typeof body?.content === 'string' ? body.content : ''
      const count = typeof body?.count === 'number' ? Math.min(10, Math.max(1, Math.round(body.count))) : 5
      if (!src.trim()) {
        return NextResponse.json({ error: '课文内容不能为空' }, { status: 400 })
      }
      const sys = `你是背诵素材整理助手。根据课文内容生成问答式记忆素材（正面是问题/提示，背面是答案/原文）。
只返回严格 JSON：{"blocks":[{"front":"问题或提示","back":"答案或原文"}]}，不要任何额外解释。front 简短（≤30字），back 精准摘自或概括课文。`
      const userMsg = `【课文内容】\n${src.slice(0, 6000)}\n\n请生成 ${count} 组问答素材。`
      const config = await getAIConfig()
      const reply = await chatComplete(
        [
          { role: 'system', content: sys },
          { role: 'user', content: userMsg },
        ],
        config,
      )
      const m = reply.match(/\{[\s\S]*\}/)
      let blocks: Array<{ front: string; back: string }> = []
      if (m) {
        try {
          const parsed = JSON.parse(m[0]) as { blocks?: unknown }
          if (Array.isArray(parsed.blocks)) {
            blocks = (parsed.blocks as Record<string, unknown>[])
              .map((b) => ({
                front: typeof b?.front === 'string' ? b.front.slice(0, 200) : '',
                back: typeof b?.back === 'string' ? b.back.slice(0, 2000) : '',
              }))
              .filter((b) => b.front && b.back)
              .slice(0, count)
          }
        } catch {
          /* 解析失败返回空 */
        }
      }
      if (blocks.length === 0) {
        return NextResponse.json({ error: 'AI 生成素材失败，请重试' }, { status: 502 })
      }
      return NextResponse.json({ blocks })
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

    // ---- AI 对话全局配置（设置页「AI 对话配置」卡片，服务端持久化）----
    // aiSystemPrompt 前置 / aiRules 追加到系统提示词；aiSelfThinking 开启时
    // 要求模型先在 <thinking>…</thinking> 内简短思考；温度/最大 tokens 透传
    // 给 chatComplete（未设置时用服务端默认）。body.selfThinking（可选布尔）
    // 可对单次请求覆盖自我思考设置（追问弹层「仅本次」开关）。
    let systemPromptFinal = systemPrompt
    const aiChatOptions: ChatOptions = {}
    const reqSelfThinking =
      typeof body?.selfThinking === 'boolean' ? (body.selfThinking as boolean) : null
    try {
      const row = await db.settings.findUnique({ where: { id: 'singleton' } })
      const customSystem =
        typeof row?.aiSystemPrompt === 'string' ? row.aiSystemPrompt.trim() : ''
      const customRules =
        typeof row?.aiRules === 'string' ? row.aiRules.trim() : ''
      const wantThinking =
        reqSelfThinking === true ||
        (reqSelfThinking === null && row?.aiSelfThinking === true)
      if (customSystem || customRules || wantThinking) {
        const parts: string[] = []
        if (customSystem) parts.push(customSystem)
        parts.push(systemPrompt)
        if (wantThinking) {
          parts.push(
            '【自我思考】回答前先在 <thinking>…</thinking> 块内用几句话简要思考（梳理问题、回忆原文相关片段），然后另起一行给出正式回答。思考块要简短，正式回答不要重复思考内容。',
          )
        }
        if (customRules) parts.push(`【自定义规则】\n${customRules}`)
        systemPromptFinal = parts.join('\n\n')
      }
      if (typeof row?.aiTemperature === 'number' && Number.isFinite(row.aiTemperature)) {
        aiChatOptions.temperature = row.aiTemperature
      }
      if (typeof row?.aiMaxTokens === 'number' && Number.isFinite(row.aiMaxTokens)) {
        aiChatOptions.maxTokens = row.aiMaxTokens
      }
    } catch {
      /* 设置读取失败 → 走默认配置，不影响对话 */
    }

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
      { role: 'system', content: systemPromptFinal },
      ...opener,
      ...incomingMessages,
    ]

    const config = await getAIConfig()
    const reply = await chatComplete(finalMessages, config, aiChatOptions)
    return NextResponse.json({ reply })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/chat] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
