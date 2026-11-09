'use client'

// 回收站（recycle bin）：最近删除的卡片，可单张恢复 / 彻底删除，
// 长按卡片或点头部「选择」进入多选，支持批量恢复 / 批量彻底删除，
// 也可通过右上角 ⋯ 菜单「全部恢复 / 清空回收站」。
// Rendered inside a parent `flex min-h-screen flex-col` wrapper:
// provides its own sticky header (h-14) + flex-1 main; no footer
// (多选模式下有一个 fixed 定位的底部批量操作栏)。

import * as React from 'react'
import { motion } from 'framer-motion'
import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import {
  ArchiveRestore,
  ChevronLeft,
  ListChecks,
  MoreHorizontal,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import type { CardData } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
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

export interface RecycleBinViewProps {
  onBack: () => void
}

/** yyyy/MM/dd in zhCN; falls back to '—' for invalid dates. */
function formatDeletedAt(iso: string): string {
  try {
    return format(new Date(iso), 'yyyy/MM/dd', { locale: zhCN })
  } catch {
    return '—'
  }
}

/** Hand-drawn style empty illustration: finger tapping a tilted phone + speech bubble. */
function EmptyBinIllustration() {
  return (
    <svg
      width={140}
      height={140}
      viewBox="0 0 160 160"
      fill="none"
      aria-hidden="true"
      className="select-none"
    >
      {/* speech bubble with three dots */}
      <path
        d="M36 12h48c5.5 0 10 4.5 10 10v18c0 5.5-4.5 10-10 10H56l-14 14V50h-6c-5.5 0-10-4.5-10-10V22c0-5.5 4.5-10 10-10z"
        fill="#fff"
        stroke="#a1a1aa"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="44" cy="31" r="3.5" fill="#a1a1aa" />
      <circle cx="58" cy="31" r="3.5" fill="#a1a1aa" />
      <circle cx="72" cy="31" r="3.5" fill="#a1a1aa" />
      {/* tilted smartphone */}
      <g transform="rotate(-10 100 96)">
        <rect x="74" y="46" width="54" height="100" rx="12" fill="#fff" stroke="#71717a" strokeWidth={3} />
        <path d="M93 58h16" stroke="#a1a1aa" strokeWidth={3} strokeLinecap="round" />
        <path d="M86 76h30M86 88h22" stroke="#d4d4d8" strokeWidth={3} strokeLinecap="round" />
        <circle cx="101" cy="134" r="4.5" stroke="#a1a1aa" strokeWidth={2.5} />
      </g>
      {/* tap ripples around the fingertip */}
      <path d="M89 82q-5-3-6-9" stroke="#a1a1aa" strokeWidth={2.5} strokeLinecap="round" />
      <path d="M113 80q5-3 6-9" stroke="#a1a1aa" strokeWidth={2.5} strokeLinecap="round" />
      {/* pointing hand */}
      <g transform="translate(120 124) rotate(-32)" strokeLinecap="round" strokeLinejoin="round">
        {/* thumb (behind the palm) */}
        <rect
          x="8"
          y="-22"
          width="22"
          height="12"
          rx="6"
          transform="rotate(38 19 -16)"
          fill="#fff"
          stroke="#71717a"
          strokeWidth={2.5}
        />
        {/* palm / fist */}
        <rect x="-14" y="-14" width="36" height="34" rx="11" fill="#fff" stroke="#71717a" strokeWidth={3} />
        {/* curled finger knuckles on the far edge */}
        <path d="M-14-2q-7 .5-7 5.5t7 5.5" fill="#fff" stroke="#71717a" strokeWidth={2.5} />
        <path d="M-14 9q-7 .5-7 5.5t7 5.5" fill="#fff" stroke="#71717a" strokeWidth={2.5} />
        {/* index finger (open base merges into the fist) */}
        <path
          d="M-4 -8v-27.5C-4-40.4-1.3-43 2-43s6 2.6 6 7.5V-8"
          fill="#fff"
          stroke="#71717a"
          strokeWidth={3}
        />
        {/* wrist hint */}
        <path d="M4 21v9M17 21v9" stroke="#d4d4d8" strokeWidth={3} />
      </g>
    </svg>
  )
}

export function RecycleBinView({ onBack }: RecycleBinViewProps) {
  const [cards, setCards] = React.useState<CardData[] | null>(null) // null = loading
  const [query, setQuery] = React.useState('')
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [confirmClear, setConfirmClear] = React.useState(false)
  const [hardTarget, setHardTarget] = React.useState<CardData | null>(null)
  const [confirmBatchDelete, setConfirmBatchDelete] = React.useState(false)
  /** 多选模式：长按卡片或点头部「选择」进入 */
  const [selectMode, setSelectMode] = React.useState(false)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  /** id of an in-flight row action, or '__all__'/'__batch__' for menu/batch actions; blocks double taps */
  const [busy, setBusy] = React.useState<string | null>(null)

  // ---------- data ----------
  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/cards?trash=1')
      const data = (await res.json()) as { cards?: CardData[]; error?: string }
      if (!res.ok) throw new Error(data.error || '加载失败')
      setCards(Array.isArray(data.cards) ? data.cards : [])
    } catch (err: unknown) {
      setCards([])
      toast.error('回收站加载失败：' + (err instanceof Error ? err.message : '未知错误'))
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const q = query.trim().toLowerCase()
  const filtered = React.useMemo(() => {
    if (!cards) return []
    if (!q) return cards
    return cards.filter(
      (c) => c.title.toLowerCase().includes(q) || c.content.toLowerCase().includes(q)
    )
  }, [cards, q])

  const allSelected = filtered.length > 0 && filtered.every((c) => selected.has(c.id))

  // ---------- menu close helpers ----------
  React.useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

  // ---------- 多选 ----------
  const toggleSelectItem = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(filtered.map((c) => c.id)))
  }

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelected(new Set())
  }

  // 列表变化时清理已不在回收站里的选中项，避免批量操作 404
  React.useEffect(() => {
    if (!cards) return
    setSelected((prev) => {
      if (prev.size === 0) return prev
      const ids = new Set(cards.map((c) => c.id))
      const next = new Set([...prev].filter((id) => ids.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [cards])

  // ---------- 长按卡片进入多选 ----------
  /** 进入多选的时刻；用于吞掉长按结束后的 click，避免刚选中又被取消 */
  const selectEnteredAt = React.useRef(0)
  const pressTimer = React.useRef<number | null>(null)
  const clearPress = React.useCallback(() => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
  }, [])
  React.useEffect(() => clearPress, [clearPress])
  const startPress = (e: React.SyntheticEvent<HTMLLIElement>, id: string) => {
    // 按在卡片内按钮上时不进入多选（那是普通点击）
    if ((e.target as Element).closest('button')) return
    clearPress()
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null
      if (!selectMode) {
        selectEnteredAt.current = Date.now()
        setSelectMode(true)
        setSelected(new Set([id]))
      }
    }, 500)
  }

  const handleCardToggle = (id: string) => {
    if (Date.now() - selectEnteredAt.current < 350) return
    toggleSelectItem(id)
  }

  // ---------- actions (all with loading toast via sonner) ----------
  const handleRestore = async (card: CardData) => {
    setBusy(card.id)
    const tid = toast.loading('正在恢复…')
    try {
      const res = await fetch(`/api/cards/${card.id}/restore`, { method: 'POST' })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(data.error || '恢复失败')
      setCards((prev) => (prev ? prev.filter((c) => c.id !== card.id) : prev))
      toast.success('已恢复到卡片列表', { id: tid })
    } catch (err: unknown) {
      toast.error('恢复失败：' + (err instanceof Error ? err.message : '未知错误'), { id: tid })
    } finally {
      setBusy(null)
    }
  }

  const handleHardDelete = async (card: CardData) => {
    setBusy(card.id)
    const tid = toast.loading('正在彻底删除…')
    try {
      const res = await fetch(`/api/cards/${card.id}?hard=1`, { method: 'DELETE' })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(data.error || '删除失败')
      setCards((prev) => (prev ? prev.filter((c) => c.id !== card.id) : prev))
      toast.success('已彻底删除', { id: tid })
    } catch (err: unknown) {
      toast.error('删除失败：' + (err instanceof Error ? err.message : '未知错误'), { id: tid })
    } finally {
      setBusy(null)
    }
  }

  const handleClearAll = async () => {
    setBusy('__all__')
    const tid = toast.loading('正在清空回收站…')
    try {
      const res = await fetch('/api/cards?trash=1', { method: 'DELETE' })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(data.error || '清空失败')
      await load()
      toast.success('已清空回收站', { id: tid })
    } catch (err: unknown) {
      toast.error('清空失败：' + (err instanceof Error ? err.message : '未知错误'), { id: tid })
    } finally {
      setBusy(null)
    }
  }

  const handleRestoreAll = async () => {
    setBusy('__all__')
    const tid = toast.loading('正在恢复…')
    try {
      const res = await fetch('/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore-all' }),
      })
      const data = (await res.json()) as { restored?: number; error?: string }
      if (!res.ok) throw new Error(data.error || '恢复失败')
      await load()
      const n = typeof data.restored === 'number' ? data.restored : 0
      if (n > 0) {
        toast.success(`已恢复 ${n} 张卡片`, { id: tid })
      } else {
        toast.info('回收站是空的', { id: tid })
      }
    } catch (err: unknown) {
      toast.error('恢复失败：' + (err instanceof Error ? err.message : '未知错误'), { id: tid })
    } finally {
      setBusy(null)
    }
  }

  // 批量恢复 / 批量彻底删除（复用单张接口，逐张并行请求）
  const runBatch = async (kind: 'restore' | 'delete') => {
    const ids = [...selected]
    if (ids.length === 0) return
    setBusy('__batch__')
    const tid = toast.loading(kind === 'restore' ? '正在恢复所选卡片…' : '正在彻底删除…')
    try {
      await Promise.all(
        ids.map(async (id) => {
          const res =
            kind === 'restore'
              ? await fetch(`/api/cards/${id}/restore`, { method: 'POST' })
              : await fetch(`/api/cards/${id}?hard=1`, { method: 'DELETE' })
          if (!res.ok) {
            const data = (await res.json().catch(() => ({}))) as { error?: string }
            throw new Error(data.error || '操作失败')
          }
        }),
      )
      setCards((prev) => (prev ? prev.filter((c) => !ids.includes(c.id)) : prev))
      toast.success(
        kind === 'restore' ? `已恢复 ${ids.length} 张卡片` : `已彻底删除 ${ids.length} 张卡片`,
        { id: tid },
      )
      exitSelectMode()
    } catch (err: unknown) {
      toast.error(
        (kind === 'restore' ? '批量恢复失败：' : '批量删除失败：') +
          (err instanceof Error ? err.message : '未知错误'),
        { id: tid },
      )
      await load() // 部分成功时重新拉取，保持列表与服务端一致
    } finally {
      setBusy(null)
    }
  }

  const handleBack = () => {
    if (selectMode) {
      exitSelectMode()
      return
    }
    onBack()
  }

  const hasQuery = q.length > 0
  const isEmpty = cards !== null && cards.length === 0

  return (
    <>
      {/* ---------- sticky header ---------- */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="relative mx-auto flex h-14 w-full max-w-2xl items-center px-3">
          <Button
            variant="ghost"
            size="icon"
            aria-label={selectMode ? '退出多选' : '返回'}
            className="text-muted-foreground"
            onClick={handleBack}
          >
            <ChevronLeft className="size-5" strokeWidth={1.75} />
          </Button>
          <h1 className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-base font-bold">
            {selectMode ? `已选 ${selected.size}` : '回收站'}
          </h1>
          <div className="ml-auto flex items-center gap-1">
            {selectMode ? (
              <Button
                variant="ghost"
                size="sm"
                className="px-2.5 text-sm text-muted-foreground"
                onClick={exitSelectMode}
              >
                取消
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="px-2.5 text-sm text-muted-foreground"
                  disabled={filtered.length === 0}
                  onClick={() => setSelectMode(true)}
                >
                  选择
                </Button>
                <div className="relative">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="更多操作"
                    aria-expanded={menuOpen}
                    aria-haspopup="menu"
                    className="text-muted-foreground"
                    onClick={() => setMenuOpen((v) => !v)}
                  >
                    <MoreHorizontal className="size-5" strokeWidth={1.75} />
                  </Button>

                  {menuOpen && (
                    <>
                      {/* backdrop: outside click closes the menu */}
                      <div
                        aria-hidden="true"
                        className="fixed inset-0 z-40"
                        onClick={() => setMenuOpen(false)}
                      />
                      <motion.div
                        role="menu"
                        aria-label="回收站菜单"
                        initial={{ opacity: 0, scale: 0.92, y: -6 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        transition={{ duration: 0.15, ease: 'easeOut' }}
                        style={{ transformOrigin: 'top right' }}
                        className="absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-2xl border border-border bg-background shadow-xl"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          disabled={busy !== null}
                          className="flex h-14 w-full items-center justify-between px-5 text-base transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
                          onClick={() => {
                            setMenuOpen(false)
                            setConfirmClear(true)
                          }}
                        >
                          <span>清空回收站</span>
                          <Trash2 className="size-5 shrink-0 text-red-500" strokeWidth={1.75} />
                        </button>
                        <div className="h-px bg-border" aria-hidden="true" />
                        <button
                          type="button"
                          role="menuitem"
                          disabled={busy !== null}
                          className="flex h-14 w-full items-center justify-between px-5 text-base transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                          onClick={() => {
                            setMenuOpen(false)
                            void handleRestoreAll()
                          }}
                        >
                          <span>全部恢复</span>
                          <ArchiveRestore
                            className="size-5 shrink-0 text-muted-foreground"
                            strokeWidth={1.75}
                          />
                        </button>
                      </motion.div>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* ---------- main ---------- */}
      <main
        className={cn(
          'mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 pt-4',
          selectMode ? 'pb-44' : 'pb-16', // 多选时给底部批量操作栏留出空间
        )}
      >
        {cards === null ? (
          // loading skeletons
          <div className="flex flex-col gap-3">
            <Skeleton className="h-28 rounded-2xl" />
            <Skeleton className="h-28 rounded-2xl" />
            <Skeleton className="h-28 rounded-2xl" />
          </div>
        ) : (
          <>
            {/* 列表顶部搜索：按标题 / 内容关键字筛选 */}
            {cards.length > 0 && (
              <div className="mb-4">
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/60"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索标题或内容…"
                    aria-label="搜索回收站"
                    className="h-10 w-full rounded-full bg-muted px-4 pl-10 text-sm outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  {query && (
                    <button
                      type="button"
                      aria-label="清除搜索内容"
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                      onClick={() => setQuery('')}
                    >
                      <X className="size-4" strokeWidth={1.75} />
                    </button>
                  )}
                </div>
              </div>
            )}

            {filtered.length === 0 ? (
              // empty state (empty bin / no search result)
              <div className="flex flex-1 flex-col items-center justify-center py-16 text-center">
                <EmptyBinIllustration />
                <p className="mt-6 text-lg text-muted-foreground">
                  {isEmpty || !hasQuery ? '这里空空如也' : '未找到相关内容'}
                </p>
              </div>
            ) : (
              <ul className="flex flex-col gap-3">
                {filtered.map((card, i) => {
                  const isSelected = selected.has(card.id)
                  const cardBody = (
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-[15px] font-bold">{card.title || '未命名卡片'}</h2>
                      <p className="mt-1.5 line-clamp-2 min-h-8 text-xs leading-relaxed text-muted-foreground">
                        {card.content || '（空内容）'}
                      </p>
                    </div>
                  )
                  return (
                    <motion.li
                      key={card.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.2, delay: Math.min(i * 0.03, 0.3), ease: 'easeOut' }}
                      className={cn(
                        'rounded-2xl border border-border bg-card p-4 shadow-sm',
                        isSelected && 'ring-1 ring-zinc-900 dark:ring-zinc-100/50',
                      )}
                      onContextMenu={(e) => {
                        if (!selectMode) {
                          e.preventDefault()
                          selectEnteredAt.current = Date.now()
                          setSelectMode(true)
                          setSelected(new Set([card.id]))
                        }
                      }}
                      onTouchStart={(e) => startPress(e, card.id)}
                      onTouchEnd={clearPress}
                      onTouchMove={clearPress}
                      onMouseDown={(e) => startPress(e, card.id)}
                      onMouseUp={clearPress}
                      onMouseLeave={clearPress}
                    >
                      {selectMode ? (
                        <button
                          type="button"
                          className="flex w-full items-start gap-3 text-left"
                          aria-label={`选中「${card.title || '未命名卡片'}」`}
                          aria-pressed={isSelected}
                          onClick={() => handleCardToggle(card.id)}
                        >
                          <RoundCheckbox checked={isSelected} />
                          {cardBody}
                        </button>
                      ) : (
                        cardBody
                      )}
                      <div className="mt-3 flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                          删除于 {card.deletedAt ? formatDeletedAt(card.deletedAt) : '—'}
                        </span>
                        {!selectMode && (
                          <>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={busy !== null}
                              aria-label={`恢复「${card.title}」`}
                              className="h-9 rounded-full border-emerald-600/40 px-4 text-sm text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-600 dark:border-emerald-400/40 dark:text-emerald-400 dark:hover:bg-emerald-400/10 dark:hover:text-emerald-300"
                              onClick={() => void handleRestore(card)}
                            >
                              恢复
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={busy !== null}
                              aria-label={`彻底删除「${card.title}」`}
                              className="h-9 rounded-full border-red-600/40 px-4 text-sm text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:border-red-400/40 dark:text-red-400 dark:hover:bg-red-400/10 dark:hover:text-red-300"
                              onClick={() => setHardTarget(card)}
                            >
                              彻底删除
                            </Button>
                          </>
                        )}
                      </div>
                    </motion.li>
                  )
                })}
              </ul>
            )}
          </>
        )}
      </main>

      {/* ---------- 底部批量操作栏（多选模式） ---------- */}
      {selectMode && (
        <div className="fixed inset-x-0 bottom-[calc(1.5rem+env(safe-area-inset-bottom))] z-40 flex justify-center px-4">
          <div className="w-full max-w-2xl rounded-2xl border border-border bg-card/95 p-3 shadow-lg shadow-black/10 backdrop-blur">
            <p className="pb-2 text-center text-xs text-muted-foreground">
              已选 {selected.size} 张卡片
            </p>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                disabled={busy !== null || filtered.length === 0}
                onClick={toggleSelectAll}
                className="flex h-11 flex-col items-center justify-center gap-0.5 rounded-xl border border-border bg-card text-[11px] font-medium transition-colors hover:bg-accent disabled:opacity-40"
              >
                <ListChecks className="size-4" strokeWidth={1.75} />
                {allSelected ? '取消全选' : '全选'}
              </button>
              <button
                type="button"
                disabled={selected.size === 0 || busy !== null}
                onClick={() => void runBatch('restore')}
                className="flex h-11 flex-col items-center justify-center gap-0.5 rounded-xl bg-emerald-600 text-[11px] font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-40"
              >
                <ArchiveRestore className="size-4" strokeWidth={1.75} />
                批量恢复
              </button>
              <button
                type="button"
                disabled={selected.size === 0 || busy !== null}
                onClick={() => setConfirmBatchDelete(true)}
                className="flex h-11 flex-col items-center justify-center gap-0.5 rounded-xl border border-destructive/40 bg-card text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-40"
              >
                <Trash2 className="size-4" strokeWidth={1.75} />
                批量删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- dialogs (controlled, live outside the menu) ---------- */}
      {/* 清空回收站 */}
      <AlertDialog
        open={confirmClear}
        onOpenChange={(open) => {
          if (!open) setConfirmClear(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清空回收站？</AlertDialogTitle>
            <AlertDialogDescription>
              回收站中的所有卡片将被彻底删除，清空后不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                setConfirmClear(false)
                void handleClearAll()
              }}
            >
              清空
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 彻底删除单张卡片 */}
      <AlertDialog
        open={hardTarget !== null}
        onOpenChange={(open) => {
          if (!open) setHardTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>彻底删除卡片？</AlertDialogTitle>
            <AlertDialogDescription>
              将永久删除「{hardTarget?.title || '未命名卡片'}」，此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                const target = hardTarget
                setHardTarget(null)
                if (target) void handleHardDelete(target)
              }}
            >
              彻底删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 批量彻底删除所选卡片 */}
      <AlertDialog
        open={confirmBatchDelete}
        onOpenChange={(open) => {
          if (!open) setConfirmBatchDelete(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>彻底删除 {selected.size} 张卡片？</AlertDialogTitle>
            <AlertDialogDescription>
              将永久删除所选的 {selected.size} 张卡片，此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                setConfirmBatchDelete(false)
                void runBatch('delete')
              }}
            >
              彻底删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// 黑色圆形勾选框（多选模式，与错题本一致）
function RoundCheckbox({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2',
        checked
          ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
          : 'border-zinc-400 bg-transparent text-transparent dark:border-zinc-600',
      )}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={3.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-3"
        aria-hidden
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </span>
  )
}
