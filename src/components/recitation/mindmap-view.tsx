'use client'

import * as React from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bold,
  Braces,
  Check,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  ClipboardPaste,
  Copy,
  Download,
  FileArchive,
  FileCode,
  FileText,
  Flag,
  FolderTree,
  GitBranchPlus,
  Image as ImageIcon,
  Link2,
  List,
  ListChecks,
  ListTree,
  Loader2,
  Maximize,
  Network,
  Pencil,
  Plus,
  Redo2,
  Search,
  Share2,
  Smile,
  SquareCheck,
  StickyNote,
  Trash2,
  Type,
  Undo2,
  UnfoldVertical,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTheme } from 'next-themes'

import { cn } from '@/lib/utils'
import { splitParagraphs } from '@/lib/cloze'
import type { MindNode, MindmapDoc } from '@/lib/types'
import { LongPressMenu, type MenuAction } from '@/components/recitation/long-press-menu'
import { BottomSheet } from '@/components/recitation/bottom-sheet'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

// ---------- local types ----------

/** Per-node visual style (bold / size / ink color). */
interface NodeStyle {
  bold?: boolean
  size?: 'sm' | 'md' | 'lg'
  color?: string
}

/** Extended per-node fields. All optional so old saved data (id/title/children
 *  only) keeps rendering/exporting/persisting without any migration. */
interface RichNodeProps {
  /** 折叠状态（true = 子树收起） */
  collapsed?: boolean
  /** emoji 图标，显示在标题前 */
  icon?: string
  /** 备注（长文本，可搜索） */
  note?: string
  /** 超链接 URL */
  link?: string
  /** 优先级 P1/P2/P3 */
  priority?: 1 | 2 | 3
  /** 节点填充色（十六进制） */
  bg?: string
  /** 节点形状 */
  shape?: 'round' | 'ellipse' | 'plain'
  /** 该节点到父节点连线的颜色 */
  branchColor?: string
}

/** MindNode + 编辑器扩展属性。普通 MindNode 可直接当 RichNode 使用。 */
type RichNode = MindNode & RichNodeProps

/** 画布布局：水平树 / 垂直树 / 导图（中心放射） */
type LayoutKind = 'htree' | 'vtree' | 'radial'

interface DocMeta {
  layout?: LayoutKind
}

/** MindmapDoc with editor extras (styles + merged scopes + layout meta),
 *  persisted as extra JSON fields. */
interface StyledMindmapDoc extends MindmapDoc {
  styles?: Record<string, NodeStyle>
  /** Scope labels already merged into this map (全文 / 第N段). */
  scopes?: string[]
  meta?: DocMeta
}

export interface MindmapViewProps {
  content: string
  /** When provided, maps persist via PATCH /api/cards/:id { mindmaps }. */
  cardId?: string
  /** Card title used for default doc naming (title + MMDD). */
  cardTitle?: string
  initialDocs?: MindmapDoc[]
  onSaved?: (docs: MindmapDoc[]) => void
  /** Optional paged text (分页). When present, scopes become 第N页 and
   *  “按页生成” can create one map per page. Falls back to chunks, then to
   *  paragraph splitting of content. */
  pages?: string[]
  /** Optional chunked text (分块). Used like pages with 第N块 labels. */
  chunks?: string[]
  /** Full override of the node context menu actions. */
  menuActions?: MenuAction[]
  /** Fallback for custom keys when menuActions is overridden. */
  onMenuAction?: (key: string, nodeId: string) => void
}

/** 进行中的节点拖拽（pointer 坐标为屏幕坐标） */
interface DragState {
  id: string
  title: string
  icon?: string
  x: number
  y: number
  targetId: string | null
}

/** 松手后的落点选择弹层 */
interface DropChoice {
  sourceId: string
  targetId: string
  targetTitle: string
}

// ---------- constants ----------

const PAD = 20 // canvas padding
const GAP = 44 // gap between depth columns
const V_GAP = 12 // vertical gap between sibling subtrees
const NODE_H = 36 // single-line node height
const NODE_LINE_H = 19 // line height for wrapped node text
const NODE_PAD_X = 24 // horizontal padding inside a node
const MAX_NODE_W = 240 // wrap width cap — longer titles wrap instead of ellipsis
const MIN_NODE_W = 88 // minimum node pill width

const INK_COLORS = ['#18181b', '#6b7280', '#059669', '#dc2626', '#d97706', '#9333ea']
const BG_COLORS = ['#fde68a', '#bbf7d0', '#bfdbfe', '#fecaca', '#e9d5ff', '#e2e8f0']
const BRANCH_COLORS = ['#dc2626', '#ea580c', '#eab308', '#059669', '#2563eb', '#9333ea']

const PRIORITY_STYLES: Record<1 | 2 | 3, { cls: string; hex: string }> = {
  1: { cls: 'bg-red-500 text-white', hex: '#dc2626' },
  2: { cls: 'bg-orange-500 text-white', hex: '#ea580c' },
  3: { cls: 'bg-blue-500 text-white', hex: '#2563eb' },
}

/** 内置 emoji 图标（48 个，常用学习/标记类） */
const EMOJI_CHOICES = [
  '📖', '📚', '✏️', '✍️', '🧠', '💡', '⭐', '🔥',
  '❤️', '✅', '❌', '❗', '❓', '🎯', '🚩', '📌',
  '📝', '🗓️', '⏰', '🔑', '🏆', '🎉', '👀', '🤔',
  '😊', '😢', '🌟', '☀️', '🌙', '⚡', '🌈', '🍀',
  '🌸', '🚀', '✈️', '🏠', '🎵', '🎨', '🍎', '💧',
  '🔔', '🧭', '🛠️', '📊', '🔬', '🎭', '⚙️', '🧩',
]

const MIN_SCALE = 0.3
const MAX_SCALE = 3

/** Safeguard for auto-per-unit generation (AI cost control). */
const MAX_AUTO_UNITS = 20

const EDIT_TOOLS: { key: string; label: string; icon: React.ComponentType<{ className?: string; strokeWidth?: number }> }[] = [
  { key: 'sibling', label: '添加同级', icon: Plus },
  { key: 'child', label: '添加子级', icon: GitBranchPlus },
  { key: 'style', label: '文本样式', icon: Type },
  { key: 'delete', label: '删除', icon: Trash2 },
  { key: 'copy', label: '复制', icon: Copy },
]

const LAYOUT_OPTIONS: { key: LayoutKind; label: string; icon: React.ComponentType<{ className?: string; strokeWidth?: number }> }[] = [
  { key: 'htree', label: '水平树（根在左）', icon: ArrowRight },
  { key: 'vtree', label: '垂直树（根在上）', icon: ArrowDown },
  { key: 'radial', label: '导图模式（中心放射）', icon: Share2 },
]

type ExportKind = 'png' | 'pdf' | 'svg' | 'md' | 'opml' | 'mm' | 'xmind'

const EXPORT_ITEMS: { kind: ExportKind; icon: React.ComponentType<{ className?: string; strokeWidth?: number }>; title: string; sub: string }[] = [
  { kind: 'png', icon: ImageIcon, title: 'PNG 图片', sub: '.png 高清位图' },
  { kind: 'pdf', icon: FileText, title: 'PDF 文档', sub: '.pdf 文档（横向 A4）' },
  { kind: 'svg', icon: FileCode, title: 'SVG 矢量图', sub: '.svg 无损缩放，跟随当前布局' },
  { kind: 'md', icon: ListTree, title: 'Markdown 大纲', sub: '.md 缩进列表（含图标/优先级/备注）' },
  { kind: 'opml', icon: FolderTree, title: 'OPML 大纲', sub: '.opml 通用大纲格式' },
  { kind: 'mm', icon: Braces, title: 'FreeMind', sub: '.mm 经典导图格式（含颜色/折叠）' },
  { kind: 'xmind', icon: FileArchive, title: 'XMind', sub: '.xmind 可继续编辑（含样式/标记/备注）' },
]

// ---------- generic helpers ----------

function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function mmdd(): string {
  const d = new Date()
  return `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function fmtTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
}

function sanitizeFilename(name: string): string {
  const s = name.replace(/[\\/:*?"<>|]/g, '_').trim()
  return s || '思维导图'
}

// ---------- node text measurement (adaptive width + wrapping) ----------

/** Approximate glyph advance: CJK/fullwidth ≈ 1em, everything else ≈ 0.62em. */
function charW(ch: string, fontSize: number): number {
  const code = ch.codePointAt(0) ?? 0
  return code > 0x2e7f ? fontSize : fontSize * 0.62
}

function textWidth(s: string, fontSize: number): number {
  let w = 0
  for (const ch of s) w += charW(ch, fontSize)
  return w
}

/** Greedy character wrap (CJK text has no spaces) into lines fitting inner px. */
function wrapText(title: string, fontSize: number, inner: number): string[] {
  const lines: string[] = []
  let cur = ''
  let curW = 0
  for (const ch of title) {
    const w = charW(ch, fontSize)
    if (cur && curW + w > inner) {
      lines.push(cur)
      cur = ch
      curW = w
    } else {
      cur += ch
      curW += w
    }
  }
  lines.push(cur)
  return lines
}

function nodeFontSize(isRoot: boolean, st?: NodeStyle): number {
  if (isRoot) return 14
  if (st?.size === 'sm') return 12
  if (st?.size === 'lg') return 15
  return 13
}

interface MeasuredNode {
  w: number
  h: number
  lines: string[]
  fs: number
}

/** 图标 / 优先级徽标额外占用的宽度（用于自适应换行） */
function nodeExtrasWidth(n: RichNode, fs: number): number {
  let w = 0
  if (n.icon) w += fs * 1.4 + 4
  if (n.priority) w += 26
  return w
}

/** Node box size: width fits the longest wrapped line (up to MAX_NODE_W),
 *  height grows with the number of lines. Full text always visible.
 *  Emoji 图标与优先级徽标计入宽度，避免文字溢出。 */
function measureNode(node: RichNode, isRoot: boolean, st?: NodeStyle): MeasuredNode {
  const fs = nodeFontSize(isRoot, st)
  const extraW = nodeExtrasWidth(node, fs)
  const inner = Math.max(48, MAX_NODE_W - NODE_PAD_X - extraW)
  const lines = wrapText(node.title, fs, inner)
  const widest = Math.max(
    ...lines.map((l) => textWidth(l, fs)),
    MIN_NODE_W - NODE_PAD_X - extraW,
  )
  return {
    w: Math.min(MAX_NODE_W, Math.ceil(widest) + NODE_PAD_X + extraW),
    h: Math.max(NODE_H, lines.length * NODE_LINE_H + (NODE_H - NODE_LINE_H)),
    lines,
    fs,
  }
}

/** Dark ink (#18181b) is unreadable on dark-mode cards — fall back to the
 *  theme's default text color there. Sepia/green themes keep it. */
function effectiveInk(color?: string, isDark?: boolean): string | undefined {
  if (!color) return undefined
  if (isDark && color.toLowerCase() === '#18181b') return undefined
  return color
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ---------- tree helpers (operate on a mutable clone) ----------

/** normalizeIds 保留扩展字段（icon/note/…），旧数据无这些字段也安全。 */
function normalizeIds(node: RichNode): RichNode {
  const kids = Array.isArray(node.children) ? node.children : undefined
  return {
    ...node,
    id: node.id || uid(),
    title: typeof node.title === 'string' && node.title ? node.title : '未命名',
    children: kids && kids.length > 0 ? kids.map(normalizeIds) : undefined,
  }
}

function normalizeDoc(d: MindmapDoc): StyledMindmapDoc {
  return { ...(d as StyledMindmapDoc), root: normalizeIds(d.root) }
}

function cloneTree(root: RichNode): RichNode {
  return JSON.parse(JSON.stringify(root)) as RichNode
}

/** 粘贴用：整树重新分配 id，同时保留样式/属性字段。 */
function reIdTree(node: RichNode): RichNode {
  return {
    ...node,
    id: uid(),
    children: node.children && node.children.length > 0 ? node.children.map(reIdTree) : undefined,
  }
}

function findNode(root: RichNode, id: string): RichNode | null {
  if (root.id === id) return root
  for (const c of root.children ?? []) {
    const hit = findNode(c, id)
    if (hit) return hit
  }
  return null
}

function findParent(root: RichNode, id: string): RichNode | null {
  for (const c of root.children ?? []) {
    if (c.id === id) return root
    const hit = findParent(c, id)
    if (hit) return hit
  }
  return null
}

function collectIds(node: RichNode, acc: string[] = []): string[] {
  acc.push(node.id)
  for (const c of node.children ?? []) collectIds(c, acc)
  return acc
}

/** id 的祖先链（从根到其父），找不到返回 null。 */
function ancestorsOf(root: RichNode, id: string, acc: RichNode[] = []): RichNode[] | null {
  if (root.id === id) return acc
  for (const c of root.children ?? []) {
    const hit = ancestorsOf(c, id, [...acc, root])
    if (hit) return hit
  }
  return null
}

/** id 是否位于 subtreeId 的子树内（不含 subtreeId 自身）。 */
function isInsideSubtree(root: RichNode, subtreeId: string, id: string): boolean {
  if (subtreeId === id) return false
  const n = findNode(root, subtreeId)
  return !!n && collectIds(n).includes(id)
}

function walkNodes(node: RichNode, fn: (n: RichNode) => void) {
  fn(node)
  for (const c of node.children ?? []) walkNodes(c, fn)
}

function insertChild(root: RichNode, parentId: string, node: RichNode) {
  const target = findNode(root, parentId)
  if (target) target.children = [...(target.children ?? []), node]
}

/** Insert `node` after siblingId in its parent; no-op when siblingId is the root. */
function insertSibling(root: RichNode, siblingId: string, node: RichNode) {
  const parent = findParent(root, siblingId)
  if (!parent || !parent.children) return
  const idx = parent.children.findIndex((c) => c.id === siblingId)
  if (idx >= 0) parent.children.splice(idx + 1, 0, node)
}

function removeSubtree(root: RichNode, id: string) {
  const parent = findParent(root, id)
  if (!parent || !parent.children) return
  const idx = parent.children.findIndex((c) => c.id === id)
  if (idx >= 0) parent.children.splice(idx, 1)
  if (parent.children.length === 0) delete parent.children
}

// ---------- layouts (htree / vtree / radial，全部跳过折叠子树) ----------

interface LayoutNode {
  id: string
  title: string
  depth: number
  x: number // left edge
  y: number // vertical center
  w: number
  h: number
  lines: string[]
  fs: number
  isRoot: boolean
  /** 原始节点（携带 icon/note/link/priority/bg/shape/branchColor/collapsed） */
  src: RichNode
  /** radial 布局：1 = 根右侧，-1 = 根左侧，0 = 根/非放射布局 */
  side: 1 | -1 | 0
  /** 直接子节点数（折叠徽标用） */
  childCount: number
}

interface LayoutLink {
  x1: number
  y1: number
  x2: number
  y2: number
  depth: number
  /** 预生成的路径（水平/垂直正交折线，或放射贝塞尔） */
  d: string
  /** 该连线（子节点 → 父节点）的自定义颜色 */
  color?: string
}

interface TreeLayout {
  nodes: LayoutNode[]
  links: LayoutLink[]
  width: number
  height: number
}

function visibleKids(n: RichNode, ignoreCollapse: boolean): RichNode[] {
  if (!ignoreCollapse && n.collapsed) return []
  return n.children ?? []
}

/** Tidy horizontal tree layout (root left) with adaptive node sizes.
 *  • Every node is measured (wrapped lines → width up to MAX_NODE_W, height
 *    grows with line count) so long titles wrap instead of being truncated.
 *  • Columns are as wide as the widest node at that depth.
 *  • Each subtree gets a disjoint vertical band (≥ its own height), so nodes
 *    never overlap; parent centers sit in the middle of their band.
 *  • Links connect the parent's right edge to the child's left edge. */
function computeHTree(root: RichNode, styles?: Record<string, NodeStyle>, ignoreCollapse = false): TreeLayout {
  const sizes = new Map<string, MeasuredNode>()
  const parentOf = new Map<string, string>()

  const preWalk = (n: RichNode, depth: number) => {
    sizes.set(n.id, measureNode(n, depth === 0, styles?.[n.id]))
    for (const k of visibleKids(n, ignoreCollapse)) {
      parentOf.set(k.id, n.id)
      preWalk(k, depth + 1)
    }
  }
  preWalk(root, 0)

  // widest node per depth column
  const colW = new Map<number, number>()
  const walkW = (n: RichNode, depth: number) => {
    colW.set(depth, Math.max(colW.get(depth) ?? 0, sizes.get(n.id)!.w))
    for (const k of visibleKids(n, ignoreCollapse)) walkW(k, depth + 1)
  }
  walkW(root, 0)

  const xOf = (depth: number): number => {
    let x = PAD
    for (let d = 0; d < depth; d += 1) x += (colW.get(d) ?? 0) + GAP
    return x
  }

  // subtree height: own height or the children's stacked height, whichever larger
  const subH = (n: RichNode): number => {
    const s = sizes.get(n.id)!
    const kids = visibleKids(n, ignoreCollapse)
    if (kids.length === 0) return s.h
    const kidsSum = kids.reduce((acc, k) => acc + subH(k), 0) + V_GAP * (kids.length - 1)
    return Math.max(s.h, kidsSum)
  }

  const nodes: LayoutNode[] = []
  const place = (n: RichNode, depth: number, top: number) => {
    const s = sizes.get(n.id)!
    const total = subH(n)
    const cy = top + total / 2
    nodes.push({
      id: n.id,
      title: n.title,
      depth,
      x: xOf(depth),
      y: cy,
      w: s.w,
      h: s.h,
      lines: s.lines,
      fs: s.fs,
      isRoot: depth === 0,
      src: n,
      side: 0,
      childCount: (n.children ?? []).length,
    })
    const kids = visibleKids(n, ignoreCollapse)
    if (kids.length > 0) {
      const kidsSum = kids.reduce((acc, k) => acc + subH(k), 0) + V_GAP * (kids.length - 1)
      let kt = top + (total - kidsSum) / 2
      for (const k of kids) {
        place(k, depth + 1, kt)
        kt += subH(k) + V_GAP
      }
    }
  }
  place(root, 0, PAD)

  const centerOf = new Map(nodes.map((n) => [n.id, n] as const))
  const links: LayoutLink[] = []
  for (const n of nodes) {
    const pid = parentOf.get(n.id)
    if (!pid) continue
    const p = centerOf.get(pid)!
    const x1 = p.x + p.w
    const midX = x1 + (n.x - x1) / 2
    links.push({
      x1,
      y1: p.y,
      x2: n.x,
      y2: n.y,
      depth: n.depth,
      d: `M ${x1} ${p.y} L ${midX} ${p.y} L ${midX} ${n.y} L ${n.x} ${n.y}`,
      color: n.src.branchColor,
    })
  }

  const contentW = nodes.reduce((acc, n) => Math.max(acc, n.x + n.w), 0)
  return {
    nodes,
    links,
    width: Math.max(contentW + PAD, PAD * 2 + MIN_NODE_W),
    height: Math.max(PAD * 2 + subH(root), NODE_H + PAD * 2),
  }
}

/** 垂直树（根在上）：把水平树的坐标轴转置 —— 深度变纵向列，
 *  子树在横向带宽内堆叠，连线为垂直正交折线。 */
function computeVTree(root: RichNode, styles?: Record<string, NodeStyle>, ignoreCollapse = false): TreeLayout {
  const sizes = new Map<string, MeasuredNode>()
  const parentOf = new Map<string, string>()

  const preWalk = (n: RichNode, depth: number) => {
    sizes.set(n.id, measureNode(n, depth === 0, styles?.[n.id]))
    for (const k of visibleKids(n, ignoreCollapse)) {
      parentOf.set(k.id, n.id)
      preWalk(k, depth + 1)
    }
  }
  preWalk(root, 0)

  // tallest node per depth row
  const colH = new Map<number, number>()
  const walkH = (n: RichNode, depth: number) => {
    colH.set(depth, Math.max(colH.get(depth) ?? 0, sizes.get(n.id)!.h))
    for (const k of visibleKids(n, ignoreCollapse)) walkH(k, depth + 1)
  }
  walkH(root, 0)

  const yOf = (depth: number): number => {
    let y = PAD
    for (let d = 0; d < depth; d += 1) y += (colH.get(d) ?? 0) + GAP
    return y
  }

  // subtree width: own width or the children's side-by-side width
  const subW = (n: RichNode): number => {
    const s = sizes.get(n.id)!
    const kids = visibleKids(n, ignoreCollapse)
    if (kids.length === 0) return s.w
    const kidsW = kids.reduce((acc, k) => acc + subW(k), 0) + GAP * (kids.length - 1)
    return Math.max(s.w, kidsW)
  }

  const nodes: LayoutNode[] = []
  const place = (n: RichNode, depth: number, left: number) => {
    const s = sizes.get(n.id)!
    const total = subW(n)
    nodes.push({
      id: n.id,
      title: n.title,
      depth,
      x: left + (total - s.w) / 2,
      y: yOf(depth) + s.h / 2,
      w: s.w,
      h: s.h,
      lines: s.lines,
      fs: s.fs,
      isRoot: depth === 0,
      src: n,
      side: 0,
      childCount: (n.children ?? []).length,
    })
    const kids = visibleKids(n, ignoreCollapse)
    if (kids.length > 0) {
      const kidsW = kids.reduce((acc, k) => acc + subW(k), 0) + GAP * (kids.length - 1)
      let kl = left + (total - kidsW) / 2
      for (const k of kids) {
        place(k, depth + 1, kl)
        kl += subW(k) + GAP
      }
    }
  }
  place(root, 0, PAD)

  const centerOf = new Map(nodes.map((n) => [n.id, n] as const))
  const links: LayoutLink[] = []
  for (const n of nodes) {
    const pid = parentOf.get(n.id)
    if (!pid) continue
    const p = centerOf.get(pid)!
    const x1 = p.x + p.w / 2
    const y1 = p.y + p.h / 2
    const x2 = n.x + n.w / 2
    const y2 = n.y - n.h / 2
    const midY = y1 + (y2 - y1) / 2
    links.push({
      x1,
      y1,
      x2,
      y2,
      depth: n.depth,
      d: `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`,
      color: n.src.branchColor,
    })
  }

  const contentW = nodes.reduce((acc, n) => Math.max(acc, n.x + n.w), 0)
  const contentH = nodes.reduce((acc, n) => Math.max(acc, n.y + n.h / 2), 0)
  return {
    nodes,
    links,
    width: Math.max(contentW + PAD, PAD * 2 + MIN_NODE_W),
    height: Math.max(contentH + PAD, NODE_H + PAD * 2),
  }
}

/** 导图模式（经典 mindmap）：根在中心，一级分支左右交替放射；
 *  每一侧按水平树展开（列对齐、子树纵向堆叠），连线为贝塞尔曲线。 */
function computeRadial(root: RichNode, styles?: Record<string, NodeStyle>, ignoreCollapse = false): TreeLayout {
  const sizes = new Map<string, MeasuredNode>()
  sizes.set(root.id, measureNode(root, true, styles?.[root.id]))
  const parentOf = new Map<string, string>()
  const nodes: LayoutNode[] = []

  const layoutSide = (side: 1 | -1) => {
    const branches = (root.children ?? []).filter((_, i) => (side === 1 ? i % 2 === 0 : i % 2 === 1))
    if (branches.length === 0) return

    const colW = new Map<number, number>()
    const walk = (n: RichNode, d: number) => {
      sizes.set(n.id, measureNode(n, false, styles?.[n.id]))
      colW.set(d, Math.max(colW.get(d) ?? 0, sizes.get(n.id)!.w))
      for (const k of visibleKids(n, ignoreCollapse)) {
        parentOf.set(k.id, n.id)
        walk(k, d + 1)
      }
    }
    for (const b of branches) {
      parentOf.set(b.id, root.id)
      walk(b, 0)
    }

    const subH = (n: RichNode): number => {
      const s = sizes.get(n.id)!
      const kids = visibleKids(n, ignoreCollapse)
      if (kids.length === 0) return s.h
      return Math.max(s.h, kids.reduce((a, k) => a + subH(k), 0) + V_GAP * (kids.length - 1))
    }

    const rootS = sizes.get(root.id)!
    // 距根中心的水平距离（本侧第 d 列的左缘）
    const xOf = (d: number): number => {
      let x = rootS.w / 2 + GAP
      for (let i = 0; i < d; i += 1) x += (colW.get(i) ?? 0) + GAP
      return x
    }

    const totalH = branches.reduce((a, b) => a + subH(b), 0) + V_GAP * (branches.length - 1)

    const place = (n: RichNode, d: number, top: number) => {
      const s = sizes.get(n.id)!
      const total = subH(n)
      const cy = top + total / 2
      const lx = xOf(d)
      nodes.push({
        id: n.id,
        title: n.title,
        depth: d + 1,
        x: side === 1 ? lx : -lx - s.w,
        y: cy,
        w: s.w,
        h: s.h,
        lines: s.lines,
        fs: s.fs,
        isRoot: false,
        src: n,
        side,
        childCount: (n.children ?? []).length,
      })
      const kids = visibleKids(n, ignoreCollapse)
      if (kids.length > 0) {
        const kidsSum = kids.reduce((a, k) => a + subH(k), 0) + V_GAP * (kids.length - 1)
        let kt = top + (total - kidsSum) / 2
        for (const k of kids) {
          place(k, d + 1, kt)
          kt += subH(k) + V_GAP
        }
      }
    }
    let top = -totalH / 2
    for (const b of branches) {
      place(b, 0, top)
      top += subH(b) + V_GAP
    }
  }

  layoutSide(1)
  layoutSide(-1)

  const rootS = sizes.get(root.id)!
  nodes.push({
    id: root.id,
    title: root.title,
    depth: 0,
    x: -rootS.w / 2,
    y: 0,
    w: rootS.w,
    h: rootS.h,
    lines: rootS.lines,
    fs: rootS.fs,
    isRoot: true,
    src: root,
    side: 0,
    childCount: (root.children ?? []).length,
  })

  // 归一化到正坐标
  let minX = -rootS.w / 2
  let maxX = rootS.w / 2
  let minY = -rootS.h / 2
  let maxY = rootS.h / 2
  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    maxX = Math.max(maxX, n.x + n.w)
    minY = Math.min(minY, n.y - n.h / 2)
    maxY = Math.max(maxY, n.y + n.h / 2)
  }
  const dx = PAD - minX
  const dy = PAD - minY
  for (const n of nodes) {
    n.x += dx
    n.y += dy
  }

  const byId = new Map(nodes.map((n) => [n.id, n] as const))
  const links: LayoutLink[] = []
  for (const n of nodes) {
    const pid = parentOf.get(n.id)
    if (!pid) continue
    const p = byId.get(pid)!
    const x1 = n.side === 1 ? p.x + p.w : p.x
    const x2 = n.side === 1 ? n.x : n.x + n.w
    const cdx = Math.max(24, Math.abs(x2 - x1) * 0.45)
    const d =
      n.side === 1
        ? `M ${x1} ${p.y} C ${x1 + cdx} ${p.y}, ${x2 - cdx} ${n.y}, ${x2} ${n.y}`
        : `M ${x1} ${p.y} C ${x1 - cdx} ${p.y}, ${x2 + cdx} ${n.y}, ${x2} ${n.y}`
    links.push({ x1, y1: p.y, x2, y2: n.y, depth: n.depth, d, color: n.src.branchColor })
  }

  return {
    nodes,
    links,
    width: maxX - minX + PAD * 2,
    height: maxY - minY + PAD * 2,
  }
}

function computeLayout(
  root: RichNode,
  styles?: Record<string, NodeStyle>,
  kind: LayoutKind = 'htree',
  opts?: { ignoreCollapse?: boolean },
): TreeLayout {
  const ignoreCollapse = !!opts?.ignoreCollapse
  if (kind === 'vtree') return computeVTree(root, styles, ignoreCollapse)
  if (kind === 'radial') return computeRadial(root, styles, ignoreCollapse)
  return computeHTree(root, styles, ignoreCollapse)
}

/** 折叠圆钮相对节点左上角的位置（跟随布局方向） */
function collapseBadgeStyle(n: LayoutNode, kind: LayoutKind): React.CSSProperties {
  if (kind === 'vtree') return { left: n.w / 2 - 10, top: n.h + 3 }
  if (kind === 'radial' && n.side === -1) return { left: -26, top: n.h / 2 - 10 }
  return { left: n.w + 3, top: n.h / 2 - 10 }
}

// ---------- export helpers ----------

function buildMapSvg(doc: StyledMindmapDoc, layout: TreeLayout): string {
  const parts: string[] = []
  parts.push(`<rect x="0" y="0" width="${layout.width}" height="${layout.height}" fill="#ffffff"/>`)
  for (const l of layout.links) {
    parts.push(
      `<path d="${l.d}" fill="none" stroke="${l.color ?? '#a1a1aa'}" stroke-width="${l.depth === 1 ? 1.75 : 1.25}" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
  }
  for (const n of layout.nodes) {
    const st = doc.styles?.[n.id]
    const src = n.src
    const hasBg = !!src.bg
    const isPlain = src.shape === 'plain'
    const fill = hasBg ? src.bg! : n.isRoot ? '#18131b' : '#ffffff'
    const stroke = hasBg ? src.bg! : n.isRoot ? '#18131b' : '#d4d4d8'
    const color = n.isRoot && !hasBg ? '#ffffff' : st?.color || '#18131b'
    const rx = src.shape === 'ellipse' ? Math.floor(Math.min(n.w, n.h) / 2) : n.isRoot ? 18 : 12
    if (!isPlain || hasBg) {
      parts.push(
        `<rect x="${n.x}" y="${n.y - n.h / 2}" width="${n.w}" height="${n.h}" rx="${rx}" fill="${fill}" stroke="${isPlain ? 'none' : stroke}" stroke-width="1.5"/>`,
      )
    }
    // wrapped full text — one tspan per line, vertically centered（首行带图标/优先级前缀）
    const prefix = `${src.icon ?? ''}${src.priority ? `P${src.priority} ` : ''}`
    const tspans = n.lines
      .map(
        (ln, i) =>
          `<tspan x="${(n.x + n.w / 2).toFixed(1)}" y="${(n.y + (i - (n.lines.length - 1) / 2) * NODE_LINE_H).toFixed(1)}" dominant-baseline="central">${escapeXml(i === 0 ? prefix + ln : ln)}</tspan>`,
      )
      .join('')
    const fw = st?.bold || n.isRoot ? 600 : 400
    parts.push(
      `<text text-anchor="middle" font-family="-apple-system,'PingFang SC','Microsoft YaHei','Noto Sans CJK SC',sans-serif" font-size="${n.fs}" font-weight="${fw}" fill="${color}">${tspans}</text>`,
    )
    if (src.note) {
      parts.push(`<circle cx="${n.x + n.w - 7}" cy="${n.y - n.h / 2 + 7}" r="3.5" fill="#f59e0b"/>`)
    }
    if (src.link) {
      parts.push(`<circle cx="${n.x + n.w - 7}" cy="${n.y + n.h / 2 - 7}" r="3.5" fill="#3b82f6"/>`)
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">${parts.join('')}</svg>`
}

async function svgToPngBlob(svg: string, width: number, height: number, scale = 2): Promise<Blob> {
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('SVG 渲染失败'))
    img.src = url
  })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 不可用')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('PNG 编码失败')
  return blob
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(blob)
  })
}

/** Markdown 大纲：`- ` 缩进列表，含 emoji / 优先级 / 链接 / 备注注释。 */
function buildMarkdown(doc: StyledMindmapDoc): string {
  const lines: string[] = []
  const root: RichNode = doc.root
  lines.push(`# ${root.icon ? `${root.icon} ` : ''}${root.title}`, '')
  const walk = (n: RichNode, depth: number) => {
    for (const c of (n.children ?? []) as RichNode[]) {
      const bits: string[] = []
      if (c.icon) bits.push(c.icon)
      if (c.priority) bits.push(`**P${c.priority}**`)
      bits.push(c.link ? `[${c.title}](${c.link})` : c.title)
      let line = `${'  '.repeat(depth)}- ${bits.join(' ')}`
      if (c.note) line += ` <!-- ${c.note.replace(/\s+/g, ' ')} -->`
      lines.push(line)
      walk(c, depth + 1)
    }
  }
  walk(root, 0)
  return `${lines.join('\n')}\n`
}

/** OPML 标准大纲 XML（text/_note 属性均转义）。 */
function buildOpml(doc: StyledMindmapDoc): string {
  const outline = (n: RichNode): string => {
    const attrs = `text="${escapeXml(n.title)}"${n.note ? ` _note="${escapeXml(n.note)}"` : ''}`
    const kids = n.children ?? []
    if (kids.length === 0) return `<outline ${attrs}/>`
    return `<outline ${attrs}>${kids.map(outline).join('')}</outline>`
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>${escapeXml(doc.title)}</title></head><body>${outline(doc.root)}</body></opml>`
}

/** FreeMind .mm：`<map version="1.0.1"><node TEXT="…">…</node></map>`，
 *  含 POSITION / FOLDED / COLOR / BACKGROUND_COLOR / edge 颜色 / 备注。 */
function buildFreemind(doc: StyledMindmapDoc): string {
  const nodeXml = (n: RichNode, depth: number, side?: 'right' | 'left'): string => {
    const st = doc.styles?.[n.id]
    let attrs = `TEXT="${escapeXml(n.title)}"`
    if (side) attrs += ` POSITION="${side}"`
    if (n.collapsed) attrs += ' FOLDED="true"'
    if (st?.color) attrs += ` COLOR="${st.color}"`
    if (n.bg) attrs += ` BACKGROUND_COLOR="${n.bg}"`
    const edge = n.branchColor ? `<edge COLOR="${n.branchColor}"/>` : ''
    const icon = n.priority ? `<icon BUILTIN="full-${n.priority}"/>` : ''
    const note = n.note
      ? `<hook NAME="accessories/plugins/ManageNoteContents.xml"><text>${escapeXml(n.note)}</text></hook>`
      : ''
    const kids = (n.children ?? []).map((c, i) =>
      nodeXml(c, depth + 1, depth === 0 ? (i % 2 === 0 ? 'right' : 'left') : undefined),
    )
    return `<node ${attrs}>${edge}${icon}${note}${kids.join('')}</node>`
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<map version="1.0.1">${nodeXml(doc.root, 0)}</map>`
}

// ---------- component ----------

export function MindmapView({
  content,
  cardId,
  cardTitle,
  initialDocs,
  onSaved,
  pages,
  chunks,
  menuActions,
  onMenuAction,
}: MindmapViewProps) {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'
  const [docs, setDocs] = React.useState<StyledMindmapDoc[]>(() => (initialDocs ?? []).map(normalizeDoc))
  const [view, setView] = React.useState<'home' | 'map'>('home')
  const [docId, setDocId] = React.useState<string | null>(null)
  const [editMode, setEditMode] = React.useState(false)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [draftTitle, setDraftTitle] = React.useState('')
  const [clipboard, setClipboard] = React.useState<RichNode | null>(null)
  const [undoStack, setUndoStack] = React.useState<string[]>([])
  const [redoStack, setRedoStack] = React.useState<string[]>([])
  const [styleOpen, setStyleOpen] = React.useState(false)

  const [newOpen, setNewOpen] = React.useState(false)
  const [newScope, setNewScope] = React.useState('全文')
  const [newLevels, setNewLevels] = React.useState<2 | 3>(2)
  /** single = one map for the chosen scope; each = one map per page/chunk;
   *  merge = per-page/chunk branches merged under one 全文 root. */
  const [newSplit, setNewSplit] = React.useState<'single' | 'each' | 'merge'>('single')
  const [generating, setGenerating] = React.useState(false)
  const [extendOpen, setExtendOpen] = React.useState(false)
  const [extendSel, setExtendSel] = React.useState<Set<string>>(new Set())
  const [extending, setExtending] = React.useState(false)
  const [listOpen, setListOpen] = React.useState(false)
  const [exportOpen, setExportOpen] = React.useState(false)
  const [exporting, setExporting] = React.useState<ExportKind | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null)
  // rename + batch-delete (list sheet)
  const [renameId, setRenameId] = React.useState<string | null>(null)
  const [renameTitle, setRenameTitle] = React.useState('')
  const [batchMode, setBatchMode] = React.useState(false)
  const [batchSel, setBatchSel] = React.useState<Set<string>>(new Set())
  const [confirmBatch, setConfirmBatch] = React.useState(false)

  // ---- 画布：布局/视图模式/缩放平移 ----
  const [canvasMode, setCanvasMode] = React.useState<'graph' | 'outline'>('graph')
  const [transform, setTransform] = React.useState<{ scale: number; tx: number; ty: number }>({ scale: 1, tx: 0, ty: 0 })
  // ---- 查找 ----
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [searchQ, setSearchQ] = React.useState('')
  const [searchIdx, setSearchIdx] = React.useState(0)
  // ---- 节点拖拽 ----
  const [dragState, setDragState] = React.useState<DragState | null>(null)
  const [dropChoice, setDropChoice] = React.useState<DropChoice | null>(null)
  // ---- 多选批量 ----
  const [multiSelMode, setMultiSelMode] = React.useState(false)
  const [multiSel, setMultiSel] = React.useState<Set<string>>(new Set())
  // ---- 节点增强属性弹层 ----
  const [iconOpenId, setIconOpenId] = React.useState<string | null>(null)
  const [noteOpenId, setNoteOpenId] = React.useState<string | null>(null)
  const [noteDraft, setNoteDraft] = React.useState('')
  const [linkOpenId, setLinkOpenId] = React.useState<string | null>(null)
  const [linkDraft, setLinkDraft] = React.useState('')
  const [priorityOpenId, setPriorityOpenId] = React.useState<string | null>(null)

  const cancelEditRef = React.useRef(false)
  const saveTimerRef = React.useRef<number | null>(null)
  // Write-through refs so event handlers always see the latest list/doc.
  const docsRef = React.useRef(docs)
  const docIdRef = React.useRef(docId)

  // ---- 画布/手势 refs ----
  const canvasRef = React.useRef<HTMLDivElement | null>(null)
  const transformRef = React.useRef(transform)
  const layoutRef = React.useRef<TreeLayout | null>(null)
  const dragRef = React.useRef<DragState | null>(null)
  const suppressClickUntilRef = React.useRef(0)
  const focusIdRef = React.useRef<string | null>(null)
  const rowRefs = React.useRef(new Map<string, HTMLDivElement>())

  React.useEffect(() => {
    docsRef.current = docs
  }, [docs])

  const getDoc = React.useCallback(
    (): StyledMindmapDoc | null => docsRef.current.find((d) => d.id === docIdRef.current) ?? null,
    [],
  )
  const currentDoc = docId ? docs.find((d) => d.id === docId) ?? null : null

  // ---------- persistence (debounced 800ms PATCH; flush on exit/unmount) ----------

  const persistNow = React.useCallback(
    async (list: StyledMindmapDoc[]) => {
      if (!cardId) return
      try {
        const res = await fetch(`/api/cards/${cardId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mindmaps: list }),
        })
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(err.error || '保存失败')
        }
        onSaved?.(list)
        toast.success('已保存', { duration: 1200 })
      } catch (err) {
        toast.error('导图保存失败：' + (err instanceof Error ? err.message : '未知错误'))
      }
    },
    [cardId, onSaved],
  )

  const flushSave = React.useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    void persistNow(docsRef.current)
  }, [persistNow])

  const scheduleSave = React.useCallback(
    (list: StyledMindmapDoc[]) => {
      onSaved?.(list)
      if (!cardId) return
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null
        void persistNow(docsRef.current)
      }, 800)
    },
    [cardId, onSaved, persistNow],
  )

  // Flush a pending auto-save when the tool unmounts (sheet closed).
  React.useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
        void persistNow(docsRef.current)
      }
    }
  }, [persistNow])

  // ---------- doc / tree mutation plumbing ----------

  const setDocsAndSave = React.useCallback(
    (next: StyledMindmapDoc[]) => {
      docsRef.current = next
      setDocs(next)
      scheduleSave(next)
    },
    [scheduleSave],
  )

  const applyRoot = React.useCallback((root: RichNode) => {
    const id = docIdRef.current
    if (!id) return
    const next = docsRef.current.map((d) =>
      d.id === id ? { ...d, root, updatedAt: new Date().toISOString() } : d,
    )
    setDocsAndSave(next)
    setSelectedId((sel) => (sel && findNode(root, sel) ? sel : null))
    setEditingId((eid) => (eid && findNode(root, eid) ? eid : null))
  }, [setDocsAndSave])

  /** 撤销快照：整文档（root + styles + meta），保证样式/属性修改也能回退。 */
  const docSnapshot = (d: StyledMindmapDoc): string =>
    JSON.stringify({ root: d.root, styles: d.styles ?? {}, meta: d.meta ?? {} })

  const pushUndo = () => {
    const d = getDoc()
    if (!d) return
    setUndoStack((s) => [...s.slice(-39), docSnapshot(d)])
    setRedoStack([])
  }

  /** mutateRoot：改树结构/节点属性。silent=true 时不入撤销栈（折叠等）。 */
  const mutateRoot = (fn: (clone: RichNode) => void, opts?: { silent?: boolean }) => {
    const doc = getDoc()
    if (!doc) return
    if (!opts?.silent) pushUndo()
    const clone = cloneTree(doc.root)
    fn(clone)
    applyRoot(clone)
  }

  const updateDocInPlace = (fn: (d: StyledMindmapDoc) => StyledMindmapDoc) => {
    const id = docIdRef.current
    if (!id) return
    const next = docsRef.current.map((d) =>
      d.id === id ? { ...fn(d), updatedAt: new Date().toISOString() } : d,
    )
    setDocsAndSave(next)
  }

  const applySnapshot = (snap: string) => {
    const d = getDoc()
    if (!d) return
    const parsed = JSON.parse(snap) as {
      root: RichNode
      styles?: Record<string, NodeStyle>
      meta?: DocMeta
    }
    updateDocInPlace((cur) => ({
      ...cur,
      root: parsed.root,
      styles: parsed.styles ?? {},
      meta: parsed.meta,
    }))
    setSelectedId((sel) => (sel && findNode(parsed.root, sel) ? sel : null))
    setEditingId((eid) => (eid && findNode(parsed.root, eid) ? eid : null))
  }

  const undo = () => {
    const doc = getDoc()
    if (!doc || undoStack.length === 0) return
    const snapshot = undoStack[undoStack.length - 1]
    setUndoStack((s) => s.slice(0, -1))
    setRedoStack((r) => [...r, docSnapshot(doc)])
    applySnapshot(snapshot)
  }

  const redo = () => {
    const doc = getDoc()
    if (!doc || redoStack.length === 0) return
    const snapshot = redoStack[redoStack.length - 1]
    setRedoStack((r) => r.slice(0, -1))
    setUndoStack((s) => [...s, docSnapshot(doc)])
    applySnapshot(snapshot)
  }

  // ---------- node operations ----------

  const commitEdit = () => {
    if (cancelEditRef.current) {
      cancelEditRef.current = false
      setEditingId(null)
      return
    }
    const id = editingId
    setEditingId(null)
    if (!id) return
    const doc = getDoc()
    const node = doc ? findNode(doc.root, id) : null
    if (!node) return
    const title = draftTitle.trim() || node.title || '未命名'
    if (title === node.title) return
    mutateRoot((clone) => {
      const n = findNode(clone, id)
      if (n) n.title = title
    })
  }

  const startEdit = (id: string) => {
    if (editingId && editingId !== id) commitEdit()
    const doc = getDoc()
    const node = doc ? findNode(doc.root, id) : null
    if (!node || !doc) return
    pushUndo()
    cancelEditRef.current = false
    setSelectedId(id)
    setEditingId(id)
    setDraftTitle(node.title)
  }

  const cancelEdit = () => {
    cancelEditRef.current = true
    setEditingId(null)
  }

  const addChild = (parentId: string) => {
    const doc = getDoc()
    if (!doc || !findNode(doc.root, parentId)) return
    const node: RichNode = { id: uid(), title: '新节点' }
    mutateRoot((clone) => insertChild(clone, parentId, node))
    setSelectedId(node.id)
    startEdit(node.id)
  }

  const addSibling = (id: string) => {
    const doc = getDoc()
    if (!doc) return
    if (id === doc.root.id) {
      toast.info('根节点没有同级节点')
      return
    }
    if (!findNode(doc.root, id)) return
    const node: RichNode = { id: uid(), title: '新节点' }
    mutateRoot((clone) => insertSibling(clone, id, node))
    setSelectedId(node.id)
    startEdit(node.id)
  }

  const removeNode = (id: string) => {
    const doc = getDoc()
    if (!doc) return
    if (id === doc.root.id) {
      toast.warning('根节点不可删除')
      return
    }
    const target = findNode(doc.root, id)
    if (!target) return
    const removedIds = new Set(collectIds(target))
    mutateRoot((clone) => removeSubtree(clone, id))
    // clean orphaned node styles
    updateDocInPlace((d) => {
      if (!d.styles) return d
      const styles: Record<string, NodeStyle> = {}
      for (const [k, v] of Object.entries(d.styles)) {
        if (!removedIds.has(k)) styles[k] = v
      }
      return { ...d, styles }
    })
    if (selectedId && removedIds.has(selectedId)) setSelectedId(null)
    if (multiSel.size > 0) setMultiSel((prev) => {
      const n = new Set(prev)
      for (const rid of removedIds) n.delete(rid)
      return n
    })
    toast.success('已删除节点及其子树')
  }

  const copyNode = (id: string) => {
    const doc = getDoc()
    const node = doc ? findNode(doc.root, id) : null
    if (!node) return
    setClipboard(cloneTree(node))
    toast.success('已复制节点及其子树')
  }

  const pasteChild = (id: string) => {
    const doc = getDoc()
    if (!doc || !clipboard) {
      toast.info('剪贴板为空，请先复制节点')
      return
    }
    if (!findNode(doc.root, id)) return
    const pasted = reIdTree(clipboard)
    mutateRoot((clone) => insertChild(clone, id, pasted))
    setSelectedId(pasted.id)
    toast.success('已粘贴子树')
  }

  const setNodeStyle = (id: string, patch: NodeStyle) => {
    pushUndo()
    updateDocInPlace((d) => {
      const styles = { ...(d.styles ?? {}) }
      styles[id] = { ...(styles[id] ?? {}), ...patch }
      return { ...d, styles }
    })
  }

  /** 设置节点扩展属性（icon/note/link/priority/bg/shape/branchColor），
   *  传 undefined 表示清除该字段。 */
  const setNodeProps = (id: string, patch: Partial<RichNodeProps>) => {
    mutateRoot((clone) => {
      const n = findNode(clone, id)
      if (!n) return
      const rec = n as unknown as Record<string, unknown>
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === null || v === '') delete rec[k]
        else rec[k] = v
      }
    })
  }

  // ---------- 折叠 / 展开（静默，不入撤销栈） ----------

  const toggleCollapse = (id: string) => {
    mutateRoot(
      (clone) => {
        const n = findNode(clone, id)
        if (!n || !n.children || n.children.length === 0) return
        n.collapsed = !n.collapsed
      },
      { silent: true },
    )
  }

  const expandAll = () => {
    mutateRoot(
      (clone) => {
        walkNodes(clone, (n) => {
          n.collapsed = false
        })
      },
      { silent: true },
    )
    toast.success('已全部展开')
  }

  // ---------- 大纲视图的层级/顺序操作 ----------

  /** 上移/下移：在同级内交换顺序 */
  const moveSibling = (id: string, dir: -1 | 1) => {
    const doc = getDoc()
    if (!doc || id === doc.root.id) return
    const parent = findParent(doc.root, id)
    if (!parent?.children) return
    const idx = parent.children.findIndex((c) => c.id === id)
    if (dir === -1 && idx <= 0) {
      toast.info('已经是第一个同级节点')
      return
    }
    if (dir === 1 && idx >= parent.children.length - 1) {
      toast.info('已经是最后一个同级节点')
      return
    }
    mutateRoot((clone) => {
      const p = findParent(clone, id)
      if (!p?.children) return
      const i = p.children.findIndex((c) => c.id === id)
      const [n] = p.children.splice(i, 1)
      p.children.splice(i + dir, 0, n)
    })
  }

  /** 升级：变为原父节点的下一个同级节点 */
  const promoteNode = (id: string) => {
    const doc = getDoc()
    if (!doc || id === doc.root.id) return
    const parent = findParent(doc.root, id)
    if (!parent) return
    if (parent.id === doc.root.id) {
      toast.info('已经是第一层级，无法升级')
      return
    }
    mutateRoot((clone) => {
      const node = findNode(clone, id)
      const parentId = node ? findParent(clone, id)?.id : undefined
      if (!node || !parentId) return
      removeSubtree(clone, id)
      insertSibling(clone, parentId, node)
    })
  }

  /** 降级：变为前一个同级节点的子节点 */
  const demoteNode = (id: string) => {
    const doc = getDoc()
    if (!doc || id === doc.root.id) return
    const parent = findParent(doc.root, id)
    if (!parent?.children) return
    const idx = parent.children.findIndex((c) => c.id === id)
    if (idx <= 0) {
      toast.info('前面没有同级节点，无法降级')
      return
    }
    const prevId = parent.children[idx - 1].id
    mutateRoot((clone) => {
      const node = findNode(clone, id)
      if (!node) return
      removeSubtree(clone, id)
      insertChild(clone, prevId, node)
      const prev = findNode(clone, prevId)
      if (prev) prev.collapsed = false
    })
  }

  // ---------- 节点拖拽移动（松手后选择落点） ----------

  const performMove = (mode: 'child' | 'before' | 'after') => {
    const dc = dropChoice
    if (!dc) return
    setDropChoice(null)
    const doc = getDoc()
    if (!doc) return
    if (dc.sourceId === doc.root.id) {
      toast.warning('根节点不可移动')
      return
    }
    if (isInsideSubtree(doc.root, dc.sourceId, dc.targetId)) {
      toast.error('不能移动到自身子树内')
      return
    }
    mutateRoot((clone) => {
      const src = findNode(clone, dc.sourceId)
      if (!src) return
      removeSubtree(clone, dc.sourceId)
      if (mode === 'child') {
        const t = findNode(clone, dc.targetId)
        if (t) {
          t.collapsed = false
          t.children = [...(t.children ?? []), src]
        }
      } else {
        const parent = findParent(clone, dc.targetId)
        if (parent?.children) {
          const idx = parent.children.findIndex((c) => c.id === dc.targetId)
          if (idx >= 0) parent.children.splice(mode === 'before' ? idx : idx + 1, 0, src)
        }
      }
    })
    toast.success(mode === 'child' ? '已移入目标节点' : '已调整节点位置')
  }

  // ---------- 多选与批量 ----------

  const enterMultiSelect = (id?: string) => {
    setEditMode(true)
    setMultiSelMode(true)
    setMultiSel(id ? new Set([id]) : new Set())
    setSelectedId(null)
    setStyleOpen(false)
  }

  const exitMultiSelect = () => {
    setMultiSelMode(false)
    setMultiSel(new Set())
  }

  const toggleMultiSel = (id: string) => {
    setMultiSel((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  const batchDelete = () => {
    const doc = getDoc()
    if (!doc || multiSel.size === 0) return
    const ids = [...multiSel].filter((id) => id !== doc.root.id && findNode(doc.root, id))
    if (ids.length === 0) {
      toast.info('没有可删除的节点')
      return
    }
    const removedStyles = new Set<string>()
    for (const id of ids) {
      const n = findNode(doc.root, id)
      if (n) for (const rid of collectIds(n)) removedStyles.add(rid)
    }
    mutateRoot((clone) => {
      for (const id of ids) removeSubtree(clone, id)
    })
    updateDocInPlace((d) => {
      if (!d.styles) return d
      const styles: Record<string, NodeStyle> = {}
      for (const [k, v] of Object.entries(d.styles)) {
        if (!removedStyles.has(k)) styles[k] = v
      }
      return { ...d, styles }
    })
    setMultiSel(new Set())
    toast.success(`已删除 ${ids.length} 个节点（可撤销）`)
  }

  const batchSetColor = (c: string) => {
    if (multiSel.size === 0) return
    pushUndo()
    updateDocInPlace((d) => {
      const styles = { ...(d.styles ?? {}) }
      for (const id of multiSel) styles[id] = { ...(styles[id] ?? {}), color: c }
      return { ...d, styles }
    })
    toast.success(`已统一 ${multiSel.size} 个节点颜色`)
  }

  const batchSetBold = (nextBold: boolean) => {
    if (multiSel.size === 0) return
    pushUndo()
    updateDocInPlace((d) => {
      const styles = { ...(d.styles ?? {}) }
      for (const id of multiSel) styles[id] = { ...(styles[id] ?? {}), bold: nextBold }
      return { ...d, styles }
    })
    toast.success(nextBold ? `已加粗 ${multiSel.size} 个节点` : `已取消加粗`)
  }

  const batchSetPriority = (p: 1 | 2 | 3) => {
    if (multiSel.size === 0) return
    pushUndo()
    mutateRoot(
      (clone) => {
        for (const id of multiSel) {
          const n = findNode(clone, id)
          if (n) n.priority = p
        }
      },
      { silent: true },
    )
    toast.success(`已设置 ${multiSel.size} 个节点为 P${p}`)
  }

  // ---------- 节点增强属性编辑器 ----------

  const openNoteEditor = (id: string) => {
    const doc = getDoc()
    const n = doc ? findNode(doc.root, id) : null
    setNoteDraft(n?.note ?? '')
    setNoteOpenId(id)
  }

  const openLinkEditor = (id: string) => {
    const doc = getDoc()
    const n = doc ? findNode(doc.root, id) : null
    setLinkDraft(n?.link ?? '')
    setLinkOpenId(id)
  }

  const openLink = (raw: string) => {
    const url = raw.trim()
    if (!url) return
    const full = /^https?:\/\//i.test(url) ? url : `https://${url}`
    try {
      window.open(full, '_blank', 'noopener,noreferrer')
    } catch {
      toast.error('无法打开链接')
    }
  }

  // ---------- node context menu ----------

  const nodeMenuActions = (id: string): MenuAction[] => {
    if (menuActions) return menuActions
    const doc = getDoc()
    const isRoot = doc ? id === doc.root.id : false
    const target = doc ? findNode(doc.root, id) : null
    const hasKids = !!(target?.children && target.children.length > 0)
    return [
      { key: 'edit', label: '编辑文字', icon: <Pencil className="size-3.5" strokeWidth={1.75} /> },
      { key: 'add-child', label: '添加子级', icon: <GitBranchPlus className="size-3.5" strokeWidth={1.75} /> },
      {
        key: 'add-sibling',
        label: '添加同级',
        icon: <Plus className="size-3.5" strokeWidth={1.75} />,
        disabled: isRoot,
      },
      { key: 'icon', label: '图标', icon: <Smile className="size-3.5" strokeWidth={1.75} /> },
      {
        key: 'note',
        label: target?.note ? '编辑备注' : '添加备注',
        icon: <StickyNote className="size-3.5" strokeWidth={1.75} />,
      },
      {
        key: 'link',
        label: target?.link ? '编辑链接' : '添加链接',
        icon: <Link2 className="size-3.5" strokeWidth={1.75} />,
      },
      { key: 'priority', label: '优先级', icon: <Flag className="size-3.5" strokeWidth={1.75} /> },
      ...(hasKids
        ? [
            {
              key: 'collapse',
              label: target?.collapsed ? '展开分支' : '折叠分支',
              icon: target?.collapsed ? (
                <UnfoldVertical className="size-3.5" strokeWidth={1.75} />
              ) : (
                <ChevronsDown className="size-3.5" strokeWidth={1.75} />
              ),
            },
          ]
        : []),
      { key: 'copy', label: '复制节点', icon: <Copy className="size-3.5" strokeWidth={1.75} /> },
      ...(clipboard
        ? [
            {
              key: 'paste',
              label: '粘贴子级',
              icon: <ClipboardPaste className="size-3.5" strokeWidth={1.75} />,
            },
          ]
        : []),
      { key: 'multiselect', label: '多选批量', icon: <SquareCheck className="size-3.5" strokeWidth={1.75} /> },
      {
        key: 'delete',
        label: '删除',
        icon: <Trash2 className="size-3.5" strokeWidth={1.75} />,
        danger: true,
        disabled: isRoot,
      },
    ]
  }

  const handleNodeMenu = (key: string, id: string) => {
    switch (key) {
      case 'edit':
        startEdit(id)
        break
      case 'add-child':
        addChild(id)
        break
      case 'add-sibling':
        addSibling(id)
        break
      case 'icon':
        setIconOpenId(id)
        break
      case 'note':
        openNoteEditor(id)
        break
      case 'link':
        openLinkEditor(id)
        break
      case 'priority':
        setPriorityOpenId(id)
        break
      case 'collapse':
        toggleCollapse(id)
        break
      case 'multiselect':
        enterMultiSelect(id)
        break
      case 'copy':
        copyNode(id)
        break
      case 'paste':
        pasteChild(id)
        break
      case 'delete':
        removeNode(id)
        break
      default:
        onMenuAction?.(key, id)
    }
  }

  // ---------- doc management ----------

  const openDoc = (id: string, edit = false) => {
    docIdRef.current = id
    setDocId(id)
    setView('map')
    setEditMode(edit)
    setSelectedId(null)
    setEditingId(null)
    setStyleOpen(false)
    setUndoStack([])
    setRedoStack([])
    setListOpen(false)
    // 重置画布状态
    setCanvasMode('graph')
    setSearchOpen(false)
    setSearchQ('')
    setSearchIdx(0)
    focusIdRef.current = null
    setMultiSelMode(false)
    setMultiSel(new Set())
    setDragState(null)
    setDropChoice(null)
  }

  const closeDoc = () => {
    docIdRef.current = null
    setDocId(null)
    setView('home')
    setEditMode(false)
    setSelectedId(null)
    setEditingId(null)
    setStyleOpen(false)
    setUndoStack([])
    setRedoStack([])
    setCanvasMode('graph')
    setSearchOpen(false)
    setSearchQ('')
    setSearchIdx(0)
    focusIdRef.current = null
    setMultiSelMode(false)
    setMultiSel(new Set())
    setDragState(null)
    setDropChoice(null)
  }

  const exitMap = () => {
    flushSave()
    closeDoc()
  }

  const deleteDoc = (id: string) => {
    const next = docsRef.current.filter((d) => d.id !== id)
    setDocsAndSave(next)
    if (docIdRef.current === id) closeDoc()
    toast.success('已删除导图')
  }

  /** Rename a saved map (list sheet → pencil icon → Dialog). */
  const renameDoc = (id: string, title: string) => {
    const t = title.trim()
    if (!t) {
      toast.error('名称不能为空')
      return
    }
    const next = docsRef.current.map((d) =>
      d.id === id ? { ...d, title: t, updatedAt: new Date().toISOString() } : d,
    )
    setDocsAndSave(next)
    setRenameId(null)
    toast.success('已重命名')
  }

  const openRenameDialog = (doc: StyledMindmapDoc) => {
    setRenameTitle(doc.title)
    setRenameId(doc.id)
  }

  const toggleBatchDoc = (id: string) => {
    setBatchSel((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  const deleteDocsBatch = () => {
    const ids = batchSel
    if (ids.size === 0) return
    const next = docsRef.current.filter((d) => !ids.has(d.id))
    setDocsAndSave(next)
    if (docIdRef.current && ids.has(docIdRef.current)) closeDoc()
    setBatchSel(new Set())
    setBatchMode(false)
    setConfirmBatch(false)
    toast.success(`已删除 ${ids.size} 张导图`)
  }

  // ---------- scope options / 新建 / 扩展 ----------

  const paragraphs = React.useMemo(() => splitParagraphs(content), [content])
  const hasContent = content.trim().length > 0

  /** Per-unit generation source: pages (第N页) when provided, else chunks
   *  (第N块), else paragraph splits (第N段) as before. */
  const unitWord: '页' | '块' | '段' =
    pages && pages.length > 0 ? '页' : chunks && chunks.length > 0 ? '块' : '段'

  const unitOptions = React.useMemo(() => {
    const src =
      pages && pages.length > 0
        ? pages
        : chunks && chunks.length > 0
          ? chunks
          : paragraphs
    return src
      .map((t, i) => ({ label: `第${i + 1}${unitWord}`, text: (t ?? '').trim(), preview: (t ?? '').trim().slice(0, 40) }))
      .filter((o) => o.text.length > 0)
  }, [pages, chunks, paragraphs, unitWord])

  const scopeOptions = React.useMemo(() => {
    const opts: { label: string; text: string; preview: string }[] = [
      { label: '全文', text: content.trim(), preview: content.trim().slice(0, 40) },
    ]
    unitOptions.forEach((o) => opts.push(o))
    return opts
  }, [content, unitOptions])

  const genMindmap = async (text: string): Promise<RichNode> => {
    const res = await fetch('/api/mindmap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    })
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(err.error || '生成失败')
    }
    const data = (await res.json()) as { mindmap: MindNode }
    if (!data.mindmap) throw new Error('AI 未返回思维导图')
    return normalizeIds(data.mindmap)
  }

  const createNewMap = async () => {
    if (newSplit !== 'single') {
      // ---- 按页/块分别生成：each = 每个单元一张图；merge = 合并为一张全览图 ----
      if (unitOptions.length === 0) {
        toast.error('没有可用的分页/分块内容')
        return
      }
      const list = unitOptions.slice(0, MAX_AUTO_UNITS)
      if (unitOptions.length > MAX_AUTO_UNITS) {
        toast.warning(`单元过多，仅生成前 ${MAX_AUTO_UNITS} 个`)
      }
      setGenerating(true)
      const tid = toast.loading(`正在生成 0/${list.length} …`)
      try {
        const now = new Date().toISOString()
        if (newSplit === 'each') {
          const created: StyledMindmapDoc[] = []
          for (let i = 0; i < list.length; i += 1) {
            toast.loading(`正在生成 ${i + 1}/${list.length}：${list[i].label} …`, { id: tid })
            const root = await genMindmap(list[i].text)
            created.push({
              id: uid(),
              title: cardTitle
                ? `${cardTitle}${mmdd()}·${list[i].label}`
                : `${root.title || '导图'}${mmdd()}·${list[i].label}`,
              scope: list[i].label,
              levels: newLevels,
              root,
              createdAt: now,
              updatedAt: now,
              styles: {},
              scopes: [list[i].label],
            })
          }
          setDocsAndSave([...created, ...docsRef.current])
          toast.success(`已生成 ${created.length} 张导图`, { id: tid })
          setNewOpen(false)
        } else {
          const children: RichNode[] = []
          for (let i = 0; i < list.length; i += 1) {
            toast.loading(`正在生成 ${i + 1}/${list.length}：${list[i].label} …`, { id: tid })
            children.push(await genMindmap(list[i].text))
          }
          const root: RichNode = {
            id: uid(),
            title: cardTitle || '全文',
            children,
          }
          const doc: StyledMindmapDoc = {
            id: uid(),
            title: cardTitle ? `${cardTitle}${mmdd()}·全览` : `全览${mmdd()}`,
            scope: '全文',
            levels: newLevels + 1,
            root,
            createdAt: now,
            updatedAt: now,
            styles: {},
            scopes: ['全文', ...list.map((u) => u.label)],
          }
          setDocsAndSave([doc, ...docsRef.current])
          toast.success('全览导图已生成', { id: tid })
          setNewOpen(false)
          openDoc(doc.id, true)
        }
      } catch (err) {
        toast.error('生成思维导图失败：' + (err instanceof Error ? err.message : '未知错误'), { id: tid })
      } finally {
        setGenerating(false)
      }
      return
    }
    // ---- 单张导图（原有流程）----
    const opt = scopeOptions.find((o) => o.label === newScope)
    if (!opt || !opt.text) {
      toast.error('所选范围内容为空')
      return
    }
    setGenerating(true)
    const tid = toast.loading('AI 正在梳理知识结构…')
    try {
      const root = await genMindmap(opt.text)
      const now = new Date().toISOString()
      const doc: StyledMindmapDoc = {
        id: uid(),
        title: cardTitle ? `${cardTitle}${mmdd()}` : `${root.title || '导图'}${mmdd()}`,
        scope: opt.label,
        levels: newLevels,
        root,
        createdAt: now,
        updatedAt: now,
        styles: {},
        scopes: [opt.label],
      }
      const next = [doc, ...docsRef.current]
      setDocsAndSave(next)
      toast.success('导图已生成', { id: tid })
      setNewOpen(false)
      openDoc(doc.id, true)
    } catch (err) {
      toast.error('生成思维导图失败：' + (err instanceof Error ? err.message : '未知错误'), { id: tid })
    } finally {
      setGenerating(false)
    }
  }

  const extendOptions = currentDoc
    ? scopeOptions.filter((o) => !(currentDoc.scopes ?? [currentDoc.scope ?? '全文']).includes(o.label))
    : []

  const extendMaps = async () => {
    const doc = getDoc()
    if (!doc) return
    const labels = [...extendSel].filter((l) => extendOptions.some((o) => o.label === l))
    if (labels.length === 0) {
      toast.info('请先选择要扩展的范围')
      return
    }
    setExtending(true)
    const tid = toast.loading(`正在扩展 0/${labels.length} …`)
    try {
      const root = cloneTree(doc.root)
      const merged: string[] = []
      for (let i = 0; i < labels.length; i += 1) {
        const opt = scopeOptions.find((o) => o.label === labels[i])
        if (!opt || !opt.text) continue
        toast.loading(`正在扩展 ${i + 1}/${labels.length}：${labels[i]} …`, { id: tid })
        const branch = await genMindmap(opt.text)
        root.children = [...(root.children ?? []), branch]
        merged.push(labels[i])
      }
      if (merged.length === 0) {
        toast.warning('未能扩展任何范围', { id: tid })
        return
      }
      pushUndo()
      applyRoot(root)
      updateDocInPlace((d) => ({
        ...d,
        scopes: [...new Set([...(d.scopes ?? [d.scope ?? '全文']), ...merged])],
      }))
      toast.success(`已扩展 ${merged.length} 个范围`, { id: tid })
      setExtendOpen(false)
      setExtendSel(new Set())
    } catch (err) {
      toast.error('扩展失败：' + (err instanceof Error ? err.message : '未知错误'), { id: tid })
    } finally {
      setExtending(false)
    }
  }

  // ---------- 布局 / 画布视图（缩放平移） ----------

  const layoutKind: LayoutKind = currentDoc?.meta?.layout ?? 'htree'

  const changeLayoutKind = (k: LayoutKind) => {
    if (k === layoutKind) return
    updateDocInPlace((d) => ({ ...d, meta: { ...(d.meta ?? {}), layout: k } }))
  }

  const layout = React.useMemo(
    () => (currentDoc ? computeLayout(currentDoc.root, currentDoc.styles, layoutKind) : null),
    [currentDoc, layoutKind],
  )
  layoutRef.current = layout
  transformRef.current = transform
  dragRef.current = dragState

  /** 适应屏幕：自动算缩放并居中 */
  const fitView = React.useCallback(() => {
    const el = canvasRef.current
    const lay = layoutRef.current
    if (!el || !lay) return
    const rect = el.getBoundingClientRect()
    if (rect.width < 40 || rect.height < 40) return
    const scale = clampScale(Math.min((rect.width - 40) / lay.width, (rect.height - 40) / lay.height))
    setTransform({
      scale,
      tx: (rect.width - lay.width * scale) / 2,
      ty: (rect.height - lay.height * scale) / 2,
    })
  }, [])

  const zoomBy = React.useCallback((factor: number) => {
    const el = canvasRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const t = transformRef.current
    const scale = clampScale(t.scale * factor)
    const cx = rect.width / 2
    const cy = rect.height / 2
    const wx = (cx - t.tx) / t.scale
    const wy = (cy - t.ty) / t.scale
    setTransform({ scale, tx: cx - wx * scale, ty: cy - wy * scale })
  }, [])

  /** 回到 100% 缩放（保持画布中心不动） */
  const resetZoom = () => {
    const el = canvasRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const t = transformRef.current
    const cx = rect.width / 2
    const cy = rect.height / 2
    const wx = (cx - t.tx) / t.scale
    const wy = (cy - t.ty) / t.scale
    setTransform({ scale: 1, tx: cx - wx, ty: cy - wy })
  }

  const centerOnNode = React.useCallback((id: string) => {
    const el = canvasRef.current
    const lay = layoutRef.current
    if (!el || !lay) return
    const n = lay.nodes.find((x) => x.id === id)
    if (!n) return
    const rect = el.getBoundingClientRect()
    const t = transformRef.current
    setTransform({
      ...t,
      tx: rect.width / 2 - (n.x + n.w / 2) * t.scale,
      ty: rect.height / 2 - (n.y + n.h / 2) * t.scale,
    })
  }, [])

  /** 屏幕坐标 → 画布内容坐标命中测试（拖拽落点） */
  const hitTestNode = (clientX: number, clientY: number, exclude: Set<string>): string | null => {
    const el = canvasRef.current
    const lay = layoutRef.current
    const t = transformRef.current
    if (!el || !lay) return null
    const rect = el.getBoundingClientRect()
    const x = (clientX - rect.left - t.tx) / t.scale
    const y = (clientY - rect.top - t.ty) / t.scale
    for (let i = lay.nodes.length - 1; i >= 0; i -= 1) {
      const n = lay.nodes[i]
      if (exclude.has(n.id)) continue
      if (x >= n.x - 6 && x <= n.x + n.w + 6 && y >= n.y - n.h / 2 - 6 && y <= n.y + n.h / 2 + 6) {
        return n.id
      }
    }
    return null
  }

  // 打开导图 / 切换布局后自动适应屏幕
  React.useEffect(() => {
    if (view !== 'map' || canvasMode !== 'graph' || !currentDoc) return
    fitView()
  }, [docId, layoutKind])

  // 滚轮缩放（以指针为锚点；非 passive 以阻止页面滚动）
  React.useEffect(() => {
    const el = canvasRef.current
    if (!el || canvasMode !== 'graph') return
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      const rect = el.getBoundingClientRect()
      const t = transformRef.current
      const cx = ev.clientX - rect.left
      const cy = ev.clientY - rect.top
      const scale = clampScale(t.scale * Math.exp(-ev.deltaY * 0.0016))
      const wx = (cx - t.tx) / t.scale
      const wy = (cy - t.ty) / t.scale
      setTransform({ scale, tx: cx - wx * scale, ty: cy - wy * scale })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [canvasMode, view, docId])

  // ---------- 节点拖拽手势（pointer events，触摸 + 鼠标统一处理） ----------

  const nodeGestureRef = React.useRef<{
    pointerId: number
    nodeId: string
    el: HTMLElement
    startX: number
    startY: number
    lastX: number
    lastY: number
    active: boolean
    timer: number | null
    targetId: string | null
    exclude: Set<string>
  } | null>(null)

  const cancelNodeGesture = () => {
    const g = nodeGestureRef.current
    nodeGestureRef.current = null
    if (g) {
      if (g.timer !== null) window.clearTimeout(g.timer)
      if (g.active) setDragState(null)
    }
  }

  const activateNodeDrag = (g: NonNullable<typeof nodeGestureRef.current>) => {
    if (g.active) return
    if (g.timer !== null) {
      window.clearTimeout(g.timer)
      g.timer = null
    }
    const doc = getDoc()
    const node = doc ? findNode(doc.root, g.nodeId) : null
    if (!node) {
      nodeGestureRef.current = null
      return
    }
    g.active = true
    g.exclude = new Set(collectIds(node))
    try {
      navigator.vibrate?.(30)
    } catch {
      // haptics unsupported — ignore
    }
    try {
      g.el.setPointerCapture?.(g.pointerId)
    } catch {
      // pointer already released — ignore
    }
    setDragState({ id: g.nodeId, title: node.title, icon: node.icon, x: g.lastX, y: g.lastY, targetId: null })
  }

  const handleNodePointerDown = (nodeId: string) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const g = nodeGestureRef.current
    if (g && g.active) return // 已有拖拽进行中
    const el = e.currentTarget
    nodeGestureRef.current = {
      pointerId: e.pointerId,
      nodeId,
      el,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      active: false,
      timer: null,
      targetId: null,
      exclude: new Set([nodeId]),
    }
    if (e.pointerType !== 'mouse') {
      // 长按 300ms 进入拖拽模式
      nodeGestureRef.current.timer = window.setTimeout(() => {
        const cur = nodeGestureRef.current
        if (cur && cur.pointerId === e.pointerId && !cur.active) activateNodeDrag(cur)
      }, 300)
    }
  }

  const handleNodePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = nodeGestureRef.current
    if (!g || g.pointerId !== e.pointerId) return
    g.lastX = e.clientX
    g.lastY = e.clientY
    if (!g.active) {
      const dist = Math.hypot(e.clientX - g.startX, e.clientY - g.startY)
      if (dist > (e.pointerType === 'mouse' ? 6 : 10)) activateNodeDrag(g)
      return
    }
    const targetId = hitTestNode(e.clientX, e.clientY, g.exclude)
    g.targetId = targetId
    setDragState((prev) =>
      prev && (prev.x !== e.clientX || prev.y !== e.clientY || prev.targetId !== targetId)
        ? { ...prev, x: e.clientX, y: e.clientY, targetId }
        : prev,
    )
  }

  const handleNodePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = nodeGestureRef.current
    if (!g || g.pointerId !== e.pointerId) return
    nodeGestureRef.current = null
    if (g.timer !== null) window.clearTimeout(g.timer)
    if (g.active) {
      suppressClickUntilRef.current = Date.now() + 450
      const targetId = g.targetId
      setDragState(null)
      if (targetId && targetId !== g.nodeId) {
        const doc = getDoc()
        const target = doc ? findNode(doc.root, targetId) : null
        if (target) {
          setDropChoice({ sourceId: g.nodeId, targetId, targetTitle: target.title })
          return
        }
      }
      toast.info('已取消移动')
    }
  }

  const handleNodePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = nodeGestureRef.current
    if (!g || g.pointerId !== e.pointerId) return
    nodeGestureRef.current = null
    if (g.timer !== null) window.clearTimeout(g.timer)
    if (g.active) {
      suppressClickUntilRef.current = Date.now() + 450
      setDragState(null)
    }
  }

  /** 拖拽/平移结束后的一小段时间内吞掉 click，避免误触选择 */
  const maybeSwallowClick = (e: React.SyntheticEvent) => {
    if (Date.now() < suppressClickUntilRef.current) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  // ---------- 画布平移 / 双指缩放（pointer events） ----------

  const pointersRef = React.useRef(new Map<number, { x: number; y: number }>())
  const panPinchRef = React.useRef<{
    mode: 'pan' | 'pinch' | null
    startT: { scale: number; tx: number; ty: number }
    startDist: number
    startPx: number
    startPy: number
    moved: boolean
  }>({ mode: null, startT: { scale: 1, tx: 0, ty: 0 }, startDist: 0, startPx: 0, startPy: 0, moved: false })

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointersRef.current.size === 2) {
      // 双指 → 捏合缩放（同时取消可能进行中的节点拖拽）
      cancelNodeGesture()
      const pts = [...pointersRef.current.values()]
      const [p1, p2] = pts
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // ignore
      }
      panPinchRef.current = {
        mode: 'pinch',
        startT: { ...transformRef.current },
        startDist: Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y)),
        startPx: (p1.x + p2.x) / 2,
        startPy: (p1.y + p2.y) / 2,
        moved: true,
      }
      return
    }
    if (pointersRef.current.size !== 1) return
    // 编辑模式下的可拖拽节点：让节点手势接管，画布不平移
    const nodeEl = (e.target as HTMLElement).closest?.('[data-node]') as HTMLElement | null
    const nodeOwnsGesture =
      !!nodeEl && editMode && !multiSelMode && nodeEl.getAttribute('data-nodrag') !== '1'
    if (nodeOwnsGesture) {
      panPinchRef.current.mode = null
      return
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // ignore
    }
    panPinchRef.current = {
      mode: 'pan',
      startT: { ...transformRef.current },
      startDist: 0,
      startPx: e.clientX,
      startPy: e.clientY,
      moved: false,
    }
  }

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(e.pointerId)) return
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const st = panPinchRef.current
    if (st.mode === 'pinch' && pointersRef.current.size >= 2) {
      const pts = [...pointersRef.current.values()]
      const [p1, p2] = pts
      const dist = Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y))
      const scale = clampScale(st.startT.scale * (dist / st.startDist))
      const el = canvasRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      // 起始中点对应的内容坐标，缩放+平移后仍跟随当前中点
      const wx = (st.startPx - rect.left - st.startT.tx) / st.startT.scale
      const wy = (st.startPy - rect.top - st.startT.ty) / st.startT.scale
      const mx = (p1.x + p2.x) / 2 - rect.left
      const my = (p1.y + p2.y) / 2 - rect.top
      setTransform({ scale, tx: mx - wx * scale, ty: my - wy * scale })
    } else if (st.mode === 'pan') {
      const dx = e.clientX - st.startPx
      const dy = e.clientY - st.startPy
      if (!st.moved && Math.hypot(dx, dy) > 4) st.moved = true
      setTransform((t) => ({ ...t, tx: st.startT.tx + dx, ty: st.startT.ty + dy }))
    }
  }

  const handleCanvasPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(e.pointerId)
    const st = panPinchRef.current
    if ((st.mode === 'pan' && st.moved) || st.mode === 'pinch') {
      suppressClickUntilRef.current = Date.now() + 350
    }
    if (pointersRef.current.size === 0) {
      panPinchRef.current = { ...st, mode: null }
    } else if (pointersRef.current.size === 1 && st.mode === 'pinch') {
      // 捏合结束退化为单指平移，以剩余指针为锚点
      const [p] = [...pointersRef.current.values()]
      panPinchRef.current = {
        mode: 'pan',
        startT: { ...transformRef.current },
        startDist: 0,
        startPx: p.x,
        startPy: p.y,
        moved: true,
      }
    }
  }

  // ---------- 查找节点 ----------

  const matchedIds = React.useMemo(() => {
    const q = searchQ.trim().toLowerCase()
    const s = new Set<string>()
    if (!q || !currentDoc) return s
    walkNodes(currentDoc.root, (n) => {
      if (
        (n.title ?? '').toLowerCase().includes(q) ||
        (n.note ?? '').toLowerCase().includes(q)
      ) {
        s.add(n.id)
      }
    })
    return s
  }, [searchQ, currentDoc])

  const matchList = React.useMemo(() => [...matchedIds], [matchedIds])

  const gotoMatch = (rawIdx: number) => {
    if (matchList.length === 0) return
    const idx = ((rawIdx % matchList.length) + matchList.length) % matchList.length
    setSearchIdx(idx)
    const id = matchList[idx]
    const visibleNow = layout?.nodes.some((n) => n.id === id) ?? false
    if (!visibleNow) {
      // 展开路径（静默，不入撤销栈），布局更新后由 focus effect 居中
      mutateRoot(
        (clone) => {
          for (const anc of ancestorsOf(clone, id) ?? []) anc.collapsed = false
        },
        { silent: true },
      )
      focusIdRef.current = id
    } else {
      centerOnNode(id)
    }
  }
  const gotoMatchRef = React.useRef(gotoMatch)
  gotoMatchRef.current = gotoMatch

  // 输入即时跳到第一个匹配
  React.useEffect(() => {
    if (searchQ.trim()) gotoMatchRef.current(0)
    else focusIdRef.current = null
  }, [searchQ])

  // 路径展开导致布局变化后，居中到目标节点
  React.useEffect(() => {
    const id = focusIdRef.current
    if (!id || !layout) return
    if (layout.nodes.some((n) => n.id === id)) {
      focusIdRef.current = null
      centerOnNode(id)
    }
  }, [layout, centerOnNode])

  // 大纲视图：搜索命中行滚动到可视区
  React.useEffect(() => {
    if (canvasMode !== 'outline' || !searchOpen || matchList.length === 0) return
    const id = matchList[Math.min(searchIdx, matchList.length - 1)]
    rowRefs.current.get(id)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [searchIdx, searchOpen, canvasMode, matchList])

  const closeSearch = () => {
    setSearchOpen(false)
    setSearchQ('')
    setSearchIdx(0)
    focusIdRef.current = null
  }

  // ---------- 大纲视图行（与图形视图共用同一棵树数据） ----------

  const outlineRows = React.useMemo(() => {
    const rows: { node: RichNode; depth: number; childCount: number }[] = []
    if (!currentDoc) return rows
    const walk = (n: RichNode, depth: number) => {
      const kids = n.children ?? []
      rows.push({ node: n, depth, childCount: kids.length })
      if (n.collapsed) return
      for (const k of kids) walk(k, depth + 1)
    }
    walk(currentDoc.root, 0)
    return rows
  }, [currentDoc])

  // ---------- export ----------

  const runExport = async (kind: ExportKind) => {
    const doc = getDoc()
    if (!doc) return
    setExporting(kind)
    try {
      // 导出始终使用完整树（忽略折叠）+ 当前布局
      const kindNow: LayoutKind = doc.meta?.layout ?? 'htree'
      const fullLayout = computeLayout(doc.root, doc.styles, kindNow, { ignoreCollapse: true })
      const safeName = sanitizeFilename(doc.title)
      if (kind === 'png') {
        const blob = await svgToPngBlob(buildMapSvg(doc, fullLayout), fullLayout.width, fullLayout.height)
        downloadBlob(blob, `${safeName}.png`)
        toast.success('已导出 PNG 图片')
      } else if (kind === 'pdf') {
        const blob = await svgToPngBlob(buildMapSvg(doc, fullLayout), fullLayout.width, fullLayout.height)
        const dataUrl = await blobToDataUrl(blob)
        const { jsPDF } = await import('jspdf')
        const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
        const pw = pdf.internal.pageSize.getWidth()
        const ph = pdf.internal.pageSize.getHeight()
        const margin = 28
        const ratio = Math.min(
          (pw - margin * 2) / fullLayout.width,
          (ph - margin * 2) / fullLayout.height,
        )
        const w = fullLayout.width * ratio
        const h = fullLayout.height * ratio
        pdf.addImage(dataUrl, 'PNG', (pw - w) / 2, (ph - h) / 2, w, h)
        pdf.save(`${safeName}.pdf`)
        toast.success('已导出 PDF 文档')
      } else if (kind === 'svg') {
        const svg = buildMapSvg(doc, fullLayout)
        downloadBlob(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), `${safeName}.svg`)
        toast.success('已导出 SVG 矢量图')
      } else if (kind === 'md') {
        const md = buildMarkdown(doc)
        downloadBlob(new Blob([`\ufeff${md}`], { type: 'text/markdown;charset=utf-8' }), `${safeName}.md`)
        toast.success('已导出 Markdown 大纲')
      } else if (kind === 'opml') {
        const xml = buildOpml(doc)
        downloadBlob(new Blob([xml], { type: 'text/x-opml;charset=utf-8' }), `${safeName}.opml`)
        toast.success('已导出 OPML 大纲')
      } else if (kind === 'mm') {
        const xml = buildFreemind(doc)
        downloadBlob(new Blob([xml], { type: 'application/x-freemind;charset=utf-8' }), `${safeName}.mm`)
        toast.success('已导出 FreeMind 文件')
      } else {
        // XMind（XMind 2020+ content.json 格式，带样式/标记/备注）
        const toTopic = (n: RichNode, depth: number): Record<string, unknown> => {
          const st = doc.styles?.[n.id]
          const t: Record<string, unknown> = {
            id: n.id,
            class: 'topic',
            title: (n.icon ? `${n.icon} ` : '') + n.title,
          }
          const props: Record<string, unknown> = {
            'fo:font-size': depth === 0 ? 16 : st?.size === 'sm' ? 12 : st?.size === 'lg' ? 16 : 13,
          }
          if (st?.bold || depth === 0) props['fo:font-weight'] = 'bold'
          if (n.bg) props['svg:fill'] = n.bg
          const ink = st?.color ?? (n.bg ? '#18181b' : undefined)
          if (ink) props['fo:color'] = ink
          t.style = { id: uid(), properties: props }
          if (n.priority) t.markers = [{ markerId: `priority-${n.priority}` }]
          if (n.note) t.notes = { plain: { content: n.note } }
          if (n.link) t.href = n.link
          if (n.children && n.children.length > 0) {
            t.children = { attached: n.children.map((c) => toTopic(c, depth + 1)) }
          }
          return t
        }
        const structureClass =
          kindNow === 'radial' ? 'logic-both' : kindNow === 'vtree' ? 'org-chart-down' : 'logic-right'
        const rootTopic = { ...toTopic(doc.root, 0), structureClass }
        // jszip ships `export = JSZip` typings without a constructor overload,
        // so recover the constructible shape from the module's default export.
        const jszipModule = await import('jszip')
        const JSZipCtor = jszipModule.default as unknown as new () => typeof jszipModule.default
        const zip = new JSZipCtor()
        zip.file(
          'content.json',
          JSON.stringify([{ id: doc.id, class: 'sheet', title: doc.title, rootTopic }]),
        )
        zip.file('metadata.json', JSON.stringify({ creator: { name: '背书吧' } }))
        zip.file('manifest.json', JSON.stringify({ 'file-checksum': '' }))
        const blob = await zip.generateAsync({ type: 'blob' })
        downloadBlob(blob, `${safeName}.xmind`)
        toast.success('已导出 XMind 文件（含样式）')
      }
      setExportOpen(false)
    } catch (err) {
      toast.error('导出失败：' + (err instanceof Error ? err.message : '未知错误'))
    } finally {
      setExporting(null)
    }
  }

  // ---------- derived ----------

  const sortedDocs = React.useMemo(
    () =>
      [...docs].sort(
        (a, b) =>
          new Date(b.updatedAt ?? b.createdAt ?? 0).getTime() -
          new Date(a.updatedAt ?? a.createdAt ?? 0).getTime(),
      ),
    [docs],
  )
  const latestDoc = sortedDocs[0] ?? null
  const styleOf = (id: string | null): NodeStyle | undefined =>
    id && currentDoc?.styles ? currentDoc.styles[id] : undefined
  const curStyle = styleOf(selectedId)
  const selNode = selectedId && currentDoc ? findNode(currentDoc.root, selectedId) : null
  const selBoldAll = React.useMemo(() => {
    if (multiSel.size === 0 || !currentDoc) return false
    for (const id of multiSel) {
      if (!currentDoc.styles?.[id]?.bold) return false
    }
    return true
  }, [multiSel, currentDoc])

  const handleEditTool = (key: string) => {
    if (!selectedId) {
      toast.info('请先点选一个节点')
      return
    }
    switch (key) {
      case 'sibling':
        addSibling(selectedId)
        break
      case 'child':
        addChild(selectedId)
        break
      case 'style':
        setStyleOpen((v) => !v)
        break
      case 'delete':
        removeNode(selectedId)
        break
      case 'copy':
        copyNode(selectedId)
        break
    }
  }

  /** 节点标题输入框的快捷键：Enter 提交并加同级，Tab 提交并加子级 */
  const renderTitleInput = (isRoot: boolean) => (
    <input
      autoFocus
      value={draftTitle}
      onChange={(e) => setDraftTitle(e.target.value)}
      onBlur={commitEdit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          const id = editingId
          commitEdit()
          if (id) addSibling(id)
        } else if (e.key === 'Tab') {
          e.preventDefault()
          const id = editingId
          commitEdit()
          if (id) addChild(id)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancelEdit()
        }
      }}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'w-full bg-transparent text-center outline-none',
        isRoot ? 'text-sm text-white' : 'text-[13px]',
      )}
      placeholder="节点文字"
      aria-label="编辑节点文字"
    />
  )

  // ---------- render: home ----------

  if (view !== 'map' || !currentDoc || !layout) {
    return (
      <div className="flex flex-col gap-4">
        <div className="relative flex h-44 items-center justify-center overflow-hidden rounded-2xl">
          {/* CSS-only dashed circles illustration */}
          <div aria-hidden className="pointer-events-none absolute size-56 rounded-full border-2 border-dashed border-zinc-300 dark:border-zinc-700" />
          <div aria-hidden className="pointer-events-none absolute size-32 rounded-full border-2 border-dashed border-zinc-300/70 dark:border-zinc-700/70" />
          <div aria-hidden className="pointer-events-none absolute -top-3 right-6 size-16 rounded-full border border-dashed border-emerald-500/40" />
          <div aria-hidden className="pointer-events-none absolute -bottom-4 left-6 size-12 rounded-full border border-dashed border-zinc-400/50 dark:border-zinc-600/60" />
          {/* mini-map graphic: black pill 章 + two white 要点 nodes */}
          <svg viewBox="0 0 200 120" className="relative h-28 w-auto" aria-hidden="true">
            <path d="M 84 60 C 106 60 104 28 126 28" fill="none" stroke="#d4d4d8" strokeWidth="2" strokeLinecap="round" />
            <path d="M 84 60 C 106 60 104 92 126 92" fill="none" stroke="#d4d4d8" strokeWidth="2" strokeLinecap="round" />
            <rect x="26" y="43" width="58" height="34" rx="17" fill="#18181b" />
            <text x="55" y="60" textAnchor="middle" dominantBaseline="central" fill="#ffffff" fontSize="13" fontWeight="600">章</text>
            <rect x="126" y="11" width="58" height="34" rx="12" fill="#ffffff" stroke="#d4d4d8" />
            <text x="155" y="28" textAnchor="middle" dominantBaseline="central" fill="#52525b" fontSize="12">要点</text>
            <rect x="126" y="75" width="58" height="34" rx="12" fill="#ffffff" stroke="#d4d4d8" />
            <text x="155" y="92" textAnchor="middle" dominantBaseline="central" fill="#52525b" fontSize="12">要点</text>
          </svg>
        </div>

        <div className="flex justify-center">
          <button
            type="button"
            disabled={!latestDoc}
            onClick={() => latestDoc && openDoc(latestDoc.id)}
            className="h-11 w-full max-w-64 rounded-full bg-zinc-900 text-sm font-semibold text-white shadow-lg transition-all hover:bg-zinc-800 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-35"
          >
            查看导图
          </button>
        </div>

        {/* 当前导图 card */}
        <button
          type="button"
          onClick={() => latestDoc && openDoc(latestDoc.id)}
          disabled={!latestDoc}
          className="w-full rounded-2xl border border-border bg-card p-4 text-left shadow-sm transition-colors hover:bg-accent/60 disabled:opacity-60"
        >
          <div className="mb-1.5 text-xs text-muted-foreground">当前导图</div>
          {latestDoc ? (
            <div className="flex items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600">
                <Network className="size-4" strokeWidth={1.75} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{latestDoc.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  范围 {latestDoc.scope ?? '全文'} · {latestDoc.levels ?? 2}级
                  {latestDoc.updatedAt ? ` · ${fmtTime(latestDoc.updatedAt)}` : ''}
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              {hasContent
                ? '还没有导图，点击下方「新建导图」让 AI 帮你梳理结构'
                : '课文内容为空，无法生成导图'}
            </div>
          )}
        </button>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            disabled={!hasContent}
            onClick={() => {
              setNewScope('全文')
              setNewLevels(2)
              setNewOpen(true)
            }}
            className="flex h-12 items-center justify-center gap-1.5 rounded-2xl border border-border bg-card text-sm font-medium shadow-sm transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
          >
            <Plus className="size-4 text-emerald-600" strokeWidth={2} />
            新建导图
          </button>
          <button
            type="button"
            disabled={docs.length === 0}
            onClick={() => setListOpen(true)}
            className="flex h-12 items-center justify-center gap-1.5 rounded-2xl border border-border bg-card text-sm font-medium shadow-sm transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
          >
            <List className="size-4 text-emerald-600" strokeWidth={2} />
            导图列表
          </button>
        </div>

        {/* 新建导图 sheet */}
        <BottomSheet open={newOpen} onOpenChange={setNewOpen} title="选择范围">
          <div className="space-y-4 pt-2">
            <div>
              <div className="mb-2 text-sm font-medium">生成方式</div>
              <div className="grid grid-cols-3 gap-2">
                {([
                  { key: 'single' as const, label: '单张导图' },
                  { key: 'each' as const, label: `按${unitWord}逐张` },
                  { key: 'merge' as const, label: `按${unitWord}合并` },
                ]).map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => setNewSplit(m.key)}
                    className={cn(
                      'h-10 rounded-2xl border px-1 text-xs font-medium leading-tight transition-colors',
                      newSplit === m.key
                        ? 'border-emerald-600 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                        : 'border-border bg-card text-muted-foreground hover:bg-accent',
                    )}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              {newSplit !== 'single' && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {newSplit === 'each'
                    ? `每个${unitWord}各生成一张独立导图（共 ${unitOptions.length} 个${unitWord}）`
                    : `每个${unitWord}生成一棵子树，合并为一张全览导图（共 ${unitOptions.length} 个${unitWord}）`}
                </p>
              )}
            </div>
            {newSplit === 'single' && (
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {scopeOptions.map((o) => {
                  const sel = newScope === o.label
                  return (
                    <button
                      key={o.label}
                      type="button"
                      onClick={() => setNewScope(o.label)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-2xl border p-3 text-left transition-colors',
                        sel ? 'border-emerald-600 bg-emerald-50 dark:bg-emerald-500/10' : 'border-border bg-card hover:bg-accent/60',
                      )}
                    >
                      <span
                        className={cn(
                          'flex size-5 shrink-0 items-center justify-center rounded-full border',
                          sel ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-muted-foreground/40',
                        )}
                      >
                        {sel && <Check className="size-3" strokeWidth={3} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{o.label}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {o.preview || '（空）'}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
            <div>
              <div className="mb-2 text-sm font-medium">层级</div>
              <div className="grid grid-cols-2 gap-2">
                {([2, 3] as const).map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setNewLevels(l)}
                    className={cn(
                      'h-10 rounded-2xl border text-sm font-medium transition-colors',
                      newLevels === l
                        ? 'border-emerald-600 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                        : 'border-border bg-card text-muted-foreground hover:bg-accent',
                    )}
                  >
                    {l}级
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={createNewMap}
              disabled={!hasContent || generating || (newSplit === 'single' && !newScope)}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-full bg-emerald-600 text-sm font-semibold text-white shadow-lg transition-all hover:bg-emerald-700 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
            >
              {generating && <Loader2 className="size-4 animate-spin" />}
              {generating ? '生成中…' : '下一步'}
            </button>
          </div>
        </BottomSheet>

        {/* 导图列表 sheet */}
        <BottomSheet
          open={listOpen}
          onOpenChange={(o) => {
            setListOpen(o)
            if (!o) {
              // leaving the list resets batch state
              setBatchMode(false)
              setBatchSel(new Set())
            }
          }}
          title="导图列表"
        >
          {/* list toolbar: batch management / select-all / batch delete */}
          {sortedDocs.length > 0 && (
            <div className="flex items-center justify-between border-b border-border pb-2 pt-2">
              {batchMode ? (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      setBatchSel((prev) =>
                        prev.size === sortedDocs.length
                          ? new Set()
                          : new Set(sortedDocs.map((d) => d.id)),
                      )
                    }
                    className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {batchSel.size === sortedDocs.length ? '取消全选' : '全选'}
                  </button>
                  <span className="text-xs text-muted-foreground">已选 {batchSel.size} 张</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (batchSel.size > 0) setConfirmBatch(true)
                    }}
                    disabled={batchSel.size === 0}
                    className="flex items-center gap-1 text-xs font-medium text-red-600 transition-colors hover:text-red-700 disabled:pointer-events-none disabled:opacity-40"
                  >
                    <Trash2 className="size-3.5" strokeWidth={1.75} />
                    批量删除
                  </button>
                </>
              ) : (
                <>
                  <span className="text-xs text-muted-foreground">共 {sortedDocs.length} 张</span>
                  <button
                    type="button"
                    onClick={() => {
                      setBatchMode(true)
                      setBatchSel(new Set())
                    }}
                    className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ListChecks className="size-3.5" strokeWidth={1.75} />
                    批量管理
                  </button>
                </>
              )}
            </div>
          )}
          <div className="max-h-96 space-y-2 overflow-y-auto pt-2">
            {sortedDocs.map((d) => {
              const checked = batchSel.has(d.id)
              return (
                <div
                  key={d.id}
                  role={batchMode ? 'button' : undefined}
                  onClick={batchMode ? () => toggleBatchDoc(d.id) : undefined}
                  className={cn(
                    'flex items-center gap-3 rounded-2xl border p-3 transition-colors',
                    batchMode
                      ? checked
                        ? 'cursor-pointer border-emerald-600 bg-emerald-50 dark:bg-emerald-500/10'
                        : 'cursor-pointer border-border bg-card hover:bg-accent/60'
                      : 'border-border bg-card',
                  )}
                >
                  {batchMode ? (
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggleBatchDoc(d.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="shrink-0"
                      aria-label={`选择 ${d.title}`}
                    />
                  ) : (
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600">
                      <Network className="size-4" strokeWidth={1.75} />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{d.title}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      范围 {d.scope ?? '全文'} · {d.levels ?? 2}级
                      {d.updatedAt ? ` · ${fmtTime(d.updatedAt)}` : ''}
                    </div>
                  </div>
                  {!batchMode && (
                    <>
                      <button
                        type="button"
                        onClick={() => openRenameDialog(d)}
                        aria-label={`重命名 ${d.title}`}
                        className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:border-emerald-500/60 hover:text-emerald-600"
                      >
                        <Pencil className="size-3.5" strokeWidth={1.75} />
                      </button>
                      <button
                        type="button"
                        onClick={() => openDoc(d.id)}
                        className="shrink-0 rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700"
                      >
                        打开
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(d.id)}
                        aria-label={`删除 ${d.title}`}
                        className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:border-red-300 hover:text-red-600"
                      >
                        <Trash2 className="size-3.5" strokeWidth={1.75} />
                      </button>
                    </>
                  )}
                </div>
              )
            })}
            {sortedDocs.length === 0 && (
              <div className="py-10 text-center text-sm text-muted-foreground">还没有保存的导图</div>
            )}
          </div>

          {/* rename dialog */}
          <Dialog
            open={renameId !== null}
            onOpenChange={(o) => {
              if (!o) setRenameId(null)
            }}
          >
            <DialogContent className="max-w-sm rounded-2xl" aria-describedby={undefined}>
              <DialogHeader>
                <DialogTitle>重命名导图</DialogTitle>
              </DialogHeader>
              <Input
                autoFocus
                value={renameTitle}
                onChange={(e) => setRenameTitle(e.target.value)}
                placeholder="导图名称"
                aria-label="导图名称"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    if (renameId) renameDoc(renameId, renameTitle)
                  }
                }}
              />
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setRenameId(null)}>
                  取消
                </Button>
                <Button
                  onClick={() => {
                    if (renameId) renameDoc(renameId, renameTitle)
                  }}
                  className="rounded-full bg-emerald-600 text-white hover:bg-emerald-700"
                >
                  保存
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* single delete confirm dialog */}
          <AlertDialog
            open={confirmDeleteId !== null}
            onOpenChange={(o) => {
              if (!o) setConfirmDeleteId(null)
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>删除导图</AlertDialogTitle>
                <AlertDialogDescription>
                  确定删除「
                  {docs.find((d) => d.id === confirmDeleteId)?.title ?? ''}
                  」吗？删除后无法恢复。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    if (confirmDeleteId) deleteDoc(confirmDeleteId)
                    setConfirmDeleteId(null)
                  }}
                  className="bg-red-600 text-white hover:bg-red-700"
                >
                  删除
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {/* batch delete confirm dialog */}
          <AlertDialog
            open={confirmBatch}
            onOpenChange={(o) => {
              if (!o) setConfirmBatch(false)
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>批量删除导图</AlertDialogTitle>
                <AlertDialogDescription>
                  确定删除已选的 {batchSel.size} 张导图吗？删除后无法恢复。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction
                  onClick={deleteDocsBatch}
                  className="bg-red-600 text-white hover:bg-red-700"
                >
                  删除
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </BottomSheet>
      </div>
    )
  }

  // ---------- render: map view ----------

  const doc = currentDoc
  const searchActive = searchOpen && searchQ.trim().length > 0

  return (
    <div className="flex h-[64vh] flex-col">
      {/* header */}
      <div className="flex items-center gap-2 pb-2">
        <button
          type="button"
          onClick={exitMap}
          aria-label="返回"
          className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" strokeWidth={1.75} />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <div className="truncate text-sm font-bold">{doc.title}</div>
          <div className="truncate text-[10px] text-muted-foreground">
            范围 {doc.scope ?? '全文'} · {doc.levels ?? 2}级 · {LAYOUT_OPTIONS.find((o) => o.key === layoutKind)?.label ?? '水平树'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExportOpen(true)}
          aria-label="导出"
          className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:text-foreground"
        >
          <Download className="size-4" strokeWidth={1.75} />
        </button>
        {!editMode ? (
          <button
            type="button"
            onClick={() => setEditMode(true)}
            className="h-8 shrink-0 rounded-full border border-border bg-card px-3 text-xs font-medium transition-colors hover:bg-accent"
          >
            编辑模式
          </button>
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={undo}
              disabled={undoStack.length === 0}
              aria-label="撤销"
              className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            >
              <Undo2 className="size-4" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={redoStack.length === 0}
              aria-label="重做"
              className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            >
              <Redo2 className="size-4" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={flushSave}
              className="h-8 rounded-full bg-emerald-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-emerald-700"
            >
              保存
            </button>
            <button
              type="button"
              onClick={() => {
                setEditMode(false)
                setStyleOpen(false)
                if (multiSelMode) exitMultiSelect()
              }}
              className="h-8 rounded-full border border-border bg-card px-3 text-xs font-medium transition-colors hover:bg-accent"
            >
              完成
            </button>
          </div>
        )}
      </div>

      {/* toolbar：布局切换 / 视图切换 / 全部展开 / 多选 / 搜索（或搜索输入行） */}
      {searchOpen ? (
        <div className="flex items-center gap-2 pb-2">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (matchList.length > 0) gotoMatch(searchIdx + 1)
                }
              }}
              placeholder="搜索节点标题或备注…"
              aria-label="搜索节点"
              className="h-9 rounded-full pl-9 pr-3 text-sm"
            />
          </div>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {matchList.length > 0 ? `${Math.min(searchIdx + 1, matchList.length)}/${matchList.length}` : '无匹配'}
          </span>
          <button
            type="button"
            onClick={closeSearch}
            aria-label="关闭搜索"
            className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 pb-2">
          {/* 布局切换 */}
          <div className="flex shrink-0 rounded-full border border-border bg-card p-0.5" role="group" aria-label="布局切换">
            {LAYOUT_OPTIONS.map((o) => {
              const Icon = o.icon
              const active = layoutKind === o.key
              return (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => changeLayoutKind(o.key)}
                  aria-label={o.label}
                  title={o.label}
                  aria-pressed={active}
                  className={cn(
                    'flex size-7 items-center justify-center rounded-full transition-colors',
                    active ? 'bg-emerald-600 text-white' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="size-3.5" strokeWidth={2} />
                </button>
              )
            })}
          </div>
          {/* 图形 / 大纲 */}
          <div className="flex shrink-0 rounded-full border border-border bg-card p-0.5" role="group" aria-label="视图切换">
            {([
              { key: 'graph' as const, label: '图形视图', icon: Network },
              { key: 'outline' as const, label: '大纲视图', icon: List },
            ]).map((o) => {
              const Icon = o.icon
              const active = canvasMode === o.key
              return (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => setCanvasMode(o.key)}
                  aria-label={o.label}
                  title={o.label}
                  aria-pressed={active}
                  className={cn(
                    'flex size-7 items-center justify-center rounded-full transition-colors',
                    active ? 'bg-emerald-600 text-white' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="size-3.5" strokeWidth={2} />
                </button>
              )
            })}
          </div>
          <div className="min-w-0 flex-1" />
          <button
            type="button"
            onClick={expandAll}
            aria-label="全部展开"
            title="全部展开"
            className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:text-foreground"
          >
            <UnfoldVertical className="size-4" strokeWidth={1.75} />
          </button>
          {editMode && (
            <button
              type="button"
              onClick={() => (multiSelMode ? exitMultiSelect() : enterMultiSelect())}
              aria-label="多选批量"
              title="多选批量"
              aria-pressed={multiSelMode}
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-full border transition-colors',
                multiSelMode
                  ? 'border-emerald-600 bg-emerald-600 text-white'
                  : 'border-border bg-card text-muted-foreground hover:text-foreground',
              )}
            >
              <SquareCheck className="size-4" strokeWidth={1.75} />
            </button>
          )}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="查找节点"
            title="查找节点"
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-full border transition-colors',
              searchActive
                ? 'border-emerald-600 bg-emerald-600 text-white'
                : 'border-border bg-card text-muted-foreground hover:text-foreground',
            )}
          >
            <Search className="size-4" strokeWidth={1.75} />
          </button>
        </div>
      )}

      {/* 画布（图形视图，transform 缩放平移）或大纲视图 */}
      {canvasMode === 'graph' ? (
        <div
          ref={canvasRef}
          className="relative min-h-0 flex-1 touch-none overflow-hidden rounded-2xl border border-border bg-muted/20"
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handleCanvasPointerEnd}
          onPointerCancel={handleCanvasPointerEnd}
          onClick={() => {
            setSelectedId(null)
            setStyleOpen(false)
          }}
          onClickCapture={maybeSwallowClick}
        >
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})`,
            }}
            role="tree"
            aria-label="思维导图"
          >
            <svg
              className="absolute left-0 top-0"
              width={layout.width}
              height={layout.height}
              aria-hidden="true"
            >
              {layout.links.map((l, i) => (
                <path
                  key={`link-${i}`}
                  d={l.d}
                  fill="none"
                  strokeWidth={l.depth === 1 ? 1.75 : 1.25}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  stroke={l.color ?? 'currentColor'}
                  className={l.color ? undefined : 'text-zinc-300 dark:text-zinc-600'}
                />
              ))}
            </svg>
            {layout.nodes.map((n) => {
              const st = styleOf(n.id)
              const src = n.src
              const isSel = selectedId === n.id
              const isEditing = editingId === n.id
              const ink = src.bg ? st?.color ?? '#18131b' : effectiveInk(st?.color, isDark)
              const isMatch = searchActive && matchedIds.has(n.id)
              const isDragTarget = dragState?.targetId === n.id
              const isDragSource = dragState?.id === n.id
              const checked = multiSelMode && multiSel.has(n.id)
              const draggable = editMode && !multiSelMode && !isEditing && !n.isRoot
              const nodeButton = (
                <button
                  type="button"
                  role="treeitem"
                  aria-selected={isSel}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (multiSelMode) {
                      toggleMultiSel(n.id)
                      return
                    }
                    setSelectedId(n.id)
                    setStyleOpen(false)
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    if (multiSelMode) return
                    startEdit(n.id)
                  }}
                  className={cn(
                    'flex min-h-full w-full flex-col items-center justify-center px-3 py-1.5 text-center shadow-sm transition-all',
                    n.isRoot
                      ? cn(
                          'bg-zinc-900 text-sm font-semibold text-white hover:bg-zinc-800',
                          n.h <= NODE_H + 4 ? 'rounded-full' : 'rounded-2xl',
                        )
                      : cn(
                          src.shape === 'ellipse' ? 'rounded-full' : 'rounded-xl',
                          src.shape === 'plain' && !src.bg
                            ? 'border border-transparent bg-transparent shadow-none'
                            : 'border border-border bg-card hover:border-emerald-500/40',
                        ),
                    !n.isRoot && (st?.size === 'sm' ? 'text-xs' : st?.size === 'lg' ? 'text-sm' : 'text-[13px]'),
                    !n.isRoot && st?.bold && 'font-bold',
                    (isSel || checked) && 'ring-2 ring-emerald-600 ring-offset-1 ring-offset-background',
                    isMatch && 'ring-2 ring-amber-400 ring-offset-1 ring-offset-background',
                    isDragTarget && 'z-20 scale-105 ring-2 ring-emerald-500',
                    isDragSource && 'opacity-40',
                  )}
                  style={{
                    backgroundColor: src.bg || undefined,
                    color: !n.isRoot || src.bg ? ink : undefined,
                  }}
                >
                  {isEditing ? (
                    renderTitleInput(n.isRoot)
                  ) : (
                    <span className="flex w-full items-center justify-center gap-1 leading-snug">
                      {src.icon && <span className="shrink-0 leading-none">{src.icon}</span>}
                      {src.priority && (
                        <span
                          className={cn(
                            'shrink-0 rounded px-1 text-[9px] font-bold leading-4',
                            PRIORITY_STYLES[src.priority].cls,
                          )}
                        >
                          P{src.priority}
                        </span>
                      )}
                      {/* full title — wraps instead of ellipsis */}
                      <span className="min-w-0 whitespace-pre-wrap break-words">{n.title}</span>
                    </span>
                  )}
                </button>
              )
              return (
                <div
                  key={n.id}
                  data-node={n.id}
                  data-nodrag={draggable ? undefined : '1'}
                  className={cn('absolute z-10', isDragTarget && 'z-30')}
                  style={{ left: n.x, top: n.y - n.h / 2, width: n.w, minHeight: n.h, touchAction: 'none' }}
                  onPointerDownCapture={draggable ? handleNodePointerDown(n.id) : undefined}
                  onPointerMoveCapture={handleNodePointerMove}
                  onPointerUpCapture={handleNodePointerUp}
                  onPointerCancelCapture={handleNodePointerCancel}
                >
                  {/* 拖拽中/多选时不挂长按菜单（卸载实例以清掉其 480ms 定时器） */}
                  {dragState || multiSelMode ? (
                    nodeButton
                  ) : (
                    <LongPressMenu
                      actions={nodeMenuActions(n.id)}
                      onAction={(key) => handleNodeMenu(key, n.id)}
                      className="w-full"
                    >
                      {nodeButton}
                    </LongPressMenu>
                  )}
                  {/* 多选勾选圈 */}
                  {multiSelMode && (
                    <button
                      type="button"
                      aria-label={checked ? `取消选择 ${n.title}` : `选择 ${n.title}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleMultiSel(n.id)
                      }}
                      className={cn(
                        'absolute -left-2.5 top-1/2 z-20 flex size-5 -translate-y-1/2 items-center justify-center rounded-full border-2 bg-card shadow-sm',
                        checked ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-muted-foreground/40',
                      )}
                    >
                      {checked && <Check className="size-3" strokeWidth={3} />}
                    </button>
                  )}
                  {/* 备注标记（点击查看/编辑） */}
                  {src.note && !isEditing && (
                    <button
                      type="button"
                      aria-label="查看备注"
                      onClick={(e) => {
                        e.stopPropagation()
                        openNoteEditor(n.id)
                      }}
                      className="absolute -right-1.5 -top-1.5 z-20 flex size-4 items-center justify-center rounded-full bg-amber-400 text-amber-950 shadow"
                    >
                      <StickyNote className="size-2.5" strokeWidth={2} />
                    </button>
                  )}
                  {/* 链接标记（点击打开） */}
                  {src.link && !isEditing && (
                    <button
                      type="button"
                      aria-label="打开链接"
                      onClick={(e) => {
                        e.stopPropagation()
                        openLink(src.link ?? '')
                      }}
                      className="absolute -bottom-1.5 -right-1.5 z-20 flex size-4 items-center justify-center rounded-full bg-blue-500 text-white shadow"
                    >
                      <Link2 className="size-2.5" strokeWidth={2} />
                    </button>
                  )}
                  {/* 折叠圆钮（子节点数徽标） */}
                  {n.childCount > 0 && (
                    <button
                      type="button"
                      aria-label={src.collapsed ? `展开（${n.childCount} 个子节点）` : '折叠分支'}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleCollapse(n.id)
                      }}
                      className={cn(
                        'absolute z-20 flex h-5 min-w-5 items-center justify-center rounded-full border px-1 text-[9px] font-semibold leading-none shadow-sm transition-colors',
                        src.collapsed
                          ? 'border-emerald-600 bg-emerald-600 text-white'
                          : 'border-border bg-card text-muted-foreground hover:border-emerald-500/60',
                      )}
                      style={collapseBadgeStyle(n, layoutKind)}
                    >
                      {n.childCount}
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {/* 缩放控制悬浮条 */}
          <div className="absolute bottom-2 right-2 z-30 flex items-center gap-0.5 rounded-full border border-border bg-card/95 p-0.5 shadow-lg backdrop-blur">
            <button
              type="button"
              onClick={() => zoomBy(1 / 1.25)}
              aria-label="缩小"
              className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
            >
              <ZoomOut className="size-3.5" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={resetZoom}
              aria-label="恢复 100% 缩放"
              className="min-w-11 rounded-full px-1 text-center text-[11px] font-medium tabular-nums text-muted-foreground transition-colors hover:text-foreground"
            >
              {Math.round(transform.scale * 100)}%
            </button>
            <button
              type="button"
              onClick={() => zoomBy(1.25)}
              aria-label="放大"
              className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
            >
              <ZoomIn className="size-3.5" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={fitView}
              aria-label="适应屏幕"
              title="适应屏幕"
              className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
            >
              <Maximize className="size-3.5" strokeWidth={1.75} />
            </button>
          </div>

          {/* 拖拽提示 */}
          {dragState && (
            <div className="pointer-events-none absolute left-1/2 top-2 z-30 -translate-x-1/2 rounded-full bg-zinc-900/90 px-3 py-1 text-[11px] text-white shadow-lg">
              拖到目标节点松手 · 空白处松手取消
            </div>
          )}
          {multiSelMode && (
            <div className="pointer-events-none absolute left-1/2 top-2 z-30 -translate-x-1/2 rounded-full bg-zinc-900/90 px-3 py-1 text-[11px] text-white shadow-lg">
              点选节点进行批量操作 · 已选 {multiSel.size} 个
            </div>
          )}
        </div>
      ) : (
        /* ---------- 大纲视图 ---------- */
        <div className="min-h-0 flex-1 overflow-auto rounded-2xl border border-border bg-muted/20">
          <div className="p-2">
            {outlineRows.map((row) => {
              const src = row.node
              const st = styleOf(src.id)
              const isSel = selectedId === src.id
              const isEditing = editingId === src.id
              const isMatch = searchActive && matchedIds.has(src.id)
              const checked = multiSelMode && multiSel.has(src.id)
              return (
                <div
                  key={src.id}
                  ref={(el) => {
                    if (el) rowRefs.current.set(src.id, el)
                    else rowRefs.current.delete(src.id)
                  }}
                  style={{ paddingLeft: row.depth * 14 }}
                  className="py-px"
                >
                  <div
                    className={cn(
                      'flex items-center gap-1 rounded-lg pr-1',
                      isSel && 'bg-emerald-50 dark:bg-emerald-500/10',
                      isMatch && 'bg-amber-100 dark:bg-amber-500/15',
                      checked && 'ring-1 ring-emerald-600',
                    )}
                  >
                    {row.childCount > 0 ? (
                      <button
                        type="button"
                        aria-label={src.collapsed ? '展开' : '折叠'}
                        onClick={() => toggleCollapse(src.id)}
                        className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <ChevronRight
                          className={cn('size-3.5 transition-transform', !src.collapsed && 'rotate-90')}
                          strokeWidth={2}
                        />
                      </button>
                    ) : (
                      <span className="size-5 shrink-0" />
                    )}
                    {multiSelMode && (
                      <button
                        type="button"
                        aria-label={checked ? `取消选择 ${src.title}` : `选择 ${src.title}`}
                        onClick={() => toggleMultiSel(src.id)}
                        className={cn(
                          'flex size-4 shrink-0 items-center justify-center rounded-full border-2',
                          checked ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-muted-foreground/40',
                        )}
                      >
                        {checked && <Check className="size-2.5" strokeWidth={3} />}
                      </button>
                    )}
                    <LongPressMenu
                      actions={nodeMenuActions(src.id)}
                      onAction={(key) => handleNodeMenu(key, src.id)}
                      className="flex min-w-0 flex-1 items-center"
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          value={draftTitle}
                          onChange={(e) => setDraftTitle(e.target.value)}
                          onBlur={commitEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              const id = editingId
                              commitEdit()
                              if (id) addSibling(id)
                            } else if (e.key === 'Tab') {
                              e.preventDefault()
                              const id = editingId
                              commitEdit()
                              if (id) addChild(id)
                            } else if (e.key === 'Escape') {
                              e.preventDefault()
                              cancelEdit()
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="h-7 w-full min-w-0 rounded border border-emerald-400 bg-card px-1.5 text-[13px] outline-none"
                          placeholder="节点文字"
                          aria-label="编辑节点文字"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            if (multiSelMode) toggleMultiSel(src.id)
                            else {
                              setSelectedId(src.id)
                              setStyleOpen(false)
                            }
                          }}
                          onDoubleClick={() => {
                            if (!multiSelMode) startEdit(src.id)
                          }}
                          className="flex min-w-0 flex-1 items-center gap-1 py-1 text-left text-[13px]"
                        >
                          {src.icon && <span className="shrink-0 leading-none">{src.icon}</span>}
                          {src.priority && (
                            <span
                              className={cn(
                                'shrink-0 rounded px-1 text-[9px] font-bold leading-4',
                                PRIORITY_STYLES[src.priority].cls,
                              )}
                            >
                              P{src.priority}
                            </span>
                          )}
                          <span
                            className={cn(
                              'min-w-0 flex-1 truncate',
                              (st?.bold || row.depth === 0) && 'font-bold',
                              st?.size === 'sm' && 'text-xs',
                              st?.size === 'lg' && 'text-sm',
                            )}
                            style={st?.color ? { color: st.color } : undefined}
                          >
                            {src.title}
                          </span>
                          {src.note && (
                            <span
                              role="button"
                              tabIndex={0}
                              aria-label="查看备注"
                              onClick={(e) => {
                                e.stopPropagation()
                                openNoteEditor(src.id)
                              }}
                              className="shrink-0 text-amber-500"
                            >
                              <StickyNote className="size-3" strokeWidth={1.75} />
                            </span>
                          )}
                          {src.link && (
                            <span
                              role="button"
                              tabIndex={0}
                              aria-label="打开链接"
                              onClick={(e) => {
                                e.stopPropagation()
                                openLink(src.link ?? '')
                              }}
                              className="shrink-0 text-blue-500"
                            >
                              <Link2 className="size-3" strokeWidth={1.75} />
                            </span>
                          )}
                        </button>
                      )}
                    </LongPressMenu>
                    {editMode && !multiSelMode && (
                      <div className="flex shrink-0 items-center text-muted-foreground">
                        <button
                          type="button"
                          onClick={() => moveSibling(src.id, -1)}
                          aria-label="上移"
                          title="上移"
                          className="flex size-6 items-center justify-center rounded transition-colors hover:bg-accent hover:text-foreground"
                        >
                          <ArrowUp className="size-3.5" strokeWidth={1.75} />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveSibling(src.id, 1)}
                          aria-label="下移"
                          title="下移"
                          className="flex size-6 items-center justify-center rounded transition-colors hover:bg-accent hover:text-foreground"
                        >
                          <ArrowDown className="size-3.5" strokeWidth={1.75} />
                        </button>
                        <button
                          type="button"
                          onClick={() => promoteNode(src.id)}
                          aria-label="升级"
                          title="升级（变为上一级同级）"
                          className="flex size-6 items-center justify-center rounded transition-colors hover:bg-accent hover:text-foreground"
                        >
                          <ChevronsUp className="size-3.5" strokeWidth={1.75} />
                        </button>
                        <button
                          type="button"
                          onClick={() => demoteNode(src.id)}
                          aria-label="降级"
                          title="降级（变为前一同级子节点）"
                          className="flex size-6 items-center justify-center rounded transition-colors hover:bg-accent hover:text-foreground"
                        >
                          <ChevronsDown className="size-3.5" strokeWidth={1.75} />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
            {outlineRows.length === 0 && (
              <div className="py-10 text-center text-sm text-muted-foreground">没有节点</div>
            )}
          </div>
        </div>
      )}

      {/* 扩展范围 pill */}
      {extendOptions.length > 0 && (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            onClick={() => {
              setExtendSel(new Set())
              setExtendOpen(true)
            }}
            className="rounded-full bg-zinc-900 px-4 py-1.5 text-xs font-medium text-white shadow-lg transition-all hover:bg-zinc-800 active:scale-[0.98]"
          >
            ＋ 扩展范围
          </button>
        </div>
      )}

      {/* edit toolbar / hint */}
      <div className="relative pb-1 pt-2">
        {styleOpen && selectedId && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setStyleOpen(false)} aria-hidden="true" />
            <div className="absolute bottom-full left-1/2 z-50 mb-1 w-80 max-w-[92vw] -translate-x-1/2 rounded-2xl border border-border bg-card p-3 shadow-xl">
              <div className="max-h-[52vh] space-y-1 overflow-y-auto">
                {/* 快捷属性入口 */}
                <div className="flex items-center justify-between py-1">
                  <span className="text-xs text-muted-foreground">属性</span>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      aria-label="图标"
                      title="图标"
                      onClick={() => setIconOpenId(selectedId)}
                      className={cn(
                        'flex h-8 w-9 items-center justify-center rounded-lg border transition-colors',
                        selNode?.icon
                          ? 'border-emerald-600 bg-emerald-500/10 text-emerald-600'
                          : 'border-border text-foreground hover:bg-accent',
                      )}
                    >
                      <Smile className="size-4" strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      aria-label="备注"
                      title="备注"
                      onClick={() => openNoteEditor(selectedId)}
                      className={cn(
                        'flex h-8 w-9 items-center justify-center rounded-lg border transition-colors',
                        selNode?.note
                          ? 'border-emerald-600 bg-emerald-500/10 text-emerald-600'
                          : 'border-border text-foreground hover:bg-accent',
                      )}
                    >
                      <StickyNote className="size-4" strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      aria-label="链接"
                      title="链接"
                      onClick={() => openLinkEditor(selectedId)}
                      className={cn(
                        'flex h-8 w-9 items-center justify-center rounded-lg border transition-colors',
                        selNode?.link
                          ? 'border-emerald-600 bg-emerald-500/10 text-emerald-600'
                          : 'border-border text-foreground hover:bg-accent',
                      )}
                    >
                      <Link2 className="size-4" strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      aria-label="优先级"
                      title="优先级"
                      onClick={() => setPriorityOpenId(selectedId)}
                      className={cn(
                        'flex h-8 w-9 items-center justify-center rounded-lg border transition-colors',
                        selNode?.priority
                          ? 'border-emerald-600 bg-emerald-500/10 text-emerald-600'
                          : 'border-border text-foreground hover:bg-accent',
                      )}
                    >
                      <Flag className="size-4" strokeWidth={1.75} />
                    </button>
                  </div>
                </div>
                {/* 加粗 */}
                <div className="flex items-center justify-between py-1">
                  <span className="text-xs text-muted-foreground">加粗</span>
                  <button
                    type="button"
                    aria-pressed={!!curStyle?.bold}
                    onClick={() => setNodeStyle(selectedId, { bold: !curStyle?.bold })}
                    className={cn(
                      'flex h-8 w-10 items-center justify-center rounded-lg border text-sm font-bold transition-colors',
                      curStyle?.bold
                        ? 'border-emerald-600 bg-emerald-500/10 text-emerald-600'
                        : 'border-border text-foreground hover:bg-accent',
                    )}
                  >
                    B
                  </button>
                </div>
                {/* 字号 */}
                <div className="flex items-center justify-between py-1">
                  <span className="text-xs text-muted-foreground">字号</span>
                  <div className="flex gap-1.5">
                    {(['sm', 'md', 'lg'] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setNodeStyle(selectedId, { size: s })}
                        className={cn(
                          'rounded-lg border px-2.5 py-1 text-xs transition-colors',
                          (curStyle?.size ?? 'md') === s
                            ? 'border-emerald-600 bg-emerald-500/10 text-emerald-600'
                            : 'border-border text-muted-foreground hover:bg-accent',
                        )}
                      >
                        {s === 'sm' ? '小' : s === 'md' ? '中' : '大'}
                      </button>
                    ))}
                  </div>
                </div>
                {/* 文字颜色 */}
                <div className="flex items-center justify-between py-1">
                  <span className="text-xs text-muted-foreground">文字颜色</span>
                  <div className="flex gap-1.5">
                    {INK_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-label={`文字颜色 ${c}`}
                        onClick={() => setNodeStyle(selectedId, { color: c })}
                        className={cn(
                          'size-6 rounded-full border border-black/10 shadow-sm transition-transform dark:border-white/20',
                          curStyle?.color === c
                            ? 'scale-110 ring-2 ring-emerald-600 ring-offset-1 ring-offset-background'
                            : 'hover:scale-110',
                        )}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                </div>
                {/* 填充色 */}
                <div className="flex items-center justify-between py-1">
                  <span className="text-xs text-muted-foreground">填充色</span>
                  <div className="flex items-center gap-1.5">
                    {BG_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-label={`填充色 ${c}`}
                        onClick={() => setNodeProps(selectedId, { bg: c })}
                        className={cn(
                          'size-6 rounded-full border border-black/10 shadow-sm transition-transform dark:border-white/20',
                          selNode?.bg === c
                            ? 'scale-110 ring-2 ring-emerald-600 ring-offset-1 ring-offset-background'
                            : 'hover:scale-110',
                        )}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                    <button
                      type="button"
                      aria-label="清除填充色"
                      title="清除填充色"
                      onClick={() => setNodeProps(selectedId, { bg: undefined })}
                      className={cn(
                        'flex size-6 items-center justify-center rounded-full border border-dashed text-muted-foreground transition-colors hover:text-foreground',
                        !selNode?.bg && 'border-emerald-600 text-emerald-600',
                      )}
                    >
                      <X className="size-3" strokeWidth={2} />
                    </button>
                  </div>
                </div>
                {/* 形状 */}
                <div className="flex items-center justify-between py-1">
                  <span className="text-xs text-muted-foreground">形状</span>
                  <div className="flex gap-1.5">
                    {(['round', 'ellipse', 'plain'] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setNodeProps(selectedId, { shape: s === 'round' ? undefined : s })}
                        className={cn(
                          'rounded-lg border px-2.5 py-1 text-xs transition-colors',
                          (selNode?.shape ?? 'round') === s
                            ? 'border-emerald-600 bg-emerald-500/10 text-emerald-600'
                            : 'border-border text-muted-foreground hover:bg-accent',
                        )}
                      >
                        {s === 'round' ? '圆角' : s === 'ellipse' ? '椭圆' : '无边框'}
                      </button>
                    ))}
                  </div>
                </div>
                {/* 分支线颜色 */}
                <div className="flex items-center justify-between py-1">
                  <span className="text-xs text-muted-foreground">分支线颜色</span>
                  <div className="flex items-center gap-1.5">
                    {BRANCH_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-label={`分支线颜色 ${c}`}
                        onClick={() => setNodeProps(selectedId, { branchColor: c })}
                        className={cn(
                          'size-6 rounded-full border border-black/10 shadow-sm transition-transform dark:border-white/20',
                          selNode?.branchColor === c
                            ? 'scale-110 ring-2 ring-emerald-600 ring-offset-1 ring-offset-background'
                            : 'hover:scale-110',
                        )}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                    <button
                      type="button"
                      aria-label="清除分支线颜色"
                      title="清除分支线颜色"
                      onClick={() => setNodeProps(selectedId, { branchColor: undefined })}
                      className={cn(
                        'flex size-6 items-center justify-center rounded-full border border-dashed text-muted-foreground transition-colors hover:text-foreground',
                        !selNode?.branchColor && 'border-emerald-600 text-emerald-600',
                      )}
                    >
                      <X className="size-3" strokeWidth={2} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
        {editMode ? (
          multiSelMode ? (
            /* 多选批量操作栏 */
            <div className="flex items-center gap-2 overflow-x-auto pb-1 pt-1">
              <span className="shrink-0 text-xs font-medium text-muted-foreground">已选 {multiSel.size}</span>
              <button
                type="button"
                onClick={batchDelete}
                disabled={multiSel.size === 0}
                className="flex shrink-0 items-center gap-1 rounded-full border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-red-500/10"
              >
                <Trash2 className="size-3.5" strokeWidth={1.75} />
                删除
              </button>
              <button
                type="button"
                onClick={() => batchSetBold(!selBoldAll)}
                disabled={multiSel.size === 0}
                className="flex shrink-0 items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
              >
                <Bold className="size-3.5" strokeWidth={1.75} />
                {selBoldAll ? '取消加粗' : '加粗'}
              </button>
              <div className="flex shrink-0 items-center gap-1">
                {INK_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`统一颜色 ${c}`}
                    title="统一文字颜色"
                    onClick={() => batchSetColor(c)}
                    className="size-5 shrink-0 rounded-full border border-black/10 shadow-sm transition-transform hover:scale-110 dark:border-white/20"
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {([1, 2, 3] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => batchSetPriority(p)}
                    className="shrink-0 rounded-full border border-border px-2 py-1 text-[10px] font-bold transition-colors hover:bg-accent"
                    style={{ color: PRIORITY_STYLES[p].hex, borderColor: `${PRIORITY_STYLES[p].hex}55` }}
                  >
                    P{p}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={exitMultiSelect}
                className="ml-auto shrink-0 rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-700"
              >
                完成
              </button>
            </div>
          ) : selectedId ? (
            <div className="grid grid-cols-5 gap-2">
              {EDIT_TOOLS.map((t) => {
                const Icon = t.icon
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => handleEditTool(t.key)}
                    className={cn(
                      'flex flex-col items-center gap-1 rounded-2xl border border-border bg-card py-2.5 text-[10px] text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground',
                      t.key === 'delete' && 'hover:border-red-300 hover:text-red-600',
                    )}
                  >
                    <Icon className="size-4" strokeWidth={1.75} />
                    {t.label}
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="py-2 text-center text-xs text-muted-foreground">
              点选一个节点后可编辑 · 长按节点有更多操作 · 按住节点拖动可移动
            </div>
          )
        ) : (
          <div className="py-2 text-center text-xs text-muted-foreground">
            点按节点查看 · 双击或长按节点可编辑 · 双指缩放 / 拖动平移画布
          </div>
        )}
      </div>

      {/* 拖拽落点选择 sheet */}
      <BottomSheet
        open={dropChoice !== null}
        onOpenChange={(o) => {
          if (!o) setDropChoice(null)
        }}
        title="移动节点到"
      >
        <div className="space-y-2 pt-2">
          {dropChoice && (
            <>
              <button
                type="button"
                onClick={() => performMove('child')}
                className="flex w-full items-center gap-3 rounded-2xl border border-border bg-card p-3.5 text-left shadow-sm transition-colors hover:bg-accent"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600">
                  <GitBranchPlus className="size-4" strokeWidth={1.75} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">作为「{dropChoice.targetTitle}」的子节点</span>
                  <span className="block text-xs text-muted-foreground">移入目标节点内部（自动展开）</span>
                </span>
              </button>
              {dropChoice.targetId !== doc.root.id && (
                <>
                  <button
                    type="button"
                    onClick={() => performMove('before')}
                    className="flex w-full items-center gap-3 rounded-2xl border border-border bg-card p-3.5 text-left shadow-sm transition-colors hover:bg-accent"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600">
                      <ArrowUp className="size-4" strokeWidth={1.75} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">移到「{dropChoice.targetTitle}」前面</span>
                      <span className="block text-xs text-muted-foreground">同级排序</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => performMove('after')}
                    className="flex w-full items-center gap-3 rounded-2xl border border-border bg-card p-3.5 text-left shadow-sm transition-colors hover:bg-accent"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600">
                      <ArrowDown className="size-4" strokeWidth={1.75} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">移到「{dropChoice.targetTitle}」后面</span>
                      <span className="block text-xs text-muted-foreground">同级排序</span>
                    </span>
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => setDropChoice(null)}
                className="h-11 w-full rounded-full border border-border text-sm text-muted-foreground transition-colors hover:bg-accent"
              >
                取消
              </button>
            </>
          )}
        </div>
      </BottomSheet>

      {/* emoji 图标选择 sheet */}
      <BottomSheet
        open={iconOpenId !== null}
        onOpenChange={(o) => {
          if (!o) setIconOpenId(null)
        }}
        title="选择节点图标"
      >
        <div className="space-y-3 pt-2">
          <div className="grid grid-cols-8 gap-1.5">
            {EMOJI_CHOICES.map((em) => (
              <button
                key={em}
                type="button"
                onClick={() => {
                  if (iconOpenId) setNodeProps(iconOpenId, { icon: em })
                  setIconOpenId(null)
                }}
                className="flex h-10 items-center justify-center rounded-xl border border-border bg-card text-xl transition-colors hover:bg-accent"
              >
                {em}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              if (iconOpenId) setNodeProps(iconOpenId, { icon: undefined })
              setIconOpenId(null)
            }}
            className="h-10 w-full rounded-full border border-border text-sm text-muted-foreground transition-colors hover:bg-accent"
          >
            清除图标
          </button>
        </div>
      </BottomSheet>

      {/* 备注编辑 dialog */}
      <Dialog
        open={noteOpenId !== null}
        onOpenChange={(o) => {
          if (!o) setNoteOpenId(null)
        }}
      >
        <DialogContent className="max-w-sm rounded-2xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>节点备注</DialogTitle>
          </DialogHeader>
          <Textarea
            autoFocus
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            placeholder="输入备注内容（可在搜索中匹配）"
            className="min-h-28 text-sm"
            aria-label="备注内容"
          />
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => {
              if (noteOpenId) setNodeProps(noteOpenId, { note: undefined })
              setNoteOpenId(null)
            }}>
              清除
            </Button>
            <Button
              className="rounded-full bg-emerald-600 text-white hover:bg-emerald-700"
              onClick={() => {
                if (noteOpenId) setNodeProps(noteOpenId, { note: noteDraft.trim() || undefined })
                setNoteOpenId(null)
              }}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 链接编辑 dialog */}
      <Dialog
        open={linkOpenId !== null}
        onOpenChange={(o) => {
          if (!o) setLinkOpenId(null)
        }}
      >
        <DialogContent className="max-w-sm rounded-2xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>节点链接</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={linkDraft}
            onChange={(e) => setLinkDraft(e.target.value)}
            placeholder="https://…"
            inputMode="url"
            aria-label="链接地址"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (linkOpenId) setNodeProps(linkOpenId, { link: linkDraft.trim() || undefined })
                setLinkOpenId(null)
              }
            }}
          />
          <DialogFooter className="gap-2">
            {linkDraft.trim() && (
              <Button variant="outline" onClick={() => openLink(linkDraft)}>
                打开
              </Button>
            )}
            <Button variant="outline" onClick={() => {
              if (linkOpenId) setNodeProps(linkOpenId, { link: undefined })
              setLinkOpenId(null)
            }}>
              清除
            </Button>
            <Button
              className="rounded-full bg-emerald-600 text-white hover:bg-emerald-700"
              onClick={() => {
                if (linkOpenId) setNodeProps(linkOpenId, { link: linkDraft.trim() || undefined })
                setLinkOpenId(null)
              }}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 优先级选择 sheet */}
      <BottomSheet
        open={priorityOpenId !== null}
        onOpenChange={(o) => {
          if (!o) setPriorityOpenId(null)
        }}
        title="设置优先级"
      >
        <div className="grid grid-cols-4 gap-2 pt-2">
          {([1, 2, 3] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => {
                if (priorityOpenId) setNodeProps(priorityOpenId, { priority: p })
                setPriorityOpenId(null)
              }}
              className="flex h-11 items-center justify-center rounded-2xl border text-sm font-bold transition-colors hover:bg-accent"
              style={{ color: PRIORITY_STYLES[p].hex, borderColor: `${PRIORITY_STYLES[p].hex}66` }}
            >
              P{p}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              if (priorityOpenId) setNodeProps(priorityOpenId, { priority: undefined })
              setPriorityOpenId(null)
            }}
            className="h-11 rounded-2xl border border-border text-sm text-muted-foreground transition-colors hover:bg-accent"
          >
            无
          </button>
        </div>
      </BottomSheet>

      {/* 扩展范围 sheet */}
      <BottomSheet open={extendOpen} onOpenChange={setExtendOpen} title="扩展范围">
        <div className="space-y-4 pt-2">
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {extendOptions.map((o) => {
              const checked = extendSel.has(o.label)
              return (
                <label
                  key={o.label}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-3 rounded-2xl border p-3 transition-colors',
                    checked ? 'border-emerald-600 bg-emerald-50 dark:bg-emerald-500/10' : 'border-border bg-card hover:bg-accent/60',
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(v) => {
                      setExtendSel((prev) => {
                        const n = new Set(prev)
                        if (v) n.add(o.label)
                        else n.delete(o.label)
                        return n
                      })
                    }}
                    className="shrink-0"
                    aria-label={o.label}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{o.label}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {o.preview || '（空）'}
                    </span>
                  </span>
                </label>
              )
            })}
            {extendOptions.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                全部范围均已合并到当前导图
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={extendMaps}
            disabled={extending || extendSel.size === 0}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-full bg-emerald-600 text-sm font-semibold text-white shadow-lg transition-all hover:bg-emerald-700 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
          >
            {extending && <Loader2 className="size-4 animate-spin" />}
            下一步{extending ? '（生成中）' : ''}
          </button>
        </div>
      </BottomSheet>

      {/* export sheet */}
      <BottomSheet open={exportOpen} onOpenChange={setExportOpen} title="导出导图">
        <div className="space-y-2 pt-2">
          {EXPORT_ITEMS.map((row) => {
            const Icon = row.icon
            const busy = exporting === row.kind
            return (
              <button
                key={row.kind}
                type="button"
                onClick={() => runExport(row.kind)}
                disabled={exporting !== null}
                className="flex w-full items-center gap-3 rounded-2xl border border-border bg-card p-3.5 text-left shadow-sm transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600">
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Icon className="size-4" strokeWidth={1.75} />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{row.title}</span>
                  <span className="block text-xs text-muted-foreground">{row.sub}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            )
          })}
        </div>
      </BottomSheet>

      {/* 拖拽幽灵节点（跟随手指/鼠标） */}
      {dragState && (
        <div
          className="pointer-events-none fixed z-[70] max-w-56 -translate-x-1/2 -translate-y-[150%] truncate rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white opacity-90 shadow-xl"
          style={{ left: dragState.x, top: dragState.y }}
        >
          {dragState.icon ? `${dragState.icon} ` : ''}
          {dragState.title}
        </div>
      )}
    </div>
  )
}
