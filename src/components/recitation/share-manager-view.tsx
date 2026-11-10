'use client'

// 分享管理 — 改版：
//   • 顶部分类 Tab：书籍内容分享 / AI对话分享（kind 过滤）
//   • 内嵌统一检索（SearchOverlay share 模式）：标题/token 搜索 +
//     全部/有效/已过期 筛选 + 创建/过期时间排序
//   • 批量延期 / 批量取消（作用于当前分类 Tab）
//   • 对话分享条目「预览」→ 内置 Dialog（公开视图 SharedConversationView）
import * as React from 'react'
import {
  ArrowLeft,
  BookOpen,
  Copy,
  Eye,
  Link2,
  Loader2,
  MessageSquare,
  Search,
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
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  SearchOverlay,
  type ShareSearchRow,
} from '@/components/recitation/search-overlay'
import { SharedConversationView } from '@/components/recitation/shared-conversation-view'

type ShareTab = 'card' | 'conversation'

const TABS: readonly { key: ShareTab; label: string; icon: typeof BookOpen }[] = [
  { key: 'card', label: '书籍内容分享', icon: BookOpen },
  { key: 'conversation', label: 'AI对话分享', icon: MessageSquare },
]

const EMPTY_HINT: Record<ShareTab, { title: string; hint: string }> = {
  card: {
    title: '还没有分享过书籍内容',
    hint: '打开一本书，点右上「分享」创建链接',
  },
  conversation: {
    title: '还没有分享过 AI 对话',
    hint: '在 AI 对话面板点「分享」创建链接',
  },
}

export function ShareManagerView({ onBack }: { onBack: () => void }) {
  const [shares, setShares] = React.useState<ShareSearchRow[] | null>(null)
  const [tab, setTab] = React.useState<ShareTab>('card')
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [batchMode, setBatchMode] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [singleDeleteId, setSingleDeleteId] = React.useState<string | null>(null)
  const [extendDays, setExtendDays] = React.useState('7')
  const [busy, setBusy] = React.useState(false)
  const [busySingle, setBusySingle] = React.useState(false)
  const [previewToken, setPreviewToken] = React.useState<string | null>(null)

  // ---------- 统一检索（share 模式） ----------
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [filtered, setFiltered] = React.useState<ShareSearchRow[] | null>(null)
  // ⚠ 必须稳定：SearchOverlay 在受控 effect 中调用
  const handleFiltered = React.useCallback((list: ShareSearchRow[] | null) => {
    setFiltered(list)
  }, [])

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/shares')
      const data = await res.json()
      setShares((data?.shares as ShareSearchRow[]) ?? [])
    } catch {
      toast.error('加载分享列表失败')
      setShares([])
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  // 当前分类 Tab 的分享 + 检索结果
  const tabShares = React.useMemo(
    () => (shares ?? []).filter((s) => s.kind === tab),
    [shares, tab],
  )
  const listShares = filtered ?? tabShares

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

  const allSelected = listShares.length > 0 && listShares.every((s) => selected.has(s.id))

  const copyLink = (token: string) => {
    const url = `${window.location.origin}/share/${token}`
    navigator.clipboard
      ?.writeText(url)
      .then(() => toast.success('链接已复制'))
      .catch(() => toast.error('复制失败'))
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

  const singleDeleteRow = shares?.find((s) => s.id === singleDeleteId) ?? null

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
                setSelected(allSelected ? new Set() : new Set(listShares.map((s) => s.id)))
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

      {/* 分类 Tab */}
      <div className="pt-3">
        <div className="flex gap-2" role="tablist" aria-label="分享分类">
          {TABS.map((t) => {
            const active = tab === t.key
            const count = (shares ?? []).filter((s) => s.kind === t.key).length
            const Icon = t.icon
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.key)}
                className={cn(
                  'flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors',
                  active
                    ? 'bg-foreground text-background shadow-sm'
                    : 'border border-border bg-card text-muted-foreground hover:bg-accent',
                )}
              >
                <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
                <span className="truncate">{t.label}</span>
                <span
                  className={cn(
                    'ml-0.5 rounded-full px-1.5 text-[11px] font-semibold',
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
          shares={tabShares}
          onFiltered={handleFiltered}
        />
      </div>

      <main className="flex-1 py-4">
        {shares === null ? (
          <div className="space-y-3">
            <Skeleton className="h-20 rounded-2xl" />
            <Skeleton className="h-20 rounded-2xl" />
          </div>
        ) : listShares.length === 0 ? (
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
            {listShares.map((s) => {
              const expired = !!s.expiresAt && new Date(s.expiresAt).getTime() < Date.now()
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
                            s.kind === 'conversation'
                              ? 'border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300'
                              : 'border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300',
                          )}
                        >
                          {s.kind === 'conversation' ? '对话' : '书'}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        /share/{s.token.slice(0, 10)}… · 创建于{' '}
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
                      {s.kind === 'conversation' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="预览对话分享"
                          onClick={() => setPreviewToken(s.token)}
                        >
                          <Eye className="size-4" strokeWidth={1.75} />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="复制链接"
                        onClick={() => copyLink(s.token)}
                      >
                        <Copy className="size-4" strokeWidth={1.75} />
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

      {/* 对话分享预览（内置 Dialog，公开视图复用） */}
      <Dialog
        open={!!previewToken}
        onOpenChange={(o) => {
          if (!o) setPreviewToken(null)
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          className="flex max-h-[88dvh] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-md"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>对话分享预览</DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:min-h-6 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent">
            {previewToken && <SharedConversationView token={previewToken} embedded />}
          </div>
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
