'use client'

// MediaDetailDialog — 富媒体详情弹窗（图片 / 表格 / 思维导图 / SVG / 公式 / 代码）。
// 能力：放大/缩小/重置（步进 25%，0.5x-4x）、下载保存、复制引用、定位到正文引用位置。
// 与 MediaRefStrip 配合；所有渲染统一走 RichContent（与阅读/预览同一内核）。

import * as React from 'react'
import { Copy, Crosshair, Download, Minus, Plus, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { MEDIA_KIND_LABEL, downloadMedia, type MediaRef } from '@/components/recitation/media-refs'

const RichContentLazy = React.lazy(() =>
  import('@/components/recitation/rich-content').then((m) => ({ default: m.RichContent })),
)

/** 富媒体源码 → RichContent 可渲染文本 */
function toRenderContent(ref: MediaRef): string {
  switch (ref.kind) {
    case 'image':
      return `![${ref.alt || '图片'}](${ref.src})`
    case 'table':
      return ref.src
    case 'formula':
      return `$$${ref.src}$$`
    case 'mermaid':
      return '```mermaid\n' + ref.src + '\n```'
    case 'svg':
      return '```svg\n' + ref.src + '\n```'
    default:
      return '```\n' + ref.src + '\n```'
  }
}

export function MediaDetailDialog({
  mediaRef,
  contextLabel,
  onOpenChange,
  onLocate,
  onCopyRef,
}: {
  /** 当前查看的引用（null 关闭） */
  mediaRef: MediaRef | null
  /** 引用位置说明，如「第 3 块 · 完整内容」 */
  contextLabel?: string
  onOpenChange: (open: boolean) => void
  /** 定位到正文引用位置 */
  onLocate?: (ref: MediaRef) => void
  /** 复制引用命令（默认直接写剪贴板） */
  onCopyRef?: (ref: MediaRef) => void
}) {
  const [scale, setScale] = React.useState(1)

  React.useEffect(() => {
    if (mediaRef) setScale(1)
  }, [mediaRef])

  if (!mediaRef) return null
  const ref = mediaRef
  const isImage = ref.kind === 'image'

  const zoom = (d: number) =>
    setScale((s) => Math.min(4, Math.max(0.5, Math.round((s + d) * 100) / 100)))

  const handleCopy = async () => {
    if (onCopyRef) {
      onCopyRef(ref)
      return
    }
    try {
      await navigator.clipboard.writeText(ref.raw)
      toast.success('引用已复制，粘贴到任意文本框即可插入')
    } catch {
      toast.error('复制失败，请手动复制')
    }
  }

  return (
    <Dialog open={!!ref} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88dvh] rounded-2xl sm:max-w-2xl">
        <DialogHeader className="pr-10">
          <DialogTitle>
            {MEDIA_KIND_LABEL[ref.kind]}详情
            {isImage && ref.alt ? ` · ${ref.alt}` : ''}
          </DialogTitle>
          <DialogDescription className="truncate">
            {contextLabel ? `${contextLabel} 引用此${MEDIA_KIND_LABEL[ref.kind]}` : '查看与保存'}
          </DialogDescription>
        </DialogHeader>

        {/* 渲染区：缩放 */}
        <div className="relative max-h-[55dvh] min-h-40 overflow-auto rounded-xl bg-muted/50 p-3">
          {isImage ? (
            <img
              src={ref.src}
              alt={ref.alt || '图片详情'}
              style={{ transform: `scale(${scale})` }}
              className="mx-auto max-h-[50dvh] w-auto origin-center rounded-lg object-contain transition-transform"
            />
          ) : (
            <div
              style={{ transform: `scale(${scale})` }}
              className="origin-top-left transition-transform"
            >
              <React.Suspense
                fallback={
                  <p className="py-6 text-center text-xs text-muted-foreground">渲染中…</p>
                }
              >
                <RichContentLazy content={toRenderContent(ref)} />
              </React.Suspense>
            </div>
          )}
        </div>

        {/* 缩放控制 + 当前倍率 */}
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="icon"
            aria-label="缩小"
            className="size-9 rounded-full"
            disabled={scale <= 0.5}
            onClick={() => zoom(-0.25)}
          >
            <Minus className="size-4" />
          </Button>
          <button
            type="button"
            aria-label="重置缩放"
            title="重置缩放"
            onClick={() => setScale(1)}
            className="min-w-14 rounded-full bg-muted px-2 py-1.5 text-xs font-medium tabular-nums text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {Math.round(scale * 100)}%
          </button>
          <Button
            variant="outline"
            size="icon"
            aria-label="放大"
            className="size-9 rounded-full"
            disabled={scale >= 4}
            onClick={() => zoom(0.25)}
          >
            <Plus className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="重置"
            title="重置"
            className="size-9 rounded-full text-muted-foreground"
            onClick={() => setScale(1)}
          >
            <RotateCcw className="size-4" />
          </Button>
        </div>

        {/* 操作条 */}
        <div className={cn('grid grid-cols-3 gap-2')}>
          <Button
            variant="outline"
            className="h-10 rounded-full text-xs"
            onClick={() => downloadMedia(ref)}
          >
            <Download className="size-4" /> 下载保存
          </Button>
          <Button variant="outline" className="h-10 rounded-full text-xs" onClick={() => void handleCopy()}>
            <Copy className="size-4" /> 复制引用
          </Button>
          <Button
            variant="outline"
            className="h-10 rounded-full text-xs"
            disabled={!onLocate}
            onClick={() => onLocate?.(ref)}
          >
            <Crosshair className="size-4" /> 定位引用
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
