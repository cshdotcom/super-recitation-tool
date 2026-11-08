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
  config?: AIConfig
): Promise<string> {
  const vision = hasImages(messages)
  const payloadMessages = toOpenAIMessages(messages)

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

  // Default: z-ai SDK
  const zai = await getZAI()
  if (vision) {
    const completion = await zai.chat.completions.createVision({
      messages: payloadMessages,
      thinking: { type: 'disabled' },
    } as CreateVisionBody)
    return completion.choices?.[0]?.message?.content ?? ''
  }
  const completion = await zai.chat.completions.create({
    messages: messages as never,
    thinking: { type: 'disabled' },
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
