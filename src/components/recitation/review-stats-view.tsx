'use client'

import * as React from 'react'
import { ChevronLeft, Loader2, Settings2 } from 'lucide-react'
import { toast } from 'sonner'

import type { Mastery, ReviewStats } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface ReviewStatsViewProps {
  onBack: () => void
  /** 打开复习计划管理（页面拥有者接线）；不传则隐藏入口 */
  onOpenPlanManager?: () => void
}

const MASTERY_COLORS: Record<Mastery, string> = {
  familiar: '#5b5bf0', // 熟悉 蓝紫
  fuzzy: '#f59e0b', // 模糊 橙
  forget: '#ef4444', // 忘记 红
  none: '#d4d4d8', // 未复习 灰
}

const MASTERY_LEGEND: { key: Mastery; label: string }[] = [
  { key: 'familiar', label: '熟悉' },
  { key: 'fuzzy', label: '模糊' },
  { key: 'forget', label: '忘记' },
  { key: 'none', label: '未复习' },
]

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1)

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function StatCell({ value, unit, label }: { value: number; unit: string; label: string }) {
  return (
    <div className="flex flex-col items-center">
      <p className="text-4xl font-bold tabular-nums">
        {value}
        <span className="ml-0.5 text-sm font-medium text-muted-foreground">{unit}</span>
      </p>
      <p className="mt-1.5 text-sm text-muted-foreground">{label}</p>
    </div>
  )
}

// SVG donut 饼图：4 色分段，值为 0 时不画；全为 0 时整圆灰色。
function MasteryDonut({ mastery }: { mastery: Record<Mastery, number> }) {
  const R = 78
  const C = 2 * Math.PI * R
  const entries = (Object.keys(MASTERY_COLORS) as Mastery[]).map(
    (k) => [k, mastery[k] ?? 0] as const,
  )
  const total = entries.reduce((s, [, v]) => s + v, 0)

  let acc = 0
  const segs = (
    total > 0
      ? entries
          .filter(([, v]) => v > 0)
          .map(([k, v]) => {
            const len = (v / total) * C
            const seg = { color: MASTERY_COLORS[k], len, off: acc }
            acc += len
            return seg
          })
      : []
  ) as { color: string; len: number; off: number }[]

  return (
    <svg viewBox="0 0 220 220" className="size-[220px]" role="img" aria-label="掌握情况饼图">
      {total === 0 ? (
        <circle cx="110" cy="110" r={R} fill="none" stroke={MASTERY_COLORS.none} strokeWidth={30} />
      ) : (
        segs.map((s, i) => (
          <circle
            key={i}
            cx="110"
            cy="110"
            r={R}
            fill="none"
            stroke={s.color}
            strokeWidth={30}
            strokeDasharray={`${s.len} ${C - s.len}`}
            strokeDashoffset={-s.off}
            transform="rotate(-90 110 110)"
          />
        ))
      )}
    </svg>
  )
}

// 复习统计页：今日/连续/用时 + 掌握情况饼图 + 复习日历。
export function ReviewStatsView({ onBack, onOpenPlanManager }: ReviewStatsViewProps) {
  const now = new Date()
  const [stats, setStats] = React.useState<ReviewStats | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [year, setYear] = React.useState(now.getFullYear())
  const [month, setMonth] = React.useState(now.getMonth() + 1)
  const [onlyReviewed, setOnlyReviewed] = React.useState(false)

  const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  // 年份下拉完全由真实 ReviewLog 数据驱动：日历里出现过的年份 + 当前年。
  const years = React.useMemo(() => {
    const currentYear = new Date().getFullYear()
    const ys = new Set<number>([currentYear])
    for (const key of Object.keys(stats?.calendar ?? {})) {
      const y = Number.parseInt(key.slice(0, 4), 10)
      if (!Number.isNaN(y) && y > 2000 && y <= currentYear) ys.add(y)
    }
    return [...ys].sort((a, b) => a - b)
  }, [stats])

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/review?tzOffset=${new Date().getTimezoneOffset()}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as ReviewStats
        if (!cancelled) setStats(data)
      } catch (err) {
        console.error('[ReviewStatsView] load failed:', err)
        if (!cancelled) toast.error('复习统计加载失败，请稍后重试')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const mastery: Record<Mastery, number> = stats?.mastery ?? {
    familiar: 0,
    fuzzy: 0,
    forget: 0,
    none: 0,
  }
  const calendar = stats?.calendar ?? {}

  // 日历格子（周一开头）
  const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7
  const daysInMonth = new Date(year, month, 0).getDate()
  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]
  const dayKey = (d: number) => `${year}-${pad(month)}-${pad(d)}`

  return (
    <div className="flex min-h-screen flex-col bg-muted/40">
      {/* 顶栏 */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="relative mx-auto flex h-14 max-w-2xl items-center px-4">
          <button
            type="button"
            onClick={onBack}
            aria-label="返回"
            className="z-10 flex size-9 items-center justify-center rounded-full transition-colors hover:bg-muted"
          >
            <ChevronLeft className="size-6" strokeWidth={2} />
          </button>
          {onOpenPlanManager && (
            <button
              type="button"
              onClick={onOpenPlanManager}
              aria-label="复习计划设置"
              title="复习计划设置"
              className="z-10 ml-1 flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Settings2 className="size-5" strokeWidth={1.9} />
            </button>
          )}
          <h1 className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-lg font-bold">
            复习统计
          </h1>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pb-16 pt-5">
        {loading ? (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            <p className="text-sm">加载中…</p>
          </div>
        ) : !stats ? (
          <div className="py-24 text-center text-sm text-muted-foreground">暂无统计数据</div>
        ) : (
          <>
            {/* 顶部三项统计 */}
            <div className="grid grid-cols-3 rounded-2xl bg-card py-5 shadow-sm">
              <StatCell value={stats.todayCount} unit="次" label="今日复习" />
              <StatCell value={stats.streakDays} unit="天" label="连续复习" />
              <StatCell value={Math.floor(stats.todaySeconds / 60)} unit="分钟" label="今日用时" />
            </div>

            {/* 掌握情况 */}
            <h2 className="mb-3 mt-7 text-xl font-bold">掌握情况</h2>
            <div className="rounded-2xl bg-card p-5 shadow-sm">
              <div className="flex items-center justify-center">
                {mastery.none > 0 && (
                  <div className="flex items-center gap-2 pr-2">
                    <div className="text-right leading-tight">
                      <p className="text-xl font-bold tabular-nums">{mastery.none}</p>
                      <p className="text-xs text-muted-foreground">未复习</p>
                    </div>
                    <span aria-hidden className="h-px w-5 bg-zinc-400" />
                  </div>
                )}
                <MasteryDonut mastery={mastery} />
              </div>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
                {MASTERY_LEGEND.map((l) => (
                  <span
                    key={l.key}
                    className="flex items-center gap-1.5 text-sm text-muted-foreground"
                  >
                    <span
                      aria-hidden
                      className="size-2.5 rounded-full"
                      style={{ backgroundColor: MASTERY_COLORS[l.key] }}
                    />
                    {l.label}
                  </span>
                ))}
              </div>
            </div>

            {/* 复习日历 */}
            <h2 className="mb-3 mt-7 text-xl font-bold">复习日历</h2>
            <div className="rounded-2xl bg-card p-4 shadow-sm">
              <div className="flex items-center gap-1">
                <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
                  <SelectTrigger
                    size="sm"
                    aria-label="选择年份"
                    className="w-[92px] border-0 bg-transparent px-2 text-base font-bold shadow-none focus-visible:ring-0"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {years.map((y) => (
                      <SelectItem key={y} value={String(y)}>
                        {y}年
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
                  <SelectTrigger
                    size="sm"
                    aria-label="选择月份"
                    className="w-[76px] border-0 bg-transparent px-2 text-base font-bold shadow-none focus-visible:ring-0"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTHS.map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {m}月
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <label className="ml-auto flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    checked={onlyReviewed}
                    onCheckedChange={(v) => setOnlyReviewed(v === true)}
                    aria-label="只显示已复习的日期"
                    className="size-4"
                  />
                  已复习
                </label>
              </div>

              <div className="mt-3 grid grid-cols-7 gap-1">
                {WEEKDAYS.map((w) => (
                  <div
                    key={w}
                    className="flex h-8 items-center justify-center text-sm text-muted-foreground"
                  >
                    {w}
                  </div>
                ))}
                {cells.map((d, i) => {
                  if (d === null) return <div key={`blank-${i}`} aria-hidden />
                  const key = dayKey(d)
                  const count = calendar[key] ?? 0
                  const isToday = key === todayKey
                  return (
                    <div
                      key={key}
                      className={cn(
                        'flex h-9 items-center justify-center rounded-lg text-sm tabular-nums',
                        count > 0 && 'bg-emerald-600 font-semibold text-white',
                        count === 0 && onlyReviewed && 'invisible',
                        isToday && 'ring-1 ring-inset ring-zinc-900',
                      )}
                    >
                      {d}
                    </div>
                  )
                })}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
