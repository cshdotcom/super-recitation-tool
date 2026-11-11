import type {
  CardData,
  CardPlan,
  DoodleStroke,
  DoodleTool,
  Point,
  ReviewAction,
  Stroke,
} from './types'

// ===========================================================================
// 复习调度算法（纯函数，服务端 /api/review 与客户端共用，便于单独测试）
//
// 三种可选复习方案（用户在「待复习」页顶部选择，localStorage 持久化，
// 提交评分时作为 scheme 参数传给 POST /api/review）：
//   sm2    — SM-2 艾宾浩斯（默认）：按评分质量动态调整难度系数与间隔
//   fixed  — 固定间隔：1/2/4/7/15/30 天序列，记得=前进一格，忘记=回到 1 天
//   simple — 简单模式：只有 会/不会 两档，会=间隔翻倍，不会=重置 1 天
// ===========================================================================

/** 复习方案 */
export type ReviewScheme = 'sm2' | 'fixed' | 'simple'

/** 待复习页顶部方案选择器的展示配置 */
export const REVIEW_SCHEMES: { value: ReviewScheme; label: string; hint: string }[] = [
  {
    value: 'sm2',
    label: '艾宾浩斯',
    hint: 'SM-2 算法：按「熟悉/模糊/忘记」动态调整难度与间隔',
  },
  {
    value: 'fixed',
    label: '固定间隔',
    hint: '固定序列 1/2/4/7/15/30 天：记得前进一格，忘记回到 1 天',
  },
  {
    value: 'simple',
    label: '简单模式',
    hint: '只有「会/不会」两档：会=间隔翻倍，不会=重置 1 天',
  },
]

/** 各方案的评分档位（action 与 ReviewLog 落库动作一一对应；简单模式只有两档） */
export const SCHEME_SCORE_ACTIONS: Record<ReviewScheme, { value: ReviewAction; label: string }[]> =
  {
    sm2: [
      { value: 'familiar', label: '熟悉' },
      { value: 'fuzzy', label: '模糊' },
      { value: 'forget', label: '忘记' },
    ],
    fixed: [
      { value: 'familiar', label: '记得' },
      { value: 'fuzzy', label: '模糊' },
      { value: 'forget', label: '忘记' },
    ],
    simple: [
      { value: 'familiar', label: '会' },
      { value: 'forget', label: '不会' },
    ],
  }

/** 未知值是否为合法复习方案（API 入参校验用） */
export function isReviewScheme(v: unknown): v is ReviewScheme {
  return v === 'sm2' || v === 'fixed' || v === 'simple'
}

/** 固定间隔方案的序列（天） */
export const FIXED_INTERVAL_STEPS: readonly number[] = [1, 2, 4, 7, 15, 30]

/** 简单模式间隔上限（天） */
export const SIMPLE_MAX_INTERVAL = 365

/** SM-2 间隔上限（天）— 熟悉 30 / 模糊 7（本应用的节奏微调） */
export const SM2_MAX_FAMILIAR = 30
export const SM2_MAX_FUZZY = 7

const DAY_MS = 86_400_000

/** SM-2 难度系数范围（标准 SM-2 下限 1.3；上限按产品节奏收在 2.5） */
export const SM2_EASE_MIN = 1.3
export const SM2_EASE_MAX = 2.5

function clampNum(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/**
 * 评分动作 → SM-2 质量分 q（0-5）：
 * 熟悉=5（完美回忆）/ 模糊=3（费力想起）/ 忘记=1（完全忘记）
 */
export function sm2Quality(action: ReviewAction): number {
  return action === 'familiar' ? 5 : action === 'fuzzy' ? 3 : 1
}

/** 卡片当前的复习调度状态（Card 表对应字段） */
export interface ReviewScheduleState {
  /** SM-2 难度系数 EF */
  ease: number
  /** 当前间隔（天） */
  interval: number
  /** 连续成功复习次数（SM-2 repetitions，忘记后归零） */
  reviewCount: number
}

export interface ReviewScheduleInput extends ReviewScheduleState {
  action: ReviewAction
  /** 复习方案，默认 sm2 */
  scheme?: ReviewScheme
  /** 当前时刻（默认 new Date()） */
  now?: Date
  /** 客户端时区偏移（分钟，UTC+8 为 -480，即 Date#getTimezoneOffset()） */
  tzOffsetMin?: number
}

export interface ReviewScheduleResult extends ReviewScheduleState {
  /** 下次复习时间 */
  nextReviewAt: Date
}

/**
 * 下次复习时间 = 客户端时区的「当日零点」+ intervalDays 天。
 * 以当地零点为锚点避免时区漂移：今天任何时刻复习都算作「今天起隔 N 天」，
 * 到期时刻落在目标日的当地 00:00。
 * 时区约定：tzOffsetMin = Date#getTimezoneOffset()（UTC+8 为 -480），
 * 当地墙上时间 = UTC - tzOffsetMin（注意方向：UTC+8 要加 8 小时）。
 */
export function nextReviewDate(
  now: Date,
  intervalDays: number,
  tzOffsetMin: number,
): Date {
  const tz = clampNum(Math.round(tzOffsetMin || 0), -840, 840)
  const localMs = now.getTime() - tz * 60_000 // 客户端墙上时间（用 UTC 数值表示）
  const localMidnight = Math.floor(localMs / DAY_MS) * DAY_MS // 当地当日零点
  return new Date(localMidnight + intervalDays * DAY_MS + tz * 60_000)
}

/**
 * 方案一：SM-2 艾宾浩斯（默认）。
 * 标准算法对照：https://en.wikipedia.org/wiki/SuperMemo#Description_of_SM-2_algorithm
 * 1. 质量分 q：熟悉=5 / 模糊=3 / 忘记=1
 * 2. 难度系数：EF' = EF + (0.1 - (5-q) * (0.08 + (5-q) * 0.02))，夹到 [1.3, 2.5]
 *    （q=5 → +0.100 / q=4 → +0.000 / q=3 → -0.140 / q=1 → -0.860）
 * 3. q < 3（忘记）：repetitions 归零、间隔重置 1 天 —— 从头开始背
 * 4. q ≥ 3：repetitions+1；第 1 次=1 天，第 2 次=3 天，之后=round(上次间隔 × EF')
 *    熟悉封顶 30 天 / 模糊封顶 7 天（本应用的节奏微调）
 */
export function scheduleSm2Review(
  state: ReviewScheduleState,
  action: ReviewAction,
  now: Date,
  tzOffsetMin: number,
): ReviewScheduleResult {
  const q = sm2Quality(action)
  // EF 更新对每次评分生效；忘记（q<3）时 repetitions 归零（标准 SM-2 行为）
  const ease = clampNum(
    clampNum(state.ease, SM2_EASE_MIN, SM2_EASE_MAX) +
      (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)),
    SM2_EASE_MIN,
    SM2_EASE_MAX,
  )
  let interval: number
  let reviewCount: number
  if (q < 3) {
    // 忘记：重置间隔为 1 天，重新从第 1 次开始
    reviewCount = 0
    interval = 1
  } else {
    reviewCount = state.reviewCount + 1
    if (reviewCount === 1) {
      interval = 1
    } else if (reviewCount === 2) {
      interval = 3
    } else {
      const next = Math.round(Math.max(1, state.interval) * ease)
      interval =
        action === 'familiar'
          ? Math.min(SM2_MAX_FAMILIAR, next)
          : Math.min(SM2_MAX_FUZZY, next)
    }
  }
  return {
    ease,
    interval,
    reviewCount,
    nextReviewAt: nextReviewDate(now, interval, tzOffsetMin),
  }
}

/**
 * 方案二：固定间隔。沿 1/2/4/7/15/30 天序列前进：
 * - 记得：前进到序列中第一个大于当前间隔的档位（已到序列末端则保持不变，不回退）
 * - 模糊：原地重复当前间隔（不足 1 天按 1 天）
 * - 忘记：回到序列起点 1 天
 * ease 不参与计算（保持原值）。
 */
export function scheduleFixedReview(
  state: ReviewScheduleState,
  action: ReviewAction,
  now: Date,
  tzOffsetMin: number,
): ReviewScheduleResult {
  let interval: number
  if (action === 'familiar') {
    const next = FIXED_INTERVAL_STEPS.find((d) => d > state.interval)
    interval = next ?? Math.max(state.interval, FIXED_INTERVAL_STEPS[FIXED_INTERVAL_STEPS.length - 1])
  } else if (action === 'fuzzy') {
    interval = Math.max(1, state.interval)
  } else {
    interval = 1
  }
  const reviewCount = action === 'forget' ? 0 : state.reviewCount + 1
  return {
    ease: state.ease,
    interval,
    reviewCount,
    nextReviewAt: nextReviewDate(now, interval, tzOffsetMin),
  }
}

/**
 * 方案三：简单模式。只有 会/不会 两档：
 * - 会：间隔翻倍（首评从 1 天起：1→2→4→8→…，封顶 365 天）
 * - 不会（以及兜底处理的模糊）：重置 1 天
 * ease 不参与计算（保持原值）。
 */
export function scheduleSimpleReview(
  state: ReviewScheduleState,
  action: ReviewAction,
  now: Date,
  tzOffsetMin: number,
): ReviewScheduleResult {
  const ok = action === 'familiar'
  const interval = !ok
    ? 1
    : state.interval < 1
      ? 1
      : Math.min(SIMPLE_MAX_INTERVAL, state.interval * 2)
  const reviewCount = ok ? state.reviewCount + 1 : 0
  return {
    ease: state.ease,
    interval,
    reviewCount,
    nextReviewAt: nextReviewDate(now, interval, tzOffsetMin),
  }
}

/** 按方案调度一次复习（scheme 分发入口，route 与客户端共用）。 */
export function scheduleReview(input: ReviewScheduleInput): ReviewScheduleResult {
  const { action, scheme = 'sm2', now = new Date(), tzOffsetMin = 0 } = input
  const state: ReviewScheduleState = {
    ease: input.ease,
    interval: input.interval,
    reviewCount: input.reviewCount,
  }
  if (scheme === 'fixed') return scheduleFixedReview(state, action, now, tzOffsetMin)
  if (scheme === 'simple') return scheduleSimpleReview(state, action, now, tzOffsetMin)
  return scheduleSm2Review(state, action, now, tzOffsetMin)
}

const TOOLS: readonly DoodleTool[] = ['pen', 'pencil', 'marker', 'brush', 'eraser']

function isPoint(p: unknown): p is Point {
  return (
    Array.isArray(p) &&
    p.length === 2 &&
    typeof p[0] === 'number' &&
    typeof p[1] === 'number'
  )
}

// Lenient check used when reading strokes back from the DB: legacy point
// arrays are passed through as-is, and DoodleStroke objects must at least
// have pts/color/width/tool of the right types.
export function isValidStroke(s: unknown): s is Stroke {
  if (Array.isArray(s)) return s.every(isPoint)
  if (s && typeof s === 'object') {
    const d = s as Partial<DoodleStroke>
    return (
      Array.isArray(d.pts) &&
      d.pts.every(isPoint) &&
      typeof d.color === 'string' &&
      typeof d.width === 'number' &&
      typeof d.tool === 'string'
    )
  }
  return false
}

// Stricter normalization for incoming PATCH payloads: DoodleStroke objects
// get their width clamped to 1..60 and their tool whitelisted.
export function normalizeStrokeInput(s: unknown): Stroke | null {
  if (Array.isArray(s)) {
    return s.every(isPoint) ? (s as Point[]) : null
  }
  if (s && typeof s === 'object') {
    const d = s as Partial<DoodleStroke>
    if (!Array.isArray(d.pts) || !d.pts.every(isPoint)) return null
    if (typeof d.color !== 'string') return null
    if (typeof d.width !== 'number' || !Number.isFinite(d.width)) return null
    if (typeof d.tool !== 'string' || !TOOLS.includes(d.tool as DoodleTool)) return null
    const stroke: DoodleStroke = {
      pts: d.pts,
      color: d.color,
      width: Math.min(60, Math.max(1, d.width)),
      tool: d.tool as DoodleTool,
    }
    return stroke
  }
  return null
}

export function serializeCard(c: {
  id: string
  title: string
  content: string
  keywords: string
  strokes: string
  plan: string
  mindmaps?: string | null
  blocks?: string | null
  categoryId?: string
  pinned?: boolean
  ord?: number
  deletedAt?: Date | null
  createdAt: Date
  updatedAt: Date
}): CardData {
  let keywords: string[] = []
  try {
    keywords = JSON.parse(c.keywords || '[]')
  } catch {}

  let strokes: Stroke[] = []
  try {
    const parsed = JSON.parse(c.strokes || '[]')
    if (Array.isArray(parsed)) {
      strokes = parsed.filter(isValidStroke)
    }
  } catch {}

  let plan: CardPlan | null = null
  try {
    const parsed = JSON.parse(c.plan || 'null')
    if (parsed && typeof parsed === 'object' && typeof parsed.goal === 'number') {
      plan = {
        goal: parsed.goal,
        ...(typeof parsed.dailyNew === 'number' ? { dailyNew: parsed.dailyNew } : {}),
        ...(typeof parsed.reviewTimes === 'number' ? { reviewTimes: parsed.reviewTimes } : {}),
      }
    }
  } catch {}

  let mindmaps: unknown[] = []
  try {
    const parsed = JSON.parse(c.mindmaps || '[]')
    if (Array.isArray(parsed)) mindmaps = parsed
  } catch {}

  // 文字编辑工具 Q&A blocks
  let blocks: CardData['blocks'] = []
  try {
    const parsed = JSON.parse(c.blocks || '[]')
    if (Array.isArray(parsed)) {
      blocks = parsed
        .filter(
          (b): b is CardData['blocks'][number] =>
            b && typeof b === 'object' && typeof (b as { front?: unknown }).front === 'string' && typeof (b as { back?: unknown }).back === 'string',
        )
        .map((b) => ({ front: b.front, back: b.back, ...(b.hidden ? { hidden: true } : {}) }))
    }
  } catch {}

  return {
    id: c.id,
    title: c.title,
    content: c.content,
    keywords,
    strokes,
    plan,
    mindmaps: mindmaps as CardData['mindmaps'],
    blocks,
    categoryId: c.categoryId ?? '',
    pinned: c.pinned ?? false,
    ord: c.ord ?? 0,
    deletedAt: c.deletedAt ? c.deletedAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }
}
