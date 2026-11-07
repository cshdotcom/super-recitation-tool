'use client'

import * as React from 'react'
import { Eraser } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { Stroke } from '@/lib/types'

interface DoodleCanvasProps {
  strokes: Stroke[]
  onStrokesChange: (strokes: Stroke[]) => void
  /** When true, the canvas accepts pointer input (涂鸦 mode active). */
  active: boolean
}

// Absolute-inset canvas overlay for the content area. Strokes are stored as
// normalized [x,y] points (0..1) so they survive resizes and are persisted
// to the backend via the parent's debounced card PATCH.
export function DoodleCanvas({ strokes, onStrokesChange, active }: DoodleCanvasProps) {
  const wrapRef = React.useRef<HTMLDivElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const drawingRef = React.useRef(false)
  const currentRef = React.useRef<Stroke>([])
  const [hasStrokes, setHasStrokes] = React.useState(strokes.length > 0)

  React.useEffect(() => {
    setHasStrokes(strokes.length > 0)
  }, [strokes])

  const strokeColor = React.useCallback(() => {
    const dark = document.documentElement.classList.contains('dark')
    return dark ? '#e4e4e7' : '#18181b'
  }, [])

  const redraw = React.useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const rect = wrap.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, rect.width, rect.height)
    ctx.lineWidth = 3
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = strokeColor()
    const all = currentRef.current.length > 0 ? [...strokes, currentRef.current] : strokes
    for (const stroke of all) {
      if (stroke.length === 0) continue
      if (stroke.length === 1) {
        // single tap -> dot
        const [x, y] = stroke[0]
        ctx.beginPath()
        ctx.arc(x * rect.width, y * rect.height, 1.5, 0, Math.PI * 2)
        ctx.fillStyle = strokeColor()
        ctx.fill()
        continue
      }
      ctx.beginPath()
      stroke.forEach(([x, y], i) => {
        const px = x * rect.width
        const py = y * rect.height
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      })
      ctx.stroke()
    }
  }, [strokes, strokeColor])

  // Redraw on mount, strokes change, and container resize.
  React.useEffect(() => {
    redraw()
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => redraw())
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [redraw])

  const pointFrom = (e: React.PointerEvent): [number, number] => {
    const rect = wrapRef.current!.getBoundingClientRect()
    return [
      Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    ]
  }

  const handleDown = (e: React.PointerEvent) => {
    if (!active) return
    e.preventDefault()
    drawingRef.current = true
    currentRef.current = [pointFrom(e)]
    redraw()
  }

  const handleMove = (e: React.PointerEvent) => {
    if (!active || !drawingRef.current) return
    e.preventDefault()
    currentRef.current.push(pointFrom(e))
    redraw()
  }

  const handleUp = () => {
    if (!active || !drawingRef.current) return
    drawingRef.current = false
    const stroke = currentRef.current
    currentRef.current = []
    if (stroke.length > 0) {
      onStrokesChange([...strokes, stroke])
    } else {
      redraw()
    }
  }

  return (
    <div
      ref={wrapRef}
      className={cn(
        'absolute inset-0 z-[5]',
        active ? 'pointer-events-auto cursor-crosshair touch-none' : 'pointer-events-none',
      )}
      aria-hidden={!active}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerLeave={handleUp}
        onPointerCancel={handleUp}
      />
      {hasStrokes && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onStrokesChange([])
          }}
          className="absolute right-2 top-2 flex items-center gap-1 rounded-full border border-border bg-background/90 px-3 py-1.5 text-xs text-muted-foreground shadow-md transition-colors hover:text-destructive"
          aria-label="清除涂鸦"
        >
          <Eraser className="size-3.5" strokeWidth={1.75} />
          清除涂鸦
        </button>
      )}
    </div>
  )
}
