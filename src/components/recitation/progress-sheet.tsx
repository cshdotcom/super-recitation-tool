'use client'

import * as React from 'react'

import { cn } from '@/lib/utils'
import { BottomSheet } from '@/components/recitation/bottom-sheet'
import { SheetTitle } from '@/components/ui/sheet'

interface ProgressSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 待复习章节量 */
  dueChapters: number
  onOverview: () => void
  onPlan: () => void
  /** 打开复习计划管理（艾宾浩斯模板）；不传则隐藏入口 */
  onOpenReviewPlans?: () => void
}

// 本书进度底部弹窗：待复习 N 章 + 复习总览 / 今日目标 / 复习计划 入口。
export function ProgressSheet({
  open,
  onOpenChange,
  dueChapters,
  onOverview,
  onPlan,
  onOpenReviewPlans,
}: ProgressSheetProps) {
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} className="h-auto">
      {/* 无可见标题，仅供屏幕阅读器 */}
      <SheetTitle className="sr-only">本书进度</SheetTitle>

      <div className="flex flex-col items-center gap-5 px-1 pb-2 pt-6">
        <div className="w-full rounded-2xl border border-border/60 bg-card px-6 py-5 text-center shadow-sm">
          <p className="text-sm text-muted-foreground">本书进度</p>
          <p className="mt-1.5 text-2xl font-bold">
            待复习<span className="text-emerald-600">{dueChapters}</span>章
          </p>
        </div>

        <div className="grid w-full grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => {
              onOpenChange(false)
              onOverview()
            }}
            className={cn(
              'flex h-16 items-center justify-center rounded-xl border border-border/60 bg-card',
              'text-base font-semibold shadow-sm transition-colors hover:bg-muted/60',
              'outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            复习总览
          </button>
          <button
            type="button"
            onClick={() => {
              onOpenChange(false)
              onPlan()
            }}
            className={cn(
              'flex h-16 items-center justify-center rounded-xl border border-border/60 bg-card',
              'text-base font-semibold shadow-sm transition-colors hover:bg-muted/60',
              'outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            今日目标
          </button>
          {onOpenReviewPlans && (
            <button
              type="button"
              onClick={() => {
                onOpenChange(false)
                onOpenReviewPlans()
              }}
              className={cn(
                'col-span-2 flex h-14 items-center justify-center rounded-xl border border-emerald-600/40 bg-emerald-500/5',
                'text-base font-semibold text-emerald-700 shadow-sm transition-colors hover:bg-emerald-500/10 dark:text-emerald-400',
                'outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              复习计划管理（艾宾浩斯模板）
            </button>
          )}
        </div>
      </div>
    </BottomSheet>
  )
}
