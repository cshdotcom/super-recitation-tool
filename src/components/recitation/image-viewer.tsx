'use client'

// ImageViewer — 全功能图片查看器（聊天附图 / 分享页附图共用）。
//   • 缩放：+/- 按钮、双击在 1x/2x 间切换、桌面滚轮、移动端双指捏合（0.25x–5x）
//   • 平移：单指/鼠标拖拽；旋转：每次 90°；下载：dataURL → a[download]
//   • 打开时自动适应窗口（contain），Esc / 点关闭按钮退出
// 以 Dialog 承载（portal 到 body，z 高于全屏对话层）。
import * as React from 'react'
import { Download, Minus, Plus, RotateCw, X } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

const MIN_SCALE = 0.25
const MAX_SCALE = 5

function clampScale(v: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, v))
}

/** 从 dataURL 猜测扩展名（默认 png）。 */
function extFromDataUrl(src: string): string {
  const m = src.match(/^data:image\/(png|jpeg|jpg|webp|gif|bmp)/i)
  if (!m) return 'png'
  const t = m[1].toLowerCase()
  return t === 'jpeg' ? 'jpg' : t
}

export function ImageViewer({
  src,
  open,
  onOpenChange,
  alt = '图片预览',
}: {
  src: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  alt?: string
}) {
  const [scale, setScale] = React.useState(1)
  const [offset, setOffset] = React.useState({ x: 0, y: 0 })
  const [rotate, setRotate] = React.useState(0)
  /** 指针交互中（拖拽/捏合）禁用 transform 过渡，避免跟手延迟。 */
  const [panActive, setPanActive] = React.useState(false)

  const stageRef = React.useRef<HTMLDivElement>(null)
  /** 活动指针表（双指捏合用）。 */
  const pointersRef = React.useRef<Map<number, { x: number; y: number }>>(new Map())
  /** 捏合起点状态（两指距离 / 中点 / 当时 scale / 当时 offset）。 */
  const pinchStartRef = React.useRef<{
    dist: number
    cx: number
    cy: number
    scale: number
    ox: number
    oy: number
  } | null>(null)
  /** 单指拖拽起点。 */
  const panStartRef = React.useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  // 打开 / 换图时复位
  React.useEffect(() => {
    if (open) {
      setScale(1)
      setOffset({ x: 0, y: 0 })
      setRotate(0)
      pointersRef.current.clear()
      pinchStartRef.current = null
      panStartRef.current = null
    }
  }, [open, src])

  // 桌面滚轮缩放（Ctrl+滚轮与普通滚轮都缩放，阻止页面滚动）
  React.useEffect(() => {
    const el = stageRef.current
    if (!el || !open) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setScale((s) => clampScale(s * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [open])

  const zoomBy = (factor: number) => setScale((s) => clampScale(s * factor))

  const handleDoubleClick = () => {
    if (scale >= 1.95) {
      setScale(1)
      setOffset({ x: 0, y: 0 })
    } else {
      setScale(2)
    }
  }

  const handleDownload = () => {
    if (!src) return
    try {
      const a = document.createElement('a')
      a.href = src
      a.download = `图片-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.${extFromDataUrl(src)}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      toast.success('图片已下载')
    } catch {
      toast.error('下载失败')
    }
  }

  // ---------- 指针交互：单指拖拽平移 / 双指捏合缩放 ----------
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!src) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    setPanActive(true)
    if (pointersRef.current.size === 1) {
      panStartRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
      pinchStartRef.current = null
    } else if (pointersRef.current.size === 2) {
      const pts = Array.from(pointersRef.current.values())
      const [a, b] = pts
      pinchStartRef.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
        scale,
        ox: offset.x,
        oy: offset.y,
      }
      panStartRef.current = null
    }
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(e.pointerId)) return
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointersRef.current.size >= 2 && pinchStartRef.current) {
      const pts = Array.from(pointersRef.current.values())
      const [a, b] = pts
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1
      const start = pinchStartRef.current
      const next = clampScale((start.scale * dist) / start.dist)
      setScale(next)
      // 中点位移作为平移量
      const cx = (a.x + b.x) / 2
      const cy = (a.y + b.y) / 2
      setOffset({ x: start.ox + (cx - start.cx), y: start.oy + (cy - start.cy) })
      return
    }
    if (pointersRef.current.size === 1 && panStartRef.current) {
      const p = panStartRef.current
      setOffset({ x: p.ox + (e.clientX - p.x), y: p.oy + (e.clientY - p.y) })
    }
  }

  const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(e.pointerId)
    if (pointersRef.current.size < 2) pinchStartRef.current = null
    if (pointersRef.current.size === 0) {
      panStartRef.current = null
      setPanActive(false)
    }
  }

  const resetView = () => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
    setRotate(0)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        className="fixed inset-0 top-0 left-0 z-[80] flex h-[100dvh] w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-black/95 p-0"
      >
        <DialogTitle className="sr-only">图片预览</DialogTitle>
        {/* 顶栏：关闭 */}
        <div className="flex items-center justify-between px-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-white">
          <span className="min-w-0 truncate px-1 text-xs text-white/70">
            {Math.round(scale * 100)}%
            {rotate % 360 !== 0 ? ` · ${((rotate % 360) + 360) % 360}°` : ''}
          </span>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="关闭预览"
            className="flex size-10 items-center justify-center rounded-full text-white/90 transition-colors hover:bg-white/10"
          >
            <X className="size-5" strokeWidth={2} />
          </button>
        </div>

        {/* 舞台：拖拽 / 双击 / 捏合 */}
        <div
          ref={stageRef}
          className="flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onDoubleClick={handleDoubleClick}
        >
          {src && (
            <img
              src={src}
              alt={alt}
              draggable={false}
              className="max-h-full max-w-full select-none object-contain will-change-transform"
              style={{
                transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale}) rotate(${rotate}deg)`,
                transition: panActive ? 'none' : 'transform 0.12s ease-out',
              }}
            />
          )}
        </div>

        {/* 底部控制条（Safe Area 适配） */}
        <div className="flex items-center justify-center gap-1.5 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
          <ViewerBtn label="缩小" onClick={() => zoomBy(1 / 1.25)} disabled={scale <= MIN_SCALE}>
            <Minus className="size-4" />
          </ViewerBtn>
          <button
            type="button"
            onClick={resetView}
            className="h-10 min-w-14 rounded-full px-2 text-xs font-medium tabular-nums text-white/90 transition-colors hover:bg-white/10"
          >
            {Math.round(scale * 100)}%
          </button>
          <ViewerBtn label="放大" onClick={() => zoomBy(1.25)} disabled={scale >= MAX_SCALE}>
            <Plus className="size-4" />
          </ViewerBtn>
          <ViewerBtn label="旋转" onClick={() => setRotate((r) => r + 90)}>
            <RotateCw className="size-4" />
          </ViewerBtn>
          <ViewerBtn label="下载图片" onClick={handleDownload}>
            <Download className="size-4" />
          </ViewerBtn>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ViewerBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={cn(
        'flex size-10 items-center justify-center rounded-full text-white/90 transition-colors hover:bg-white/10',
        disabled && 'pointer-events-none opacity-35',
      )}
    >
      {children}
    </button>
  )
}
