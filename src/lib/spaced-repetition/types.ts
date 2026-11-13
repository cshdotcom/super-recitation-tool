// ===========================================================================
// FSRS 级间隔重复算法 — 类型定义（v2.8.0+）
// 对标 Anki FSRS，自研可控粒度更高。纯函数，服务端 API 与客户端共用。
// ===========================================================================

/** 算法类型 */
export type AlgorithmType = 'fsrs' | 'sm2' | 'fixed' | 'simple' | 'custom'

export const ALGORITHM_TYPES: { value: AlgorithmType; label: string; desc: string }[] = [
  { value: 'fsrs', label: 'FSRS 自适应', desc: '基于记忆稳定性 S / 难度 D / 可提取性 R 的现代算法，目标保留率可调' },
  { value: 'sm2', label: 'SM-2 艾宾浩斯', desc: '经典 SuperMemo-2：难度系数 EF + 间隔，熟悉/模糊/忘记三档' },
  { value: 'fixed', label: '固定间隔', desc: '1/2/4/7/15/30 天序列，记得前进一格，忘记回到起点' },
  { value: 'simple', label: '简单模式', desc: '只有 会/不会 两档，会=间隔翻倍，不会=重置 1 天' },
  { value: 'custom', label: '自定义公式', desc: '用表达式自定义 S/D/间隔更新逻辑，可视化编辑' },
]

/** 4 档评分（FSRS 风格）。旧 3 档 familiar/fuzzy/forget 自动映射：
 *  familiar→good, fuzzy→hard, forget→again */
export type Grade = 'again' | 'hard' | 'good' | 'easy'

export const GRADES: { value: Grade; label: string; color: string; rating: number }[] = [
  { value: 'again', label: '忘记', color: '#ef4444', rating: 1 },
  { value: 'hard', label: '困难', color: '#f59e0b', rating: 2 },
  { value: 'good', label: '良好', color: '#10b981', rating: 3 },
  { value: 'easy', label: '简单', color: '#3b82f6', rating: 4 },
]

/** 旧 3 档动作 → 新 4 档评分映射 */
export function legacyActionToGrade(action: string): Grade {
  if (action === 'familiar') return 'good'
  if (action === 'fuzzy') return 'hard'
  return 'again'
}

/** 卡片状态机 */
export type CardState = 'new' | 'learning' | 'review' | 'relearn' | 'suspended'

export const CARD_STATES: { value: CardState; label: string; color: string }[] = [
  { value: 'new', label: '新卡', color: '#6b7280' },
  { value: 'learning', label: '初学中', color: '#3b82f6' },
  { value: 'review', label: '复习中', color: '#10b981' },
  { value: 'relearn', label: '重学中', color: '#f59e0b' },
  { value: 'suspended', label: '已暂停', color: '#9ca3af' },
]

/** 单卡完整记忆状态（JSON 持久化到 Card.srsState） */
export interface CardMemory {
  /** 稳定性 S（天） */
  s: number
  /** 难度 D（1-10，5=默认；越高越难） */
  d: number
  /** 连续成功复习次数 */
  reps: number
  /** 累计遗忘次数 */
  lapses: number
  /** 状态机当前状态 */
  state: CardState
  /** 上次评分 */
  lastGrade: Grade | null
  /** 上次复习时间 ISO */
  lastReviewAt: string | null
  /** 学习/重学步骤索引（state=learning|relearn 时生效） */
  step: number
  /** 历史复习记录 */
  history: ReviewHistoryEntry[]
}

/** 复习历史条目 */
export interface ReviewHistoryEntry {
  at: string
  grade: Grade
  s: number
  d: number
  /** 当时复习前的可提取性 R（0-1） */
  r: number
  /** 距上次复习的天数 */
  elapsedDays: number
  durationSec?: number
}

/** 算法参数配置（全局默认 / 单卡覆盖 / 模板） */
export interface AlgorithmConfig {
  /** 目标保留率 R_target（0.6-0.95） */
  desiredRetention: number
  /** 最大间隔（天） */
  maxInterval: number
  /** 最小间隔（天，毕业后下限） */
  minInterval: number
  /** FSRS w 参数数组（17 值，高级调参） */
  w: number[]
  /** 初学步骤（分钟） */
  learningSteps: number[]
  /** 重学步骤（分钟） */
  relearnSteps: number[]
  /** SM-2 ease 下限 */
  easeMin: number
  /** SM-2 ease 上限 */
  easeMax: number
  /** SM-2 熟悉封顶（天） */
  sm2MaxFamiliar: number
  /** SM-2 模糊封顶（天） */
  sm2MaxFuzzy: number
  /** 固定间隔序列（天） */
  fixedSteps: number[]
  /** 简单模式间隔上限（天） */
  simpleMax: number
  /** 遗忘后 S 保留比例（0.1-0.9） */
  lapseSRetention: number
  /** 遗忘后 S 下限（天，防锁死） */
  lapseMinS: number
  /** Easy 增益系数（1.0-2.0） */
  easyBonus: number
  /** Hard 惩罚系数（0.5-1.0） */
  hardPenalty: number
  /** 间隔加微小随机抖动（防成簇到期） */
  fuzz: boolean
  /** 启用提前复习增益 */
  enableEarlyReview: boolean
  /** 启用延迟复习惩罚 */
  enableLatePenalty: boolean
  /** 自定义公式（algorithm=custom 时生效） */
  customExpr: {
    stability?: string
    difficulty?: string
    interval?: string
  }
  /** 每日新卡上限 */
  dailyNewLimit: number
  /** 每日复习卡上限 */
  dailyReviewLimit: number
  /** 复习排序策略 */
  reviewOrder: 'due' | 'lowR' | 'random'
}

/** 计算输入 */
export interface ComputeInput {
  memory: CardMemory
  grade: Grade
  config: AlgorithmConfig
  algorithm: AlgorithmType
  now?: Date
  tzOffsetMin?: number
  durationSec?: number
}

/** 计算结果 */
export interface ComputeResult {
  memory: CardMemory
  nextReviewAt: Date
  interval: number
  prevR: number
  log: ComputeLogLine[]
  /** 同步到旧 SM-2 字段（向后兼容 due 查询） */
  ease: number
  reviewCount: number
}

export interface ComputeLogLine {
  step: string
  detail: string
  value?: number
}

/** 4 档预览 */
export interface GradePreview {
  grade: Grade
  interval: number
  nextReviewAt: string
  newS: number
  newD: number
  newR: number
}

/** 单卡完整预览 */
export interface CardPreview {
  current: {
    s: number
    d: number
    r: number
    state: CardState
    elapsedDays: number
    interval: number
  }
  grades: GradePreview[]
  /** R 衰减曲线采样点（0 到 maxInterval 天） */
  rCurve: { days: number; r: number }[]
}

/** 算法模板序列化形态 */
export interface AlgorithmTemplateData {
  id: string
  name: string
  type: AlgorithmType
  config: AlgorithmConfig
  description: string
  builtIn: boolean
  createdAt: string
  updatedAt: string
}

export type ConfigScope = 'global' | 'card'

/** 解析后的生效配置 */
export interface ResolvedConfig {
  algorithm: AlgorithmType
  config: AlgorithmConfig
  sourceChain: { scope: ConfigScope; algorithm?: AlgorithmType; templateName?: string }[]
}

/** 默认空记忆（新卡） */
export function emptyMemory(): CardMemory {
  return {
    s: 0,
    d: 5,
    reps: 0,
    lapses: 0,
    state: 'new',
    lastGrade: null,
    lastReviewAt: null,
    step: 0,
    history: [],
  }
}

/** 从 JSON 安全解析 CardMemory */
export function parseMemory(json: string | null | undefined): CardMemory {
  if (!json) return emptyMemory()
  try {
    const p = JSON.parse(json)
    if (!p || typeof p !== 'object') return emptyMemory()
    return {
      s: num(p.s, 0),
      d: num(p.d, 5),
      reps: num(p.reps, 0),
      lapses: num(p.lapses, 0),
      state: validState(p.state) ? p.state : 'new',
      lastGrade:
        p.lastGrade === 'again' || p.lastGrade === 'hard' || p.lastGrade === 'good' || p.lastGrade === 'easy'
          ? p.lastGrade
          : null,
      lastReviewAt: typeof p.lastReviewAt === 'string' ? p.lastReviewAt : null,
      step: num(p.step, 0),
      history: Array.isArray(p.history) ? p.history.filter(isValidHistoryEntry) : [],
    }
  } catch {
    return emptyMemory()
  }
}

function num(v: unknown, def: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : def
}
function validState(s: unknown): s is CardState {
  return s === 'new' || s === 'learning' || s === 'review' || s === 'relearn' || s === 'suspended'
}
function isValidHistoryEntry(e: unknown): e is ReviewHistoryEntry {
  if (!e || typeof e !== 'object') return false
  const o = e as Record<string, unknown>
  return (
    typeof o.at === 'string' &&
    (o.grade === 'again' || o.grade === 'hard' || o.grade === 'good' || o.grade === 'easy') &&
    typeof o.s === 'number' &&
    typeof o.d === 'number' &&
    typeof o.r === 'number' &&
    typeof o.elapsedDays === 'number'
  )
}
