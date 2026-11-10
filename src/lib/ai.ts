// LLM abstraction layer.
// Supports two providers:
//   1. "zai"    -> z-ai-web-dev-sdk (default)
//   2. "custom" -> any OpenAI-compatible /chat/completions endpoint
//
// Vision: a ChatMessage may carry `images: string[]` (data URIs). When any
// message has images the request is upgraded to a multimodal payload —
// OpenAI-style `{type:'text'}/{type:'image_url'}` content parts for "custom",
// `zai.chat.completions.createVision` for "zai". Text-only requests keep the
// exact previous behaviour on both providers.
//
// This lets the user plug in their own third-party model API while still
// using the z-ai SDK for everything else (VLM/OCR, TTS, ASR).
// MUST only be imported by server-side code.
import { getZAI } from './zai'
import type { ChatMessage } from './types'

export interface AIConfig {
  provider: 'zai' | 'custom'
  baseURL?: string
  apiKey?: string
  model?: string
}

/** 采样参数（可选）：AI 对话全局配置的温度 / 最大回复长度。
 *  未传或非有限数时走服务端默认。 */
export interface ChatOptions {
  /** 采样温度 0~2。 */
  temperature?: number
  /** 最大回复 tokens（64~32768）。 */
  maxTokens?: number
}

/** 规范化采样参数：越界值裁剪，非有限数丢弃（返回不含该键）。 */
function normalizeSampling(options?: ChatOptions): {
  temperature?: number
  max_tokens?: number
} {
  const out: { temperature?: number; max_tokens?: number } = {}
  if (options && typeof options.temperature === 'number' && Number.isFinite(options.temperature)) {
    out.temperature = Math.min(2, Math.max(0, options.temperature))
  }
  if (options && typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens)) {
    out.max_tokens = Math.min(32768, Math.max(64, Math.round(options.maxTokens)))
  }
  return out
}

// ---------- vision helpers ----------

// OpenAI-style multimodal content parts.
type TextPart = { type: 'text'; text: string }
type ImagePart = { type: 'image_url'; image_url: { url: string } }
type ContentPart = TextPart | ImagePart

const IMAGE_DATA_PREFIX = 'data:image/'

// Body shape of the SDK's zai.chat.completions.createVision. Its TS types
// require `model`, but the z-ai backend selects a default vision model when
// it is omitted — per the app contract the body only carries messages +
// thinking, so it is cast to the SDK's parameter type.
type CreateVisionBody = Parameters<
  Awaited<ReturnType<typeof getZAI>>['chat']['completions']['createVision']
>[0]

function isValidImage(img: unknown): img is string {
  return typeof img === 'string' && img.startsWith(IMAGE_DATA_PREFIX)
}

/** Whether any message carries valid data-URI images (→ vision request). */
export function hasImages(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.images) && m.images.some(isValidImage)
  )
}

/**
 * Build OpenAI-compatible message payloads: messages with images become
 * multimodal content arrays, plain messages keep their string content.
 */
function toOpenAIMessages(
  messages: ChatMessage[]
): Array<{ role: ChatMessage['role']; content: string | ContentPart[] }> {
  return messages.map((m) => {
    const images = Array.isArray(m.images)
      ? m.images.filter(isValidImage)
      : []
    if (!images.length) {
      return { role: m.role, content: m.content }
    }
    const content: ContentPart[] = [
      { type: 'text', text: m.content },
      ...images.map(
        (url) => ({ type: 'image_url', image_url: { url } }) as ImagePart
      ),
    ]
    return { role: m.role, content }
  })
}

export async function chatComplete(
  messages: ChatMessage[],
  config?: AIConfig,
  options?: ChatOptions
): Promise<string> {
  const vision = hasImages(messages)
  const payloadMessages = toOpenAIMessages(messages)
  const sampling = normalizeSampling(options)

  // Custom OpenAI-compatible endpoint
  if (
    config &&
    config.provider === 'custom' &&
    config.baseURL &&
    config.apiKey
  ) {
    const url = `${config.baseURL.replace(/\/$/, '')}/chat/completions`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model || 'gpt-4o-mini',
        messages: payloadMessages,
        ...sampling,
      }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`第三方模型请求失败 (${res.status}): ${detail.slice(0, 200)}`)
    }
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new Error('第三方模型返回格式异常')
    }
    return content
  }

  // Default: z-ai SDK（body 带 index signature，额外采样参数原样透传）
  const zai = await getZAI()
  if (vision) {
    const completion = await zai.chat.completions.createVision({
      messages: payloadMessages,
      thinking: { type: 'disabled' },
      ...sampling,
    } as CreateVisionBody)
    return completion.choices?.[0]?.message?.content ?? ''
  }
  const completion = await zai.chat.completions.create({
    messages: messages as never,
    thinking: { type: 'disabled' },
    ...sampling,
  })
  return completion.choices[0]?.message?.content ?? ''
}

/** Repair common LLM JSON mistakes: trailing commas, raw newlines/tabs
 *  inside strings, smart quotes, unescaped control chars. */
function repairJSON(t: string): string {
  let out = ''
  let inStr = false
  let escape = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (inStr) {
      if (escape) {
        out += ch
        escape = false
        continue
      }
      if (ch === '\\') {
        out += ch
        escape = true
        continue
      }
      if (ch === '"') {
        inStr = false
        out += ch
        continue
      }
      if (ch === '\n') {
        out += '\\n'
        continue
      }
      if (ch === '\r') {
        continue
      }
      if (ch === '\t') {
        out += '\\t'
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') {
      inStr = true
      out += ch
      continue
    }
    // Trailing commas: ",}" ",]" ", ," etc. outside strings.
    if (ch === ',' || ch === '}' || ch === ']') {
      if (ch !== ',') {
        // look back: strip trailing commas before this closer
        let j = out.length - 1
        while (j >= 0 && /\s/.test(out[j])) j--
        while (j >= 0 && out[j] === ',') j--
        while (j >= 0 && /\s/.test(out[j])) j--
        out = out.slice(0, j + 1)
      }
      out += ch
      continue
    }
    // Smart quotes → straight quotes (outside strings only)
    if (ch === '\u201c' || ch === '\u201d') {
      out += '"'
      continue
    }
    out += ch
  }
  return out
}

// Robustly extract a JSON object/array from an LLM response that may be
// wrapped in ```json fences or surrounded by prose.
export function extractJSON<T = unknown>(text: string): T {
  let t = (text || '').trim()

  // Strip code fences ```json ... ``` or ``` ... ```
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()

  // Fast path
  try {
    return JSON.parse(t) as T
  } catch {
    /* fall through to balanced extraction */
  }

  const startIdx = t.search(/[[{]/)
  if (startIdx === -1) throw new Error('AI 返回格式异常，请重试')
  const open = t[startIdx]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let endIdx = -1
  let inStr = false
  let escape = false
  for (let i = startIdx; i < t.length; i++) {
    const ch = t[i]
    if (inStr) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') {
      inStr = true
    } else if (ch === open) {
      depth++
    } else if (ch === close) {
      depth--
      if (depth === 0) {
        endIdx = i
        break
      }
    }
  }
  if (endIdx === -1) {
    // Unterminated JSON — close it up and try to salvage.
    const slice = t.slice(startIdx)
    const repaired = repairJSON(slice)
    for (const suffix of [close, '"' + close, '"}]', '"\n}]']) {
      try {
        return JSON.parse(repaired + suffix) as T
      } catch {
        /* keep trying */
      }
    }
    throw new Error('AI 返回内容不完整，请重试')
  }
  const slice = t.slice(startIdx, endIdx + 1)
  try {
    return JSON.parse(slice) as T
  } catch {
    // Balanced but malformed — attempt repair before giving up.
    try {
      return JSON.parse(repairJSON(slice)) as T
    } catch {
      throw new Error('AI 返回格式异常，请重试')
    }
  }
}

/**
 * Last-resort salvage: scan raw LLM output for balanced `{...}` objects that
 * look like quiz questions (contain "question") and parse each one
 * independently. Survives truncated or outer-malformed responses where the
 * whole payload cannot be repaired as a unit.
 */
export function extractQuestionObjects(raw: string): unknown[] {
  const t = raw || ''
  const out: unknown[] = []
  let i = 0
  while (i < t.length) {
    if (t[i] !== '{') {
      i++
      continue
    }
    let depth = 0
    let inStr = false
    let esc = false
    let end = -1
    for (let j = i; j < t.length; j++) {
      const ch = t[j]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
      } else if (ch === '"') {
        inStr = true
      } else if (ch === '{') {
        depth++
      } else if (ch === '}') {
        depth--
        if (depth === 0) {
          end = j
          break
        }
      }
    }
    if (end === -1) break
    const slice = t.slice(i, end + 1)
    if (slice.includes('"question"') || slice.includes('question')) {
      let obj: unknown = null
      try {
        obj = JSON.parse(slice)
      } catch {
        try {
          obj = JSON.parse(repairJSON(slice))
        } catch {
          obj = null
        }
      }
      if (obj && typeof obj === 'object') out.push(obj)
    }
    i = end + 1
  }
  return out
}

// ---------- 富媒体代码生成（/api/media-ai：编辑器 AI 助理 / AI 修复） ----------

export type MediaCodegenKind = 'mermaid' | 'svg' | 'table' | 'formula' | 'code'

export interface MediaCodegenHistoryItem {
  role: 'user' | 'assistant'
  content: string
}

export interface MediaCodegenParams {
  kind: MediaCodegenKind
  /** 现有代码：空 = 从零生成；非空 = 在其基础上按指令修改 */
  currentCode: string
  instruction: string
  /** 最近对话（用户指令 + AI 代码），最多 20 条 */
  history?: MediaCodegenHistoryItem[]
}

const MEDIA_KIND_DESC: Record<MediaCodegenKind, string> = {
  mermaid: 'mermaid 图表源码（mindmap 思维导图 或 graph/flowchart 流程图/树状图）',
  svg: 'SVG 图形源码（单个 <svg>…</svg>，禁止 <script> 与 on* 事件）',
  table: 'markdown 表格源码（| 表头 | … |，含 |---| 分隔行）',
  formula: 'LaTeX 公式源码（不含 $$ / $ 定界符，可用 \\ce{} 化学式）',
  code: '纯代码内容（不带 markdown 围栏）',
}

/** 剥掉 LLM 回复中常见的 markdown 围栏（```lang\n…```），返回纯代码。 */
export function stripCodeFence(text: string): string {
  let t = (text || '').trim()
  if (!t) return ''
  // 1) 完整围栏整体包裹：```lang\n…\n``` → 直接取内容
  const full = t.match(/^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/)
  if (full) return full[1].replace(/\s+$/, '')
  // 2) 前后带解释文字、代码在围栏里：取第一个围栏块的内容
  const anyFence = t.match(/```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```/)
  if (anyFence && anyFence[1].trim() !== '') return anyFence[1].replace(/\s+$/, '')
  // 3) 只开不闭：```lang\n…
  const open = t.match(/^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*)$/)
  if (open) t = open[1]
  // 4) 散落的首尾围栏行
  t = t.replace(/^```[A-Za-z0-9_-]*[ \t]*\r?\n?/, '').replace(/\r?\n?```[ \t]*$/, '')
  return t.trim() !== '' ? t : (text || '').trim()
}

/**
 * 富媒体代码生成/修改（供 /api/media-ai 调用）。
 * 提示词强制「只返回完整最终代码」，服务端再剥一次围栏兜底；
 * 超时控制由调用方（route）用 Promise.race 实现。
 */
export async function mediaCodegen(
  params: MediaCodegenParams,
  config?: AIConfig,
): Promise<string> {
  const kind = params.kind
  const currentCode = (params.currentCode || '').trim()
  const instruction = (params.instruction || '').trim() || '生成一段示例代码'
  const history = (params.history || [])
    .filter(
      (m) =>
        !!m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim() !== '',
    )
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 12000) }))
  const isEdit = currentCode !== ''

  const sys = `你是背诵学习应用的富媒体代码助手，当前任务类型：${MEDIA_KIND_DESC[kind]}。
要求：
- ${
    isEdit
      ? '用户给出了现有代码：在保留其主体结构与内容的前提下，按用户指令做最小必要修改，不要大幅重写。'
      : '用户没有现成代码：按用户指令从零生成完整代码。'
  }
- 只返回最终的完整代码本身：不要任何解释、说明、前后缀文字，不要用代码围栏（\`\`\`）包裹。${
    kind === 'mermaid'
      ? '\n- 输出合法 mermaid 源码，第一行必须是 mindmap 或 graph TD/TB/LR/RL/BT 或 flowchart TD/TB/LR/RL/BT 声明。'
      : ''
  }${
    kind === 'svg'
      ? '\n- 输出单个完整 <svg xmlns="http://www.w3.org/2000/svg" viewBox="…" …>…</svg>，图形布局清晰、大小适中（viewBox 约 600x400）。'
      : ''
  }${
    kind === 'table'
      ? '\n- 输出 markdown 表格：首行表头、第二行 | --- | 分隔行，之后每行一个数据行。'
      : ''
  }${
    kind === 'formula'
      ? '\n- 输出纯 LaTeX 公式源码，绝不包含 $$ 或 $ 定界符。'
      : ''
  }${
    kind === 'code'
      ? '\n- 输出纯代码内容本身（不带围栏、不带语言标注）。'
      : ''
  }
- 内容文字使用中文（代码关键字除外）。`

  const userMsg = `${isEdit ? `【现有代码】\n${currentCode.slice(0, 12000)}\n\n` : ''}【指令】\n${instruction.slice(0, 4000)}`

  const reply = await chatComplete(
    [
      { role: 'system', content: sys },
      ...history,
      { role: 'user', content: userMsg },
    ],
    config,
  )

  let code = stripCodeFence(reply || '')
  if (kind === 'formula') {
    code = code
      .replace(/^\$\$([\s\S]*?)\$\$\s*$/, '$1')
      .replace(/^\$([\s\S]*?)\$\s*$/, '$1')
      .trim()
  }
  if (kind === 'svg') {
    const m = code.match(/<svg[\s\S]*<\/svg\s*>/i)
    if (m) code = m[0]
  }
  return code
}
