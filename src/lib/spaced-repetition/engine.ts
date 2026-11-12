// ===========================================================================
// FSRS 级间隔重复算法 — 引擎核心（v2.8.0+）
// 纯函数：computeReview(统一调度) / previewCard(4档预览+R曲线) / retrievability
// / resolveConfig(全局→单卡覆盖合并) / 自定义公式安全求值器
// ===========================================================================
import {
  type AlgorithmConfig,
  type AlgorithmType,
  type CardMemory,
  type CardPreview,
  type ComputeInput,
  type ComputeLogLine,
  type ComputeResult,
  type Grade,
  type GradePreview,
  type ResolvedConfig,
} from './types'
import { mergeConfig } from './presets'
import { scheduleSm2Review, scheduleFixedReview, scheduleSimpleReview, sm2Quality, nextReviewDate } from '@/lib/card'
import type { ReviewAction } from '@/lib/types'

const DAY_MS = 86_400_000

/** 可提取性 R：记忆衰减曲线。t=经过天数，S=稳定性（天）。
 *  R = (1 + t/(9*S))^(-1)（FSRS 衰减模型，decay=9, factor=-1） */
export function retrievability(s: number, elapsedDays: number): number {
  if (s <= 0) return 0
  const t = Math.max(0, elapsedDays)
  return Math.max(0, Math.min(1, Math.pow(1 + t / (9 * s), -1)))
}

/** 计算从 lastReviewAt 到 now 的经过天数（容错：无历史=0） */
export function elapsedDays(memory: CardMemory, now: Date): number {
  if (!memory.lastReviewAt) return 0
  const t = new Date(memory.lastReviewAt).getTime()
  if (!Number.isFinite(t)) return 0
  return Math.max(0, (now.getTime() - t) / DAY_MS)
}

/** 扩展输入：SM-2 模式需读取 Card.ease（向后兼容） */
export interface FullComputeInput extends ComputeInput {
  ease?: number
}

// ---------------------------------------------------------------------------
// 统一调度入口
// ---------------------------------------------------------------------------
export function computeReview(input: FullComputeInput): ComputeResult {
  const { algorithm } = input
  if (algorithm === 'sm2') return computeSm2(input)
  if (algorithm === 'fixed') return computeFixed(input)
  if (algorithm === 'simple') return computeSimple(input)
  if (algorithm === 'custom') return computeCustom(input)
  return computeFsrs(input)
}

// ---------------------------------------------------------------------------
// FSRS 自适应
// ---------------------------------------------------------------------------
function computeFsrs(input: FullComputeInput): ComputeResult {
  const { memory: m0, grade, config: c, now = new Date(), tzOffsetMin = 0, durationSec } = input
  const log: ComputeLogLine[] = []
  const w = c.w
  const m = cloneMemory(m0)
  const el = elapsedDays(m, now)
  const prevR = retrievability(m.s, el)
  log.push({ step: '读取', detail: `状态=${m.state} S=${m.s.toFixed(2)} D=${m.d.toFixed(2)} 经过=${el.toFixed(1)}天`, value: prevR })

  // 难度更新（新卡首次评分也走这里，D0=w[4]）
  const rating = gradeRating(grade)
  let dNew = m.d
  if (m.state === 'new') dNew = w[4]
  const dDelta = w[5] * (3 - rating)
  dNew = dNew + dDelta
  // 均值回归到 w[4]
  dNew = dNew * (1 - w[6]) + w[4] * w[6]
  dNew = clamp(dNew, 1, 10)
  log.push({ step: '难度更新', detail: `D: ${m.d.toFixed(2)} → ${dNew.toFixed(2)} (Δ=${dDelta.toFixed(2)} 回归=${w[6]})`, value: dNew })

  let sNew: number
  let newState: CardMemory['state'] = m.state
  let step = m.step
  let reps = m.reps
  let lapses = m.lapses

  if (m.state === 'new' || m.state === 'learning' || m.state === 'relearn') {
    // 学习/重学阶段：走 steps（分钟），good/easy 推进或毕业，again/hard 重复或回退
    const steps = m.state === 'relearn' ? c.relearnSteps : c.learningSteps
    const stepsArr = steps.length > 0 ? steps : [1]
    if (grade === 'again') {
      step = 0
      newState = m.state === 'relearn' ? 'relearn' : 'learning'
      sNew = Math.max(c.lapseMinS, m.s * c.lapseSRetention)
      const minIdx0 = stepsArr[0]
      const intervalDays = minIdx0 / 1440
      log.push({ step: '学习·忘记', detail: `回退到第0步 (${minIdx0}分钟)`, value: intervalDays })
      return finalize(m, grade, c, now, tzOffsetMin, dNew, sNew, newState, step, reps, lapses, prevR, log, durationSec, intervalDays, deriveEase(dNew))
  }
    if (grade === 'hard') {
      // 重复当前步（不推进）
      newState = m.state === 'relearn' ? 'relearn' : 'learning'
      sNew = Math.max(c.lapseMinS, m.s * 0.8)
      const cur = stepsArr[Math.min(step, stepsArr.length - 1)]
      const intervalDays = cur / 1440
      log.push({ step: '学习·困难', detail: `重复第${step}步 (${cur}分钟)`, value: intervalDays })
      return finalize(m, grade, c, now, tzOffsetMin, dNew, sNew, newState, step, reps, lapses, prevR, log, durationSec, intervalDays, deriveEase(dNew))
    }
    // good / easy：推进步数
    step += grade === 'easy' ? 2 : 1
    if (step >= stepsArr.length) {
      // 毕业 → 进入 review
      newState = 'review'
      sNew = w[grade === 'easy' ? 3 : grade === 'good' ? 2 : 1]
      reps = 1
      const intervalDays = intervalFromS(sNew, c)
      log.push({ step: '学习·毕业', detail: `毕业进入复习，S0=${sNew.toFixed(2)} 间隔=${intervalDays.toFixed(1)}天`, value: intervalDays })
      return finalize(m, grade, c, now, tzOffsetMin, dNew, sNew, newState, step, reps, lapses, prevR, log, durationSec, intervalDays, deriveEase(dNew))
    }
    // 未毕业：返回下一步的分钟间隔
    newState = m.state === 'relearn' ? 'relearn' : 'learning'
    sNew = Math.max(c.lapseMinS, m.s * 1.1)
    const cur = stepsArr[Math.min(step, stepsArr.length - 1)]
    const intervalDays = cur / 1440
    log.push({ step: '学习·推进', detail: `第${step}步 (${cur}分钟)`, value: intervalDays })
    return finalize(m, grade, c, now, tzOffsetMin, dNew, sNew, newState, step, reps, lapses, prevR, log, durationSec, intervalDays, deriveEase(dNew))
  }

  // ---- review 状态 ----
  if (grade === 'again') {
    // 遗忘：S 大幅下降，进入重学
    sNew = Math.max(c.lapseMinS, m.s * c.lapseSRetention * w[11])
    newState = 'relearn'
    step = 0
    lapses += 1
    reps = 0
    log.push({ step: '遗忘', detail: `S: ${m.s.toFixed(2)} → ${sNew.toFixed(2)} (保留=${c.lapseSRetention}×${w[11]})`, value: sNew })
    // 重学第一步的分钟间隔
    const rSteps = c.relearnSteps.length > 0 ? c.relearnSteps : [10]
    const intervalDays = rSteps[0] / 1440
    return finalize(m, grade, c, now, tzOffsetMin, dNew, sNew, newState, step, reps, lapses, prevR, log, durationSec, intervalDays, deriveEase(dNew))
  }

  // good / easy / hard 在 review 状态
  // 提前复习增益 / 延迟惩罚
  let earlyFactor = 1
  if (c.enableEarlyReview && el < intervalFromS(m.s, c) * 0.5) {
    earlyFactor = 1.05
    log.push({ step: '提前增益', detail: `提前复习，S×${earlyFactor}`, value: earlyFactor })
  }
  if (c.enableLatePenalty && el > intervalFromS(m.s, c) * 2) {
    earlyFactor *= 0.9
    log.push({ step: '延迟惩罚', detail: `超期复习，S×0.9`, value: earlyFactor })
  }
  const ratingFactor = grade === 'hard' ? c.hardPenalty : grade === 'easy' ? c.easyBonus : 1.0
  const gain = w[7] * Math.pow(Math.max(1, 11 - dNew), w[10]) * Math.pow(1 - prevR, w[8]) * Math.pow(Math.max(0.01, m.s), -w[9])
  sNew = m.s * (1 + gain) * ratingFactor * earlyFactor
  sNew = clamp(sNew, c.lapseMinS, c.maxInterval)
  reps += 1
  log.push({ step: '稳定增益', detail: `gain=${gain.toFixed(3)} rating×${ratingFactor} S: ${m.s.toFixed(2)} → ${sNew.toFixed(2)}`, value: sNew })

  const intervalDays = intervalFromS(sNew, c)
  return finalize(m, grade, c, now, tzOffsetMin, dNew, sNew, newState, step, reps, lapses, prevR, log, durationSec, intervalDays, deriveEase(dNew))
}

/** 由稳定性 S 与目标保留率算间隔（使下次复习时 R=target） */
function intervalFromS(s: number, c: AlgorithmConfig): number {
  const raw = 9 * s * (Math.pow(c.desiredRetention, -1) - 1)
  let iv = clamp(raw, c.minInterval, c.maxInterval)
  if (c.fuzz && iv > 2) {
    const f = c.w[15] ?? 0.15
    const jitter = (Math.sin(iv * 12.9898) * 0.5 + 0.5) * f // 伪随机（确定性，便于预览一致）
    iv = clamp(iv + jitter - f / 2, c.minInterval, c.maxInterval)
  }
  return iv
}

function deriveEase(d: number): number {
  // D(1-10) → EF(2.5-1.3) 反向映射，仅供旧 SM-2 字段兼容展示
  return clamp(2.5 - ((d - 5) * 0.3), 1.3, 2.5)
}

function gradeRating(g: Grade): number {
  return g === 'again' ? 1 : g === 'hard' ? 2 : g === 'good' ? 3 : 4
}

// ---------------------------------------------------------------------------
// SM-2 / 固定 / 简单 —— 复用 card.ts 现有纯函数，包装为统一 ComputeResult
// ---------------------------------------------------------------------------
function computeSm2(input: FullComputeInput): ComputeResult {
  const { memory: m0, grade, config: c, now = new Date(), tzOffsetMin = 0, durationSec, ease = 2.5 } = input
  const action: ReviewAction = grade === 'again' ? 'forget' : grade === 'hard' ? 'fuzzy' : 'familiar'
  const scheduled = scheduleSm2Review(
    { ease, interval: Math.round(m0.s) || 0, reviewCount: m0.reps },
    action,
    now,
    tzOffsetMin,
  )
  const log: ComputeLogLine[] = [
    { step: 'SM-2', detail: `q=${sm2Quality(action)} EF: ${ease.toFixed(2)}→${scheduled.ease.toFixed(2)} 间隔=${scheduled.interval}天`, value: scheduled.interval },
  ]
  const m = cloneMemory(m0)
  const newS = scheduled.interval
  const newD = clamp(5 + (2.5 - scheduled.ease) * 4, 1, 10)
  return finalizeMemory(m0, grade, c, now, scheduled.nextReviewAt, scheduled.interval, newS, newD, scheduled.reviewCount, m0.lapses + (action === 'forget' ? 1 : 0), action === 'forget' ? 'relearn' : 'review', prevRsm2(m0, now), log, durationSec, scheduled.ease, scheduled.reviewCount)
}

function computeFixed(input: FullComputeInput): ComputeResult {
  const { memory: m0, grade, config: c, now = new Date(), tzOffsetMin = 0, durationSec, ease = 2.5 } = input
  const action: ReviewAction = grade === 'again' ? 'forget' : grade === 'hard' ? 'fuzzy' : 'familiar'
  const scheduled = scheduleFixedReview(
    { ease, interval: Math.round(m0.s) || 0, reviewCount: m0.reps },
    action,
    now,
    tzOffsetMin,
  )
  const log: ComputeLogLine[] = [
    { step: '固定间隔', detail: `序列[${c.fixedSteps.join(',')}] 动作=${action} 间隔=${scheduled.interval}天`, value: scheduled.interval },
  ]
  return finalizeMemory(m0, grade, c, now, scheduled.nextReviewAt, scheduled.interval, scheduled.interval, m0.d, scheduled.reviewCount, m0.lapses + (action === 'forget' ? 1 : 0), action === 'forget' ? 'relearn' : 'review', prevRsm2(m0, now), log, durationSec, ease, scheduled.reviewCount)
}

function computeSimple(input: FullComputeInput): ComputeResult {
  const { memory: m0, grade, config: c, now = new Date(), tzOffsetMin = 0, durationSec, ease = 2.5 } = input
  const action: ReviewAction = grade === 'again' ? 'forget' : 'familiar'
  const scheduled = scheduleSimpleReview(
    { ease, interval: Math.round(m0.s) || 0, reviewCount: m0.reps },
    action,
    now,
    tzOffsetMin,
  )
  const log: ComputeLogLine[] = [
    { step: '简单模式', detail: `${action === 'familiar' ? '会→翻倍' : '不会→重置'} 间隔=${scheduled.interval}天`, value: scheduled.interval },
  ]
  return finalizeMemory(m0, grade, c, now, scheduled.nextReviewAt, scheduled.interval, scheduled.interval, m0.d, scheduled.reviewCount, m0.lapses + (action === 'forget' ? 1 : 0), action === 'forget' ? 'relearn' : 'review', prevRsm2(m0, now), log, durationSec, ease, scheduled.reviewCount)
}

function prevRsm2(m: CardMemory, now: Date): number {
  // SM-2 模式无 R 概念，按 elapsed 粗估
  return retrievability(Math.max(m.s, 0.5), elapsedDays(m, now))
}

// ---------------------------------------------------------------------------
// 自定义公式模式（安全表达式求值）
// ---------------------------------------------------------------------------
function computeCustom(input: FullComputeInput): ComputeResult {
  const { memory: m0, grade, config: c, now = new Date(), tzOffsetMin = 0, durationSec } = input
  const log: ComputeLogLine[] = []
  const m = cloneMemory(m0)
  const el = elapsedDays(m, now)
  const prevR = retrievability(m.s, el)
  const rating = gradeRating(grade)
  const ratingFactor = grade === 'hard' ? c.hardPenalty : grade === 'easy' ? c.easyBonus : grade === 'again' ? c.lapseSRetention : 1.0

  // 难度
  let dNew = m.d
  if (c.customExpr.difficulty) {
    try {
      dNew = clamp(safeEval(c.customExpr.difficulty, ctx(m, el, prevR, rating, ratingFactor, c, 0)), 1, 10)
      log.push({ step: '自定义·难度', detail: c.customExpr.difficulty.slice(0, 60), value: dNew })
    } catch (e) {
      log.push({ step: '自定义·难度错误', detail: (e as Error).message })
    }
  } else {
    dNew = clamp(m.d + 0.8 * (3 - rating), 1, 10)
  }

  // 稳定性
  let sNew = m.s
  if (c.customExpr.stability) {
    try {
      sNew = safeEval(c.customExpr.stability, ctx(m, el, prevR, rating, ratingFactor, c, 0))
      sNew = clamp(sNew, c.lapseMinS, c.maxInterval)
      log.push({ step: '自定义·稳定', detail: `S→${sNew.toFixed(2)}`, value: sNew })
    } catch (e) {
      log.push({ step: '自定义·稳定错误', detail: (e as Error).message })
    }
  } else {
    sNew = clamp(m.s * (1 + 0.5 * (1 - prevR)) * ratingFactor, c.lapseMinS, c.maxInterval)
  }

  // 间隔
  let intervalDays: number
  if (c.customExpr.interval) {
    try {
      intervalDays = safeEval(c.customExpr.interval, ctx(m, el, prevR, rating, ratingFactor, c, sNew))
      intervalDays = clamp(intervalDays, c.minInterval, c.maxInterval)
      log.push({ step: '自定义·间隔', detail: `${intervalDays.toFixed(2)}天`, value: intervalDays })
    } catch (e) {
      log.push({ step: '自定义·间隔错误', detail: (e as Error).message })
      intervalDays = intervalFromS(sNew, c)
    }
  } else {
    intervalDays = intervalFromS(sNew, c)
  }

  const newState: CardMemory['state'] = grade === 'again' ? 'relearn' : m.state === 'new' ? 'review' : m.state
  const reps = grade === 'again' ? 0 : m.reps + 1
  const lapses = m.lapses + (grade === 'again' ? 1 : 0)
  return finalize(m0, grade, c, now, tzOffsetMin, dNew, sNew, newState, m.step, reps, lapses, prevR, log, durationSec, intervalDays, deriveEase(dNew))
}

function ctx(
  m: CardMemory,
  el: number,
  r: number,
  rating: number,
  ratingFactor: number,
  c: AlgorithmConfig,
  newS: number,
): Record<string, number> {
  return {
    S: m.s,
    D: m.d,
    R: r,
    t: el,
    reps: m.reps,
    lapses: m.lapses,
    rating,
    ratingFactor,
    desiredRetention: c.desiredRetention,
    newS,
    interval: m.s,
    maxInterval: c.maxInterval,
    minInterval: c.minInterval,
    easeBonus: c.easyBonus,
    hardPenalty: c.hardPenalty,
    lapseSRetention: c.lapseSRetention,
    PI: Math.PI,
    E: Math.E,
  }
}

// ---------------------------------------------------------------------------
// 收尾：构造 ComputeResult（FSRS/custom 共用）
// ---------------------------------------------------------------------------
function finalize(
  m0: CardMemory,
  grade: Grade,
  c: AlgorithmConfig,
  now: Date,
  tzOffsetMin: number,
  dNew: number,
  sNew: number,
  newState: CardMemory['state'],
  step: number,
  reps: number,
  lapses: number,
  prevR: number,
  log: ComputeLogLine[],
  durationSec: number | undefined,
  intervalDays: number,
  ease: number,
): ComputeResult {
  // 亚天间隔（学习/重学步骤，分钟级）：nextReviewAt = now + intervalDays 天，不走当日零点锚定
  const floored = Math.max(intervalDays, c.minInterval)
  const nextReviewAt =
    intervalDays < 1
      ? new Date(now.getTime() + intervalDays * DAY_MS)
      : nextReviewDate(now, floored, tzOffsetMin)
  const memory: CardMemory = {
    ...m0,
    s: sNew,
    d: dNew,
    reps,
    lapses,
    state: newState,
    lastGrade: grade,
    lastReviewAt: now.toISOString(),
    step,
    history: appendHistory(m0, grade, sNew, dNew, prevR, elapsedDays(m0, now), now, durationSec),
  }
  log.push({ step: '完成', detail: `间隔=${intervalDays.toFixed(2)}天 下次=${nextReviewAt.toISOString().slice(0, 16)}`, value: intervalDays })
  return { memory, nextReviewAt, interval: intervalDays < 1 ? intervalDays : floored, prevR, log, ease, reviewCount: reps }
}

/** SM-2/固定/简单 共用收尾（直接传 nextReviewAt） */
function finalizeMemory(
  m0: CardMemory,
  grade: Grade,
  c: AlgorithmConfig,
  now: Date,
  nextReviewAt: Date,
  intervalDays: number,
  sNew: number,
  dNew: number,
  reps: number,
  lapses: number,
  state: CardMemory['state'],
  prevR: number,
  log: ComputeLogLine[],
  durationSec: number | undefined,
  ease: number,
  reviewCount: number,
): ComputeResult {
  const memory: CardMemory = {
    ...m0,
    s: sNew,
    d: dNew,
    reps,
    lapses,
    state,
    lastGrade: grade,
    lastReviewAt: now.toISOString(),
    step: 0,
    history: appendHistory(m0, grade, sNew, dNew, prevR, elapsedDays(m0, now), now, durationSec),
  }
  return { memory, nextReviewAt, interval: intervalDays, prevR, log, ease, reviewCount }
}

function appendHistory(
  m: CardMemory,
  grade: Grade,
  s: number,
  d: number,
  r: number,
  el: number,
  now: Date,
  durationSec?: number,
) {
  const entry = { at: now.toISOString(), grade, s, d, r, elapsedDays: el, ...(durationSec ? { durationSec } : {}) }
  const h = [...m.history, entry]
  return h.length > 200 ? h.slice(h.length - 200) : h
}

function cloneMemory(m: CardMemory): CardMemory {
  return { ...m, history: [...m.history] }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

// ---------------------------------------------------------------------------
// 4 档预览 + R 曲线
// ---------------------------------------------------------------------------
export function previewCard(
  memory: CardMemory,
  config: AlgorithmConfig,
  algorithm: AlgorithmType,
  now = new Date(),
  tzOffsetMin = 0,
  ease?: number,
): CardPreview {
  const el = elapsedDays(memory, now)
  const curR = retrievability(memory.s, el)
  const grades: GradePreview[] = (['again', 'hard', 'good', 'easy'] as Grade[]).map((g) => {
    const r = computeReview({ memory, grade: g, config, algorithm, now, tzOffsetMin, ease })
    return {
      grade: g,
      interval: r.interval,
      nextReviewAt: r.nextReviewAt.toISOString(),
      newS: r.memory.s,
      newD: r.memory.d,
      newR: retrievability(r.memory.s, r.interval),
    }
  })
  const maxDay = Math.max(30, Math.min(config.maxInterval, 90))
  const rCurve: { days: number; r: number }[] = []
  const cur = memory.s > 0 ? memory.s : 1
  for (let d = 0; d <= maxDay; d += Math.max(1, Math.round(maxDay / 60))) {
    rCurve.push({ days: d, r: retrievability(cur, el + d) })
  }
  return {
    current: { s: memory.s, d: memory.d, r: curR, state: memory.state, elapsedDays: el, interval: memory.s > 0 ? intervalFromS(memory.s, config) : 0 },
    grades,
    rCurve,
  }
}

// ---------------------------------------------------------------------------
// 配置解析：全局默认 → 单卡覆盖（合并）
// ---------------------------------------------------------------------------
export function resolveConfig(
  globalAlg: AlgorithmType,
  globalCfg: AlgorithmConfig,
  cardAlgType?: string | null,
  cardCfgJson?: string,
): ResolvedConfig {
  const chain: ResolvedConfig['sourceChain'] = [{ scope: 'global', algorithm: globalAlg }]
  if (cardAlgType && isValidAlgType(cardAlgType)) {
    const cardCfg = mergeConfig(safeParseJson(cardCfgJson))
    return {
      algorithm: cardAlgType,
      config: mergeWithBase(globalCfg, cardCfg, cardAlgType),
      sourceChain: [...chain, { scope: 'card', algorithm: cardAlgType }],
    }
  }
  return { algorithm: globalAlg, config: globalCfg, sourceChain: chain }
}

function mergeWithBase(base: AlgorithmConfig, overlay: AlgorithmConfig, _type: AlgorithmType): AlgorithmConfig {
  // 单卡覆盖：以 overlay 中「非默认」的字段覆盖 base。简化：直接用 overlay 全量字段
  // （前端保存单卡配置时已合并全局基础值），保留 base.customExpr 兜底。
  return {
    ...base,
    ...overlay,
    customExpr: { ...base.customExpr, ...overlay.customExpr },
    w: overlay.w?.length === 17 ? overlay.w : base.w,
  }
}

export function isValidAlgType(v: unknown): v is AlgorithmType {
  return v === 'fsrs' || v === 'sm2' || v === 'fixed' || v === 'simple' || v === 'custom'
}

function safeParseJson(s?: string): unknown {
  if (!s) return {}
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// 安全表达式求值器（递归下降，无 eval/Function，白名单函数）
// ---------------------------------------------------------------------------
export function safeEval(expr: string, vars: Record<string, number>): number {
  const parser = new ExprParser(expr)
  return parser.parse(vars)
}

const FN_TABLE: Record<string, (args: number[]) => number> = {
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  pow: (a) => Math.pow(a[0], a[1]),
  sqrt: (a) => Math.sqrt(a[0]),
  exp: (a) => Math.exp(a[0]),
  log: (a) => Math.log(a[0]),
  abs: (a) => Math.abs(a[0]),
  round: (a) => Math.round(a[0]),
  floor: (a) => Math.floor(a[0]),
  ceil: (a) => Math.ceil(a[0]),
  sin: (a) => Math.sin(a[0]),
  cos: (a) => Math.cos(a[0]),
  clamp: (a) => Math.min(a[2], Math.max(a[1], a[0])),
  mean: (a) => {
    // mean(a, b, w) = a*(1-w) + b*w ；mean(a,b,...) 等权均值
    if (a.length === 3) return a[0] * (1 - a[2]) + a[1] * a[2]
    return a.reduce((s, x) => s + x, 0) / a.length
  },
}

class ExprParser {
  private s: string
  private i = 0
  constructor(s: string) {
    this.s = s
  }
  parse(vars: Record<string, number>): number {
    const v = this.expr(vars)
    this.skipWs()
    if (this.i < this.s.length) throw new Error(`表达式未消费完: "${this.s.slice(this.i)}"`)
    return v
  }
  private expr(vars: Record<string, number>): number {
    let v = this.term(vars)
    while (true) {
      this.skipWs()
      const c = this.s[this.i]
      if (c === '+') { this.i++; v += this.term(vars) }
      else if (c === '-') { this.i++; v -= this.term(vars) }
      else break
    }
    return v
  }
  private term(vars: Record<string, number>): number {
    let v = this.factor(vars)
    while (true) {
      this.skipWs()
      const c = this.s[this.i]
      if (c === '*') { this.i++; v *= this.factor(vars) }
      else if (c === '/') { this.i++; const d = this.factor(vars); if (d === 0) throw new Error('除零'); v /= d }
      else if (c === '%') { this.i++; v %= this.factor(vars) }
      else break
    }
    return v
  }
  private factor(vars: Record<string, number>): number {
    let v = this.unary(vars)
    this.skipWs()
    if (this.s[this.i] === '^') { this.i++; v = Math.pow(v, this.unary(vars)) }
    return v
  }
  private unary(vars: Record<string, number>): number {
    this.skipWs()
    if (this.s[this.i] === '-') { this.i++; return -this.unary(vars) }
    if (this.s[this.i] === '+') { this.i++; return this.unary(vars) }
    return this.atom(vars)
  }
  private atom(vars: Record<string, number>): number {
    this.skipWs()
    const c = this.s[this.i]
    if (c === '(') {
      this.i++
      const v = this.expr(vars)
      this.skipWs()
      if (this.s[this.i] !== ')') throw new Error('缺少 )')
      this.i++
      return v
    }
    if (/[0-9.]/.test(c)) {
      let num = ''
      while (this.i < this.s.length && /[0-9.eE+\-]/.test(this.s[this.i])) {
        // 防止把 1e-3 的 - 吃成减号：仅当 e/E 后紧跟 +/-
        if ((this.s[this.i] === '+' || this.s[this.i] === '-') && !/[eE]/.test(this.s[this.i - 1] || '')) break
        num += this.s[this.i++]
      }
      const n = Number(num)
      if (!Number.isFinite(n)) throw new Error(`无效数字 "${num}"`)
      return n
    }
    if (/[a-zA-Z_]/.test(c)) {
      let id = ''
      while (this.i < this.s.length && /[a-zA-Z0-9_]/.test(this.s[this.i])) id += this.s[this.i++]
      this.skipWs()
      if (this.s[this.i] === '(') {
        this.i++
        const args: number[] = []
        this.skipWs()
        if (this.s[this.i] !== ')') {
          args.push(this.expr(vars))
          this.skipWs()
          while (this.s[this.i] === ',') { this.i++; args.push(this.expr(vars)); this.skipWs() }
        }
        if (this.s[this.i] !== ')') throw new Error(`函数 ${id} 缺少 )`)
        this.i++
        const fn = FN_TABLE[id]
        if (!fn) throw new Error(`未知函数 ${id}`)
        return fn(args)
      }
      if (id in vars) return vars[id]
      throw new Error(`未知变量 ${id}`)
    }
    throw new Error(`意外字符 "${c}" at ${this.i}`)
  }
  private skipWs() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++
  }
}

export { defaultConfig, mergeConfig } from './presets'
