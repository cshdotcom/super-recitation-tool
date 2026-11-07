// AI auto cloze keyword extraction.
// POST /api/cloze   { content: string } -> { keywords: string[] }
import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { chatComplete, extractJSON } from '@/lib/ai'
import { getAIConfig } from '@/lib/settings'
import { ruleCloze } from '@/lib/cloze'

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })

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
          '你是语文背书助手。挖空单位是「字」不是词语：请从下面这段文字中挑选出最适合用于"挖空背诵"的关键字，每个元素只放一个汉字（连续的英文单词/数字可作为一个整体元素）。优先挑名词、动词、形容词、成语中的关键字、专有名词、数字、人名地名里的字。数量约为总字数的10%-20%，最少4个最多60个，不要重复。只返回一个JSON数组（元素为字符串），不要任何解释或前后缀。',
      },
      { role: 'user' as const, content: truncated },
    ]

    let keywords: string[] = []
    try {
      const config = await getAIConfig()
      const raw = await chatComplete(messages, config)
      keywords = extractJSON<string[]>(raw)
      if (!Array.isArray(keywords)) keywords = []
      // 挖空单位是字 — split any multi-char CJK keyword the model returned
      // into individual characters so every blank is exactly one 字.
      const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/
      const flat: string[] = []
      for (const k of keywords) {
        if (typeof k !== 'string' || !k.trim()) continue
        const t = k.trim()
        if (CJK_RE.test(t) && t.length > 1) {
          for (const ch of t) flat.push(ch)
        } else {
          flat.push(t)
        }
      }
      keywords = Array.from(new Set(flat)).slice(0, 60)
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
