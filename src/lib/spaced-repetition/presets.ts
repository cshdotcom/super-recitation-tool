// ===========================================================================
// 算法预设模板与默认配置（v2.8.0+）
// ===========================================================================
import type { AlgorithmConfig, AlgorithmTemplateData, AlgorithmType } from './types'

/** FSRS w 参数默认值（17 值，FSRS-4.5 启发，自研可调）
 *  [0..3]:  新卡各档初始稳定性 S0（again/hard/good/easy）
 *  [4]:     初始难度 D0
 *  [5]:     难度更新权重 ΔD/rating-step
 *  [6]:     难度均值回归权重
 *  [7]:     稳定性增益基础系数 a
 *  [8]:     稳定性增益 (1-R) 幂
 *  [9]:     稳定性增益 S 幂（负，越大衰减越快）
 *  [10]:    稳定性增益 (11-D) 幂（难度影响）
 *  [11]:    遗忘时 S 保留系数
 *  [12]:    Hard 稳定性系数
 *  [13]:    Easy 稳定性系数
 *  [14]:    重学毕业 S 系数
 *  [15]:    Fuzz 抖动范围（天）
 *  [16]:    保留（扩展） */
export const DEFAULT_W: number[] = [
  0.4, 0.6, 1.0, 2.5, 5.0, 0.8, 0.2, 0.9, 0.5, 0.2, 0.3, 0.5, 0.5, 1.3, 0.4, 0.15, 1.0,
]

export const W_LABELS: string[] = [
  '新卡·忘记 S0',
  '新卡·困难 S0',
  '新卡·良好 S0',
  '新卡·简单 S0',
  '初始难度 D0',
  '难度更新权重',
  '难度回归权重',
  '稳定增益 a',
  '增益(1-R)幂',
  '增益 S 幂',
  '增益(11-D)幂',
  '遗忘 S 保留',
  '困难 S 系数',
  '简单 S 系数',
  '重学毕业 S',
  'Fuzz 范围',
  '保留',
]

/** 默认算法参数（FSRS 推荐） */
export function defaultConfig(): AlgorithmConfig {
  return {
    desiredRetention: 0.9,
    maxInterval: 365,
    minInterval: 1,
    w: [...DEFAULT_W],
    learningSteps: [1, 10],
    relearnSteps: [10],
    easeMin: 1.3,
    easeMax: 2.5,
    sm2MaxFamiliar: 30,
    sm2MaxFuzzy: 7,
    fixedSteps: [1, 2, 4, 7, 15, 30],
    simpleMax: 365,
    lapseSRetention: 0.3,
    lapseMinS: 0.2,
    easyBonus: 1.3,
    hardPenalty: 0.7,
    fuzz: true,
    enableEarlyReview: false,
    enableLatePenalty: true,
    customExpr: {
      stability: 'S * (1 + 0.9 * pow(max(1,11-D), 0.3) * pow(1-R, 0.5) * pow(max(0.01,S), -0.2)) * ratingFactor',
      difficulty: 'mean(max(1, min(10, D - 0.8 * (rating - 3))), 5, 0.2)',
      interval: '9 * newS * (pow(desiredRetention, -1) - 1)',
    },
    dailyNewLimit: 20,
    dailyReviewLimit: 200,
    reviewOrder: 'due',
  }
}

/** 把部分字段覆盖合并到默认配置（容错：未知字段忽略，类型校验） */
export function mergeConfig(overlay: unknown): AlgorithmConfig {
  const base = defaultConfig()
  if (!overlay || typeof overlay !== 'object') return base
  const o = overlay as Record<string, unknown>
  const m = (k: keyof AlgorithmConfig, fn: (v: unknown) => unknown) => {
    if (k in o) {
      const v = fn(o[k])
      ;(base as Record<string, unknown>)[k] = v
    }
  }
  m('desiredRetention', (v) => clampNum(num(v, 0.9), 0.6, 0.95))
  m('maxInterval', (v) => clampNum(num(v, 365), 1, 36500))
  m('minInterval', (v) => clampNum(num(v, 1), 0, 365))
  m('easeMin', (v) => clampNum(num(v, 1.3), 1.0, 3.0))
  m('easeMax', (v) => clampNum(num(v, 2.5), 1.0, 3.0))
  m('sm2MaxFamiliar', (v) => clampNum(num(v, 30), 1, 365))
  m('sm2MaxFuzzy', (v) => clampNum(num(v, 7), 1, 365))
  m('simpleMax', (v) => clampNum(num(v, 365), 1, 36500))
  m('lapseSRetention', (v) => clampNum(num(v, 0.3), 0.05, 0.9))
  m('lapseMinS', (v) => clampNum(num(v, 0.2), 0.05, 10))
  m('easyBonus', (v) => clampNum(num(v, 1.3), 1.0, 2.5))
  m('hardPenalty', (v) => clampNum(num(v, 0.7), 0.3, 1.0))
  m('fuzz', (v) => !!v)
  m('enableEarlyReview', (v) => !!v)
  m('enableLatePenalty', (v) => !!v)
  m('dailyNewLimit', (v) => clampNum(Math.round(num(v, 20)), 0, 1000))
  m('dailyReviewLimit', (v) => clampNum(Math.round(num(v, 200)), 0, 5000))
  m('reviewOrder', (v) => (v === 'due' || v === 'lowR' || v === 'random' ? v : 'due'))
  if (Array.isArray(o.w)) {
    const w = o.w.map((x) => num(x, 0)).slice(0, 17)
    while (w.length < 17) w.push(DEFAULT_W[w.length])
    base.w = w
  }
  if (Array.isArray(o.learningSteps)) base.learningSteps = o.learningSteps.map((x) => num(x, 1)).filter((x) => x > 0)
  if (Array.isArray(o.relearnSteps)) base.relearnSteps = o.relearnSteps.map((x) => num(x, 1)).filter((x) => x > 0)
  if (Array.isArray(o.fixedSteps)) base.fixedSteps = o.fixedSteps.map((x) => num(x, 1)).filter((x) => x > 0)
  if (o.customExpr && typeof o.customExpr === 'object') {
    const ce = o.customExpr as Record<string, unknown>
    base.customExpr = {
      stability: typeof ce.stability === 'string' ? ce.stability : base.customExpr.stability,
      difficulty: typeof ce.difficulty === 'string' ? ce.difficulty : base.customExpr.difficulty,
      interval: typeof ce.interval === 'string' ? ce.interval : base.customExpr.interval,
    }
  }
  return base
}

function num(v: unknown, def: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : def
}
function clampNum(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** 内置预设模板（首启时 seed 到数据库 AlgorithmTemplate） */
export interface PresetDef {
  name: string
  type: AlgorithmType
  description: string
  config: Partial<AlgorithmConfig>
}

export const BUILTIN_PRESETS: PresetDef[] = [
  {
    name: 'FSRS 标准',
    type: 'fsrs',
    description: 'FSRS-4.5 启发的默认参数，目标保留率 90%，适合大多数背诵',
    config: {},
  },
  {
    name: '文科背诵',
    type: 'fsrs',
    description: '长文背诵，保留率 85%，间隔稍长，适合古诗文 / 政治大题',
    config: { desiredRetention: 0.85, maxInterval: 540, easyBonus: 1.2, hardPenalty: 0.8 },
  },
  {
    name: '理科公式',
    type: 'fsrs',
    description: '公式定理精准记忆，保留率 92%，频繁强化，防遗忘',
    config: { desiredRetention: 0.92, maxInterval: 180, easyBonus: 1.15, hardPenalty: 0.6, lapseSRetention: 0.2 },
  },
  {
    name: '错题强化',
    type: 'fsrs',
    description: '错题本专用，保留率 95%，遗忘后大幅降稳定，重学频繁',
    config: {
      desiredRetention: 0.95,
      maxInterval: 120,
      lapseSRetention: 0.15,
      lapseMinS: 0.3,
      hardPenalty: 0.55,
      relearnSteps: [10, 30],
    },
  },
  {
    name: '英语单词',
    type: 'fsrs',
    description: '词汇量大、节奏快，保留率 88%，每日新卡上限放宽',
    config: { desiredRetention: 0.88, maxInterval: 720, dailyNewLimit: 40, dailyReviewLimit: 300, easyBonus: 1.35 },
  },
  {
    name: '经典 SM-2',
    type: 'sm2',
    description: '经典 SuperMemo-2，熟悉/模糊/忘记三档动态难度系数',
    config: {},
  },
  {
    name: '固定间隔序列',
    type: 'fixed',
    description: '1/2/4/7/15/30 天艾宾浩斯序列，记得前进一格，忘记回起点',
    config: {},
  },
  {
    name: '简单会/不会',
    type: 'simple',
    description: '只有两档：会=间隔翻倍，不会=重置 1 天，封顶 365',
    config: {},
  },
  {
    name: '自定义公式',
    type: 'custom',
    description: '用表达式自定义 S/D/间隔更新，可视化编辑器调试',
    config: {},
  },
]

/** 由预设定义构造完整 AlgorithmTemplateData（用于 seed 与前端展示） */
export function presetToTemplate(p: PresetDef): AlgorithmTemplateData {
  const now = new Date().toISOString()
  return {
    id: `builtin-${p.name}`,
    name: p.name,
    type: p.type,
    config: mergeConfig(p.config),
    description: p.description,
    builtIn: true,
    createdAt: now,
    updatedAt: now,
  }
}
