// Quiz generation.
// POST /api/quiz   { content, keywords?, count? } -> { questions: QuizQuestion[] }
import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { chatComplete, extractJSON } from '@/lib/ai'
import { getAIConfig } from '@/lib/settings'
import type { QuizQuestion } from '@/lib/types'

export async function POST(req: NextRequest) {
  try {
    const account = await getSessionUser()
    if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const content: string = typeof body?.content === 'string' ? body.content : ''
    if (!content.trim()) {
      return NextResponse.json({ error: '课文内容不能为空' }, { status: 400 })
    }
    const keywords: string[] = Array.isArray(body?.keywords)
      ? body.keywords.filter((k: unknown): k is string => typeof k === 'string')
      : []

    let count: number =
      typeof body?.count === 'number' && Number.isFinite(body.count) ? Math.floor(body.count) : 5
    if (count < 1) count = 1
    if (count > 10) count = 10

    const system = `你是语文出题老师。根据下面这段文字生成背书练习题，题型混合：填空题(type="fill")、简答题(type="short")、选择题(type="choice")。要求：填空题用____表示空缺，answer为应填内容；选择题必须提供options(恰好4个选项的字符串数组)和answer(正确选项的完整文本，须与options中某一项完全一致)；简答题answer为参考答案。共生成${count}道题。只返回JSON：{"questions":[{"type":"fill"|"short"|"choice","question":"...","answer":"...","options":["..."]}]}，不要任何解释。`
    const user = `课文：\n${content}\n\n重点关注词语：${keywords.length > 0 ? keywords.join('、') : '（无）'}`

    const messages = [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: user },
    ]

    const config = await getAIConfig()
    const raw = await chatComplete(messages, config)
    const parsed = extractJSON<{ questions?: QuizQuestion[] }>(raw)
    const questions: QuizQuestion[] = Array.isArray(parsed?.questions) ? parsed.questions : []
    return NextResponse.json({ questions })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/quiz] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
