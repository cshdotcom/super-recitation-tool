'use client'

// SvgVisualEditor — SVG 可视化编辑器（工具栏 + 画布 + 图层 + 属性栏）。
// 能力总览：
//   • 绘图工具：选择 / 抓手 / 矩形 / 圆 / 椭圆 / 直线 / 箭头 / 多边形（边数 3-8）/
//     折线（连续点击，双击或回车结束）/ 自由画笔（拖动平滑路径）/ 文字（点击就地输入）。
//     直线绘制与端点拖拽支持 Shift 锁定水平 / 垂直 / 45°。
//   • 画布：滚轮 / 双指捏合缩放（25% – 400%，以指针为中心）、抓手工具或空格+拖动平移、
//     「适应内容」一键 fit、缩放百分比显示；画布尺寸 200-2000 可调（viewBox 同步）+ 预设。
//   • 网格（20px 淡灰点阵）与吸附（移动 / resize / 绘制坐标取整 10px）。
//   • 选择：点选、Shift+点击多选、空白拖框多选；多选支持批量删除 / 批量改色 / 批量改粗细 /
//     六向对齐（按包围盒）。
//   • 编辑：拖动移动（多选整体移动）、resize 手柄、直线端点手柄、旋转手柄 + 角度输入
//     （除圆外的全部元素）、透明度、虚线（实线/虚线/点线）、线帽（圆头/平头/方头）、
//     圆角 rx、层级（上移/下移/置顶/置底）。
//   • 图层面板：全部元素列表、点击选中、眼睛显隐、上下移调序；原始（复杂）元素锁定展示。
//   • 撤销 / 重做：完整操作快照栈（增/删/移动/resize/属性/层级/导入），栈深 50，
//     Ctrl+Z / Ctrl+Shift+Z（Ctrl+Y），工具栏 ↶ ↷ 按钮。
//   • 复制粘贴：Ctrl+C / Ctrl+V（编辑器内部剪贴板）、Ctrl+D 与「复制副本」按钮（偏移 12px）。
//   • 导入文件：上传 .svg 走解析管线（画布有内容时询问「追加导入 / 替换全部」）；
//     下载 SVG（Blob 下载）与「复制源码」（navigator.clipboard）。
//   • 双向同步：切到可视化时用 DOMParser 解析现有 SVG 源码；能识别的
//     rect（含圆角 rx）/ circle / ellipse / line / text（含 tspan 合并）/ polygon / polyline /
//     简单 path（绝对坐标 M/L/C/Q/H/V/Z）载入画布，支持 rotate 变换 / 透明度 / 虚线 / 线帽 /
//     display:none 解析；识别不了的元素（复杂 path、g、滤镜、渐变填充…）保留为「原始元素」
//     随导出原样带回（不丢内容）；源码改动后切回可视化自动重载。
//   • 全部交互基于 pointer events（setPointerCapture），兼容鼠标 / 触摸 / 触控笔。

import * as React from 'react'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpToLine,
  ChevronDown,
  ChevronUp,
  Circle as CircleIcon,
  ClipboardCopy,
  Copy,
  Download,
  Eye,
  EyeOff,
  Frame,
  Grid3x3,
  Hand,
  Hexagon,
  Layers,
  Lock,
  Magnet,
  Minus,
  MousePointer2,
  Pencil,
  Plus,
  Redo2,
  RotateCw,
  Scan,
  Spline,
  Square,
  Trash2,
  Type as TypeIcon,
  Undo2,
  Upload,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'

// ============================================================
// 一、数据模型
// ============================================================

interface Pt {
  x: number
  y: number
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** 路径命令（仅绝对坐标 M/L/C/Q/Z；H/V 在解析时折算为 L） */
interface PathCmd {
  c: 'M' | 'L' | 'C' | 'Q' | 'Z'
  n: number[]
}

type DashStyle = 'solid' | 'dash' | 'dot'
type LineCap = 'butt' | 'round' | 'square'

interface ShapeCommon {
  id: string
  fill: string
  stroke: string
  strokeWidth: number
  /** 透明度 0-1（缺省 1） */
  opacity?: number
  /** 隐藏（导出为 display="none"） */
  visible?: boolean
  /** 旋转角度（度，绕自身包围盒中心；circle 旋转无视觉意义，其余类型均可） */
  rotation?: number
  /** 虚线样式 */
  dash?: DashStyle
  /** 线帽（线条类） */
  linecap?: LineCap
}

export type SvgShape =
  | (ShapeCommon & { kind: 'rect'; x: number; y: number; w: number; h: number; rx?: number })
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
  | (ShapeCommon & { kind: 'polygon'; pts: Pt[] })
  | (ShapeCommon & { kind: 'polyline'; pts: Pt[] })
  | (ShapeCommon & { kind: 'path'; cmds: PathCmd[] })

interface SvgDoc {
  width: number
  height: number
  shapes: SvgShape[]
  /** 识别不了的元素原样保留（导出时随输出带回） */
  raw: string[]
  parseError: string | null
}

const DEFAULT_DOC: SvgDoc = { width: 600, height: 400, shapes: [], raw: [], parseError: null }

const KIND_LABEL: Record<SvgShape['kind'], string> = {
  rect: '矩形',
  circle: '圆',
  ellipse: '椭圆',
  line: '直线',
  text: '文字',
  polygon: '多边形',
  polyline: '折线',
  path: '路径',
}

/** 线条类元素（可设置线帽） */
const LINE_LIKE: ReadonlySet<string> = new Set(['line', 'polyline', 'path'])
/** 支持旋转属性的元素（circle 旋转无视觉意义，排除；其余类型均可旋转） */
const ROTATABLE: ReadonlySet<string> = new Set([
  'rect',
  'ellipse',
  'text',
  'line',
  'polygon',
  'polyline',
  'path',
])

type ToolId =
  | 'select'
  | 'pan'
  | 'rect'
  | 'circle'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'polygon'
  | 'polyline'
  | 'path'
  | 'text'

/** 拖拽绘制的形状工具 */
type DrawKind = Exclude<ToolId, 'select' | 'pan' | 'text' | 'polyline' | 'path'>

type AlignMode = 'l' | 'hc' | 'r' | 't' | 'vc' | 'b'

// ============================================================
// 二、通用小工具
// ============================================================

let shapeSeq = 0
const nextShapeId = (kind: string) => `el-${kind}-${Date.now().toString(36)}-${++shapeSeq}`

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const snapTo = (v: number, n: number) => Math.round(v / n) * n
const snapPtTo = (p: Pt, n: number): Pt => ({ x: snapTo(p.x, n), y: snapTo(p.y, n) })

function rotPt(p: Pt, center: Pt, deg: number): Pt {
  const a = (deg * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const dx = p.x - center.x
  const dy = p.y - center.y
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos }
}

/** Shift 锁定角度：以 origin 为圆心，把 p 吸附到 45° 倍数方向 */
function lock45(origin: Pt, p: Pt): Pt {
  const dx = p.x - origin.x
  const dy = p.y - origin.y
  const len = Math.hypot(dx, dy)
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
  return { x: origin.x + Math.cos(a) * len, y: origin.y + Math.sin(a) * len }
}

function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

function boxIntersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function ptsBBox(pts: Pt[]): Box {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

function pathBBox(cmds: PathCmd[]): Box {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const c of cmds) {
    for (let i = 0; i + 1 < c.n.length; i += 2) {
      if (c.n[i] < minX) minX = c.n[i]
      if (c.n[i] > maxX) maxX = c.n[i]
      if (c.n[i + 1] < minY) minY = c.n[i + 1]
      if (c.n[i + 1] > maxY) maxY = c.n[i + 1]
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** 正多边形顶点（cx,cy 为中心，r 为外接圆半径，rotDeg 为首个顶点角度） */
function regularPolygonPts(cx: number, cy: number, r: number, sides: number, rotDeg: number): Pt[] {
  const n = Math.round(clamp(sides, 3, 8))
  return Array.from({ length: n }, (_, i) => {
    const a = ((rotDeg + (i * 360) / n) * Math.PI) / 180
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
  })
}

/** 自由绘制点串 → 平滑路径（经典中点二次贝塞尔） */
function smoothPathCmds(pts: Pt[]): PathCmd[] {
  if (pts.length === 0) return []
  if (pts.length === 1) return [{ c: 'M', n: [pts[0].x, pts[0].y] }]
  if (pts.length === 2) return [
    { c: 'M', n: [pts[0].x, pts[0].y] },
    { c: 'L', n: [pts[1].x, pts[1].y] },
  ]
  const cmds: PathCmd[] = [{ c: 'M', n: [pts[0].x, pts[0].y] }]
  for (let i = 1; i < pts.length - 1; i++) {
    const mid = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 }
    cmds.push({ c: 'Q', n: [pts[i].x, pts[i].y, mid.x, mid.y] })
  }
  const last = pts[pts.length - 1]
  cmds.push({ c: 'L', n: [last.x, last.y] })
  return cmds
}

function cloneShape(s: SvgShape): SvgShape {
  return JSON.parse(JSON.stringify(s)) as SvgShape
}

function dashArrayOf(s: SvgShape): string | undefined {
  if (!s.dash || s.dash === 'solid' || s.stroke === 'none' || s.strokeWidth <= 0) return undefined
  const w = Math.max(1, s.strokeWidth)
  if (s.dash === 'dash') return `${Math.round(w * 3)},${Math.round(w * 2)}`
  return `${Math.max(1, Math.round(w / 2))},${Math.round(w * 2)}`
}

// ============================================================
// 三、源码解析
// ============================================================

function numAttr(el: Element, name: string): number | null {
  const v = parseFloat(el.getAttribute(name) || '')
  return Number.isFinite(v) ? v : null
}

function colorAttr(el: Element, name: string, fallback: string): string {
  const v = el.getAttribute(name)
  return v && v.trim() !== '' ? v.trim() : fallback
}

/** 各标签允许出现的几何属性（之外的属性 → 整个元素按原始元素保留，保证不丢外观） */
const ALLOWED_ATTRS: Record<string, ReadonlySet<string>> = {
  rect: new Set(['x', 'y', 'width', 'height', 'rx', 'ry']),
  circle: new Set(['cx', 'cy', 'r']),
  ellipse: new Set(['cx', 'cy', 'rx', 'ry']),
  line: new Set(['x1', 'y1', 'x2', 'y2', 'marker-end']),
  text: new Set(['x', 'y', 'font-size']),
  polygon: new Set(['points']),
  polyline: new Set(['points']),
  path: new Set(['d', 'marker-end']),
}

/** 各标签允许出现的通用样式属性 */
const STYLE_ATTRS: ReadonlySet<string> = new Set([
  'fill',
  'stroke',
  'stroke-width',
  'opacity',
  'display',
  'transform',
  'stroke-dasharray',
  'stroke-linecap',
])

function attrsAllowed(el: Element): boolean {
  const allowed = ALLOWED_ATTRS[el.tagName.toLowerCase()]
  if (!allowed) return false
  for (const name of el.getAttributeNames()) {
    if (!allowed.has(name) && !STYLE_ATTRS.has(name)) return false
    if (name === 'fill' || name === 'stroke') {
      const v = (el.getAttribute(name) || '').trim()
      if (/^url\(/i.test(v)) return false // 渐变填充 → 原样保留
    }
  }
  return true
}

/** 仅支持单一 rotate 变换（可带旋转中心），其他变换返回 null（上层归入原始元素） */
function parseRotateTransform(tr: string): { deg: number; px: number; py: number } | null {
  const s = tr.trim().replace(/[\s,]+/g, ' ')
  let m = s.match(/^rotate\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/)
  if (m) return { deg: parseFloat(m[1]), px: parseFloat(m[2]), py: parseFloat(m[3]) }
  m = s.match(/^rotate\(\s*(-?\d+(?:\.\d+)?)\s*\)$/)
  if (m) return { deg: parseFloat(m[1]), px: 0, py: 0 }
  return null
}

function parseOpacityAttr(el: Element): number | undefined | 'raw' {
  const v = el.getAttribute('opacity')
  if (v == null || v === '') return undefined
  const n = parseFloat(v)
  if (!Number.isFinite(n) || n < 0 || n > 1) return 'raw'
  return n
}

function parseDisplayAttr(el: Element): boolean | undefined | 'raw' {
  const v = el.getAttribute('display')
  if (v == null || v === '') return undefined
  if (v.trim() === 'none') return false
  return 'raw'
}

function parseLinecapAttr(el: Element): LineCap | undefined | 'raw' {
  const v = el.getAttribute('stroke-linecap')
  if (v == null || v === '') return undefined
  if (v === 'butt' || v === 'round' || v === 'square') return v
  return 'raw'
}

/** 解析 stroke-dasharray：能对上本编辑器生成的虚线 / 点线格式则转为字段，否则整体保留 */
function parseDashAttr(el: Element, strokeWidth: number): DashStyle | undefined | 'raw' {
  const v = (el.getAttribute('stroke-dasharray') || '').trim()
  if (!v || v === 'none') return undefined
  const nums = v.match(/-?[\d.]+/g)
  if (!nums || nums.length < 2) return 'raw'
  const a = parseFloat(nums[0])
  const b = parseFloat(nums[1])
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'raw'
  if (Math.abs(a - strokeWidth * 3) <= 0.51 && Math.abs(b - strokeWidth * 2) <= 0.51) return 'dash'
  if (a <= strokeWidth * 0.75 + 0.51 && Math.abs(b - strokeWidth * 2) <= 0.51) return 'dot'
  return 'raw'
}

function parsePointsStr(v: string): Pt[] | null {
  const nums = v.trim().match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g)
  if (!nums || nums.length < 4 || nums.length % 2 !== 0) return null
  const pts: Pt[] = []
  for (let i = 0; i < nums.length; i += 2) {
    const x = parseFloat(nums[i])
    const y = parseFloat(nums[i + 1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    pts.push({ x, y })
  }
  return pts
}

/**
 * 解析 path d 属性：仅接受绝对坐标 M/L/C/Q/H/V/Z（H/V 折算为 L，M 后隐式 L 支持）。
 * 相对命令 / 弧线 / S / T 等返回 null（上层归入原始元素）。
 */
function parsePathTokens(d: string): PathCmd[] | null {
  const tokens = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g)
  if (!tokens || tokens.length === 0) return null
  const isLetter = (t: string) => t.length === 1 && /[A-Za-z]/.test(t)
  const cmds: PathCmd[] = []
  let i = 0
  let cur: Pt | null = null
  const readPair = (): Pt | null => {
    if (i + 1 >= tokens.length || isLetter(tokens[i]) || isLetter(tokens[i + 1])) return null
    const x = parseFloat(tokens[i])
    const y = parseFloat(tokens[i + 1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    i += 2
    return { x, y }
  }
  const readNum = (): number | null => {
    if (i >= tokens.length || isLetter(tokens[i])) return null
    const v = parseFloat(tokens[i])
    if (!Number.isFinite(v)) return null
    i += 1
    return v
  }
  while (i < tokens.length) {
    const t = tokens[i]
    if (!isLetter(t)) return null
    i += 1
    if (t === 'M') {
      const p = readPair()
      if (!p) return null
      cmds.push({ c: 'M', n: [p.x, p.y] })
      cur = p
      while (i < tokens.length && !isLetter(tokens[i])) {
        const q = readPair()
        if (!q) return null
        cmds.push({ c: 'L', n: [q.x, q.y] })
        cur = q
      }
    } else if (t === 'L') {
      if (!cur) return null
      while (i < tokens.length && !isLetter(tokens[i])) {
        const q = readPair()
        if (!q) return null
        cmds.push({ c: 'L', n: [q.x, q.y] })
        cur = q
      }
    } else if (t === 'C') {
      if (!cur) return null
      while (i < tokens.length && !isLetter(tokens[i])) {
        const n: number[] = []
        for (let k = 0; k < 6; k++) {
          const v = readNum()
          if (v == null) return null
          n.push(v)
        }
        cmds.push({ c: 'C', n })
        cur = { x: n[4], y: n[5] }
      }
    } else if (t === 'Q') {
      if (!cur) return null
      while (i < tokens.length && !isLetter(tokens[i])) {
        const n: number[] = []
        for (let k = 0; k < 4; k++) {
          const v = readNum()
          if (v == null) return null
          n.push(v)
        }
        cmds.push({ c: 'Q', n })
        cur = { x: n[2], y: n[3] }
      }
    } else if (t === 'H') {
      if (!cur) return null
      while (i < tokens.length && !isLetter(tokens[i])) {
        const v = readNum()
        if (v == null) return null
        cmds.push({ c: 'L', n: [v, cur.y] })
        cur = { x: v, y: cur.y }
      }
    } else if (t === 'V') {
      if (!cur) return null
      while (i < tokens.length && !isLetter(tokens[i])) {
        const v = readNum()
        if (v == null) return null
        cmds.push({ c: 'L', n: [cur.x, v] })
        cur = { x: cur.x, y: v }
      }
    } else if (t === 'Z') {
      cmds.push({ c: 'Z', n: [] })
      cur = null
    } else {
      return null // 相对命令 / 弧线 / S / T → 原样保留
    }
  }
  return cmds
}

/** path 元素 → 可编辑形状（单段 M..L → 直线；全 L → 折线/多边形；含曲线 → 路径） */
function recognizePathShape(el: Element, fill: string, stroke: string, strokeWidth: number): SvgShape | null {
  const d = (el.getAttribute('d') || '').trim()
  if (!d) return null
  const cmds = parsePathTokens(d)
  if (!cmds) return null
  const hasMarker = el.hasAttribute('marker-end')
  const mCount = cmds.filter((c) => c.c === 'M').length
  const onlyMLZ = cmds.every((c) => c.c === 'M' || c.c === 'L' || c.c === 'Z')
  if (onlyMLZ && mCount === 1) {
    const pts: Pt[] = []
    for (const c of cmds) {
      if (c.c === 'M' || c.c === 'L') pts.push({ x: c.n[0], y: c.n[1] })
    }
    const closed = cmds.some((c) => c.c === 'Z')
    if (pts.length === 2 && !closed) {
      return {
        id: nextShapeId('line'),
        kind: 'line',
        x1: pts[0].x,
        y1: pts[0].y,
        x2: pts[1].x,
        y2: pts[1].y,
        arrow: hasMarker,
        fill: 'none',
        stroke: stroke === 'none' ? '#000000' : stroke,
        strokeWidth,
      }
    }
    // 折线 / 多边形不承载 marker，带 marker 的保留原样
    if (!hasMarker) {
      if (closed && pts.length >= 3) {
        return { id: nextShapeId('polygon'), kind: 'polygon', pts, fill, stroke, strokeWidth }
      }
      if (!closed && pts.length >= 2) {
        return { id: nextShapeId('polyline'), kind: 'polyline', pts, fill, stroke, strokeWidth }
      }
    }
    return null
  }
  if (hasMarker || mCount !== 1) return null
  return { id: nextShapeId('path'), kind: 'path', cmds, fill, stroke, strokeWidth }
}

/** 识别一个 SVG 子元素 → 可编辑形状；识别不了返回 null（上层归入「原始元素」）。 */
function recognizeShape(el: Element): SvgShape | null {
  if (!attrsAllowed(el)) return null
  const tag = el.tagName.toLowerCase()

  // 变换：仅支持单一 rotate（transform="" 视为无变换），其他 → 原样保留
  let rot: { deg: number; px: number; py: number } | null = null
  const trAttr = el.getAttribute('transform')
  if (trAttr != null && trAttr !== '') {
    rot = parseRotateTransform(trAttr)
    if (!rot) return null
  }

  // 通用样式（不认识的值 → 原样保留）
  const opacity = parseOpacityAttr(el)
  if (opacity === 'raw') return null
  const visible = parseDisplayAttr(el)
  if (visible === 'raw') return null
  const linecap = parseLinecapAttr(el)
  if (linecap === 'raw') return null
  const stroke = colorAttr(el, 'stroke', 'none')
  const strokeWidth = numAttr(el, 'stroke-width') ?? 1
  if (strokeWidth < 0) return null
  const dash = parseDashAttr(el, strokeWidth)
  if (dash === 'raw') return null
  const fill = colorAttr(el, 'fill', '#000000')

  let shape: SvgShape | null = null
  switch (tag) {
    case 'rect': {
      let rxVal: number | null = null
      const rx = numAttr(el, 'rx')
      const ry = numAttr(el, 'ry')
      if (rx != null || ry != null) {
        if (rx != null && ry != null && Math.abs(rx - ry) > 0.01) return null // rx≠ry 的圆角 → 保留
        const rv = rx ?? ry
        if (rv == null || rv < 0) return null
        rxVal = rv
      }
      const x = numAttr(el, 'x') ?? 0
      const y = numAttr(el, 'y') ?? 0
      const w = numAttr(el, 'width')
      const h = numAttr(el, 'height')
      if (w == null || h == null || w < 0 || h < 0) return null
      shape = {
        id: nextShapeId('rect'),
        kind: 'rect',
        x,
        y,
        w,
        h,
        ...(rxVal != null && rxVal > 0 ? { rx: rxVal } : {}),
        fill,
        stroke,
        strokeWidth,
      }
      break
    }
    case 'circle': {
      const cx = numAttr(el, 'cx')
      const cy = numAttr(el, 'cy')
      const r = numAttr(el, 'r')
      if (cx == null || cy == null || r == null || r < 0) return null
      shape = { id: nextShapeId('circle'), kind: 'circle', cx, cy, r, fill, stroke, strokeWidth }
      break
    }
    case 'ellipse': {
      const cx = numAttr(el, 'cx')
      const cy = numAttr(el, 'cy')
      const rx = numAttr(el, 'rx')
      const ry = numAttr(el, 'ry')
      if (cx == null || cy == null || rx == null || ry == null || rx < 0 || ry < 0) return null
      shape = { id: nextShapeId('ellipse'), kind: 'ellipse', cx, cy, rx, ry, fill, stroke, strokeWidth }
      break
    }
    case 'line': {
      const x1 = numAttr(el, 'x1')
      const y1 = numAttr(el, 'y1')
      const x2 = numAttr(el, 'x2')
      const y2 = numAttr(el, 'y2')
      if (x1 == null || y1 == null || x2 == null || y2 == null) return null
      shape = {
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
      break
    }
    case 'text': {
      // tspan：不带定位属性的合并进文字；带 x/y/dx/dy 定位的 → 原样保留
      for (const child of Array.from(el.children)) {
        if (child.tagName.toLowerCase() !== 'tspan') return null
        if (
          child.hasAttribute('x') ||
          child.hasAttribute('y') ||
          child.hasAttribute('dx') ||
          child.hasAttribute('dy')
        ) {
          return null
        }
      }
      const x = numAttr(el, 'x') ?? 0
      const y = numAttr(el, 'y') ?? 0
      const text = (el.textContent || '').trim()
      if (!text) return null
      shape = {
        id: nextShapeId('text'),
        kind: 'text',
        x,
        y,
        text,
        size: numAttr(el, 'font-size') ?? 16,
        fill,
        stroke: 'none',
        strokeWidth: 0,
      }
      break
    }
    case 'polygon': {
      const pts = parsePointsStr(el.getAttribute('points') || '')
      if (!pts || pts.length < 3) return null
      shape = { id: nextShapeId('polygon'), kind: 'polygon', pts, fill, stroke, strokeWidth }
      break
    }
    case 'polyline': {
      const pts = parsePointsStr(el.getAttribute('points') || '')
      if (!pts || pts.length < 2) return null
      shape = { id: nextShapeId('polyline'), kind: 'polyline', pts, fill, stroke, strokeWidth }
      break
    }
    case 'path': {
      shape = recognizePathShape(el, fill, stroke, strokeWidth)
      break
    }
    default:
      return null
  }
  if (!shape) return null

  const styled = shape
  if (opacity !== undefined) styled.opacity = opacity
  if (visible !== undefined) styled.visible = visible
  if (linecap !== undefined) styled.linecap = linecap
  if (dash !== undefined) styled.dash = dash
  if (rot && rot.deg !== 0) return applyImportRotate(styled, rot.deg, rot.px, rot.py)
  return styled
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
      // 本编辑器生成的箭头 marker 导出时会按需重新生成，导入时剔除，
      // 否则「导出→再导入」每往返一次就多攒一份重复 defs（id 重复、源码膨胀）。
      const clone = el.cloneNode(true) as Element
      for (const c of Array.from(clone.children)) {
        if ((c.getAttribute('id') || '').startsWith('svgedit-arrow-')) c.remove()
      }
      // 其余 defs 内容（渐变/滤镜/自定义 marker）原样保留，导出带回
      if ((clone.innerHTML || '').trim() !== '') out.raw.push(clone.outerHTML)
      continue
    }
    const shape = recognizeShape(el)
    if (shape) out.shapes.push(shape)
    else out.raw.push(el.outerHTML)
  }
  return out
}

// ============================================================
// 四、源码生成
// ============================================================

const escXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const fmt = (n: number) => String(Math.round(n * 10) / 10)
const fmt2 = (n: number) => String(Math.round(n * 100) / 100)

const ptsAttr = (pts: Pt[]) => pts.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ')

function pathDAttr(cmds: PathCmd[]): string {
  return cmds
    .map((c) => (c.n.length > 0 ? `${c.c} ${c.n.map(fmt).join(' ')}` : c.c))
    .join(' ')
}

const arrowMarkerId = (color: string) => `svgedit-arrow-${color.replace(/[^a-zA-Z0-9]/g, '')}`

function fillAttrs(s: SvgShape): string {
  if (s.kind === 'line') return ' fill="none"'
  return ` fill="${escXml(s.fill)}"`
}

function strokeAttrs(s: SvgShape): string {
  if (s.kind === 'text' || s.stroke === 'none' || s.strokeWidth <= 0) return ''
  let out = ` stroke="${escXml(s.stroke)}" stroke-width="${fmt(s.strokeWidth)}"`
  const da = dashArrayOf(s)
  if (da) out += ` stroke-dasharray="${da}"`
  if (s.linecap) out += ` stroke-linecap="${s.linecap}"`
  return out
}

/** 透明度 / 显隐 / 旋转（绕包围盒中心，与画布渲染一致，保证导出再导入不变形） */
function styleAttrs(s: SvgShape): string {
  let out = ''
  if (s.opacity != null && s.opacity < 1) out += ` opacity="${fmt(s.opacity)}"`
  if (s.visible === false) out += ` display="none"`
  if (s.rotation && ROTATABLE.has(s.kind)) {
    const bb = shapeBBox(s)
    out += ` transform="rotate(${fmt(s.rotation)} ${fmt(bb.x + bb.w / 2)} ${fmt(bb.y + bb.h / 2)})"`
  }
  return out
}

/** 画布文档 → 干净 SVG 源码（原始元素原样带回）。 */
function serializeSvgDoc(doc: SvgDoc): string {
  const lines: string[] = []
  const arrowStrokes = new Set<string>()
  for (const s of doc.shapes) {
    if (s.kind === 'line' && s.arrow) arrowStrokes.add(s.stroke)
  }
  if (arrowStrokes.size > 0) {
    lines.push('  <defs>')
    for (const c of arrowStrokes) {
      lines.push(
        `    <marker id="${arrowMarkerId(c)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${escXml(c)}"/></marker>`,
      )
    }
    lines.push('  </defs>')
  }
  if (doc.raw.length > 0) {
    lines.push('  <!-- 复杂元素以源码保留 -->')
    for (const r of doc.raw) lines.push(`  ${r}`)
  }
  for (const s of doc.shapes) {
    const extra = styleAttrs(s)
    switch (s.kind) {
      case 'rect':
        lines.push(
          `  <rect x="${fmt(s.x)}" y="${fmt(s.y)}" width="${fmt(s.w)}" height="${fmt(s.h)}"${s.rx ? ` rx="${fmt(s.rx)}"` : ''}${fillAttrs(s)}${strokeAttrs(s)}${extra}/>`,
        )
        break
      case 'circle':
        lines.push(
          `  <circle cx="${fmt(s.cx)}" cy="${fmt(s.cy)}" r="${fmt(s.r)}"${fillAttrs(s)}${strokeAttrs(s)}${extra}/>`,
        )
        break
      case 'ellipse':
        lines.push(
          `  <ellipse cx="${fmt(s.cx)}" cy="${fmt(s.cy)}" rx="${fmt(s.rx)}" ry="${fmt(s.ry)}"${fillAttrs(s)}${strokeAttrs(s)}${extra}/>`,
        )
        break
      case 'line':
        lines.push(
          `  <line x1="${fmt(s.x1)}" y1="${fmt(s.y1)}" x2="${fmt(s.x2)}" y2="${fmt(s.y2)}"${strokeAttrs(s)} fill="none"${s.arrow ? ` marker-end="url(#${arrowMarkerId(s.stroke)})"` : ''}${extra}/>`,
        )
        break
      case 'text':
        lines.push(
          `  <text x="${fmt(s.x)}" y="${fmt(s.y)}" font-size="${fmt(s.size)}"${fillAttrs(s)}${extra}>${escXml(s.text)}</text>`,
        )
        break
      case 'polygon':
        lines.push(`  <polygon points="${ptsAttr(s.pts)}"${fillAttrs(s)}${strokeAttrs(s)}${extra}/>`)
        break
      case 'polyline':
        lines.push(`  <polyline points="${ptsAttr(s.pts)}"${fillAttrs(s)}${strokeAttrs(s)}${extra}/>`)
        break
      case 'path':
        lines.push(`  <path d="${pathDAttr(s.cmds)}"${fillAttrs(s)}${strokeAttrs(s)}${extra}/>`)
        break
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${doc.width} ${doc.height}" width="${doc.width}" height="${doc.height}">\n${lines.join('\n')}\n</svg>`
}

// ============================================================
// 五、几何工具
// ============================================================

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
    case 'polygon':
    case 'polyline':
      return { ...s, pts: s.pts.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
    case 'path':
      return {
        ...s,
        cmds: s.cmds.map((c) => ({
          c: c.c,
          n: c.n.map((v, i) => (i % 2 === 0 ? v + dx : v + dy)),
        })),
      }
  }
}

function shapeBBox(s: SvgShape): Box {
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
    case 'text': {
      // 估算：CJK 字符约 1em 宽，其他约 0.56em
      const cjk = (s.text.match(/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/g) || []).length
      const rest = s.text.length - cjk
      const w = Math.max(s.size * (cjk * 1.02 + rest * 0.56), 8)
      return { x: s.x - 2, y: s.y - s.size * 0.85, w, h: s.size * 1.15 }
    }
    case 'polygon':
    case 'polyline':
      return ptsBBox(s.pts)
    case 'path':
      return pathBBox(s.cmds)
  }
}

/**
 * 导入 rotate 变换：刚体旋转等价于「绕自身中心旋转 + 中心平移到旋转后的位置」，
 * 点线类形状把旋转烘进各点（round-trip 精确），矩形/椭圆/文字记 rotation 字段。
 */
function applyImportRotate(s: SvgShape, deg: number, px: number, py: number): SvgShape {
  const pivot = { x: px, y: py }
  if (s.kind === 'line') {
    const p1 = rotPt({ x: s.x1, y: s.y1 }, pivot, deg)
    const p2 = rotPt({ x: s.x2, y: s.y2 }, pivot, deg)
    return { ...s, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }
  }
  if (s.kind === 'polygon' || s.kind === 'polyline') {
    return { ...s, pts: s.pts.map((p) => rotPt(p, pivot, deg)) }
  }
  if (s.kind === 'path') {
    return {
      ...s,
      cmds: s.cmds.map((c) => {
        const n = [...c.n]
        for (let i = 0; i + 1 < n.length; i += 2) {
          const q = rotPt({ x: n[i], y: n[i + 1] }, pivot, deg)
          n[i] = q.x
          n[i + 1] = q.y
        }
        return { c: c.c, n }
      }),
    }
  }
  // rect / ellipse / text（circle 仅平移中心）
  const bb = shapeBBox(s)
  const c = { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 }
  // 本编辑器导出的 transform 恒以包围盒中心为轴（轴心写入时取整到 0.1）；
  // 轴心与自身中心偏差 ≤0.05 时视为绕自身中心旋转，跳过亚像素平移，
  // 保证「导出→再导入」完全幂等（否则每往返一次漂移 ~0.05px 且缓慢累积）。
  const selfPivot = Math.abs(pivot.x - c.x) <= 0.051 && Math.abs(pivot.y - c.y) <= 0.051
  const rc = selfPivot ? c : rotPt(c, pivot, deg)
  const moved = translateShape(s, rc.x - c.x, rc.y - c.y)
  if (s.kind === 'circle') return moved
  return { ...moved, rotation: ((deg % 360) + 360) % 360 }
}

/** 多边形改边数：保持质心 / 外接半径 / 首顶点角度，重新生成正多边形 */
function regenRegularPolygon(s: Extract<SvgShape, { kind: 'polygon' }>, sides: number): SvgShape {
  if (s.pts.length === 0) return s
  const cx = s.pts.reduce((a, p) => a + p.x, 0) / s.pts.length
  const cy = s.pts.reduce((a, p) => a + p.y, 0) / s.pts.length
  let r = 0
  for (const p of s.pts) r = Math.max(r, Math.hypot(p.x - cx, p.y - cy))
  const a0 = (Math.atan2(s.pts[0].y - cy, s.pts[0].x - cx) * 180) / Math.PI
  return { ...s, pts: regularPolygonPts(cx, cy, Math.max(r, 1), sides, a0) }
}

// ============================================================
// 六、属性面板小组件
// ============================================================

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

/** 分段选择（线型 / 线帽等） */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: { v: T; label: string; title?: string }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-12 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <div className="flex overflow-hidden rounded-lg border border-border">
        {options.map((o) => (
          <button
            key={o.v}
            type="button"
            title={o.title ?? o.label}
            aria-label={o.title ?? o.label}
            onClick={() => onChange(o.v)}
            className={cn(
              'h-7 px-2.5 text-[11px] transition-colors',
              value === o.v
                ? 'bg-primary text-primary-foreground'
                : 'bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 边数步进器（3-8） */
function SidesStepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const v = Math.round(clamp(value, 3, 8))
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        title="减少边数"
        aria-label="减少边数"
        onClick={() => onChange(Math.max(3, v - 1))}
        className="flex size-7 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Minus className="size-3.5" />
      </button>
      <span className="w-14 text-center text-[11px] tabular-nums text-muted-foreground">{value} 边形</span>
      <button
        type="button"
        title="增加边数"
        aria-label="增加边数"
        onClick={() => onChange(Math.min(8, v + 1))}
        className="flex size-7 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  )
}

// ============================================================
// 七、交互状态
// ============================================================

type DragState =
  | { mode: 'move'; ids: string[]; startX: number; startY: number; origs: SvgShape[]; before: SvgDoc }
  | { mode: 'resize'; id: string; orig: SvgShape; before: SvgDoc }
  | { mode: 'endpoint'; id: string; which: 1 | 2; orig: SvgShape; before: SvgDoc }
  | {
      mode: 'rotate'
      id: string
      orig: SvgShape
      before: SvgDoc
      center: Pt
      startPointerAngle: number
    }
  | { mode: 'pan'; startClientX: number; startClientY: number; startVb: { x: number; y: number; w: number } }
  | { mode: 'marquee'; startX: number; startY: number; additive: boolean }
  | { mode: 'draw'; kind: DrawKind; startX: number; startY: number }
  | { mode: 'drawPath' }
  | null

type DrawDrag = Extract<DragState, { mode: 'draw' }>

/** 绘制中的形状预览（模块级纯函数，便于撤销栈无关的实时预览） */
function buildDraftShape(
  d: DrawDrag,
  pt: Pt,
  shift: boolean,
  snapOn: boolean,
  sides: number,
  st: { fill: string; stroke: string; strokeWidth: number },
): SvgShape | null {
  const sx = d.startX
  const sy = d.startY
  switch (d.kind) {
    case 'rect': {
      let w = Math.abs(pt.x - sx)
      let h = Math.abs(pt.y - sy)
      if (shift) {
        const m = Math.max(w, h)
        w = m
        h = m
      }
      let x = Math.min(sx, pt.x)
      let y = Math.min(sy, pt.y)
      if (snapOn) {
        x = snapTo(x, 10)
        y = snapTo(y, 10)
        w = Math.max(10, snapTo(w, 10))
        h = Math.max(10, snapTo(h, 10))
      }
      if (w < 2 || h < 2) return null
      return { id: 'draft', kind: 'rect', x, y, w, h, fill: st.fill, stroke: st.stroke, strokeWidth: st.strokeWidth }
    }
    case 'circle': {
      let r = Math.hypot(pt.x - sx, pt.y - sy)
      if (snapOn) r = Math.max(10, snapTo(r, 10))
      if (r < 2) return null
      return { id: 'draft', kind: 'circle', cx: sx, cy: sy, r, fill: st.fill, stroke: st.stroke, strokeWidth: st.strokeWidth }
    }
    case 'ellipse': {
      let rx = Math.abs(pt.x - sx)
      let ry = Math.abs(pt.y - sy)
      if (shift) {
        const m = Math.max(rx, ry)
        rx = m
        ry = m
      }
      if (snapOn) {
        rx = Math.max(10, snapTo(rx, 10))
        ry = Math.max(10, snapTo(ry, 10))
      }
      if (rx < 2 || ry < 2) return null
      return {
        id: 'draft',
        kind: 'ellipse',
        cx: sx,
        cy: sy,
        rx,
        ry,
        fill: st.fill,
        stroke: st.stroke,
        strokeWidth: st.strokeWidth,
      }
    }
    case 'line':
    case 'arrow': {
      let end = pt
      if (shift) end = lock45({ x: sx, y: sy }, pt)
      else if (snapOn) end = { x: snapTo(end.x, 10), y: snapTo(end.y, 10) }
      if (Math.hypot(end.x - sx, end.y - sy) < 2) return null
      return {
        id: 'draft',
        kind: 'line',
        x1: sx,
        y1: sy,
        x2: end.x,
        y2: end.y,
        arrow: d.kind === 'arrow',
        fill: 'none',
        stroke: st.stroke,
        strokeWidth: st.strokeWidth,
      }
    }
    case 'polygon': {
      let r = Math.hypot(pt.x - sx, pt.y - sy)
      if (snapOn) r = Math.max(10, snapTo(r, 10))
      if (r < 3) return null
      const a0 = (Math.atan2(pt.y - sy, pt.x - sx) * 180) / Math.PI
      return {
        id: 'draft',
        kind: 'polygon',
        pts: regularPolygonPts(sx, sy, r, sides, a0),
        fill: st.fill,
        stroke: st.stroke,
        strokeWidth: st.strokeWidth,
      }
    }
  }
}

/** 单击（未拖动）时按默认尺寸落一个形状 */
function defaultShapeForClick(
  d: DrawDrag,
  sides: number,
  st: { fill: string; stroke: string; strokeWidth: number },
): SvgShape {
  const sx = d.startX
  const sy = d.startY
  switch (d.kind) {
    case 'rect':
      return { id: 'draft', kind: 'rect', x: sx - 60, y: sy - 30, w: 120, h: 60, fill: st.fill, stroke: st.stroke, strokeWidth: st.strokeWidth }
    case 'circle':
      return { id: 'draft', kind: 'circle', cx: sx, cy: sy, r: 40, fill: st.fill, stroke: st.stroke, strokeWidth: st.strokeWidth }
    case 'ellipse':
      return { id: 'draft', kind: 'ellipse', cx: sx, cy: sy, rx: 60, ry: 35, fill: st.fill, stroke: st.stroke, strokeWidth: st.strokeWidth }
    case 'line':
    case 'arrow':
      return {
        id: 'draft',
        kind: 'line',
        x1: sx - 60,
        y1: sy,
        x2: sx + 60,
        y2: sy,
        arrow: d.kind === 'arrow',
        fill: 'none',
        stroke: st.stroke,
        strokeWidth: st.strokeWidth,
      }
    case 'polygon':
      return {
        id: 'draft',
        kind: 'polygon',
        pts: regularPolygonPts(sx, sy, 40, sides, -90),
        fill: st.fill,
        stroke: st.stroke,
        strokeWidth: st.strokeWidth,
      }
  }
}

// ============================================================
// 八、主组件
// ============================================================

const TOOLS: { id: ToolId; label: string; icon: LucideIcon; iconCls?: string }[] = [
  { id: 'select', label: '选择', icon: MousePointer2 },
  { id: 'pan', label: '抓手', icon: Hand },
  { id: 'rect', label: '矩形', icon: Square },
  { id: 'circle', label: '圆', icon: CircleIcon },
  { id: 'ellipse', label: '椭圆', icon: CircleIcon, iconCls: 'scale-x-150' },
  { id: 'line', label: '直线', icon: Minus },
  { id: 'arrow', label: '箭头', icon: ArrowRight },
  { id: 'polygon', label: '多边形', icon: Hexagon },
  { id: 'polyline', label: '折线', icon: Spline },
  { id: 'path', label: '画笔', icon: Pencil },
  { id: 'text', label: '文字', icon: TypeIcon },
]

const LAYER_ICON: Record<SvgShape['kind'], LucideIcon> = {
  rect: Square,
  circle: CircleIcon,
  ellipse: CircleIcon,
  line: Minus,
  text: TypeIcon,
  polygon: Hexagon,
  polyline: Spline,
  path: Pencil,
}

function layerLabel(s: SvgShape): string {
  if (s.kind === 'text') return `文字「${s.text.slice(0, 12)}」`
  const b = shapeBBox(s)
  return `${KIND_LABEL[s.kind]} · ${Math.round(b.w)}×${Math.round(b.h)}`
}

const CANVAS_PRESETS: { w: number; h: number }[] = [
  { w: 600, h: 400 },
  { w: 800, h: 600 },
  { w: 1080, h: 720 },
]

const ALIGNS: { id: AlignMode; title: string; icon: LucideIcon }[] = [
  { id: 'l', title: '左对齐', icon: AlignStartVertical },
  { id: 'hc', title: '水平居中', icon: AlignCenterVertical },
  { id: 'r', title: '右对齐', icon: AlignEndVertical },
  { id: 't', title: '上对齐', icon: AlignStartHorizontal },
  { id: 'vc', title: '垂直居中', icon: AlignCenterHorizontal },
  { id: 'b', title: '下对齐', icon: AlignEndHorizontal },
]

export function SvgVisualEditor({
  code,
  onChange,
}: {
  code: string
  onChange: (next: string) => void
}) {
  // ---------- 状态 ----------
  const [doc, setDoc] = React.useState<SvgDoc>(() => parseSvgCode(code))
  const [selectedIds, setSelectedIds] = React.useState<string[]>([])
  const [drag, setDrag] = React.useState<DragState>(null)
  const [tool, setTool] = React.useState<ToolId>('select')
  const [vb, setVb] = React.useState<{ x: number; y: number; w: number } | null>(null)
  const [containerSize, setContainerSize] = React.useState({ w: 0, h: 0 })
  const [showLayers, setShowLayers] = React.useState(false)
  const [showCanvas, setShowCanvas] = React.useState(false)
  const [grid, setGrid] = React.useState(false)
  const [snap, setSnap] = React.useState(false)
  const [polySides, setPolySides] = React.useState(6)
  const [draft, setDraftState] = React.useState<SvgShape | null>(null)
  const [draftPathPts, setDraftPathPtsState] = React.useState<Pt[]>([])
  const [pendingPts, setPendingPtsState] = React.useState<Pt[]>([])
  const [marquee, setMarqueeState] = React.useState<Box | null>(null)
  const [textEdit, setTextEditState] = React.useState<{ x: number; y: number; value: string } | null>(null)
  const [hoverPt, setHoverPt] = React.useState<Pt | null>(null)
  const [importPending, setImportPending] = React.useState<{ doc: SvgDoc; name: string } | null>(null)
  const [importError, setImportError] = React.useState<string | null>(null)
  const [histInfo, setHistInfo] = React.useState({ canUndo: false, canRedo: false })
  const [spaceDown, setSpaceDown] = React.useState(false)
  const [canvasW, setCanvasW] = React.useState(String(600))
  const [canvasH, setCanvasH] = React.useState(String(400))

  // ---------- refs ----------
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const svgRef = React.useRef<SVGSVGElement | null>(null)
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  const textInputRef = React.useRef<HTMLInputElement | null>(null)
  const textInputOverlayRef = React.useRef<HTMLInputElement | null>(null)
  /** 上一次同步给父级 / 从父级读入的源码：只有外部改动才重载画布 */
  const lastSyncRef = React.useRef<string>(code)
  /** 最新画布文档镜像（事件回调里读写，避免闭包过期） */
  const docRef = React.useRef<SvgDoc>(doc)
  React.useEffect(() => {
    docRef.current = doc
  }, [doc])
  /** 撤销 / 重做栈（元素数组快照，栈深 50） */
  const histRef = React.useRef<{ past: SvgDoc[]; future: SvgDoc[] }>({ past: [], future: [] })
  /** 属性连改合并窗口（滑杆 / 打字时避免历史栈爆满） */
  const coalesceRef = React.useRef<{ key: string; t: number } | null>(null)
  /** 编辑器内部剪贴板（Ctrl+C / Ctrl+V） */
  const clipRef = React.useRef<SvgShape[]>([])
  /** 新形状默认样式（跟随最近一次属性修改） */
  const lastStyleRef = React.useRef({ fill: '#ffffff', stroke: '#000000', strokeWidth: 2 })
  const lastTextSizeRef = React.useRef(18)
  const movedRef = React.useRef(false)
  /** 视图（100% 基准宽度，fit 时记录） */
  const fitWRef = React.useRef(0)
  const vbRef = React.useRef<{ x: number; y: number; w: number } | null>(null)
  /** 双指捏合跟踪 */
  const pointersRef = React.useRef(new Map<number, Pt>())
  const pinchRef = React.useRef<{ d0: number; s0: Pt; vb0: { x: number; y: number; w: number } } | null>(null)
  // 稳定回调所需的镜像
  const selectedIdsRef = React.useRef<string[]>([])
  const dragRef = React.useRef<DragState>(null)
  const toolRef = React.useRef<ToolId>('select')
  const snapRef = React.useRef(false)
  const polySidesRef = React.useRef(6)
  const draftRef = React.useRef<SvgShape | null>(null)
  const draftPathPtsRef = React.useRef<Pt[]>([])
  const pendingPtsRef = React.useRef<Pt[]>([])
  const marqueeRef = React.useRef<Box | null>(null)
  const textEditRef = React.useRef<{ x: number; y: number; value: string } | null>(null)

  // ---------- 状态 + 镜像同步 setter ----------
  const setSelectedIdsBoth = React.useCallback((ids: string[]) => {
    selectedIdsRef.current = ids
    setSelectedIds(ids)
  }, [])
  const beginDrag = React.useCallback((d: DragState) => {
    dragRef.current = d
    setDrag(d)
  }, [])
  const endDrag = React.useCallback(() => {
    dragRef.current = null
    setDrag(null)
  }, [])
  const applyTool = React.useCallback((t: ToolId) => {
    toolRef.current = t
    setTool(t)
  }, [])
  const setSnapBoth = React.useCallback((v: boolean) => {
    snapRef.current = v
    setSnap(v)
  }, [])
  const setPolySidesBoth = React.useCallback((n: number) => {
    const v = Math.round(clamp(n, 3, 8))
    polySidesRef.current = v
    setPolySides(v)
  }, [])
  const setDraftBoth = React.useCallback((s: SvgShape | null) => {
    draftRef.current = s
    setDraftState(s)
  }, [])
  const setDraftPathPtsBoth = React.useCallback((pts: Pt[]) => {
    draftPathPtsRef.current = pts
    setDraftPathPtsState(pts)
  }, [])
  const setPendingPtsBoth = React.useCallback((pts: Pt[]) => {
    pendingPtsRef.current = pts
    setPendingPtsState(pts)
  }, [])
  const setMarqueeBoth = React.useCallback((b: Box | null) => {
    marqueeRef.current = b
    setMarqueeState(b)
  }, [])
  const applyVb = React.useCallback((v: { x: number; y: number; w: number }) => {
    vbRef.current = v
    setVb(v)
  }, [])

  // ---------- 基础流程：emit / 历史 ----------
  const syncHistInfo = React.useCallback(() => {
    setHistInfo({
      canUndo: histRef.current.past.length > 0,
      canRedo: histRef.current.future.length > 0,
    })
  }, [])

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

  /** 拖拽等连续操作结束时只同步源码（doc 已实时更新） */
  const flushEmit = React.useCallback(() => {
    const out = serializeSvgDoc(docRef.current)
    if (out !== lastSyncRef.current) {
      lastSyncRef.current = out
      onChange(out)
    }
  }, [onChange])

  const pushHistory = React.useCallback((before: SvgDoc, coalesceKey?: string) => {
    const now = Date.now()
    const last = coalesceRef.current
    if (coalesceKey && last && last.key === coalesceKey && now - last.t < 800) {
      coalesceRef.current = { key: coalesceKey, t: now }
      return
    }
    coalesceRef.current = coalesceKey ? { key: coalesceKey, t: now } : null
    const past = [...histRef.current.past, before]
    if (past.length > 50) past.splice(0, past.length - 50)
    histRef.current = { past, future: [] }
    syncHistInfo()
  }, [syncHistInfo])

  /** 提交一次文档变更（入历史 + 同步父级） */
  const commit = React.useCallback(
    (next: SvgDoc, before?: SvgDoc, coalesceKey?: string) => {
      pushHistory(before ?? docRef.current, coalesceKey)
      emit(next)
    },
    [pushHistory, emit],
  )

  const undo = React.useCallback(() => {
    if (dragRef.current) return
    const h = histRef.current
    if (h.past.length === 0) return
    const prev = h.past[h.past.length - 1]
    histRef.current = { past: h.past.slice(0, -1), future: [docRef.current, ...h.future].slice(0, 50) }
    coalesceRef.current = null
    syncHistInfo()
    emit(prev)
    const alive = new Set(prev.shapes.map((s) => s.id))
    setSelectedIdsBoth(selectedIdsRef.current.filter((i) => alive.has(i)))
  }, [emit, syncHistInfo, setSelectedIdsBoth])

  const redo = React.useCallback(() => {
    if (dragRef.current) return
    const h = histRef.current
    if (h.future.length === 0) return
    const next = h.future[0]
    histRef.current = { past: [...h.past, docRef.current].slice(-50), future: h.future.slice(1) }
    coalesceRef.current = null
    syncHistInfo()
    emit(next)
    const alive = new Set(next.shapes.map((s) => s.id))
    setSelectedIdsBoth(selectedIdsRef.current.filter((i) => alive.has(i)))
  }, [emit, syncHistInfo, setSelectedIdsBoth])

  // ---------- 视图：fit / 缩放 / 平移 ----------
  const toSvgXY = React.useCallback((clientX: number, clientY: number): Pt | null => {
    const svg = svgRef.current
    if (!svg) return null
    const ctm = svg.getScreenCTM()
    if (!ctm) return null
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse())
    return { x: p.x, y: p.y }
  }, [])

  const currentVb = React.useCallback((): { x: number; y: number; w: number } => {
    const v = vbRef.current
    if (v) return v
    const d = docRef.current
    return { x: -d.width * 0.05, y: -d.height * 0.05, w: d.width * 1.1 }
  }, [])

  const fitView = React.useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const cw = el.clientWidth || 1
    const ch = el.clientHeight || 1
    const d = docRef.current
    let bb: Box | null = null
    for (const s of d.shapes) {
      const b = shapeBBox(s)
      bb = bb ? unionBox(bb, b) : b
    }
    if (!bb) bb = { x: 0, y: 0, w: d.width, h: d.height }
    const pad = Math.max(bb.w, bb.h) * 0.08 + 10
    const bw = Math.max(bb.w + pad * 2, 20)
    const bh = Math.max(bb.h + pad * 2, 20)
    const base = cw / d.width
    const scale = Math.min(Math.max(Math.min(cw / bw, ch / bh), base * 0.25), base * 4)
    const w = cw / scale
    const h = ch / scale
    fitWRef.current = w
    applyVb({ x: bb.x + bb.w / 2 - w / 2, y: bb.y + bb.h / 2 - h / 2, w })
  }, [applyVb])

  const zoomAt = React.useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const el = containerRef.current
      if (!el) return
      const cw = el.clientWidth || 1
      const ch = el.clientHeight || 1
      const v = currentVb()
      const pt = toSvgXY(clientX, clientY)
      if (!pt) return
      const fit = fitWRef.current || v.w
      const nw = clamp(v.w * factor, fit / 4, fit * 4)
      if (Math.abs(nw - v.w) < 1e-6) return
      const nh = (nw * ch) / cw
      const fx = (pt.x - v.x) / v.w
      const fy = (pt.y - v.y) / ((v.w * ch) / cw)
      applyVb({ x: pt.x - fx * nw, y: pt.y - fy * nh, w: nw })
    },
    [toSvgXY, currentVb, applyVb],
  )

  const zoomAtCenter = React.useCallback(
    (factor: number) => {
      const el = containerRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor)
    },
    [zoomAt],
  )

  const resetZoom = React.useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const cw = el.clientWidth || 1
    const ch = el.clientHeight || 1
    const v = currentVb()
    const w = fitWRef.current || v.w
    const cx = v.x + v.w / 2
    const cy = v.y + (v.w * ch) / cw / 2
    applyVb({ x: cx - w / 2, y: cy - (w * ch) / cw / 2, w })
  }, [currentVb, applyVb])

  // ---------- 外部源码变化 → 重载画布 ----------
  React.useEffect(() => {
    if (code !== lastSyncRef.current) {
      lastSyncRef.current = code
      const next = parseSvgCode(code)
      docRef.current = next
      setDoc(next)
      setSelectedIdsBoth([])
      endDrag()
      setDraftBoth(null)
      setMarqueeBoth(null)
      setDraftPathPtsBoth([])
      setPendingPtsBoth([])
      setTextEditState(null)
      textEditRef.current = null
      histRef.current = { past: [], future: [] }
      coalesceRef.current = null
      syncHistInfo()
      requestAnimationFrame(() => fitView())
    }
  }, [code, setSelectedIdsBoth, endDrag, setDraftBoth, setMarqueeBoth, setDraftPathPtsBoth, setPendingPtsBoth, syncHistInfo, fitView])

  // ---------- 容器测量 + 挂载 fit ----------
  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    fitView()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [fitView])

  // ---------- 滚轮缩放（非被动监听以阻止页面滚动） ----------
  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  // ---------- 切换工具时清理未完成的绘制 ----------
  React.useEffect(() => {
    setDraftBoth(null)
    setMarqueeBoth(null)
    setDraftPathPtsBoth([])
    setPendingPtsBoth([])
    setTextEditState(null)
    textEditRef.current = null
    setHoverPt(null)
  }, [tool, setDraftBoth, setMarqueeBoth, setDraftPathPtsBoth, setPendingPtsBoth])

  // ---------- 画布尺寸输入同步 ----------
  React.useEffect(() => {
    setCanvasW(String(doc.width))
    setCanvasH(String(doc.height))
  }, [doc.width, doc.height])

  // ---------- 就地文字输入聚焦 ----------
  const prevTextEditOpenRef = React.useRef(false)
  React.useEffect(() => {
    const opened = !!textEdit
    if (opened && !prevTextEditOpenRef.current) {
      requestAnimationFrame(() => textInputOverlayRef.current?.focus())
    }
    prevTextEditOpenRef.current = opened
  }, [textEdit])

  // ---------- 增删改操作 ----------
  const patchShapesById = React.useCallback(
    (ids: string[], fn: (s: SvgShape) => SvgShape, coalesceKey?: string) => {
      if (ids.length === 0) return
      const before = docRef.current
      const set = new Set(ids)
      const shapes = before.shapes.map((s) => (set.has(s.id) ? fn(s) : s))
      if (shapes.every((s, i) => s === before.shapes[i])) return // 无实际变化（字段不适用）→ 不入历史
      commit({ ...before, shapes }, before, coalesceKey)
    },
    [commit],
  )

  const patchSelected = React.useCallback(
    (fn: (s: SvgShape) => SvgShape, coalesceKey?: string) => {
      patchShapesById(selectedIdsRef.current, fn, coalesceKey)
    },
    [patchShapesById],
  )

  const deleteSelected = React.useCallback(() => {
    const ids = new Set(selectedIdsRef.current)
    if (ids.size === 0) return
    const before = docRef.current
    commit({ ...before, shapes: before.shapes.filter((s) => !ids.has(s.id)) }, before)
    setSelectedIdsBoth([])
  }, [commit, setSelectedIdsBoth])

  const pasteShapes = React.useCallback(
    (list: SvgShape[]) => {
      if (list.length === 0) return
      const before = docRef.current
      const copies = list.map((s) => ({
        ...translateShape(cloneShape(s), 12, 12),
        id: nextShapeId(s.kind),
      }))
      commit({ ...before, shapes: [...before.shapes, ...copies] }, before)
      setSelectedIdsBoth(copies.map((c) => c.id))
    },
    [commit, setSelectedIdsBoth],
  )

  const copySelection = React.useCallback(() => {
    const ids = new Set(selectedIdsRef.current)
    const list = docRef.current.shapes.filter((s) => ids.has(s.id))
    if (list.length === 0) return
    clipRef.current = list.map(cloneShape)
    toast.success(`已复制 ${list.length} 个元素，Ctrl+V 粘贴`)
  }, [])

  const pasteFromClipboard = React.useCallback(() => {
    if (clipRef.current.length === 0) return
    pasteShapes(clipRef.current)
  }, [pasteShapes])

  const duplicateSelection = React.useCallback(() => {
    const ids = new Set(selectedIdsRef.current)
    const list = docRef.current.shapes.filter((s) => ids.has(s.id))
    if (list.length === 0) return
    pasteShapes(list)
  }, [pasteShapes])

  const selectAll = React.useCallback(() => {
    applyTool('select')
    setSelectedIdsBoth(docRef.current.shapes.map((s) => s.id))
  }, [applyTool, setSelectedIdsBoth])

  const nudgeSelection = React.useCallback(
    (dx: number, dy: number) => {
      const ids = new Set(selectedIdsRef.current)
      if (ids.size === 0) return
      const before = docRef.current
      const shapes = before.shapes.map((s) => (ids.has(s.id) ? translateShape(s, dx, dy) : s))
      commit({ ...before, shapes }, before, 'nudge')
    },
    [commit],
  )

  const zChange = React.useCallback(
    (id: string, dir: 'up' | 'down' | 'top' | 'bottom') => {
      const before = docRef.current
      const idx = before.shapes.findIndex((s) => s.id === id)
      if (idx === -1) return
      const arr = [...before.shapes]
      const [it] = arr.splice(idx, 1)
      const nIdx =
        dir === 'up' ? Math.min(arr.length, idx + 1) : dir === 'down' ? Math.max(0, idx - 1) : dir === 'top' ? arr.length : 0
      arr.splice(nIdx, 0, it)
      commit({ ...before, shapes: arr }, before)
    },
    [commit],
  )

  const alignSelection = React.useCallback(
    (mode: AlignMode) => {
      const ids = new Set(selectedIdsRef.current)
      const sel = docRef.current.shapes.filter((s) => ids.has(s.id))
      if (sel.length < 2) return
      const boxes = sel.map(shapeBBox)
      const total = boxes.reduce(unionBox)
      const before = docRef.current
      const shapes = before.shapes.map((s) => {
        const i = sel.findIndex((o) => o.id === s.id)
        if (i < 0) return s
        const b = boxes[i]
        let dx = 0
        let dy = 0
        if (mode === 'l') dx = total.x - b.x
        else if (mode === 'hc') dx = total.x + total.w / 2 - (b.x + b.w / 2)
        else if (mode === 'r') dx = total.x + total.w - (b.x + b.w)
        else if (mode === 't') dy = total.y - b.y
        else if (mode === 'vc') dy = total.y + total.h / 2 - (b.y + b.h / 2)
        else dy = total.y + total.h - (b.y + b.h)
        return translateShape(s, dx, dy)
      })
      commit({ ...before, shapes }, before)
    },
    [commit],
  )

  const toggleVisible = React.useCallback(
    (id: string) => {
      const before = docRef.current
      const shapes = before.shapes.map((s) =>
        s.id === id ? { ...s, visible: s.visible === false ? undefined : false } : s,
      )
      commit({ ...before, shapes }, before)
    },
    [commit],
  )

  // ---------- 属性修改（单选 / 多选通用，多选时跳过不适用字段） ----------
  const setFill = (c: string) => {
    lastStyleRef.current = { ...lastStyleRef.current, fill: c }
    patchSelected((s) => (s.kind === 'line' ? s : ({ ...s, fill: c } as SvgShape)), 'fill')
  }
  const setStrokeColor = (c: string) => {
    lastStyleRef.current = { ...lastStyleRef.current, stroke: c }
    patchSelected((s) => (s.kind === 'text' ? s : ({ ...s, stroke: c } as SvgShape)), 'stroke')
  }
  const setStrokeWidth = (w: number) => {
    lastStyleRef.current = { ...lastStyleRef.current, strokeWidth: w }
    patchSelected((s) => (s.kind === 'text' ? s : ({ ...s, strokeWidth: w } as SvgShape)), 'width')
  }
  const setOpacity = (o: number) => {
    patchSelected((s) => ({ ...s, opacity: o } as SvgShape), 'opacity')
  }
  const setDashStyle = (v: DashStyle) => {
    patchSelected((s) => (s.kind === 'text' ? s : ({ ...s, dash: v } as SvgShape)), 'dash')
  }
  const setLinecap = (v: LineCap) => {
    patchSelected((s) => (LINE_LIKE.has(s.kind) ? ({ ...s, linecap: v } as SvgShape) : s), 'linecap')
  }
  const setTextValue = (t: string) => {
    patchSelected((s) => (s.kind === 'text' ? ({ ...s, text: t } as SvgShape) : s), 'text')
  }
  const setTextSize = (n: number) => {
    lastTextSizeRef.current = n
    patchSelected((s) => (s.kind === 'text' ? ({ ...s, size: n } as SvgShape) : s), 'size')
  }
  const setArrowOn = (b: boolean) => {
    patchSelected((s) => (s.kind === 'line' ? { ...s, arrow: b } : s))
  }
  const setRotation = (deg: number) => {
    patchSelected(
      (s) => (ROTATABLE.has(s.kind) ? ({ ...s, rotation: ((deg % 360) + 360) % 360 } as SvgShape) : s),
      'rotation',
    )
  }
  const setRx = (v: number) => {
    patchSelected((s) => (s.kind === 'rect' ? ({ ...s, rx: v } as SvgShape) : s), 'rx')
  }
  const setSides = (n: number) => {
    setPolySidesBoth(n)
    patchSelected((s) => (s.kind === 'polygon' ? regenRegularPolygon(s, n) : s), 'sides')
  }

  // ---------- 画布尺寸 ----------
  const applyCanvasSize = React.useCallback(
    (w: number, h: number) => {
      const cw = clamp(Math.round(w), 200, 2000)
      const chh = clamp(Math.round(h), 200, 2000)
      setCanvasW(String(cw))
      setCanvasH(String(chh))
      const before = docRef.current
      if (before.width === cw && before.height === chh) return
      commit({ ...before, width: cw, height: chh }, before)
      requestAnimationFrame(() => fitView())
    },
    [commit, fitView],
  )

  const applyCanvasInputs = () => {
    const w = parseInt(canvasW, 10)
    const h = parseInt(canvasH, 10)
    if (!Number.isFinite(w) || !Number.isFinite(h)) {
      setCanvasW(String(docRef.current.width))
      setCanvasH(String(docRef.current.height))
      return
    }
    applyCanvasSize(w, h)
  }

  // ---------- 文件导入 ----------
  const applyImportDoc = React.useCallback(
    (d: SvgDoc, mode: 'replace' | 'append', name?: string) => {
      setImportPending(null)
      const before = docRef.current
      const next: SvgDoc =
        mode === 'replace'
          ? { ...d }
          : { ...before, shapes: [...before.shapes, ...d.shapes], raw: [...before.raw, ...d.raw] }
      commit(next, before)
      setSelectedIdsBoth([])
      applyTool('select')
      if (mode === 'replace') requestAnimationFrame(() => fitView())
      const label = name ? `「${name}」` : ''
      toast.success(mode === 'replace' ? `已导入${label}，共 ${next.shapes.length + next.raw.length} 个元素` : `已追加导入 ${d.shapes.length + d.raw.length} 个元素`)
    },
    [commit, setSelectedIdsBoth, applyTool, fitView],
  )

  const handleImportFile = async (f: File) => {
    setImportError(null)
    let text = ''
    try {
      text = await f.text()
    } catch {
      setImportError('SVG 文件读取失败，请重试')
      return
    }
    const parsed = parseSvgCode(text)
    if (parsed.parseError) {
      setImportError('SVG 文件解析失败：不是有效的 SVG 文本')
      return
    }
    const cur = docRef.current
    if (cur.shapes.length === 0 && cur.raw.length === 0) {
      applyImportDoc(parsed, 'replace', f.name)
      return
    }
    setImportPending({ doc: parsed, name: f.name })
  }

  // ---------- 导出 ----------
  const downloadSvg = () => {
    const out = serializeSvgDoc(docRef.current)
    const blob = new Blob([out], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const ts = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    a.download = `svg-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}.svg`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    toast.success('已下载 SVG 文件')
  }

  const copySource = async () => {
    const out = serializeSvgDoc(docRef.current)
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(out)
        toast.success('已复制 SVG 源码到剪贴板')
        return
      }
      throw new Error('no clipboard')
    } catch {
      // 降级：临时 textarea + execCommand
      try {
        const ta = document.createElement('textarea')
        ta.value = out
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
        toast.success('已复制 SVG 源码到剪贴板')
      } catch {
        toast.error('复制失败，请切换到「源码」页手动复制')
      }
    }
  }

  // ---------- 折线（连续点击加点） ----------
  const finishPolyline = React.useCallback(() => {
    let pts = pendingPtsRef.current
    setPendingPtsBoth([])
    setHoverPt(null)
    if (pts.length >= 2) {
      const a = pts[pts.length - 1]
      const b = pts[pts.length - 2]
      // 双击结束时会重复加入末点，去掉
      if (Math.hypot(a.x - b.x, a.y - b.y) < 2) pts = pts.slice(0, -1)
      if (pts.length >= 2) {
        const shape: SvgShape = {
          id: nextShapeId('polyline'),
          kind: 'polyline',
          pts,
          fill: 'none',
          stroke: lastStyleRef.current.stroke,
          strokeWidth: lastStyleRef.current.strokeWidth,
        }
        const before = docRef.current
        pushHistory(before)
        emit({ ...before, shapes: [...before.shapes, shape] })
        setSelectedIdsBoth([shape.id])
        applyTool('select')
      }
    }
  }, [setPendingPtsBoth, pushHistory, emit, setSelectedIdsBoth, applyTool])

  // ---------- 就地文字输入 ----------
  const openTextEdit = React.useCallback((te: { x: number; y: number; value: string }) => {
    textEditRef.current = te
    setTextEditState(te)
  }, [])

  const closeTextEdit = React.useCallback(() => {
    textEditRef.current = null
    setTextEditState(null)
  }, [])

  const commitText = () => {
    const te = textEditRef.current
    if (!te) return
    closeTextEdit()
    const value = te.value.trim()
    if (!value) return
    const before = docRef.current
    const shape: SvgShape = {
      id: nextShapeId('text'),
      kind: 'text',
      x: te.x,
      y: te.y,
      text: value,
      size: lastTextSizeRef.current,
      fill: /^#[0-9a-fA-F]{6}$/.test(lastStyleRef.current.stroke) ? lastStyleRef.current.stroke : '#000000',
      stroke: 'none',
      strokeWidth: 0,
    }
    commit({ ...before, shapes: [...before.shapes, shape] }, before)
    setSelectedIdsBoth([shape.id])
    applyTool('select')
  }

  // ---------- 手势取消 ----------
  const cancelGesture = React.useCallback(
    (restore: boolean) => {
      const d = dragRef.current
      if (
        restore &&
        d &&
        (d.mode === 'move' || d.mode === 'resize' || d.mode === 'endpoint' || d.mode === 'rotate')
      ) {
        docRef.current = d.before
        setDoc(d.before)
      }
      endDrag()
      setDraftBoth(null)
      setMarqueeBoth(null)
      setDraftPathPtsBoth([])
      movedRef.current = false
    },
    [endDrag, setDraftBoth, setMarqueeBoth, setDraftPathPtsBoth],
  )

  const handleEscapeKey = React.useCallback(() => {
    if (textEditRef.current) {
      closeTextEdit()
      return
    }
    if (dragRef.current) {
      cancelGesture(true)
      return
    }
    if (pendingPtsRef.current.length > 0) {
      setPendingPtsBoth([])
      setHoverPt(null)
      return
    }
    if (toolRef.current !== 'select') {
      applyTool('select')
      return
    }
    setSelectedIdsBoth([])
  }, [closeTextEdit, cancelGesture, setPendingPtsBoth, applyTool, setSelectedIdsBoth])

  // ---------- 画布 / 元素 pointer 事件 ----------
  const startShapePointer = (e: React.PointerEvent, s: SvgShape) => {
    if (tool !== 'select' || spaceDown || e.button === 1 || e.button === 2) return
    if (pointersRef.current.size >= 2 || pinchRef.current) return
    e.stopPropagation()
    const pt = toSvgXY(e.clientX, e.clientY)
    if (!pt) return
    let ids = selectedIds
    if (e.shiftKey) {
      if (ids.includes(s.id)) {
        setSelectedIdsBoth(ids.filter((i) => i !== s.id))
        return
      }
      ids = [...ids, s.id]
    } else if (!ids.includes(s.id)) {
      ids = [s.id]
    }
    setSelectedIdsBoth(ids)
    const origs = docRef.current.shapes.filter((sh) => ids.includes(sh.id))
    movedRef.current = false
    beginDrag({ mode: 'move', ids, startX: pt.x, startY: pt.y, origs, before: docRef.current })
    svgRef.current?.setPointerCapture(e.pointerId)
  }

  const startHandleDrag = (e: React.PointerEvent, mode: 'resize' | 'endpoint' | 'rotate', which: 1 | 2 = 2) => {
    e.stopPropagation()
    if (toolRef.current !== 'select') return
    const ids = selectedIdsRef.current
    if (ids.length !== 1) return
    const s = docRef.current.shapes.find((x) => x.id === ids[0])
    if (!s) return
    movedRef.current = false
    const before = docRef.current
    if (mode === 'resize') {
      if (s.kind !== 'rect' && s.kind !== 'circle' && s.kind !== 'ellipse') return
      beginDrag({ mode: 'resize', id: s.id, orig: s, before })
    } else if (mode === 'endpoint') {
      if (s.kind !== 'line') return
      beginDrag({ mode: 'endpoint', id: s.id, which, orig: s, before })
    } else {
      if (!ROTATABLE.has(s.kind)) return
      const bb = shapeBBox(s)
      const pt = toSvgXY(e.clientX, e.clientY)
      if (!pt) return
      const center = { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 }
      beginDrag({
        mode: 'rotate',
        id: s.id,
        orig: s,
        before,
        center,
        startPointerAngle: (Math.atan2(pt.y - center.y, pt.x - center.x) * 180) / Math.PI,
      })
    }
    svgRef.current?.setPointerCapture(e.pointerId)
  }

  const onCanvasPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button === 2) return
    if (pointersRef.current.size >= 2 || pinchRef.current) return
    const pt = toSvgXY(e.clientX, e.clientY)
    if (!pt) return
    // 中键 / 空格 / 抓手工具 → 平移画布
    if (e.button === 1 || spaceDown || tool === 'pan') {
      e.preventDefault()
      const v = currentVb()
      movedRef.current = false
      beginDrag({ mode: 'pan', startClientX: e.clientX, startClientY: e.clientY, startVb: { x: v.x, y: v.y, w: v.w } })
      svgRef.current?.setPointerCapture(e.pointerId)
      return
    }
    if (tool === 'select') {
      // 空白处按下：可能取消选择（抬起未拖动）或拖框选择
      movedRef.current = false
      setMarqueeBoth(null)
      beginDrag({ mode: 'marquee', startX: pt.x, startY: pt.y, additive: e.shiftKey })
      svgRef.current?.setPointerCapture(e.pointerId)
      return
    }
    if (tool === 'text') {
      // 有未确认的就地输入 → 先确认，本次点击不落新输入框
      if (textEditRef.current) {
        commitText()
        return
      }
      // 点在已有文字上 → 选中并聚焦侧栏编辑
      const shapeEl = (e.target as Element).closest('[data-shape-id]')
      if (shapeEl) {
        const id = shapeEl.getAttribute('data-shape-id') || ''
        const hit = docRef.current.shapes.find((x) => x.id === id)
        if (hit?.kind === 'text') {
          applyTool('select')
          setSelectedIdsBoth([id])
          requestAnimationFrame(() => textInputRef.current?.focus())
          return
        }
      }
      const sp = snapRef.current ? snapPtTo(pt, 10) : pt
      openTextEdit({ x: sp.x, y: sp.y, value: '' })
      return
    }
    if (tool === 'polyline') {
      const sp = snapRef.current ? snapPtTo(pt, 10) : pt
      setPendingPtsBoth([...pendingPtsRef.current, sp])
      return
    }
    if (tool === 'path') {
      movedRef.current = false
      setDraftPathPtsBoth([pt])
      beginDrag({ mode: 'drawPath' })
      svgRef.current?.setPointerCapture(e.pointerId)
      return
    }
    // 形状绘制工具（rect / circle / ellipse / line / arrow / polygon）
    movedRef.current = false
    setDraftBoth(null)
    beginDrag({ mode: 'draw', kind: tool, startX: pt.x, startY: pt.y })
    svgRef.current?.setPointerCapture(e.pointerId)
  }

  const onCanvasPointerMove = (e: React.PointerEvent) => {
    // 折线工具：鼠标悬停时显示橡皮筋预览线
    if (tool === 'polyline' && pendingPts.length > 0 && e.pointerType === 'mouse' && !drag) {
      const pt = toSvgXY(e.clientX, e.clientY)
      setHoverPt(pt)
    }
  }

  const onCanvasDoubleClick = () => {
    if (tool === 'polyline') finishPolyline()
  }

  // ---------- 双指捏合（capture 阶段跟踪指针） ----------
  const onContainerPointerDownCapture = (e: React.PointerEvent) => {
    if (e.button === 2) return
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointersRef.current.size === 2) {
      // 第二根手指落下：取消当前手势，进入捏合缩放
      cancelGesture(true)
      const pts = [...pointersRef.current.values()]
      const a = pts[0]
      const b = pts[1]
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const p = toSvgXY(mid.x, mid.y)
      pinchRef.current = {
        d0: Math.max(10, Math.hypot(b.x - a.x, b.y - a.y)),
        s0: p ?? { x: 0, y: 0 },
        vb0: currentVb(),
      }
    }
  }

  const onContainerPointerMoveCapture = (e: React.PointerEvent) => {
    if (!pointersRef.current.has(e.pointerId)) return
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const pinch = pinchRef.current
    if (!pinch) return
    const pts = [...pointersRef.current.values()]
    if (pts.length < 2) return
    const a = pts[0]
    const b = pts[1]
    const el = containerRef.current
    if (!el) return
    const cw = el.clientWidth || 1
    const ch = el.clientHeight || 1
    const rect = el.getBoundingClientRect()
    const d1 = Math.max(10, Math.hypot(b.x - a.x, b.y - a.y))
    const fit = fitWRef.current || pinch.vb0.w
    const nw = clamp(pinch.vb0.w * (pinch.d0 / d1), fit / 4, fit * 4)
    const nh = (nw * ch) / cw
    const midX = (a.x + b.x) / 2 - rect.left
    const midY = (a.y + b.y) / 2 - rect.top
    applyVb({ x: pinch.s0.x - (midX / cw) * nw, y: pinch.s0.y - (midY / ch) * nh, w: nw })
  }

  const onContainerPointerUpCapture = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId)
    if (pointersRef.current.size < 2) pinchRef.current = null
  }

  // ---------- 拖拽主循环（window 监听 → 鼠标 / 触摸通用） ----------
  React.useEffect(() => {
    if (!drag) return
    const d = drag
    const replaceShape = (id: string, next: SvgShape) => {
      const prev = docRef.current
      const shapes = prev.shapes.map((s) => (s.id === id ? next : s))
      const nextDoc = { ...prev, shapes }
      docRef.current = nextDoc
      setDoc(nextDoc)
    }
    const onMove = (e: PointerEvent) => {
      switch (d.mode) {
        case 'pan': {
          const el = containerRef.current
          if (!el) break
          const k = d.startVb.w / (el.clientWidth || 1)
          applyVb({
            x: d.startVb.x - (e.clientX - d.startClientX) * k,
            y: d.startVb.y - (e.clientY - d.startClientY) * k,
            w: d.startVb.w,
          })
          break
        }
        case 'marquee': {
          const pt = toSvgXY(e.clientX, e.clientY)
          if (!pt) break
          if (!movedRef.current && Math.hypot(pt.x - d.startX, pt.y - d.startY) > 4) movedRef.current = true
          if (movedRef.current) {
            setMarqueeBoth({
              x: Math.min(d.startX, pt.x),
              y: Math.min(d.startY, pt.y),
              w: Math.abs(pt.x - d.startX),
              h: Math.abs(pt.y - d.startY),
            })
          }
          break
        }
        case 'move': {
          const pt = toSvgXY(e.clientX, e.clientY)
          if (!pt) break
          let dx = pt.x - d.startX
          let dy = pt.y - d.startY
          if (e.shiftKey) {
            // Shift 拖动 → 锁定水平 / 垂直
            if (Math.abs(dx) > Math.abs(dy)) dy = 0
            else dx = 0
          }
          if (snapRef.current && d.origs.length > 0) {
            const b0 = shapeBBox(d.origs[0])
            dx = snapTo(b0.x + dx, 10) - b0.x
            dy = snapTo(b0.y + dy, 10) - b0.y
          }
          if (dx !== 0 || dy !== 0) movedRef.current = true
          const byId = new Map(d.origs.map((o) => [o.id, o]))
          const prev = docRef.current
          const shapes = prev.shapes.map((s) => {
            const o = byId.get(s.id)
            return o ? translateShape(o, dx, dy) : s
          })
          const nextDoc = { ...prev, shapes }
          docRef.current = nextDoc
          setDoc(nextDoc)
          break
        }
        case 'resize': {
          const pt = toSvgXY(e.clientX, e.clientY)
          if (!pt) break
          const o = d.orig
          let p = pt
          if (o.rotation) {
            const bb = shapeBBox(o)
            p = rotPt(pt, { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 }, -o.rotation)
          }
          let next: SvgShape = o
          if (o.kind === 'rect') {
            let w = Math.max(4, p.x - o.x)
            let h = Math.max(4, p.y - o.y)
            if (snapRef.current) {
              w = Math.max(10, snapTo(w, 10))
              h = Math.max(10, snapTo(h, 10))
            }
            next = { ...o, w, h }
          } else if (o.kind === 'circle') {
            let r = Math.max(2, Math.hypot(p.x - o.cx, p.y - o.cy))
            if (snapRef.current) r = Math.max(10, snapTo(r, 10))
            next = { ...o, r }
          } else if (o.kind === 'ellipse') {
            let rx = Math.max(2, Math.abs(p.x - o.cx))
            let ry = Math.max(2, Math.abs(p.y - o.cy))
            if (snapRef.current) {
              rx = Math.max(10, snapTo(rx, 10))
              ry = Math.max(10, snapTo(ry, 10))
            }
            next = { ...o, rx, ry }
          }
          if (next !== o) {
            movedRef.current = true
            replaceShape(o.id, next)
          }
          break
        }
        case 'endpoint': {
          const pt = toSvgXY(e.clientX, e.clientY)
          if (!pt) break
          const o = d.orig
          if (o.kind !== 'line') break
          const fixed = d.which === 1 ? { x: o.x2, y: o.y2 } : { x: o.x1, y: o.y1 }
          let end = pt
          if (o.rotation) {
            // 旋转过的直线：指针逆旋转回未旋转坐标系，保证端点跟手（与矩形 resize 同理）
            const bb = shapeBBox(o)
            end = rotPt(end, { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 }, -o.rotation)
          }
          if (e.shiftKey) end = lock45(fixed, end)
          else if (snapRef.current) end = { x: snapTo(end.x, 10), y: snapTo(end.y, 10) }
          const next: SvgShape =
            d.which === 1 ? { ...o, x1: end.x, y1: end.y } : { ...o, x2: end.x, y2: end.y }
          movedRef.current = true
          replaceShape(o.id, next)
          break
        }
        case 'rotate': {
          const pt = toSvgXY(e.clientX, e.clientY)
          if (!pt) break
          const ang = (Math.atan2(pt.y - d.center.y, pt.x - d.center.x) * 180) / Math.PI
          let rot = (d.orig.rotation ?? 0) + (ang - d.startPointerAngle)
          if (e.shiftKey) rot = Math.round(rot / 15) * 15
          const norm = ((rot % 360) + 360) % 360
          for (const c of [0, 90, 180, 270]) {
            if (Math.abs(norm - c) < 4) rot = c
          }
          rot = ((Math.round(rot) % 360) + 360) % 360
          movedRef.current = true
          replaceShape(d.id, { ...d.orig, rotation: rot } as SvgShape)
          break
        }
        case 'draw': {
          const pt = toSvgXY(e.clientX, e.clientY)
          if (!pt) break
          const s = buildDraftShape(d, pt, e.shiftKey, snapRef.current, polySidesRef.current, lastStyleRef.current)
          movedRef.current = s != null
          setDraftBoth(s)
          break
        }
        case 'drawPath': {
          const pt = toSvgXY(e.clientX, e.clientY)
          if (!pt) break
          const pts = draftPathPtsRef.current
          const last = pts[pts.length - 1]
          if (pts.length === 0 || !last || Math.hypot(pt.x - last.x, pt.y - last.y) > 1.5) {
            if (pts.length < 600) {
              const nx = [...pts, pt]
              setDraftPathPtsBoth(nx)
              if (nx.length >= 2) movedRef.current = true
            }
          }
          break
        }
      }
    }
    const finish = (cancelled: boolean) => {
      switch (d.mode) {
        case 'pan':
          break
        case 'marquee': {
          setMarqueeBoth(null)
          if (cancelled) break
          const m = marqueeRef.current
          if (movedRef.current && m) {
            const hit = docRef.current.shapes
              .filter((s) => s.visible !== false && boxIntersects(shapeBBox(s), m))
              .map((s) => s.id)
            setSelectedIdsBoth(d.additive ? Array.from(new Set([...selectedIdsRef.current, ...hit])) : hit)
          } else if (!d.additive) {
            setSelectedIdsBoth([])
          }
          break
        }
        case 'move':
        case 'resize':
        case 'endpoint':
        case 'rotate': {
          if (cancelled) {
            docRef.current = d.before
            setDoc(d.before)
            break
          }
          if (movedRef.current) {
            pushHistory(d.before)
            flushEmit()
          }
          break
        }
        case 'draw': {
          const s = draftRef.current ?? defaultShapeForClick(d, polySidesRef.current, lastStyleRef.current)
          setDraftBoth(null)
          if (cancelled || !s) break
          const shape: SvgShape = { ...s, id: nextShapeId(s.kind) }
          const before = docRef.current
          pushHistory(before)
          emit({ ...before, shapes: [...before.shapes, shape] })
          setSelectedIdsBoth([shape.id])
          applyTool('select')
          break
        }
        case 'drawPath': {
          const pts = draftPathPtsRef.current
          setDraftPathPtsBoth([])
          if (cancelled || pts.length < 2) break
          const shape: SvgShape = {
            id: nextShapeId('path'),
            kind: 'path',
            cmds: smoothPathCmds(pts),
            fill: 'none',
            stroke: lastStyleRef.current.stroke,
            strokeWidth: lastStyleRef.current.strokeWidth,
            linecap: 'round',
          }
          const before = docRef.current
          pushHistory(before)
          emit({ ...before, shapes: [...before.shapes, shape] })
          setSelectedIdsBoth([shape.id])
          applyTool('select')
          break
        }
      }
      movedRef.current = false
      endDrag()
    }
    const onUp = () => finish(false)
    const onCancel = () => finish(true)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [
    drag,
    toSvgXY,
    applyVb,
    setMarqueeBoth,
    setSelectedIdsBoth,
    pushHistory,
    flushEmit,
    emit,
    applyTool,
    setDraftBoth,
    setDraftPathPtsBoth,
    endDrag,
  ])

  // ---------- 键盘快捷键 ----------
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const active = document.activeElement as HTMLElement | null
      const root = rootRef.current
      const inEditor = !active || active === document.body || (root != null && root.contains(active))
      if (!inEditor) return
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (mod && k === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && k === 'y') {
        e.preventDefault()
        redo()
        return
      }
      if (mod && k === 'a') {
        e.preventDefault()
        selectAll()
        return
      }
      if (mod && k === 'c') {
        e.preventDefault()
        copySelection()
        return
      }
      if (mod && k === 'v') {
        e.preventDefault()
        pasteFromClipboard()
        return
      }
      if (mod && k === 'd') {
        e.preventDefault()
        duplicateSelection()
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedIdsRef.current.length > 0) {
          e.preventDefault()
          deleteSelected()
        }
        return
      }
      if (e.key === 'Enter') {
        if (pendingPtsRef.current.length >= 2) {
          e.preventDefault()
          finishPolyline()
        }
        return
      }
      if (e.key === 'Escape') {
        handleEscapeKey()
        return
      }
      if (e.key === ' ') {
        if (active && (active.tagName === 'BUTTON' || active.tagName === 'A')) return
        e.preventDefault()
        if (!e.repeat) setSpaceDown(true)
        return
      }
      if (e.key.startsWith('Arrow') && selectedIdsRef.current.length > 0) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        if (e.key === 'ArrowLeft') nudgeSelection(-step, 0)
        else if (e.key === 'ArrowRight') nudgeSelection(step, 0)
        else if (e.key === 'ArrowUp') nudgeSelection(0, -step)
        else if (e.key === 'ArrowDown') nudgeSelection(0, step)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') setSpaceDown(false)
    }
    const onBlur = () => setSpaceDown(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [
    undo,
    redo,
    selectAll,
    copySelection,
    pasteFromClipboard,
    duplicateSelection,
    deleteSelected,
    finishPolyline,
    handleEscapeKey,
    nudgeSelection,
  ])

  // ---------- 派生数据 ----------
  const selectedShapes = doc.shapes.filter((s) => selectedIds.includes(s.id))
  const single = selectedShapes.length === 1 ? selectedShapes[0] : null
  const isLine = single?.kind === 'line'
  const isText = single?.kind === 'text'

  const vw = vb?.w ?? doc.width * 1.1
  const vh = vb && containerSize.w > 0 ? (vb.w * containerSize.h) / containerSize.w : doc.height * 1.1
  const vbX = vb?.x ?? -doc.width * 0.05
  const vbY = vb?.y ?? -doc.height * 0.05
  const viewScale = containerSize.w > 0 ? containerSize.w / vw : 1
  const zoomPct = fitWRef.current > 0 ? Math.round((fitWRef.current / vw) * 100) : 100
  const cursor =
    drag?.mode === 'pan'
      ? 'grabbing'
      : spaceDown || tool === 'pan'
        ? 'grab'
        : tool === 'select'
          ? 'default'
          : 'crosshair'

  // ---------- 渲染：单个形状 ----------
  const renderShapeNode = (s: SvgShape, isDraft: boolean): React.ReactNode => {
    const bb = shapeBBox(s)
    const interactive = !isDraft && tool === 'select' && !spaceDown
    const rot =
      s.rotation && ROTATABLE.has(s.kind)
        ? `rotate(${s.rotation} ${bb.x + bb.w / 2} ${bb.y + bb.h / 2})`
        : undefined
    const stroke = s.stroke === 'none' ? 'none' : s.stroke
    const dash = dashArrayOf(s)
    let el: React.ReactNode
    switch (s.kind) {
      case 'rect':
        el = (
          <rect
            x={s.x}
            y={s.y}
            width={s.w}
            height={s.h}
            rx={s.rx || undefined}
            fill={s.fill}
            stroke={stroke}
            strokeWidth={s.strokeWidth}
            strokeDasharray={dash}
          />
        )
        break
      case 'circle':
        el = (
          <circle
            cx={s.cx}
            cy={s.cy}
            r={s.r}
            fill={s.fill}
            stroke={stroke}
            strokeWidth={s.strokeWidth}
            strokeDasharray={dash}
          />
        )
        break
      case 'ellipse':
        el = (
          <ellipse
            cx={s.cx}
            cy={s.cy}
            rx={s.rx}
            ry={s.ry}
            fill={s.fill}
            stroke={stroke}
            strokeWidth={s.strokeWidth}
            strokeDasharray={dash}
          />
        )
        break
      case 'line':
        el = (
          <line
            x1={s.x1}
            y1={s.y1}
            x2={s.x2}
            y2={s.y2}
            fill="none"
            stroke={stroke === 'none' ? '#000000' : stroke}
            strokeWidth={s.strokeWidth}
            strokeDasharray={dash}
            strokeLinecap={s.linecap}
            markerEnd={s.arrow ? `url(#${arrowMarkerId(s.stroke)})` : undefined}
          />
        )
        break
      case 'text':
        el = (
          <>
            <text x={s.x} y={s.y} fontSize={s.size} fill={s.fill}>
              {s.text}
            </text>
            {/* 透明命中区：方便点选文字 */}
            <rect
              x={bb.x - 6}
              y={bb.y - 4}
              width={Math.max(bb.w + 12, 12)}
              height={Math.max(bb.h + 8, 12)}
              fill="transparent"
              stroke="none"
            />
          </>
        )
        break
      case 'polygon':
        el = (
          <polygon
            points={s.pts.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ')}
            fill={s.fill}
            stroke={stroke}
            strokeWidth={s.strokeWidth}
            strokeDasharray={dash}
            strokeLinejoin="round"
          />
        )
        break
      case 'polyline':
        el = (
          <polyline
            points={s.pts.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ')}
            fill={s.fill}
            stroke={stroke}
            strokeWidth={s.strokeWidth}
            strokeDasharray={dash}
            strokeLinecap={s.linecap}
            strokeLinejoin="round"
          />
        )
        break
      case 'path':
        el = (
          <path
            d={pathDAttr(s.cmds)}
            fill={s.fill}
            stroke={stroke}
            strokeWidth={s.strokeWidth}
            strokeDasharray={dash}
            strokeLinecap={s.linecap}
            strokeLinejoin="round"
          />
        )
        break
    }
    return (
      <g
        key={isDraft ? 'draft' : s.id}
        data-shape-id={isDraft ? undefined : s.id}
        transform={rot}
        opacity={s.opacity != null ? s.opacity : undefined}
        display={s.visible === false ? 'none' : undefined}
        className={cn(!isDraft && interactive && 'cursor-move')}
        style={isDraft ? { pointerEvents: 'none' } : undefined}
        onPointerDown={interactive ? (e: React.PointerEvent) => startShapePointer(e, s) : undefined}
        onDoubleClick={
          interactive && s.kind === 'text'
            ? () => requestAnimationFrame(() => textInputRef.current?.focus())
            : undefined
        }
      >
        {el}
      </g>
    )
  }

  const shapeEls = doc.shapes.map((s) => renderShapeNode(s, false))

  // ---------- 渲染：选中态覆盖层 ----------
  let overlay: React.ReactNode = null
  if (tool === 'select' && selectedShapes.length > 0) {
    const hs = Math.max(3, Math.min(20, 6 / viewScale))
    const sw = 1 / viewScale
    const handleProps = {
      fill: '#3b82f6',
      stroke: '#ffffff',
      strokeWidth: sw,
      r: hs,
    } as const
    if (selectedShapes.length > 1) {
      const boxes = selectedShapes.map(shapeBBox)
      const total = boxes.reduce(unionBox)
      overlay = (
        <g pointerEvents="none">
          {boxes.map((b, i) => (
            <rect
              key={i}
              x={b.x - 2 * sw}
              y={b.y - 2 * sw}
              width={Math.max(b.w + 4 * sw, 4 * sw)}
              height={Math.max(b.h + 4 * sw, 4 * sw)}
              fill="none"
              stroke="#93c5fd"
              strokeWidth={sw}
              strokeDasharray={`${4 * sw} ${3 * sw}`}
            />
          ))}
          <rect
            x={total.x - 3 * sw}
            y={total.y - 3 * sw}
            width={Math.max(total.w + 6 * sw, 4 * sw)}
            height={Math.max(total.h + 6 * sw, 4 * sw)}
            fill="none"
            stroke="#3b82f6"
            strokeWidth={1.5 * sw}
            strokeDasharray={`${5 * sw} ${3 * sw}`}
          />
        </g>
      )
    } else {
      const s = selectedShapes[0]
      const bb = shapeBBox(s)
      const rot =
        s.rotation && ROTATABLE.has(s.kind)
          ? `rotate(${s.rotation} ${bb.x + bb.w / 2} ${bb.y + bb.h / 2})`
          : undefined
      overlay = (
        <g transform={rot} pointerEvents="none">
          <rect
            x={bb.x - 3 * sw}
            y={bb.y - 3 * sw}
            width={Math.max(bb.w + 6 * sw, 8 * sw)}
            height={Math.max(bb.h + 6 * sw, 8 * sw)}
            fill="none"
            stroke="#3b82f6"
            strokeWidth={1.5 * sw}
            strokeDasharray={`${5 * sw} ${3 * sw}`}
          />
          {(s.kind === 'rect' || s.kind === 'circle' || s.kind === 'ellipse') && (
            <circle
              {...handleProps}
              cx={
                s.kind === 'rect'
                  ? s.x + s.w
                  : s.kind === 'circle'
                    ? s.cx + s.r
                    : s.cx + s.rx
              }
              cy={
                s.kind === 'rect'
                  ? s.y + s.h
                  : s.kind === 'circle'
                    ? s.cy + s.r
                    : s.cy + s.ry
              }
              pointerEvents="all"
              className="cursor-nwse-resize"
              onPointerDown={(e) => startHandleDrag(e, 'resize')}
            />
          )}
          {s.kind === 'line' && (
            <>
              <circle
                {...handleProps}
                cx={s.x1}
                cy={s.y1}
                pointerEvents="all"
                className="cursor-move"
                onPointerDown={(e) => startHandleDrag(e, 'endpoint', 1)}
              />
              <circle
                {...handleProps}
                cx={s.x2}
                cy={s.y2}
                pointerEvents="all"
                className="cursor-move"
                onPointerDown={(e) => startHandleDrag(e, 'endpoint', 2)}
              />
            </>
          )}
          {ROTATABLE.has(s.kind) && (
            <g>
              <line
                x1={bb.x + bb.w / 2}
                y1={bb.y - 4 * sw}
                x2={bb.x + bb.w / 2}
                y2={bb.y - 20 * sw}
                stroke="#3b82f6"
                strokeWidth={sw}
              />
              <circle
                {...handleProps}
                cx={bb.x + bb.w / 2}
                cy={bb.y - 22 * sw}
                pointerEvents="all"
                className="cursor-grab"
                onPointerDown={(e) => startHandleDrag(e, 'rotate')}
              />
            </g>
          )}
        </g>
      )
    }
  }

  // ---------- 渲染：箭头 marker / 网格 / 草稿 / 框选 ----------
  const arrowMarkerStrokes = new Set<string>()
  for (const s of doc.shapes) {
    if (s.kind === 'line' && s.arrow) arrowMarkerStrokes.add(s.stroke)
  }
  if (draft?.kind === 'line' && draft.arrow) arrowMarkerStrokes.add(draft.stroke)

  const gridNode = grid ? (
    <>
      <pattern id="svgedit-grid" width={20} height={20} patternUnits="userSpaceOnUse">
        <circle cx={0} cy={0} r={1.2} fill="#d4d4d8" />
      </pattern>
      <rect x={0} y={0} width={doc.width} height={doc.height} fill="url(#svgedit-grid)" pointerEvents="none" />
    </>
  ) : null

  const pendingNode =
    pendingPts.length > 0 ? (
      <g pointerEvents="none">
        <polyline
          points={pendingPts.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ')}
          fill="none"
          stroke={lastStyleRef.current.stroke}
          strokeWidth={lastStyleRef.current.strokeWidth}
          strokeLinejoin="round"
        />
        {pendingPts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={Math.max(2, 3 / viewScale)} fill="#3b82f6" />
        ))}
        {hoverPt && pendingPts.length > 0 && (
          <line
            x1={pendingPts[pendingPts.length - 1].x}
            y1={pendingPts[pendingPts.length - 1].y}
            x2={hoverPt.x}
            y2={hoverPt.y}
            stroke="#3b82f6"
            strokeWidth={1 / viewScale}
            strokeDasharray={`${4 / viewScale} ${3 / viewScale}`}
          />
        )}
      </g>
    ) : null

  const draftPathNode =
    draftPathPts.length > 0 ? (
      <path
        d={pathDAttr(smoothPathCmds(draftPathPts))}
        fill="none"
        stroke={lastStyleRef.current.stroke}
        strokeWidth={lastStyleRef.current.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        pointerEvents="none"
      />
    ) : null

  const marqueeNode = marquee ? (
    <rect
      x={marquee.x}
      y={marquee.y}
      width={marquee.w}
      height={marquee.h}
      fill="rgba(59,130,246,0.06)"
      stroke="#3b82f6"
      strokeWidth={1 / viewScale}
      strokeDasharray={`${4 / viewScale} ${3 / viewScale}`}
      pointerEvents="none"
    />
  ) : null

  // 就地文字输入框位置（SVG 坐标 → 容器像素）
  const textEditPos = (() => {
    if (!textEdit) return { x: 8, y: 8 }
    const px = (textEdit.x - vbX) * viewScale
    const py = (textEdit.y - vbY) * (containerSize.h > 0 ? containerSize.h / vh : 1)
    return { x: Math.max(4, px), y: Math.max(4, py - lastTextSizeRef.current * viewScale * 0.85) }
  })()

  // ---------- 提示文案 ----------
  const hint = (() => {
    if (textEdit) return '输入文字后按回车确认，Esc 取消'
    if (tool === 'polyline') return '连续点击画布加点；双击或回车结束；Esc 取消'
    if (tool === 'path') return '按住拖动自由绘制，松手成型（双指可平移缩放）'
    if (tool === 'text') return '点击画布任意位置就地输入文字；点击已有文字可编辑'
    if (tool === 'pan') return '按住拖动平移画布；双指捏合缩放'
    if (tool === 'line' || tool === 'arrow') return '拖动绘制；按住 Shift 锁定水平 / 垂直 / 45°；单击落默认长度'
    if (tool === 'polygon') return '从中心拖出绘制正多边形（边数可调）；单击落默认大小'
    if (tool === 'rect' || tool === 'circle' || tool === 'ellipse')
      return '拖动绘制；按住 Shift 约束正方形 / 圆形；单击落默认大小'
    if (selectedShapes.length > 1)
      return `已选 ${selectedShapes.length} 个元素：拖动批量移动 · 批量改色 / 粗细 · 六向对齐 · Delete 批量删除`
    if (selectedShapes.length === 1)
      return '拖动移动 · 手柄调整大小 / 端点 · 上方圆点手柄旋转 · Delete 删除 · Ctrl+C/V 复制粘贴'
    return '单击选择 · Shift+点击多选 · 空白处拖框选择 · 空格+拖动 / 抓手平移 · 滚轮 / 双指缩放'
  })()

  // ---------- JSX ----------
  return (
    <div ref={rootRef} className="flex flex-col gap-2">
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
      {importError && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
          <span>{importError}</span>
          <button
            type="button"
            aria-label="关闭提示"
            title="关闭提示"
            onClick={() => setImportError(null)}
            className="shrink-0 rounded-full px-1.5 font-bold"
          >
            ×
          </button>
        </div>
      )}
      {importPending && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <span className="flex-1">
            当前画布已有内容，导入「{importPending.name}」的方式：
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 rounded-full border-amber-400 px-3 text-[11px] hover:bg-amber-100 dark:hover:bg-amber-500/20"
            onClick={() => applyImportDoc(importPending.doc, 'append', importPending.name)}
          >
            追加导入
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 rounded-full border-amber-400 px-3 text-[11px] text-destructive hover:bg-amber-100 dark:hover:bg-amber-500/20"
            onClick={() => applyImportDoc(importPending.doc, 'replace', importPending.name)}
          >
            替换全部
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 rounded-full px-3 text-[11px]"
            onClick={() => setImportPending(null)}
          >
            取消
          </Button>
        </div>
      )}

      {/* 绘图工具 */}
      <div className="grid grid-cols-6 gap-1.5">
        {TOOLS.map((it) => {
          const Icon = it.icon
          const active = tool === it.id
          return (
            <button
              key={it.id}
              type="button"
              onClick={() => applyTool(active ? 'select' : it.id)}
              title={`${it.label}工具${active ? '（再点一次切回选择）' : ''}`}
              aria-label={`${it.label}工具`}
              aria-pressed={active}
              className={cn(
                'flex h-11 flex-col items-center justify-center gap-0.5 rounded-lg border text-[10px] transition-colors',
                active
                  ? 'border-blue-500/60 bg-blue-500/10 text-blue-600 dark:text-blue-400'
                  : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className={cn('size-4', it.iconCls ?? '')} strokeWidth={1.75} />
              {it.label}
            </button>
          )
        })}
      </div>

      {/* 多边形边数（绘制时） */}
      {tool === 'polygon' && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-1.5">
          <span className="text-[11px] text-muted-foreground">绘制边数</span>
          <SidesStepper value={polySides} onChange={(n) => setPolySidesBoth(n)} />
          <span className="text-[10px] text-muted-foreground">（3 – 8 边）</span>
        </div>
      )}

      {/* 操作条 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="outline"
          size="icon"
          className="size-9 rounded-lg"
          title="撤销（Ctrl+Z）"
          aria-label="撤销"
          disabled={!histInfo.canUndo}
          onClick={undo}
        >
          <Undo2 className="size-4" strokeWidth={1.75} />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-9 rounded-lg"
          title="重做（Ctrl+Shift+Z / Ctrl+Y）"
          aria-label="重做"
          disabled={!histInfo.canRedo}
          onClick={redo}
        >
          <Redo2 className="size-4" strokeWidth={1.75} />
        </Button>
        <div className="mx-0.5 h-6 w-px bg-border" aria-hidden />
        <Button
          variant={showLayers ? 'secondary' : 'outline'}
          size="sm"
          className="h-9 rounded-lg px-2.5 text-[11px]"
          title="图层面板"
          aria-label="图层面板"
          aria-pressed={showLayers}
          onClick={() => setShowLayers((v) => !v)}
        >
          <Layers className="size-4" strokeWidth={1.75} />
          图层
        </Button>
        <Button
          variant={showCanvas ? 'secondary' : 'outline'}
          size="sm"
          className="h-9 rounded-lg px-2.5 text-[11px]"
          title="画布设置（尺寸 / 预设）"
          aria-label="画布设置"
          aria-pressed={showCanvas}
          onClick={() => setShowCanvas((v) => !v)}
        >
          <Frame className="size-4" strokeWidth={1.75} />
          画布
        </Button>
        <div className="mx-0.5 h-6 w-px bg-border" aria-hidden />
        <Button
          variant="outline"
          size="sm"
          className="h-9 rounded-lg px-2.5 text-[11px]"
          title="导入 SVG 文件（可追加或替换）"
          aria-label="导入 SVG 文件"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="size-4" strokeWidth={1.75} />
          导入文件
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-9 rounded-lg px-2.5 text-[11px]"
          title="下载当前画布为 SVG 文件"
          aria-label="下载 SVG 文件"
          onClick={downloadSvg}
        >
          <Download className="size-4" strokeWidth={1.75} />
          下载
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-9 rounded-lg px-2.5 text-[11px]"
          title="复制 SVG 源码到剪贴板"
          aria-label="复制 SVG 源码"
          onClick={() => void copySource()}
        >
          <ClipboardCopy className="size-4" strokeWidth={1.75} />
          复制源码
        </Button>
        <div className="mx-0.5 h-6 w-px bg-border" aria-hidden />
        <Button
          variant={grid ? 'secondary' : 'outline'}
          size="icon"
          className="size-9 rounded-lg"
          title="网格（20px 淡灰点阵，纯视觉）"
          aria-label="网格开关"
          aria-pressed={grid}
          onClick={() => setGrid((v) => !v)}
        >
          <Grid3x3 className="size-4" strokeWidth={1.75} />
        </Button>
        <Button
          variant={snap ? 'secondary' : 'outline'}
          size="icon"
          className="size-9 rounded-lg"
          title="吸附（移动 / 调整大小 / 绘制坐标取整 10px）"
          aria-label="吸附开关"
          aria-pressed={snap}
          onClick={() => setSnapBoth(!snap)}
        >
          <Magnet className="size-4" strokeWidth={1.75} />
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".svg,image/svg+xml"
          className="hidden"
          aria-label="选择 SVG 文件"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void handleImportFile(f)
          }}
        />
      </div>

      {/* 图层面板 */}
      {showLayers && (
        <div className="rounded-xl border border-border p-2">
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-xs font-medium">图层（上层在前）</p>
            <p className="text-[10px] text-muted-foreground">点击选中 · 眼睛显隐 · 箭头调序</p>
          </div>
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {doc.raw.length > 0 && (
              <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-2 py-1.5 text-[11px] text-muted-foreground">
                <Lock className="size-3.5 shrink-0" strokeWidth={1.75} />
                <span className="flex-1 truncate">复杂元素 ×{doc.raw.length}（源码保留，不可编辑）</span>
              </div>
            )}
            {doc.shapes.length === 0 && doc.raw.length === 0 && (
              <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">画布暂无元素</p>
            )}
            {[...doc.shapes].reverse().map((s) => {
              const Icon = LAYER_ICON[s.kind]
              const isSel = selectedIds.includes(s.id)
              const idx = doc.shapes.indexOf(s)
              return (
                <div
                  key={s.id}
                  className={cn(
                    'flex items-center gap-1 rounded-lg border px-2 py-1.5',
                    isSel ? 'border-blue-500/60 bg-blue-500/5' : 'border-transparent bg-muted/40',
                  )}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    title="点击选中（Shift 加选 / 减选）"
                    onClick={(e) => {
                      applyTool('select')
                      if (e.shiftKey) {
                        setSelectedIdsBoth(
                          selectedIdsRef.current.includes(s.id)
                            ? selectedIdsRef.current.filter((i) => i !== s.id)
                            : [...selectedIdsRef.current, s.id],
                        )
                      } else {
                        setSelectedIdsBoth([s.id])
                      }
                    }}
                  >
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                    <span
                      className={cn(
                        'truncate text-[11px]',
                        s.visible === false ? 'text-muted-foreground/50 line-through' : 'text-foreground',
                      )}
                    >
                      {layerLabel(s)}
                    </span>
                  </button>
                  <button
                    type="button"
                    title={s.visible === false ? '显示该元素' : '隐藏该元素'}
                    aria-label={s.visible === false ? '显示该元素' : '隐藏该元素'}
                    onClick={() => toggleVisible(s.id)}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {s.visible === false ? (
                      <EyeOff className="size-3.5" strokeWidth={1.75} />
                    ) : (
                      <Eye className="size-3.5" strokeWidth={1.75} />
                    )}
                  </button>
                  <button
                    type="button"
                    title="上移一层"
                    aria-label="上移一层"
                    disabled={idx >= doc.shapes.length - 1}
                    onClick={() => zChange(s.id, 'up')}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
                  >
                    <ChevronUp className="size-3.5" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    title="下移一层"
                    aria-label="下移一层"
                    disabled={idx <= 0}
                    onClick={() => zChange(s.id, 'down')}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
                  >
                    <ChevronDown className="size-3.5" strokeWidth={1.75} />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 画布设置 */}
      {showCanvas && (
        <div className="flex flex-col gap-2 rounded-xl border border-border p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-12 shrink-0 text-[11px] text-muted-foreground">尺寸</span>
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
              宽
              <Input
                type="number"
                min={200}
                max={2000}
                value={canvasW}
                aria-label="画布宽度（200-2000）"
                onChange={(e) => setCanvasW(e.target.value)}
                onBlur={applyCanvasInputs}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) applyCanvasInputs()
                }}
                className="h-8 w-20 rounded-lg text-xs"
              />
            </label>
            <span className="text-[11px] text-muted-foreground">×</span>
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
              高
              <Input
                type="number"
                min={200}
                max={2000}
                value={canvasH}
                aria-label="画布高度（200-2000）"
                onChange={(e) => setCanvasH(e.target.value)}
                onBlur={applyCanvasInputs}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) applyCanvasInputs()
                }}
                className="h-8 w-20 rounded-lg text-xs"
              />
            </label>
            <span className="text-[10px] text-muted-foreground">（200 – 2000，viewBox 同步）</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-12 shrink-0 text-[11px] text-muted-foreground">预设</span>
            {CANVAS_PRESETS.map((p) => (
              <Button
                key={`${p.w}x${p.h}`}
                variant="outline"
                size="sm"
                className="h-7 rounded-full px-2.5 text-[11px]"
                title={`画布设为 ${p.w}×${p.h}`}
                onClick={() => applyCanvasSize(p.w, p.h)}
              >
                {p.w}×{p.h}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* 画布 */}
      <div
        ref={containerRef}
        className="relative h-[360px] touch-none select-none overflow-hidden rounded-xl border border-border bg-muted/40 md:h-[460px]"
        style={{ cursor }}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDownCapture={onContainerPointerDownCapture}
        onPointerMoveCapture={onContainerPointerMoveCapture}
        onPointerUpCapture={onContainerPointerUpCapture}
        onPointerCancelCapture={onContainerPointerUpCapture}
      >
        <svg
          ref={svgRef}
          viewBox={`${fmt2(vbX)} ${fmt2(vbY)} ${fmt2(vw)} ${fmt2(vh)}`}
          className="h-full w-full"
          role="application"
          aria-label="SVG 画布：选择工具点选元素后拖动编辑；绘图工具在画布上拖动绘制"
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onDoubleClick={onCanvasDoubleClick}
        >
          <defs>
            {arrowMarkerStrokes.size > 0 &&
              Array.from(arrowMarkerStrokes).map((c) => (
                <marker
                  key={c}
                  id={arrowMarkerId(c)}
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
          {/* 画布白底 */}
          <rect
            x={0}
            y={0}
            width={doc.width}
            height={doc.height}
            fill="#ffffff"
            stroke="#e4e4e7"
            strokeWidth={1 / viewScale}
            pointerEvents="none"
          />
          {/* 网格点阵 */}
          {gridNode}
          {/* 原始元素底衬（半透明灰显，不可编辑） */}
          {doc.raw.length > 0 && (
            <g data-bg="1" opacity={0.45} style={{ pointerEvents: 'none' }} dangerouslySetInnerHTML={{ __html: doc.raw.join('\n') }} />
          )}
          {shapeEls}
          {pendingNode}
          {draft ? renderShapeNode(draft, true) : null}
          {draftPathNode}
          {marqueeNode}
          {overlay}
        </svg>

        {/* 缩放控件 */}
        <div className="absolute bottom-2 right-2 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-background/90 p-0.5 shadow-sm backdrop-blur">
          <button
            type="button"
            title="缩小（滚轮 / 双指捏合同样可用）"
            aria-label="缩小"
            onClick={() => zoomAtCenter(1 / 1.25)}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ZoomOut className="size-3.5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            title="点击回到 100%"
            aria-label={`当前缩放 ${zoomPct}%，点击回到 100%`}
            onClick={resetZoom}
            className="h-7 min-w-11 rounded-md text-[10px] tabular-nums text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {zoomPct}%
          </button>
          <button
            type="button"
            title="放大（滚轮 / 双指张开同样可用）"
            aria-label="放大"
            onClick={() => zoomAtCenter(1.25)}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ZoomIn className="size-3.5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            title="适应内容（自动缩放并居中）"
            aria-label="适应内容"
            onClick={fitView}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Scan className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>

        {/* 就地文字输入 */}
        {textEdit && (
          <input
            ref={textInputOverlayRef}
            type="text"
            value={textEdit.value}
            placeholder="输入文字…"
            aria-label="新文字内容（回车确认，Esc 取消）"
            onChange={(e) => {
              const te = textEditRef.current
              if (!te) return
              const next = { ...te, value: e.target.value }
              textEditRef.current = next
              setTextEditState(next)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                commitText()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                closeTextEdit()
              }
            }}
            onBlur={commitText}
            className="absolute z-20 rounded border border-dashed border-blue-500 bg-white/95 px-1 py-0 text-foreground shadow-sm outline-none dark:bg-white dark:text-black"
            style={{
              left: textEditPos.x,
              top: textEditPos.y,
              fontSize: Math.max(11, lastTextSizeRef.current * viewScale),
              minWidth: 140,
            }}
          />
        )}
      </div>

      {/* 操作提示 */}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>

      {/* 属性栏（单选） */}
      {single && tool === 'select' ? (
        <div className="flex flex-col gap-2 rounded-xl border border-border p-2.5">
          {isText && (
            <div className="flex gap-2">
              <Input
                ref={textInputRef}
                value={single.text}
                aria-label="文字内容"
                onChange={(e) => setTextValue(e.target.value)}
                className="h-9 flex-1 rounded-lg text-sm"
              />
              <Input
                type="number"
                min={8}
                max={96}
                value={single.size}
                aria-label="字号（8-96）"
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (Number.isFinite(v)) setTextSize(Math.min(96, Math.max(8, v)))
                }}
                className="h-9 w-16 rounded-lg text-sm"
              />
            </div>
          )}
          {isLine && (
            <label className="flex w-fit cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={single.arrow}
                onChange={(e) => setArrowOn(e.target.checked)}
                className="size-4 accent-blue-600"
              />
              箭头（末端）
            </label>
          )}
          {LINE_LIKE.has(single.kind) && (
            <Segmented<LineCap>
              label="线帽"
              value={single.linecap ?? 'butt'}
              options={[
                { v: 'round', label: '圆头', title: '圆头线帽' },
                { v: 'butt', label: '平头', title: '平头线帽' },
                { v: 'square', label: '方头', title: '方头线帽' },
              ]}
              onChange={(v) => setLinecap(v)}
            />
          )}
          {single.kind === 'polygon' && (
            <div className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-[11px] text-muted-foreground">边数</span>
              <SidesStepper value={single.pts.length} onChange={(n) => setSides(n)} />
              <span className="text-[10px] text-muted-foreground">（重排为正多边形）</span>
            </div>
          )}
          {single.kind === 'rect' && Math.floor(Math.min(single.w, single.h) / 2) >= 1 && (
            <div className="flex items-center gap-3">
              <span className="w-12 shrink-0 text-[11px] text-muted-foreground">圆角</span>
              <Slider
                value={[single.rx ?? 0]}
                min={0}
                max={Math.floor(Math.min(single.w, single.h) / 2)}
                step={1}
                onValueChange={(v) => setRx(v[0] ?? 0)}
                className="flex-1"
                aria-label="矩形圆角半径"
              />
              <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
                {Math.round(single.rx ?? 0)}
              </span>
            </div>
          )}
          {!isLine && (
            <ColorSwatches
              label={isText ? '文字色' : '填充'}
              value={single.fill}
              allowNone={!isText}
              onChange={(c) => setFill(c)}
            />
          )}
          {!isText && (
            <ColorSwatches label="描边" value={single.stroke} allowNone onChange={(c) => setStrokeColor(c)} />
          )}
          {!isText && (
            <div className="flex items-center gap-3">
              <span className="w-12 shrink-0 text-[11px] text-muted-foreground">粗细</span>
              <Slider
                value={[single.strokeWidth]}
                min={1}
                max={12}
                step={1}
                onValueChange={(v) => setStrokeWidth(v[0] ?? single.strokeWidth)}
                className="flex-1"
                aria-label="描边粗细（1-12）"
              />
              <span className="w-6 text-right text-xs tabular-nums text-muted-foreground">
                {single.strokeWidth}
              </span>
            </div>
          )}
          {!isText && (
            <Segmented<DashStyle>
              label="线型"
              value={single.dash ?? 'solid'}
              options={[
                { v: 'solid', label: '实线', title: '实线' },
                { v: 'dash', label: '虚线', title: '虚线' },
                { v: 'dot', label: '点线', title: '点线' },
              ]}
              onChange={(v) => setDashStyle(v)}
            />
          )}
          <div className="flex items-center gap-3">
            <span className="w-12 shrink-0 text-[11px] text-muted-foreground">透明</span>
            <Slider
              value={[single.opacity ?? 1]}
              min={0}
              max={1}
              step={0.05}
              onValueChange={(v) => setOpacity(v[0] ?? 1)}
              className="flex-1"
              aria-label="透明度（0-100%）"
            />
            <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
              {Math.round((single.opacity ?? 1) * 100)}%
            </span>
          </div>
          {ROTATABLE.has(single.kind) && (
            <div className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-[11px] text-muted-foreground">旋转</span>
              <RotateCw className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
              <Input
                type="number"
                min={0}
                max={359}
                value={Math.round(single.rotation ?? 0)}
                aria-label="旋转角度（0-360 度）"
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (Number.isFinite(v)) setRotation(v)
                }}
                className="h-8 w-20 rounded-lg text-xs"
              />
              <span className="text-[10px] text-muted-foreground">度（或拖选中框上方圆点手柄，Shift 吸附 15°）</span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-12 shrink-0 text-[11px] text-muted-foreground">层级</span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 rounded-lg px-2 text-[11px]"
              title="置底（移到最下层）"
              aria-label="置底"
              onClick={() => zChange(single.id, 'bottom')}
            >
              <ArrowDownToLine className="size-3.5" strokeWidth={1.75} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 rounded-lg px-2 text-[11px]"
              title="下移一层"
              aria-label="下移一层"
              onClick={() => zChange(single.id, 'down')}
            >
              <ChevronDown className="size-3.5" strokeWidth={1.75} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 rounded-lg px-2 text-[11px]"
              title="上移一层"
              aria-label="上移一层"
              onClick={() => zChange(single.id, 'up')}
            >
              <ChevronUp className="size-3.5" strokeWidth={1.75} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 rounded-lg px-2 text-[11px]"
              title="置顶（移到最上层）"
              aria-label="置顶"
              onClick={() => zChange(single.id, 'top')}
            >
              <ArrowUpToLine className="size-3.5" strokeWidth={1.75} />
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              拖动移动 · 手柄调整 · 方向键微调（Shift×10）
            </p>
            <div className="flex gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-full px-3 text-xs"
                title="生成偏移 12px 的副本（Ctrl+D）"
                onClick={duplicateSelection}
              >
                <Copy className="size-3.5" strokeWidth={1.75} />
                复制副本
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-full text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                title="删除选中元素（Delete）"
                onClick={deleteSelected}
              >
                <Trash2 className="size-3.5" strokeWidth={1.75} />
                删除选中
              </Button>
            </div>
          </div>
        </div>
      ) : selectedShapes.length > 1 && tool === 'select' ? (
        /* 属性栏（多选） */
        <div className="flex flex-col gap-2 rounded-xl border border-border p-2.5">
          <p className="text-xs font-medium">已选中 {selectedShapes.length} 个元素</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-12 shrink-0 text-[11px] text-muted-foreground">对齐</span>
            {ALIGNS.map((a) => {
              const Icon = a.icon
              return (
                <Button
                  key={a.id}
                  variant="outline"
                  size="sm"
                  className="h-7 w-9 justify-center rounded-lg px-0 text-[11px]"
                  title={a.title}
                  aria-label={a.title}
                  onClick={() => alignSelection(a.id)}
                >
                  <Icon className="size-3.5" strokeWidth={1.75} />
                </Button>
              )
            })}
          </div>
          <ColorSwatches label="填充" value="" allowNone onChange={(c) => setFill(c)} />
          <ColorSwatches label="描边" value="" allowNone onChange={(c) => setStrokeColor(c)} />
          <div className="flex items-center gap-3">
            <span className="w-12 shrink-0 text-[11px] text-muted-foreground">粗细</span>
            <Slider
              value={[selectedShapes.find((s) => s.kind !== 'text')?.strokeWidth ?? 2]}
              min={1}
              max={12}
              step={1}
              onValueChange={(v) => setStrokeWidth(v[0] ?? 2)}
              className="flex-1"
              aria-label="批量描边粗细（1-12）"
            />
            <span className="w-6 text-right text-xs tabular-nums text-muted-foreground">
              {selectedShapes.find((s) => s.kind !== 'text')?.strokeWidth ?? 2}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="w-12 shrink-0 text-[11px] text-muted-foreground">透明</span>
            <Slider
              value={[selectedShapes[0]?.opacity ?? 1]}
              min={0}
              max={1}
              step={0.05}
              onValueChange={(v) => setOpacity(v[0] ?? 1)}
              className="flex-1"
              aria-label="批量透明度（0-100%）"
            />
            <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
              {Math.round((selectedShapes[0]?.opacity ?? 1) * 100)}%
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">拖动任意选中元素可整体移动 · Delete 批量删除</p>
            <div className="flex gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-full px-3 text-xs"
                title="生成偏移 12px 的副本（Ctrl+D）"
                onClick={duplicateSelection}
              >
                <Copy className="size-3.5" strokeWidth={1.75} />
                复制副本
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-full text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                title="批量删除选中元素（Delete）"
                onClick={deleteSelected}
              >
                <Trash2 className="size-3.5" strokeWidth={1.75} />
                批量删除
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          点击画布中的元素选中后可拖动、调大小、旋转、改样式；Shift+点击或空白拖框可多选；
          点空白处取消选择。桌面快捷键：Ctrl+Z / Ctrl+Shift+Z 撤销重做、Ctrl+C/V 复制粘贴、
          Ctrl+A 全选、方向键微调、空格+拖动平移、滚轮缩放。
        </p>
      )}
    </div>
  )
}
