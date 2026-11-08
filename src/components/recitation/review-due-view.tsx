'use client'

// 待复习：基于复习记录（熟悉/模糊/忘记）+ 提醒免打扰（review:snooze）的到期卡片列表。
// - 行：标题 + 最近动作（色点：熟悉绿/模糊黄/忘记红）+ 距上次复习天数，点击打开卡片
// - 批量：顶栏全选 + 行复选框，底部操作条「忽略（30 天）」「过几天提醒（1/3/7 天）」
// - 空态：「太棒了，暂无待复习内容」
// Rendered inside a parent `flex min-h-screen flex-col` wrapper:
// provides its own sticky header (h-14) + flex-1 main; no footer.

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  BellOff,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'

export interface ReviewDueViewProps {
  onBack: () => void
  onOpenCard: (id: string) => void
}

interface DueCardItem {
  id: string
  title: string
  /** familiar | fuzzy | forget */
  lastAction: string
  /** ISO 时间 */
  lastActionAt: string
  daysSince: number
}

const ACTION_META: Record<string, { label: string; dot: string }> = {
  familiar: { label: '熟悉', dot: 'bg-emerald-500' },
  fuzzy: { label: '模糊', dot: 'bg-amber-500' },
  forget: { label: '忘记', dot: 'bg-red-500' },
}

const REMIND_DAYS = [1, 3, 7]

function dueMeta(item: DueCardItem) {
  const meta = ACTION_META[item.lastAction] ?? { label: '复习', dot: 'bg-muted-foreground' }
  const days = item.daysSince <= 0 ? '今天复习过' : `${item.daysSince} 天前复习`
  return { ...meta, days }
}

export function ReviewDueView({ onBack, onOpenCard }: ReviewDueViewProps) {
  const [cards, setCards] = React.useState<DueCardItem[] | null>(null) // null = loading
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [busy, setBusy] = React.useState(false)
  const [remindOpen, setRemindOpen] = React.useState(false)

  // ---------- data ----------
  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/review/due')
      const data = (await res.json()) as { cards?: DueCardItem[]; error?: string }
      if (!res.ok) throw new Error(data.error || '加载失败')
      setCards(Array.isArray(data.cards) ? data.cards : [])
    } catch (err: unknown) {
      setCards([])
      toast.error('待复习加载失败：' + (err instanceof Error ? err.message : '未知错误'))
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

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

  const isEmpty = cards !== null && cards.length === 0

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
          <div className="ml-auto flex items-center">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
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
        {cards === null ? (
          <div className="flex flex-col gap-3">
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
          </div>
        ) : (
          <div className="flex flex-col gap-3" role="list" aria-label="待复习列表">
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
                    <h2 className="truncate text-[15px] font-bold leading-snug">
                      {item.title || '未命名卡片'}
                    </h2>
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className={cn('size-2 shrink-0 rounded-full', meta.dot)} aria-hidden />
                      <span>{meta.label}</span>
                      <span aria-hidden>·</span>
                      <span className="min-w-0 truncate">{meta.days}</span>
                    </p>
                  </div>
                  <ChevronRight
                    className="size-4 shrink-0 text-muted-foreground/50"
                    strokeWidth={1.75}
                    aria-hidden
                  />
                </motion.div>
              )
            })}
          </div>
        )}
      </main>

      {/* ---------- 批量操作条（固定，安全区上方） ---------- */}
      {cards !== null && cards.length > 0 && selected.size > 0 && (
        <motion.div
          initial={{ y: 90, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 400, damping: 34 }}
          className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[calc(1rem_+_env(safe-area-inset-bottom))]"
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
    </>
  )
}
