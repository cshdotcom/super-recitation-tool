'use client'

// 分享背书卡 — 完整版:
//   • 有效期选择 (无限 / 1天 / 7天 / 30天 / 自定义天数)
//   • 只读链接 + 二维码 (扫码打开)
//   • 复制链接 / 系统分享 (navigator.share)
//   • 导出文本 (.txt) / 复制全文 / 卡片预览

import * as React from 'react'
import QRCode from 'qrcode'
import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import {
  Copy,
  Download,
  Link2,
  Loader2,
  QrCode,
  Share2,
  SquareArrowOutUpRight,
} from 'lucide-react'
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
  const [qrUrl, setQrUrl] = React.useState<string | null>(null)
  const [showQr, setShowQr] = React.useState(false)

  // Load current share status each time the dialog opens.
  React.useEffect(() => {
    if (!open) return
    setOrigin(window.location.origin)
    setExpiry('7')
    setCustomDays('7')
    setShowQr(false)
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

  // Generate the QR code whenever the link exists / toggled visible.
  React.useEffect(() => {
    if (!open || !link || !showQr) {
      setQrUrl(null)
      return
    }
    let alive = true
    QRCode.toDataURL(link, {
      width: 480,
      margin: 2,
      color: { dark: '#111111', light: '#ffffff' },
    })
      .then((url) => {
        if (alive) setQrUrl(url)
      })
      .catch(() => {
        if (alive) toast.error('二维码生成失败')
      })
    return () => {
      alive = false
    }
  }, [open, link, showQr])

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
      setShowQr(false)
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
      setShowQr(false)
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

  const handleSystemShare = async () => {
    if (!link) return
    const text = `【背书吧】${card.title}\n${link}`
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ title: card.title, text, url: link })
        return
      } catch (err) {
        // AbortError = user cancelled, silently ignore; other errors fall back.
        if (err instanceof DOMException && err.name === 'AbortError') return
      }
    }
    try {
      await navigator.clipboard.writeText(text)
      toast.success('已复制链接与标题，可粘贴分享')
    } catch {
      toast.error('当前环境不支持系统分享')
    }
  }

  const handleCopyAll = async () => {
    try {
      await navigator.clipboard.writeText(`${card.title}\n\n${card.content}`)
      toast.success('全文已复制')
    } catch {
      toast.error('复制失败')
    }
  }

  const handleExportTxt = () => {
    try {
      const blob = new Blob([`${card.title}\n\n${card.content}`], {
        type: 'text/plain;charset=utf-8',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${card.title || '背书卡'}.txt`
      a.click()
      URL.revokeObjectURL(url)
      toast.success('已导出 .txt 文件')
    } catch {
      toast.error('导出失败')
    }
  }

  const formatExpiry = (s: ShareInfo): string => {
    if (!s.expiresAt) return '永久有效'
    return `有效期至 ${format(new Date(s.expiresAt), 'yyyy/MM/dd', { locale: zhCN })}`
  }

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="分享背书卡">
      <div className="mt-4 flex-1 space-y-4 overflow-y-auto pb-6">
        {/* ---------- card preview ---------- */}
        <div className="rounded-2xl border border-border bg-card px-4 py-3.5">
          <p className="truncate text-sm font-bold">{card.title}</p>
          <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {card.content.slice(0, 80) || '（空内容）'}
          </p>
          <p className="mt-2 text-[11px] text-muted-foreground/70">
            {card.content.length} 字 · {card.keywords.length} 处挖空
          </p>
        </div>

        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-24 rounded-2xl" />
            <Skeleton className="h-40 rounded-2xl" />
          </div>
        ) : share ? (
          <>
            {/* ---------- link section ---------- */}
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
                  复制
                </Button>
              </div>

              {/* action grid */}
              <div className="mt-3 grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setShowQr((v) => !v)}
                  className={cn(
                    'flex flex-col items-center gap-1.5 rounded-xl border py-3 text-xs font-medium transition-colors',
                    showQr
                      ? 'border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400'
                      : 'border-border bg-background hover:bg-accent',
                  )}
                >
                  <QrCode className="size-4.5" strokeWidth={1.75} />
                  二维码
                </button>
                <button
                  type="button"
                  onClick={() => void handleSystemShare()}
                  className="flex flex-col items-center gap-1.5 rounded-xl border border-border bg-background py-3 text-xs font-medium transition-colors hover:bg-accent"
                >
                  <SquareArrowOutUpRight className="size-4.5" strokeWidth={1.75} />
                  系统分享
                </button>
                <button
                  type="button"
                  onClick={handleExportTxt}
                  className="flex flex-col items-center gap-1.5 rounded-xl border border-border bg-background py-3 text-xs font-medium transition-colors hover:bg-accent"
                >
                  <Download className="size-4.5" strokeWidth={1.75} />
                  导出文本
                </button>
              </div>

              {/* QR code */}
              {showQr && (
                <div className="mt-3 flex flex-col items-center gap-2 rounded-xl bg-background px-4 py-4">
                  {qrUrl ? (
                    <img
                      src={qrUrl}
                      alt="共享链接二维码"
                      className="size-48 rounded-xl"
                    />
                  ) : (
                    <Skeleton className="size-48 rounded-xl" />
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    扫一扫，在手机上打开这张背书卡
                  </p>
                </div>
              )}

              <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">
                任何拥有此链接的人都可查看该背书卡的只读内容；取消共享后链接立即失效。
              </p>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="outline"
                  className="h-10 flex-1 rounded-full"
                  onClick={() => void handleCopyAll()}
                >
                  <Copy className="size-4" strokeWidth={1.75} />
                  复制全文
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      className="h-10 flex-1 rounded-full border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
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
            </div>

            {/* adjust expiry */}
            <div className="rounded-2xl border border-border bg-card px-4 py-4">
              <div className="flex items-center gap-2 text-sm font-bold">
                <Share2 className="size-4 text-muted-foreground" strokeWidth={1.75} />
                调整有效期
              </div>
              <ExpiryPicker
                expiry={expiry}
                setExpiry={setExpiry}
                customDays={customDays}
                setCustomDays={setCustomDays}
              />
              <Button
                className="mt-4 h-10 w-full rounded-full font-semibold"
                onClick={() => void handleCreate()}
                disabled={creating}
              >
                {creating && <Loader2 className="size-4 animate-spin" />}
                更新共享
              </Button>
            </div>
          </>
        ) : (
          /* ---------- enable flow ---------- */
          <div className="rounded-2xl border border-border bg-card px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-bold">
              <Share2 className="size-4 text-muted-foreground" strokeWidth={1.75} />
              选择有效期
            </div>
            <ExpiryPicker
              expiry={expiry}
              setExpiry={setExpiry}
              customDays={customDays}
              setCustomDays={setCustomDays}
            />
            <Button
              className="mt-4 h-10 w-full rounded-full font-semibold"
              onClick={() => void handleCreate()}
              disabled={creating}
            >
              {creating && <Loader2 className="size-4 animate-spin" />}
              开启共享
            </Button>
            <p className="mt-2 text-center text-[11px] text-muted-foreground/70">
              开启后将生成只读链接 + 二维码，可随时取消
            </p>
          </div>
        )}
      </div>
    </BottomSheet>
  )
}

// ---------- expiry radio group (shared by enable / adjust flows) ----------
function ExpiryPicker({
  expiry,
  setExpiry,
  customDays,
  setCustomDays,
}: {
  expiry: 'inf' | '1' | '7' | '30' | 'custom'
  setExpiry: (v: 'inf' | '1' | '7' | '30' | 'custom') => void
  customDays: string
  setCustomDays: (v: string) => void
}) {
  return (
    <>
      <RadioGroup
        value={expiry}
        onValueChange={(v) => setExpiry(v as 'inf' | '1' | '7' | '30' | 'custom')}
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
    </>
  )
}
