// ===========================================================================
// 队列调度与统计聚合（v2.8.0+）
// ===========================================================================
import type { CardMemory, AlgorithmConfig } from './types'
import { retrievability, elapsedDays } from './engine'
import { parseMemory } from './types'

const DAY_MS = 86_400_000

export interface DueCardMeta {
  id: string
  title: string
  nextReviewAt: Date | null
  memory: CardMemory
  /** 旧 SM-2 interval（向后兼容） */
  interval: number
  lastReviewedAt: Date | null
}

/** 按排序策略排序待复习队列 */
export function orderQueue(
  cards: DueCardMeta[],
  config: AlgorithmConfig,
  now = new Date(),
): DueCardMeta[] {
  const order = config.reviewOrder
  const arr = [...cards]
  if (order === 'random') {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
    return arr
  }
  if (order === 'lowR') {
    arr.sort((a, b) => {
      const ra = cardR(a, now)
      const rb = cardR(b, now)
      if (ra !== rb) return ra - rb
      return dueCmp(a, b, now)
    })
    return arr
  }
  // due：到期优先（最早 nextReviewAt 在前；新卡排最前）
  arr.sort((a, b) => dueCmp(a, b, now))
  return arr
}

function dueCmp(a: DueCardMeta, b: DueCardMeta, now: Date): number {
  const an = a.nextReviewAt
  const bn = b.nextReviewAt
  if (!an && bn) return -1
  if (an && !bn) return 1
  if (!an && !bn) return a.title.localeCompare(b.title)
  return an!.getTime() - bn!.getTime()
}

function cardR(m: DueCardMeta, now: Date): number {
  if (m.memory.s <= 0) return 0.5
  return retrievability(m.memory.s, elapsedDays(m.memory, now))
}

/** 未来 N 天复习负载预测（按 nextReviewAt 分桶） */
export function forecast(cards: DueCardMeta[], days: number, now = new Date()): { day: string; count: number }[] {
  const start = midnight(now)
  const buckets: { day: string; count: number }[] = []
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * DAY_MS)
    buckets.push({ day: d.toISOString().slice(0, 10), count: 0 })
  }
  const last = new Date(start.getTime() + days * DAY_MS)
  for (const c of cards) {
    if (!c.nextReviewAt) {
      // 新卡算今天
      buckets[0].count += 1
      continue
    }
    const t = c.nextReviewAt.getTime()
    if (t <= start.getTime()) {
      buckets[0].count += 1
    } else if (t < last.getTime()) {
      const idx = Math.floor((t - start.getTime()) / DAY_MS)
      if (idx >= 0 && idx < buckets.length) buckets[idx].count += 1
    }
  }
  return buckets
}

function midnight(d: Date): Date {
  return new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS)
}

/** 卡片状态分布（饼图数据） */
export function stateDistribution(cards: { srsState: string; nextReviewAt: Date | null }[]): {
  state: string
  count: number
}[] {
  const counts: Record<string, number> = { new: 0, learning: 0, review: 0, relearn: 0, suspended: 0 }
  for (const c of cards) {
    const m = parseMemory(c.srsState)
    const st = m.state === 'suspended' ? 'suspended' : m.state === 'new' ? 'new' : m.state === 'learning' ? 'learning' : m.state === 'relearn' ? 'relearn' : 'review'
    counts[st] += 1
  }
  return Object.entries(counts).map(([state, count]) => ({ state, count }))
}

/** 间隔分布直方图（当前 review 状态卡片的下次间隔分桶） */
export function intervalHistogram(
  cards: { srsState: string; nextReviewAt: Date | null }[],
  now = new Date(),
): { bucket: string; count: number }[] {
  const buckets = [
    { label: '≤1天', max: 1, count: 0 },
    { label: '2-3天', max: 3, count: 0 },
    { label: '4-7天', max: 7, count: 0 },
    { label: '8-15天', max: 15, count: 0 },
    { label: '16-30天', max: 30, count: 0 },
    { label: '31-90天', max: 90, count: 0 },
    { label: '>90天', max: Infinity, count: 0 },
  ]
  for (const c of cards) {
    const m = parseMemory(c.srsState)
    if (m.state !== 'review' && m.state !== 'relearn') continue
    const nr = c.nextReviewAt ? Math.max(0, (c.nextReviewAt.getTime() - now.getTime()) / DAY_MS) : 0
    for (const b of buckets) {
      if (nr <= b.max) {
        b.count += 1
        break
      }
    }
  }
  return buckets.map((b) => ({ bucket: b.label, count: b.count }))
}

/** 真实回忆率 vs 目标保留率（按最近 N 天 review 日志的答对率） */
export function recallRateTrend(
  logs: { createdAt: Date; action: string }[],
  days: number,
  now = new Date(),
): { day: string; rate: number; total: number }[] {
  const start = midnight(now)
  const buckets: Map<string, { right: number; total: number }> = new Map()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(start.getTime() - i * DAY_MS)
    buckets.set(d.toISOString().slice(0, 10), { right: 0, total: 0 })
  }
  for (const l of logs) {
    const day = midnight(l.createdAt).toISOString().slice(0, 10)
    const b = buckets.get(day)
    if (!b) continue
    if (l.action === 'familiar' || l.action === 'fuzzy' || l.action === 'forget') {
      b.total += 1
      if (l.action === 'familiar') b.right += 1
    }
  }
  return [...buckets.entries()].map(([day, v]) => ({
    day,
    rate: v.total > 0 ? v.right / v.total : 0,
    total: v.total,
  }))
}

/** 复习热力图（每天复习量，最近 N 周） */
export function reviewHeatmap(
  logs: { createdAt: Date; action: string }[],
  weeks: number,
  now = new Date(),
): { day: string; count: number }[] {
  const start = midnight(now)
  const days = weeks * 7
  const map = new Map<string, number>()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(start.getTime() - i * DAY_MS)
    map.set(d.toISOString().slice(0, 10), 0)
  }
  for (const l of logs) {
    const day = midnight(l.createdAt).toISOString().slice(0, 10)
    if (map.has(day)) map.set(day, (map.get(day) || 0) + 1)
  }
  return [...map.entries()].map(([day, count]) => ({ day, count }))
}
