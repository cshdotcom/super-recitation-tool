'use client'

// 单卡记忆详情面板：FSRS 记忆状态可视化
// 包含 参数面板、R 衰减曲线（含未来天数滑块模拟）、4 档预览。
// 数据源：POST /api/algorithms/preview { cardId, tzOffset }
import * as React from 'react'
import { Brain, Clock, TrendingDown, Activity } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Slider } from '@/components/ui/slider'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface CardMemoryDetailProps {
  cardId: string
  cardTitle: string
  /** 受控开关 */
  open: boolean
  onOpenChange: (v: boolean) => void
}

type AlgorithmType = 'fsrs' | 'sm2' | 'fixed' | 'simple' | 'custom'
type Grade = 'again' | 'hard' | 'good' | 'easy'
type CardState = 'new' | 'learning' | 'review' | 'relearn' | 'suspended'

interface PreviewCurrent {
  s: number
  d: number
  r: number
  state: CardState
  elapsedDays: number
  interval: number
  /** 可选：连续正确次数（API 未返回时显示 -） */
  reps?: number
  /** 可选：累计遗忘次数（API 未返回时显示 -） */
  lapses?: number
}

interface GradePreview {
  grade: Grade
  interval: number
  nextReviewAt: string
  newS: number
  newD: number
  newR: number
}

interface RCurvePoint {
  days: number
  r: number
}

interface CardPreview {
  current: PreviewCurrent
  grades: GradePreview[]
  rCurve: RCurvePoint[]
}

interface PreviewResponse {
  preview: CardPreview
  algorithm: AlgorithmType
  config: unknown
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const GRADE_META: { grade: Grade; label: string; color: string }[] = [
  { grade: 'again', label: '忘记', color: '#ef4444' },
  { grade: 'hard', label: '困难', color: '#f59e0b' },
  { grade: 'good', label: '良好', color: '#10b981' },
  { grade: 'easy', label: '简单', color: '#3b82f6' },
]

const STATE_META: { state: CardState; label: string; color: string }[] = [
  { state: 'new', label: '新卡', color: '#6b7280' },
  { state: 'learning', label: '初学中', color: '#3b82f6' },
  { state: 'review', label: '复习中', color: '#10b981' },
  { state: 'relearn', label: '重学中', color: '#f59e0b' },
  { state: 'suspended', label: '已暂停', color: '#9ca3af' },
]

const ALG_LABEL: Record<AlgorithmType, string> = {
  fsrs: 'FSRS',
  sm2: 'SM-2',
  fixed: '固定间隔',
  simple: '简单模式',
  custom: '自定义',
}

/** 目标保留率（用于在曲线图上画虚线参考线） */
const TARGET_R = 0.9

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function fmtInterval(days: number): string {
  if (!Number.isFinite(days)) return '-'
  if (days < 1) return `${Math.round(days * 1440)}分`
  if (days < 30) return `${days.toFixed(1)}天`
  if (days < 365) return `${Math.round(days / 30)}月`
  return `${(days / 365).toFixed(1)}年`
}

/** FSRS 风格 R 公式：R = (1 + t / (9*S))^-1 */
function computeR(days: number, s: number): number {
  if (!Number.isFinite(s) || s <= 0) return 0
  if (!Number.isFinite(days) || days <= 0) return 1
  const r = Math.pow(1 + days / (9 * s), -1)
  return Math.max(0, Math.min(1, r))
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '-'
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  } catch {
    return '-'
  }
}

function stateMeta(s: CardState) {
  return STATE_META.find((x) => x.state === s) ?? STATE_META[0]
}

function rColor(r: number): string {
  if (r < 0.5) return '#ef4444'
  if (r < 0.7) return '#f59e0b'
  return '#10b981'
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export function CardMemoryDetail({
  cardId,
  cardTitle,
  open,
  onOpenChange,
}: CardMemoryDetailProps) {
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [data, setData] = React.useState<PreviewResponse | null>(null)
  const [simDay, setSimDay] = React.useState(0)

  // 加载预览
  const loadPreview = React.useCallback(async () => {
    if (!cardId) return
    setLoading(true)
    setError(null)
    setData(null)
    try {
      const res = await fetch('/api/algorithms/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardId,
          tzOffset: new Date().getTimezoneOffset(),
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        throw new Error(j?.error || `请求失败 (${res.status})`)
      }
      const json = (await res.json()) as PreviewResponse
      setData(json)
      const ed = json.preview?.current?.elapsedDays ?? 0
      setSimDay(Math.max(0, Math.round(ed)))
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [cardId])

  React.useEffect(() => {
    if (!open || !cardId) return
    void loadPreview()
  }, [open, cardId, loadPreview])

  const preview = data?.preview ?? null
  const algorithm = data?.algorithm ?? 'fsrs'
  const lastDay = React.useMemo(() => {
    if (!preview?.rCurve?.length) return 0
    return Math.max(0, Math.round(preview.rCurve[preview.rCurve.length - 1].days))
  }, [preview])
  const current = preview?.current ?? null

  // 模拟 R 值
  const simR = React.useMemo(() => {
    if (!current) return 0
    return computeR(simDay, current.s)
  }, [simDay, current])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg max-h-[85vh] overflow-hidden p-0 gap-0"
        showCloseButton
      >
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border/60 shrink-0 text-left">
          <div className="flex items-center gap-2">
            <Brain className="size-4 text-emerald-600" />
            <DialogTitle className="text-base">记忆详情</DialogTitle>
            <Badge
              variant="outline"
              className="ml-auto text-[10px] py-0 px-1.5 border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
            >
              {ALG_LABEL[algorithm]}
            </Badge>
          </div>
          <DialogDescription className="truncate text-xs">
            {cardTitle || '未命名卡片'}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0 max-h-[calc(85vh-64px)]">
          <div className="px-5 py-4 space-y-5">
            {loading && <LoadingSkeleton />}

            {!loading && error && (
              <ErrorState message={error} onRetry={() => void loadPreview()} />
            )}

            {!loading && !error && preview && current && (
              <>
                {/* 参数面板 */}
                <ParamsPanel current={current} />

                {/* R 衰减曲线 */}
                <RCurveSection
                  rCurve={preview.rCurve}
                  current={current}
                  simDay={simDay}
                  simR={simR}
                  lastDay={lastDay}
                  onSimDay={setSimDay}
                />

                {/* 4 档预览 */}
                <GradesSection grades={preview.grades} />
              </>
            )}

            {!loading && !error && !preview && (
              <div className="py-10 text-center text-sm text-muted-foreground">
                暂无记忆数据
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// 子组件：加载骨架
// ---------------------------------------------------------------------------

function LoadingSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-40 rounded-lg" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 子组件：错误状态 + 重试
// ---------------------------------------------------------------------------

function ErrorState({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <div className="py-10 flex flex-col items-center gap-3 text-center">
      <div className="size-10 rounded-full bg-red-50 dark:bg-red-950/30 flex items-center justify-center">
        <span className="text-red-600 text-lg font-bold">!</span>
      </div>
      <div className="text-sm text-muted-foreground max-w-xs">{message}</div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-1 px-3 py-1.5 text-xs rounded-md border border-emerald-500/50 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-colors"
      >
        重试
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 子组件：参数面板（2x2 + 子指标行）
// ---------------------------------------------------------------------------

function StatTile({
  label,
  value,
  icon,
  color,
  sub,
}: {
  label: string
  value: React.ReactNode
  icon: React.ReactNode
  color: string
  sub?: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3 flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span style={{ color }}>{icon}</span>
        <span>{label}</span>
      </div>
      <div className="text-base font-semibold leading-tight" style={{ color }}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  )
}

function ParamsPanel({ current }: { current: PreviewCurrent }) {
  const rPct = Math.round(current.r * 100)
  const rColorVal = rColor(current.r)
  const sm = stateMeta(current.state)

  return (
    <section>
      <SectionTitle icon={<Activity className="size-3.5" />}>参数面板</SectionTitle>
      <div className="grid grid-cols-2 gap-3">
        <StatTile
          label="稳定性 S"
          value={current.s.toFixed(1)}
          icon={<TrendingDown className="size-3" />}
          color="#10b981"
          sub="天 · 越大越稳定"
        />
        <StatTile
          label="难度 D"
          value={current.d.toFixed(1)}
          icon={<Activity className="size-3" />}
          color="#f59e0b"
          sub="1-10 · 越高越难"
        />
        <StatTile
          label="可提取性 R"
          value={`${rPct}%`}
          icon={<Brain className="size-3" />}
          color={rColorVal}
          sub={
            <div className="mt-1">
              <Progress
                value={rPct}
                className={cn(
                  'h-1.5 bg-muted',
                  '[&_[data-slot=progress-indicator]]:[background-color:var(--r-color)]',
                )}
                style={
                  {
                    '--r-color': rColorVal,
                  } as React.CSSProperties
                }
              />
              <div
                className="mt-1 inline-flex items-center gap-1 text-[10px]"
                style={{ color: rColorVal }}
              >
                {rPct < 50
                  ? '风险高'
                  : rPct < 70
                    ? '需复习'
                    : '记忆良好'}
              </div>
            </div>
          }
        />
        <StatTile
          label="状态"
          value={
            <span style={{ color: sm.color }}>
              <span
                className="inline-block size-2 rounded-full mr-1.5 align-middle"
                style={{ backgroundColor: sm.color }}
              />
              {sm.label}
            </span>
          }
          icon={<Clock className="size-3" />}
          color={sm.color}
          sub={current.state === 'suspended' ? '已暂停复习' : '当前卡片状态'}
        />
      </div>

      {/* 子指标 */}
      <div className="mt-3 grid grid-cols-4 gap-2">
        <MiniStat
          label="连续对"
          value={
            typeof current.reps === 'number'
              ? String(Math.round(current.reps))
              : '-'
          }
        />
        <MiniStat
          label="遗忘次数"
          value={
            typeof current.lapses === 'number'
              ? String(Math.round(current.lapses))
              : '-'
          }
        />
        <MiniStat label="经过天数" value={current.elapsedDays.toFixed(1)} />
        <MiniStat label="当前间隔" value={fmtInterval(current.interval)} />
      </div>
    </section>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/40 px-2 py-1.5 text-center">
      <div className="text-[10px] text-muted-foreground truncate">{label}</div>
      <div className="text-xs font-medium text-foreground truncate">{value}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 子组件：R 衰减曲线（手绘 SVG + 滑块）
// ---------------------------------------------------------------------------

function RCurveSection({
  rCurve,
  current,
  simDay,
  simR,
  lastDay,
  onSimDay,
}: {
  rCurve: RCurvePoint[]
  current: PreviewCurrent
  simDay: number
  simR: number
  lastDay: number
  onSimDay: (v: number) => void
}) {
  const W = 320
  const H = 140
  const padL = 24
  const padR = 8
  const padT = 8
  const padB = 18
  const plotW = W - padL - padR
  const plotH = H - padT - padB

  const xMax = Math.max(1, lastDay, Math.round(current.interval) || 1)
  const xOf = (d: number) => padL + (d / xMax) * plotW
  const yOf = (r: number) => padT + (1 - r) * plotH

  // 构造路径（rCurve 仅 ~60 点，直接计算，无需 memo）
  const pathD = rCurve.length
    ? rCurve
        .map((p, i) => {
          const x = xOf(p.days)
          const y = yOf(p.r)
          return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
        })
        .join(' ')
    : ''

  const simX = xOf(simDay)
  const simY = yOf(simR)
  const curX = xOf(Math.min(current.elapsedDays, xMax))
  const curY = yOf(current.r)
  const intervalX = xOf(Math.min(current.interval, xMax))
  const targetY = yOf(TARGET_R)

  return (
    <section>
      <SectionTitle icon={<TrendingDown className="size-3.5" />}>
        R 衰减曲线
      </SectionTitle>
      <div className="rounded-lg border border-border/60 bg-muted/20 p-2">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-auto"
          role="img"
          aria-label="可提取性随时间衰减曲线"
        >
          {/* 网格 */}
          {[0, 0.25, 0.5, 0.75, 1].map((g) => (
            <line
              key={g}
              x1={padL}
              x2={W - padR}
              y1={yOf(g)}
              y2={yOf(g)}
              stroke="currentColor"
              className="text-border"
              strokeWidth={0.5}
            />
          ))}

          {/* 目标保留率虚线 */}
          <line
            x1={padL}
            x2={W - padR}
            y1={targetY}
            y2={targetY}
            stroke="#10b981"
            strokeWidth={1}
            strokeDasharray="3 3"
            opacity={0.7}
          />
          <text
            x={W - padR - 2}
            y={targetY - 3}
            fontSize={8}
            fill="#10b981"
            textAnchor="end"
          >
            目标 90%
          </text>

          {/* Y 轴标签 */}
          <text x={2} y={padT + 4} fontSize={8} fill="currentColor" className="text-muted-foreground">
            1
          </text>
          <text x={2} y={padT + plotH} fontSize={8} fill="currentColor" className="text-muted-foreground">
            0
          </text>

          {/* 衰减曲线 */}
          {pathD && (
            <path
              d={pathD}
              fill="none"
              stroke="#10b981"
              strokeWidth={1.6}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}

          {/* 当前间隔竖线 */}
          {current.interval > 0 && (
            <line
              x1={intervalX}
              x2={intervalX}
              y1={padT}
              y2={padT + plotH}
              stroke="#f59e0b"
              strokeWidth={1}
              strokeDasharray="2 2"
              opacity={0.8}
            />
          )}

          {/* 模拟点（由滑块控制） */}
          {simDay > 0 && (
            <>
              <line
                x1={simX}
                x2={simX}
                y1={padT}
                y2={padT + plotH}
                stroke="#71717a"
                strokeWidth={0.8}
                opacity={0.5}
              />
              <circle cx={simX} cy={simY} r={3.5} fill="#71717a" />
            </>
          )}

          {/* 当前点 */}
          <circle cx={curX} cy={curY} r={4} fill="#ef4444" stroke="#fff" strokeWidth={1.2} />
        </svg>

        {/* 图例 */}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground px-1">
          <Legend color="#ef4444">当前 {Math.round(current.r * 100)}%</Legend>
          <Legend color="#10b981">R 曲线</Legend>
          <Legend color="#10b981" dashed>
            目标 90%
          </Legend>
          <Legend color="#f59e0b" dashed>
            间隔 {fmtInterval(current.interval)}
          </Legend>
          {simDay > 0 && <Legend color="#71717a">模拟 第{simDay}天</Legend>}
        </div>
      </div>

      {/* 滑块 */}
      <div className="mt-3 px-1">
        <div className="flex items-center justify-between text-xs mb-2">
          <span className="text-muted-foreground">模拟未来天数</span>
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            模拟第 {simDay} 天：R=
            <span style={{ color: rColor(simR) }}>
              {Math.round(simR * 100)}%
            </span>
          </span>
        </div>
        <Slider
          min={0}
          max={Math.max(1, lastDay)}
          step={1}
          value={[simDay]}
          onValueChange={(v) => onSimDay(Array.isArray(v) ? (v[0] ?? 0) : (v ?? 0))}
        />
        <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
          <span>0 天</span>
          <span>{lastDay} 天</span>
        </div>
      </div>
    </section>
  )
}

function Legend({
  color,
  dashed,
  children,
}: {
  color: string
  dashed?: boolean
  children: React.ReactNode
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="inline-block h-[2px] w-3"
        style={{
          backgroundColor: dashed ? 'transparent' : color,
          borderTop: dashed ? `2px dashed ${color}` : undefined,
        }}
      />
      <span>{children}</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// 子组件：4 档预览
// ---------------------------------------------------------------------------

function GradesSection({ grades }: { grades: GradePreview[] }) {
  // 确保 4 档顺序一致
  const ordered = GRADE_META.map((gm) => {
    const g = grades.find((x) => x.grade === gm.grade)
    return g ? { meta: gm, g } : null
  }).filter(Boolean) as { meta: (typeof GRADE_META)[number]; g: GradePreview }[]

  return (
    <section>
      <SectionTitle icon={<Clock className="size-3.5" />}>4 档预览</SectionTitle>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {ordered.map(({ meta, g }) => (
          <div
            key={g.grade}
            className="rounded-lg border border-border/60 bg-muted/20 overflow-hidden flex flex-col"
            style={{ borderTopColor: meta.color, borderTopWidth: 2 }}
          >
            <div
              className="px-2 py-1 text-[11px] font-medium"
              style={{ color: meta.color }}
            >
              {meta.label}
            </div>
            <div className="px-2 pb-2 pt-1 space-y-1">
              <div className="text-sm font-semibold text-foreground">
                {fmtInterval(g.interval)}
              </div>
              <div className="text-[10px] text-muted-foreground space-y-0.5">
                <div>
                  新 S:
                  <span className="text-emerald-700 dark:text-emerald-400 ml-0.5">
                    {g.newS.toFixed(1)}
                  </span>
                </div>
                <div>
                  新 D:
                  <span className="text-amber-700 dark:text-amber-400 ml-0.5">
                    {g.newD.toFixed(1)}
                  </span>
                </div>
                <div className="text-foreground/80">
                  {fmtDate(g.nextReviewAt)}
                </div>
              </div>
            </div>
          </div>
        ))}
        {ordered.length === 0 && (
          <div className="col-span-full py-4 text-center text-xs text-muted-foreground">
            无预览数据
          </div>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// 通用区块标题
// ---------------------------------------------------------------------------

function SectionTitle({
  icon,
  children,
}: {
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <span className="text-emerald-600">{icon}</span>
      {children}
    </h3>
  )
}
