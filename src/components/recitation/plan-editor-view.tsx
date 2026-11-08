'use client'

import * as React from 'react'
import { ArrowLeftRight, ChevronLeft, ChevronRight } from 'lucide-react'

import type { CardData } from '@/lib/types'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  CalendarClockIll,
  FilesStackIll,
} from '@/components/recitation/illustrations'

interface PlanEditorViewProps {
  card: CardData
  /** 已掌握章节数 */
  mastered: number
  /** 已学章节数 */
  learned: number
  onBack: () => void
  onConfirm: (plan: { goal: number; dailyNew: number; reviewTimes: number }) => void
}

const DAILY_NEW_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
const REVIEW_TIMES_OPTIONS = [1, 2, 3, 5, 7, 10]

type PickerKey = 'dailyNew' | 'reviewTimes'

// 制作背书计划页：学习进度 + 每日计划（新学章节量 / 复习遍数），确认保存。
export function PlanEditorView({
  card,
  mastered,
  learned,
  onBack,
  onConfirm,
}: PlanEditorViewProps) {
  const goal = card.plan?.goal ?? 10
  const [dailyNew, setDailyNew] = React.useState(card.plan?.dailyNew ?? 3)
  const [reviewTimes, setReviewTimes] = React.useState(card.plan?.reviewTimes ?? 5)
  const [picker, setPicker] = React.useState<PickerKey | null>(null)

  const pct = learned > 0 ? Math.min(100, Math.round((mastered / learned) * 100)) : 0
  const due = Math.max(0, learned - mastered)

  const pickerValue = picker === 'dailyNew' ? dailyNew : reviewTimes
  const pickerOptions = picker === 'dailyNew' ? DAILY_NEW_OPTIONS : REVIEW_TIMES_OPTIONS

  const handlePick = (n: number) => {
    if (picker === 'dailyNew') setDailyNew(n)
    if (picker === 'reviewTimes') setReviewTimes(n)
    setPicker(null)
  }

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
          <h1 className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-lg font-bold">
            制作背书计划
          </h1>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4">
        <CalendarClockIll className="mx-auto mt-10 w-44" />

        {/* 学习进度 */}
        <p className="mb-2 mt-6 text-sm text-muted-foreground">学习进度</p>
        <div className="rounded-2xl bg-card p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <FilesStackIll className="w-10 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold">{card.title}</p>
              <div className="mt-2.5 flex items-center gap-2">
                <div
                  className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="h-full rounded-full bg-zinc-900 transition-[width]"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
                  {pct}%
                </span>
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-3 items-center text-sm">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full bg-zinc-900" />
              掌握 <span className="font-semibold tabular-nums">{mastered}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full border border-zinc-400" />
              已学 <span className="font-semibold tabular-nums">{learned}</span>
            </span>
            <span className="flex items-center justify-end gap-1 font-medium text-emerald-600">
              <ArrowLeftRight className="size-3.5" strokeWidth={2} />
              <span className="tabular-nums">{due}章</span>
            </span>
          </div>
        </div>

        {/* 每日计划 */}
        <p className="mb-2 mt-6 text-sm text-muted-foreground">每日计划</p>
        <div className="divide-y divide-border rounded-2xl bg-card shadow-sm">
          <button
            type="button"
            onClick={() => setPicker('dailyNew')}
            className="flex h-14 w-full items-center justify-between px-4 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <span className="text-sm font-medium">新学章节量</span>
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <span className="tabular-nums">{dailyNew}</span>
              <ChevronRight className="size-4 text-muted-foreground/60" />
            </span>
          </button>
          <button
            type="button"
            onClick={() => setPicker('reviewTimes')}
            className="flex h-14 w-full items-center justify-between px-4 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <span className="text-sm font-medium">复习遍数</span>
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <span className="tabular-nums">复习{reviewTimes}遍</span>
              <ChevronRight className="size-4 text-muted-foreground/60" />
            </span>
          </button>
        </div>

        {/* 底部确认 */}
        <div className="mt-auto pb-6 pt-10">
          <button
            type="button"
            onClick={() => onConfirm({ goal, dailyNew, reviewTimes })}
            className="h-12 w-full rounded-full bg-zinc-900 text-base font-semibold text-white transition-transform hover:bg-zinc-800 active:scale-[0.98]"
          >
            确认
          </button>
        </div>
      </main>

      {/* 数字选择弹窗 */}
      <Dialog open={picker !== null} onOpenChange={(o) => !o && setPicker(null)}>
        <DialogContent className="rounded-2xl sm:max-w-xs" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-center text-base">
              {picker === 'dailyNew' ? '新学章节量' : '复习遍数'}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-wrap justify-center gap-3 pb-2 pt-1">
            {pickerOptions.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => handlePick(n)}
                className={cn(
                  'flex size-11 items-center justify-center rounded-full text-base font-semibold transition-colors',
                  pickerValue === n
                    ? 'bg-zinc-900 text-white'
                    : 'bg-muted text-foreground hover:bg-muted-foreground/20',
                )}
              >
                {n}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
