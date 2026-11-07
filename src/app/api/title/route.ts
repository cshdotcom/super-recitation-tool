// Auto title generation.
// POST /api/title   { content: string } -> { title: string }
import { NextRequest, NextResponse } from 'next/server'
import { chatComplete } from '@/lib/ai'
import { getAIConfig } from '@/lib/settings'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const content: string = typeof body?.content === 'string' ? body.content : ''
    if (!content.trim()) {
      return NextResponse.json({ error: '内容不能为空' }, { status: 400 })
    }

    const messages = [
      {
        role: 'system' as const,
        content:
          '请为下面这段文字生成一个简短的中文标题，不超过12个字，概括核心内容。只返回标题文字本身，不要引号、不要解释、不要标点结尾。',
      },
      { role: 'user' as const, content: content.slice(0, 800) },
    ]

    const config = await getAIConfig()
    const raw = await chatComplete(messages, config)
    const cleaned = (raw || '')
      .trim()
      .replace(/^["“『「『]+|["”』」』]+$/g, '')
      .replace(/[\r\n]+/g, ' ')
      .trim()
    return NextResponse.json({ title: cleaned.slice(0, 30) })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/title] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
