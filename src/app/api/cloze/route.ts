// AI auto cloze keyword extraction.
// POST /api/cloze   { content: string } -> { keywords: string[] }
import { NextRequest, NextResponse } from 'next/server'
import { chatComplete, extractJSON } from '@/lib/ai'
import { getAIConfig } from '@/lib/settings'
import { ruleCloze } from '@/lib/cloze'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const content: string = typeof body?.content === 'string' ? body.content : ''
    if (!content.trim()) {
      return NextResponse.json({ error: '内容不能为空' }, { status: 400 })
    }
    // Too short to extract meaningful keywords.
    if (content.length < 20) {
      return NextResponse.json({ keywords: [] })
    }

    const truncated = content.slice(0, 3000)
    const messages = [
      {
        role: 'system' as const,
        content:
          '你是语文背书助手。请从下面这段文字中挑选出最适合用于"挖空背诵"的关键词语（名词、动词、形容词、成语、专有名词、数字、人名地名等）。数量约为文字长度的15%-25%，最少4个最多40个。只返回一个JSON数组（元素为字符串），不要任何解释或前后缀。',
      },
      { role: 'user' as const, content: truncated },
    ]

    let keywords: string[] = []
    try {
      const config = await getAIConfig()
      const raw = await chatComplete(messages, config)
      keywords = extractJSON<string[]>(raw)
      if (!Array.isArray(keywords)) keywords = []
      keywords = keywords
        .filter((k) => typeof k === 'string' && k.trim().length > 0)
        .map((k) => k.trim())
        .slice(0, 40)
    } catch (err: unknown) {
      console.warn('[POST /api/cloze] AI parse failed, fallback to ruleCloze:', err)
      keywords = ruleCloze(content, 4)
    }

    return NextResponse.json({ keywords })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/cloze] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
