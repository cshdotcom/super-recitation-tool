'use client'

import * as React from 'react'
import {
  ChevronLeft,
  RotateCw,
  TrendingUp,
  AlertTriangle,
  Brain,
  Calendar,
  Target,
  Flame,
} from 'lucide-react'
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'

interface AlgorithmStatsViewProps {
  onBack: () => void
  onOpenCard?: (id: string) => void
}

type CardState = 'new' | 'learning' | 'review' | 'relearn' | 'suspended'

interface DistItem {
  state: CardState
  count: number
}
interface HistItem {
  bucket: string
  count: number
}
interface TrendItem {
  day: string
  rate: number
  total: number
}
interface HeatItem {
  day: string
  count: number
}
interface ForecastItem {
  day: string
  count: number
}
interface RiskItem {
  id: string
  title: string
  r: number
  s: number
  d: number
  state: string
}
interface StatsData {
  dist: DistItem[]
  hist: HistItem[]
  trend: TrendItem[]
  heat: HeatItem[]
  forecast: ForecastItem[]
  risk: RiskItem[]
  today: { total: number; right: number }
  targetRetention: number
  cardsTotal: number
}

/** 每日复习上限阈值，超过的预测柱会高亮 */
const DAILY_REVIEW_LIMIT = 50

const STATE_META: Record<CardState, { label: string; color: string }> = {
  new: { label: '新卡', color: '#6b7280' },
  learning: { label: '学习中', color: '#3b82f6' },
  review: { label: '复习中', color: '#10b981' },
  relearn: { label: '重学', color: '#f59e0b' },
  suspended: { label: '已暂停', color: '#9ca3af' },
}

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']

function formatDayMMDD(day: string): string {
  if (!day) return ''
  const parts = day.split('-')
  if (parts.length >= 3) return `${parts[1]}-${parts[2]}`
  if (parts.length === 2) return `${parts[0]}-${parts[1]}`
  return day
}

function heatColor(count: number): string {
  if (count <= 0) return 'bg-muted'
  if (count <= 2) return 'bg-emerald-200'
  if (count <= 5) return 'bg-emerald-400'
  return 'bg-emerald-600'
}

function retentionBadge(r: number): { label: string; className: string } {
  if (r < 0.5) {
    return {
      label: r.toFixed(2),
      className:
        'border-transparent bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
    }
  }
  if (r < 0.7) {
    return {
      label: r.toFixed(2),
      className:
        'border-transparent bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
    }
  }
  return {
    label: r.toFixed(2),
    className:
      'border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  }
}

function ChartCard({
  title,
  icon,
  children,
}: {
  title: string
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="rounded-2xl border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        {icon}
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      {children}
    </section>
  )
}

function StatCard({
  label,
  value,
  icon,
}: {
  label: string
  value: React.ReactNode
  icon: React.ReactNode
}) {
  return (
    <div className="flex min-w-[136px] flex-1 flex-col rounded-xl border bg-card p-3 shadow-sm">
      <div className="mb-1.5 flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <p className="text-2xl font-bold tabular-nums">{value}</p>
    </div>
  )
}

export function AlgorithmStatsView({ onBack, onOpenCard }: AlgorithmStatsViewProps) {
  const [data, setData] = React.useState<StatsData | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const fetchData = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const tzOffset = new Date().getTimezoneOffset()
      const res = await fetch(
        `/api/algorithms/stats?tzOffset=${tzOffset}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`请求失败 (${res.status})`)
      const json = (await res.json()) as StatsData
      setData(json)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void fetchData()
  }, [fetchData])

  const todayRate =
    data && data.today.total > 0 ? data.today.right / data.today.total : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Sticky header */}
      <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <Button
          variant="ghost"
          size="icon"
          className="size-9"
          onClick={onBack}
          aria-label="返回"
        >
          <ChevronLeft className="size-5" />
        </Button>
        <h1 className="flex-1 text-center text-base font-semibold">
          算法统计仪表盘
        </h1>
        <Button
          variant="ghost"
          size="icon"
          className="size-9"
          onClick={() => void fetchData()}
          aria-label="刷新"
          disabled={loading}
        >
          <RotateCw className={cn('size-5', loading && 'animate-spin')} />
        </Button>
      </header>

      <main className="flex-1 px-3 py-4 pb-10">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {error ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border bg-card p-8 text-center shadow-sm">
              <AlertTriangle className="size-8 text-amber-500" />
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button size="sm" onClick={() => void fetchData()}>
                <RotateCw className="size-4" />
                重试
              </Button>
            </div>
          ) : loading ? (
            <>
              <div className="flex gap-3 overflow-hidden">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-[76px] flex-1 rounded-xl" />
                ))}
              </div>
              <Skeleton className="h-64 rounded-2xl" />
              <Skeleton className="h-64 rounded-2xl" />
              <Skeleton className="h-64 rounded-2xl" />
              <Skeleton className="h-48 rounded-2xl" />
            </>
          ) : data ? (
            <>
              {/* 1. 顶部概览卡片行 */}
              <div className="-mx-3 flex gap-3 overflow-x-auto px-3 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <StatCard
                  label="今日复习"
                  value={data.today.total}
                  icon={<Calendar className="size-3.5" />}
                />
                <StatCard
                  label="今日正确率"
                  value={
                    todayRate !== null
                      ? `${Math.round(todayRate * 100)}%`
                      : '—'
                  }
                  icon={<Target className="size-3.5" />}
                />
                <StatCard
                  label="卡片总数"
                  value={data.cardsTotal}
                  icon={<Brain className="size-3.5" />}
                />
                <StatCard
                  label="高遗忘风险"
                  value={data.risk.length}
                  icon={<AlertTriangle className="size-3.5" />}
                />
              </div>

              {/* 2. 近30天复习量柱状图 */}
              <ChartCard
                title="近30天复习量"
                icon={<TrendingUp className="size-4 text-emerald-600" />}
              >
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart
                    data={data.trend}
                    margin={{ top: 4, right: 4, bottom: 0, left: -24 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      vertical={false}
                      stroke="var(--border)"
                    />
                    <XAxis
                      dataKey="day"
                      tickFormatter={formatDayMMDD}
                      tick={{ fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      interval="preserveStartEnd"
                      minTickGap={20}
                    />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                    />
                    <Tooltip
                      formatter={(value) => [`${value} 张`, '复习量']}
                      labelFormatter={(l) => `日期: ${l}`}
                      contentStyle={{
                        fontSize: 12,
                        borderRadius: 8,
                        border: '1px solid var(--border)',
                      }}
                    />
                    <Bar
                      dataKey="total"
                      fill="#10b981"
                      radius={[3, 3, 0, 0]}
                      maxBarSize={24}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>

              {/* 3. 回忆率趋势 */}
              <ChartCard
                title="回忆率趋势 vs 目标"
                icon={<Target className="size-4 text-emerald-600" />}
              >
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart
                    data={data.trend}
                    margin={{ top: 4, right: 4, bottom: 0, left: -24 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      vertical={false}
                      stroke="var(--border)"
                    />
                    <XAxis
                      dataKey="day"
                      tickFormatter={formatDayMMDD}
                      tick={{ fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      interval="preserveStartEnd"
                      minTickGap={20}
                    />
                    <YAxis
                      domain={[0, 1]}
                      tickFormatter={(v) => `${Math.round(Number(v) * 100)}%`}
                      tick={{ fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      formatter={(value) =>
                        [`${Math.round(Number(value) * 100)}%`, '回忆率']
                      }
                      labelFormatter={(l) => `日期: ${l}`}
                      contentStyle={{
                        fontSize: 12,
                        borderRadius: 8,
                        border: '1px solid var(--border)',
                      }}
                    />
                    <ReferenceLine
                      y={data.targetRetention}
                      stroke="#f59e0b"
                      strokeDasharray="4 4"
                      label={{
                        value: `目标 ${Math.round(data.targetRetention * 100)}%`,
                        fontSize: 10,
                        fill: '#f59e0b',
                        position: 'insideTopRight',
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="rate"
                      stroke="#10b981"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </ChartCard>

              {/* 4. 卡片状态分布 */}
              <ChartCard
                title="卡片状态分布"
                icon={<Brain className="size-4 text-emerald-600" />}
              >
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie
                      data={data.dist}
                      dataKey="count"
                      nameKey="state"
                      cx="50%"
                      cy="50%"
                      outerRadius={72}
                      innerRadius={38}
                      paddingAngle={2}
                    >
                      {data.dist.map((entry) => (
                        <Cell
                          key={entry.state}
                          fill={STATE_META[entry.state]?.color ?? '#9ca3af'}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value, _name, item) => {
                        const state = (item as { payload?: DistItem })?.payload
                          ?.state
                        const label = state
                          ? STATE_META[state]?.label ?? state
                          : ''
                        return [`${value} 张`, label]
                      }}
                      contentStyle={{
                        fontSize: 12,
                        borderRadius: 8,
                        border: '1px solid var(--border)',
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1.5">
                  {data.dist.map((d) => (
                    <div
                      key={d.state}
                      className="flex items-center gap-1.5 text-xs"
                    >
                      <span
                        className="size-2.5 rounded-sm"
                        style={{
                          backgroundColor:
                            STATE_META[d.state]?.color ?? '#9ca3af',
                        }}
                      />
                      <span className="text-muted-foreground">
                        {STATE_META[d.state]?.label ?? d.state}
                      </span>
                      <span className="font-medium tabular-nums">{d.count}</span>
                    </div>
                  ))}
                </div>
              </ChartCard>

              {/* 5. 间隔分布直方图 */}
              <ChartCard
                title="下次间隔分布"
                icon={<TrendingUp className="size-4 text-emerald-600" />}
              >
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart
                    data={data.hist}
                    margin={{ top: 4, right: 4, bottom: 24, left: -24 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      vertical={false}
                      stroke="var(--border)"
                    />
                    <XAxis
                      dataKey="bucket"
                      tick={{ fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      interval={0}
                      angle={-25}
                      textAnchor="end"
                      height={48}
                    />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                    />
                    <Tooltip
                      formatter={(value) => [`${value} 张`, '卡片']}
                      labelFormatter={(l) => `间隔: ${l}`}
                      contentStyle={{
                        fontSize: 12,
                        borderRadius: 8,
                        border: '1px solid var(--border)',
                      }}
                    />
                    <Bar
                      dataKey="count"
                      fill="#10b981"
                      radius={[3, 3, 0, 0]}
                      maxBarSize={36}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>

              {/* 6. 复习热力图 */}
              <ChartCard
                title="复习热力图（12周）"
                icon={<Flame className="size-4 text-emerald-600" />}
              >
                <Heatmap heat={data.heat} />
              </ChartCard>

              {/* 7. 未来7天负载预测 */}
              <ChartCard
                title="未来7天复习负载"
                icon={<Calendar className="size-4 text-emerald-600" />}
              >
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart
                    data={data.forecast}
                    margin={{ top: 4, right: 4, bottom: 0, left: -24 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      vertical={false}
                      stroke="var(--border)"
                    />
                    <XAxis
                      dataKey="day"
                      tickFormatter={formatDayMMDD}
                      tick={{ fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      interval={0}
                    />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                    />
                    <Tooltip
                      formatter={(value) => [`${value} 张`, '预计复习']}
                      labelFormatter={(l) => `日期: ${l}`}
                      contentStyle={{
                        fontSize: 12,
                        borderRadius: 8,
                        border: '1px solid var(--border)',
                      }}
                    />
                    <ReferenceLine
                      y={DAILY_REVIEW_LIMIT}
                      stroke="#f59e0b"
                      strokeDasharray="4 4"
                      label={{
                        value: `上限 ${DAILY_REVIEW_LIMIT}`,
                        fontSize: 10,
                        fill: '#f59e0b',
                        position: 'insideTopRight',
                      }}
                    />
                    <Bar
                      dataKey="count"
                      radius={[3, 3, 0, 0]}
                      maxBarSize={40}
                    >
                      {data.forecast.map((f) => (
                        <Cell
                          key={f.day}
                          fill={
                            f.count > DAILY_REVIEW_LIMIT
                              ? '#ef4444'
                              : '#10b981'
                          }
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <p className="mt-2 text-xs text-muted-foreground">
                  超过 {DAILY_REVIEW_LIMIT} 张/天的日期以红色高亮，建议提前安排复习时间。
                </p>
              </ChartCard>

              {/* 8. 高遗忘风险卡片列表 */}
              <ChartCard
                title="高遗忘风险卡片"
                icon={<AlertTriangle className="size-4 text-amber-500" />}
              >
                {data.risk.length === 0 ? (
                  <div className="py-6 text-center text-sm text-muted-foreground">
                    暂无高遗忘风险卡片，继续保持！
                  </div>
                ) : (
                  <div
                    className="max-h-96 overflow-y-auto pr-1
                      [scrollbar-width:thin]
                      [&::-webkit-scrollbar]:w-1.5
                      [&::-webkit-scrollbar-thumb]:rounded-full
                      [&::-webkit-scrollbar-thumb]:bg-zinc-300
                      dark:[&::-webkit-scrollbar-thumb]:bg-zinc-700
                      [&::-webkit-scrollbar-track]:bg-transparent"
                  >
                    <ul className="flex flex-col gap-2">
                      {data.risk.map((item) => {
                        const rb = retentionBadge(item.r)
                        const stateLabel =
                          STATE_META[item.state as CardState]?.label ??
                          item.state
                        return (
                          <li key={item.id}>
                            <button
                              type="button"
                              onClick={() => onOpenCard?.(item.id)}
                              disabled={!onOpenCard}
                              className="flex w-full items-center gap-3 rounded-xl border bg-background px-3 py-2.5 text-left transition-colors hover:bg-accent/60 active:bg-accent disabled:cursor-default disabled:opacity-100 disabled:hover:bg-background"
                            >
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">
                                  {item.title || '未命名卡片'}
                                </p>
                                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                  <span>
                                    稳定度 S:{' '}
                                    <span className="tabular-nums">
                                      {item.s.toFixed(1)}
                                    </span>
                                  </span>
                                  <span>
                                    难度 D:{' '}
                                    <span className="tabular-nums">
                                      {item.d.toFixed(2)}
                                    </span>
                                  </span>
                                  <Badge
                                    variant="outline"
                                    className="px-1.5 py-0 text-[10px] font-normal"
                                  >
                                    {stateLabel}
                                  </Badge>
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-1.5">
                                <span className="text-xs text-muted-foreground">
                                  R
                                </span>
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    'px-1.5 py-0 text-xs font-semibold tabular-nums',
                                    rb.className,
                                  )}
                                >
                                  {rb.label}
                                </Badge>
                              </div>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}
              </ChartCard>
            </>
          ) : null}
        </div>
      </main>
    </div>
  )
}

/** 12 周 × 7 天的 CSS 网格热力图（按周分列，周一到周日为行） */
function Heatmap({ heat }: { heat: HeatItem[] }) {
  const WEEKS = 12
  const DAYS = 7

  // 将 heat 数组按时间顺序填入 12×7 的网格；不足的部分以空格补齐。
  const padded: (HeatItem | null)[] = [...heat]
  while (padded.length < WEEKS * DAYS) padded.push(null)
  const trimmed = padded.slice(0, WEEKS * DAYS)

  const weeks: (HeatItem | null)[][] = []
  for (let w = 0; w < WEEKS; w++) {
    const col: (HeatItem | null)[] = []
    for (let d = 0; d < DAYS; d++) {
      col.push(trimmed[w * DAYS + d] ?? null)
    }
    weeks.push(col)
  }

  const maxCount = heat.reduce((m, h) => Math.max(m, h.count), 0)

  return (
    <div className="w-full overflow-x-auto">
      <div className="min-w-[320px]">
        {/* 周标签 */}
        <div className="flex gap-[3px] pl-6">
          {weeks.map((_, w) => (
            <div
              key={w}
              className="flex-1 text-center text-[9px] leading-none text-muted-foreground"
            >
              {w % 4 === 3 ? `第${w + 1}周` : ''}
            </div>
          ))}
        </div>
        <div className="mt-1 flex gap-[3px]">
          {/* 星期标签列 */}
          <div className="flex flex-col gap-[3px] pr-1">
            {WEEK_LABELS.map((l) => (
              <div
                key={l}
                className="flex h-3 items-center justify-end text-[9px] leading-none text-muted-foreground"
              >
                {l}
              </div>
            ))}
          </div>
          {/* 方格网格 */}
          <div className="flex flex-1 gap-[3px]">
            {weeks.map((col, w) => (
              <div key={w} className="flex flex-1 flex-col gap-[3px]">
                {col.map((item, d) => (
                  <div
                    key={d}
                    title={
                      item?.day
                        ? `${item.day}: ${item.count} 次`
                        : '无数据'
                    }
                    className={cn(
                      'h-3 rounded-[2px] transition-colors',
                      heatColor(item?.count ?? 0),
                      item && item.count > 0 &&
                        'hover:ring-1 hover:ring-emerald-400/60',
                    )}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
        {/* 图例 */}
        <div className="mt-3 flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
          <span>少</span>
          <div className="size-3 rounded-[2px] bg-muted" />
          <div className="size-3 rounded-[2px] bg-emerald-200" />
          <div className="size-3 rounded-[2px] bg-emerald-400" />
          <div className="size-3 rounded-[2px] bg-emerald-600" />
          <span>多</span>
          {maxCount > 0 && (
            <span className="ml-1 tabular-nums">（峰值 {maxCount}）</span>
          )}
        </div>
      </div>
    </div>
  )
}
