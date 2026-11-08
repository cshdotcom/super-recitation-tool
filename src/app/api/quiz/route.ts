// Quiz generation.
// POST /api/quiz — three request shapes, one response shape:
//
// 1. Legacy (compat):  { content, keywords?, count? }
//    -> mixed fill/short/choice quiz (old behaviour, kept for compatibility).
// 2. Two-step flow:    { content, points: [{ text, importance } | string], types: { choice, multi, judge, fill, short } }
//    -> questions constrained to the selected knowledge points, per-type counts.
// 3. Similar (举一反三): { mode: 'similar', questions: [{ question, answer, type?, options? }] }
//    -> 3-5 new questions drilling the same knowledge points as the wrong answers.
//
// Response: { questions: QuizQuestion[] } — QuizQuestion extended with the
// 'multi' (多选) and 'judge' (判断) types, keeping the original fields intact.
import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { chatComplete, extractJSON, extractQuestionObjects } from '@/lib/ai'
import { getAIConfig } from '@/lib/settings'
import type { QuizQuestion } from '@/lib/types'

/**
 * Parse LLM quiz output with layered fallbacks:
 *   1. extractJSON (balanced extraction + repair)
 *   2. salvage individual {"question":...} objects from raw text
 * Returns [] when nothing usable was found.
 */
async function parseQuizRaw(raw: string): Promise<QuizQuestionX[]> {
  try {
    const parsed = extractJSON<{ questions?: unknown }>(raw)
    const qs = normalizeQuestions(parsed?.questions)
    if (qs.length > 0) return qs
  } catch {
    /* fall through to salvage */
  }
  return normalizeQuestions(extractQuestionObjects(raw))
}

/** Ask the model once more to re-emit strict JSON when parsing failed. */
async function retryStrictJSON(
  raw: string,
  messages: { role: 'system' | 'user'; content: string }[],
  config: Awaited<ReturnType<typeof getAIConfig>>,
): Promise<string> {
  return chatComplete(
    [
      ...messages,
      {
        role: 'user' as const,
        content: `你上一次的回答无法被解析为合法 JSON。请把题目重新输出为严格 JSON：{"questions":[{"type":"fill"|"short"|"choice"|"multi"|"judge","question":"...","answer":"...","options":["..."]}]}，不要代码块以外的任何文字，确保字符串内的引号已转义。`,
      },
    ],
    config,
  )
}

type QuizTypeX = QuizQuestion['type'] | 'multi' | 'judge'

interface QuizQuestionX {
  type: QuizTypeX
  question: string
  answer: string
  options?: string[]
}

const MAX_CONTENT = 6000
const VALID_TYPES: readonly string[] = ['fill', 'short', 'choice', 'multi', 'judge']
const MAX_PER_TYPE = 10
const MAX_TOTAL = 30

function clampCount(n: unknown, max = MAX_PER_TYPE): number {
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v) || v < 0) return 0
  return Math.min(max, v)
}

/** Validate / trim raw LLM questions; dedupe by question text; degrade broken options. */
function normalizeQuestions(raw: unknown): QuizQuestionX[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: QuizQuestionX[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const question = typeof o.question === 'string' ? o.question.trim().slice(0, 500) : ''
    const answer = typeof o.answer === 'string' ? o.answer.trim().slice(0, 1000) : ''
    if (!question || !answer || seen.has(question)) continue
    seen.add(question)
    const type = VALID_TYPES.includes(String(o.type)) ? (String(o.type) as QuizTypeX) : 'fill'
    let options: string[] | undefined
    if (Array.isArray(o.options)) {
      const opts = o.options
        .map((x) => String(x).trim().slice(0, 120))
        .filter(Boolean)
      if (opts.length >= 2) options = opts.slice(0, 8)
    }
    // choice/multi are meaningless without options — degrade to fill.
    if ((type === 'choice' || type === 'multi') && !options) {
      out.push({ type: 'fill', question, answer })
    } else if (options) {
      out.push({ type, question, answer, options })
    } else {
      out.push({ type, question, answer })
    }
    if (out.length >= MAX_TOTAL) break
  }
  return out
}

function parsePoints(raw: unknown): { text: string; importance: 'core' | 'secondary' }[] {
  if (!Array.isArray(raw)) return []
  const out: { text: string; importance: 'core' | 'secondary' }[] = []
  for (const p of raw) {
    if (typeof p === 'string') {
      const text = p.trim()
      if (text) out.push({ text: text.slice(0, 120), importance: 'secondary' })
    } else if (p && typeof p === 'object') {
      const o = p as Record<string, unknown>
      const text = typeof o.text === 'string' ? o.text.trim().slice(0, 120) : ''
      if (!text) continue
      out.push({ text, importance: o.importance === 'core' ? 'core' : 'secondary' })
    }
    if (out.length >= 12) break
  }
  return out
}

export async function POST(req: NextRequest) {
  try {
    const account = await getSessionUser()
    if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const config = await getAIConfig()

    // ---------- Mode 3: similar questions from wrong answers (举一反三) ----------
    if (body?.mode === 'similar') {
      const sources: QuizQuestionX[] = normalizeQuestions(
        Array.isArray(body?.questions) ? body.questions.slice(0, 10) : [],
      ).map((q) => ({ ...q, question: q.question.slice(0, 300), answer: q.answer.slice(0, 300) }))
      if (sources.length === 0) {
        return NextResponse.json({ error: '缺少错题数据' }, { status: 400 })
      }

      const system = `你是语文老师。下面这些是学生做错的题目。请围绕这些错题所考察的知识点，出 3 到 5 道相似的新题，帮助学生举一反三：考点相同，但换一种提问角度或表述，难度相当。题型规则：选择题(type="choice")必须提供 options（恰好 4 个）且 answer 为正确选项的完整文本（与 options 中某一项完全一致）；多选题(type="multi")的 answer 为所有正确选项的完整文本、用「、」连接；判断题(type="judge")的 answer 只能是「正确」或「错误」；填空题(type="fill")题干用____表示空缺，answer 为应填内容；简答题(type="short")的 answer 为参考答案要点。只返回严格 JSON：{"questions":[{"type":"fill"|"short"|"choice"|"multi"|"judge","question":"...","answer":"...","options":["..."]}]}，不要任何解释。`
      const listText = sources
        .map(
          (q, i) =>
            `${i + 1}.（原题题型：${q.type}）${q.question}\n   正确答案：${q.answer}${
              q.options?.length ? `\n   选项：${q.options.join(' | ')}` : ''
            }`,
        )
        .join('\n')

      const raw = await chatComplete(
        [
          { role: 'system' as const, content: system },
          { role: 'user' as const, content: `学生做错的题目：\n${listText}` },
        ],
        config,
      )
      const messages = [
        { role: 'system' as const, content: system },
        { role: 'user' as const, content: `学生做错的题目：\n${listText}` },
      ]
      let qs = await parseQuizRaw(raw)
      if (qs.length === 0) {
        try {
          qs = await parseQuizRaw(await retryStrictJSON(raw, messages, config))
        } catch {
          qs = []
        }
      }
      if (qs.length === 0) {
        return NextResponse.json({ error: 'AI 未能生成有效题目，请重试' }, { status: 502 })
      }
      return NextResponse.json({ questions: qs })
    }

    const content: string = typeof body?.content === 'string' ? body.content : ''
    if (!content.trim()) {
      return NextResponse.json({ error: '课文内容不能为空' }, { status: 400 })
    }

    // ---------- Mode 2: two-step flow (knowledge points + per-type counts) ----------
    const types = body?.types
    const points = parsePoints(body?.points)
    if (points.length > 0 && types && typeof types === 'object') {
      const counts = {
        choice: clampCount(types.choice),
        multi: clampCount(types.multi),
        judge: clampCount(types.judge),
        fill: clampCount(types.fill),
        short: clampCount(types.short),
      }
      const total = Object.values(counts).reduce((a, b) => a + b, 0)
      if (total === 0) {
        return NextResponse.json({ error: '请至少选择一种题型和数量' }, { status: 400 })
      }

      const typeReq = [
        counts.choice > 0 &&
          `单选题（type="choice"）${counts.choice} 道：恰好 4 个 options，answer 为正确选项的完整文本（须与 options 中某一项完全一致）`,
        counts.multi > 0 &&
          `多选题（type="multi"）${counts.multi} 道：提供 4-5 个 options，answer 为所有正确选项的完整文本、用「、」连接（每个正确选项都必须是 options 中的某一项）`,
        counts.judge > 0 &&
          `判断题（type="judge"）${counts.judge} 道：陈述句判断，answer 只能是「正确」或「错误」`,
        counts.fill > 0 &&
          `填空题（type="fill"）${counts.fill} 道：题干用____表示空缺（尽量只设一个空），answer 为应填内容`,
        counts.short > 0 &&
          `简答题（type="short"）${counts.short} 道：answer 为参考答案要点`,
      ]
        .filter(Boolean)
        .join('；')

      const system = `你是语文出题老师。请严格依据给定的"知识点清单"范围出题，结合课文原文，优先覆盖标注为[核心]的知识点，题型分布与数量必须满足：${typeReq}。只返回严格 JSON：{"questions":[{"type":"fill"|"short"|"choice"|"multi"|"judge","question":"...","answer":"...","options":["..."]}]}，不要任何解释。`

      const pointsText = points
        .map((p, i) => `${i + 1}. [${p.importance === 'core' ? '核心' : '次要'}] ${p.text}`)
        .join('\n')
      const keywords: string[] = Array.isArray(body?.keywords)
        ? body.keywords.filter((k: unknown): k is string => typeof k === 'string')
        : []
      const user = `知识点清单：\n${pointsText}\n\n课文：\n${content.slice(0, MAX_CONTENT)}${
        keywords.length > 0 ? `\n\n重点关注词语：${keywords.join('、')}` : ''
      }`

      const messages = [
        { role: 'system' as const, content: system },
        { role: 'user' as const, content: user },
      ]

      const raw = await chatComplete(messages, config)
      let qs = await parseQuizRaw(raw)
      if (qs.length === 0) {
        try {
          qs = await parseQuizRaw(await retryStrictJSON(raw, messages, config))
        } catch {
          qs = []
        }
      }
      if (qs.length === 0) {
        return NextResponse.json({ error: 'AI 未能生成有效题目，请重试' }, { status: 502 })
      }
      return NextResponse.json({ questions: qs })
    }

    // ---------- Mode 1: legacy mixed quiz (compat) ----------
    const keywords: string[] = Array.isArray(body?.keywords)
      ? body.keywords.filter((k: unknown): k is string => typeof k === 'string')
      : []
    let count: number =
      typeof body?.count === 'number' && Number.isFinite(body.count) ? Math.floor(body.count) : 5
    if (count < 1) count = 1
    if (count > 10) count = 10

    const system = `你是语文出题老师。根据下面这段文字生成背书练习题，题型混合：填空题(type="fill")、简答题(type="short")、选择题(type="choice")。要求：填空题用____表示空缺，answer为应填内容；选择题必须提供options(恰好4个选项的字符串数组)和answer(正确选项的完整文本，须与options中某一项完全一致)；简答题answer为参考答案。共生成${count}道题。只返回JSON：{"questions":[{"type":"fill"|"short"|"choice","question":"...","answer":"...","options":["..."]}]}，不要任何解释。`
    const user = `课文：\n${content.slice(0, MAX_CONTENT)}\n\n重点关注词语：${
      keywords.length > 0 ? keywords.join('、') : '（无）'
    }`

    const messages = [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: user },
    ]

    const raw = await chatComplete(messages, config)
    let questions = await parseQuizRaw(raw)
    if (questions.length === 0) {
      try {
        questions = await parseQuizRaw(await retryStrictJSON(raw, messages, config))
      } catch {
        questions = []
      }
    }
    if (questions.length === 0) {
      return NextResponse.json({ error: 'AI 未能生成有效题目，请重试' }, { status: 502 })
    }
    return NextResponse.json({ questions: questions.slice(0, count) })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/quiz] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
