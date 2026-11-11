// POST /api/autoformat — AI 智能排版（导入的混乱文本 → 结构清晰的 Markdown）。
// body: { content: string, instruction?: string }
//   content：待排版的文本（超长时服务端截断保留前 8000 字）
//   instruction：可选的用户补充指令（拼进用户消息）
// 返回: { content: string } — 排版后的 Markdown（原文逐字保留，只加结构符号）。
// AI 失败返回 500 {error:'AI 排版失败，请稍后重试'}；60s 超时保护；session 鉴权。
import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getAIConfig } from '@/lib/settings'
import { autoFormatText } from '@/lib/ai'

export const runtime = 'nodejs'
export const maxDuration = 120

const TIMEOUT_MS = 60_000
const MAX_INSTRUCTION_LEN = 1000

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    const body = (await req.json().catch(() => ({}))) as {
      content?: unknown
      instruction?: unknown
    }
    const content = typeof body?.content === 'string' ? body.content : ''
    if (!content.trim()) {
      return NextResponse.json({ error: '内容不能为空' }, { status: 400 })
    }
    const instruction =
      typeof body?.instruction === 'string'
        ? body.instruction.trim().slice(0, MAX_INSTRUCTION_LEN)
        : ''

    const config = await getAIConfig()
    // 60s 超时保护（autoFormatText 内部不再计时）
    const formatted = await Promise.race([
      autoFormatText(content, instruction, config),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('AI 排版超时（60 秒），请重试')), TIMEOUT_MS),
      ),
    ])

    if (!formatted || !formatted.trim()) {
      return NextResponse.json({ error: 'AI 排版失败，请稍后重试' }, { status: 500 })
    }
    return NextResponse.json({ content: formatted })
  } catch (err: unknown) {
    console.error('[POST /api/autoformat] failed:', err)
    return NextResponse.json({ error: 'AI 排版失败，请稍后重试' }, { status: 500 })
  }
}
