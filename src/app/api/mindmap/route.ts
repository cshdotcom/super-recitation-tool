// Mind-map generation.
// POST /api/mindmap   { content } -> { mindmap: MindNode }
import { NextRequest, NextResponse } from 'next/server'
import { chatComplete, extractJSON } from '@/lib/ai'
import { getAIConfig } from '@/lib/settings'
import type { MindNode } from '@/lib/types'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const content: string = typeof body?.content === 'string' ? body.content : ''
    if (!content.trim()) {
      return NextResponse.json({ error: '课文内容不能为空' }, { status: 400 })
    }

    const messages = [
      {
        role: 'system' as const,
        content:
          '请为下面这段文字生成思维导图的层级结构。要求：中心主题作为根title；提取2-4个一级分支；每个分支可有2-4个二级子节点；最多2层children。只返回JSON：{"title":"中心主题","children":[{"title":"分支","children":[{"title":"子节点"}]}]}，不要解释。',
      },
      { role: 'user' as const, content: content.slice(0, 2000) },
    ]

    const config = await getAIConfig()
    const raw = await chatComplete(messages, config)
    const mindmap = extractJSON<MindNode>(raw)
    return NextResponse.json({ mindmap })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/mindmap] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
