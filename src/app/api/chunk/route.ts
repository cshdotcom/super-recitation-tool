// AI semantic chunking (AI快速分块).
// POST /api/chunk   { content: string } -> { chunks: string[] }
// Splits the text into 1-3 sentence semantic blocks via LLM, with a
// deterministic sentence-group fallback when the model fails.
import { NextRequest, NextResponse } from 'next/server'
import { chatComplete, extractJSON } from '@/lib/ai'
import { getAIConfig } from '@/lib/settings'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const content: string = typeof body?.content === 'string' ? body.content : ''
    if (!content.trim()) {
      return NextResponse.json({ error: '内容不能为空' }, { status: 400 })
    }

    const truncated = content.slice(0, 3000)
    const messages = [
      {
        role: 'system' as const,
        content:
          '你是语文老师。请把下面这段课文按语义分成若干块，每块包含1-3句完整的话，块的数量在3到12之间。不要改动原文文字，只做切分。只返回JSON数组（元素为字符串，按原文顺序），不要任何解释。',
      },
      { role: 'user' as const, content: truncated },
    ]

    let chunks: string[] = []
    try {
      const config = await getAIConfig()
      const raw = await chatComplete(messages, config)
      chunks = extractJSON<string[]>(raw)
      if (!Array.isArray(chunks)) chunks = []
      chunks = chunks
        .filter((c) => typeof c === 'string' && c.trim().length > 0)
        .map((c) => c.trim())
    } catch (err: unknown) {
      console.warn('[POST /api/chunk] AI parse failed, fallback:', err)
    }

    // Deterministic fallback: group sentences in pairs.
    if (chunks.length < 2) {
      const sentences = truncated.match(/[^。！？!?.\n]+[。！？!?.\n]?/g) || [truncated]
      chunks = []
      for (let i = 0; i < sentences.length; i += 2) {
        const group = sentences.slice(i, i + 2).join('')
        if (group.trim()) chunks.push(group.trim())
      }
    }

    return NextResponse.json({ chunks })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/chunk] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
