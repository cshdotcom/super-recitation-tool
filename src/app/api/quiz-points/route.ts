// AI knowledge-point extraction — Step 1 of the two-step quiz flow.
// POST /api/quiz-points  { content } -> { points: [{ text, importance: 'core' | 'secondary' }] }
import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { chatComplete, extractJSON } from '@/lib/ai'
import { getAIConfig } from '@/lib/settings'

const MAX_CONTENT = 6000
const MAX_POINTS = 12

export async function POST(req: NextRequest) {
  try {
    const account = await getSessionUser()
    if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const content: string = typeof body?.content === 'string' ? body.content : ''
    if (!content.trim()) {
      return NextResponse.json({ error: '课文内容不能为空' }, { status: 400 })
    }

    const system = `你是语文老师。请从课文原文中提炼 6 到 12 个适合用来出题的知识点。每个知识点用一句简洁的话概括（25 字以内）。重要程度标注规则：importance="core" 表示核心考点（中心思想、必背字词、关键句意等必须掌握的内容）；importance="secondary" 表示次要知识点（背景、细节、扩展信息）。角度尽量覆盖全面：字词、句意、段落大意、主旨、修辞、文学常识等。只返回严格 JSON，格式：{"points":[{"text":"知识点描述","importance":"core"}]}，不要任何解释。`
    const user = `课文：\n${content.slice(0, MAX_CONTENT)}`

    const messages = [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: user },
    ]

    const config = await getAIConfig()
    const raw = await chatComplete(messages, config)
    const parsed = extractJSON<{ points?: { text?: unknown; importance?: unknown }[] }>(raw)
    const list = Array.isArray(parsed?.points) ? parsed.points : []

    const seen = new Set<string>()
    const points: { text: string; importance: 'core' | 'secondary' }[] = []
    for (const p of list) {
      const text =
        typeof p?.text === 'string' ? p.text.trim().replace(/\s+/g, ' ').slice(0, 80) : ''
      if (!text || seen.has(text)) continue
      seen.add(text)
      points.push({ text, importance: p?.importance === 'core' ? 'core' : 'secondary' })
      if (points.length >= MAX_POINTS) break
    }

    return NextResponse.json({ points })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/quiz-points] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
