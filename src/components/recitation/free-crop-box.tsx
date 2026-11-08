'use client'

// FreeCropBox — 手写的自由裁剪框组件（不依赖 react-easy-crop）。
// 两处复用：图片 OCR 编辑器 + 浏览器相机的裁剪模式。
//
// 交互：
//   • 裁剪框带 8 个把手（4 角 + 4 边中点），拖拽把手自由拉升；
//     选择比例（aspect）时锁定宽高比
//   • 拖框内部移动整个框（始终限制在图片显示矩形内）
//   • 拖框外空白平移图片（配合缩放 > 1 查看局部）
//   • 双指捏合缩放（pointer events 计算），滑块缩放由父组件控制 zoom
//   • 框外区域用 box-shadow 大扩散半透明黑遮罩压暗
//   • 可选九宫格参考线
//
// 坐标契约：
//   • crop 以「显示坐标」（容器内像素）存储在父组件
//   • 几何（zoom/offset/容器尺寸）变化时自动把旧框按图片显示矩形的变化
//     重锚定，保证框始终对应图片上同一块区域
//   • 同时通过 onCropNatural 把框换算成「原图像素坐标」回调，
//     父组件提交时直接传给 /api/ocr 的 crop 参数

import * as React from 'react'

import { cn } from '@/lib/utils'

export interface CropBox {
  x: number
  y: number
  width: number
  height: number
}

export interface CropOffset {
  x: number
  y: number
}

type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

const HANDLES: HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

const HANDLE_STYLE: Record<HandleId, React.CSSProperties> = {
  nw: { left: 0, top: 0, cursor: 'nwse-resize' },
  n: { left: '50%', top: 0, cursor: 'ns-resize' },
  ne: { left: '100%', top: 0, cursor: 'nesw-resize' },
  e: { left: '100%', top: '50%', cursor: 'ew-resize' },
  se: { left: '100%', top: '100%', cursor: 'nwse-resize' },
  s: { left: '50%', top: '100%', cursor: 'ns-resize' },
  sw: { left: 0, top: '100%', cursor: 'nesw-resize' },
  w: { left: 0, top: '50%', cursor: 'ew-resize' },
}

/** 双指/滑块缩放上限 */
export const MAX_CROP_ZOOM = 4

const MIN_BOX = 32 // 裁剪框最小显示边长（px）
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

interface ImageRect {
  x: number
  y: number
  width: number
  height: number
}

interface FreeCropBoxProps {
  src: string
  /** 缩放倍率（1–MAX_CROP_ZOOM），由父组件滑块 / 双指控制 */
  zoom: number
  onZoomChange?: (z: number) => void
  /** 图片平移偏移（显示坐标） */
  offset: CropOffset
  onOffsetChange?: (o: CropOffset) => void
  /** 裁剪框（显示坐标）；null 时自动初始化默认框 */
  crop: CropBox | null
  onCropChange: (c: CropBox) => void
  /** 裁剪框换算成原图像素坐标后回调（提交给 /api/ocr 的 crop 参数） */
  onCropNatural?: (c: CropBox) => void
  /** 宽高比（宽/高），undefined = 自由拉升 */
  aspect?: number
  /** 框内九宫格参考线 */
  grid?: boolean
  disabled?: boolean
  className?: string
}

/** 把裁剪框限制在图片显示矩形内 */
function clampBox(b: CropBox, r: ImageRect): CropBox {
  const width = clamp(b.width, MIN_BOX, r.width)
  const height = clamp(b.height, MIN_BOX, r.height)
  return {
    x: clamp(b.x, r.x, r.x + r.width - width),
    y: clamp(b.y, r.y, r.y + r.height - height),
    width,
    height,
  }
}

/** 按把手拖拽调整裁剪框（aspect 存在时锁定比例，锚定对侧边） */
function resizeBox(
  orig: CropBox,
  handle: HandleId,
  px: number,
  py: number,
  r: ImageRect,
  aspect?: number,
): CropBox {
  const right = orig.x + orig.width
  const bottom = orig.y + orig.height

  if (!aspect) {
    // 自由拉升：各边独立调整
    let x = orig.x
    let y = orig.y
    let width = orig.width
    let height = orig.height
    if (handle.includes('w')) {
      x = clamp(px, r.x, right - MIN_BOX)
      width = right - x
    }
    if (handle.includes('e')) width = clamp(px, orig.x + MIN_BOX, r.x + r.width) - orig.x
    if (handle.includes('n')) {
      y = clamp(py, r.y, bottom - MIN_BOX)
      height = bottom - y
    }
    if (handle.includes('s')) height = clamp(py, orig.y + MIN_BOX, r.y + r.height) - orig.y
    return clampBox({ x, y, width, height }, r)
  }

  if (handle === 'n' || handle === 's') {
    // 上下边把手：高度驱动，宽度按比例并水平居中
    const cx = orig.x + orig.width / 2
    let height =
      handle === 'n'
        ? bottom - clamp(py, r.y, bottom - MIN_BOX)
        : clamp(py, orig.y + MIN_BOX, r.y + r.height) - orig.y
    let width = height * aspect
    if (width > r.width) {
      width = r.width
      height = width / aspect
    }
    width = Math.max(width, MIN_BOX)
    height = width / aspect
    return clampBox({ x: cx - width / 2, y: handle === 'n' ? bottom - height : orig.y, width, height }, r)
  }

  if (handle === 'e' || handle === 'w') {
    // 左右边把手：宽度驱动，高度按比例并垂直居中
    const cy = orig.y + orig.height / 2
    let width =
      handle === 'w'
        ? right - clamp(px, r.x, right - MIN_BOX)
        : clamp(px, orig.x + MIN_BOX, r.x + r.width) - orig.x
    let height = width / aspect
    if (height > r.height) {
      height = r.height
      width = height * aspect
    }
    height = Math.max(height, MIN_BOX)
    width = height * aspect
    return clampBox({ x: handle === 'w' ? right - width : orig.x, y: cy - height / 2, width, height }, r)
  }

  // 角把手：宽度驱动，对角固定
  const anchorRight = handle.includes('w')
  const anchorBottom = handle.includes('n')
  const maxW = anchorRight ? right - r.x : r.x + r.width - orig.x
  const maxH = anchorBottom ? bottom - r.y : r.y + r.height - orig.y
  const rawWidth =
    handle.includes('w')
      ? right - clamp(px, r.x, right - MIN_BOX)
      : clamp(px, orig.x + MIN_BOX, r.x + r.width) - orig.x
  const width = clamp(rawWidth, MIN_BOX, Math.max(MIN_BOX, Math.min(maxW, maxH * aspect)))
  const height = width / aspect
  return clampBox(
    { x: anchorRight ? right - width : orig.x, y: anchorBottom ? bottom - height : orig.y, width, height },
    r,
  )
}

const sameRect = (a: ImageRect | null, b: ImageRect | null) =>
  !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

export function FreeCropBox({
  src,
  zoom,
  onZoomChange,
  offset,
  onOffsetChange,
  crop,
  onCropChange,
  onCropNatural,
  aspect,
  grid = false,
  disabled = false,
  className,
}: FreeCropBoxProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [size, setSize] = React.useState<{ w: number; h: number } | null>(null)
  const [natural, setNatural] = React.useState<{ w: number; h: number } | null>(null)
  const [dragKind, setDragKind] = React.useState<'pan' | 'box' | 'resize' | 'pinch' | null>(null)

  // latest-ref 模式：pointer 回调里始终拿到最新的 props/state
  // （React 19 hooks 规则要求 ref 只能在 effect 中写入）
  const cropRef = React.useRef(crop)
  const onCropChangeRef = React.useRef(onCropChange)
  const onCropNaturalRef = React.useRef(onCropNatural)
  React.useEffect(() => {
    cropRef.current = crop
    onCropChangeRef.current = onCropChange
    onCropNaturalRef.current = onCropNatural
  })

  // 测量容器尺寸
  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) setSize({ w: rect.width, h: rect.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 读取图片原始尺寸（src 变化时重置）
  React.useEffect(() => {
    setNatural(null)
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (!cancelled) setNatural({ w: img.naturalWidth, h: img.naturalHeight })
    }
    img.src = src
    return () => {
      cancelled = true
      img.onload = null
    }
  }, [src])

  // object-contain 基准缩放
  const baseScale = natural && size ? Math.min(size.w / natural.w, size.h / natural.h) : 0

  // 图片显示矩形（显示坐标，含缩放与平移）
  const imageRect = React.useMemo<ImageRect | null>(() => {
    if (!natural || !size || !baseScale) return null
    const width = natural.w * baseScale * zoom
    const height = natural.h * baseScale * zoom
    return {
      x: size.w / 2 + offset.x - width / 2,
      y: size.h / 2 + offset.y - height / 2,
      width,
      height,
    }
  }, [natural, size, baseScale, zoom, offset])

  const clampOffset = React.useCallback(
    (o: CropOffset): CropOffset => ({
      x: clamp(o.x, -(size?.w ?? 0) / 2, (size?.w ?? 0) / 2),
      y: clamp(o.y, -(size?.h ?? 0) / 2, (size?.h ?? 0) / 2),
    }),
    [size],
  )

  // 几何变化 → 裁剪框重锚定（跟随图片上同一块区域）
  const lastRectRef = React.useRef<ImageRect | null>(null)
  React.useEffect(() => {
    const last = lastRectRef.current
    lastRectRef.current = imageRect
    const c = cropRef.current
    if (!imageRect || !last || sameRect(last, imageRect) || !c) return
    const sx = imageRect.width / last.width
    const sy = imageRect.height / last.height
    onCropChangeRef.current(
      clampBox(
        {
          x: imageRect.x + (c.x - last.x) * sx,
          y: imageRect.y + (c.y - last.y) * sy,
          width: c.width * sx,
          height: c.height * sy,
        },
        imageRect,
      ),
    )
  }, [imageRect])

  // 图片就绪且尚无框时，初始化默认框（居中 80%，含比例约束）
  const hasCrop = crop != null
  React.useEffect(() => {
    if (!imageRect || hasCrop) return
    const r = imageRect
    let width = r.width * 0.8
    let height = r.height * 0.8
    if (aspect) {
      width = Math.min(width, height * aspect)
      height = width / aspect
    }
    onCropChangeRef.current(
      clampBox({ x: r.x + (r.width - width) / 2, y: r.y + (r.height - height) / 2, width, height }, r),
    )
  }, [imageRect, hasCrop, aspect])

  // 切换比例 chip：围绕中心把现有框调整为新比例
  const prevAspectRef = React.useRef(aspect)
  React.useEffect(() => {
    if (prevAspectRef.current === aspect) return
    prevAspectRef.current = aspect
    const c = cropRef.current
    if (!imageRect || !c || !aspect) return
    const r = imageRect
    let width = c.width
    let height = width / aspect
    if (height > r.height) {
      height = r.height
      width = height * aspect
    }
    const cx = c.x + c.width / 2
    const cy = c.y + c.height / 2
    onCropChangeRef.current(clampBox({ x: cx - width / 2, y: cy - height / 2, width, height }, r))
  }, [aspect, imageRect])

  // 显示坐标 → 原图坐标（考虑缩放与位移），提交给 /api/ocr
  React.useEffect(() => {
    if (!onCropNaturalRef.current || !crop || !imageRect || !natural || !baseScale) return
    const scale = baseScale * zoom
    onCropNaturalRef.current({
      x: (crop.x - imageRect.x) / scale,
      y: (crop.y - imageRect.y) / scale,
      width: crop.width / scale,
      height: crop.height / scale,
    })
  }, [crop, imageRect, natural, baseScale, zoom])

  // ---------- pointer 交互 ----------
  const pointersRef = React.useRef(new Map<number, CropOffset>())
  const dragRef = React.useRef<
    | null
    | {
        kind: 'pan' | 'box' | 'resize'
        handle?: HandleId
        startX: number
        startY: number
        origBox: CropBox
        origOffset: CropOffset
      }
  >(null)
  const pinchRef = React.useRef<null | { dist: number; zoom: number; mid: CropOffset; offset: CropOffset }>(null)

  const getPos = (e: React.PointerEvent): CropOffset => {
    const rect = containerRef.current?.getBoundingClientRect()
    return rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : { x: 0, y: 0 }
  }

  const endInteraction = () => {
    dragRef.current = null
    pinchRef.current = null
    setDragKind(null)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled || !imageRect) return
    e.preventDefault()
    const pos = getPos(e)
    pointersRef.current.set(e.pointerId, pos)
    try {
      containerRef.current?.setPointerCapture(e.pointerId)
    } catch {
      // 指针可能已释放，忽略
    }
    if (pointersRef.current.size === 2) {
      // 双指捏合开始：取消单指拖拽
      dragRef.current = null
      const [a, b] = [...pointersRef.current.values()]
      pinchRef.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        zoom,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        offset: { ...offset },
      }
      setDragKind('pinch')
      return
    }
    if (pointersRef.current.size > 2 || pinchRef.current) return

    const handle = (e.target as HTMLElement)
      .closest('[data-handle]')
      ?.getAttribute('data-handle') as HandleId | null
    const c = cropRef.current
    if (handle && c) {
      dragRef.current = { kind: 'resize', handle, startX: pos.x, startY: pos.y, origBox: c, origOffset: offset }
      setDragKind('resize')
    } else if (c && pos.x >= c.x && pos.x <= c.x + c.width && pos.y >= c.y && pos.y <= c.y + c.height) {
      dragRef.current = { kind: 'box', startX: pos.x, startY: pos.y, origBox: c, origOffset: offset }
      setDragKind('box')
    } else {
      dragRef.current = {
        kind: 'pan',
        startX: pos.x,
        startY: pos.y,
        origBox: c ?? { x: 0, y: 0, width: 0, height: 0 },
        origOffset: offset,
      }
      setDragKind('pan')
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (disabled || !pointersRef.current.has(e.pointerId)) return
    const pos = getPos(e)
    pointersRef.current.set(e.pointerId, pos)

    // 双指捏合：缩放 + 中点平移
    const pinch = pinchRef.current
    if (pinch && pointersRef.current.size >= 2) {
      const [a, b] = [...pointersRef.current.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      onZoomChange?.(clamp(pinch.zoom * (dist / pinch.dist), 1, MAX_CROP_ZOOM))
      onOffsetChange?.(
        clampOffset({
          x: pinch.offset.x + (mid.x - pinch.mid.x),
          y: pinch.offset.y + (mid.y - pinch.mid.y),
        }),
      )
      return
    }

    const d = dragRef.current
    if (!d || !imageRect) return
    if (d.kind === 'pan') {
      onOffsetChange?.(
        clampOffset({
          x: d.origOffset.x + (pos.x - d.startX),
          y: d.origOffset.y + (pos.y - d.startY),
        }),
      )
    } else if (d.kind === 'box') {
      const c = d.origBox
      onCropChangeRef.current(
        clampBox(
          { x: c.x + (pos.x - d.startX), y: c.y + (pos.y - d.startY), width: c.width, height: c.height },
          imageRect,
        ),
      )
    } else if (d.handle) {
      onCropChangeRef.current(resizeBox(d.origBox, d.handle, pos.x, pos.y, imageRect, aspect))
    }
  }

  const onPointerEnd = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId)
    if (pointersRef.current.size < 2) pinchRef.current = null
    if (pointersRef.current.size === 0) endInteraction()
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative touch-none select-none overflow-hidden bg-black',
        dragKind === 'pan' ? 'cursor-grabbing' : 'cursor-grab',
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      {natural && baseScale > 0 && (
        <img
          src={src}
          alt=""
          draggable={false}
          className="pointer-events-none absolute left-1/2 top-1/2 max-w-none"
          style={{
            width: natural.w * baseScale,
            height: natural.h * baseScale,
            transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${zoom})`,
          }}
        />
      )}

      {crop && (
        <div
          className="absolute cursor-move border-[1.5px] border-white/90"
          style={{
            left: crop.x,
            top: crop.y,
            width: crop.width,
            height: crop.height,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
          }}
        >
          {grid && (
            <>
              <div className="absolute inset-y-0 left-1/3 w-px bg-white/40" />
              <div className="absolute inset-y-0 left-2/3 w-px bg-white/40" />
              <div className="absolute inset-x-0 top-1/3 h-px bg-white/40" />
              <div className="absolute inset-x-0 top-2/3 h-px bg-white/40" />
            </>
          )}
          {HANDLES.map((id) => (
            <div
              key={id}
              data-handle={id}
              className="absolute z-10 size-3 -translate-x-1/2 -translate-y-1/2 rounded-[3px] border-2 border-white bg-emerald-500 shadow-md"
              style={HANDLE_STYLE[id]}
            />
          ))}
        </div>
      )}
    </div>
  )
}
