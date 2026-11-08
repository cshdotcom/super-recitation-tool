'use client'

// 分享管理：全部分享链接列表 + 单个删除 + 批量操作（延长有效期 / 删除所选）
import * as React from 'react'
import { ArrowLeft, Copy, Link2, Loader2, SquareCheckBig, Trash2 } from 'lucide-react'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface ShareRow {
  id: string
  token: string
  cardId: string
  cardTitle: string
  expiresAt: string | null
  createdAt: string
}

export function ShareManagerView({ onBack }: { onBack: () => void }) {
  const [shares, setShares] = React.useState<ShareRow[] | null>(null)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [batchMode, setBatchMode] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [singleDeleteId, setSingleDeleteId] = React.useState<string | null>(null)
  const [extendDays, setExtendDays] = React.useState('7')
  const [busy, setBusy] = React.useState(false)
  const [busySingle, setBusySingle] = React.useState(false)

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

  const toggle = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const allSelected = !!shares?.length && shares.every((s) => selected.has(s.id))

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
              onClick={() => setSelected(allSelected ? new Set() : new Set((shares ?? []).map((s) => s.id)))}
            >
              {allSelected ? '取消全选' : '全选'}
            </Button>
          )}
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

      <main className="flex-1 py-4">
        {shares === null ? (
          <div className="space-y-3">
            <Skeleton className="h-20 rounded-2xl" />
            <Skeleton className="h-20 rounded-2xl" />
          </div>
        ) : shares.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-border py-16 text-center">
            <Link2 className="size-12 text-muted-foreground/30" strokeWidth={1.25} />
            <p className="text-sm text-muted-foreground">还没有分享过任何卡片</p>
            <p className="text-xs text-muted-foreground/70">打开一张卡片，点右上「分享」创建链接</p>
          </div>
        ) : (
          <ul className="space-y-3" role="list">
            {shares.map((s) => {
              const expired = s.expiresAt && new Date(s.expiresAt).getTime() < Date.now()
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
                        {selected.has(s.id) && <SquareCheckBig className="size-3.5" strokeWidth={2.5} />}
                      </button>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold">{s.cardTitle}</p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        /share/{s.token.slice(0, 10)}… · 创建于{' '}
                        {new Date(s.createdAt).toLocaleDateString('zh-CN')}
                      </p>
                      <p className={cn('mt-0.5 text-xs', expired ? 'text-destructive' : 'text-emerald-600')}>
                        {s.expiresAt
                          ? expired
                            ? '已过期'
                            : `有效期至 ${new Date(s.expiresAt).toLocaleDateString('zh-CN')}`
                          : '永久有效'}
                      </p>
                    </div>
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
                      aria-label="删除该分享"
                      disabled={busySingle}
                      onClick={() => setSingleDeleteId(s.id)}
                    >
                      <Trash2 className="size-4" strokeWidth={1.75} />
                    </Button>
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

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent className="rounded-2xl sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>删除所选 {selected.size} 个分享？</AlertDialogTitle>
            <AlertDialogDescription>删除后原链接立即失效，访客将无法再访问，且不可恢复。</AlertDialogDescription>
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
            <AlertDialogTitle>删除该分享？</AlertDialogTitle>
            <AlertDialogDescription>
              {singleDeleteRow
                ? `「${singleDeleteRow.cardTitle}」的分享链接将立即失效，访客无法再访问，且不可恢复。`
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
              {busySingle ? '删除中…' : '确认删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
