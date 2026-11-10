'use client'

// ConversationShareDialog — 对话分享前的有效期选择对话框（单条 / 批量共用）。
// 从 chat-sidebar.tsx 抽出为公共组件：ChatTool 头部分享、侧边栏单条/批量分享、
// ChatTool 消息多选分享共用同一套 UI（永久 / 1 / 7 / 30 / 自定义天数）。
import * as React from 'react'
import { Share2 } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export type ShareExpiry = 'inf' | '1' | '7' | '30' | 'custom'

const SHARE_EXPIRY_OPTIONS: { value: ShareExpiry; label: string }[] = [
  { value: 'inf', label: '永久有效' },
  { value: '1', label: '1 天' },
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: 'custom', label: '自定义' },
]

/**
 * 分享对话前的有效期选择对话框（与卡片/书籍分享一致）。
 * - mode 'single'：分享单个对话 / 一组勾选消息（title 自定义）。
 * - mode 'batch'：批量分享（title 如「批量分享 N 个对话」）。
 * 确认后回调 onConfirm(days)：0 = 永久，N = N 天有效；由调用方执行
 * 实际创建。自定义天数需为 1-3650 的整数。
 */
export function ConversationShareDialog({
  open,
  onOpenChange,
  title,
  description,
  mode,
  onConfirm,
  busy,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** 可选描述文案；未传时按 mode 给默认说明。 */
  description?: string
  mode: 'single' | 'batch'
  onConfirm: (days: number) => void
  /** 确认按钮 busy 态（创建中）。 */
  busy?: boolean
}) {
  const [expiry, setExpiry] = React.useState<ShareExpiry>('7')
  const [customDays, setCustomDays] = React.useState('7')

  // 每次打开重置（默认 7 天，与卡片分享默认一致）
  React.useEffect(() => {
    if (open) {
      setExpiry('7')
      setCustomDays('7')
    }
  }, [open])

  const handleConfirm = () => {
    if (expiry === 'inf') {
      onConfirm(0)
      return
    }
    if (expiry === 'custom') {
      const v = customDays.trim()
      const n = Number(v)
      if (!/^\d+$/.test(v) || !Number.isInteger(n) || n < 1 || n > 3650) {
        toast.error('自定义有效期需为 1-3650 的整数（天）')
        return
      }
      onConfirm(n)
      return
    }
    onConfirm(Number(expiry))
  }

  const defaultDesc =
    mode === 'batch'
      ? '将为所选对话分别创建只读分享链接，并逐个复制到剪贴板；到期后链接自动失效。'
      : '将创建只读分享链接并复制到剪贴板；到期后链接自动失效。'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description ?? defaultDesc}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm font-medium">有效期</p>
          <RadioGroup
            value={expiry}
            onValueChange={(v) => setExpiry(v as ShareExpiry)}
            className="gap-2.5"
          >
            {SHARE_EXPIRY_OPTIONS.map((opt) => (
              <div
                key={opt.value}
                className={cn(
                  'flex items-center gap-2.5 rounded-xl border px-3 py-2.5 transition-colors',
                  expiry === opt.value
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-border',
                )}
              >
                <RadioGroupItem value={opt.value} id={`conv-share-expiry-${opt.value}`} />
                <Label
                  htmlFor={`conv-share-expiry-${opt.value}`}
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
        </div>

        <DialogFooter>
          <Button variant="outline" className="rounded-full" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button className="rounded-full" disabled={busy} onClick={handleConfirm}>
            <Share2 className="size-4" />
            确认分享
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
