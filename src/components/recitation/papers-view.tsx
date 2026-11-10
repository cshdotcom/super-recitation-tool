'use client'

// 试卷夹 — 按书本（Card）独立划分的试卷管理（自带 bottom Sheet，open 由 props 控制）。
//
// 功能：
//   • 按书本独立：顶部书本切换（当前书 / 全部书 / 其他书 — cards prop 或 GET /api/cards）
//   • 时间轴浏览：按日期分组（今天 / 昨天 / 本周 / 更早）
//   • 搜索：过滤试卷标题 + items[].question 题目内容
//   • 排序：最新创建 / 最早创建 / 题数最多
//   • 日期筛选：全部 / 近7天 / 近30天 / 近90天
//   • 批量管理：复选框模式 — 全选 / 批量删除（确认）/ 批量导出（合并 Markdown）
//   • 试卷详情：内联展开，RichContent 渲染每题（题干+选项+答案，富媒体绝不溢出）
//     「开始练习」→ onPractice(items, title) 由宿主接入答题流程；导出单份 MD / TXT
//
// API（src/app/api/papers/route.ts）：
//   GET    /api/papers?cardId=<id> → { papers }（省略 cardId = 全部，时间倒序）
//   PUT    /api/papers { id, title?, items? } → { ok }
//   DELETE /api/papers?id= | ?ids=a,b
import * as React from 'react'
import {
  ArrowDownUp,
  BookOpen,
  CalendarRange,
  Check,
  Download,
  FileText,
  FolderOpen,
  Loader2,
  MoreVertical,
  Pencil,
  Play,
  Search,
  Square,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { RichContent } from '@/components/recitation/rich-content'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

// ---------- 类型 ----------
/** 试卷中的单道题（与 /api/quiz 的题目结构一致，原样 JSON 存取） */
export interface PaperItem {
  type: string
  question: string
  answer: string
  options?: string[]
}

export interface PaperData {
  id: string
  cardId: string
  cardTitle: string
  title: string
  count: number
  items: PaperItem[]
  source: string
  createdAt: string
  updatedAt: string
}

export interface PapersViewProps {
  /** 当前书本 id（初始选中的书；空串则默认「全部书」） */
  cardId: string
  /** 当前书本标题 */
  cardTitle: string
  /** Sheet 开关（受控） */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** 开始练习回调：把试卷题目交给宿主的答题流程 */
  onPractice?: (items: unknown[], title: string) => void
  /** 可选：书本列表（不传则自行 GET /api/cards） */
  cards?: Array<{ id: string; title: string }>
}

// ---------- 常量 ----------
const TYPE_LABEL: Record<string, string> = {
  fill: '填空',
  short: '简答',
  choice: '单选',
  multi: '多选',
  judge: '判断',
}

const SOURCE_LABEL: Record<string, string> = {
  ai: 'AI出题',
  manual: '手动',
  wrong: '错题',
  extend: '举一反三',
}

function sourceLabel(s: string): string {
  return SOURCE_LABEL[s] ?? '手动'
}

const SORT_OPTIONS = [
  { key: 'new', label: '最新创建' },
  { key: 'old', label: '最早创建' },
  { key: 'count', label: '题数最多' },
] as const
type SortKey = (typeof SORT_OPTIONS)[number]['key']

const DATE_OPTIONS = [
  { key: 'all', label: '全部时间' },
  { key: '7', label: '近7天' },
  { key: '30', label: '近30天' },
  { key: '90', label: '近90天' },
] as const
type DateKey = (typeof DATE_OPTIONS)[number]['key']

type Bucket = 'today' | 'yesterday' | 'week' | 'earlier'
const BUCKET_ORDER: Bucket[] = ['today', 'yesterday', 'week', 'earlier']
const BUCKET_LABEL: Record<Bucket, string> = {
  today: '今天',
  yesterday: '昨天',
  week: '本周',
  earlier: '更早',
}

function dateBucket(iso: string): Bucket {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 'earlier'
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (t >= startOfToday) return 'today'
  if (t >= startOfToday - 86400000) return 'yesterday'
  if (t >= startOfToday - 6 * 86400000) return 'week'
  return 'earlier'
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === new Date().toDateString()) return `今天 ${hm}`
  if (d.getFullYear() === new Date().getFullYear())
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

// ---------- 导出 ----------
function downloadText(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function safeFilename(s: string): string {
  return (s.trim() || '试卷').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
}

/** 单份试卷 → Markdown（试卷标题 + 题目 + 选项 + 答案） */
function paperToMarkdown(p: PaperData): string {
  const head: string[] = [
    `# ${p.title}`,
    '',
    `> ${sourceLabel(p.source)} · 共 ${p.count} 题 · ${formatDate(p.createdAt)}${p.cardTitle ? ` · ${p.cardTitle}` : ''}`,
    '',
  ]
  const body: string[] = []
  ;(p.items ?? []).forEach((it, i) => {
    body.push(`## ${i + 1}. [${TYPE_LABEL[it.type] ?? it.type ?? '题目'}]`)
    body.push(it.question ?? '')
    if (Array.isArray(it.options) && it.options.length > 0) {
      body.push('')
      it.options.forEach((o, j) => body.push(`${String.fromCharCode(65 + j)}. ${o}`))
    }
    body.push('')
    body.push(`**答案：** ${it.answer ?? ''}`)
    body.push('')
  })
  return [...head, ...body].join('\n')
}

/** 单份试卷 → 纯文本 */
function paperToText(p: PaperData): string {
  const lines: string[] = [`试卷：${p.title}`, `共 ${p.count} 题 · ${formatDate(p.createdAt)}`, '']
  ;(p.items ?? []).forEach((it, i) => {
    lines.push(`第${i + 1}题 [${TYPE_LABEL[it.type] ?? it.type ?? '题目'}]`)
    lines.push(it.question ?? '')
    if (Array.isArray(it.options) && it.options.length > 0) {
      it.options.forEach((o, j) => lines.push(`${String.fromCharCode(65 + j)}. ${o}`))
    }
    lines.push(`答案：${it.answer ?? ''}`)
    lines.push('')
  })
  return lines.join('\n')
}

// ---------- 主组件 ----------
export function PapersView({
  cardId,
  cardTitle,
  open = false,
  onOpenChange,
  onPractice,
  cards: cardsProp,
}: PapersViewProps) {
  // ---- 数据 ----
  const [papers, setPapers] = React.useState<PaperData[]>([])
  const [loading, setLoading] = React.useState(false)
  const [cardList, setCardList] = React.useState<Array<{ id: string; title: string }>>(
    cardsProp ?? [],
  )

  // ---- 视图状态 ----
  const [bookId, setBookId] = React.useState<string>(cardId || 'all')
  const [search, setSearch] = React.useState('')
  const [sortBy, setSortBy] = React.useState<SortKey>('new')
  const [dateRange, setDateRange] = React.useState<DateKey>('all')
  const [manageMode, setManageMode] = React.useState(false)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [expandedId, setExpandedId] = React.useState<string | null>(null)

  // ---- 弹窗 ----
  const [renaming, setRenaming] = React.useState<{ id: string; title: string } | null>(null)
  const [deleteId, setDeleteId] = React.useState<string | null>(null)
  const [batchDeleteOpen, setBatchDeleteOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  // 书本跟随 props 变化（切换卡片时回到当前书）
  React.useEffect(() => {
    setBookId(cardId || 'all')
  }, [cardId])

  React.useEffect(() => {
    if (cardsProp) setCardList(cardsProp)
  }, [cardsProp])

  // ---- 加载试卷 ----
  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const url = bookId === 'all' ? '/api/papers' : `/api/papers?cardId=${encodeURIComponent(bookId)}`
      const res = await fetch(url)
      if (!res.ok) throw new Error('加载试卷失败')
      const data = (await res.json()) as { papers?: PaperData[] }
      setPapers(
        (data.papers ?? []).map((p) => ({
          ...p,
          items: Array.isArray(p.items) ? p.items : [],
          count: typeof p.count === 'number' ? p.count : (p.items ?? []).length,
        })),
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载试卷失败')
    } finally {
      setLoading(false)
    }
  }, [bookId])

  React.useEffect(() => {
    if (open) void load()
  }, [open, load])

  // 书本列表（props 未提供时自行拉取 /api/cards）
  React.useEffect(() => {
    if (!open || cardsProp) return
    let alive = true
    void (async () => {
      try {
        const res = await fetch('/api/cards')
        if (!res.ok) return
        const data = (await res.json()) as { cards?: Array<{ id: string; title: string }> }
        if (alive && Array.isArray(data.cards)) setCardList(data.cards)
      } catch {
        /* 静默降级：书本切换里至少有「全部书」与当前书 */
      }
    })()
    return () => {
      alive = false
    }
  }, [open, cardsProp])

  // ---- 筛选 / 排序 / 搜索 ----
  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    const now = Date.now()
    let list = papers.filter((p) => {
      if (dateRange !== 'all') {
        const t = new Date(p.createdAt).getTime()
        if (Number.isNaN(t) || now - t > Number(dateRange) * 86400000) return false
      }
      if (!q) return true
      if (p.title.toLowerCase().includes(q)) return true
      return (p.items ?? []).some((it) => (it?.question ?? '').toLowerCase().includes(q))
    })
    list = [...list]
    if (sortBy === 'old') list.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    else if (sortBy === 'count') list.sort((a, b) => b.count - a.count)
    else list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return list
  }, [papers, search, sortBy, dateRange])

  // 时间轴分组（仅「最新创建」排序时分组展示，其他排序平铺）
  const groups = React.useMemo(() => {
    if (sortBy !== 'new') return [{ bucket: null as Bucket | null, list: filtered }]
    const map = new Map<Bucket, PaperData[]>()
    for (const p of filtered) {
      const b = dateBucket(p.createdAt)
      if (!map.has(b)) map.set(b, [])
      map.get(b)!.push(p)
    }
    return BUCKET_ORDER.filter((b) => map.has(b)).map((b) => ({ bucket: b, list: map.get(b)! }))
  }, [filtered, sortBy])

  // ---- 批量 ----
  const allSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.id))
  const selectedPapers = filtered.filter((p) => selected.has(p.id))

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(filtered.map((p) => p.id)))
  }

  const exitManage = () => {
    setManageMode(false)
    setSelected(new Set())
  }

  const switchBook = (id: string) => {
    setBookId(id)
    setExpandedId(null)
    if (manageMode) exitManage()
  }

  // ---- 单份操作 ----
  const confirmRename = async () => {
    if (!renaming) return
    const title = renaming.title.trim()
    if (!title) {
      toast.warning('标题不能为空')
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/papers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: renaming.id, title }),
      })
      if (!res.ok) throw new Error('重命名失败')
      setPapers((prev) => prev.map((p) => (p.id === renaming.id ? { ...p, title } : p)))
      toast.success('已重命名')
      setRenaming(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重命名失败')
    } finally {
      setBusy(false)
    }
  }

  const deletePaper = async (id: string) => {
    setBusy(true)
    try {
      const res = await fetch(`/api/papers?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('删除失败')
      setPapers((prev) => prev.filter((p) => p.id !== id))
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      if (expandedId === id) setExpandedId(null)
      toast.success('已删除试卷')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  const batchDelete = async () => {
    const ids = [...selected]
    if (ids.length === 0) return
    setBusy(true)
    try {
      const res = await fetch(`/api/papers?ids=${encodeURIComponent(ids.join(','))}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error('删除失败')
      setPapers((prev) => prev.filter((p) => !selected.has(p.id)))
      toast.success(`已删除 ${ids.length} 份试卷`)
      exitManage()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  const exportOne = (p: PaperData, fmt: 'md' | 'txt') => {
    const name = safeFilename(p.title)
    if (fmt === 'md') {
      downloadText(`${name}.md`, paperToMarkdown(p), 'text/markdown;charset=utf-8')
    } else {
      downloadText(`${name}.txt`, paperToText(p), 'text/plain;charset=utf-8')
    }
    toast.success(`已导出 ${fmt.toUpperCase()} 文件`)
  }

  const exportBatch = () => {
    if (selectedPapers.length === 0) {
      toast('未选中任何试卷')
      return
    }
    const md = selectedPapers.map((p) => paperToMarkdown(p)).join('\n\n---\n\n')
    downloadText(
      `试卷夹_合并导出_${new Date().toISOString().slice(0, 10)}.md`,
      md,
      'text/markdown;charset=utf-8',
    )
    toast.success(`已合并导出 ${selectedPapers.length} 份试卷`)
  }

  // ---- 书本切换列表：当前书 + 全部书 + 其他书 ----
  const bookLabel =
    bookId === 'all'
      ? '全部书本'
      : (cardList.find((c) => c.id === bookId)?.title ?? (bookId === cardId ? cardTitle : '未知书本'))
  const otherBooks = cardList.filter((c) => c.id !== bookId && c.id !== cardId)

  const sortLabel = SORT_OPTIONS.find((s) => s.key === sortBy)?.label ?? '最新创建'
  const dateLabel = DATE_OPTIONS.find((d) => d.key === dateRange)?.label ?? '全部时间'

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="flex h-[92dvh] flex-col gap-0 rounded-t-3xl p-0"
      >
        {/* 头部 */}
        <SheetHeader className="shrink-0 border-b border-border/60 pb-3">
          <SheetTitle className="pr-10 text-left text-base font-bold">试卷夹</SheetTitle>
          <SheetDescription className="text-left text-xs">
            {bookLabel} · 共 {filtered.length} 份试卷
            {manageMode && ' · 管理模式'}
          </SheetDescription>
        </SheetHeader>

        {/* 筛选区：第 1 行 书本切换 + 搜索；第 2 行 排序 + 日期 + 管理 */}
        <div className="shrink-0 space-y-2 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="切换书本"
                  className="flex h-11 min-w-0 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <BookOpen className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span className="max-w-28 truncate">{bookLabel}</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
                {cardId && (
                  <DropdownMenuItem
                    onClick={() => switchBook(cardId)}
                    className={cn(bookId === cardId && 'font-bold text-red-500')}
                  >
                    <span className="max-w-48 truncate">{cardTitle || '当前书本'}</span>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => switchBook('all')}
                  className={cn(bookId === 'all' && 'font-bold text-red-500')}
                >
                  全部书本
                </DropdownMenuItem>
                {otherBooks.map((c) => (
                  <DropdownMenuItem
                    key={c.id}
                    onClick={() => switchBook(c.id)}
                    className={cn(bookId === c.id && 'font-bold text-red-500')}
                  >
                    <span className="max-w-48 truncate">{c.title}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                strokeWidth={1.75}
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索标题或题目…"
                aria-label="搜索试卷"
                className="h-11 rounded-full pl-9 text-sm"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="排序方式"
                  className="flex h-11 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ArrowDownUp className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span>{sortLabel}</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {SORT_OPTIONS.map((s) => (
                  <DropdownMenuItem
                    key={s.key}
                    onClick={() => setSortBy(s.key)}
                    className={cn(sortBy === s.key && 'font-bold text-red-500')}
                  >
                    {s.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="日期筛选"
                  className="flex h-11 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <CalendarRange className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span>{dateLabel}</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {DATE_OPTIONS.map((d) => (
                  <DropdownMenuItem
                    key={d.key}
                    onClick={() => setDateRange(d.key)}
                    className={cn(dateRange === d.key && 'font-bold text-red-500')}
                  >
                    {d.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              aria-pressed={manageMode}
              onClick={() => (manageMode ? exitManage() : setManageMode(true))}
              disabled={papers.length === 0}
              className={cn(
                'ml-auto flex h-11 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium transition-colors disabled:opacity-40',
                manageMode
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'border border-border bg-card text-muted-foreground hover:bg-accent',
              )}
            >
              {manageMode ? (
                <Check className="size-3.5" strokeWidth={2} />
              ) : (
                <Square className="size-3.5" strokeWidth={1.75} />
              )}
              {manageMode ? '完成' : '管理'}
            </button>
          </div>
        </div>

        {/* 列表（时间轴分组） */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-20 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
              <span className="text-sm">加载中…</span>
            </div>
          ) : papers.length === 0 ? (
            <EmptyPapers hasSearch={false} />
          ) : filtered.length === 0 ? (
            <EmptyPapers hasSearch />
          ) : (
            groups.map((g) => (
              <section key={g.bucket ?? 'all'} className="mb-4">
                <h3 className="mb-2 text-xs font-semibold text-muted-foreground">
                  {g.bucket ? BUCKET_LABEL[g.bucket] : '全部试卷'}
                  <span className="ml-1 font-normal">（{g.list.length}）</span>
                </h3>
                <div className="flex flex-col gap-2.5">
                  {g.list.map((p) => (
                    <PaperCard
                      key={p.id}
                      paper={p}
                      showBook={bookId === 'all'}
                      manageMode={manageMode}
                      selected={selected.has(p.id)}
                      expanded={expandedId === p.id}
                      canPractice={!!onPractice}
                      onToggleSelect={() => toggleSelect(p.id)}
                      onToggleExpand={() => setExpandedId(expandedId === p.id ? null : p.id)}
                      onPractice={() => onPractice?.(p.items, p.title)}
                      onExport={(fmt) => exportOne(p, fmt)}
                      onRename={() => setRenaming({ id: p.id, title: p.title })}
                      onDelete={() => setDeleteId(p.id)}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>

        {/* 批量管理底栏 */}
        {manageMode && (
          <div className="shrink-0 border-t border-border bg-card/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>已选 {selected.size} 份</span>
              <button
                type="button"
                onClick={toggleSelectAll}
                className="rounded-full px-2 py-1 font-medium text-foreground transition-colors hover:bg-accent"
              >
                {allSelected ? '取消全选' : '全选'}
              </button>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={selected.size === 0 || busy}
                onClick={exportBatch}
                className="h-11 flex-1 rounded-full text-sm"
              >
                <Download className="size-4" strokeWidth={1.75} /> 导出 MD
              </Button>
              <AlertDialog open={batchDeleteOpen} onOpenChange={setBatchDeleteOpen}>
                <Button
                  variant="outline"
                  disabled={selected.size === 0 || busy}
                  onClick={() => setBatchDeleteOpen(true)}
                  className="h-11 flex-1 rounded-full border-destructive/40 text-sm text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="size-4" strokeWidth={1.75} /> 删除所选
                </Button>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>删除 {selected.size} 份试卷？</AlertDialogTitle>
                    <AlertDialogDescription>
                      将彻底删除所选试卷及其全部题目，此操作不可撤销。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-white hover:bg-destructive/90"
                      onClick={() => {
                        setBatchDeleteOpen(false)
                        void batchDelete()
                      }}
                    >
                      删除
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        )}

        {/* 重命名弹窗 */}
        <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
          <DialogContent className="max-w-sm rounded-2xl">
            <DialogHeader>
              <DialogTitle>重命名试卷</DialogTitle>
            </DialogHeader>
            <Input
              value={renaming?.title ?? ''}
              onChange={(e) =>
                setRenaming((prev) => (prev ? { ...prev, title: e.target.value } : prev))
              }
              placeholder="输入新的试卷标题"
              aria-label="试卷标题"
              className="h-11 rounded-xl"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void confirmRename()
              }}
            />
            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                className="flex-1 rounded-full"
                onClick={() => setRenaming(null)}
                disabled={busy}
              >
                取消
              </Button>
              <Button
                className="flex-1 rounded-full bg-zinc-900 text-white hover:bg-zinc-800"
                onClick={() => void confirmRename()}
                disabled={busy || !(renaming?.title ?? '').trim()}
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                保存
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 单份删除确认 */}
        <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除这份试卷？</AlertDialogTitle>
              <AlertDialogDescription>
                「{papers.find((p) => p.id === deleteId)?.title ?? ''}」将被彻底删除，此操作不可撤销。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => {
                  const id = deleteId
                  setDeleteId(null)
                  if (id) void deletePaper(id)
                }}
              >
                删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  )
}

// ---------- 试卷卡片 ----------
function PaperCard({
  paper,
  showBook,
  manageMode,
  selected,
  expanded,
  canPractice,
  onToggleSelect,
  onToggleExpand,
  onPractice,
  onExport,
  onRename,
  onDelete,
}: {
  paper: PaperData
  showBook: boolean
  manageMode: boolean
  selected: boolean
  expanded: boolean
  canPractice: boolean
  onToggleSelect: () => void
  onToggleExpand: () => void
  onPractice: () => void
  onExport: (fmt: 'md' | 'txt') => void
  onRename: () => void
  onDelete: () => void
}) {
  return (
    <div
      className={cn(
        'rounded-2xl bg-card transition-shadow',
        selected && 'ring-1 ring-zinc-900 dark:ring-zinc-100/50',
      )}
    >
      <div className="flex w-full items-start gap-3 p-4">
        {manageMode && (
          <button
            type="button"
            role="checkbox"
            aria-checked={selected}
            aria-label={`选择试卷：${paper.title}`}
            onClick={onToggleSelect}
            className={cn(
              'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border-2 transition-colors',
              selected
                ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                : 'border-zinc-400 bg-transparent text-transparent dark:border-zinc-600',
            )}
          >
            <Check className="size-3.5" strokeWidth={3} />
          </button>
        )}
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => (manageMode ? onToggleSelect() : onToggleExpand())}
        >
          <p className="break-words text-sm font-medium leading-relaxed">{paper.title}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <Badge variant="secondary" className="px-1.5 text-[10px]">
              {paper.count} 题
            </Badge>
            <Badge
              variant="secondary"
              className={cn(
                'px-1.5 text-[10px]',
                paper.source === 'ai' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
                paper.source === 'wrong' && 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
                paper.source === 'extend' && 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
              )}
            >
              {sourceLabel(paper.source)}
            </Badge>
            {showBook && paper.cardTitle && (
              <span className="max-w-32 truncate">《{paper.cardTitle}》</span>
            )}
            <span>{formatDate(paper.createdAt)}</span>
          </div>
        </button>
        {!manageMode && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="试卷操作"
                className="shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <MoreVertical className="size-5" strokeWidth={2} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onToggleExpand}>
                {expanded ? '收起详情' : '查看详情'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onRename}>
                <Pencil className="size-4" strokeWidth={1.75} /> 重命名
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport('md')}>
                <Download className="size-4" strokeWidth={1.75} /> 导出 MD
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport('txt')}>
                <FileText className="size-4" strokeWidth={1.75} /> 导出 TXT
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDelete} className="text-destructive">
                <Trash2 className="size-4" strokeWidth={1.75} /> 删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* 详情（内联展开）：题目列表 + 开始练习 + 导出 */}
      {expanded && (
        <div className="border-t border-border px-4 py-3">
          <div className="max-h-96 space-y-2.5 overflow-y-auto overscroll-contain">
            {(paper.items ?? []).length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">这份试卷没有题目</p>
            ) : (
              paper.items.map((it, i) => (
                <div key={i} className="rounded-xl bg-muted/40 p-3">
                  <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="text-xs font-semibold text-muted-foreground">第{i + 1}题</span>
                    <Badge variant="secondary" className="px-1.5 text-[10px]">
                      {TYPE_LABEL[it.type] ?? it.type ?? '题目'}
                    </Badge>
                  </div>
                  {/* 题干：富媒体防护容器（break-words + max-w 封顶，绝不撑破题框） */}
                  <div className="min-w-0 max-w-full overflow-hidden break-words">
                    <RichContent content={it.question ?? ''} />
                  </div>
                  {Array.isArray(it.options) && it.options.length > 0 && (
                    <div className="mt-1.5 space-y-1 text-sm">
                      {it.options.map((o, j) => (
                        <p key={j} className="min-w-0 break-words text-muted-foreground">
                          {String.fromCharCode(65 + j)}. {o}
                        </p>
                      ))}
                    </div>
                  )}
                  {(it.answer ?? '').trim() && (
                    <div className="mt-2 min-w-0 max-w-full overflow-hidden break-words rounded-lg bg-emerald-500/5 px-2.5 py-1.5 text-sm">
                      <span className="mr-1 text-xs text-muted-foreground">答案：</span>
                      <span className="font-medium text-emerald-700 dark:text-emerald-300">
                        {it.answer}
                      </span>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {canPractice && (
              <Button
                onClick={onPractice}
                disabled={(paper.items ?? []).length === 0}
                className="h-11 flex-1 rounded-full bg-zinc-900 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
              >
                <Play className="size-4" strokeWidth={2} /> 开始练习
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => onExport('md')}
              className="h-11 rounded-full text-sm"
            >
              <Download className="size-4" strokeWidth={1.75} /> MD
            </Button>
            <Button
              variant="outline"
              onClick={() => onExport('txt')}
              className="h-11 rounded-full text-sm"
            >
              <FileText className="size-4" strokeWidth={1.75} /> TXT
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- 空状态 ----------
function EmptyPapers({ hasSearch }: { hasSearch: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl bg-card py-16 text-center">
      <FolderOpen className="size-10 text-muted-foreground/30" strokeWidth={1.5} />
      <p className="text-sm font-medium text-muted-foreground">
        {hasSearch ? '没有匹配的试卷' : '还没有试卷'}
      </p>
      {!hasSearch && (
        <p className="max-w-64 text-xs leading-relaxed text-muted-foreground/70">
          在「AI 出题」生成题目后点「存为试卷」，或把错题「举一反三」的结果存进来，就能在这里随时重练
        </p>
      )}
    </div>
  )
}

export default PapersView
