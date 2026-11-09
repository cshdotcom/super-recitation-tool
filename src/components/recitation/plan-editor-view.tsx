'use client'

import * as React from 'react'
import { ArrowLeftRight, ChevronLeft, Minus, Plus } from 'lucide-react'

import type { CardData } from '@/lib/types'
import { cn } from '@/lib/utils'
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

// 范围与服务端 PATCH /api/cards/:id 对 plan 的校验完全一致：
// goal 1–9999 / dailyNew 1–9999 / reviewTimes 1–20。
// goal / dailyNew 已按用户要求放开上限（最多 9999），可无级自由调节；
// reviewTimes 仍保留 1–20。
const FIELD_MIN = 1
const GOAL_MAX = 9999
const DAILY_NEW_MAX = 9999
const REVIEW_TIMES_MAX = 20

// 目标词数快捷预设（均在上限内）
const GOAL_PRESETS = [20, 50, 100, 200]

// 收敛到 [FIELD_MIN, max]，保证初始值与提交值都在服务端接受范围内
function clampPlan(n: number, max: number) {
  return Math.min(max, Math.max(FIELD_MIN, Math.round(n)))
}

interface NumberStepperProps {
  value: number
  min: number
  max: number
  ariaLabel: string
  onChange: (n: number) => void
}

// 数值步进器：+/- 按钮（44px 触控区）+ 居中可直接输入的数字框。
// 聚焦时可自由键入（允许临时空值/越界值），失焦或回车时统一收敛到 [min, max]。
function NumberStepper({ value, min, max, ariaLabel, onChange }: NumberStepperProps) {
  const [draft, setDraft] = React.useState('')
  const [focused, setFocused] = React.useState(false)

  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)))

  const commit = () => {
    const n = Number(draft)
    if (draft !== '' && Number.isFinite(n)) onChange(clamp(n))
    setDraft('')
  }

  const step = (delta: number) => {
    const base = draft === '' ? value : Number(draft)
    const next = clamp((Number.isFinite(base) ? base : value) + delta)
    onChange(next)
    setDraft(focused ? String(next) : '')
  }

  return (
    <div className="flex items-center gap-2" role="group" aria-label={ariaLabel}>
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={!focused && value <= min}
        aria-label={`减少${ariaLabel}`}
        className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-foreground transition-all hover:bg-muted-foreground/20 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
      >
        <Minus className="size-5" strokeWidth={2.5} />
      </button>
      <div className="flex h-11 w-20 items-center justify-center rounded-xl border border-input bg-background">
        <input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={focused ? draft : String(value)}
          onFocus={() => {
            setDraft(String(value))
            setFocused(true)
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            commit()
            setFocused(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          aria-label={ariaLabel}
          className="h-full w-full bg-transparent text-center text-base font-semibold tabular-nums text-foreground outline-none"
        />
      </div>
      <button
        type="button"
        onClick={() => step(1)}
        disabled={!focused && value >= max}
        aria-label={`增加${ariaLabel}`}
        className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-foreground transition-all hover:bg-muted-foreground/20 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
      >
        <Plus className="size-5" strokeWidth={2.5} />
      </button>
    </div>
  )
}

interface PlanFieldProps {
  label: string
  hint: string
  stepper: React.ReactNode
  children?: React.ReactNode
}

// 单个计划字段行：标题 + 步进器，下方范围提示（可再放快捷预设）。
function PlanField({ label, hint, stepper, children }: PlanFieldProps) {
  return (
    <div className="px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-medium">{label}</p>
        {stepper}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
      {children}
    </div>
  )
}

// 制作背书计划页：学习进度 + 每日计划（新学章节量 / 复习遍数 / 目标词数，
// 均支持步进 + 直接输入，范围内无级自由调节），确认保存。
export function PlanEditorView({
  card,
  mastered,
  learned,
  onBack,
  onConfirm,
}: PlanEditorViewProps) {
  const [goal, setGoal] = React.useState(clampPlan(card.plan?.goal ?? 10, GOAL_MAX))
  const [dailyNew, setDailyNew] = React.useState(
    clampPlan(card.plan?.dailyNew ?? 3, DAILY_NEW_MAX),
  )
  const [reviewTimes, setReviewTimes] = React.useState(
    clampPlan(card.plan?.reviewTimes ?? 5, REVIEW_TIMES_MAX),
  )

  const pct = learned > 0 ? Math.min(100, Math.round((mastered / learned) * 100)) : 0
  const due = Math.max(0, learned - mastered)

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
          <PlanField
            label="新学章节量"
            hint="每天新学 1–9999 章，步进或直接输入均可"
            stepper={
              <NumberStepper
                value={dailyNew}
                min={FIELD_MIN}
                max={DAILY_NEW_MAX}
                ariaLabel="新学章节量"
                onChange={setDailyNew}
              />
            }
          />
          <PlanField
            label="复习遍数"
            hint="每天复习 1–20 遍，步进或直接输入均可"
            stepper={
              <NumberStepper
                value={reviewTimes}
                min={FIELD_MIN}
                max={REVIEW_TIMES_MAX}
                ariaLabel="复习遍数"
                onChange={setReviewTimes}
              />
            }
          />
          <PlanField
            label="目标词数"
            hint="目标 1–9999 词，步进或直接输入均可"
            stepper={
              <NumberStepper
                value={goal}
                min={FIELD_MIN}
                max={GOAL_MAX}
                ariaLabel="目标词数"
                onChange={setGoal}
              />
            }
          >
            <div className="mt-3 flex flex-wrap gap-2">
              {GOAL_PRESETS.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setGoal(n)}
                  aria-pressed={goal === n}
                  className={cn(
                    'min-h-9 rounded-full px-4 text-sm font-medium tabular-nums transition-colors',
                    goal === n
                      ? 'bg-zinc-900 text-white'
                      : 'bg-muted text-foreground hover:bg-muted-foreground/20',
                  )}
                >
                  {n} 词
                </button>
              ))}
            </div>
          </PlanField>
        </div>

        {/* 计划摘要：随调节实时更新 */}
        <p className="mt-3 text-center text-sm text-muted-foreground" aria-live="polite">
          每天新学 <span className="font-semibold tabular-nums text-foreground">{dailyNew}</span>{' '}
          章 · 复习 <span className="font-semibold tabular-nums text-foreground">{reviewTimes}</span>{' '}
          遍 · 目标 <span className="font-semibold tabular-nums text-foreground">{goal}</span> 词
        </p>

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
    </div>
  )
}
