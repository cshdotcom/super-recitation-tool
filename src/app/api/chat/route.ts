// AI chat endpoints — supervise (recitation coach) and ask (comprehension).
// POST /api/chat   { mode: 'supervise' | 'ask', messages: ChatMessage[], content: string }
import { NextRequest, NextResponse } from 'next/server'
import { chatComplete } from '@/lib/ai'
import { getAIConfig } from '@/lib/settings'
import type { ChatMessage } from '@/lib/types'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const content: string = typeof body?.content === 'string' ? body.content : ''
    if (!content.trim()) {
      return NextResponse.json({ error: '课文内容不能为空' }, { status: 400 })
    }
    const mode: 'supervise' | 'ask' =
      body?.mode === 'ask' ? 'ask' : 'supervise'

    const incomingMessages: ChatMessage[] = Array.isArray(body?.messages)
      ? body.messages
          .filter(
            (m: unknown): m is ChatMessage =>
              !!m &&
              typeof m === 'object' &&
              (m as ChatMessage).role !== undefined &&
              typeof (m as ChatMessage).content === 'string'
          )
          .map((m) => ({
            role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
            content: m.content,
          }))
      : []

    const systemPrompt =
      mode === 'supervise'
        ? `你是一位严格而鼓励人的背书督背老师。用户正在背诵下面这段课文原文。任务：1) 引导用户逐句逐段背诵；2) 对照原文检查用户背诵，精确指出漏字、错字、多字；3) 多给提示而非直接给完整答案，除非用户明确说"想不起来"；4) 适时鼓励。每次回复简短，不超过180字。\n\n【课文原文】\n${content}`
        : `你是这篇课文的阅读理解助手。根据下面这段课文原文回答用户的问题，帮助理解内容、主旨、写作手法、字词含义等。回答简明准确，不超过300字。\n\n【课文原文】\n${content}`

    const finalMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
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
