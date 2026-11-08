'use client'

import * as React from 'react'
import {
  ArrowLeft,
  Check,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  FileArchive,
  FileText,
  GitBranchPlus,
  Image as ImageIcon,
  List,
  ListChecks,
  Loader2,
  Network,
  Pencil,
  Plus,
  Redo2,
  Trash2,
  Type,
  Undo2,
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

/** MindmapDoc with editor extras (styles + merged scopes), persisted as extra JSON fields. */
interface StyledMindmapDoc extends MindmapDoc {
  styles?: Record<string, NodeStyle>
  /** Scope labels already merged into this map (全文 / 第N段). */
  scopes?: string[]
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

// ---------- constants ----------

const PAD = 20 // canvas padding
const GAP = 44 // horizontal gap between depth columns
const V_GAP = 12 // vertical gap between sibling subtrees
const NODE_H = 36 // single-line node height
const NODE_LINE_H = 19 // line height for wrapped node text
const NODE_PAD_X = 24 // horizontal padding inside a node
const MAX_NODE_W = 240 // wrap width cap — longer titles wrap instead of ellipsis
const MIN_NODE_W = 88 // minimum node pill width

const INK_COLORS = ['#18181b', '#6b7280', '#059669', '#dc2626', '#d97706', '#9333ea']

/** Safeguard for auto-per-unit generation (AI cost control). */
const MAX_AUTO_UNITS = 20

const EDIT_TOOLS: { key: string; label: string; icon: React.ComponentType<{ className?: string; strokeWidth?: number }> }[] = [
  { key: 'sibling', label: '添加同级', icon: Plus },
  { key: 'child', label: '添加子级', icon: GitBranchPlus },
  { key: 'style', label: '文本样式', icon: Type },
  { key: 'delete', label: '删除', icon: Trash2 },
  { key: 'copy', label: '复制', icon: Copy },
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

/** Node box size: width fits the longest wrapped line (up to MAX_NODE_W),
 *  height grows with the number of lines. Full text always visible. */
function measureNode(title: string, isRoot: boolean, st?: NodeStyle): MeasuredNode {
  const fs = nodeFontSize(isRoot, st)
  const lines = wrapText(title, fs, MAX_NODE_W - NODE_PAD_X)
  const widest = Math.max(
    ...lines.map((l) => textWidth(l, fs)),
    MIN_NODE_W - NODE_PAD_X,
  )
  return {
    w: Math.min(MAX_NODE_W, Math.ceil(widest) + NODE_PAD_X),
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

function normalizeIds(node: MindNode): MindNode {
  const kids = Array.isArray(node.children) ? node.children : undefined
  return {
    id: node.id || uid(),
    title: typeof node.title === 'string' && node.title ? node.title : '未命名',
    children: kids && kids.length > 0 ? kids.map(normalizeIds) : undefined,
  }
}

function normalizeDoc(d: MindmapDoc): StyledMindmapDoc {
  return { ...(d as StyledMindmapDoc), root: normalizeIds(d.root) }
}

function cloneTree(root: MindNode): MindNode {
  return JSON.parse(JSON.stringify(root)) as MindNode
}

function reIdTree(node: MindNode): MindNode {
  return {
    id: uid(),
    title: node.title,
    children: node.children && node.children.length > 0 ? node.children.map(reIdTree) : undefined,
  }
}

function findNode(root: MindNode, id: string): MindNode | null {
  if (root.id === id) return root
  for (const c of root.children ?? []) {
    const hit = findNode(c, id)
    if (hit) return hit
  }
  return null
}

function findParent(root: MindNode, id: string): MindNode | null {
  for (const c of root.children ?? []) {
    if (c.id === id) return root
    const hit = findParent(c, id)
    if (hit) return hit
  }
  return null
}

function collectIds(node: MindNode, acc: string[] = []): string[] {
  acc.push(node.id)
  for (const c of node.children ?? []) collectIds(c, acc)
  return acc
}

function insertChild(root: MindNode, parentId: string, node: MindNode) {
  const target = findNode(root, parentId)
  if (target) target.children = [...(target.children ?? []), node]
}

/** Insert `node` after siblingId in its parent; no-op when siblingId is the root. */
function insertSibling(root: MindNode, siblingId: string, node: MindNode) {
  const parent = findParent(root, siblingId)
  if (!parent || !parent.children) return
  const idx = parent.children.findIndex((c) => c.id === siblingId)
  if (idx >= 0) parent.children.splice(idx + 1, 0, node)
}

function removeSubtree(root: MindNode, id: string) {
  const parent = findParent(root, id)
  if (!parent || !parent.children) return
  const idx = parent.children.findIndex((c) => c.id === id)
  if (idx >= 0) parent.children.splice(idx, 1)
  if (parent.children.length === 0) delete parent.children
}

// ---------- horizontal tree layout ----------

interface LayoutNode {
  id: string
  title: string
  depth: number
  x: number
  y: number // vertical center
  w: number
  h: number
  lines: string[]
  fs: number
  isRoot: boolean
}

interface LayoutLink {
  x1: number
  y1: number
  x2: number
  y2: number
  depth: number
}

interface TreeLayout {
  nodes: LayoutNode[]
  links: LayoutLink[]
  width: number
  height: number
}

/** Tidy horizontal tree layout with adaptive node sizes.
 *  • Every node is measured (wrapped lines → width up to MAX_NODE_W, height
 *    grows with line count) so long titles wrap instead of being truncated.
 *  • Columns are as wide as the widest node at that depth.
 *  • Each subtree gets a disjoint vertical band (≥ its own height), so nodes
 *    never overlap; parent centers sit in the middle of their band.
 *  • Links connect the parent's right edge to the child's left edge, so
 *    endpoints follow the real node sizes. */
function computeLayout(root: MindNode, styles?: Record<string, NodeStyle>): TreeLayout {
  const sizes = new Map<string, MeasuredNode>()
  const parentOf = new Map<string, string>()

  const preWalk = (n: MindNode, depth: number) => {
    sizes.set(n.id, measureNode(n.title, depth === 0, styles?.[n.id]))
    for (const k of n.children ?? []) {
      parentOf.set(k.id, n.id)
      preWalk(k, depth + 1)
    }
  }
  preWalk(root, 0)

  // widest node per depth column
  const colW = new Map<number, number>()
  const walkW = (n: MindNode, depth: number) => {
    colW.set(depth, Math.max(colW.get(depth) ?? 0, sizes.get(n.id)!.w))
    for (const k of n.children ?? []) walkW(k, depth + 1)
  }
  walkW(root, 0)

  const xOf = (depth: number): number => {
    let x = PAD
    for (let d = 0; d < depth; d += 1) x += (colW.get(d) ?? 0) + GAP
    return x
  }

  // subtree height: own height or the children's stacked height, whichever larger
  const subH = (n: MindNode): number => {
    const s = sizes.get(n.id)!
    if (!n.children || n.children.length === 0) return s.h
    const kidsSum =
      n.children.reduce((acc, k) => acc + subH(k), 0) + V_GAP * (n.children.length - 1)
    return Math.max(s.h, kidsSum)
  }

  const nodes: LayoutNode[] = []
  const place = (n: MindNode, depth: number, top: number) => {
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
    })
    if (n.children && n.children.length > 0) {
      const kidsSum =
        n.children.reduce((acc, k) => acc + subH(k), 0) + V_GAP * (n.children.length - 1)
      let kt = top + (total - kidsSum) / 2
      for (const k of n.children) {
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
    links.push({ x1: p.x + p.w, y1: p.y, x2: n.x, y2: n.y, depth: n.depth })
  }

  const contentW = nodes.reduce((acc, n) => Math.max(acc, n.x + n.w), 0)
  return {
    nodes,
    links,
    width: Math.max(contentW + PAD, PAD * 2 + MIN_NODE_W),
    height: Math.max(PAD * 2 + subH(root), NODE_H + PAD * 2),
  }
}

// ---------- export helpers ----------

function buildMapSvg(doc: StyledMindmapDoc, layout: TreeLayout): string {
  const parts: string[] = []
  parts.push(`<rect x="0" y="0" width="${layout.width}" height="${layout.height}" fill="#ffffff"/>`)
  for (const l of layout.links) {
    const midX = l.x1 + (l.x2 - l.x1) / 2
    parts.push(
      `<path d="M ${l.x1} ${l.y1} L ${midX} ${l.y1} L ${midX} ${l.y2} L ${l.x2} ${l.y2}" fill="none" stroke="#a1a1aa" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
  }
  for (const n of layout.nodes) {
    const st = doc.styles?.[n.id]
    const fill = n.isRoot ? '#18181b' : '#ffffff'
    const stroke = n.isRoot ? '#18181b' : '#d4d4d8'
    const color = n.isRoot ? '#ffffff' : st?.color || '#18181b'
    const fs = n.fs
    const fw = st?.bold || n.isRoot ? 600 : 400
    const rx = n.isRoot ? 18 : 12
    parts.push(
      `<rect x="${n.x}" y="${n.y - n.h / 2}" width="${n.w}" height="${n.h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`,
    )
    // wrapped full text — one tspan per line, vertically centered
    const tspans = n.lines
      .map(
        (ln, i) =>
          `<tspan x="${n.x + n.w / 2}" y="${(n.y + (i - (n.lines.length - 1) / 2) * NODE_LINE_H).toFixed(1)}" dominant-baseline="central">${escapeXml(ln)}</tspan>`,
      )
      .join('')
    parts.push(
      `<text text-anchor="middle" font-family="-apple-system,'PingFang SC','Microsoft YaHei',sans-serif" font-size="${fs}" font-weight="${fw}" fill="${color}">${tspans}</text>`,
    )
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
  const [clipboard, setClipboard] = React.useState<MindNode | null>(null)
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
  const [exporting, setExporting] = React.useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null)
  // rename + batch-delete (list sheet)
  const [renameId, setRenameId] = React.useState<string | null>(null)
  const [renameTitle, setRenameTitle] = React.useState('')
  const [batchMode, setBatchMode] = React.useState(false)
  const [batchSel, setBatchSel] = React.useState<Set<string>>(new Set())
  const [confirmBatch, setConfirmBatch] = React.useState(false)

  const cancelEditRef = React.useRef(false)
  const saveTimerRef = React.useRef<number | null>(null)
  // Write-through refs so event handlers always see the latest list/doc.
  const docsRef = React.useRef(docs)
  const docIdRef = React.useRef(docId)

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

  const applyRoot = React.useCallback((root: MindNode) => {
    const id = docIdRef.current
    if (!id) return
    const next = docsRef.current.map((d) =>
      d.id === id ? { ...d, root, updatedAt: new Date().toISOString() } : d,
    )
    setDocsAndSave(next)
    setSelectedId((sel) => (sel && findNode(root, sel) ? sel : null))
    setEditingId((eid) => (eid && findNode(root, eid) ? eid : null))
  }, [setDocsAndSave])

  const pushUndo = (root: MindNode) => {
    setUndoStack((s) => [...s.slice(-39), JSON.stringify(root)])
    setRedoStack([])
  }

  const mutateRoot = (fn: (clone: MindNode) => void) => {
    const doc = getDoc()
    if (!doc) return
    pushUndo(doc.root)
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

  const undo = () => {
    const doc = getDoc()
    if (!doc || undoStack.length === 0) return
    const snapshot = undoStack[undoStack.length - 1]
    setUndoStack((s) => s.slice(0, -1))
    setRedoStack((r) => [...r, JSON.stringify(doc.root)])
    applyRoot(JSON.parse(snapshot) as MindNode)
  }

  const redo = () => {
    const doc = getDoc()
    if (!doc || redoStack.length === 0) return
    const snapshot = redoStack[redoStack.length - 1]
    setRedoStack((r) => r.slice(0, -1))
    setUndoStack((s) => [...s, JSON.stringify(doc.root)])
    applyRoot(JSON.parse(snapshot) as MindNode)
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
    pushUndo(doc.root)
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
    const node: MindNode = { id: uid(), title: '新节点' }
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
    const node: MindNode = { id: uid(), title: '新节点' }
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
    updateDocInPlace((d) => {
      const styles = { ...(d.styles ?? {}) }
      styles[id] = { ...(styles[id] ?? {}), ...patch }
      return { ...d, styles }
    })
  }

  // ---------- node context menu ----------

  const nodeMenuActions = (id: string): MenuAction[] => {
    if (menuActions) return menuActions
    const doc = getDoc()
    const isRoot = doc ? id === doc.root.id : false
    return [
      { key: 'edit', label: '编辑文字', icon: <Pencil className="size-3.5" strokeWidth={1.75} /> },
      { key: 'add-child', label: '添加子级', icon: <GitBranchPlus className="size-3.5" strokeWidth={1.75} /> },
      {
        key: 'add-sibling',
        label: '添加同级',
        icon: <Plus className="size-3.5" strokeWidth={1.75} />,
        disabled: isRoot,
      },
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

  const genMindmap = async (text: string): Promise<MindNode> => {
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
          const children: MindNode[] = []
          for (let i = 0; i < list.length; i += 1) {
            toast.loading(`正在生成 ${i + 1}/${list.length}：${list[i].label} …`, { id: tid })
            children.push(await genMindmap(list[i].text))
          }
          const root: MindNode = {
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
      for (let i = 0; i < labels.length; i++) {
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
      pushUndo(doc.root)
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

  // ---------- export ----------

  const layout = React.useMemo(
    () => (currentDoc ? computeLayout(currentDoc.root, currentDoc.styles) : null),
    [currentDoc],
  )

  const runExport = async (kind: 'png' | 'pdf' | 'xmind') => {
    const doc = getDoc()
    if (!doc || !layout) return
    setExporting(kind)
    try {
      if (kind === 'png') {
        const blob = await svgToPngBlob(buildMapSvg(doc, layout), layout.width, layout.height)
        downloadBlob(blob, `${doc.title}.png`)
        toast.success('已导出 PNG 图片')
      } else if (kind === 'pdf') {
        const blob = await svgToPngBlob(buildMapSvg(doc, layout), layout.width, layout.height)
        const dataUrl = await blobToDataUrl(blob)
        const { jsPDF } = await import('jspdf')
        const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
        const pw = pdf.internal.pageSize.getWidth()
        const ph = pdf.internal.pageSize.getHeight()
        const margin = 28
        const ratio = Math.min(
          (pw - margin * 2) / layout.width,
          (ph - margin * 2) / layout.height,
        )
        const w = layout.width * ratio
        const h = layout.height * ratio
        pdf.addImage(dataUrl, 'PNG', (pw - w) / 2, (ph - h) / 2, w, h)
        pdf.save(`${doc.title}.pdf`)
        toast.success('已导出 PDF 文档')
      } else {
        const toTopic = (n: MindNode): Record<string, unknown> => {
          const t: Record<string, unknown> = { id: n.id, title: n.title }
          if (n.children && n.children.length > 0) {
            t.children = { attached: n.children.map(toTopic) }
          }
          return t
        }
        // jszip ships `export = JSZip` typings without a constructor overload,
        // so recover the constructible shape from the module's default export.
        const jszipModule = await import('jszip')
        const JSZipCtor = jszipModule.default as unknown as new () => typeof jszipModule.default
        const zip = new JSZipCtor()
        zip.file(
          'content.json',
          JSON.stringify([
            { id: doc.id, class: 'sheet', title: doc.title, rootTopic: toTopic(doc.root) },
          ]),
        )
        zip.file('metadata.json', JSON.stringify({ creator: { name: '背书吧' } }))
        zip.file('manifest.json', JSON.stringify({ 'file-checksum': '' }))
        const blob = await zip.generateAsync({ type: 'blob' })
        downloadBlob(blob, `${doc.title}.xmind`)
        toast.success('已导出 XMind 文件')
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
            <DialogContent className="max-w-sm rounded-2xl">
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
            范围 {doc.scope ?? '全文'} · {doc.levels ?? 2}级
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
              }}
              className="h-8 rounded-full border border-border bg-card px-3 text-xs font-medium transition-colors hover:bg-accent"
            >
              完成
            </button>
          </div>
        )}
      </div>

      {/* horizontal tree canvas */}
      <div
        className="min-h-0 flex-1 overflow-auto rounded-2xl border border-border bg-muted/20"
        onClick={() => {
          setSelectedId(null)
          setStyleOpen(false)
        }}
      >
        <div className="flex min-h-full items-center">
          <div
            className="relative m-auto"
            style={{ width: layout.width, height: layout.height }}
            role="tree"
            aria-label="思维导图"
          >
            <svg
              className="absolute inset-0"
              width={layout.width}
              height={layout.height}
              aria-hidden="true"
            >
              {layout.links.map((l, i) => {
                const midX = l.x1 + (l.x2 - l.x1) / 2
                return (
                  <path
                    key={`link-${i}`}
                    d={`M ${l.x1} ${l.y1} L ${midX} ${l.y1} L ${midX} ${l.y2} L ${l.x2} ${l.y2}`}
                    fill="none"
                    strokeWidth={l.depth === 1 ? 1.75 : 1.25}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-zinc-300 dark:text-zinc-600"
                    stroke="currentColor"
                  />
                )
              })}
            </svg>
            {layout.nodes.map((n) => {
              const st = styleOf(n.id)
              const isSel = selectedId === n.id
              const isEditing = editingId === n.id
              const ink = effectiveInk(st?.color, isDark)
              return (
                <div
                  key={n.id}
                  className="absolute z-10"
                  style={{
                    left: n.x,
                    top: n.y - n.h / 2,
                    width: n.w,
                    // minHeight (instead of fixed height) lets real font
                    // metrics add a wrap line without clipping
                    minHeight: n.h,
                  }}
                >
                  <LongPressMenu
                    actions={nodeMenuActions(n.id)}
                    onAction={(key) => handleNodeMenu(key, n.id)}
                    className="w-full"
                  >
                    <button
                      type="button"
                      role="treeitem"
                      aria-selected={isSel}
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelectedId(n.id)
                        setStyleOpen(false)
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        startEdit(n.id)
                      }}
                      className={cn(
                        'flex min-h-full w-full flex-col items-center justify-center px-3 py-1.5 text-center shadow-sm transition-all',
                        n.isRoot
                          ? n.h <= NODE_H + 4
                            ? 'rounded-full bg-zinc-900 text-sm font-semibold text-white hover:bg-zinc-800'
                            : 'rounded-2xl bg-zinc-900 text-sm font-semibold text-white hover:bg-zinc-800'
                          : 'rounded-xl border border-border bg-card hover:border-emerald-500/40',
                        !n.isRoot && (st?.size === 'sm' ? 'text-xs' : st?.size === 'lg' ? 'text-sm' : 'text-[13px]'),
                        !n.isRoot && st?.bold && 'font-bold',
                        isSel && 'ring-2 ring-emerald-600 ring-offset-1 ring-offset-background',
                      )}
                      style={!n.isRoot && ink ? { color: ink } : undefined}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          value={draftTitle}
                          onChange={(e) => setDraftTitle(e.target.value)}
                          onBlur={commitEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitEdit()
                            if (e.key === 'Escape') {
                              e.preventDefault()
                              cancelEdit()
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className={cn(
                            'w-full bg-transparent text-center outline-none',
                            n.isRoot ? 'text-sm text-white' : 'text-[13px]',
                          )}
                          placeholder="节点文字"
                          aria-label="编辑节点文字"
                        />
                      ) : (
                        // full title — wraps instead of ellipsis
                        <span className="block w-full whitespace-pre-wrap break-words leading-snug">
                          {n.title}
                        </span>
                      )}
                    </button>
                  </LongPressMenu>
                </div>
              )
            })}
          </div>
        </div>
      </div>

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
            <div className="absolute bottom-full left-1/2 z-50 mb-1 w-72 -translate-x-1/2 rounded-2xl border border-border bg-card p-3 shadow-xl">
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
              <div className="flex items-center justify-between py-1">
                <span className="text-xs text-muted-foreground">颜色</span>
                <div className="flex gap-1.5">
                  {INK_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`颜色 ${c}`}
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
            </div>
          </>
        )}
        {editMode ? (
          selectedId ? (
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
              点选一个节点后可编辑 · 长按节点有更多操作
            </div>
          )
        ) : (
          <div className="py-2 text-center text-xs text-muted-foreground">
            点按节点查看 · 双击或长按节点可编辑
          </div>
        )}
      </div>

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
          {(
            [
              { kind: 'png' as const, icon: ImageIcon, title: '图片', sub: '.png 高清图片' },
              { kind: 'pdf' as const, icon: FileText, title: 'PDF', sub: '.pdf 文档（横向 A4）' },
              { kind: 'xmind' as const, icon: FileArchive, title: 'XMind', sub: '.xmind 可继续编辑' },
            ]
          ).map((row) => {
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
    </div>
  )
}
