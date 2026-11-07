// LLM abstraction layer.
// Supports two providers:
//   1. "zai"  -> z-ai-web-dev-sdk (default)
//   2. "custom" -> any OpenAI-compatible /chat/completions endpoint
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

export async function chatComplete(
  messages: ChatMessage[],
  config?: AIConfig
): Promise<string> {
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
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
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
  const completion = await zai.chat.completions.create({
    messages: messages as never,
    thinking: { type: 'disabled' },
  })
  return completion.choices[0]?.message?.content ?? ''
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
  if (startIdx === -1) throw new Error('未在响应中找到 JSON')
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
  if (endIdx === -1) throw new Error('JSON 括号未闭合')
  return JSON.parse(t.slice(startIdx, endIdx + 1)) as T
}
