// AI auto cloze keyword extraction.
// POST /api/cloze   { content: string } -> { keywords: string[] }
import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { chatComplete, extractJSON } from '@/lib/ai'
import { getAIConfig } from '@/lib/settings'
import { ruleCloze, kwText } from '@/lib/cloze'
import type { KwEntry } from '@/lib/types'

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
          '你是语文背书助手的挖空专家。请从下面的文字中挑选出最适合"挖空背诵"的关键片段。要求：\n' +
          '1. 每个片段必须是原文中【连续且逐字存在】的子串（2-10个字），优先：名词短语、动词短语、成语、专有名词、人名、地名、书名、数字、核心论点词组。\n' +
          '2. 不要挑虚词（的/了/是/在/和/我们）、不要挑标点、不要挑重复出现的普通单字。\n' +
          '3. 片段数量约为全文总字数的 10%-18%，最少 4 个，最多 50 个，按在原文中出现的顺序排列，去重。\n' +
          '4. 只返回一个 JSON 字符串数组，不要任何解释、不要 markdown 代码块。',
      },
      { role: 'user' as const, content: truncated },
    ]

    let keywords: KwEntry[] = []
    try {
      const config = await getAIConfig()
      const raw = await chatComplete(messages, config)
      const parsed = extractJSON<string[]>(raw)
      keywords = Array.isArray(parsed) ? parsed : []
      // 严格校验：必须是原文的精确子串、长度合理、非纯标点 —— 保证挖空一定命中。
      const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/g
      keywords = Array.from(
        new Set(
          keywords
            .filter((k): k is string => typeof k === 'string')
            .map((k) => k.trim())
            .filter((k) => k.length >= 1 && k.length <= 12)
            .filter((k) => content.includes(k))
            .filter((k) => (k.match(CJK_RE) || []).length >= 1 || /[a-zA-Z0-9]/.test(k)),
        ),
      ).slice(0, 50)
      // 去掉互为子串的冗余项（保留更长的片段）。
      const sorted = [...keywords].sort(
        (a, b) => kwText(b).length - kwText(a).length,
      )
      const kept: string[] = []
      for (const k of sorted) {
        const kt = kwText(k)
        if (!kept.some((x) => x.includes(kt))) kept.push(kt)
      }
      keywords = kept
        .sort((a, b) => content.indexOf(a) - content.indexOf(b))
        .slice(0, 50)
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
