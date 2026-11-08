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
}

// 本书进度底部弹窗：待复习 N 章 + 复习总览 / 计划管理 两个入口。
export function ProgressSheet({
  open,
  onOpenChange,
  dueChapters,
  onOverview,
  onPlan,
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
            计划管理
          </button>
        </div>
      </div>
    </BottomSheet>
  )
}
