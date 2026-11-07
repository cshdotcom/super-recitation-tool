'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { ChevronLeft, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import type { ReviewPlanData } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Skeleton } from '@/components/ui/skeleton'

interface PlanManagerViewProps {
  onBack: () => void
}

type Screen = { mode: 'list' } | { mode: 'edit'; plan: ReviewPlanData | null }

// Preset day options in the day-picker dialog (0 = 现在).
const DAY_OPTIONS = [0, 1, 2, 3, 4, 5, 7, 10, 14, 21, 30]
const MAX_ROWS = 12
const MENU_WIDTH = 128

function dayLabel(d: number): string {
  return d === 0 ? '现在' : `${d}天后`
}

/** Sticky sub-view header: back chevron + absolutely centered title. */
function ViewHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
      <div className="relative mx-auto flex h-14 max-w-2xl items-center px-4">
        <button
          type="button"
          onClick={onBack}
          aria-label="返回"
          className="z-10 flex size-9 items-center justify-center rounded-full transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft className="size-6" strokeWidth={1.75} />
        </button>
        <h1 className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-lg font-bold">
          {title}
        </h1>
      </div>
    </header>
  )
}

export function PlanManagerView({ onBack }: PlanManagerViewProps) {
  const [plans, setPlans] = React.useState<ReviewPlanData[]>([])
  const [loading, setLoading] = React.useState(true)
  const [screen, setScreen] = React.useState<Screen>({ mode: 'list' })

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch('/api/plans')
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '加载失败')
      }
      const data = (await res.json()) as { plans?: ReviewPlanData[] }
      setPlans(Array.isArray(data.plans) ? data.plans : [])
    } catch (err) {
      toast.error('加载复习计划失败：' + (err instanceof Error ? err.message : '未知错误'))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const handleSaved = React.useCallback(() => {
    setScreen({ mode: 'list' })
    void refresh()
  }, [refresh])

  if (screen.mode === 'list') {
    return (
      <ListScreen
        plans={plans}
        loading={loading}
        onBack={onBack}
        onNew={() => setScreen({ mode: 'edit', plan: null })}
        onEdit={(plan) => setScreen({ mode: 'edit', plan })}
        onChanged={refresh}
      />
    )
  }
  return (
    <EditScreen
      key={screen.plan?.id ?? 'new'}
      plan={screen.plan}
      onCancel={() => setScreen({ mode: 'list' })}
      onSaved={handleSaved}
    />
  )
}

// ==================== 列表页 ====================

function ListScreen({
  plans,
  loading,
  onBack,
  onNew,
  onEdit,
  onChanged,
}: {
  plans: ReviewPlanData[]
  loading: boolean
  onBack: () => void
  onNew: () => void
  onEdit: (plan: ReviewPlanData) => void
  onChanged: () => Promise<void>
}) {
  const [deleteTarget, setDeleteTarget] = React.useState<ReviewPlanData | null>(null)
  // Optimistic tombstones for just-deleted plans (cleared after refresh).
  const [removedIds, setRemovedIds] = React.useState<ReadonlySet<string>>(new Set())

  const visiblePlans = React.useMemo(
    () => plans.filter((p) => !removedIds.has(p.id)),
    [plans, removedIds],
  )

  const handleDelete = React.useCallback(async () => {
    const target = deleteTarget
    if (!target) return
    const tid = toast.loading('正在删除…')
    try {
      const res = await fetch(`/api/plans?id=${encodeURIComponent(target.id)}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '删除失败')
      }
      setRemovedIds((prev) => new Set(prev).add(target.id))
      toast.success('已删除', { id: tid })
    } catch (err) {
      toast.error('删除失败：' + (err instanceof Error ? err.message : '未知错误'), { id: tid })
    } finally {
      setDeleteTarget(null)
      // Refresh from the server, then drop the tombstone once fresh data lands.
      void onChanged().then(() => setRemovedIds(new Set()))
    }
  }, [deleteTarget, onChanged])

  return (
    <>
      <ViewHeader title="复习计划管理" onBack={onBack} />

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pb-28 pt-8">
        {loading ? (
          <div className="flex flex-col gap-4">
            <Skeleton className="h-32 rounded-2xl" />
            <Skeleton className="h-32 rounded-2xl" />
          </div>
        ) : visiblePlans.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border py-20 text-center">
            <p className="text-base font-medium text-muted-foreground">还没有复习计划</p>
            <p className="text-sm text-muted-foreground/70">点击右下角 + 新建一个</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {visiblePlans.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                onEdit={() => onEdit(plan)}
                onDelete={() => setDeleteTarget(plan)}
              />
            ))}
          </div>
        )}
      </main>

      {/* FAB 新建复习计划 */}
      <div className="pointer-events-none fixed inset-x-0 bottom-8 z-40 flex justify-end px-6">
        <button
          type="button"
          onClick={onNew}
          aria-label="新建复习计划"
          className="pointer-events-auto flex size-14 items-center justify-center rounded-full bg-zinc-900 text-white shadow-xl transition-transform hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Plus className="size-6" strokeWidth={1.75} />
        </button>
      </div>

      {/* 删除确认 */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除复习计划？</AlertDialogTitle>
            <AlertDialogDescription>
              将永久删除「{deleteTarget?.name}」，此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => void handleDelete()}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function PlanCard({
  plan,
  onEdit,
  onDelete,
}: {
  plan: ReviewPlanData
  onEdit: () => void
  onDelete: () => void
}) {
  const subtitle = plan.builtIn
    ? '基于记忆曲线，在最佳时间提醒复习'
    : `复习 ${plan.days.length} 次 · ${plan.days.map(dayLabel).join(' / ')}`

  return (
    <div className="relative rounded-2xl border-0 bg-card px-6 py-8 text-center shadow-sm">
      <h3 className="text-2xl font-bold">{plan.name}</h3>
      <p
        className={cn('mt-3 text-muted-foreground', !plan.builtIn && 'truncate')}
        title={!plan.builtIn ? subtitle : undefined}
      >
        {subtitle}
      </p>
      {!plan.builtIn && <PlanMenuButton plan={plan} onEdit={onEdit} onDelete={onDelete} />}
    </div>
  )
}

/** ⋯ button + dark floating menu (visual style of long-press-menu panel). */
function PlanMenuButton({
  plan,
  onEdit,
  onDelete,
}: {
  plan: ReviewPlanData
  onEdit: () => void
  onDelete: () => void
}) {
  const [mounted, setMounted] = React.useState(false)
  const [open, setOpen] = React.useState<{ x: number; y: number } | null>(null)
  React.useEffect(() => setMounted(true), [])

  const openMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8))
    const y = Math.min(rect.bottom + 6, window.innerHeight - 140)
    setOpen({ x, y })
  }

  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const panel = open ? (
    <div
      className="fixed inset-0 z-[9999]"
      onClick={(e) => {
        e.stopPropagation()
        setOpen(null)
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <motion.div
        role="menu"
        aria-label={`计划操作：${plan.name}`}
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.14, ease: 'easeOut' }}
        style={{
          position: 'fixed',
          left: open.x,
          top: open.y,
          width: MENU_WIDTH,
          transformOrigin: 'top right',
        }}
        className="pointer-events-auto rounded-2xl border border-white/10 bg-zinc-900/95 p-1.5 text-white shadow-2xl backdrop-blur"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(null)
            onEdit()
          }}
          className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-zinc-100 transition-colors hover:bg-white/10"
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            <Pencil className="size-4" strokeWidth={1.75} />
          </span>
          <span>编辑</span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(null)
            onDelete()
          }}
          className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-red-400 transition-colors hover:bg-red-500/15"
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            <Trash2 className="size-4" strokeWidth={1.75} />
          </span>
          <span>删除</span>
        </button>
      </motion.div>
    </div>
  ) : null

  return (
    <>
      <button
        type="button"
        aria-label={`管理计划：${plan.name}`}
        aria-haspopup="menu"
        aria-expanded={!!open}
        onClick={openMenu}
        className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-full text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MoreHorizontal className="size-5" strokeWidth={1.75} />
      </button>
      {mounted && panel ? createPortal(panel, document.body) : null}
    </>
  )
}

// ==================== 编辑页（新建/修改） ====================

function EditScreen({
  plan,
  onCancel,
  onSaved,
}: {
  plan: ReviewPlanData | null
  onCancel: () => void
  onSaved: () => void
}) {
  const [name, setName] = React.useState(plan?.name ?? '')
  // New plans start with 0 rows (screenshot: 复习时间安排（0天）); the first
  // appended row defaults to 现在 (0), later rows continue from the last day.
  const [days, setDays] = React.useState<number[]>(plan ? [...plan.days] : [])
  const [saving, setSaving] = React.useState(false)
  const [dayDialogRow, setDayDialogRow] = React.useState<number | null>(null)

  const canSave = name.trim().length > 0 && days.length > 0 && !saving

  const appendRow = React.useCallback(() => {
    setDays((prev) => {
      if (prev.length >= MAX_ROWS) return prev
      const next = prev.length === 0 ? 0 : Math.max(prev[prev.length - 1], 0) + 1
      return [...prev, next]
    })
  }, [])

  const pickDay = React.useCallback((rowIdx: number, day: number) => {
    // Keep values free-form but re-sort ascending after each change.
    setDays((prev) => {
      const next = [...prev]
      next[rowIdx] = day
      return next.sort((a, b) => a - b)
    })
    setDayDialogRow(null)
  }, [])

  const handleSave = React.useCallback(async () => {
    if (!canSave) return
    setSaving(true)
    const tid = toast.loading('正在保存…')
    try {
      const res = await fetch('/api/plans', {
        method: plan ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          plan ? { id: plan.id, name: name.trim(), days } : { name: name.trim(), days },
        ),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '保存失败')
      }
      toast.success('已保存', { id: tid })
      onSaved()
    } catch (err) {
      toast.error('保存失败：' + (err instanceof Error ? err.message : '未知错误'), { id: tid })
      setSaving(false)
    }
  }, [canSave, days, name, onSaved, plan])

  return (
    <>
      <ViewHeader title="复习计划" onBack={onCancel} />

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pb-10 pt-8">
        {/* 名称输入卡片 */}
        <div className="rounded-2xl bg-card shadow-sm">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="请输入名称"
            aria-label="计划名称"
            maxLength={30}
            className="h-16 w-full rounded-2xl border-0 bg-transparent text-center text-lg text-foreground outline-none placeholder:text-muted-foreground/60"
          />
        </div>

        {/* 复习时间安排 标签行 */}
        <div className="mt-6 flex items-baseline gap-1.5">
          <h2 className="text-xl font-bold">复习时间安排</h2>
          <span className="text-base font-normal text-muted-foreground">（{days.length}天）</span>
        </div>

        {/* 时间线卡片 */}
        <div className="mt-3 max-h-[26rem] overflow-y-auto rounded-2xl bg-card px-5 py-5 shadow-sm">
          {days.length === 0 ? (
            <p className="py-3 text-center text-sm text-muted-foreground">
              点击下方 + 添加第1次复习时间
            </p>
          ) : (
            days.map((d, i) => (
              <React.Fragment key={i}>
                {i > 0 && (
                  <div
                    aria-hidden
                    className="ml-[9px] h-6 border-l border-dotted border-zinc-300"
                  />
                )}
                <div className="flex h-12 items-center gap-4">
                  <span
                    aria-hidden
                    className={cn(
                      'size-5 shrink-0 rounded-full',
                      i === 0 ? 'bg-zinc-900' : 'border-2 border-zinc-300',
                    )}
                  />
                  <span className="text-lg font-bold">第{i + 1}次</span>
                  <button
                    type="button"
                    onClick={() => setDayDialogRow(i)}
                    aria-label={`设置第${i + 1}次复习时间，当前${dayLabel(d)}`}
                    className="ml-auto flex h-10 shrink-0 items-center rounded-lg bg-muted px-4 text-base font-medium text-blue-600 transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {dayLabel(d)}
                  </button>
                </div>
              </React.Fragment>
            ))
          )}
          {/* + 添加按钮 */}
          {days.length > 0 && (
            <div
              aria-hidden
              className="ml-[9px] h-6 border-l border-dotted border-zinc-300"
            />
          )}
          <div className="flex h-12 items-center">
            <button
              type="button"
              onClick={appendRow}
              disabled={days.length >= MAX_ROWS}
              aria-label="添加复习时间"
              className="flex size-9 items-center justify-center rounded-full bg-zinc-900 text-white shadow-md transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-30"
            >
              <Plus className="size-5" strokeWidth={1.75} />
            </button>
          </div>
        </div>

        {/* 取消 / 保存 */}
        <div className="mb-8 mt-10 flex gap-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="h-14 flex-1 rounded-2xl border border-zinc-300 bg-white text-lg text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 dark:border-border dark:bg-card"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!canSave}
            className="h-14 flex-1 rounded-2xl bg-zinc-900 text-lg font-medium text-white shadow-sm transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40"
          >
            保存
          </button>
        </div>
      </main>

      {/* 复习时间选择弹窗 */}
      {dayDialogRow !== null && dayDialogRow < days.length ? (
        <DayPickerDialog
          rowIdx={dayDialogRow}
          current={days[dayDialogRow]}
          onPick={(day) => pickDay(dayDialogRow, day)}
          onOpenChange={(open) => {
            if (!open) setDayDialogRow(null)
          }}
        />
      ) : null}
    </>
  )
}

/** Day picker: presets grid + custom day input (1-365). */
function DayPickerDialog({
  rowIdx,
  current,
  onPick,
  onOpenChange,
}: {
  rowIdx: number
  current: number
  onPick: (day: number) => void
  onOpenChange: (open: boolean) => void
}) {
  const [custom, setCustom] = React.useState('')

  const applyCustom = () => {
    const n = Number(custom)
    if (!custom.trim() || !Number.isInteger(n) || n < 1 || n > 365) {
      toast.error('请输入1-365的整数')
      return
    }
    onPick(n)
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm rounded-2xl p-5">
        <DialogHeader>
          <DialogTitle>选择复习时间</DialogTitle>
          <DialogDescription>第{rowIdx + 1}次复习安排在什么时候？</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-4 gap-2">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => onPick(d)}
              aria-pressed={current === d}
              className={cn(
                'h-10 rounded-lg border text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                current === d
                  ? 'border-zinc-900 bg-zinc-900 text-white'
                  : 'border-border bg-background text-foreground hover:bg-muted',
              )}
            >
              {d === 0 ? '现在' : `${d}天`}
            </button>
          ))}
        </div>

        <div className="mt-1 flex items-center gap-2">
          <Input
            type="number"
            min={1}
            max={365}
            placeholder="自定义天数（1-365）"
            aria-label="自定义天数"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                applyCustom()
              }
            }}
            className="h-10 flex-1 rounded-lg"
          />
          <Button
            type="button"
            onClick={applyCustom}
            className="h-10 rounded-lg bg-zinc-900 px-5 text-white hover:bg-zinc-800"
          >
            确定
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
