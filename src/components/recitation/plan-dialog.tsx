'use client'

import * as React from 'react'

import type { CardData } from '@/lib/types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'

interface PlanDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  card: CardData
  /** 今日已背词数（localStorage）。 */
  progress: number
  onSavePlan: (goal: number) => void
}

// 今日计划（制定 / 查看）
export function PlanDialog({
  open,
  onOpenChange,
  card,
  progress,
  onSavePlan,
}: PlanDialogProps) {
  const [goalDraft, setGoalDraft] = React.useState('10')

  React.useEffect(() => {
    if (open) {
      setGoalDraft(String(card.plan?.goal ?? 10))
    }
  }, [open, card.plan])

  const goal = card.plan?.goal ?? 10
  const pct = Math.min(100, Math.round((Math.min(progress, goal) / goal) * 100))
  const parsed = Math.round(Number(goalDraft))
  const valid = Number.isFinite(parsed) && parsed >= 1 && parsed <= 200

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-2xl sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>今日计划</DialogTitle>
          <DialogDescription>设定每日背诵词数目标，坚持每天进步一点</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-2xl bg-muted/60 px-4 py-3.5">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">今日进度</span>
              <span className="text-muted-foreground">
                已背 {Math.min(progress, goal)} / {goal} 词
              </span>
            </div>
            <Progress value={pct} className="mt-2.5 h-2" aria-label="今日背诵进度" />
            <p className="mt-2 text-xs text-muted-foreground">
              {progress >= goal
                ? '🎉 今天的计划已完成，太棒了！'
                : `还差 ${Math.max(0, goal - progress)} 词完成今日目标`}
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="plan-goal" className="text-sm font-medium">
              每日背诵词数
            </label>
            <Input
              id="plan-goal"
              type="number"
              min={1}
              max={200}
              value={goalDraft}
              onChange={(e) => setGoalDraft(e.target.value)}
              className="h-11 rounded-xl"
              placeholder="10"
            />
            <p className="text-[11px] text-muted-foreground">
              揭示一处挖空答案或新增一处挖空记 1 词
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            className="rounded-full bg-primary font-semibold"
            disabled={!valid}
            onClick={() => onSavePlan(parsed)}
          >
            保存计划
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
