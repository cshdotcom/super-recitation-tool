'use client'

// 分享管理 — 改版（书籍内容 / AI 对话 / 试卷 三类分享统一管理）：
//   • 顶部分类 Tab：全部 / 书籍内容 / AI 对话 / 试卷（kind 过滤 + 计数）
//   • 内嵌统一检索（SearchOverlay share 模式）：标题/token 搜索 +
//     全部/有效/已过期 筛选 + 创建/过期时间排序；列表侧另有「正序/倒序」开关
//   • 每条分享：预览（内嵌公开视图，卡片/对话/试卷通吃）→ 预览底部可复制链接 /
//     在浏览器打开；行内还有 复制链接 / 修改有效期（无限/1/7/30/自定义）/ 删除
//   • 批量：全选/多选 → 批量延期（1/7/30/90 天或永久）/ 批量取消（级联清理快照）
//   • 链接路由：试卷分享为 /s/<token>（SharedPaperView），卡片/对话为
//     /share/<token>；预览复用公开视图组件，卡片分享由 SharedConversationView
//     内部委托 SharedCardView 渲染。
import * as React from 'react'
import {
  ArrowDownUp,
  ArrowLeft,
  BookOpen,
  Clock3,
  Copy,
  Eye,
  FileText,
  Link2,
  Loader2,
  MessageSquare,
  Search,
  SquareArrowOutUpRight,
  SquareCheckBig,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  SearchOverlay,
  type ShareSearchRow,
} from '@/components/recitation/search-overlay'
import { SharedConversationView } from '@/components/recitation/shared-conversation-view'
import { SharedPaperView } from '@/components/recitation/shared-paper-view'

/** 分享行（GET /api/shares；kind 含 paper，paperId 为源试卷 id，仅试卷分享有值） */
interface ShareRow {
  id: string
  token: string
  kind: 'card' | 'conversation' | 'paper'
  cardId: string
  refId: string
  title: string
  paperId?: string
  expiresAt: string | null
  createdAt: string
}

type ShareTab = 'all' | 'card' | 'conversation' | 'paper'

const TABS: readonly { key: ShareTab; label: string; icon: typeof BookOpen }[] = [
  { key: 'all', label: '全部', icon: Link2 },
  { key: 'card', label: '书籍内容', icon: BookOpen },
  { key: 'conversation', label: 'AI 对话', icon: MessageSquare },
  { key: 'paper', label: '试卷', icon: FileText },
]

const EMPTY_HINT: Record<ShareTab, { title: string; hint: string }> = {
  all: {
    title: '还没有任何分享',
    hint: '打开书本、AI 对话或试卷夹，点「分享」创建链接',
  },
  card: {
    title: '还没有分享过书籍内容',
    hint: '打开一本书，点右上「分享」创建链接',
  },
  conversation: {
    title: '还没有分享过 AI 对话',
    hint: '在 AI 对话面板点「分享」创建链接',
  },
  paper: {
    title: '还没有分享过试卷',
    hint: '在试卷夹的试卷菜单里点「分享」创建链接',
  },
}

const KIND_BADGE: Record<ShareRow['kind'], { label: string; className: string }> = {
  card: {
    label: '书',
    className: 'border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300',
  },
  conversation: {
    label: '对话',
    className: 'border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  },
  paper: {
    label: '试卷',
    className: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  },
}

/** 分享链接：试卷分享走 /s/<token>，卡片/对话走 /share/<token> */
function shareUrl(kind: string, token: string): string {
  return kind === 'paper'
    ? `${window.location.origin}/s/${token}`
    : `${window.location.origin}/share/${token}`
}

type ExpiryOption = 'inf' | '1' | '7' | '30' | 'custom'

/** 有效期选项 → 天数（0 = 永久）；自定义非法时返回 null */
function expiryToDays(expiry: ExpiryOption, customDays: string): number | null {
  if (expiry === 'inf') return 0
  if (expiry === 'custom') {
    const v = customDays.trim()
    const n = Number(v)
    if (!/^\d+$/.test(v) || !Number.isInteger(n) || n < 1 || n > 3650) return null
    return n
  }
  return Number(expiry)
}

export function ShareManagerView({ onBack }: { onBack: () => void }) {
  const [shares, setShares] = React.useState<ShareRow[] | null>(null)
  const [tab, setTab] = React.useState<ShareTab>('all')
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [batchMode, setBatchMode] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [singleDeleteId, setSingleDeleteId] = React.useState<string | null>(null)
  const [extendDays, setExtendDays] = React.useState('7')
  const [busy, setBusy] = React.useState(false)
  const [busySingle, setBusySingle] = React.useState(false)
  /** 预览行（内嵌公开视图；卡片/对话 → 对话视图，试卷 → 试卷视图） */
  const [previewRow, setPreviewRow] = React.useState<ShareRow | null>(null)
  /** 单条「修改有效期」行 */
  const [expiryRow, setExpiryRow] = React.useState<ShareRow | null>(null)

  // ---------- 统一检索（share 模式） ----------
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [filtered, setFiltered] = React.useState<ShareRow[] | null>(null)
  // 列表排序方向（在检索排序基础上整体翻转：新→旧 / 旧→新）
  const [sortDir, setSortDir] = React.useState<'desc' | 'asc'>('desc')
  // ⚠ 必须稳定：SearchOverlay 在受控 effect 中调用
  const handleFiltered = React.useCallback((list: ShareSearchRow[] | null) => {
    setFiltered(list as ShareRow[] | null)
  }, [])

  // ---------- 单条「修改有效期」弹窗状态 ----------
  const [expiry, setExpiry] = React.useState<ExpiryOption>('7')
  const [customDays, setCustomDays] = React.useState('7')

  React.useEffect(() => {
    if (expiryRow) {
      setExpiry('7')
      setCustomDays('7')
    }
  }, [expiryRow])

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/shares')
      const data = await res.json()
      setShares((data?.shares as ShareRow[]) ?? [])
    } catch {
      toast.error('加载分享列表失败')
      setShares([])
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  // 当前分类 Tab 的分享 + 检索结果 + 排序方向
  const tabShares = React.useMemo(
    () => (shares ?? []).filter((s) => tab === 'all' || s.kind === tab),
    [shares, tab],
  )
  const listShares = filtered ?? tabShares
  const displayShares = React.useMemo(
    () => (sortDir === 'asc' ? [...listShares].reverse() : listShares),
    [listShares, sortDir],
  )

  // 切换分类：清空检索结果与选择（批量操作只作用于当前分类）
  React.useEffect(() => {
    setFiltered(null)
    setSelected(new Set())
  }, [tab])

  const toggle = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const allSelected = displayShares.length > 0 && displayShares.every((s) => selected.has(s.id))

  const copyLink = (row: ShareRow) => {
    const url = shareUrl(row.kind, row.token)
    navigator.clipboard
      ?.writeText(url)
      .then(() => toast.success('链接已复制'))
      .catch(() => toast.error('复制失败'))
  }

  /** 跳转分享页（新标签页打开公开链接） */
  const openSharePage = (row: ShareRow) => {
    window.open(shareUrl(row.kind, row.token), '_blank', 'noopener,noreferrer')
  }

  const batchExtend = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selected), days: Number(extendDays) }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '操作失败')
      toast.success(`已延长 ${selected.size} 个分享的有效期`)
      setSelected(new Set())
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const batchDelete = async () => {
    setBusy(true)
    try {
      const res = await fetch(`/api/shares?ids=${encodeURIComponent(Array.from(selected).join(','))}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '操作失败')
      toast.success(`已删除 ${selected.size} 个分享`)
      setSelected(new Set())
      setBatchMode(false)
      setConfirmDelete(false)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const deleteSingle = async () => {
    if (!singleDeleteId) return
    setBusySingle(true)
    try {
      const res = await fetch(`/api/shares/${encodeURIComponent(singleDeleteId)}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '删除失败')
      toast.success('已删除该分享')
      // 若删除的项处于选中态，同步移除
      setSelected((prev) => {
        if (!prev.has(singleDeleteId)) return prev
        const n = new Set(prev)
        n.delete(singleDeleteId)
        return n
      })
      setSingleDeleteId(null)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setBusySingle(false)
    }
  }

  /** 单条修改有效期：POST /api/shares { ids: [id], days }（0 = 永久） */
  const updateExpiry = async () => {
    if (!expiryRow) return
    const days = expiryToDays(expiry, customDays)
    if (days === null) {
      toast.error('自定义有效期需为 1-3650 的整数（天）')
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [expiryRow.id], days }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '操作失败')
      toast.success(days === 0 ? '已设为永久有效' : `有效期已更新为 ${days} 天`)
      setExpiryRow(null)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const singleDeleteRow = shares?.find((s) => s.id === singleDeleteId) ?? null
  const expiryRowCurrent = expiryRow
    ? expiryRow.expiresAt
      ? `当前：${
          new Date(expiryRow.expiresAt).getTime() < Date.now()
            ? '已过期'
            : `有效期至 ${new Date(expiryRow.expiresAt).toLocaleDateString('zh-CN')}`
        }`
      : '当前：永久有效'
    : ''

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4">
      <header className="sticky top-0 z-30 -mx-4 flex h-14 items-center gap-2 border-b border-border bg-background/90 px-4 backdrop-blur">
        <Button variant="ghost" size="icon" aria-label="返回" onClick={onBack}>
          <ArrowLeft className="size-5" strokeWidth={1.75} />
        </Button>
        <h1 className="text-base font-bold">分享管理</h1>
        <div className="ml-auto flex items-center gap-1">
          {batchMode && (
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full text-sm"
              onClick={() =>
                setSelected(allSelected ? new Set() : new Set(displayShares.map((s) => s.id)))
              }
            >
              {allSelected ? '取消全选' : '全选'}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="搜索分享"
            aria-pressed={searchOpen}
            className={cn(searchOpen && 'text-emerald-600')}
            onClick={() => {
              setFiltered(null)
              setSearchOpen((v) => !v)
            }}
          >
            <Search className="size-5" strokeWidth={1.75} />
          </Button>
          <Button
            variant={batchMode ? 'default' : 'outline'}
            size="sm"
            className="rounded-full"
            onClick={() => {
              setBatchMode((v) => !v)
              setSelected(new Set())
            }}
          >
            <SquareCheckBig className="size-4" strokeWidth={1.75} />
            {batchMode ? '完成' : '批量'}
          </Button>
        </div>
      </header>

      {/* 分类 Tab：全部 / 书籍内容 / AI 对话 / 试卷 */}
      <div className="pt-3">
        <div className="flex gap-2" role="tablist" aria-label="分享分类">
          {TABS.map((t) => {
            const active = tab === t.key
            const count =
              (shares ?? []).filter((s) => t.key === 'all' || s.kind === t.key).length
            const Icon = t.icon
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.key)}
                className={cn(
                  'flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full px-2 text-sm font-medium transition-colors',
                  active
                    ? 'bg-foreground text-background shadow-sm'
                    : 'border border-border bg-card text-muted-foreground hover:bg-accent',
                )}
              >
                <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
                <span className="truncate">{t.label}</span>
                <span
                  className={cn(
                    'ml-0.5 shrink-0 rounded-full px-1.5 text-[11px] font-semibold',
                    active ? 'bg-background/20 text-background' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {count}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* 统一检索（share 模式，内嵌） */}
      <div className="pt-3">
        <SearchOverlay
          mode="share"
          open={searchOpen}
          onOpenChange={(o) => {
            setSearchOpen(o)
            if (!o) setFiltered(null)
          }}
          shares={tabShares as ShareSearchRow[]}
          onFiltered={handleFiltered}
        />
      </div>

      {/* 计数 + 排序方向开关（在检索排序基础上整体翻转） */}
      <div className="flex items-center justify-between pt-3 text-xs text-muted-foreground">
        <span>
          共 {displayShares.length} 条
          {batchMode && selected.size > 0 ? ` · 已选 ${selected.size}` : ''}
        </span>
        <button
          type="button"
          onClick={() => setSortDir((v) => (v === 'desc' ? 'asc' : 'desc'))}
          aria-label={sortDir === 'desc' ? '当前倒序，点击切换为正序' : '当前正序，点击切换为倒序'}
          className="flex h-8 items-center gap-1 rounded-full border border-border bg-card px-3 font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowDownUp className="size-3.5" strokeWidth={1.75} />
          {sortDir === 'desc' ? '新→旧' : '旧→新'}
        </button>
      </div>

      <main className="flex-1 py-3">
        {shares === null ? (
          <div className="space-y-3">
            <Skeleton className="h-20 rounded-2xl" />
            <Skeleton className="h-20 rounded-2xl" />
          </div>
        ) : displayShares.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-border py-16 text-center">
            {filtered !== null ? (
              <>
                <Search className="size-12 text-muted-foreground/30" strokeWidth={1.25} />
                <p className="text-sm text-muted-foreground">没有匹配的分享</p>
                <p className="text-xs text-muted-foreground/70">换个关键词，或调整有效/过期筛选</p>
              </>
            ) : (
              <>
                <Link2 className="size-12 text-muted-foreground/30" strokeWidth={1.25} />
                <p className="text-sm text-muted-foreground">{EMPTY_HINT[tab].title}</p>
                <p className="text-xs text-muted-foreground/70">{EMPTY_HINT[tab].hint}</p>
              </>
            )}
          </div>
        ) : (
          <ul className="space-y-3" role="list">
            {displayShares.map((s) => {
              const expired = !!s.expiresAt && new Date(s.expiresAt).getTime() < Date.now()
              const badge = KIND_BADGE[s.kind] ?? KIND_BADGE.card
              return (
                <li
                  key={s.id}
                  className={cn(
                    'rounded-2xl border border-border bg-card p-4',
                    batchMode && selected.has(s.id) && 'border-emerald-600/60 ring-1 ring-emerald-600/40',
                  )}
                >
                  <div className="flex items-center gap-3">
                    {batchMode && (
                      <button
                        type="button"
                        aria-label={selected.has(s.id) ? '取消选择' : '选择'}
                        aria-pressed={selected.has(s.id)}
                        onClick={() => toggle(s.id)}
                        className={cn(
                          'flex size-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
                          selected.has(s.id)
                            ? 'border-foreground bg-foreground text-background'
                            : 'border-muted-foreground/40',
                        )}
                      >
                        {selected.has(s.id) && (
                          <SquareCheckBig className="size-3.5" strokeWidth={2.5} />
                        )}
                      </button>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <p className="truncate text-sm font-bold">{s.title}</p>
                        <span
                          className={cn(
                            'shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                            badge.className,
                          )}
                        >
                          {badge.label}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {s.kind === 'paper' ? '/s/' : '/share/'}
                        {s.token.slice(0, 10)}… · 创建于{' '}
                        {new Date(s.createdAt).toLocaleDateString('zh-CN')}
                      </p>
                      <p
                        className={cn(
                          'mt-0.5 text-xs',
                          expired ? 'text-destructive' : 'text-emerald-600',
                        )}
                      >
                        {s.expiresAt
                          ? expired
                            ? '已过期'
                            : `有效期至 ${new Date(s.expiresAt).toLocaleDateString('zh-CN')}`
                          : '永久有效'}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="预览分享内容"
                        onClick={() => setPreviewRow(s)}
                      >
                        <Eye className="size-4" strokeWidth={1.75} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="复制链接"
                        onClick={() => copyLink(s)}
                      >
                        <Copy className="size-4" strokeWidth={1.75} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="修改有效期"
                        onClick={() => setExpiryRow(s)}
                      >
                        <Clock3 className="size-4" strokeWidth={1.75} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="取消该分享"
                        disabled={busySingle}
                        onClick={() => setSingleDeleteId(s.id)}
                      >
                        <Trash2 className="size-4" strokeWidth={1.75} />
                      </Button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </main>

      {batchMode && selected.size > 0 && (
        <div className="sticky bottom-0 -mx-4 flex items-center gap-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur">
          <Select value={extendDays} onValueChange={setExtendDays}>
            <SelectTrigger className="h-10 w-32 rounded-full" aria-label="延长天数">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">延长 1 天</SelectItem>
              <SelectItem value="7">延长 7 天</SelectItem>
              <SelectItem value="30">延长 30 天</SelectItem>
              <SelectItem value="90">延长 90 天</SelectItem>
              <SelectItem value="0">设为永久</SelectItem>
            </SelectContent>
          </Select>
          <Button
            className="flex-1 rounded-full bg-primary"
            disabled={busy}
            onClick={() => void batchExtend()}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            批量延期
          </Button>
          <Button
            variant="destructive"
            className="flex-1 rounded-full"
            disabled={busy || selected.size === 0}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="size-4" strokeWidth={1.75} />
            删除所选
          </Button>
        </div>
      )}

      {/* 分享预览（内置 Dialog：试卷 → SharedPaperView；卡片/对话 → 对话视图/卡片视图） */}
      <Dialog
        open={!!previewRow}
        onOpenChange={(o) => {
          if (!o) setPreviewRow(null)
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          className="flex max-h-[88dvh] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-md"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>分享预览</DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:min-h-6 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent">
            {previewRow &&
              (previewRow.kind === 'paper' ? (
                <SharedPaperView token={previewRow.token} embedded />
              ) : (
                <SharedConversationView token={previewRow.token} embedded />
              ))}
          </div>
          {previewRow && (
            <div className="flex shrink-0 gap-2 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <Button
                variant="outline"
                className="h-10 flex-1 rounded-full text-sm"
                onClick={() => copyLink(previewRow)}
              >
                <Copy className="size-4" strokeWidth={1.75} />
                复制链接
              </Button>
              <Button
                variant="outline"
                className="h-10 flex-1 rounded-full text-sm"
                onClick={() => openSharePage(previewRow)}
              >
                <SquareArrowOutUpRight className="size-4" strokeWidth={1.75} />
                在浏览器打开
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 单条修改有效期（无限 / 1 / 7 / 30 / 自定义） */}
      <Dialog
        open={!!expiryRow}
        onOpenChange={(o) => {
          if (!o) setExpiryRow(null)
        }}
      >
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>修改有效期</DialogTitle>
            <DialogDescription className="truncate">
              {expiryRow ? `「${expiryRow.title}」` : ''}
              {expiryRowCurrent ? ` · ${expiryRowCurrent}` : ''}
            </DialogDescription>
          </DialogHeader>
          <RadioGroup
            value={expiry}
            onValueChange={(v) => setExpiry(v as ExpiryOption)}
            className="gap-2.5"
          >
            {(
              [
                { value: 'inf', label: '无限（不过期）' },
                { value: '1', label: '1 天' },
                { value: '7', label: '7 天' },
                { value: '30', label: '30 天' },
                { value: 'custom', label: '自定义' },
              ] as const
            ).map((opt) => (
              <div
                key={opt.value}
                className={cn(
                  'flex items-center gap-2.5 rounded-xl border px-3 py-2.5 transition-colors',
                  expiry === opt.value
                    ? 'border-emerald-600/40 bg-emerald-600/5'
                    : 'border-border',
                )}
              >
                <RadioGroupItem value={opt.value} id={`mgr-expiry-${opt.value}`} />
                <Label
                  htmlFor={`mgr-expiry-${opt.value}`}
                  className="flex-1 cursor-pointer text-sm font-medium"
                >
                  {opt.label}
                </Label>
              </div>
            ))}
          </RadioGroup>
          {expiry === 'custom' && (
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={3650}
                value={customDays}
                onChange={(e) => setCustomDays(e.target.value)}
                placeholder="1-3650"
                aria-label="自定义天数"
                className="h-10 w-28 rounded-xl"
              />
              <span className="text-sm text-muted-foreground">天（1-3650）</span>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" className="rounded-full" onClick={() => setExpiryRow(null)}>
              取消
            </Button>
            <Button className="rounded-full" disabled={busy} onClick={() => void updateExpiry()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent className="rounded-2xl sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>删除所选 {selected.size} 个分享？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后原链接立即失效，访客将无法再访问，且不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => void batchDelete()}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!singleDeleteId}
        onOpenChange={(v) => {
          if (!v) setSingleDeleteId(null)
        }}
      >
        <AlertDialogContent className="rounded-2xl sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>取消该分享？</AlertDialogTitle>
            <AlertDialogDescription>
              {singleDeleteRow
                ? `「${singleDeleteRow.title}」的分享链接将立即失效，访客无法再访问，且不可恢复。`
                : '该分享链接将立即失效，访客将无法再访问，且不可恢复。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={busySingle}
              onClick={() => void deleteSingle()}
            >
              {busySingle ? '删除中…' : '确认取消'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
