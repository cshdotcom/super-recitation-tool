'use client'

// SvgVisualEditor — SVG 可视化编辑器（形状面板 + 画布 + 属性栏）。
// 能力：
//   • 形状面板：矩形 / 圆 / 椭圆 / 直线 / 箭头（带 marker）/ 文字，点击添加
//   • 画布（固定 viewBox，默认 600x400）：点选元素 → 选中高亮 → 拖动移动（pointer
//     events，支持触摸）；矩形/椭圆/圆：角点手柄 resize；直线/箭头：端点手柄；
//     文字：选中后侧栏编辑文本 + 字号（双击聚焦输入框）
//   • 属性栏：填充色 / 描边色（8 色盘 + 取色器 + 无色）、描边粗细
//   • 删除选中（按钮 + Delete/Backspace 键）
//   • 双向同步：切到可视化时用 DOMParser 解析现有 SVG 源码；能识别的
//     rect/circle/ellipse/line/text/简单 path 载入画布；识别不了的元素（复杂
//     path、g、polygon、滤镜…）保留为「原始元素」随导出原样带回（不丢内容）；
//     源码改动后切回可视化自动重载。

import * as React from 'react'
import {
  ArrowRight,
  Circle as CircleIcon,
  Minus,
  Square,
  Trash2,
  Type as TypeIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'

// ---------- 数据模型 ----------

interface ShapeCommon {
  id: string
  fill: string
  stroke: string
  strokeWidth: number
}

export type SvgShape =
  | (ShapeCommon & { kind: 'rect'; x: number; y: number; w: number; h: number })
  | (ShapeCommon & { kind: 'circle'; cx: number; cy: number; r: number })
  | (ShapeCommon & { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number })
  | (ShapeCommon & {
      kind: 'line'
      x1: number
      y1: number
      x2: number
      y2: number
      arrow: boolean
    })
  | (ShapeCommon & { kind: 'text'; x: number; y: number; text: string; size: number })

interface SvgDoc {
  width: number
  height: number
  shapes: SvgShape[]
  /** 识别不了的元素原样保留（导出时随输出带回） */
  raw: string[]
  parseError: string | null
}

const DEFAULT_DOC: SvgDoc = { width: 600, height: 400, shapes: [], raw: [], parseError: null }

// ---------- 源码解析 ----------

let shapeSeq = 0
const nextShapeId = (kind: string) => `el-${kind}-${Date.now().toString(36)}-${++shapeSeq}`

function numAttr(el: Element, name: string): number | null {
  const v = parseFloat(el.getAttribute(name) || '')
  return Number.isFinite(v) ? v : null
}

function colorAttr(el: Element, name: string, fallback: string): string {
  const v = el.getAttribute(name)
  return v && v.trim() !== '' ? v.trim() : fallback
}

/** 识别一个 SVG 子元素 → 可编辑形状；识别不了返回 null（上层归入「原始元素」）。 */
function recognizeShape(el: Element): SvgShape | null {
  const tag = el.tagName.toLowerCase()
  const stroke = colorAttr(el, 'stroke', 'none')
  const strokeWidth = numAttr(el, 'stroke-width') ?? 1
  switch (tag) {
    case 'rect': {
      // 圆角矩形保留原样（rx/ry 属于内容，编辑器不支持，避免丢失）
      if (numAttr(el, 'rx') != null || numAttr(el, 'ry') != null) return null
      const x = numAttr(el, 'x') ?? 0
      const y = numAttr(el, 'y') ?? 0
      const w = numAttr(el, 'width')
      const h = numAttr(el, 'height')
      if (w == null || h == null || w < 0 || h < 0) return null
      return {
        id: nextShapeId('rect'),
        kind: 'rect',
        x,
        y,
        w,
        h,
        fill: colorAttr(el, 'fill', '#000000'),
        stroke,
        strokeWidth,
      }
    }
    case 'circle': {
      const cx = numAttr(el, 'cx')
      const cy = numAttr(el, 'cy')
      const r = numAttr(el, 'r')
      if (cx == null || cy == null || r == null || r < 0) return null
      return {
        id: nextShapeId('circle'),
        kind: 'circle',
        cx,
        cy,
        r,
        fill: colorAttr(el, 'fill', '#000000'),
        stroke,
        strokeWidth,
      }
    }
    case 'ellipse': {
      const cx = numAttr(el, 'cx')
      const cy = numAttr(el, 'cy')
      const rx = numAttr(el, 'rx')
      const ry = numAttr(el, 'ry')
      if (cx == null || cy == null || rx == null || ry == null || rx < 0 || ry < 0) return null
      return {
        id: nextShapeId('ellipse'),
        kind: 'ellipse',
        cx,
        cy,
        rx,
        ry,
        fill: colorAttr(el, 'fill', '#000000'),
        stroke,
        strokeWidth,
      }
    }
    case 'line': {
      const x1 = numAttr(el, 'x1')
      const y1 = numAttr(el, 'y1')
      const x2 = numAttr(el, 'x2')
      const y2 = numAttr(el, 'y2')
      if (x1 == null || y1 == null || x2 == null || y2 == null) return null
      return {
        id: nextShapeId('line'),
        kind: 'line',
        x1,
        y1,
        x2,
        y2,
        arrow: !!el.getAttribute('marker-end'),
        fill: 'none',
        stroke: stroke === 'none' ? '#000000' : stroke,
        strokeWidth,
      }
    }
    case 'text': {
      if (el.querySelector('tspan')) return null // 带 tspan 定位的文字 → 原样保留
      const x = numAttr(el, 'x') ?? 0
      const y = numAttr(el, 'y') ?? 0
      const text = (el.textContent || '').trim()
      if (!text) return null
      return {
        id: nextShapeId('text'),
        kind: 'text',
        x,
        y,
        text,
        size: numAttr(el, 'font-size') ?? 16,
        fill: colorAttr(el, 'fill', '#000000'),
        stroke: 'none',
        strokeWidth: 0,
      }
    }
    case 'path': {
      // 仅识别两点直线 M x y L x y（可编辑为直线），复杂路径 → 原样保留
      const d = (el.getAttribute('d') || '').trim()
      const m = d.match(/^M\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s+L\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*$/i)
      if (!m) return null
      return {
        id: nextShapeId('line'),
        kind: 'line',
        x1: parseFloat(m[1]),
        y1: parseFloat(m[2]),
        x2: parseFloat(m[3]),
        y2: parseFloat(m[4]),
        arrow: !!el.getAttribute('marker-end'),
        fill: 'none',
        stroke: colorAttr(el, 'stroke', '#000000'),
        strokeWidth: numAttr(el, 'stroke-width') ?? 1,
      }
    }
    default:
      return null
  }
}

/** SVG 源码 → 画布文档（DOMParser；解析失败给空画布 + 错误提示，不抛异常）。 */
function parseSvgCode(code: string): SvgDoc {
  if (!code.trim()) return { ...DEFAULT_DOC }
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(code, 'image/svg+xml')
  } catch {
    return { ...DEFAULT_DOC, parseError: 'SVG 源码无法解析，画布从空白开始' }
  }
  const root = doc.documentElement
  if (
    root.tagName.toLowerCase() === 'parsererror' ||
    doc.querySelector('parsererror') ||
    root.tagName.toLowerCase() !== 'svg'
  ) {
    return { ...DEFAULT_DOC, parseError: 'SVG 源码无法解析，画布从空白开始（原源码仍在「源码」页，未应用前不会丢失）' }
  }
  const out: SvgDoc = { width: 600, height: 400, shapes: [], raw: [], parseError: null }
  const vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number)
  if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) {
    out.width = Math.round(vb[2])
    out.height = Math.round(vb[3])
  } else {
    const w = numAttr(root, 'width')
    const h = numAttr(root, 'height')
    if (w != null && h != null && w > 0 && h > 0) {
      out.width = Math.round(w)
      out.height = Math.round(h)
    }
  }
  for (const el of Array.from(root.children)) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'defs') {
      // 非本编辑器生成的 defs（渐变/滤镜/自定义 marker）原样保留，导出带回
      if ((el.innerHTML || '').trim() !== '') out.raw.push(el.outerHTML)
      continue
    }
    const shape = recognizeShape(el)
    if (shape) out.shapes.push(shape)
    else out.raw.push(el.outerHTML)
  }
  return out
}

// ---------- 源码生成 ----------

const escXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const fmt = (n: number) => String(Math.round(n * 10) / 10)

function fillAttrs(s: SvgShape): string {
  if (s.kind === 'line') return ' fill="none"'
  if (s.kind === 'text') return ` fill="${s.fill}"`
  return ` fill="${s.fill}"`
}

function strokeAttrs(s: SvgShape): string {
  if (s.stroke === 'none' || s.strokeWidth <= 0) return ''
  return ` stroke="${s.stroke}" stroke-width="${fmt(s.strokeWidth)}"`
}

/** 画布文档 → 干净 SVG 源码（原始元素原样带回）。 */
function serializeSvgDoc(doc: SvgDoc): string {
  const lines: string[] = []
  const arrowStrokes = Array.from(
    new Set(
      doc.shapes.filter((s) => s.kind === 'line' && s.arrow).map((s) => s.stroke),
    ),
  )
  if (arrowStrokes.length > 0) {
    lines.push('  <defs>')
    for (const c of arrowStrokes) {
      const id = `svgedit-arrow-${c.replace(/[^a-zA-Z0-9]/g, '')}`
      lines.push(
        `    <marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${escXml(c)}"/></marker>`,
      )
    }
    lines.push('  </defs>')
  }
  if (doc.raw.length > 0) {
    lines.push('  <!-- 复杂元素以源码保留 -->')
    for (const r of doc.raw) lines.push(`  ${r}`)
  }
  for (const s of doc.shapes) {
    switch (s.kind) {
      case 'rect':
        lines.push(
          `  <rect x="${fmt(s.x)}" y="${fmt(s.y)}" width="${fmt(s.w)}" height="${fmt(s.h)}"${fillAttrs(s)}${strokeAttrs(s)}/>`,
        )
        break
      case 'circle':
        lines.push(
          `  <circle cx="${fmt(s.cx)}" cy="${fmt(s.cy)}" r="${fmt(s.r)}"${fillAttrs(s)}${strokeAttrs(s)}/>`,
        )
        break
      case 'ellipse':
        lines.push(
          `  <ellipse cx="${fmt(s.cx)}" cy="${fmt(s.cy)}" rx="${fmt(s.rx)}" ry="${fmt(s.ry)}"${fillAttrs(s)}${strokeAttrs(s)}/>`,
        )
        break
      case 'line':
        lines.push(
          `  <line x1="${fmt(s.x1)}" y1="${fmt(s.y1)}" x2="${fmt(s.x2)}" y2="${fmt(s.y2)}"${strokeAttrs(s)} fill="none"${s.arrow ? ` marker-end="url(#svgedit-arrow-${s.stroke.replace(/[^a-zA-Z0-9]/g, '')})"` : ''}/>`,
        )
        break
      case 'text':
        lines.push(
          `  <text x="${fmt(s.x)}" y="${fmt(s.y)}" font-size="${fmt(s.size)}"${fillAttrs(s)}>${escXml(s.text)}</text>`,
        )
        break
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${doc.width} ${doc.height}" width="${doc.width}" height="${doc.height}">\n${lines.join('\n')}\n</svg>`
}

// ---------- 几何工具 ----------

function translateShape(s: SvgShape, dx: number, dy: number): SvgShape {
  switch (s.kind) {
    case 'rect':
      return { ...s, x: s.x + dx, y: s.y + dy }
    case 'circle':
      return { ...s, cx: s.cx + dx, cy: s.cy + dy }
    case 'ellipse':
      return { ...s, cx: s.cx + dx, cy: s.cy + dy }
    case 'line':
      return { ...s, x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy }
    case 'text':
      return { ...s, x: s.x + dx, y: s.y + dy }
  }
}

function shapeBBox(s: SvgShape): { x: number; y: number; w: number; h: number } {
  switch (s.kind) {
    case 'rect':
      return { x: s.x, y: s.y, w: s.w, h: s.h }
    case 'circle':
      return { x: s.cx - s.r, y: s.cy - s.r, w: s.r * 2, h: s.r * 2 }
    case 'ellipse':
      return { x: s.cx - s.rx, y: s.cy - s.ry, w: s.rx * 2, h: s.ry * 2 }
    case 'line':
      return {
        x: Math.min(s.x1, s.x2),
        y: Math.min(s.y1, s.y2),
        w: Math.abs(s.x2 - s.x1),
        h: Math.abs(s.y2 - s.y1),
      }
    case 'text':
      return {
        x: s.x - 4,
        y: s.y - s.size,
        w: Math.max(s.size * Math.max(s.text.length * 0.7, 1), 16),
        h: s.size * 1.4,
      }
  }
}

// ---------- 交互状态 ----------

type DragState =
  | { mode: 'move'; id: string; startX: number; startY: number; orig: SvgShape }
  | { mode: 'resize'; id: string; orig: SvgShape }
  | { mode: 'endpoint'; id: string; which: 1 | 2; orig: SvgShape }
  | null

// ---------- 属性面板小组件 ----------

const PALETTE = ['#000000', '#ffffff', '#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7'] as const

function ColorSwatches({
  value,
  onChange,
  allowNone,
  label,
}: {
  value: string
  onChange: (c: string) => void
  allowNone?: boolean
  label: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-12 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      {allowNone && (
        <button
          type="button"
          aria-label="无色（透明）"
          title="无色（透明）"
          onClick={() => onChange('none')}
          className={cn(
            'relative size-7 shrink-0 overflow-hidden rounded-full ring-1 ring-border transition-transform hover:scale-110',
            value === 'none' && 'ring-2 ring-blue-500',
          )}
        >
          <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 rotate-45 bg-red-500" />
        </button>
      )}
      {PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`颜色 ${c}`}
          title={c}
          onClick={() => onChange(c)}
          style={{ background: c }}
          className={cn(
            'size-7 shrink-0 rounded-full ring-1 ring-border transition-transform hover:scale-110',
            value === c && 'ring-2 ring-blue-500',
          )}
        />
      ))}
      <label className="relative size-7 shrink-0 cursor-pointer" title="自定义颜色">
        <span
          aria-hidden
          className="absolute inset-0 rounded-full ring-1 ring-border"
          style={{
            background:
              'conic-gradient(#ef4444,#f97316,#eab308,#22c55e,#3b82f6,#a855f7,#ec4899,#ef4444)',
          }}
        />
        <input
          type="color"
          aria-label={`自定义${label}`}
          value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000'}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </label>
    </div>
  )
}

// ---------- 主组件 ----------

export function SvgVisualEditor({
  code,
  onChange,
}: {
  code: string
  onChange: (next: string) => void
}) {
  const [doc, setDoc] = React.useState<SvgDoc>(() => parseSvgCode(code))
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [drag, setDrag] = React.useState<DragState>(null)
  const svgRef = React.useRef<SVGSVGElement | null>(null)
  const textInputRef = React.useRef<HTMLInputElement | null>(null)
  /** 上一次同步给父级 / 从父级读入的源码：只有外部改动才重载画布 */
  const lastSyncRef = React.useRef<string>(code)
  /** 最新画布文档镜像（事件回调里序列化用，避免在 setState updater 内做副作用） */
  const docRef = React.useRef<SvgDoc>(doc)
  React.useEffect(() => {
    docRef.current = doc
  }, [doc])

  // 外部源码变化（手动改代码 / AI 应用）→ 自动重载画布
  React.useEffect(() => {
    if (code !== lastSyncRef.current) {
      lastSyncRef.current = code
      const next = parseSvgCode(code)
      docRef.current = next
      setDoc(next)
      setSelectedId(null)
      setDrag(null)
    }
  }, [code])

  const selected = doc.shapes.find((s) => s.id === selectedId) ?? null

  /** 画布编辑 → 序列化并同步给父级源码 */
  const emit = React.useCallback(
    (next: SvgDoc) => {
      docRef.current = next
      setDoc(next)
      const out = serializeSvgDoc(next)
      lastSyncRef.current = out
      onChange(out)
    },
    [onChange],
  )

  // ---- 坐标换算（支持 viewBox 缩放 / letterbox） ----
  const toSvgXY = React.useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const svg = svgRef.current
    if (!svg) return null
    const ctm = svg.getScreenCTM()
    if (!ctm) return null
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse())
    return { x: p.x, y: p.y }
  }, [])

  // ---- 拖拽（window 监听 → 鼠标 / 触摸通用） ----
  React.useEffect(() => {
    if (!drag) return
    const onMove = (e: PointerEvent) => {
      const pt = toSvgXY(e.clientX, e.clientY)
      if (!pt) return
      const prev = docRef.current
      const idx = prev.shapes.findIndex((s) => s.id === drag.id)
      if (idx === -1) return
      const orig = drag.orig
      let next: SvgShape
      switch (drag.mode) {
        case 'move': {
          const dx = pt.x - drag.startX
          const dy = pt.y - drag.startY
          next = translateShape(orig, dx, dy)
          break
        }
        case 'resize': {
          if (orig.kind === 'rect') {
            next = { ...orig, w: Math.max(4, pt.x - orig.x), h: Math.max(4, pt.y - orig.y) }
          } else if (orig.kind === 'circle') {
            next = { ...orig, r: Math.max(2, Math.hypot(pt.x - orig.cx, pt.y - orig.cy)) }
          } else if (orig.kind === 'ellipse') {
            next = {
              ...orig,
              rx: Math.max(2, Math.abs(pt.x - orig.cx)),
              ry: Math.max(2, Math.abs(pt.y - orig.cy)),
            }
          } else {
            next = orig
          }
          break
        }
        case 'endpoint': {
          if (orig.kind === 'line') {
            next =
              drag.which === 1
                ? { ...orig, x1: pt.x, y1: pt.y }
                : { ...orig, x2: pt.x, y2: pt.y }
          } else {
            next = orig
          }
          break
        }
      }
      const shapes = [...prev.shapes]
      shapes[idx] = next
      const nextDoc = { ...prev, shapes }
      docRef.current = nextDoc // 同步镜像，pointerup 时直接序列化最新态
      setDoc(nextDoc)
    }
    const onUp = () => {
      // 拖动过程只更新本地；结束时一次性序列化同步（避免高频 onChange）
      const out = serializeSvgDoc(docRef.current)
      if (out !== lastSyncRef.current) {
        lastSyncRef.current = out
        onChange(out)
      }
      setDrag(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [drag, toSvgXY, onChange])

  // ---- 删除键 ----
  const deleteSelected = React.useCallback(() => {
    if (!selectedId) return
    const next: SvgDoc = {
      ...docRef.current,
      shapes: docRef.current.shapes.filter((s) => s.id !== selectedId),
    }
    setDoc(next)
    const out = serializeSvgDoc(next)
    lastSyncRef.current = out
    onChange(out)
    setSelectedId(null)
  }, [selectedId, onChange])

  React.useEffect(() => {
    if (!selectedId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      deleteSelected()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, deleteSelected])

  // ---- 增改操作 ----
  const addShape = (kind: SvgShape['kind'], opts?: { arrow?: boolean }) => {
    const cx = doc.width / 2
    const cy = doc.height / 2
    const id = nextShapeId(kind)
    let s: SvgShape
    switch (kind) {
      case 'rect':
        s = { id, kind, x: cx - 60, y: cy - 30, w: 120, h: 60, fill: '#ffffff', stroke: '#000000', strokeWidth: 2 }
        break
      case 'circle':
        s = { id, kind, cx, cy, r: 40, fill: '#ffffff', stroke: '#000000', strokeWidth: 2 }
        break
      case 'ellipse':
        s = { id, kind, cx, cy, rx: 60, ry: 35, fill: '#ffffff', stroke: '#000000', strokeWidth: 2 }
        break
      case 'line':
        s = { id, kind, x1: cx - 60, y1: cy, x2: cx + 60, y2: cy, arrow: opts?.arrow ?? false, fill: 'none', stroke: '#000000', strokeWidth: 2 }
        break
      case 'text':
        s = { id, kind, x: cx - 40, y: cy + 6, text: '文字', size: 18, fill: '#000000', stroke: 'none', strokeWidth: 0 }
        break
    }
    emit({ ...doc, shapes: [...doc.shapes, s] })
    setSelectedId(id)
    if (kind === 'text') requestAnimationFrame(() => textInputRef.current?.focus())
  }

  const updateSelected = (patch: Record<string, unknown>) => {
    if (!selectedId) return
    emit({
      ...doc,
      shapes: doc.shapes.map((s) => (s.id === selectedId ? ({ ...s, ...patch } as SvgShape) : s)),
    })
  }

  // ---- 画布事件 ----
  const startShapeDrag = (e: React.PointerEvent, s: SvgShape) => {
    e.stopPropagation()
    const pt = toSvgXY(e.clientX, e.clientY)
    if (!pt) return
    setSelectedId(s.id)
    setDrag({ mode: 'move', id: s.id, startX: pt.x, startY: pt.y, orig: s })
  }

  const startHandleDrag = (e: React.PointerEvent, mode: 'resize' | 'endpoint', which: 1 | 2) => {
    e.stopPropagation()
    if (!selected) return
    setDrag(
      mode === 'resize'
        ? { mode, id: selected.id, orig: selected }
        : { mode: 'endpoint', id: selected.id, which, orig: selected },
    )
  }

  const shapeEls = doc.shapes.map((s) => {
    const common = {
      onPointerDown: (e: React.PointerEvent) => startShapeDrag(e, s),
      onDoubleClick: s.kind === 'text' ? () => textInputRef.current?.focus() : undefined,
      className: 'cursor-move',
    }
    switch (s.kind) {
      case 'rect':
        return (
          <rect key={s.id} x={s.x} y={s.y} width={s.w} height={s.h} fill={s.fill}
            stroke={s.stroke === 'none' ? 'none' : s.stroke} strokeWidth={s.strokeWidth} {...common} />
        )
      case 'circle':
        return (
          <circle key={s.id} cx={s.cx} cy={s.cy} r={s.r} fill={s.fill}
            stroke={s.stroke === 'none' ? 'none' : s.stroke} strokeWidth={s.strokeWidth} {...common} />
        )
      case 'ellipse':
        return (
          <ellipse key={s.id} cx={s.cx} cy={s.cy} rx={s.rx} ry={s.ry} fill={s.fill}
            stroke={s.stroke === 'none' ? 'none' : s.stroke} strokeWidth={s.strokeWidth} {...common} />
        )
      case 'line':
        return (
          <line key={s.id} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} fill="none"
            stroke={s.stroke === 'none' ? '#000000' : s.stroke} strokeWidth={s.strokeWidth}
            markerEnd={s.arrow ? `url(#svgedit-arrow-${s.stroke.replace(/[^a-zA-Z0-9]/g, '')})` : undefined} {...common} />
        )
      case 'text':
        return (
          <text key={s.id} x={s.x} y={s.y} fontSize={s.size} fill={s.fill} {...common}>
            {s.text}
          </text>
        )
    }
  })

  // 选中态覆盖层（虚线框 + 手柄）
  let overlay: React.ReactNode = null
  if (selected) {
    const bb = shapeBBox(selected)
    const handleProps = {
      fill: '#3b82f6',
      stroke: '#ffffff',
      strokeWidth: 1,
      r: 6,
    } as const
    overlay = (
      <g pointerEvents="none">
        <rect
          x={bb.x - 3}
          y={bb.y - 3}
          width={Math.max(bb.w + 6, 8)}
          height={Math.max(bb.h + 6, 8)}
          fill="none"
          stroke="#3b82f6"
          strokeWidth={1.5}
          strokeDasharray="5 3"
        />
        {(selected.kind === 'rect' ||
          selected.kind === 'circle' ||
          selected.kind === 'ellipse') && (
          <circle
            {...handleProps}
            cx={selected.kind === 'rect' ? selected.x + selected.w : selected.kind === 'circle' ? selected.cx + selected.r : selected.cx + selected.rx}
            cy={selected.kind === 'rect' ? selected.y + selected.h : selected.kind === 'circle' ? selected.cy + selected.r : selected.cy + selected.ry}
            pointerEvents="all"
            className="cursor-nwse-resize"
            onPointerDown={(e) => startHandleDrag(e, 'resize', 2)}
          />
        )}
        {selected.kind === 'line' && (
          <>
            <circle
              {...handleProps}
              cx={selected.x1}
              cy={selected.y1}
              pointerEvents="all"
              className="cursor-move"
              onPointerDown={(e) => startHandleDrag(e, 'endpoint', 1)}
            />
            <circle
              {...handleProps}
              cx={selected.x2}
              cy={selected.y2}
              pointerEvents="all"
              className="cursor-move"
              onPointerDown={(e) => startHandleDrag(e, 'endpoint', 2)}
            />
          </>
        )}
      </g>
    )
  }

  const arrowMarkerDefs = Array.from(
    new Set(doc.shapes.filter((s) => s.kind === 'line' && s.arrow).map((s) => s.stroke)),
  )

  const isLine = selected?.kind === 'line'
  const isText = selected?.kind === 'text'

  return (
    <div className="flex flex-col gap-2">
      {/* 容错提示 */}
      {doc.parseError && (
        <p className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
          {doc.parseError}
        </p>
      )}
      {!doc.parseError && doc.raw.length > 0 && (
        <p className="rounded-xl border border-border bg-muted/50 px-3 py-1.5 text-[11px] text-muted-foreground">
          {doc.raw.length} 个复杂元素将以源码保留（画布中半透明灰显，不可编辑，导出时原样带回）
        </p>
      )}

      {/* 形状面板 */}
      <div className="grid grid-cols-6 gap-1.5">
        {(
          [
            { label: '矩形', icon: Square, kind: 'rect' as const },
            { label: '圆', icon: CircleIcon, kind: 'circle' as const },
            { label: '椭圆', icon: CircleIcon, iconCls: 'scale-x-150', kind: 'ellipse' as const },
            { label: '直线', icon: Minus, kind: 'line' as const },
            { label: '箭头', icon: ArrowRight, kind: 'line-arrow' as const },
            { label: '文字', icon: TypeIcon, kind: 'text' as const },
          ] as const
        ).map((it) => {
          const Icon = it.icon
          return (
            <button
              key={it.label}
              type="button"
              onClick={() =>
                it.kind === 'line-arrow'
                  ? addShape('line', { arrow: true })
                  : addShape(it.kind)
              }
              title={`添加${it.label}`}
              aria-label={`添加${it.label}`}
              className="flex h-11 flex-col items-center justify-center gap-0.5 rounded-lg border border-border text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Icon className={cn('size-4', 'iconCls' in it ? it.iconCls : '')} strokeWidth={1.75} />
              {it.label}
            </button>
          )
        })}
      </div>

      {/* 画布 */}
      <div
        className="relative overflow-hidden rounded-xl border border-border bg-white"
        style={{ aspectRatio: `${doc.width} / ${doc.height}` }}
      >
        <svg
          ref={svgRef}
          viewBox={`0 0 ${doc.width} ${doc.height}`}
          className="h-full w-full touch-none select-none"
          role="application"
          aria-label="SVG 画布：点选元素后拖动编辑"
          onPointerDown={(e) => {
            // 点空白（画布本身 / 原始元素底衬）→ 取消选择
            const target = e.target as Element
            if (target === e.currentTarget || target.getAttribute('data-bg') === '1') {
              setSelectedId(null)
            }
          }}
        >
          {/* 箭头 marker 定义（与导出保持一致） */}
          <defs>
            {arrowMarkerDefs.map((c) => (
              <marker
                key={c}
                id={`svgedit-arrow-${c.replace(/[^a-zA-Z0-9]/g, '')}`}
                viewBox="0 0 10 10"
                refX={9}
                refY={5}
                markerWidth={7}
                markerHeight={7}
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill={c} />
              </marker>
            ))}
          </defs>
          {/* 原始元素底衬（半透明灰显，不可编辑） */}
          {doc.raw.length > 0 && (
            <g data-bg="1" opacity={0.45} dangerouslySetInnerHTML={{ __html: doc.raw.join('\n') }} />
          )}
          {shapeEls}
          {overlay}
        </svg>
      </div>

      {/* 属性栏（选中时） */}
      {selected ? (
        <div className="flex flex-col gap-2 rounded-xl border border-border p-2.5">
          {isText && (
            <div className="flex gap-2">
              <Input
                ref={textInputRef}
                value={selected.text}
                aria-label="文字内容"
                onChange={(e) => updateSelected({ text: e.target.value })}
                className="h-9 flex-1 rounded-lg text-sm"
              />
              <Input
                type="number"
                min={8}
                max={96}
                value={selected.size}
                aria-label="字号"
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (Number.isFinite(v)) updateSelected({ size: Math.min(96, Math.max(8, v)) })
                }}
                className="h-9 w-16 rounded-lg text-sm"
              />
            </div>
          )}
          {isLine && (
            <label className="flex w-fit cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={selected.arrow}
                onChange={(e) => updateSelected({ arrow: e.target.checked })}
                className="size-4 accent-blue-600"
              />
              箭头（末端）
            </label>
          )}
          {!isLine && (
            <ColorSwatches
              label="填充"
              value={selected.fill}
              allowNone
              onChange={(c) => updateSelected({ fill: c })}
            />
          )}
          {!isText && (
            <ColorSwatches
              label="描边"
              value={selected.stroke}
              allowNone
              onChange={(c) => updateSelected({ stroke: c })}
            />
          )}
          {isText && (
            <ColorSwatches label="文字色" value={selected.fill} onChange={(c) => updateSelected({ fill: c })} />
          )}
          {!isText && (
            <div className="flex items-center gap-3">
              <span className="w-12 shrink-0 text-[11px] text-muted-foreground">粗细</span>
              <Slider
                value={[selected.strokeWidth]}
                min={1}
                max={12}
                step={1}
                onValueChange={(v) => updateSelected({ strokeWidth: v[0] ?? selected.strokeWidth })}
                className="flex-1"
                aria-label="描边粗细"
              />
              <span className="w-6 text-right text-xs tabular-nums text-muted-foreground">
                {selected.strokeWidth}
              </span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-muted-foreground">
              拖动移动{!isText ? ' · 手柄调整大小' : ' · 双击聚焦文字'} · Delete 删除
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-8 rounded-full text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={deleteSelected}
            >
              <Trash2 className="size-3.5" /> 删除选中
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          点击画布中的元素选中后可拖动、调大小、改颜色；点空白处取消选择
        </p>
      )}
    </div>
  )
}
