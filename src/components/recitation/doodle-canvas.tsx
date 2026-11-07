'use client'

import * as React from 'react'
import {
  Brush,
  Eraser,
  Highlighter,
  Palette,
  Pencil,
  PenTool,
  Redo2,
  Trash2,
  Undo2,
  type LucideIcon,
} from 'lucide-react'

import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'
import {
  isDoodleStroke,
  type DoodleStroke,
  type DoodleTool,
  type Point,
  type Stroke,
} from '@/lib/types'

interface DoodleCanvasProps {
  strokes: Stroke[]
  onStrokesChange: (strokes: Stroke[]) => void
  /** When true, the canvas accepts pointer input (涂鸦 mode active). */
  active: boolean
}

// Ink used for legacy strokes (plain point arrays) — dark-mode aware.
const LIGHT_INK = '#18181b'
const DARK_INK = '#e4e4e7'
const LEGACY_WIDTH = 3
// Pointer spacing (px) at/below which a brush segment counts as "slow" (thick).
const BRUSH_SLOW_SPACING = 6
const PENCIL_JITTER: [number, number][] = [
  [-0.5, 0.4],
  [0.5, -0.4],
]
// 8 preset swatches; the first is the theme-aware default ink.
const WHEEL_GRADIENT =
  'conic-gradient(#ef4444,#f97316,#eab308,#22c55e,#14b8a6,#3b82f6,#a855f7,#ec4899,#ef4444)'

const TOOLS: { key: DoodleTool; label: string; icon: LucideIcon }[] = [
  { key: 'pen', label: '钢笔', icon: PenTool },
  { key: 'pencil', label: '铅笔', icon: Pencil },
  { key: 'marker', label: '荧光笔', icon: Highlighter },
  { key: 'brush', label: '毛笔', icon: Brush },
  { key: 'eraser', label: '橡皮', icon: Eraser },
]

function systemInk(): string {
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('dark')) {
    return DARK_INK
  }
  return LIGHT_INK
}

// ---------- stroke rendering ----------

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, w: number, h: number, ink: string) {
  const pts: Point[] = isDoodleStroke(s) ? s.pts : s
  const tool: DoodleTool = isDoodleStroke(s) ? s.tool : 'pen'
  const color = isDoodleStroke(s) ? s.color : ink
  const width = Math.max(1, isDoodleStroke(s) ? s.width : LEGACY_WIDTH)
  if (pts.length === 0) return

  const dot = (p: Point, r: number) => {
    ctx.beginPath()
    ctx.arc(p[0] * w, p[1] * h, r, 0, Math.PI * 2)
    ctx.fill()
  }
  const polyline = () => {
    ctx.beginPath()
    for (let i = 0; i < pts.length; i++) {
      const px = pts[i][0] * w
      const py = pts[i][1] * h
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.stroke()
  }

  ctx.save()
  try {
    if (tool === 'eraser') {
      // Punch through everything drawn so far (strokes redraw in order each frame).
      ctx.globalCompositeOperation = 'destination-out'
      ctx.strokeStyle = '#000'
      ctx.fillStyle = '#000'
      ctx.lineWidth = width * 2.5
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      if (pts.length === 1) dot(pts[0], (width * 2.5) / 2)
      else polyline()
      return
    }

    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineJoin = 'round'

    if (tool === 'brush') {
      // Variable width by speed: only points are stored — spacing proxies speed
      // (closer points → slower → thicker line).
      ctx.lineCap = 'round'
      ctx.globalAlpha = 1
      if (pts.length === 1) {
        ctx.lineWidth = width
        dot(pts[0], width / 2)
        return
      }
      for (let i = 1; i < pts.length; i++) {
        const dx = (pts[i][0] - pts[i - 1][0]) * w
        const dy = (pts[i][1] - pts[i - 1][1]) * h
        const speed = Math.min(1, Math.hypot(dx, dy) / BRUSH_SLOW_SPACING)
        ctx.lineWidth = Math.max(0.8, width * (1.4 - 1.05 * speed))
        ctx.beginPath()
        ctx.moveTo(pts[i - 1][0] * w, pts[i - 1][1] * h)
        ctx.lineTo(pts[i][0] * w, pts[i][1] * h)
        ctx.stroke()
      }
      return
    }

    const eff = tool === 'pencil' ? width * 0.6 : tool === 'marker' ? width * 2.2 : width
    ctx.lineWidth = eff
    ctx.lineCap = tool === 'marker' ? 'butt' : 'round'
    // Marker stays translucent so the text below the transparent canvas shows through.
    ctx.globalAlpha = tool === 'pencil' ? 0.85 : tool === 'marker' ? 0.3 : 1
    if (pts.length === 1) {
      dot(pts[0], eff / 2)
      return
    }
    polyline()
    if (tool === 'pencil') {
      // Grainy texture: two slightly offset overlay passes.
      ctx.globalAlpha = 0.35
      for (const [jx, jy] of PENCIL_JITTER) {
        ctx.save()
        ctx.translate(jx, jy)
        polyline()
        ctx.restore()
      }
    }
  } finally {
    ctx.restore()
  }
}

// ---------- history helpers (tolerate the debounced server-save echo) ----------

function strokeEquals(a: Stroke, b: Stroke): boolean {
  const aStyled = isDoodleStroke(a)
  const bStyled = isDoodleStroke(b)
  if (aStyled !== bStyled) return false
  if (aStyled && bStyled && (a.tool !== b.tool || a.color !== b.color || a.width !== b.width)) {
    return false
  }
  const pa = aStyled ? a.pts : a
  const pb = bStyled ? b.pts : b
  if (pa.length !== pb.length) return false
  for (let i = 0; i < pa.length; i++) {
    if (pa[i][0] !== pb[i][0] || pa[i][1] !== pb[i][1]) return false
  }
  return true
}

function strokesArraysEqual(a: Stroke[] | null, b: Stroke[]): boolean {
  if (a === b) return true
  if (a === null || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!strokeEquals(a[i], b[i])) return false
  }
  return true
}

// Absolute-inset canvas overlay for the content area. Strokes are stored as
// normalized [x,y] points (0..1) so they survive resizes and are persisted
// to the backend via the parent's debounced card PATCH. A pill toolbar with
// tool/color/width controls and undo/redo/clear renders while `active`.
export function DoodleCanvas({ strokes, onStrokesChange, active }: DoodleCanvasProps) {
  const wrapRef = React.useRef<HTMLDivElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const drawingRef = React.useRef(false)
  const currentRef = React.useRef<DoodleStroke | null>(null)
  const rafRef = React.useRef(0)

  // Undo/redo history: snapshots of the strokes array before each local change.
  const undoStackRef = React.useRef<Stroke[][]>([])
  const redoStackRef = React.useRef<Stroke[]>([])
  const emittedRef = React.useRef<Stroke[] | null>(null)
  const [redoDepth, setRedoDepth] = React.useState(0)

  // Tool settings.
  const [tool, setTool] = React.useState<DoodleTool>('pen')
  const [color, setColor] = React.useState(LIGHT_INK)
  const [width, setWidth] = React.useState(4)

  const darkInk = React.useCallback(() => systemInk(), [])

  // Adopt the theme-appropriate default ink once mounted (SSR safe).
  React.useEffect(() => {
    setColor(darkInk())
  }, [darkInk])

  const presetColors = React.useMemo(
    () => [systemInk(), '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#ec4899'],
    [],
  )
  const isCustomColor = !presetColors.includes(color)

  const emit = (next: Stroke[]) => {
    emittedRef.current = next
    onStrokesChange(next)
  }

  const redraw = React.useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const rect = wrap.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const cw = Math.max(1, Math.round(rect.width * dpr))
    const ch = Math.max(1, Math.round(rect.height * dpr))
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw
      canvas.height = ch
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, rect.width, rect.height)
    const ink = darkInk()
    const all: Stroke[] = currentRef.current ? [...strokes, currentRef.current] : strokes
    for (const s of all) drawStroke(ctx, s, rect.width, rect.height, ink)
  }, [strokes, darkInk])

  // Coalesce pointermove bursts into one redraw per animation frame.
  const scheduleRedraw = React.useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      redraw()
    })
  }, [redraw])

  // Redraw on mount, strokes change, and container resize.
  React.useEffect(() => {
    redraw()
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => redraw())
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [redraw])

  // Follow dark-mode toggles so legacy strokes stay visible.
  React.useEffect(() => {
    const el = document.documentElement
    const mo = new MutationObserver(() => redraw())
    mo.observe(el, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [redraw])

  React.useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // External strokes changes (server-save echo of our own emit is tolerated)
  // invalidate the undo/redo history.
  React.useEffect(() => {
    if (emittedRef.current === strokes) return
    if (strokesArraysEqual(emittedRef.current, strokes)) return
    undoStackRef.current = []
    redoStackRef.current = []
    setRedoDepth(0)
  }, [strokes])

  // ---------- undo / redo / clear ----------

  const addStroke = (s: DoodleStroke) => {
    undoStackRef.current.push(strokes)
    redoStackRef.current = []
    setRedoDepth(0)
    emit([...strokes, s])
  }

  // Keep a ref to the latest addStroke so mode-exit cleanup can commit safely.
  const commitRef = React.useRef(addStroke)
  React.useEffect(() => {
    commitRef.current = addStroke
  })

  const undo = () => {
    if (strokes.length === 0) return
    const removed = strokes[strokes.length - 1]
    const next =
      undoStackRef.current.length > 0 ? undoStackRef.current.pop()! : strokes.slice(0, -1)
    redoStackRef.current.push(removed)
    setRedoDepth(redoStackRef.current.length)
    emit(next)
  }

  const redo = () => {
    const s = redoStackRef.current.pop()
    if (!s) return
    setRedoDepth(redoStackRef.current.length)
    undoStackRef.current.push(strokes)
    emit([...strokes, s])
  }

  const clearAll = () => {
    undoStackRef.current = []
    redoStackRef.current = []
    setRedoDepth(0)
    if (strokes.length > 0) emit([])
    else scheduleRedraw()
  }

  // ---------- pointer input ----------

  const pointFromClient = (clientX: number, clientY: number): Point => {
    const rect = wrapRef.current!.getBoundingClientRect()
    return [
      Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    ]
  }

  const pushPoint = (clientX: number, clientY: number) => {
    const cur = currentRef.current
    if (!cur) return
    const p = pointFromClient(clientX, clientY)
    const last = cur.pts[cur.pts.length - 1]
    if (last && last[0] === p[0] && last[1] === p[1]) return
    cur.pts.push(p)
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!active || drawingRef.current) return
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // setPointerCapture can throw for already-released pointers; ignore.
    }
    drawingRef.current = true
    currentRef.current = { pts: [pointFromClient(e.clientX, e.clientY)], color, width, tool }
    scheduleRedraw()
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!active || !drawingRef.current || !currentRef.current) return
    e.preventDefault()
    const native = e.nativeEvent
    // Coalesced events give smooth high-frequency strokes on supporting browsers.
    const coalesced =
      typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : []
    if (coalesced.length > 0) {
      for (const ce of coalesced) pushPoint(ce.clientX, ce.clientY)
    } else {
      pushPoint(e.clientX, e.clientY)
    }
    scheduleRedraw()
  }

  const handlePointerUp = () => {
    if (!drawingRef.current) return
    drawingRef.current = false
    const cur = currentRef.current
    currentRef.current = null
    if (cur && cur.pts.length > 0) addStroke(cur)
    else scheduleRedraw()
  }

  const handlePointerCancel = () => {
    if (!drawingRef.current) return
    drawingRef.current = false
    currentRef.current = null
    scheduleRedraw()
  }

  // Commit (or drop) an in-progress stroke if doodle mode exits mid-draw.
  React.useEffect(() => {
    if (active || !drawingRef.current) return
    drawingRef.current = false
    const cur = currentRef.current
    currentRef.current = null
    if (cur && cur.pts.length > 0) commitRef.current(cur)
    else redraw()
  }, [active, redraw])

  // ---------- toolbar ----------

  const previewSize = tool === 'eraser' ? Math.min(width * 2.5, 24) : Math.min(width, 22)
  const canUndo = strokes.length > 0
  const canRedo = redoDepth > 0

  return (
    <div
      ref={wrapRef}
      className={cn(
        // z-30 while active: the toolbar inside must paint above the sticky
        // quick-chips bar (z-20). z-[5] keeps it under text UI when idle.
        active ? 'z-30' : 'z-[5]',
        'absolute inset-0',
        active ? 'pointer-events-auto select-none' : 'pointer-events-none',
      )}
      aria-hidden={!active}
    >
      <canvas
        ref={canvasRef}
        className={cn('absolute inset-0 h-full w-full', active && 'cursor-crosshair touch-none')}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handlePointerUp}
      />

      {active && (
        <div className="absolute inset-x-2 bottom-2 z-20 rounded-2xl border border-border bg-background/95 p-2 shadow-xl backdrop-blur">
          {/* Row 1: tools | undo/redo | clear */}
          <div className="no-scrollbar flex items-center gap-0.5 overflow-x-auto" role="toolbar" aria-label="涂鸦工具">
            {TOOLS.map((t) => {
              const Icon = t.icon
              const isActive = tool === t.key
              return (
                <button
                  key={t.key}
                  type="button"
                  aria-pressed={isActive}
                  title={t.label}
                  onClick={() => setTool(t.key)}
                  className={cn(
                    'flex w-11 shrink-0 flex-col items-center gap-0.5 rounded-xl py-1 text-[10px] transition-colors',
                    isActive
                      ? 'bg-emerald-500/10 text-emerald-600'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  <Icon className="size-4" strokeWidth={1.75} />
                  {t.label}
                </button>
              )
            })}
            <div className="mx-1 h-6 w-px shrink-0 bg-border" aria-hidden="true" />
            <button
              type="button"
              aria-label="撤销"
              title="撤销"
              disabled={!canUndo}
              onClick={undo}
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
            >
              <Undo2 className="size-4" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              aria-label="重做"
              title="重做"
              disabled={!canRedo}
              onClick={redo}
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
            >
              <Redo2 className="size-4" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              aria-label="清空涂鸦"
              title="清空涂鸦"
              disabled={!canUndo}
              onClick={clearAll}
              className="ml-auto flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-35"
            >
              <Trash2 className="size-3.5" strokeWidth={1.75} />
              清空
            </button>
          </div>

          {/* Row 2: preset colors + custom color wheel */}
          <div className="no-scrollbar mt-1.5 flex items-center gap-1.5 overflow-x-auto px-1" role="toolbar" aria-label="涂鸦颜色">
            {presetColors.map((c, i) => (
              <button
                key={c}
                type="button"
                aria-label={i === 0 ? '默认墨色' : `颜色 ${c}`}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className={cn(
                  'size-5 shrink-0 rounded-full border border-black/10 shadow-sm transition-transform dark:border-white/25',
                  color === c ? 'scale-110 ring-2 ring-emerald-600 ring-offset-1 ring-offset-background' : 'hover:scale-110',
                )}
                style={{ backgroundColor: c }}
              />
            ))}
            <div className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden="true" />
            <div className="relative size-6 shrink-0">
              <span
                aria-hidden="true"
                className={cn(
                  'flex size-6 items-center justify-center rounded-full text-white shadow-sm',
                  isCustomColor && 'ring-2 ring-emerald-600 ring-offset-1 ring-offset-background',
                )}
                style={{ background: WHEEL_GRADIENT }}
              >
                <Palette className="size-3.5 drop-shadow" strokeWidth={1.75} />
              </span>
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                aria-label="自定义颜色"
                className="absolute inset-0 size-full cursor-pointer opacity-0"
              />
            </div>
          </div>

          {/* Row 3: width slider + live preview dot */}
          <div className="mt-1.5 flex items-center gap-2 px-1">
            <span className="shrink-0 text-[11px] text-muted-foreground">粗细</span>
            <Slider
              value={[width]}
              min={2}
              max={24}
              step={1}
              onValueChange={(v) => setWidth(v[0] ?? 4)}
              className="min-w-0 flex-1"
              aria-label="笔画粗细"
            />
            <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
              {width}
            </span>
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border"
            >
              <span
                className={cn(
                  'rounded-full',
                  tool === 'eraser' && 'border border-dashed border-muted-foreground',
                )}
                style={{
                  width: previewSize,
                  height: previewSize,
                  backgroundColor: tool === 'eraser' ? undefined : color,
                }}
              />
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
