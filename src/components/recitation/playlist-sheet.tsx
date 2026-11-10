'use client'

// 待播放列表（全局朗读队列）—— Sheet 底部抽屉：
// 搜索（书名/片段名/正文内容）/ 排序（手动·添加时间·书名拼音）/ 筛选（按书本分组）
// / 单项与批量删除 / 上移下移换序 / 添加（整本 or 片段：起止段选择 + 实时预览）
// / 清空全部 / 点播（立即播放并移出队列）。
// API：GET/POST/PUT/DELETE /api/playlist（详见 src/app/api/playlist/route.ts）。

import * as React from 'react'
import {
  ArrowDownUp,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Filter,
  Loader2,
  Play,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import type { CardData } from '@/lib/types'
import {
  addToPlaylist,
  dispatchOpenTtsPlayer,
  fetchCardById,
  fetchPlaylist,
  getPlayback,
  playbackStart,
  removePlaylistItems,
  type PlayItem,
} from '@/lib/playback'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

type SortMode = 'manual' | 'time' | 'title'
type FilterMode = 'all' | 'group'

const SORT_LABEL: Record<SortMode, string> = {
  manual: '手动排序',
  time: '按添加时间',
  title: '按书名拼音',
}

const FILTER_LABEL: Record<FilterMode, string> = {
  all: '全部',
  group: '按书本分组',
}

/** 按空行分段（片段模式的「段」）。 */
export function splitParagraphs(content: string): string[] {
  return (content ?? '')
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ---------------------------------------------------------------------------
// 主 Sheet
// ---------------------------------------------------------------------------

export function PlaylistSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const [items, setItems] = React.useState<PlayItem[]>([])
  const [cards, setCards] = React.useState<CardData[]>([])
  const [loading, setLoading] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [sortMode, setSortMode] = React.useState<SortMode>('manual')
  const [filterMode, setFilterMode] = React.useState<FilterMode>('all')
  const [batchMode, setBatchMode] = React.useState(false)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [addOpen, setAddOpen] = React.useState(false)
  const [confirmClear, setConfirmClear] = React.useState(false)
  const [confirmBatch, setConfirmBatch] = React.useState(false)
  const [busyId, setBusyId] = React.useState<string | null>(null)

  const reload = React.useCallback(async () => {
    setLoading(true)
    try {
      const [list, cardsRes] = await Promise.all([
        fetchPlaylist(),
        fetch('/api/cards')
          .then((r) => (r.ok ? (r.json() as Promise<{ cards?: unknown }>) : { cards: [] }))
          .catch(() => ({ cards: [] })),
      ])
      setItems(list)
      setCards(Array.isArray(cardsRes.cards) ? (cardsRes.cards as CardData[]) : [])
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (!open) return
    setBatchMode(false)
    setSelected(new Set())
    setQuery('')
    void reload()
  }, [open, reload])

  // ---- 搜索过滤（书名/片段名；正文匹配的书单独提示） ----
  const q = query.trim().toLowerCase()
  const filtered = React.useMemo(() => {
    if (!q) return items
    return items.filter(
      (it) =>
        it.cardTitle.toLowerCase().includes(q) || it.label.toLowerCase().includes(q),
    )
  }, [items, q])

  const sorted = React.useMemo(() => {
    if (sortMode === 'manual') return filtered
    const arr = [...filtered]
    if (sortMode === 'time') arr.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    else arr.sort((a, b) => a.cardTitle.localeCompare(b.cardTitle, 'zh-Hans-CN'))
    return arr
  }, [filtered, sortMode])

  const groups = React.useMemo(() => {
    const map = new Map<string, PlayItem[]>()
    for (const it of sorted) {
      const key = it.cardTitle || '未命名'
      const bucket = map.get(key)
      if (bucket) bucket.push(it)
      else map.set(key, [it])
    }
    return [...map.entries()]
  }, [sorted])

  // 正文内容匹配的书（输入 ≥2 字时提示所属书，点击直接整本入列）
  const contentMatches = React.useMemo(() => {
    if (q.length < 2) return []
    return cards.filter((c) => c.content.includes(q)).slice(0, 5)
  }, [q, cards])

  // ---- 操作 ----

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 上移/下移（手动排序）：本地换序后 PUT 全量新顺序。 */
  const moveItem = async (id: string, dir: -1 | 1) => {
    const idx = items.findIndex((x) => x.id === id)
    const to = idx + dir
    if (idx === -1 || to < 0 || to >= items.length) return
    const next = [...items]
    ;[next[idx], next[to]] = [next[to], next[idx]]
    setItems(next)
    try {
      await fetch('/api/playlist', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: next.map((x) => x.id) }),
      })
    } catch {
      toast.error('排序保存失败，请重试')
    }
  }

  /** 删除单项：删除即不再播放。 */
  const deleteItem = async (id: string) => {
    setItems((prev) => prev.filter((x) => x.id !== id))
    const ok = await removePlaylistItems([id])
    if (!ok) toast.error('删除失败，请重试')
  }

  const batchDelete = async () => {
    const ids = [...selected]
    if (ids.length === 0) return
    setItems((prev) => prev.filter((x) => !selected.has(x.id)))
    setSelected(new Set())
    setBatchMode(false)
    const ok = await removePlaylistItems(ids)
    toast[ok ? 'success' : 'error'](ok ? `已删除 ${ids.length} 项，不会再播放` : '删除失败，请重试')
  }

  const clearAll = async () => {
    setItems([])
    setConfirmClear(false)
    setBatchMode(false)
    setSelected(new Set())
    try {
      const res = await fetch('/api/playlist?all=1', { method: 'DELETE' })
      toast[res.ok ? 'success' : 'error'](res.ok ? '已清空待播放列表' : '清空失败，请重试')
    } catch {
      toast.error('清空失败，请重试')
    }
  }

  /** 点播：立即播放该项（force 替换当前会话）并移出队列。 */
  const playItem = async (item: PlayItem) => {
    if (busyId) return
    setBusyId(item.id)
    try {
      let card = cards.find((c) => c.id === item.cardId) ?? null
      if (!card) card = await fetchCardById(item.cardId)
      if (!card) {
        toast.error('找不到这本书，可能已被删除')
        await removePlaylistItems([item.id])
        setItems((prev) => prev.filter((x) => x.id !== item.id))
        return
      }
      const cur = getPlayback()
      playbackStart(
        card,
        {
          label: item.label || undefined,
          startText: item.startText || undefined,
          endText: item.endText || undefined,
        },
        { force: true, speed: cur?.speed, voice: cur?.voice },
      )
      await removePlaylistItems([item.id])
      setItems((prev) => prev.filter((x) => x.id !== item.id))
      dispatchOpenTtsPlayer({
        cardId: card.id,
        title: card.title,
        text: getPlayback()?.content ?? card.content,
        expand: true,
      })
      onOpenChange(false)
    } finally {
      setBusyId(null)
    }
  }

  const addWholeCard = async (card: CardData) => {
    const ok = await addToPlaylist([{ cardId: card.id }])
    if (ok) {
      toast.success(`《${card.title}》已加入待播放列表`)
      void reload()
    } else toast.error('添加失败，请重试')
  }

  // ---- 行渲染 ----

  const renderRow = (item: PlayItem, i: number, arrLen: number) => {
    const checked = selected.has(item.id)
    return (
      <div
        key={item.id}
        className={cn(
          'flex items-center gap-2 rounded-2xl border border-border bg-card p-2 transition-colors',
          batchMode && checked && 'border-primary/40 bg-primary/5',
        )}
      >
        {batchMode ? (
          <Checkbox
            aria-label={`选择 ${item.cardTitle}`}
            checked={checked}
            onCheckedChange={() => toggleSelect(item.id)}
            className="size-5"
          />
        ) : (
          <button
            type="button"
            aria-label={`播放 ${item.cardTitle}`}
            onClick={() => void playItem(item)}
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white shadow-sm transition-transform active:scale-95"
          >
            {busyId === item.id ? (
              <Loader2 className="size-4.5 animate-spin" />
            ) : (
              <Play className="size-4.5 translate-x-px fill-current" />
            )}
          </button>
        )}
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => (batchMode ? toggleSelect(item.id) : void playItem(item))}
        >
          <p className="truncate text-sm font-medium">{item.cardTitle}</p>
          <p className="truncate text-xs text-muted-foreground">
            #{i + 1} · {item.label ? `片段「${item.label}」` : '整本'} · {fmtTime(item.createdAt)}
          </p>
        </button>
        {!batchMode && (
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              aria-label="上移"
              disabled={sortMode !== 'manual' || i === 0}
              onClick={() => void moveItem(item.id, -1)}
              className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
            >
              <ChevronUp className="size-4.5" />
            </button>
            <button
              type="button"
              aria-label="下移"
              disabled={sortMode !== 'manual' || i === arrLen - 1}
              onClick={() => void moveItem(item.id, 1)}
              className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
            >
              <ChevronDown className="size-4.5" />
            </button>
            <button
              type="button"
              aria-label={`删除 ${item.cardTitle}`}
              onClick={() => void deleteItem(item.id)}
              className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          aria-describedby={undefined}
          className="flex h-[85dvh] flex-col rounded-t-3xl p-0"
        >
          <SheetHeader className="flex-row items-center justify-between space-y-0 border-b border-border px-5 pb-3 pt-4">
            <div>
              <SheetTitle className="text-base font-bold">待播放列表</SheetTitle>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {items.length > 0 ? `${items.length} 项 · 当前播完自动连播` : '暂无待播内容'}
              </p>
            </div>
            <div className="flex items-center gap-1">
              {/* 排序 */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 rounded-full px-3 text-xs"
                    aria-label="排序方式"
                  >
                    <ArrowDownUp className="size-4" />
                    {SORT_LABEL[sortMode]}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="rounded-xl">
                  <DropdownMenuRadioGroup
                    value={sortMode}
                    onValueChange={(v) => setSortMode(v as SortMode)}
                  >
                    <DropdownMenuRadioItem value="manual">手动排序</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="time">按添加时间</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="title">按书名拼音</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              {/* 筛选 */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 rounded-full px-3 text-xs"
                    aria-label="筛选方式"
                  >
                    <Filter className="size-4" />
                    {FILTER_LABEL[filterMode]}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="rounded-xl">
                  <DropdownMenuRadioGroup
                    value={filterMode}
                    onValueChange={(v) => setFilterMode(v as FilterMode)}
                  >
                    <DropdownMenuRadioItem value="all">全部</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="group">按书本分组</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              {/* 批量管理 */}
              <Button
                variant={batchMode ? 'default' : 'ghost'}
                size="sm"
                className="h-9 rounded-full px-3 text-xs"
                aria-pressed={batchMode}
                onClick={() => {
                  setBatchMode((v) => !v)
                  setSelected(new Set())
                }}
              >
                {batchMode ? '退出批量' : '批量'}
              </Button>
              {/* 清空 */}
              <Button
                variant="ghost"
                size="sm"
                className="h-9 rounded-full px-3 text-xs text-destructive hover:text-destructive"
                aria-label="清空待播放列表"
                disabled={items.length === 0}
                onClick={() => setConfirmClear(true)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </SheetHeader>

          {/* 搜索 */}
          <div className="relative px-4 py-2.5">
            <Search className="pointer-events-none absolute left-7 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索书名 / 片段 / 正文内容"
              aria-label="搜索待播放列表"
              className="h-11 rounded-full pl-10 pr-10"
            />
            {query && (
              <button
                type="button"
                aria-label="清除搜索"
                onClick={() => setQuery('')}
                className="absolute right-7 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>

          {/* 列表 */}
          <div className="flex-1 space-y-2 overflow-y-auto px-3 pb-3">
            {loading && items.length === 0 && (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                加载中…
              </div>
            )}

            {/* 正文内容匹配的书：点击整本入列 */}
            {contentMatches.length > 0 && (
              <div className="rounded-2xl border border-dashed border-border p-3">
                <p className="text-xs text-muted-foreground">
                  正文包含「{query.trim()}」的书：
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {contentMatches.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => void addWholeCard(c)}
                      className="flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs transition-colors hover:border-primary/40 hover:text-primary"
                    >
                      <BookOpen className="size-3.5" />
                      {c.title}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {!loading && sorted.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
                <p className="text-sm text-muted-foreground">
                  {items.length === 0 ? '列表空空如也' : '没有匹配的结果'}
                </p>
                {items.length === 0 && (
                  <Button
                    variant="outline"
                    className="h-10 rounded-full px-6"
                    onClick={() => setAddOpen(true)}
                  >
                    <Plus className="size-4" />
                    去添加
                  </Button>
                )}
              </div>
            )}

            {filterMode === 'group'
              ? groups.map(([title, list]) => (
                  <div key={title} className="space-y-2">
                    <p className="flex items-center gap-1.5 px-1 pt-1 text-xs font-semibold text-muted-foreground">
                      <BookOpen className="size-3.5" />
                      {title}
                      <span className="font-normal">({list.length})</span>
                    </p>
                    {list.map((it, i) => renderRow(it, i, list.length))}
                  </div>
                ))
              : sorted.map((it, i) => renderRow(it, i, sorted.length))}

            {/* 批量删除栏 */}
            {batchMode && selected.size > 0 && (
              <Button
                variant="destructive"
                className="h-11 w-full rounded-full"
                onClick={() => setConfirmBatch(true)}
              >
                <Trash2 className="size-4" />
                删除选中的 {selected.size} 项
              </Button>
            )}
          </div>

          {/* 底部添加 */}
          <div className="border-t border-border p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <Button
              className="h-12 w-full rounded-full text-base"
              onClick={() => setAddOpen(true)}
            >
              <Plus className="size-5" />
              添加到待播放列表
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* 添加流程：选书 → 整本/片段 → （片段）起止段 + 预览 */}
      <AddToPlaylistDialog
        open={addOpen}
        cards={cards}
        onOpenChange={setAddOpen}
        onAdded={() => void reload()}
      />

      {/* 清空确认 */}
      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>清空待播放列表？</DialogTitle>
            <DialogDescription>
              将删除全部 {items.length} 项待播内容，删除后不会再自动播放。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-row gap-2">
            <Button variant="ghost" className="h-10 flex-1 rounded-full" onClick={() => setConfirmClear(false)}>
              取消
            </Button>
            <Button variant="destructive" className="h-10 flex-1 rounded-full" onClick={() => void clearAll()}>
              清空
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量删除确认 */}
      <Dialog open={confirmBatch} onOpenChange={setConfirmBatch}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>删除选中的 {selected.size} 项？</DialogTitle>
            <DialogDescription>删除后这些内容不会再播放。</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-row gap-2">
            <Button variant="ghost" className="h-10 flex-1 rounded-full" onClick={() => setConfirmBatch(false)}>
              取消
            </Button>
            <Button variant="destructive" className="h-10 flex-1 rounded-full" onClick={() => void batchDelete()}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ---------------------------------------------------------------------------
// 添加流程 Dialog：① 搜索/选书 ② 整本 or 片段 ③ 片段起止段 + 实时预览
// ---------------------------------------------------------------------------

function AddToPlaylistDialog({
  open,
  cards,
  onOpenChange,
  onAdded,
}: {
  open: boolean
  cards: CardData[]
  onOpenChange: (v: boolean) => void
  onAdded: () => void
}) {
  const [query, setQuery] = React.useState('')
  const [card, setCard] = React.useState<CardData | null>(null)
  const [mode, setMode] = React.useState<'whole' | 'fragment'>('whole')
  const [startIdx, setStartIdx] = React.useState(0)
  const [endIdx, setEndIdx] = React.useState(0)
  const [submitting, setSubmitting] = React.useState(false)

  React.useEffect(() => {
    if (!open) {
      setQuery('')
      setCard(null)
      setMode('whole')
      setStartIdx(0)
      setEndIdx(0)
    }
  }, [open])

  const paragraphs = React.useMemo(
    () => (card ? splitParagraphs(card.content) : []),
    [card],
  )

  // 换书 / 分段数变化时重置起止段
  React.useEffect(() => {
    setStartIdx(0)
    setEndIdx(0)
  }, [card?.id, paragraphs.length])

  const q = query.trim().toLowerCase()
  const cardList = React.useMemo(() => {
    const list = q
      ? cards.filter(
          (c) => c.title.toLowerCase().includes(q) || c.content.toLowerCase().includes(q),
        )
      : cards
    return list.slice(0, 50)
  }, [cards, q])

  const safeStart = Math.min(startIdx, Math.max(paragraphs.length - 1, 0))
  const safeEnd = Math.min(Math.max(endIdx, safeStart), Math.max(paragraphs.length - 1, 0))
  const preview = paragraphs.slice(safeStart, safeEnd + 1).join('\n\n')

  const handleStartChange = (v: string) => {
    const n = Number.parseInt(v, 10)
    if (!Number.isFinite(n)) return
    setStartIdx(n)
    if (endIdx < n) setEndIdx(n)
  }

  const handleEndChange = (v: string) => {
    const n = Number.parseInt(v, 10)
    if (!Number.isFinite(n)) return
    setEndIdx(Math.max(n, startIdx))
  }

  const paraOption = (p: string, i: number) =>
    `第 ${i + 1} 段 · ${p.slice(0, 14)}${p.length > 14 ? '…' : ''}`

  const confirm = async () => {
    if (!card) return
    setSubmitting(true)
    try {
      let ok = false
      if (mode === 'whole') {
        ok = await addToPlaylist([{ cardId: card.id }])
      } else {
        const startPara = paragraphs[safeStart] ?? ''
        const endPara = paragraphs[safeEnd] ?? ''
        const label =
          startPara.slice(0, 10) + (startPara.length > 10 ? '…' : '') +
          (safeEnd > safeStart ? ` ~ ${endPara.slice(0, 10)}${endPara.length > 10 ? '…' : ''}` : '')
        ok = await addToPlaylist([
          {
            cardId: card.id,
            label,
            startText: startPara.slice(0, 60),
            endText: endPara.slice(-60),
          },
        ])
      }
      if (ok) {
        toast.success(mode === 'whole' ? `《${card.title}》整本已加入` : '片段已加入待播放列表')
        onAdded()
        onOpenChange(false)
      } else {
        toast.error('添加失败，请重试')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="flex max-h-[85dvh] w-[calc(100vw-1.5rem)] max-w-lg flex-col rounded-3xl p-0"
      >
        <DialogHeader className="border-b border-border px-5 pb-3 pt-5">
          <DialogTitle className="flex items-center gap-2 text-base">
            {card && (
              <button
                type="button"
                aria-label="重新选书"
                onClick={() => setCard(null)}
                className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <ChevronUp className="size-4.5 -rotate-90" />
              </button>
            )}
            {card ? `添加：《${card.title}》` : '添加到待播放列表'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {card ? '选择整本播放，或截取一段（按空行分段的起止段）' : '先选择一本书'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {!card ? (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索书名或正文"
                  aria-label="搜索书"
                  className="h-11 rounded-full pl-9"
                />
              </div>
              <div className="mt-3 space-y-1.5">
                {cardList.length === 0 && (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    没有找到书本
                  </p>
                )}
                {cardList.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setCard(c)}
                    className="flex w-full items-center gap-2.5 rounded-2xl border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/40"
                  >
                    <BookOpen className="size-4.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{c.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {c.content.slice(0, 40)}
                        {c.content.length > 40 ? '…' : ''}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              {/* 模式选择 */}
              <div className="flex items-center rounded-full bg-muted p-1" role="tablist" aria-label="添加模式">
                {(
                  [
                    { key: 'whole' as const, label: '整本' },
                    { key: 'fragment' as const, label: '片段' },
                  ]
                ).map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={mode === t.key}
                    onClick={() => setMode(t.key)}
                    className={cn(
                      'flex-1 rounded-full py-2 text-sm transition-all',
                      mode === t.key
                        ? 'bg-background font-semibold text-foreground shadow-sm'
                        : 'text-muted-foreground',
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {mode === 'fragment' && (
                <div className="mt-4 space-y-3">
                  {paragraphs.length === 0 ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">
                      这本书没有可分段的内容
                    </p>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1.5">
                          <Label className="text-xs text-muted-foreground">起始段</Label>
                          <Select value={String(safeStart)} onValueChange={handleStartChange}>
                            <SelectTrigger className="h-11 w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {paragraphs.map((p, i) => (
                                <SelectItem key={i} value={String(i)}>
                                  {paraOption(p, i)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs text-muted-foreground">结束段</Label>
                          <Select value={String(safeEnd)} onValueChange={handleEndChange}>
                            <SelectTrigger className="h-11 w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {paragraphs.map((p, i) => (
                                <SelectItem key={i} value={String(i)} disabled={i < safeStart}>
                                  {paraOption(p, i)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      {/* 实时预览 */}
                      <div>
                        <p className="mb-1 text-xs text-muted-foreground">
                          片段预览（第 {safeStart + 1}
                          {safeEnd > safeStart ? ` - ${safeEnd + 1}` : ''} 段，共{' '}
                          {preview.length} 字）
                        </p>
                        <div className="max-h-44 overflow-y-auto rounded-2xl border border-border bg-muted/40 p-3 text-sm leading-relaxed whitespace-pre-wrap">
                          {preview || '（空）'}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}

              {mode === 'whole' && (
                <div className="mt-4 max-h-52 overflow-y-auto rounded-2xl border border-border bg-muted/40 p-3 text-sm leading-relaxed text-muted-foreground">
                  {card.content.slice(0, 300)}
                  {card.content.length > 300 ? '…' : ''}
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter className="border-t border-border px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <Button
            className="h-12 w-full rounded-full"
            disabled={!card || (mode === 'fragment' && paragraphs.length === 0) || submitting}
            onClick={() => void confirm()}
          >
            {submitting && <Loader2 className="size-4.5 animate-spin" />}
            {card ? (mode === 'whole' ? '整本加入' : '片段加入') : '请先选择书本'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
