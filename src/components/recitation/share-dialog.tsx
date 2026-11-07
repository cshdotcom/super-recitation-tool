'use client'

import * as React from 'react'
import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import { Copy, Link2, Loader2, Share2 } from 'lucide-react'
import { toast } from 'sonner'

import type { CardData, ShareInfo } from '@/lib/types'
import { cn } from '@/lib/utils'
import { BottomSheet } from '@/components/recitation/bottom-sheet'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * IMPORTANT EXPORT CONTRACT — consumed by the reader as
 *   <ShareDialog card={card} open={shareOpen} onOpenChange={setShareOpen} />
 */
export function ShareDialog({
  card,
  open,
  onOpenChange,
}: {
  card: CardData
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  type ExpiryOption = 'inf' | '1' | '7' | '30' | 'custom'

  const [loading, setLoading] = React.useState(false)
  const [share, setShare] = React.useState<ShareInfo | null>(null)
  const [expiry, setExpiry] = React.useState<ExpiryOption>('7')
  const [customDays, setCustomDays] = React.useState('7')
  const [creating, setCreating] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const [origin, setOrigin] = React.useState('')

  // Load current share status each time the dialog opens.
  React.useEffect(() => {
    if (!open) return
    setOrigin(window.location.origin)
    setExpiry('7')
    setCustomDays('7')
    setLoading(true)
    let alive = true
    fetch(`/api/cards/${encodeURIComponent(card.id)}/share`)
      .then((r) => r.json())
      .then((res) => {
        if (alive) setShare((res && res.share) || null)
      })
      .catch(() => {
        if (alive) toast.error('获取共享状态失败')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [open, card.id])

  const link = share ? `${origin}/share/${share.token}` : ''

  const handleCreate = async () => {
    let days: number | null
    if (expiry === 'inf') {
      days = null
    } else if (expiry === 'custom') {
      const n = Number(customDays)
      if (!Number.isInteger(n) || n < 1 || n > 3650) {
        toast.error('自定义有效期需为 1-3650 的整数（天）')
        return
      }
      days = n
    } else {
      days = Number(expiry)
    }

    setCreating(true)
    try {
      const res = await fetch(`/api/cards/${encodeURIComponent(card.id)}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresInDays: days }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '开启共享失败')
      setShare(data.share as ShareInfo)
      toast.success('共享已开启')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '开启共享失败')
    } finally {
      setCreating(false)
    }
  }

  const handleCancelShare = async () => {
    if (!share) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/cards/${encodeURIComponent(card.id)}/share`, {
        method: 'DELETE',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '取消共享失败')
      setShare(null)
      toast.success('已取消共享，链接即刻失效')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '取消共享失败')
    } finally {
      setDeleting(false)
    }
  }

  const handleCopyLink = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      toast.success('链接已复制')
    } catch {
      toast.error('复制失败，请长按链接手动复制')
    }
  }

  const formatExpiry = (s: ShareInfo): string => {
    if (!s.expiresAt) return '永久有效'
    return `有效期至 ${format(new Date(s.expiresAt), 'yyyy/MM/dd', { locale: zhCN })}`
  }

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="共享背书卡片">
      <div className="mt-4 flex-1 space-y-4 overflow-y-auto pb-6">
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-24 rounded-2xl" />
            <Skeleton className="h-40 rounded-2xl" />
          </div>
        ) : share ? (
          /* ---------- link section ---------- */
          <div className="rounded-2xl border border-emerald-600/30 bg-emerald-600/5 px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-bold text-emerald-700 dark:text-emerald-400">
              <Link2 className="size-4" strokeWidth={1.75} />
              共享已开启 · {formatExpiry(share)}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Input
                readOnly
                value={link}
                aria-label="共享链接"
                onFocus={(e) => e.currentTarget.select()}
                className="h-10 min-w-0 flex-1 rounded-xl font-mono text-xs"
              />
              <Button
                size="sm"
                className="h-10 shrink-0 rounded-full bg-emerald-600 px-4 font-semibold text-white hover:bg-emerald-600/90"
                onClick={() => void handleCopyLink()}
              >
                <Copy className="size-4" strokeWidth={1.75} />
                复制链接
              </Button>
            </div>
            <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">
              任何拥有此链接的人都可查看该背书卡的只读内容；取消共享后链接立即失效。
            </p>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  className="mt-3 h-10 w-full rounded-full border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={deleting}
                >
                  {deleting && <Loader2 className="size-4 animate-spin" />}
                  取消共享
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="rounded-2xl">
                <AlertDialogHeader>
                  <AlertDialogTitle>取消共享？</AlertDialogTitle>
                  <AlertDialogDescription>
                    取消后原共享链接将立即失效，无法再访问该卡片内容。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-white hover:bg-destructive/90"
                    onClick={() => void handleCancelShare()}
                  >
                    确认取消共享
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ) : (
          /* ---------- enable flow ---------- */
          <div className="rounded-2xl border border-border bg-card px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-bold">
              <Share2 className="size-4 text-muted-foreground" strokeWidth={1.75} />
              选择有效期
            </div>
            <RadioGroup
              value={expiry}
              onValueChange={(v) => setExpiry(v as ExpiryOption)}
              className="mt-3 gap-2.5"
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
                  <RadioGroupItem value={opt.value} id={`share-expiry-${opt.value}`} />
                  <Label
                    htmlFor={`share-expiry-${opt.value}`}
                    className="flex-1 cursor-pointer text-sm font-medium"
                  >
                    {opt.label}
                  </Label>
                </div>
              ))}
            </RadioGroup>

            {expiry === 'custom' && (
              <div className="mt-3 flex items-center gap-2">
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

            <Button
              className="mt-4 h-10 w-full rounded-full font-semibold"
              onClick={() => void handleCreate()}
              disabled={creating}
            >
              {creating && <Loader2 className="size-4 animate-spin" />}
              开启共享
            </Button>
            <p className="mt-2 text-center text-[11px] text-muted-foreground/70">
              开启后将生成只读链接，可随时取消
            </p>
          </div>
        )}
      </div>
    </BottomSheet>
  )
}
