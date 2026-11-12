// Quiz generation + AI grading.
// POST /api/quiz — four request shapes:
//
// 0. Grade (AI 批改):  { action:'grade', question, userAnswer, correctAnswer, type, options? }
//    -> { correct:'right'|'partial'|'wrong', score:number, comment:string, keyPoints:string[] }
// 1. Legacy (compat):  { content, keywords?, count?, requirements? }
//    -> mixed fill/short/choice quiz (old behaviour, kept for compatibility).
// 2. Two-step flow:    { content, points: [{ text, importance } | string], types: { choice, multi, judge, fill, short }, requirements? }
//    -> questions constrained to the selected knowledge points, per-type counts.
// 3. Similar (举一反三): { mode: 'similar', questions: [{ question, answer, type?, options? }], requirements? }
//    -> 3-5 new questions drilling the same knowledge points as the wrong answers.
//
// `requirements` is an optional user-supplied string of custom instructions
// (e.g. "侧重第二章"、"题目要难"、"每题附解析"、"只用填空和简答") appended to the
// system prompt so the generated questions follow them.
//
// Response (generation modes): { questions: QuizQuestion[] } — QuizQuestion
// extended with the 'multi' (多选) and 'judge' (判断) types, keeping the
// original fields intact.
import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { chatComplete, extractJSON, extractQuestionObjects } from '@/lib/ai'
import { getAIConfig } from '@/lib/settings'
import { stripRecitationMarks } from '@/lib/inline-style'
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
// 按用户要求放开自定义题数上限（原 MAX_PER_TYPE=10 / MAX_TOTAL=30）。
const MAX_PER_TYPE = 100
const MAX_TOTAL = 100

/**
 * 富媒体格式指引（只改 prompt 文案，不改变请求/响应 JSON 结构）：
 * 题干保持简洁适合作答；简答题参考答案可完整富媒体；
 * 机器判分题型（填空/选择/判断）的 answer 保持简洁纯文本，避免影响自动判分。
 */
const RICH_FORMAT_HINT =
  '富文本格式要求：数学/物理/化学式必须用 LaTeX（行内 $...$、独立 $$...$$）。题干(question)保持简洁适合作答，可用 LaTeX，但不要在题干里塞 mermaid 图、大表格或图片外链；简答题(short)的 answer 是供对照自评的参考答案，可完整使用富文本——**加粗**、markdown 表格、LaTeX 公式、mermaid 思维导图（```mermaid 代码块，适合知识结构梳理）、代码块；填空/选择/判断题的 answer 保持简洁纯文本（可含 LaTeX），便于自动判分；options 为纯文本短语。任何字段都不要输出图片外链。'

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

/** 上游 AI/网络层报错 → 友好中文（避免把英文堆栈式错误直接透传给客户端）。 */
function friendlyUpstreamError(msg: string): string {
  if (
    /API request failed|Failed to fetch|fetch failed|NetworkError|ECONN|socket|network|timeout|timed out|aborted/i.test(
      msg,
    )
  ) {
    return 'AI 服务暂时不可用，请稍后重试；多次失败请到「设置 → AI 配置」检查'
  }
  return msg
}

/**
 * 用户自定义出题要求的提示词后缀（附加到系统提示末尾）。
 * 仅在 requirements 非空时返回非空串；长度上限 1000 字符。
 */
function requirementsSuffix(req?: string): string {
  const r = (req || '').trim()
  if (!r) return ''
  return `\n\n【用户自定义出题要求】${r.slice(0, 1000)}\n请在出题时严格遵守上述自定义要求（在不与题型/JSON 格式规则冲突的前提下优先满足；如要求"每题附解析"，则把解析合并进 answer 字段，不要新增字段）。`
}

// ---------- AI 批改（action:'grade'） ----------
type GradeCorrect = 'right' | 'partial' | 'wrong'

interface GradeResult {
  correct: GradeCorrect
  score: number
  comment: string
  keyPoints: string[]
}

/** 校验 + 规范化 AI 批改返回：correct 三值、score 0–100、comment 字符串、keyPoints 字符串数组。 */
function normalizeGrade(raw: unknown): GradeResult {
  const o = (raw ?? {}) as Record<string, unknown>
  const c = String(o.correct)
  const correct: GradeCorrect =
    c === 'right' || c === 'partial' || c === 'wrong' ? c : 'wrong'
  let score = Math.round(Number(o.score))
  if (!Number.isFinite(score)) score = correct === 'right' ? 100 : correct === 'partial' ? 50 : 0
  score = Math.max(0, Math.min(100, score))
  const comment =
    typeof o.comment === 'string' ? o.comment.trim().slice(0, 800) : ''
  const keyPoints = Array.isArray(o.keyPoints)
    ? o.keyPoints
        .map((x) => (typeof x === 'string' ? x.trim() : ''))
        .filter((s) => s.length > 0)
        .slice(0, 12)
    : []
  return { correct, score, comment, keyPoints }
}

/**
 * 出题用课文清洗（纯函数，两步流出题链路）：
 * - `![alt](url)` → `[图片: alt]`（URL 对模型无意义；图片已由客户端转 dataURI
 *   走 /api/quiz-points 的 images 视觉链路，此处只留 alt 文字提示）
 * - `[[audio:uuid|标题]]` / `[[video:uuid|标题]]` → `[音频: 标题]` / `[视频: 标题]`
 * - 背诵标记剥离干净（出题不该受挖空/行内样式语法干扰，嵌套安全）：
 *   `%%样式|文字%%` → 文字、`==高亮==` → 文字、`{{挖空}}` → 文字
 * - 围栏代码块（mermaid/svg 等结构化富媒体）与 LaTeX/表格/加粗等 markdown 原样保留
 *   （模型可理解其结构）。
 */
export function cleanContentForQuiz(raw: string): string {
  const src = String(raw ?? '')
  if (!src) return src
  return src
    .split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/g)
    .map((part, idx) => {
      if (idx % 2 === 1) return part // 围栏代码块整体保留
      if (!part) return part
      let s = part
      // 图片引用 → [图片: alt] 文字提示
      s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m: string, alt: string) => {
        const label = String(alt ?? '').trim()
        return label ? `[图片: ${label}]` : '[图片]'
      })
      // 音视频引用 → 文字提示（URL 对模型无意义）
      s = s.replace(
        /\[\[(audio|video):[a-f0-9-]+(?:\|([^\]]*))?\]\]/g,
        (_m: string, kind: string, title?: string) => {
          const label = (title ?? '').trim() || (kind === 'audio' ? '音频' : '视频')
          return kind === 'audio' ? `[音频: ${label}]` : `[视频: ${label}]`
        },
      )
      // 背诵标记（嵌套安全，复用共享分词器）：%%…|…%% / ==…== / {{…}}
      return stripRecitationMarks(s)
    })
    .join('')
}

export async function POST(req: NextRequest) {
  try {
    const account = await getSessionUser()
    if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const config = await getAIConfig()

    // ---------- Action 0: AI 批改（action:'grade'） ----------
    // 输入 { action:'grade', question, userAnswer, correctAnswer, type, options? }
    // 输出 { correct:'right'|'partial'|'wrong', score:number, comment:string, keyPoints:string[] }
    // 适用于所有题型：填空/简答/选择/判断/多选统一走这条批改路径。
    if (body?.action === 'grade') {
      const question: string = typeof body?.question === 'string' ? body.question.trim().slice(0, 1200) : ''
      const userAnswer: string = typeof body?.userAnswer === 'string' ? body.userAnswer.trim().slice(0, 4000) : ''
      const correctAnswer: string =
        typeof body?.correctAnswer === 'string' ? body.correctAnswer.trim().slice(0, 2000) : ''
      const type: string = typeof body?.type === 'string' ? body.type : ''
      if (!question || !correctAnswer) {
        return NextResponse.json({ error: '题目与正确答案不能为空' }, { status: 400 })
      }

      const optionsPart =
        Array.isArray(body?.options) && body.options.length > 0
          ? `\n选项：${(body.options as string[])
              .map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`)
              .join('  ')}`
          : ''

      const gradeSystem = `你是严谨且善于讲解的语文判题老师。请判定学生的回答相对于标准答案的对错程度，并给出得分、评语与正确答案要点。

判定与得分规则：
- 选择题/判断题/多选题：答案与标准答案一致判 "right"（score=100）；不一致判 "wrong"（score=0）。这类客观题不存在 "partial"。
- 填空题：核心含义与标准答案一致判 "right"（score=95–100，允许标点/同义词差异）；多空答对一部分判 "partial"（score 按答对比例 30–70）；完全不符或空白判 "wrong"（score=0–20）。
- 简答题：要点全覆盖判 "right"（score=90–100）；覆盖大部分要点判 "partial"（score=50–85）；要点缺失严重或答非所问判 "wrong"（score=0–40）。
- score 为 0–100 的整数；comment 为中文一句话评语，可含 LaTeX 行内公式 $...$，但不要使用表格、mermaid、代码块等多行格式，确保返回的是合法 JSON。
- keyPoints 为正确答案要点的字符串数组（每条一个简洁要点，2–8 条；客观题也可给出"正确选项是 X，因为…"这类要点）。
- 完全无关/答非所问/空白 → "wrong"，score=0。

只返回严格 JSON：{"correct":"right"|"partial"|"wrong","score":number,"comment":"...","keyPoints":["...","..."]}，不要任何额外解释或代码围栏。`

      const userMsg = `题型：${type || '未标注'}${optionsPart}
题目：${question}
标准答案：${correctAnswer}
学生答案：${userAnswer || '（未作答）'}
请按规则判定并给出得分、评语与要点。`

      const reply = await chatComplete(
        [
          { role: 'system', content: gradeSystem },
          { role: 'user', content: userMsg },
        ],
        config,
      )

      let parsed: unknown = null
      try {
        parsed = extractJSON<unknown>(reply)
      } catch {
        // 兜底：从原始回复里抓第一个 {...} 块
        const m = (reply || '').match(/\{[\s\S]*\}/)
        if (m) {
          try {
            parsed = JSON.parse(m[0])
          } catch {
            parsed = null
          }
        }
      }
      const result = normalizeGrade(parsed)
      return NextResponse.json(result)
    }

    // 自定义出题要求（所有出题模式共用，留空则不影响）
    const requirements: string =
      typeof body?.requirements === 'string' ? body.requirements.slice(0, 1000) : ''

    // ---------- Mode 3: similar questions from wrong answers (举一反三) ----------
    if (body?.mode === 'similar') {
      const sources: QuizQuestionX[] = normalizeQuestions(
        Array.isArray(body?.questions) ? body.questions.slice(0, 10) : [],
      ).map((q) => ({ ...q, question: q.question.slice(0, 300), answer: q.answer.slice(0, 300) }))
      if (sources.length === 0) {
        return NextResponse.json({ error: '缺少错题数据' }, { status: 400 })
      }

      const system = `你是语文老师。下面这些是学生做错的题目。请围绕这些错题所考察的知识点，出 3 到 5 道相似的新题，帮助学生举一反三：考点相同，但换一种提问角度或表述，难度相当。题型规则：选择题(type="choice")必须提供 options（恰好 4 个）且 answer 为正确选项的完整文本（与 options 中某一项完全一致）；多选题(type="multi")的 answer 为所有正确选项的完整文本、用「、」连接；判断题(type="judge")的 answer 只能是「正确」或「错误」；填空题(type="fill")题干用____表示空缺，answer 为应填内容；简答题(type="short")的 answer 为参考答案要点。${RICH_FORMAT_HINT} 只返回严格 JSON：{"questions":[{"type":"fill"|"short"|"choice"|"multi"|"judge","question":"...","answer":"...","options":["..."]}]}，不要任何解释。${requirementsSuffix(requirements)}`
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

      const system = `你是语文出题老师。请严格依据给定的"知识点清单"范围出题，结合课文原文，优先覆盖标注为[核心]的知识点，题型分布与数量必须满足：${typeReq}。${RICH_FORMAT_HINT} 只返回严格 JSON：{"questions":[{"type":"fill"|"short"|"choice"|"multi"|"judge","question":"...","answer":"...","options":["..."]}]}，不要任何解释。${requirementsSuffix(requirements)}`

      const pointsText = points
        .map((p, i) => `${i + 1}. [${p.importance === 'core' ? '核心' : '次要'}] ${p.text}`)
        .join('\n')
      const keywords: string[] = Array.isArray(body?.keywords)
        ? body.keywords.filter((k: unknown): k is string => typeof k === 'string')
        : []
      // 课文先清洗（图片引用→文字提示、背诵标记剥离；围栏/公式/表格保留）
      const cleaned = cleanContentForQuiz(content)
      const user = `知识点清单：\n${pointsText}\n\n课文：\n${cleaned.slice(0, MAX_CONTENT)}${
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
    if (count > MAX_TOTAL) count = MAX_TOTAL

    const system = `你是语文出题老师。根据下面这段文字生成背书练习题，题型混合：填空题(type="fill")、简答题(type="short")、选择题(type="choice")。要求：填空题用____表示空缺，answer为应填内容；选择题必须提供options(恰好4个选项的字符串数组)和answer(正确选项的完整文本，须与options中某一项完全一致)；简答题answer为参考答案。共生成${count}道题。${RICH_FORMAT_HINT} 只返回JSON：{"questions":[{"type":"fill"|"short"|"choice","question":"...","answer":"...","options":["..."]}]}，不要任何解释。${requirementsSuffix(requirements)}`
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
    return NextResponse.json({ error: friendlyUpstreamError(msg) }, { status: 500 })
  }
}
