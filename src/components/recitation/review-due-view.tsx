'use client'

// 待复习：服务端 nextReviewAt 驱动的到期卡片（含计划覆盖后的到期卡）。
// - 顶部算法选择器：FSRS / SM-2 / 固定 / 简单 / 自定义（localStorage 持久化，
//   评分提交时作为 algorithm 参数传给 POST /api/review）
// - 「开始复习」进入逐张背书复习会话（自动打开每张卡片的复习模式）：
//     · 沉浸复习模式（默认开）：全屏挖空正文（点空显示答案 / 一键显示全部答案，
//       挖空样式与字号跟随全局设置），底部评分条档位随方案变化，
//       评分后自动下一张，全部完成显示总结
//     · 关闭时逐张只显示标题，快速过卡评分
// - 列表行：标题 + 最近动作色点 + 「计划」徽标（卡片绑定了 activePlanId 时显示，
//   服务端在评分时按计划天数覆盖 nextReviewAt，到期即进入本队列），点击打开背书页
// - 批量：顶栏全选 + 行复选框，底部操作条「忽略（30 天）」「过几天提醒（1/3/7 天）」
// - 空态：「太棒了，暂无待复习内容」
// Rendered inside a parent `flex min-h-screen flex-col` wrapper:
// provides its own sticky header (h-14) + flex-1 main; no footer.

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  BellOff,
  Brain,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Info,
  Play,
  SkipForward,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import type {
  CardData,
  ClozeStyle,
  ReviewPlanData,
  SettingsData,
} from '@/lib/types'
import {
  type AlgorithmType,
  type Grade,
  type CardPreview,
  ALGORITHM_TYPES,
  GRADES,
  isValidAlgType,
} from '@/lib/spaced-repetition'
import { getState, putState } from '@/lib/server-state'
import { todayKey } from '@/lib/use-local-storage'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { ClozeText } from '@/components/recitation/cloze-text'
import { ReviewScoreBar } from '@/components/recitation/review-score-bar'
import { AlgorithmConfigDialog } from '@/components/recitation/algorithm-config-dialog'
import { AlgorithmStatsView } from '@/components/recitation/algorithm-stats-view'
import { CardMemoryDetail } from '@/components/recitation/card-memory-detail'

export interface ReviewDueViewProps {
  onBack: () => void
  onOpenCard: (id: string) => void
}

/** /api/review/due 返回的到期卡 */
interface DueCardRow {
  id: string
  title: string
  /** familiar | fuzzy | forget | none */
  lastAction: string
  /** ISO 时间 */
  lastActionAt: string
  daysSince: number
  nextReviewAt: string | null
  isNew: boolean
}

/** 待复习队列项 = 服务端 nextReviewAt 到期卡（含计划覆盖后的到期卡） */
interface QueueItem extends DueCardRow {
  source: 'due' | 'plan'
  /** 卡片绑定的复习计划名（显示「计划」徽标） */
  planNames: string[]
  /** 计划第几天（保留字段，计划驱动调度后由服务端 nextReviewAt 决定到期，客户端不再计算） */
  planDay: number | null
}

/** 复习会话状态（逐张过卡 + 结果统计） */
interface SessionState {
  queue: QueueItem[]
  index: number
  results: { again: number; hard: number; good: number; easy: number }
  skipped: number
}

const ACTION_META: Record<string, { label: string; dot: string }> = {
  familiar: { label: '熟悉', dot: 'bg-emerald-500' },
  fuzzy: { label: '模糊', dot: 'bg-amber-500' },
  forget: { label: '忘记', dot: 'bg-red-500' },
}

const REMIND_DAYS = [1, 3, 7]

/** 复习间隔人性化格式化：<1天显示分钟/小时，<30天显示天，<365显示月，否则年 */
export function fmtReviewInterval(days: number | null | undefined): string {
  if (days == null || !Number.isFinite(days) || days <= 0) return '不久'
  if (days < 1 / 1440) return '立即'
  if (days < 1) {
    const mins = Math.round(days * 1440)
    if (mins < 60) return `${mins} 分钟`
    return `${Math.round(mins / 60)} 小时`
  }
  if (days < 30) return `${days.toFixed(days < 10 ? 1 : 0)} 天`
  if (days < 365) return `${Math.round(days / 30)} 个月`
  return `${(days / 365).toFixed(1)} 年`
}

// localStorage（个人偏好，按任务约定不加服务端设置项）
const ALG_KEY = 'beishuba-review-algorithm'
const IMMERSIVE_KEY = 'beishuba-review-immersive'

function readStoredAlgorithm(): AlgorithmType {
  try {
    const v = window.localStorage.getItem(ALG_KEY)
    if (isValidAlgType(v)) return v
  } catch {
    /* ignore */
  }
  return 'fsrs'
}

function readStoredImmersive(): boolean {
  try {
    return window.localStorage.getItem(IMMERSIVE_KEY) !== '0'
  } catch {
    return true
  }
}

function dueMeta(item: QueueItem) {
  const meta = ACTION_META[item.lastAction] ?? { label: '复习', dot: 'bg-muted-foreground' }
  const days = item.daysSince <= 0 ? '今天复习过' : `${item.daysSince} 天前复习`
  return { ...meta, days }
}

export function ReviewDueView({ onBack, onOpenCard }: ReviewDueViewProps) {
  const [cards, setCards] = React.useState<QueueItem[] | null>(null) // null = loading
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [busy, setBusy] = React.useState(false)
  const [remindOpen, setRemindOpen] = React.useState(false)

  // 复习算法 + 沉浸模式（localStorage 持久化）+ 全局启用的算法集合
  const [algorithm, setAlgorithm] = React.useState<AlgorithmType>(() =>
    typeof window === 'undefined' ? 'fsrs' : readStoredAlgorithm(),
  )
  const [enabledAlgs, setEnabledAlgs] = React.useState<AlgorithmType[]>(['fsrs'])
  const [immersive, setImmersive] = React.useState<boolean>(() =>
    typeof window === 'undefined' ? true : readStoredImmersive(),
  )
  // 算法配置面板（全局 / 单卡）+ 统计面板 + 单卡记忆详情
  const [algConfig, setAlgConfig] = React.useState<{ open: boolean; scope: 'global' | 'card'; cardId?: string; cardTitle?: string }>({
    open: false,
    scope: 'global',
  })
  const [statsOpen, setStatsOpen] = React.useState(false)
  const [memDetail, setMemDetail] = React.useState<{ id: string; title: string } | null>(null)
  // 会话中当前卡的 4 档预览
  const [cardPreview, setCardPreview] = React.useState<CardPreview | null>(null)

  // 复习会话
  const [session, setSession] = React.useState<SessionState | null>(null)
  const [scoring, setScoring] = React.useState(false)
  const [revealed, setRevealed] = React.useState<Set<number>>(new Set())
  const [showAnswers, setShowAnswers] = React.useState(false)
  const cardStartAtRef = React.useRef<number>(Date.now())

  // 沉浸模式渲染正文需要：全量卡片（id → CardData）与挖空显示设置
  const [cardMap, setCardMap] = React.useState<Map<string, CardData>>(new Map())
  const [clozeCfg, setClozeCfg] = React.useState<{ clozeStyle: ClozeStyle; fontSize: number }>({
    clozeStyle: 'circle',
    fontSize: 18,
  })

  // ---------- data ----------
  // 计划驱动调度：服务端在 POST /api/review 时按 card.activePlanId 覆盖 nextReviewAt，
  // /api/review/due 已据 nextReviewAt <= now 判定到期 —— 这里无需客户端再叠加计划项。
  // 仅拉取卡片→计划绑定映射，给到期卡显示「计划」徽标与计划名。
  const load = React.useCallback(async () => {
    try {
      const [dueRes, cardsRes, plansRes, assignRes] = await Promise.all([
        fetch('/api/review/due'),
        fetch('/api/cards'),
        fetch('/api/plans'),
        fetch('/api/plans?assignments=1'),
      ])
      const dueData = (await dueRes.json()) as { cards?: DueCardRow[]; error?: string }
      if (!dueRes.ok) throw new Error(dueData.error || '加载失败')
      const dueCards: DueCardRow[] = Array.isArray(dueData.cards) ? dueData.cards : []

      const cardsData = (await cardsRes.json().catch(() => ({}))) as { cards?: CardData[] }
      const allCards: CardData[] = Array.isArray(cardsData.cards) ? cardsData.cards : []
      setCardMap(new Map(allCards.map((c) => [c.id, c])))

      const plansData = (await plansRes.json().catch(() => ({}))) as { plans?: ReviewPlanData[] }
      const plans: ReviewPlanData[] = Array.isArray(plansData.plans) ? plansData.plans : []
      const planMap = new Map<string, ReviewPlanData>(plans.map((p) => [p.id, p]))

      // 卡片 → activePlanId 绑定映射（仅含已绑定卡）
      const assignData = (await assignRes.json().catch(() => ({}))) as {
        assignments?: Record<string, string>
      }
      const assignments: Record<string, string> = assignData.assignments ?? {}

      // ---- 合并队列：完全由服务端 nextReviewAt 驱动（含计划覆盖后的到期卡）----
      // 给每张到期卡附上「计划」徽标信息：activePlanId 解析到计划名 → planNames。
      const queue: QueueItem[] = dueCards.map((c) => {
        const planId = assignments[c.id]
        const plan = planId ? planMap.get(planId) : undefined
        return {
          ...c,
          source: plan ? ('plan' as const) : ('due' as const),
          planNames: plan ? [plan.name] : [],
          planDay: null,
        }
      })
      setCards(queue)
    } catch (err: unknown) {
      setCards([])
      toast.error('待复习加载失败：' + (err instanceof Error ? err.message : '未知错误'))
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  // 复习后回到本列表自动刷新：页面重新可见（从阅读页返回）或窗口聚焦时重新拉取，
  // 让刚评分的卡片（nextReviewAt 已推进）立即从待复习队列消失。
  React.useEffect(() => {
    const reload = () => void load()
    const onVis = () => {
      if (document.visibilityState === 'visible') reload()
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', reload)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', reload)
    }
  }, [load])

  // 挖空显示设置（沉浸模式正文渲染用，与背书页同一份全局设置）
  React.useEffect(() => {
    let alive = true
    fetch('/api/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((s: SettingsData | null) => {
        if (alive && s) {
          setClozeCfg({ clozeStyle: s.clozeStyle ?? 'circle', fontSize: s.fontSize ?? 18 })
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // ---------- 加载全局启用的算法集合 ----------
  React.useEffect(() => {
    let alive = true
    fetch('/api/algorithms/config')
      .then((r) => r.json())
      .then((d: { global?: { enabled?: string[]; algorithm?: string } }) => {
        if (!alive) return
        const en = (d.global?.enabled ?? []).filter(isValidAlgType)
        if (en.length > 0) setEnabledAlgs(en)
        const ga = d.global?.algorithm
        if (isValidAlgType(ga)) setAlgorithm(ga as AlgorithmType)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // ---------- algorithm / immersive ----------
  const changeAlgorithm = (next: AlgorithmType) => {
    setAlgorithm(next)
    try {
      window.localStorage.setItem(ALG_KEY, next)
    } catch {
      /* ignore */
    }
    toast.info(`已切换复习算法：${ALGORITHM_TYPES.find((a) => a.value === next)?.label ?? next}`)
  }

  const changeImmersive = (next: boolean) => {
    setImmersive(next)
    try {
      window.localStorage.setItem(IMMERSIVE_KEY, next ? '1' : '0')
    } catch {
      /* ignore */
    }
  }

  // ---------- selection ----------
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  const allSelected = !!cards && cards.length > 0 && cards.every((c) => selected.has(c.id))
  const toggleAll = () => {
    if (!cards) return
    setSelected(allSelected ? new Set() : new Set(cards.map((c) => c.id)))
  }

  // ---------- actions ----------
  // POST /api/review/due { cardIds, days }：days=30 → 忽略；1/3/7 → 过几天提醒
  const snooze = async (days: number) => {
    if (selected.size === 0 || busy) return
    setBusy(true)
    const ids = Array.from(selected)
    const tid = toast.loading(days >= 30 ? '正在忽略…' : '正在设置提醒…')
    try {
      const res = await fetch('/api/review/due', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardIds: ids, days }),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok || !data.ok) throw new Error(data.error || '操作失败')
      // 刷新列表（移除已处理的卡片）并清空选择
      const gone = new Set(ids)
      setCards((prev) => (prev ? prev.filter((c) => !gone.has(c.id)) : prev))
      setSelected(new Set())
      toast.success(days >= 30 ? '已忽略，30 天内不再提醒' : `已设置，${days} 天后提醒`, {
        id: tid,
      })
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '操作失败', { id: tid })
    } finally {
      setBusy(false)
      setRemindOpen(false)
    }
  }

  // ---------- 复习会话 ----------
  const startSession = (onlySelected = false) => {
    if (!cards || cards.length === 0 || session) return
    const pool = onlySelected && selected.size > 0 ? cards.filter((c) => selected.has(c.id)) : cards
    if (pool.length === 0) return
    setSession({
      queue: pool.map((c) => ({ ...c })),
      index: 0,
      results: { again: 0, hard: 0, good: 0, easy: 0 },
      skipped: 0,
    })
    setRevealed(new Set())
    setShowAnswers(false)
    setCardPreview(null)
    cardStartAtRef.current = Date.now()
  }

  const exitSession = () => {
    setSession(null)
    void load()
  }

  // 与背书页评分保持一致：每次评分给「今日计划」进度 +1（服务端 KV plan-<id>-<日期>），
  // 背书页据此显示今日背诵次数。
  const bumpTodayProgress = React.useCallback(async (cardId: string) => {
    const key = todayKey(cardId)
    const values = await getState([key])
    const cur = Number(values[key])
    const next = (Number.isFinite(cur) && cur > 0 ? cur : 0) + 1
    await putState(key, String(next))
  }, [])

  const scoreInSession = async (grade: Grade) => {
    const s = session
    if (!s || scoring) return
    const item = s.queue[s.index]
    if (!item) return
    setScoring(true)
    try {
      const res = await fetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardId: item.id,
          cardTitle: item.title,
          grade,
          algorithm,
          durationSec: Math.min(
            3600,
            Math.max(1, Math.round((Date.now() - cardStartAtRef.current) / 1000)),
          ),
          tzOffset: new Date().getTimezoneOffset(),
        }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error || '记录失败')
      }
      const data = (await res.json()) as { interval?: number }
      // 评分成功：计数 + 从队列移除 + 推进今日计划进度，然后自动下一张
      setSession((prev) =>
        prev
          ? {
              ...prev,
              results: { ...prev.results, [grade]: prev.results[grade] + 1 },
              index: prev.index + 1,
            }
          : prev,
      )
      setCards((prev) => (prev ? prev.filter((c) => c.id !== item.id) : prev))
      setSelected((prev) => {
        if (!prev.has(item.id)) return prev
        const n = new Set(prev)
        n.delete(item.id)
        return n
      })
      void bumpTodayProgress(item.id)
      cardStartAtRef.current = Date.now()
      const label = GRADES.find((g) => g.value === grade)?.label ?? grade
      toast.success(`已评「${label}」· 下次 ${fmtReviewInterval(data.interval)} 后复习`, { duration: 1600 })
    } catch (err: unknown) {
      toast.error('评分失败：' + (err instanceof Error ? err.message : '未知错误'))
    } finally {
      // 留出按压反馈时间，再解锁下一张的评分
      window.setTimeout(() => setScoring(false), 220)
    }
  }

  const skipInSession = () => {
    if (!session || scoring) return
    setSession((prev) =>
      prev ? { ...prev, skipped: prev.skipped + 1, index: prev.index + 1 } : prev,
    )
    cardStartAtRef.current = Date.now()
  }

  // 换卡时重置挖空显示状态
  React.useEffect(() => {
    setRevealed(new Set())
  }, [session?.index])

  const handleReveal = (idx: number) => {
    setRevealed((prev) => {
      if (prev.has(idx)) return prev
      const n = new Set(prev)
      n.add(idx)
      return n
    })
  }

  const isEmpty = cards !== null && cards.length === 0
  const planCount = cards?.filter((c) => c.planNames.length > 0).length ?? 0

  // ---------- 会话派生状态 ----------
  const total = session?.queue.length ?? 0
  const pos = session ? Math.min(session.index + 1, total) : 0
  const sessionDone = !!session && session.index >= total
  const currentItem = session && !sessionDone ? session.queue[session.index] : null
  const currentCardData = currentItem ? (cardMap.get(currentItem.id) ?? null) : null
  const scoredCount = session
    ? session.results.again + session.results.hard + session.results.good + session.results.easy
    : 0

  // 会话中拉取当前卡的 4 档预览（供评分条显示间隔）
  React.useEffect(() => {
    if (!session || sessionDone || !currentItem) {
      setCardPreview(null)
      return
    }
    let alive = true
    fetch('/api/algorithms/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardId: currentItem.id, tzOffset: new Date().getTimezoneOffset() }),
    })
      .then((r) => r.json())
      .then((d: { preview?: CardPreview }) => {
        if (alive) setCardPreview(d.preview ?? null)
      })
      .catch(() => {
        if (alive) setCardPreview(null)
      })
    return () => {
      alive = false
    }
  }, [session?.index, session, sessionDone, currentItem])

  // 会话底部评分区（沉浸 / 快速两种模式共用）
  const scoreFooter = (
    <div className="border-t border-border px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">
      <div className="mb-2.5 flex items-center justify-between">
        <button
          type="button"
          onClick={skipInSession}
          disabled={scoring}
          className="flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
        >
          <SkipForward className="size-3.5" strokeWidth={1.75} aria-hidden />
          跳过本张
        </button>
        <p className="text-xs text-muted-foreground">
          {ALGORITHM_TYPES.find((a) => a.value === algorithm)?.label} · 背完后自评
        </p>
      </div>
      <ReviewScoreBar
        algorithm={algorithm}
        disabled={scoring}
        previews={cardPreview?.grades ?? null}
        onScore={(g) => void scoreInSession(g)}
      />
    </div>
  )

  return (
    <>
      {/* ---------- 顶栏 ---------- */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="relative mx-auto flex h-14 w-full max-w-2xl items-center px-3">
          <Button
            variant="ghost"
            size="icon"
            aria-label="返回"
            className="text-muted-foreground"
            onClick={onBack}
          >
            <ChevronLeft className="size-5" strokeWidth={1.75} />
          </Button>
          <h1 className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-base font-bold">
            {cards ? `待复习 ${cards.length} 张` : '待复习'}
          </h1>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label="算法统计"
              className="text-muted-foreground"
              onClick={() => setStatsOpen(true)}
            >
              <BarChart3 className="size-5" strokeWidth={1.75} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="算法配置"
              className="text-muted-foreground"
              onClick={() => setAlgConfig({ open: true, scope: 'global' })}
            >
              <Brain className="size-5" strokeWidth={1.75} />
            </Button>
            <label className="flex cursor-pointer items-center gap-1.5 pl-1 text-xs text-muted-foreground">
              <Checkbox
                checked={allSelected}
                disabled={!cards || cards.length === 0}
                onCheckedChange={toggleAll}
                aria-label="全选"
                className="size-5"
              />
              全选
            </label>
          </div>
        </div>
      </header>

      {/* ---------- 主内容 ---------- */}
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 pb-40 pt-4">
        {/* 算法选择 + 开始复习 */}
        <section
          className="rounded-2xl border border-border bg-card p-4 shadow-sm"
          aria-label="复习算法"
        >
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-bold">复习算法</p>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              沉浸复习模式
              <Switch
                checked={immersive}
                onCheckedChange={changeImmersive}
                aria-label="沉浸复习模式（逐张显示挖空正文）"
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5" role="radiogroup" aria-label="复习算法">
            {ALGORITHM_TYPES.filter((a) => enabledAlgs.includes(a.value)).map((a) => (
              <button
                key={a.value}
                type="button"
                role="radio"
                aria-checked={algorithm === a.value}
                onClick={() => changeAlgorithm(a.value)}
                className={cn(
                  'h-9 rounded-xl border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  algorithm === a.value
                    ? 'border-zinc-900 bg-zinc-900 text-white'
                    : 'border-border bg-background text-foreground hover:bg-muted',
                )}
              >
                {a.label}
              </button>
            ))}
            {enabledAlgs.length === 0 && (
              <span className="text-xs text-muted-foreground">未启用算法，点右上角齿轮配置</span>
            )}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground" aria-live="polite">
            {ALGORITHM_TYPES.find((a) => a.value === algorithm)?.desc}
            {planCount > 0 ? ` · 含计划驱动复习 ${planCount} 张` : ''}
          </p>
          <Button
            className="mt-3 h-12 w-full rounded-xl bg-primary text-base font-semibold"
            disabled={!cards || cards.length === 0 || !!session}
            onClick={() => startSession(false)}
          >
            <Play className="size-4" strokeWidth={2} aria-hidden />
            开始复习{cards && cards.length > 0 ? `（${cards.length} 张）` : ''}
          </Button>
          {selected.size > 0 && (
            <Button
              className="mt-2 h-11 w-full rounded-xl border border-emerald-600/50 bg-emerald-500/10 text-base font-semibold text-emerald-700 dark:text-emerald-400"
              disabled={!cards || cards.length === 0 || !!session}
              onClick={() => startSession(true)}
            >
              <Play className="size-4" strokeWidth={2} aria-hidden />
              仅复习选中（{selected.size} 张）
            </Button>
          )}
        </section>

        {cards === null ? (
          <div className="mt-4 flex flex-col gap-3">
            <Skeleton className="h-20 rounded-2xl" />
            <Skeleton className="h-20 rounded-2xl" />
            <Skeleton className="h-20 rounded-2xl" />
          </div>
        ) : isEmpty ? (
          <div className="flex flex-1 flex-col items-center justify-center py-16 text-center">
            <div className="flex size-20 items-center justify-center rounded-full bg-emerald-500/10">
              <CheckCircle2 className="size-10 text-emerald-600" strokeWidth={1.5} aria-hidden />
            </div>
            <p className="mt-6 text-lg text-muted-foreground">太棒了，暂无待复习内容</p>
            <p className="mt-1.5 text-sm text-muted-foreground/70">
              完成复习后，卡片会按复习周期再次出现在这里
            </p>
            <p className="mt-1 text-sm text-muted-foreground/70">
              在「复习计划管理」把计划应用到书籍，即可按计划天数自动安排复习
            </p>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-3" role="list" aria-label="待复习列表">
            {cards.map((item, i) => {
              const meta = dueMeta(item)
              const checked = selected.has(item.id)
              return (
                <motion.div
                  key={item.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, delay: Math.min(i * 0.03, 0.3), ease: 'easeOut' }}
                  role="listitem"
                  tabIndex={0}
                  aria-label={`打开背书卡：${item.title}`}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm transition-all hover:shadow-md',
                    checked && 'border-emerald-600/60 ring-1 ring-emerald-600/40',
                  )}
                  onClick={() => onOpenCard(item.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onOpenCard(item.id)
                    }
                  }}
                >
                  <button
                    type="button"
                    aria-label={checked ? `取消选择 ${item.title}` : `选择 ${item.title}`}
                    className="-m-1 flex size-11 shrink-0 items-center justify-center"
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleSelect(item.id)
                    }}
                  >
                    <Checkbox
                      checked={checked}
                      className="pointer-events-none size-5"
                      tabIndex={-1}
                      aria-hidden
                    />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <h2 className="min-w-0 truncate text-[15px] font-bold leading-snug">
                        {item.title || '未命名卡片'}
                      </h2>
                      {item.planNames.length > 0 && (
                        <span
                          className="shrink-0 rounded-full border border-emerald-600/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600"
                          title={`复习计划：${item.planNames.join('、')}`}
                        >
                          计划
                        </span>
                      )}
                    </div>
                    {item.source === 'plan' ? (
                      <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span
                          className="size-2 shrink-0 rounded-full bg-emerald-500"
                          aria-hidden
                        />
                        <span className="min-w-0 truncate">
                          {item.planNames.join('、')} · 计划驱动复习
                        </span>
                      </p>
                    ) : (
                      <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className={cn('size-2 shrink-0 rounded-full', meta.dot)} aria-hidden />
                        <span>{meta.label}</span>
                        <span aria-hidden>·</span>
                        <span className="min-w-0 truncate">{meta.days}</span>
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      aria-label={`记忆详情 ${item.title}`}
                      className="-m-1 flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted"
                      onClick={(e) => {
                        e.stopPropagation()
                        setMemDetail({ id: item.id, title: item.title })
                      }}
                    >
                      <Info className="size-4" strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      aria-label={`算法配置 ${item.title}`}
                      className="-m-1 flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted"
                      onClick={(e) => {
                        e.stopPropagation()
                        setAlgConfig({ open: true, scope: 'card', cardId: item.id, cardTitle: item.title })
                      }}
                    >
                      <Brain className="size-4" strokeWidth={1.75} />
                    </button>
                    <ChevronRight
                      className="size-4 shrink-0 text-muted-foreground/50"
                      strokeWidth={1.75}
                      aria-hidden
                    />
                  </div>
                </motion.div>
              )
            })}
          </div>
        )}
      </main>

      {/* ---------- 批量操作条（固定，安全区上方） ---------- */}
      {cards !== null && cards.length > 0 && selected.size > 0 && !session && (
        <motion.div
          initial={{ y: 90, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 400, damping: 34 }}
          className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
        >
          <div className="flex w-full max-w-md items-center gap-2 rounded-2xl border border-border bg-background/95 p-2 shadow-xl backdrop-blur">
            <span className="pl-2 text-xs text-muted-foreground">已选 {selected.size} 项</span>
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="outline"
                className="rounded-full"
                disabled={busy}
                onClick={() => void snooze(30)}
              >
                <BellOff className="size-4" strokeWidth={1.75} aria-hidden />
                忽略
              </Button>
              <Popover open={remindOpen} onOpenChange={setRemindOpen}>
                <PopoverTrigger asChild>
                  <Button className="rounded-full bg-primary" disabled={busy}>
                    <CalendarClock className="size-4" strokeWidth={1.75} aria-hidden />
                    过几天提醒
                  </Button>
                </PopoverTrigger>
                <PopoverContent side="top" align="end" className="w-40 rounded-2xl p-1.5">
                  {REMIND_DAYS.map((d) => (
                    <button
                      key={d}
                      type="button"
                      disabled={busy}
                      className="flex h-10 w-full items-center rounded-xl px-3 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50"
                      onClick={() => void snooze(d)}
                    >
                      {d} 天后提醒
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
            </div>
          </div>
        </motion.div>
      )}

      {/* ---------- 复习会话（背书复习模式：自动逐张打开） ---------- */}
      {session && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-background"
          role="dialog"
          aria-modal="true"
          aria-label="背书复习模式"
        >
          {/* 顶栏：退出 + 进度 */}
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Button
              variant="ghost"
              size="icon"
              aria-label="退出复习"
              className="text-muted-foreground"
              onClick={exitSession}
            >
              <X className="size-5" strokeWidth={1.75} />
            </Button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold leading-tight">
                {sessionDone ? '复习完成' : currentItem?.title || '未命名卡片'}
              </p>
              <p className="text-[11px] leading-tight text-muted-foreground">
                {sessionDone
                  ? `共 ${total} 张`
                  : `第 ${pos} / ${total} 张${currentItem?.source === 'plan' ? ' · 计划项' : ''}`}
              </p>
            </div>
            {immersive && !sessionDone && (
              <Button
                variant="outline"
                size="sm"
                className="h-9 shrink-0 rounded-full px-3 text-xs"
                aria-pressed={showAnswers}
                onClick={() => setShowAnswers((v) => !v)}
              >
                {showAnswers ? (
                  <EyeOff className="size-4" strokeWidth={1.75} aria-hidden />
                ) : (
                  <Eye className="size-4" strokeWidth={1.75} aria-hidden />
                )}
                {showAnswers ? '遮住答案' : '显示答案'}
              </Button>
            )}
          </div>
          <Progress
            value={total > 0 ? (Math.min(session.index, total) / total) * 100 : 0}
            className="h-1 rounded-none"
            aria-label="复习进度"
          />

          {sessionDone ? (
            /* ---------- 总结 ---------- */
            <div className="flex flex-1 flex-col items-center justify-center px-6 pb-8 text-center">
              <div className="flex size-20 items-center justify-center rounded-full bg-emerald-500/10">
                <CheckCircle2 className="size-10 text-emerald-600" strokeWidth={1.5} aria-hidden />
              </div>
              <p className="mt-5 text-xl font-bold">复习完成！</p>
              <p className="mt-1.5 text-sm text-muted-foreground">
                共复习 {scoredCount} 张
                {session.skipped > 0 ? ` · 跳过 ${session.skipped} 张` : ''}
              </p>
              <div className="mt-6 flex w-full max-w-xs flex-col gap-2">
                {GRADES.map((g) => (
                  <div
                    key={g.value}
                    className="flex items-center justify-between rounded-xl bg-muted/60 px-4 py-2.5 text-sm"
                  >
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <span className="size-2 rounded-full" style={{ background: g.color }} />
                      {g.label}
                    </span>
                    <span className="font-bold tabular-nums">{session.results[g.value]} 张</span>
                  </div>
                ))}
              </div>
              <Button
                className="mt-6 w-full max-w-xs rounded-full bg-primary font-semibold"
                onClick={exitSession}
              >
                完成
              </Button>
            </div>
          ) : immersive ? (
            /* ---------- 沉浸模式：挖空正文 + 评分 ---------- */
            <>
              <div className="flex-1 overflow-y-auto px-4 py-4">
                {currentCardData ? (
                  <ClozeText
                    key={currentItem?.id}
                    content={currentCardData.content}
                    keywords={currentCardData.keywords}
                    style={clozeCfg.clozeStyle}
                    showAnswers={showAnswers}
                    fontSize={clozeCfg.fontSize}
                    revealed={revealed}
                    onReveal={handleReveal}
                    onToggleKeyword={() => {
                      /* 复习模式不改挖空 */
                    }}
                  />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                    <p className="text-base font-bold">{currentItem?.title}</p>
                    <p className="text-sm text-muted-foreground">
                      {cardMap.size > 0 ? '该卡片已删除或不可用' : '正文加载中…'}
                    </p>
                  </div>
                )}
              </div>
              {scoreFooter}
            </>
          ) : (
            /* ---------- 快速模式：仅标题过卡 ---------- */
            <>
              <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
                <p className="text-xl font-bold">{currentItem?.title}</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {currentItem?.source === 'plan'
                    ? currentItem.planNames.join('、')
                    : currentItem
                      ? dueMeta(currentItem).days
                      : ''}
                </p>
              </div>
              {scoreFooter}
            </>
          )}
        </div>
      )}

      {/* ---------- 算法配置面板（全局 / 单卡） ---------- */}
      <AlgorithmConfigDialog
        open={algConfig.open}
        onOpenChange={(v) => setAlgConfig((s) => ({ ...s, open: v }))}
        scope={algConfig.scope}
        cardId={algConfig.cardId}
        cardTitle={algConfig.cardTitle}
      />

      {/* ---------- 单卡记忆详情 ---------- */}
      {memDetail && (
        <CardMemoryDetail
          cardId={memDetail.id}
          cardTitle={memDetail.title}
          open
          onOpenChange={(v) => {
            if (!v) setMemDetail(null)
          }}
        />
      )}

      {/* ---------- 统计仪表盘（全屏覆盖） ---------- */}
      {statsOpen && (
        <AlgorithmStatsView
          onBack={() => setStatsOpen(false)}
          onOpenCard={(id) => {
            setStatsOpen(false)
            onOpenCard(id)
          }}
        />
      )}
    </>
  )
}
