'use client'

// MediaEditDialog — 富媒体二次编辑弹窗：可视化 ⇄ 源码 双模式 + 容错 + AI。
//   table   → 表格网格编辑器（增删行列、单元格编辑）
//   formula → 公式编辑器（KaTeX 实时预览 + 常用符号面板 + LaTeX 输入）
//   mermaid mindmap → 思维导图树编辑器（加/改名/删/移动节点）
//   mermaid graph/flowchart → 画布式流程图编辑器（SVG 拖拽 / 锚点连线 / 缩放平移 /
//     subgraph 分组 + 列表模式，两模式共享同一 FlowDoc 与撤销栈）
//   svg → SVG 可视化编辑器（形状面板 / 画布拖拽 / 属性栏，复杂元素源码保留）
//   html → HTML 可视化编辑器（元素结构树 + 属性面板 + 快速插入模板 +
//     Shadow DOM 沙盒实时预览 + 源码校验/格式化）
//   其他 code → 实时预览 + 源码编辑
// 容错（apply 前校验 + 部分加载 + AI 修复）：
//   • mermaid：mermaid.parse 校验；失败时按错误行号逐行剥离出「净化版」预览，
//     顶部黄色横幅提示「第 X 行有误已忽略」，可 AI 修复 / 仍用原文
//   • svg：DOMParser parsererror 校验；html：DOMParser + 标签配对自检；
//     formula：katex renderToString 校验
//   • AI 修复：调 /api/media-ai 返回修复代码先预览 → 接纳 / 撤销
// AI 助理：右下角临时悬浮对话（AiAssistPopover，支持语音输入/看图生成/技能模板），
//   生成代码一键写入编辑器，写入后自动切回可视化继续编辑。
// 应用后 onApply(newSrc) 由宿主替换块文本中的原文（可撤销）。

import * as React from 'react'
import katex from 'katex'
// 化学公式扩展（\ce{}）——与 rich-content 共享同一 katex 实例，弹窗内独立可用
import 'katex/contrib/mhchem'
import {
  AlertTriangle,
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Bold,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Code2,
  Combine,
  Copy,
  Eraser,
  Eye,
  Hand,
  Highlighter,
  Italic,
  Link as LinkIcon,
  Loader2,
  Magnet,
  Maximize2,
  MoreVertical,
  MousePointer2,
  MoveRight,
  Pencil,
  Pin,
  Plus,
  Redo2,
  Sparkles,
  Split,
  Trash2,
  Type,
  Undo2,
  Wand2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import {
  MEDIA_KIND_LABEL,
  isMindmap,
  parseMindmap,
  serializeMindmap,
  type MediaKind,
  type MediaRef,
  type MediaRefKind,
  type MindNode,
} from '@/components/recitation/media-refs'
import { AiAssistPopover } from '@/components/recitation/ai-assist-popover'
import { SvgVisualEditor } from '@/components/recitation/media-svg-editor'

const RichContentLazy = React.lazy(() =>
  import('@/components/recitation/rich-content').then((m) => ({ default: m.RichContent })),
)

// ---------- 表格网格编辑器（完整版：横向滚动 / 表头 / 对齐 / 合并 /
//   行列增删移 / 富文本 / 批量 / 粘贴导入 / 排序 / 双向同步） ----------
//
// 完整可视化表格编辑器（v2.7）：
//   1. 横向滚动：容器 overflow-x-auto + 触控滑动；「冻结首列」开关把首列 sticky left-0
//   2. 表头设置：首行可标记为表头（<th> 加粗居中背景）；切换实时反映到 Markdown 输出
//   3. 单元格对齐：每列左/中/右；输出 :--- / :---: / ---: 语法
//   4. 合并单元格：选中 → 菜单「向右/向下合并」；Markdown 不支持合并 → 自动转 HTML table 输出
//      编辑器识别 HTML td 的 colspan/rowspan 还原网格；可拆分
//   5. 行列操作：每行/列尽头 + 加按钮；行头/列头 ⋮ 菜单含 上移/下移 / 左移/右移 / 删除 / 复制
//   6. 单元格富文本：**加粗** / *斜体* / ==高亮== / `代码` / [文字](链接)；Shift+Enter 多行 → <br>
//   7. 批量操作：Shift+点选多单元格 → 批量清空 / 批量填充 / 批量设对齐
//   8. 导入兼容：粘贴 Markdown 表格 / HTML <table> 自动解析进网格
//   9. 排序：点表头列按该列升/降序（文本/数字自动判断），原序可恢复
//   10. 双向同步：parseRichTable ⇄ serializeRichTable；Markdown（无合并）或 HTML table（有合并 / 无表头）输出

/** 单元格对齐方式 */
type CellAlign = 'left' | 'center' | 'right'

/** 单元格 span 信息（colspan / rowspan） */
interface CellSpan {
  colspan: number
  rowspan: number
}

/**
 * 富表格网格：在原 TableGrid 基础上扩展对齐 / 表头开关 / 冻结首列 / 合并 span。
 * 序列化时若无 span 且 headerRow=true → Markdown 表格；否则 HTML <table>。
 */
interface RichTableGrid {
  /** 表头列名（每列） */
  head: string[]
  /** body 单元格文本（可能含 markdown inline / <br> / 显式 HTML） */
  rows: string[][]
  /** 每列对齐（长度与 head 同步） */
  aligns: CellAlign[]
  /** 首行是否作为表头（<th> 渲染） */
  headerRow: boolean
  /** 冻结首列（sticky left-0） */
  freezeFirstCol: boolean
  /**
   * 每个 body 单元格的 span（与 rows 同形状）；null 表示被同行 / 上方 cell 覆盖（不渲染）。
   * 默认 { colspan: 1, rowspan: 1 }。
   */
  spans: (CellSpan | null)[][]
}

const DEFAULT_SPAN: CellSpan = { colspan: 1, rowspan: 1 }

/** 生成 rowsCount×colsCount 的默认 span 矩阵（全部 1×1） */
function uniformSpans(rowsCount: number, colsCount: number): (CellSpan | null)[][] {
  return Array.from({ length: rowsCount }, () =>
    Array.from({ length: colsCount }, () => ({ ...DEFAULT_SPAN })),
  )
}

/** 生成 colsCount 个左对齐 */
function defaultAligns(colsCount: number): CellAlign[] {
  return Array.from({ length: Math.max(1, colsCount) }, () => 'left')
}

/** Markdown 分隔行 → 列对齐数组；非分隔行返回 null */
function parseAlignFromSeparator(line: string): CellAlign[] | null {
  const t = line.trim()
  if (!/^\|[\s:|-]+\|$/.test(t)) return null
  const parts = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim())
  const aligns: CellAlign[] = []
  for (const p of parts) {
    if (/^:.*:$/.test(p)) aligns.push('center')
    else if (/:$/.test(p)) aligns.push('right')
    else aligns.push('left')
  }
  return aligns
}

/** HTML 单元格文本转义（< > &） */
function escapeHtmlCell(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Markdown 单元格管道符转义 */
function escapeMdCell(s: string): string {
  return s.replace(/\|/g, '\\|')
}

/**
 * 单元格内 markdown inline → HTML 片段（用于 HTML 输出模式；保留 <br> 多行）。
 * 支持 ==高亮== / **加粗** / *斜体* / `代码` / [文字](链接) / 显式 <br>。
 */
function mdInlineToHtml(s: string): string {
  let t = escapeHtmlCell(s)
  t = t.replace(/==([^=]+)==/g, '<mark>$1</mark>')
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>')
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>')
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
  t = t.replace(/&lt;br\s*\/?&gt;/g, '<br/>')
  t = t.replace(/\n/g, '<br/>')
  return t
}

/** Markdown 表格源码 → RichTableGrid */
function parseMarkdownTable(src: string): RichTableGrid | null {
  const lines = src
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^\|.+\|$/.test(l))
  if (lines.length < 2) return null
  const splitRow = (l: string) =>
    l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  const head = splitRow(lines[0])
  let aligns = defaultAligns(head.length)
  let bodyStart = 1
  const sepAligns = parseAlignFromSeparator(lines[1])
  if (sepAligns) {
    aligns = sepAligns.slice(0, head.length)
    while (aligns.length < head.length) aligns.push('left')
    bodyStart = 2
  }
  const rows: string[][] = []
  for (let i = bodyStart; i < lines.length; i++) {
    if (/^\|[\s:|-]+\|$/.test(lines[i])) continue
    const cells = splitRow(lines[i])
    while (cells.length < head.length) cells.push('')
    rows.push(cells.slice(0, head.length))
  }
  return {
    head,
    rows,
    aligns,
    headerRow: true,
    freezeFirstCol: false,
    spans: uniformSpans(rows.length, head.length),
  }
}

/**
 * HTML <table> 源码 → RichTableGrid：识别 thead / th / td / colspan / rowspan。
 * 解析失败（无 <table> / 无行 / 无单元格）返回 null。
 */
function parseHtmlTable(src: string): RichTableGrid | null {
  if (!/<table[\s>]/i.test(src)) return null
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(src, 'text/html')
  } catch {
    return null
  }
  const tbl = doc.querySelector('table')
  if (!tbl) return null
  const allRows = Array.from(tbl.querySelectorAll('tr'))
  if (allRows.length === 0) return null
  // 确定最大列数（按 colspan 累加）
  let maxCols = 0
  for (const tr of allRows) {
    const cells = Array.from(tr.children).filter((c) => /^(td|th)$/i.test(c.tagName))
    let span = 0
    for (const c of cells) {
      span += Math.max(1, parseInt(c.getAttribute('colspan') ?? '1', 10) || 1)
    }
    if (span > maxCols) maxCols = span
  }
  if (maxCols === 0) return null

  // 表头检测：thead 存在 或 首行含 <th>
  let headerRow = false
  if (tbl.querySelector('thead')) headerRow = true
  else if (allRows[0]?.querySelector('th')) headerRow = true

  // 首行 → head（thead 内 / 或首行 th）
  const firstRowCells = Array.from(allRows[0].children).filter((c) =>
    /^(td|th)$/i.test(c.tagName),
  ) as HTMLElement[]
  const head: string[] = new Array(maxCols).fill('')
  let hIdx = 0
  for (const c of firstRowCells) {
    const cs = Math.max(1, parseInt(c.getAttribute('colspan') ?? '1', 10) || 1)
    const text = (c.textContent ?? '').trim()
    for (let k = 0; k < cs && hIdx < maxCols; k++, hIdx++) head[hIdx] = text
  }

  // 其余行 → rows + spans；同时跟踪上方 rowspan 覆盖
  const rows: string[][] = []
  const spans: (CellSpan | null)[][] = []
  const pendingRowsLeft: number[] = new Array(maxCols).fill(0)
  for (let r = 1; r < allRows.length; r++) {
    const cells = Array.from(allRows[r].children).filter((c) =>
      /^(td|th)$/i.test(c.tagName),
    ) as HTMLElement[]
    const rowTexts: string[] = new Array(maxCols).fill('')
    const rowSpans: (CellSpan | null)[] = new Array(maxCols).fill(null)
    let c = 0
    for (const cell of cells) {
      while (c < maxCols && pendingRowsLeft[c] > 0) c++
      if (c >= maxCols) break
      const cs = Math.max(1, parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1)
      const rs = Math.max(1, parseInt(cell.getAttribute('rowspan') ?? '1', 10) || 1)
      rowTexts[c] = (cell.textContent ?? '').trim()
      rowSpans[c] = { colspan: cs, rowspan: rs }
      // 同行右侧 colspan 覆盖
      for (let x = 1; x < cs && c + x < maxCols; x++) rowSpans[c + x] = null
      // 下方 rowspan 覆盖登记
      if (rs > 1) {
        for (let x = 0; x < cs && c + x < maxCols; x++) pendingRowsLeft[c + x] = rs - 1
      }
      c += cs
    }
    for (let x = 0; x < maxCols; x++) {
      if (pendingRowsLeft[x] > 0) pendingRowsLeft[x]--
    }
    rows.push(rowTexts)
    spans.push(rowSpans)
  }
  if (rows.length === 0) {
    rows.push(new Array(maxCols).fill(''))
    spans.push(Array.from({ length: maxCols }, () => ({ ...DEFAULT_SPAN })))
  }
  return {
    head,
    rows,
    aligns: defaultAligns(maxCols),
    headerRow,
    freezeFirstCol: false,
    spans,
  }
}

/** 源码 → RichTableGrid：优先 HTML <table>，否则 Markdown 表格 */
function parseRichTable(src: string): RichTableGrid | null {
  const t = (src || '').trim()
  if (!t) return null
  if (/^<table[\s>]/i.test(t)) {
    const ht = parseHtmlTable(t)
    if (ht) return ht
  }
  return parseMarkdownTable(t)
}

/** 是否含 colspan/rowspan > 1 */
function hasComplexSpans(g: RichTableGrid): boolean {
  for (const row of g.spans) {
    for (const s of row) {
      if (s && (s.colspan > 1 || s.rowspan > 1)) return true
    }
  }
  return false
}

/** 序列化为 Markdown 表格（仅在无 span 且 headerRow=true 时可用） */
function serializeRichAsMarkdown(g: RichTableGrid): string {
  const n = Math.max(g.head.length, 1)
  const head = g.head.slice(0, n)
  while (head.length < n) head.push('')
  const esc = escapeMdCell
  const sep = Array.from({ length: n }, (_, i) => {
    const a = g.aligns[i] ?? 'left'
    if (a === 'center') return ':---:'
    if (a === 'right') return '---:'
    return '---'
  })
  const lines = [
    `| ${head.map(esc).join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...g.rows.map((r) => {
      const cells = r.slice(0, n)
      while (cells.length < n) cells.push('')
      return `| ${cells.map(esc).join(' | ')} |`
    }),
  ]
  return lines.join('\n')
}

/** 序列化为 HTML <table>（带 colspan/rowspan，可选 thead） */
function serializeRichAsHtml(g: RichTableGrid): string {
  const n = Math.max(g.head.length, 1)
  const head = g.head.slice(0, n)
  while (head.length < n) head.push('')
  const lines: string[] = ['<table>']
  if (g.headerRow) {
    lines.push('  <thead>', '    <tr>')
    for (let i = 0; i < n; i++) lines.push(`      <th>${mdInlineToHtml(head[i])}</th>`)
    lines.push('    </tr>', '  </thead>', '  <tbody>')
  } else {
    lines.push('  <tbody>', '    <tr>')
    for (let i = 0; i < n; i++) lines.push(`      <td>${mdInlineToHtml(head[i])}</td>`)
    lines.push('    </tr>')
  }
  for (let r = 0; r < g.rows.length; r++) {
    lines.push('    <tr>')
    for (let c = 0; c < n; c++) {
      const s = g.spans[r]?.[c]
      if (!s) continue
      const text = mdInlineToHtml(g.rows[r][c] ?? '')
      const csAttr = s.colspan > 1 ? ` colspan="${s.colspan}"` : ''
      const rsAttr = s.rowspan > 1 ? ` rowspan="${s.rowspan}"` : ''
      lines.push(`      <td${csAttr}${rsAttr}>${text}</td>`)
    }
    lines.push('    </tr>')
  }
  lines.push('  </tbody>', '</table>')
  return lines.join('\n')
}

/** 序列化：无合并 + 表头 → Markdown；否则 HTML table */
function serializeRichTable(g: RichTableGrid): string {
  if (g.headerRow && !hasComplexSpans(g)) return serializeRichAsMarkdown(g)
  return serializeRichAsHtml(g)
}

/** 单元格选中状态："r,c" 字符串集合 */
type CellSel = Set<string>

/** 把 r,c 编码为选中 key */
const cellKey = (r: number, c: number) => `${r},${c}`

/** 把 "r,c" 解码 */
function parseCellKey(k: string): [number, number] | null {
  const [r, c] = k.split(',').map((n) => parseInt(n, 10))
  if (Number.isNaN(r) || Number.isNaN(c)) return null
  return [r, c]
}

/** 把选中 key 集合展开成 r,c 数组 */
function expandSel(sel: CellSel): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const k of sel) {
    const p = parseCellKey(k)
    if (p) out.push(p)
  }
  return out
}

/** 把选中范围扩展为矩形（取 min/max 包络） */
function selRect(sel: CellSel): { r0: number; r1: number; c0: number; c1: number } | null {
  const pts = expandSel(sel)
  if (pts.length === 0) return null
  let r0 = pts[0][0], r1 = pts[0][0], c0 = pts[0][1], c1 = pts[0][1]
  for (const [r, c] of pts) {
    r0 = Math.min(r0, r)
    r1 = Math.max(r1, r)
    c0 = Math.min(c0, c)
    c1 = Math.max(c1, c)
  }
  return { r0, r1, c0, c1 }
}

/** 文本 → 数字判断（用于排序：纯数字列按数字排序） */
function isNumericCol(values: string[]): boolean {
  let cnt = 0
  for (const v of values) {
    if (v.trim() === '') continue
    if (!Number.isNaN(Number(v.replace(/[,，%]/g, '')))) cnt++
  }
  return cnt >= Math.max(1, values.filter((v) => v.trim()).length)
}

/** 单元格内 markdown inline → 安全 HTML 片段（用于编辑器内只读渲染预览） */
function renderCellPreview(s: string): string {
  return mdInlineToHtml(s)
}

/**
 * 完整表格可视化编辑器：横向滚动 + 冻结首列 + 表头 + 列对齐 + 合并 +
 *   行列增删移复制 + 单元格富文本工具条 + 批量操作 + 粘贴导入 + 排序。
 */
function TableGridEditor({
  grid,
  onChange,
}: {
  grid: RichTableGrid
  onChange: (g: RichTableGrid) => void
}) {
  const cols = Math.max(grid.head.length, 1)
  const rows = grid.rows
  const [sel, setSel] = React.useState<CellSel>(new Set())
  const [anchor, setAnchor] = React.useState<[number, number] | null>(null)
  const [editing, setEditing] = React.useState<[number, number] | null>(null)
  const [pasteOpen, setPasteOpen] = React.useState(false)
  const [pasteText, setPasteText] = React.useState('')
  /** 排序状态：{ col, dir: 'asc'|'desc'|null }；null = 恢复原序 */
  const [sortState, setSortState] = React.useState<{
    col: number
    dir: 'asc' | 'desc' | null
  } | null>(null)
  /** 行序：当 sortState.dir=null 时按 grid.rows 原序；排序时用映射 */
  const [rowOrder, setRowOrder] = React.useState<number[] | null>(null)
  const editRef = React.useRef<HTMLTextAreaElement | null>(null)

  // 行/列数变化时清空选中 / 编辑态，避免越界
  React.useEffect(() => {
    setSel(new Set())
    setAnchor(null)
    setEditing(null)
  }, [rows.length, cols])

  // 编辑态进入时聚焦 textarea
  React.useEffect(() => {
    if (editing) {
      requestAnimationFrame(() => {
        editRef.current?.focus()
        const len = editRef.current?.value.length ?? 0
        editRef.current?.setSelectionRange(len, len)
      })
    }
  }, [editing])

  /** 当前显示行序（null = 原序 0..n-1；非空 = 按映射） */
  const displayRows: number[] =
    rowOrder && sortState?.dir !== null ? rowOrder : rows.map((_, i) => i)

  /** 不可变更新（带 span/aligns/head 同步） */
  const update = (next: RichTableGrid) => {
    onChange(next)
  }

  const setCellText = (ri: number, ci: number, v: string) => {
    update({
      ...grid,
      rows: grid.rows.map((r, i) => (i === ri ? r.map((c, j) => (j === ci ? v : c)) : r)),
    })
  }

  const setHead = (ci: number, v: string) => {
    update({ ...grid, head: grid.head.map((c, i) => (i === ci ? v : c)) })
  }

  const setAlign = (ci: number, a: CellAlign) => {
    update({ ...grid, aligns: grid.aligns.map((x, i) => (i === ci ? a : x)) })
  }

  const addRowAt = (ri: number, dir: 0 | 1 = 1) => {
    const idx = dir === 1 ? ri + 1 : ri
    const newRow = grid.head.map(() => '')
    const newSpan: CellSpan = { ...DEFAULT_SPAN }
    update({
      ...grid,
      rows: [...grid.rows.slice(0, idx), newRow, ...grid.rows.slice(idx)],
      spans: [
        ...grid.spans.slice(0, idx),
        Array.from({ length: cols }, () => ({ ...newSpan })),
        ...grid.spans.slice(idx),
      ],
    })
  }

  const addColAt = (ci: number, dir: 0 | 1 = 1) => {
    const idx = dir === 1 ? ci + 1 : ci
    update({
      ...grid,
      head: [...grid.head.slice(0, idx), '新列', ...grid.head.slice(idx)],
      aligns: [...grid.aligns.slice(0, idx), 'left', ...grid.aligns.slice(idx)],
      rows: grid.rows.map((r) => [...r.slice(0, idx), '', ...r.slice(idx)]),
      spans: grid.spans.map((row) => [
        ...row.slice(0, idx),
        { ...DEFAULT_SPAN },
        ...row.slice(idx),
      ]),
    })
  }

  const delRow = (ri: number) => {
    if (grid.rows.length <= 1) {
      toast.warning('至少保留 1 行')
      return
    }
    update({
      ...grid,
      rows: grid.rows.filter((_, i) => i !== ri),
      spans: grid.spans.filter((_, i) => i !== ri),
    })
  }

  const delCol = (ci: number) => {
    if (cols <= 1) {
      toast.warning('至少保留 1 列')
      return
    }
    update({
      ...grid,
      head: grid.head.filter((_, i) => i !== ci),
      aligns: grid.aligns.filter((_, i) => i !== ci),
      rows: grid.rows.map((r) => r.filter((_, i) => i !== ci)),
      spans: grid.spans.map((row) => row.filter((_, i) => i !== ci)),
    })
  }

  const moveRow = (ri: number, dir: -1 | 1) => {
    const j = ri + dir
    if (j < 0 || j >= grid.rows.length) return
    const rows = [...grid.rows]
    const spans = [...grid.spans]
    ;[rows[ri], rows[j]] = [rows[j], rows[ri]]
    ;[spans[ri], spans[j]] = [spans[j], spans[ri]]
    update({ ...grid, rows, spans })
  }

  const moveCol = (ci: number, dir: -1 | 1) => {
    const j = ci + dir
    if (j < 0 || j >= cols) return
    const head = [...grid.head]
    const aligns = [...grid.aligns]
    ;[head[ci], head[j]] = [head[j], head[ci]]
    ;[aligns[ci], aligns[j]] = [aligns[j], aligns[ci]]
    const rows = grid.rows.map((r) => {
      const x = [...r]
      ;[x[ci], x[j]] = [x[j], x[ci]]
      return x
    })
    const spans = grid.spans.map((row) => {
      const x = [...row]
      ;[x[ci], x[j]] = [x[j], x[ci]]
      return x
    })
    update({ ...grid, head, aligns, rows, spans })
  }

  const copyRow = (ri: number) => {
    const r = grid.rows[ri]
    const s = grid.spans[ri]
    update({
      ...grid,
      rows: [...grid.rows, [...r]],
      spans: [...grid.spans, s.map((c) => (c ? { ...c } : null))],
    })
    toast.success('已复制行到末尾')
  }

  const copyCol = (ci: number) => {
    update({
      ...grid,
      head: [...grid.head, `${grid.head[ci] ?? ''} 副本`],
      aligns: [...grid.aligns, grid.aligns[ci] ?? 'left'],
      rows: grid.rows.map((r) => [...r, r[ci] ?? '']),
      spans: grid.spans.map((row) => [...row, row[ci] ? { ...row[ci]! } : { ...DEFAULT_SPAN }]),
    })
    toast.success('已复制列到末尾')
  }

  /** 向右合并：把 (r,c) 与 (r,c+1) 合并（要求 c+1<cols 且 (r,c+1) 的 span 非 null） */
  const mergeRight = (r: number, c: number) => {
    if (c + 1 >= cols) {
      toast.warning('已是最右列')
      return
    }
    const span = grid.spans[r]?.[c]
    const right = grid.spans[r]?.[c + 1]
    if (!span || !right) {
      toast.warning('相邻单元格已被合并覆盖，无法继续合并')
      return
    }
    const nextSpans = grid.spans.map((row, ri) =>
      ri === r
        ? row.map((s, ci) => {
            if (ci === c) return { colspan: span.colspan + right.colspan, rowspan: span.rowspan }
            if (ci >= c + 1 && ci < c + 1 + right.colspan) return null
            return s
          })
        : row.slice(),
    )
    const nextRows = grid.rows.map((row, ri) =>
      ri === r
        ? row.map((v, ci) =>
            ci === c
              ? (grid.rows[r][c] + ' ' + grid.rows[r][c + 1]).trim()
              : ci === c + 1
                ? ''
                : v,
          )
        : row.slice(),
    )
    update({ ...grid, rows: nextRows, spans: nextSpans })
  }

  /** 向下合并 */
  const mergeDown = (r: number, c: number) => {
    if (r + 1 >= grid.rows.length) {
      toast.warning('已是最下行')
      return
    }
    const span = grid.spans[r]?.[c]
    const below = grid.spans[r + 1]?.[c]
    if (!span || !below) {
      toast.warning('下方单元格已被合并覆盖，无法继续合并')
      return
    }
    const nextSpans = grid.spans.map((row, ri) => {
      if (ri === r) {
        return row.map((s, ci) =>
          ci === c ? { colspan: span.colspan, rowspan: span.rowspan + below.rowspan } : s,
        )
      }
      if (ri >= r + 1 && ri < r + 1 + below.rowspan) {
        return row.map((s, ci) =>
          ci >= c && ci < c + span.colspan ? null : s,
        )
      }
      return row.slice()
    })
    const nextRows = grid.rows.map((row, ri) =>
      ri === r
        ? row.map((v, ci) =>
            ci === c
              ? (grid.rows[r][c] + ' ' + grid.rows[r + 1][c]).trim()
              : v,
          )
        : ri === r + 1
          ? row.map((v, ci) => (ci === c ? '' : v))
          : row.slice(),
    )
    update({ ...grid, rows: nextRows, spans: nextSpans })
  }

  /** 拆分本单元格：colspan/rowspan 全恢复 1×1，被覆盖的单元格复原默认 span */
  const splitCell = (r: number, c: number) => {
    const span = grid.spans[r]?.[c]
    if (!span || (span.colspan <= 1 && span.rowspan <= 1)) {
      toast.info('当前单元格未合并')
      return
    }
    const nextSpans = grid.spans.map((row) => row.map((s) => (s ? { ...s } : null)))
    // 主单元格 → 1×1
    nextSpans[r][c] = { ...DEFAULT_SPAN }
    // 还原被它覆盖的同行右侧 / 下方行
    for (let dr = 0; dr < span.rowspan; dr++) {
      for (let dc = 0; dc < span.colspan; dc++) {
        if (dr === 0 && dc === 0) continue
        const rr = r + dr
        const cc = c + dc
        if (rr < nextSpans.length && cc < cols) {
          nextSpans[rr][cc] = { ...DEFAULT_SPAN }
        }
      }
    }
    update({ ...grid, spans: nextSpans })
  }

  /** 单元格富文本工具条：包裹选区 */
  const wrapSelection = (left: string, right: string = left) => {
    if (!editing) return
    const [r, c] = editing
    const el = editRef.current
    const val = grid.rows[r]?.[c] ?? ''
    if (!el) {
      setCellText(r, c, left + val + right)
      return
    }
    const start = el.selectionStart ?? val.length
    const end = el.selectionEnd ?? start
    const selText = val.slice(start, end)
    const next =
      val.slice(0, start) +
      left +
      (selText || '文字') +
      right +
      val.slice(end)
    setCellText(r, c, next)
    requestAnimationFrame(() => {
      el.focus()
      const s = start + left.length
      el.setSelectionRange(s, s + (selText || '文字').length)
    })
  }

  const insertLink = () => {
    if (!editing) return
    const [r, c] = editing
    const el = editRef.current
    const val = grid.rows[r]?.[c] ?? ''
    const start = el?.selectionStart ?? val.length
    const end = el?.selectionEnd ?? start
    const selText = val.slice(start, end) || '链接文字'
    const next = val.slice(0, start) + `[${selText}](https://)` + val.slice(end)
    setCellText(r, c, next)
  }

  /** 批量：清空选中 */
  const batchClear = () => {
    if (sel.size === 0) {
      toast.info('请先选中单元格（Shift+点选多格）')
      return
    }
    const pts = expandSel(sel)
    const rows = grid.rows.map((row) => row.slice())
    for (const [r, c] of pts) {
      if (rows[r]) rows[r][c] = ''
    }
    update({ ...grid, rows })
    toast.success(`已清空 ${pts.length} 个单元格`)
  }

  /** 批量：填充选中（prompt 输入） */
  const batchFill = () => {
    if (sel.size === 0) {
      toast.info('请先选中单元格（Shift+点选多格）')
      return
    }
    const v = window.prompt('输入要批量填充的内容')
    if (v == null) return
    const pts = expandSel(sel)
    const rows = grid.rows.map((row) => row.slice())
    for (const [r, c] of pts) {
      if (rows[r]) rows[r][c] = v
    }
    update({ ...grid, rows })
    toast.success(`已填充 ${pts.length} 个单元格`)
  }

  /** 批量：设对齐（取选中涉及的列统一对齐） */
  const batchAlign = (a: CellAlign) => {
    if (sel.size === 0) {
      toast.info('请先选中单元格（Shift+点选多格）')
      return
    }
    const rect = selRect(sel)
    if (!rect) return
    const aligns = grid.aligns.slice()
    for (let c = rect.c0; c <= rect.c1; c++) aligns[c] = a
    update({ ...grid, aligns })
    toast.success(`已对选中列设为「${a === 'left' ? '左' : a === 'center' ? '中' : '右'}对齐」`)
  }

  /** 排序：点表头列循环 升序 → 降序 → 取消（原序） */
  const sortCol = (ci: number) => {
    if (sortState?.col === ci && sortState.dir === 'asc') {
      setSortState({ col: ci, dir: 'desc' })
    } else if (sortState?.col === ci && sortState.dir === 'desc') {
      setSortState(null)
      setRowOrder(null)
      return
    } else {
      setSortState({ col: ci, dir: 'asc' })
    }
    const dir = sortState?.col === ci ? (sortState.dir === 'asc' ? 'desc' : 'asc') : 'asc'
    const values = grid.rows.map((r) => r[ci] ?? '')
    const numeric = isNumericCol(values)
    const idxs = grid.rows.map((_, i) => i)
    idxs.sort((a, b) => {
      const va = grid.rows[a][ci] ?? ''
      const vb = grid.rows[b][ci] ?? ''
      let cmp: number
      if (numeric) {
        const na = Number(va.replace(/[,，%]/g, '')) || 0
        const nb = Number(vb.replace(/[,，%]/g, '')) || 0
        cmp = na - nb
      } else {
        cmp = va.localeCompare(vb, 'zh-Hans-CN')
      }
      return dir === 'asc' ? cmp : -cmp
    })
    setRowOrder(idxs)
  }

  /** 粘贴导入：尝试 parseRichTable，成功替换 */
  const applyPaste = () => {
    const g = parseRichTable(pasteText)
    if (!g) {
      toast.error('未识别出 Markdown 表格或 HTML <table>')
      return
    }
    update(g)
    setPasteOpen(false)
    setPasteText('')
    toast.success('已导入表格')
  }

  /** 单元格点击：单选 / Shift 范围选 */
  const onCellClick = (r: number, c: number, e: React.MouseEvent) => {
    // 点在按钮 / 菜单触发上不触发选中
    const tgt = e.target as HTMLElement | null
    if (tgt && tgt.closest('button, a, input, textarea, [role="menuitem"]')) return
    if (e.shiftKey && anchor) {
      const next = new Set<string>()
      const r0 = Math.min(anchor[0], r)
      const r1 = Math.max(anchor[0], r)
      const c0 = Math.min(anchor[1], c)
      const c1 = Math.max(anchor[1], c)
      for (let rr = r0; rr <= r1; rr++) {
        for (let cc = c0; cc <= c1; cc++) {
          // 跳过被合并覆盖的单元格
          if (grid.spans[rr]?.[cc] !== null && grid.spans[rr]?.[cc] !== undefined) {
            next.add(cellKey(rr, cc))
          }
        }
      }
      setSel(next)
      setEditing(null)
    } else {
      setSel(new Set([cellKey(r, c)]))
      setAnchor([r, c])
      setEditing([r, c])
    }
  }

  // 顶部工具条
  return (
    <div className="flex flex-col gap-2">
      {/* 工具条：表头开关 / 冻结首列 / 粘贴导入 / 批量操作 / 排序状态 */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-muted/40 px-2.5 py-2 text-xs">
        <label className="flex items-center gap-1.5">
          <Switch
            checked={grid.headerRow}
            onCheckedChange={(v) => update({ ...grid, headerRow: v })}
            aria-label="表头行开关"
            className="scale-90"
          />
          <span className="text-muted-foreground">表头行</span>
        </label>
        <label className="flex items-center gap-1.5">
          <Switch
            checked={grid.freezeFirstCol}
            onCheckedChange={(v) => update({ ...grid, freezeFirstCol: v })}
            aria-label="冻结首列开关"
            className="scale-90"
          />
          <Pin className="size-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">冻结首列</span>
        </label>
        <Button
          variant="outline"
          size="sm"
          className="h-8 rounded-full text-xs"
          onClick={() => setPasteOpen((v) => !v)}
        >
          <ClipboardPaste className="size-3.5" /> 粘贴导入
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 rounded-full text-xs"
          onClick={batchClear}
          disabled={sel.size === 0}
        >
          <Eraser className="size-3.5" /> 批量清空
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 rounded-full text-xs"
          onClick={batchFill}
          disabled={sel.size === 0}
        >
          <Type className="size-3.5" /> 批量填充
        </Button>
        <div className="flex items-center gap-0.5 rounded-full border border-border bg-background p-0.5">
          {(['left', 'center', 'right'] as CellAlign[]).map((a) => {
            const Icon = a === 'center' ? AlignCenter : a === 'right' ? AlignRight : AlignLeft
            return (
              <button
                key={a}
                type="button"
                aria-label={`批量${a === 'left' ? '左' : a === 'center' ? '居中' : '右'}对齐`}
                onClick={() => batchAlign(a)}
                disabled={sel.size === 0}
                className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted disabled:opacity-40"
              >
                <Icon className="size-3.5" />
              </button>
            )
          })}
        </div>
        {sortState && sortState.dir !== null && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-900 dark:bg-amber-500/20 dark:text-amber-300">
            按「{grid.head[sortState.col] || `第${sortState.col + 1}列`}」
            {sortState.dir === 'asc' ? '升序' : '降序'} · 点表头取消
          </span>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {rows.length} 行 × {cols} 列
          {hasComplexSpans(grid) ? ' · 含合并（HTML 输出）' : ''}
        </span>
      </div>

      {/* 粘贴导入面板 */}
      {pasteOpen && (
        <div className="rounded-xl border border-border bg-muted/30 p-2.5">
          <p className="text-[11px] text-muted-foreground">
            粘贴 Markdown 表格或 HTML &lt;table&gt; 源码，点「导入」替换当前网格。
          </p>
          <Textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={'| 列1 | 列2 |\n| --- | --- |\n| 值1 | 值2 |'}
            className="mt-1.5 min-h-24 resize-none rounded-lg bg-background font-mono text-xs"
          />
          <div className="mt-1.5 flex gap-2">
            <Button size="sm" className="h-7 rounded-full text-xs" onClick={applyPaste}>
              <Check className="size-3.5" /> 导入
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 rounded-full text-xs"
              onClick={() => {
                setPasteOpen(false)
                setPasteText('')
              }}
            >
              取消
            </Button>
          </div>
        </div>
      )}

      {/* 富文本工具条（仅编辑态显示） */}
      {editing && (
        <div className="flex flex-wrap items-center gap-1 rounded-full border border-border bg-background px-1.5 py-1 text-xs shadow-sm">
          <span className="px-1 text-[11px] text-muted-foreground">
            单元格 {editing[0] + 1}-{editing[1] + 1}
          </span>
          <button
            type="button"
            aria-label="加粗"
            onClick={() => wrapSelection('**')}
            className="rounded p-1.5 text-muted-foreground hover:bg-muted"
          >
            <Bold className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="斜体"
            onClick={() => wrapSelection('*')}
            className="rounded p-1.5 text-muted-foreground hover:bg-muted"
          >
            <Italic className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="高亮"
            onClick={() => wrapSelection('==')}
            className="rounded p-1.5 text-muted-foreground hover:bg-muted"
          >
            <Highlighter className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="行内代码"
            onClick={() => wrapSelection('`')}
            className="rounded p-1.5 text-muted-foreground hover:bg-muted"
          >
            <Code2 className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="链接"
            onClick={insertLink}
            className="rounded p-1.5 text-muted-foreground hover:bg-muted"
          >
            <LinkIcon className="size-3.5" />
          </button>
          <span className="px-1 text-[10px] text-muted-foreground/70">
            Shift+Enter 换行（输出 &lt;br&gt;）
          </span>
        </div>
      )}

      {/* 表格：横向滚动 + 冻结首列 */}
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className={cn(grid.headerRow ? 'bg-muted/70' : 'bg-muted/40')}>
              {/* 行号列（固定左上角） */}
              <th
                className="sticky left-0 z-20 w-9 min-w-9 border-b border-r border-border bg-muted/70 p-1 text-center text-[10px] font-semibold text-muted-foreground"
                aria-label="列菜单"
              >
                #
              </th>
              {grid.head.map((h, ci) => {
                const isFrozen = grid.freezeFirstCol && ci === 0
                const isSorted = sortState?.col === ci && sortState.dir !== null
                return (
                  <th
                    key={ci}
                    className={cn(
                      'min-w-28 border-b border-r border-border p-1',
                      isFrozen && 'sticky z-10',
                      isFrozen && (ci === 0 ? 'left-9' : 'left-0'),
                      grid.headerRow ? 'bg-muted/70' : 'bg-muted/40',
                    )}
                  >
                    <div className="flex items-center gap-0.5">
                      <Input
                        value={h}
                        aria-label={`表头 ${ci + 1}`}
                        onChange={(e) => setHead(ci, e.target.value)}
                        className="h-8 min-w-0 flex-1 border-0 bg-transparent px-1.5 text-xs font-semibold focus-visible:ring-1"
                      />
                      {/* 排序按钮 */}
                      <button
                        type="button"
                        aria-label={`按第 ${ci + 1} 列排序`}
                        onClick={() => sortCol(ci)}
                        className={cn(
                          'shrink-0 rounded p-1 text-muted-foreground hover:bg-muted',
                          isSorted && 'bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-300',
                        )}
                      >
                        <ArrowUpDown className="size-3.5" />
                      </button>
                      {/* 列 ⋮ 菜单 */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={`列 ${ci + 1} 菜单`}
                            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted"
                          >
                            <MoreVertical className="size-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuLabel className="text-xs text-muted-foreground">
                            第 {ci + 1} 列
                          </DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => moveCol(ci, -1)}
                            disabled={ci === 0}
                          >
                            <ArrowLeft className="size-3.5" /> 左移
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => moveCol(ci, 1)}
                            disabled={ci === cols - 1}
                          >
                            <ArrowRight className="size-3.5" /> 右移
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => copyCol(ci)}>
                            <Copy className="size-3.5" /> 复制列
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuLabel className="text-xs text-muted-foreground">
                            对齐
                          </DropdownMenuLabel>
                          {(['left', 'center', 'right'] as CellAlign[]).map((a) => {
                            const AIcon = a === 'center' ? AlignCenter : a === 'right' ? AlignRight : AlignLeft
                            return (
                              <DropdownMenuItem
                                key={a}
                                onClick={() => setAlign(ci, a)}
                                className={cn(grid.aligns[ci] === a && 'bg-accent')}
                              >
                                <AIcon className="size-3.5" />{' '}
                                {a === 'left' ? '左对齐' : a === 'center' ? '居中' : '右对齐'}
                              </DropdownMenuItem>
                            )
                          })}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => delCol(ci)}
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2 className="size-3.5" /> 删除列
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      {/* 加列按钮 */}
                      <button
                        type="button"
                        aria-label="右侧加列"
                        onClick={() => addColAt(ci, 1)}
                        className="shrink-0 rounded p-1 text-emerald-600 hover:bg-emerald-500/10"
                      >
                        <Plus className="size-3.5" />
                      </button>
                    </div>
                  </th>
                )
              })}
              {/* 末尾加列按钮 */}
              <th className="sticky right-0 z-10 w-9 border-b border-border bg-muted/70 p-1">
                <button
                  type="button"
                  aria-label="末尾加列"
                  onClick={() => addColAt(cols - 1, 1)}
                  className="flex size-7 items-center justify-center rounded-full text-emerald-600 hover:bg-emerald-500/10"
                >
                  <Plus className="size-4" />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((rIdx, displayIdx) => {
              const row = grid.rows[rIdx]
              const spanRow = grid.spans[rIdx] ?? []
              return (
                <tr key={rIdx} className="group">
                  {/* 行号 + 行 ⋮ 菜单 */}
                  <td
                    className={cn(
                      'sticky left-0 z-10 w-9 border-b border-r border-border bg-muted/30 p-1 text-center align-middle',
                    )}
                  >
                    <div className="flex items-center justify-center gap-0.5">
                      <span className="text-[10px] text-muted-foreground">{rIdx + 1}</span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={`行 ${rIdx + 1} 菜单`}
                            className="rounded p-0.5 text-muted-foreground/70 hover:bg-muted hover:text-foreground"
                          >
                            <MoreVertical className="size-3" />
                          </button>
                        </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-44">
                        <DropdownMenuLabel className="text-xs text-muted-foreground">
                          第 {rIdx + 1} 行
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => moveRow(rIdx, -1)}
                          disabled={rIdx === 0}
                        >
                          <ArrowUp className="size-3.5" /> 上移
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => moveRow(rIdx, 1)}
                          disabled={rIdx === grid.rows.length - 1}
                        >
                          <ArrowDown className="size-3.5" /> 下移
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => copyRow(rIdx)}>
                          <Copy className="size-3.5" /> 复制行
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => addRowAt(rIdx, 0)}
                        >
                          <Plus className="size-3.5" /> 上方加行
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => addRowAt(rIdx, 1)}>
                          <Plus className="size-3.5" /> 下方加行
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => delRow(rIdx)}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="size-3.5" /> 删除行
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    </div>
                  </td>
                  {grid.head.map((_, ci) => {
                    const span = spanRow[ci]
                    const isFrozen = grid.freezeFirstCol && ci === 0
                    const isEditing = editing && editing[0] === rIdx && editing[1] === ci
                    const isSelected = sel.has(cellKey(rIdx, ci))
                    // 被覆盖的单元格不渲染（colspan/rowspan 占位）
                    if (!span) {
                      return (
                        <td
                          key={ci}
                          className={cn(
                            'border-b border-r border-border/50 p-0',
                            isFrozen && 'sticky z-10',
                            isFrozen && (ci === 0 ? 'left-9' : 'left-0'),
                          )}
                          aria-hidden
                        />
                      )
                    }
                    return (
                      <td
                        key={ci}
                        colSpan={span.colspan > 1 ? span.colspan : undefined}
                        rowSpan={span.rowspan > 1 ? span.rowspan : undefined}
                        className={cn(
                          'relative border-b border-r border-border/50 p-0 align-top',
                          isFrozen && 'sticky z-10',
                          isFrozen && (ci === 0 ? 'left-9' : 'left-0'),
                          isSelected
                            ? 'bg-primary/10 ring-1 ring-inset ring-primary/40'
                            : 'hover:bg-muted/30',
                        )}
                        onClick={(e) => onCellClick(rIdx, ci, e)}
                      >
                        {isEditing ? (
                          <textarea
                            ref={editRef}
                            value={grid.rows[rIdx][ci] ?? ''}
                            onChange={(e) => setCellText(rIdx, ci, e.target.value)}
                            onBlur={() => setEditing(null)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault()
                                setEditing(null)
                              }
                              if (e.key === 'Escape') {
                                e.preventDefault()
                                setEditing(null)
                              }
                            }}
                            aria-label={`单元格 ${rIdx + 1}-${ci + 1}`}
                            rows={1}
                            className={cn(
                              'block w-full resize-y bg-transparent px-2 py-1.5 text-xs outline-none',
                              grid.headerRow && rIdx === -1 && 'font-semibold',
                            )}
                          />
                        ) : (
                          <div
                            className={cn(
                              'min-h-9 cursor-text px-2 py-1.5 text-xs',
                              grid.aligns[ci] === 'center' && 'text-center',
                              grid.aligns[ci] === 'right' && 'text-right',
                              span.colspan > 1 || span.rowspan > 1
                                ? 'bg-emerald-50/40 dark:bg-emerald-500/5'
                                : '',
                            )}
                            // 单元格内 markdown inline 渲染（只读预览，编辑时切 textarea）
                            dangerouslySetInnerHTML={{
                              __html:
                                renderCellPreview(grid.rows[rIdx][ci] ?? '') ||
                                '<span class="text-muted-foreground/40">点击编辑</span>',
                            }}
                          />
                        )}
                        {/* 单元格 ⋮ 菜单（右上角） */}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              aria-label={`单元格 ${rIdx + 1}-${ci + 1} 菜单`}
                              className="absolute right-0.5 top-0.5 rounded p-0.5 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/60 hover:bg-muted hover:text-foreground"
                            >
                              <MoreVertical className="size-3" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuLabel className="text-xs text-muted-foreground">
                              单元格 {rIdx + 1}-{ci + 1}
                            </DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => mergeRight(rIdx, ci)}
                              disabled={ci >= cols - 1}
                            >
                              <Combine className="size-3.5" /> 向右合并
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => mergeDown(rIdx, ci)}
                              disabled={rIdx >= grid.rows.length - 1}
                            >
                              <Combine className="size-3.5 rotate-90" /> 向下合并
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => splitCell(rIdx, ci)}
                              disabled={!span || (span.colspan <= 1 && span.rowspan <= 1)}
                            >
                              <Split className="size-3.5" /> 拆分单元格
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => {
                                setEditing([rIdx, ci])
                                setSel(new Set([cellKey(rIdx, ci)]))
                              }}
                            >
                              <Pencil className="size-3.5" /> 编辑内容
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => {
                                setCellText(rIdx, ci, '')
                                toast.success('已清空')
                              }}
                            >
                              <Eraser className="size-3.5" /> 清空内容
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() =>
                                void navigator.clipboard
                                  .writeText(grid.rows[rIdx][ci] ?? '')
                                  .then(() => toast.success('单元格已复制'))
                                  .catch(() => toast.error('复制失败'))
                              }
                            >
                              <Copy className="size-3.5" /> 复制单元格
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    )
                  })}
                  {/* 末尾加行按钮（仅在该行显示） */}
                  {displayIdx === 0 && (
                    <td
                      rowSpan={displayRows.length}
                      className="sticky right-0 z-10 w-9 border-b border-border bg-muted/30 p-1 align-top"
                    >
                      <button
                        type="button"
                        aria-label="末尾加行"
                        onClick={() => addRowAt(grid.rows.length - 1, 1)}
                        className="flex size-7 items-center justify-center rounded-full text-emerald-600 hover:bg-emerald-500/10"
                      >
                        <Plus className="size-4" />
                      </button>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* 底部加行 / 选中提示 */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-8 rounded-full text-xs"
          onClick={() => addRowAt(grid.rows.length - 1, 1)}
        >
          <Plus className="size-3.5" /> 加行
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 rounded-full text-xs"
          onClick={() => addColAt(cols - 1, 1)}
        >
          <Plus className="size-3.5" /> 加列
        </Button>
        {sel.size > 0 && (
          <span className="text-[11px] text-muted-foreground">
            已选 {sel.size} 格 · Shift+点选多格 · 点 ⋮ 单元格菜单
          </span>
        )}
      </div>
    </div>
  )
}

// ---------- 公式编辑器 ----------

const SYMBOLS: { label: string; insert: string }[] = [
  { label: 'x²', insert: 'x^2' },
  { label: 'xᵢ', insert: 'x_i' },
  { label: 'a/b', insert: '\\frac{a}{b}' },
  { label: '√x', insert: '\\sqrt{x}' },
  { label: '∑', insert: '\\sum_{i=1}^{n}' },
  { label: '∫', insert: '\\int_0^1' },
  { label: '×', insert: '\\times' },
  { label: '÷', insert: '\\div' },
  { label: '±', insert: '\\pm' },
  { label: '≤', insert: '\\leq' },
  { label: '≥', insert: '\\geq' },
  { label: '≠', insert: '\\neq' },
  { label: '∞', insert: '\\infty' },
  { label: 'π', insert: '\\pi' },
  { label: 'θ', insert: '\\theta' },
  { label: 'α', insert: '\\alpha' },
  { label: 'β', insert: '\\beta' },
  { label: 'Δ', insert: '\\Delta' },
  { label: '→', insert: '\\to' },
  { label: '∈', insert: '\\in' },
  { label: '化学', insert: '\\ce{H2O}' },
]

/** 常用公式模板（多行环境：矩阵 / 分段函数 / 方程组 / 化学反应方程式等） */
const TEMPLATES: { label: string; insert: string; desc?: string }[] = [
  {
    label: '2×2 矩阵',
    insert: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
    desc: '圆括号矩阵',
  },
  {
    label: '3×3 矩阵',
    insert: '\\begin{pmatrix} a_{11} & a_{12} & a_{13} \\\\ a_{21} & a_{22} & a_{23} \\\\ a_{31} & a_{32} & a_{33} \\end{pmatrix}',
    desc: '圆括号矩阵',
  },
  {
    label: '方括号矩阵',
    insert: '\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}',
    desc: '中括号矩阵',
  },
  {
    label: '行列式',
    insert: '\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}',
    desc: '竖线行列式',
  },
  {
    label: '分段函数',
    insert: 'f(x) = \\begin{cases} x^2, & x > 0 \\\\ -x, & x \\le 0 \\end{cases}',
    desc: 'cases 分段',
  },
  {
    label: '方程组',
    insert: '\\begin{cases} 2x + y = 5 \\\\ x - y = 1 \\end{cases}',
    desc: 'cases 方程组',
  },
  {
    label: '多行对齐',
    insert: '\\begin{aligned} y &= (x+1)^2 \\\\ &= x^2 + 2x + 1 \\end{aligned}',
    desc: 'aligned 推导',
  },
  {
    label: '极限',
    insert: '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1',
  },
  {
    label: '化学反应',
    insert: '\\ce{2H2 + O2 -> 2H2O}',
    desc: 'mhchem 化学方程式',
  },
]

function FormulaEditor({
  src,
  onChange,
}: {
  src: string
  onChange: (s: string) => void
}) {
  const taRef = React.useRef<HTMLTextAreaElement>(null)
  const [preview, setPreview] = React.useState('')
  const [err, setErr] = React.useState('')

  React.useEffect(() => {
    try {
      setPreview(
        katex.renderToString(src || '\\text{（输入 LaTeX 公式）}', {
          displayMode: true,
          throwOnError: true,
          output: 'html',
        }),
      )
      setErr('')
    } catch (e) {
      setPreview('')
      setErr(e instanceof Error ? e.message : '公式语法错误')
    }
  }, [src])

  const insertSymbol = (ins: string) => {
    const el = taRef.current
    if (!el) {
      onChange(src + ins)
      return
    }
    const start = el.selectionStart ?? src.length
    const end = el.selectionEnd ?? start
    const next = src.slice(0, start) + ins + src.slice(end)
    onChange(next)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + ins.length, start + ins.length)
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex min-h-20 items-center justify-center overflow-x-auto rounded-xl bg-muted/50 p-3"
        aria-live="polite"
      >
        {err ? (
          <p className="text-xs text-destructive">公式语法错误：{err.slice(0, 120)}</p>
        ) : (
          <div
            className="katex-preview text-base"
            // KaTeX 输出（本项目 rich-content 同源渲染方式）
            dangerouslySetInnerHTML={{ __html: preview }}
          />
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {SYMBOLS.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => insertSymbol(s.insert)}
            className="shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-xs transition-colors hover:bg-muted"
          >
            {s.label}
          </button>
        ))}
      </div>
      {/* 模板（多行环境：矩阵 / 分段 / 方程组 / 化学反应） */}
      <div className="flex flex-wrap gap-1.5">
        {TEMPLATES.map((t) => (
          <button
            key={t.label}
            type="button"
            title={t.desc}
            onClick={() => insertSymbol(t.insert)}
            className="shrink-0 rounded-lg border border-emerald-400/60 bg-emerald-50/40 px-2.5 py-1.5 text-xs text-emerald-800 transition-colors hover:bg-emerald-100 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300"
          >
            {t.label}
          </button>
        ))}
      </div>
      <Textarea
        ref={taRef}
        value={src}
        onChange={(e) => onChange(e.target.value)}
        aria-label="LaTeX 源码"
        placeholder="输入 LaTeX，如 \frac{1}{2}mv^2"
        className="min-h-20 resize-none rounded-xl bg-muted/40 font-mono text-sm"
      />
    </div>
  )
}

// ---------- 思维导图树编辑器（不可变路径更新） ----------

/** 按路径定位节点并替换（不可变） */
function mapNode(
  root: MindNode,
  path: number[],
  fn: (n: MindNode) => MindNode,
): MindNode {
  if (path.length === 0) return fn(root)
  const [head, ...rest] = path
  return {
    ...root,
    children: root.children.map((c, i) => (i === head ? mapNode(c, rest, fn) : c)),
  }
}

/** 在父节点的 children 中按索引移动（不可变） */
function moveChild(n: MindNode, idx: number, dir: -1 | 1): MindNode {
  const j = idx + dir
  if (j < 0 || j >= n.children.length) return n
  const children = [...n.children]
  const [x] = children.splice(idx, 1)
  children.splice(j, 0, x)
  return { ...n, children }
}

function MindTreeItem({
  node,
  path,
  siblings,
  update,
}: {
  node: MindNode
  /** 从根到本节点的子索引路径（根 = []） */
  path: number[]
  /** 同级兄弟数量（根节点无父级 → 0，移动按钮禁用） */
  siblings: number
  /** 按路径不可变更新整树 */
  update: (path: number[], fn: (n: MindNode) => MindNode) => void
}) {
  const [open, setOpen] = React.useState(true)
  const parentPath = path.slice(0, -1)
  const myIndex = path[path.length - 1]
  const isRoot = path.length === 0

  return (
    <div className={cn(!isRoot && 'ml-4 border-l border-border pl-2')}>
      <div className="flex items-center gap-1 rounded-lg px-1 py-1 hover:bg-muted/50">
        {node.children.length > 0 ? (
          <button
            type="button"
            aria-label={open ? '折叠' : '展开'}
            onClick={() => setOpen((o) => !o)}
            className="shrink-0 rounded p-0.5 text-muted-foreground"
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        ) : (
          <span className="w-[18px] shrink-0" />
        )}
        <Input
          value={node.text}
          aria-label="节点名称"
          onChange={(e) => update(path, (n) => ({ ...n, text: e.target.value }))}
          className="h-8 flex-1 border-0 bg-transparent px-1 text-sm focus-visible:ring-1"
        />
        <button
          type="button"
          aria-label="上移节点"
          disabled={isRoot || myIndex === 0}
          onClick={() => update(parentPath, (p) => moveChild(p, myIndex, -1))}
          className="shrink-0 rounded p-1 text-muted-foreground/70 hover:bg-muted disabled:opacity-30"
        >
          <ArrowUp className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="下移节点"
          disabled={isRoot || myIndex >= siblings - 1}
          onClick={() => update(parentPath, (p) => moveChild(p, myIndex, 1))}
          className="shrink-0 rounded p-1 text-muted-foreground/70 hover:bg-muted disabled:opacity-30"
        >
          <ArrowDown className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="添加子节点"
          onClick={() =>
            update(path, (n) => ({
              ...n,
              children: [...n.children, { text: '新节点', children: [] }],
            }))
          }
          className="shrink-0 rounded p-1 text-emerald-600 hover:bg-emerald-500/10"
        >
          <Plus className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="删除节点"
          disabled={isRoot}
          onClick={() =>
            update(parentPath, (p) => ({
              ...p,
              children: p.children.filter((_, i) => i !== myIndex),
            }))
          }
          className="shrink-0 rounded p-1 text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive disabled:opacity-30"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      {open &&
        node.children.map((c, i) => (
          <MindTreeItem
            key={`${i}-${c.text}`}
            node={c}
            path={[...path, i]}
            siblings={node.children.length}
            update={update}
          />
        ))}
    </div>
  )
}

function MindmapEditor({
  root,
  onChange,
}: {
  root: MindNode
  onChange: (next: MindNode) => void
}) {
  const update = React.useCallback(
    (path: number[], fn: (n: MindNode) => MindNode) => {
      onChange(mapNode(root, path, fn))
    },
    [root, onChange],
  )
  return (
    <div className="flex flex-col gap-2">
      <div className="max-h-[46dvh] overflow-y-auto rounded-xl border border-border p-2">
        <MindTreeItem node={root} path={[]} siblings={0} update={update} />
      </div>
      <p className="text-[11px] text-muted-foreground">
        节点名称可直接编辑；「+」加子节点；箭头上下移动；根节点不可删除
      </p>
    </div>
  )
}

// ---------- 流程图画布编辑器（graph / flowchart） ----------
//
// 【布局注释协议】节点中心坐标以 JSON 存在声明行后的注释里（mermaid 渲染端忽略 %% 注释行）：
//   flowchart TD
//   %%layout:{"a":[80,40],"b":[280,120]}
// 缺少该行时按连线关系自动分层生成初始坐标；任何画布/列表操作都会重写该行实现位置持久化。
//
// 数据流：画布/列表操作 → FlowDoc（不可变更新）→ serializeFlowDoc 重新生成源码 →
//   宿主 onChange 链写回 src（结构变化立即、拖动位置防抖 600ms）→ 既有校验容错链照常工作。
// 容错解析：parseFlowDoc 逐行扫描，坏行/未支持指令原样保留在 doc.extras（不丢内容），
//   行号记入 problems，画布顶部黄条提示「解析出多少显示多少，坏行忽略」。

type FlowDir = 'TD' | 'TB' | 'LR' | 'RL' | 'BT'
type FlowEdgeStyle = '-->' | '---' | '-.->' | '==>'
/** 节点形状（mermaid 语法：bare 默认 / [..] / (..) / ((..)) / {..} / {{..}} / [(..)] / [/../]） */
type FlowNodeShape =
  | 'default'
  | 'rect'
  | 'round'
  | 'circle'
  | 'diamond'
  | 'hexagon'
  | 'cylinder'
  | 'parallelogram'

interface FlowDocNode {
  id: string
  label: string
  shape: FlowNodeShape
  /** 所属 subgraph 分组 id */
  group?: string
  /** 填充色（生成 `style <id> fill:#hex` 行） */
  fill?: string
}

interface FlowDocEdge {
  from: string
  to: string
  label?: string
  style?: FlowEdgeStyle
}

interface FlowGroup {
  id: string
  title: string
  /** 嵌套父分组 id（subgraph 嵌套） */
  parent?: string
}

interface FlowDoc {
  dir: FlowDir
  nodes: FlowDocNode[]
  edges: FlowDocEdge[]
  groups: FlowGroup[]
  /** 节点中心坐标（%%layout 协议行） */
  layout: Record<string, [number, number]>
  /** 暂不支持可视化的指令行（classDef / class / linkStyle / click…），重建源码时原样带回 */
  extras: string[]
}

/** 可选形状（工具条 7 种图标 + 列表下拉共用；bare 默认形状仅由解析产生，改名时自动升级为方形） */
const FLOW_SHAPES: Array<{ value: FlowNodeShape; label: string; syntax: string }> = [
  { value: 'rect', label: '方形', syntax: '[文字]' },
  { value: 'round', label: '圆角', syntax: '(文字)' },
  { value: 'diamond', label: '菱形', syntax: '{文字}' },
  { value: 'hexagon', label: '六边形', syntax: '{{文字}}' },
  { value: 'cylinder', label: '圆柱', syntax: '[(文字)]' },
  { value: 'parallelogram', label: '平行四边形', syntax: '[/文字/]' },
  { value: 'circle', label: '圆形', syntax: '((文字))' },
]

const FLOW_EDGE_STYLES: Array<{ value: FlowEdgeStyle; label: string }> = [
  { value: '-->', label: '实线箭头' },
  { value: '---', label: '无箭头' },
  { value: '-.->', label: '虚线箭头' },
  { value: '==>', label: '粗线箭头' },
]

/** 填充色板（选中节点 → 生成 style 行；至少 6 选） */
const FLOW_FILLS = ['#dbeafe', '#dcfce7', '#fef3c7', '#fce7f3', '#ede9fe', '#fee2e2'] as const

const FLOW_ID_CHAR = /[\w\u4e00-\u9fff]/

/** 节点 token（A / A[文字] / A[(文字)] …）→ { id, label, shape }；不认识返回 null。 */
function parseFlowToken(tok: string): { id: string; label: string; shape: FlowNodeShape } | null {
  let i = 0
  while (i < tok.length && FLOW_ID_CHAR.test(tok[i])) i++
  const id = tok.slice(0, i)
  if (!id) return null
  const rest = tok.slice(i).trim().replace(/^:::[\w-]+/, '').trim()
  const unquote = (s: string) =>
    s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s
  const inner = (s: string) => unquote(s).replace(/\s+/g, ' ').trim() || id
  let m: RegExpMatchArray | null
  if ((m = rest.match(/^\(\(([\s\S]*)\)\)$/))) return { id, label: inner(m[1]), shape: 'circle' }
  if ((m = rest.match(/^\[\(([\s\S]*)\)\]$/))) return { id, label: inner(m[1]), shape: 'cylinder' }
  if ((m = rest.match(/^\[\/([\s\S]*)\/\]$/))) return { id, label: inner(m[1]), shape: 'parallelogram' }
  if ((m = rest.match(/^\{\{([\s\S]*)\}\}$/))) return { id, label: inner(m[1]), shape: 'hexagon' }
  if ((m = rest.match(/^\[([\s\S]*)\]$/))) return { id, label: inner(m[1]), shape: 'rect' }
  if ((m = rest.match(/^\(([\s\S]*)\)$/))) return { id, label: inner(m[1]), shape: 'round' }
  if ((m = rest.match(/^\{([\s\S]*)\}$/))) return { id, label: inner(m[1]), shape: 'diamond' }
  if (rest === '') return { id, label: id, shape: 'default' }
  return null
}

/** 箭头片段归类为 4 种受支持样式；无法归类返回 null。 */
function flowArrowStyle(seg: string): FlowEdgeStyle | null {
  if (!seg || !/^[-=.]/.test(seg)) return null
  if (/^=/.test(seg)) return '==>'
  if (/\./.test(seg)) return '-.->'
  if (/>$/.test(seg.trim())) return '-->'
  return '---'
}

interface FlowScanTok {
  node?: string
  edge?: { label?: string; style: FlowEdgeStyle }
}

/**
 * 扫描一行流程语句 → 节点/连线交替 token。
 * 支持 8 种形状括号、链式 A-->B-->C、`-- 文字 -->`、`-->|文字|`、`A:::class`。
 */
function scanFlowTokens(line: string): FlowScanTok[] | null {
  const toks: FlowScanTok[] = []
  let i = 0
  const n = line.length
  let expectNode = true
  while (i < n) {
    const ch = line[i]
    if (ch === ' ' || ch === '\t') {
      i++
      continue
    }
    if (expectNode) {
      let j = i
      while (j < n && FLOW_ID_CHAR.test(line[j])) j++
      if (j === i) return null
      const open = line[j]
      if (open === '[' || open === '(' || open === '{') {
        const close = open === '[' ? ']' : open === '(' ? ')' : '}'
        let depth = 0
        let end = -1
        for (let k = j; k < n; k++) {
          if (line[k] === open) depth++
          else if (line[k] === close) {
            depth--
            if (depth === 0) {
              end = k
              break
            }
          }
        }
        if (end === -1) return null
        j = end + 1
      }
      // `A:::class` 修饰（class 定义保留在 extras，引用处忽略）
      if (line[j] === ':' && line.slice(j).startsWith(':::')) {
        const cm = line.slice(j).match(/^:::[\w-]+/)
        if (cm) j += cm[0].length
      }
      toks.push({ node: line.slice(i, j) })
      i = j
      expectNode = false
      continue
    }
    // ---- 连线段：[-=.] 开头的箭头序列 ----
    let j = i
    while (j < n && (line[j] === '-' || line[j] === '=' || line[j] === '.')) j++
    let seg = line.slice(i, j)
    if (!seg) return null
    if (j < n && line[j] === '>') {
      seg += '>'
      j++
    }
    let label: string | undefined
    // `-- 文字 -->` / `== 文字 ==>` 内联文字形式
    const opener = seg.replace(/>$/, '')
    if (!seg.endsWith('>') && /^(-{2,}|={2,}|-\.+)$/.test(opener)) {
      const rest = line.slice(j)
      const m = rest.match(/^([^-=|>.]*?)\s*(-{2,}>|-\.+->|-\.->|={2,}>|-->|==>|\.->|-{3,}|-{2,}|-\.-|-\.|={2,}|\.-)/)
      if (m && m[2]) {
        label = m[1].trim() || undefined
        j += m[0].length
        seg = line.slice(i, j)
      }
    }
    // `-->|文字|` 形式
    if (j < n && line[j] === '|') {
      const close = line.indexOf('|', j + 1)
      if (close === -1) return null
      label = line.slice(j + 1, close).trim() || label
      j = close + 1
    }
    const style = flowArrowStyle(seg)
    if (!style) return null
    toks.push({ edge: { label, style } })
    i = j
    expectNode = true
  }
  return expectNode ? null : toks
}

/**
 * mermaid graph/flowchart 源码 → FlowDoc（容错解析）。
 * 返回 null：首个有效行不是 graph/flowchart 声明（非流程图）。
 * 坏行 / 未支持指令不中断解析：保留进 extras 重建时带回，行号进 problems（黄条提示）。
 */
function parseFlowDoc(raw: string): { doc: FlowDoc; problems: number[] } | null {
  if (!raw) return null
  const lines = raw.split(/\r?\n/)
  let declIdx = -1
  let dir: FlowDir = 'TD'
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t || t.startsWith('%%')) continue
    const m = t.match(/^(?:graph|flowchart)(?:[ \t]+(TD|TB|LR|RL|BT))?[ \t]*$/i)
    if (!m) return null
    declIdx = i
    dir = (m[1] ? m[1].toUpperCase() : 'TD') as FlowDir
    break
  }
  if (declIdx === -1) return null

  // %%layout 协议行（可能不存在 → 走自动布局）
  const layout: Record<string, [number, number]> = {}
  for (const l of lines) {
    const m = l.trim().match(/^%%layout:\s*(\{[\s\S]*\})\s*$/)
    if (!m) continue
    try {
      const obj = JSON.parse(m[1]) as Record<string, unknown>
      for (const [k, v] of Object.entries(obj)) {
        if (
          Array.isArray(v) &&
          v.length >= 2 &&
          typeof v[0] === 'number' &&
          typeof v[1] === 'number'
        ) {
          layout[k] = [v[0], v[1]]
        }
      }
    } catch {
      // 坏 JSON 忽略 → 自动布局
    }
    break
  }

  const nodes: FlowDocNode[] = []
  const nodeIdx = new Map<string, number>()
  const edges: FlowDocEdge[] = []
  const groups: FlowGroup[] = []
  const groupById = new Map<string, FlowGroup>()
  const stack: string[] = []
  const extras: string[] = []
  const fills: Record<string, string> = {}
  const problems: number[] = []

  const register = (tok: string): FlowDocNode | null => {
    const p = parseFlowToken(tok)
    if (!p) return null
    const gi = nodeIdx.get(p.id)
    if (gi !== undefined) {
      const ex = nodes[gi]
      // 首见优先；后见带形状/标签时补全
      if (p.shape !== 'default' || (p.label !== p.id && ex.label === ex.id)) {
        nodes[gi] = {
          ...ex,
          label: p.label === p.id && ex.label !== ex.id ? ex.label : p.label,
          shape: p.shape === 'default' ? ex.shape : p.shape,
        }
        return nodes[gi]
      }
      return ex
    }
    const node: FlowDocNode = { id: p.id, label: p.label, shape: p.shape, group: stack[stack.length - 1] }
    nodes.push(node)
    nodeIdx.set(p.id, nodes.length - 1)
    return node
  }

  for (let i = declIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t || t.startsWith('%%')) continue
    // subgraph 分组（subgraph id[标题] / subgraph 标题）
    const sm = t.match(/^subgraph[ \t]+(.+)$/i)
    if (sm) {
      const tok = sm[1].trim()
      const bm = tok.match(/^([\w\u4e00-\u9fff]+)[ \t]*[\[\(]([^\]\)]*)[\]\)]$/)
      const gid = bm ? bm[1] : tok.replace(/[^\w\u4e00-\u9fff]/g, '_')
      const title = bm ? bm[2].trim() || gid : tok
      let g = groupById.get(gid)
      if (!g) {
        g = { id: gid, title, parent: stack[stack.length - 1] }
        groups.push(g)
        groupById.set(gid, g)
      }
      stack.push(gid)
      continue
    }
    if (/^end\b/i.test(t)) {
      if (stack.length) stack.pop()
      else problems.push(i + 1)
      continue
    }
    // style 行：提取 fill（节点填色），其余样式属性暂不可视化
    const ym = t.match(/^style[ \t]+([\w\u4e00-\u9fff]+)[ \t]+(.+)$/i)
    if (ym) {
      const fm = ym[2].match(/(?:^|[,;]\s*)fill:\s*(#[0-9a-fA-F]{3,8})/)
      if (fm && nodeIdx.has(ym[1])) fills[ym[1]] = fm[1]
      else extras.push(t)
      continue
    }
    // 未支持指令：原样保留（不丢内容）；direction 仅影响渲染方向，静默丢弃
    if (/^(classDef|class|linkStyle|click|init|frontmatter)\b/i.test(t)) {
      extras.push(t)
      continue
    }
    if (/^direction\b/i.test(t)) continue
    const toks = scanFlowTokens(t)
    if (!toks) {
      extras.push(t)
      problems.push(i + 1)
      continue
    }
    const nodeToks = toks.filter((x) => x.node != null).map((x) => x.node as string)
    const edgeToks = toks.filter((x) => x.edge != null).map((x) => x.edge as NonNullable<FlowScanTok['edge']>)
    if (nodeToks.length === 0 || edgeToks.length !== nodeToks.length - 1) {
      extras.push(t)
      problems.push(i + 1)
      continue
    }
    if (edgeToks.length === 0) {
      register(nodeToks[0])
      continue
    }
    for (let k = 0; k < edgeToks.length; k++) {
      const a = register(nodeToks[k])
      const b = register(nodeToks[k + 1])
      if (!a || !b) {
        extras.push(t)
        problems.push(i + 1)
        break
      }
      edges.push({ from: a.id, to: b.id, label: edgeToks[k].label, style: edgeToks[k].style })
    }
  }

  // 悬空分组引用清理 + 填色应用
  const gidSet = new Set(groups.map((g) => g.id))
  const finalNodes = nodes.map((n) => ({
    ...n,
    group: n.group && gidSet.has(n.group) ? n.group : undefined,
    fill: fills[n.id],
  }))
  return { doc: { dir, nodes: finalNodes, edges, groups, layout, extras }, problems }
}

/** FlowDoc → 合法 mermaid flowchart 源码（含 %%layout 协议行；标签特殊字符转全角保证语法合法）。 */
function serializeFlowDoc(doc: FlowDoc): string {
  const FW: Record<string, string> = {
    '|': '｜',
    '[': '［',
    ']': '］',
    '{': '｛',
    '}': '｝',
    '(': '（',
    ')': '）',
    '/': '／',
    '<': '＜',
    '>': '＞',
    '"': '＂',
  }
  const esc = (s: string) =>
    (s || '')
      .replace(/[|[\]{}()/<>"]/g, (c) => FW[c] ?? c)
      .replace(/\s+/g, ' ')
      .trim()
  const wrap = (n: FlowDocNode) => {
    const label = esc(n.label) || n.id
    switch (n.shape) {
      case 'round':
        return `${n.id}(${label})`
      case 'circle':
        return `${n.id}((${label}))`
      case 'diamond':
        return `${n.id}{${label}}`
      case 'hexagon':
        return `${n.id}{{${label}}}`
      case 'cylinder':
        return `${n.id}[(${label})]`
      case 'parallelogram':
        return `${n.id}[/${label}/]`
      case 'default':
        return n.id
      default:
        return `${n.id}[${label}]`
    }
  }
  const gidSet = new Set(doc.groups.map((g) => g.id))
  const validGroup = (id?: string) => (id && gidSet.has(id) ? id : undefined)
  const lines: string[] = [`flowchart ${doc.dir}`]

  // 位置协议行（仅保留存在节点的坐标；键排序保证稳定）
  const withPos = doc.nodes.filter((n) => doc.layout[n.id])
  if (withPos.length) {
    const obj: Record<string, [number, number]> = {}
    for (const n of [...withPos].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      obj[n.id] = [Math.round(doc.layout[n.id][0]), Math.round(doc.layout[n.id][1])]
    }
    lines.push(`%%layout:${JSON.stringify(obj)}`)
  }

  // subgraph 块（递归嵌套；空组不输出；组内节点保持首次出现顺序）
  const emitGroup = (g: FlowGroup, depth: number) => {
    const kids = doc.nodes.filter((n) => validGroup(n.group) === g.id)
    const children = doc.groups.filter((c) => validGroup(c.parent) === g.id)
    if (kids.length === 0 && children.length === 0) return
    const pad = '  '.repeat(depth)
    lines.push(`${pad}subgraph ${g.id}[${esc(g.title) || g.id}]`)
    for (const n of kids) lines.push(`${pad}  ${wrap(n)}`)
    for (const c of children) emitGroup(c, depth + 1)
    lines.push(`${pad}end`)
  }
  for (const g of doc.groups) if (!validGroup(g.parent)) emitGroup(g, 0)

  // 未分组节点
  for (const n of doc.nodes) if (!validGroup(n.group)) lines.push(`  ${wrap(n)}`)

  // 连线（`a -->|标签| b`）
  for (const e of doc.edges) {
    const style = e.style ?? '-->'
    lines.push(e.label ? `  ${e.from} ${style}|${esc(e.label)}| ${e.to}` : `  ${e.from} ${style} ${e.to}`)
  }
  // 填充色 style 行
  for (const n of doc.nodes) if (n.fill) lines.push(`  style ${n.id} fill:${n.fill}`)
  // 保留的额外指令
  for (const x of doc.extras) lines.push(x)
  return lines.join('\n')
}

/** 自动布局：按连线最长路分层（层间距 100、同层间距 80；TD 纵向分层 / LR 横向分层）。 */
function autoLayout(doc: FlowDoc): Record<string, [number, number]> {
  const layout: Record<string, [number, number]> = {}
  if (doc.nodes.length === 0) return layout
  const boxes = new Map(doc.nodes.map((n) => [n.id, flowNodeBox(n, doc.layout[n.id])]))
  const layer = new Map<string, number>(doc.nodes.map((n) => [n.id, 0]))
  for (let it = 0; it < Math.min(doc.nodes.length + 1, 40); it++) {
    let changed = false
    for (const e of doc.edges) {
      if (!layer.has(e.from) || !layer.has(e.to)) continue
      const want = (layer.get(e.from) ?? 0) + 1
      if (want > (layer.get(e.to) ?? 0)) {
        layer.set(e.to, want)
        changed = true
      }
    }
    if (!changed) break
  }
  const byLayer = new Map<number, FlowDocNode[]>()
  for (const n of doc.nodes) {
    const l = layer.get(n.id) ?? 0
    if (!byLayer.has(l)) byLayer.set(l, [])
    byLayer.get(l)!.push(n)
  }
  const horizontal = doc.dir === 'LR' || doc.dir === 'RL'
  const GAP_SAME = 80
  const GAP_LAYER = 100
  const PAD = 40
  let main = PAD
  for (const l of [...byLayer.keys()].sort((a, b) => a - b)) {
    const ns = byLayer.get(l)!
    let cross = PAD
    let mainSize = 0
    for (const n of ns) {
      const b = boxes.get(n.id)!
      const spread = horizontal ? b.h : b.w
      const along = horizontal ? b.w : b.h
      const p = cross + spread / 2
      layout[n.id] = horizontal ? [main + along / 2, p] : [p, main + along / 2]
      cross += spread + GAP_SAME
      mainSize = Math.max(mainSize, along)
    }
    main += mainSize + GAP_LAYER
  }
  return layout
}

/** 解析结果补坐标：协议行整行缺失 → 全量自动布局；个别节点缺坐标 → 仅补缺失项。 */
function withAutoLayout(doc: FlowDoc): FlowDoc {
  if (doc.nodes.length === 0) return doc
  const missing = doc.nodes.filter((n) => !doc.layout[n.id])
  if (missing.length === 0) return doc
  const auto = autoLayout(doc)
  if (missing.length === doc.nodes.length) return { ...doc, layout: auto }
  const layout = { ...doc.layout }
  for (const n of missing) layout[n.id] = auto[n.id] ?? [80, 80]
  return { ...doc, layout }
}

interface FlowBox {
  x: number
  y: number
  w: number
  h: number
  cx: number
  cy: number
  lines: string[]
}

/** 估算节点尺寸（CJK 约 13px / 其他约 7.2px；超宽自动折两行）。 */
function flowNodeBox(n: FlowDocNode, pos?: [number, number]): FlowBox {
  const label = (n.label || '').trim() || n.id
  const textW = (s: string) => {
    let w = 0
    for (const ch of s) w += ch.charCodeAt(0) > 0x2e7f ? 13 : 7.2
    return w
  }
  let lines = [label]
  if (textW(label) > 190 && label.length > 1) {
    let best = Math.ceil(label.length / 2)
    let bestDiff = Infinity
    for (let i = 1; i < label.length; i++) {
      const d = Math.abs(textW(label.slice(0, i)) - textW(label.slice(i)))
      if (d < bestDiff) {
        bestDiff = d
        best = i
      }
    }
    lines = [label.slice(0, best), label.slice(best)]
  }
  const w = Math.min(250, Math.max(76, ...lines.map((l) => textW(l) + 28)))
  const h = lines.length > 1 ? 56 : 40
  const cx = pos?.[0] ?? 0
  const cy = pos?.[1] ?? 0
  return { x: cx - w / 2, y: cy - h / 2, w, h, cx, cy, lines }
}

/** 连线端点：按两节点相对方位自动选左右 / 上下锚点。 */
function flowEdgeAnchors(a: FlowBox, b: FlowBox): { x1: number; y1: number; x2: number; y2: number } {
  const dx = b.cx - a.cx
  const dy = b.cy - a.cy
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { x1: a.x + a.w, y1: a.cy, x2: b.x, y2: b.cy }
      : { x1: a.x, y1: a.cy, x2: b.x + b.w, y2: b.cy }
  }
  return dy >= 0
    ? { x1: a.cx, y1: a.y + a.h, x2: b.cx, y2: b.y }
    : { x1: a.cx, y1: a.y, x2: b.cx, y2: b.y + b.h }
}

/** 箭头三角形（手绘 polygon，避免 marker 的取色/缩放兼容问题）。 */
function flowArrowHead(x1: number, y1: number, x2: number, y2: number, size = 9) {
  const a = Math.atan2(y2 - y1, x2 - x1)
  const c = Math.cos(a)
  const s = Math.sin(a)
  const bx = x2 - c * size
  const by = y2 - s * size
  const nx = -s * size * 0.45
  const ny = c * size * 0.45
  return {
    head: `M ${x2} ${y2} L ${bx + nx} ${by + ny} L ${bx - nx} ${by - ny} Z`,
    lineEnd: [x2 - c * size * 0.72, y2 - s * size * 0.72] as [number, number],
  }
}

interface GroupBox {
  x: number
  y: number
  w: number
  h: number
  depth: number
}

/** 分组容器包围盒（递归含子组与成员节点；顶部留 36px 标题区、四周留白）。 */
function flowGroupBoxes(doc: FlowDoc, boxes: Map<string, FlowBox>): Map<string, GroupBox> {
  const memo = new Map<string, GroupBox | null>()
  const childrenOf = (gid: string) => doc.groups.filter((g) => g.parent === gid)
  const rec = (gid: string): GroupBox | null => {
    if (memo.has(gid)) return memo.get(gid) ?? null
    memo.set(gid, null) // 防环
    let x1 = Infinity
    let y1 = Infinity
    let x2 = -Infinity
    let y2 = -Infinity
    for (const n of doc.nodes) {
      if (n.group !== gid) continue
      const b = boxes.get(n.id)
      if (!b) continue
      x1 = Math.min(x1, b.x)
      y1 = Math.min(y1, b.y)
      x2 = Math.max(x2, b.x + b.w)
      y2 = Math.max(y2, b.y + b.h)
    }
    for (const c of childrenOf(gid)) {
      const b = rec(c.id)
      if (!b) continue
      x1 = Math.min(x1, b.x)
      y1 = Math.min(y1, b.y)
      x2 = Math.max(x2, b.x + b.w)
      y2 = Math.max(y2, b.y + b.h)
    }
    const out: GroupBox | null =
      x1 === Infinity ? null : { x: x1 - 22, y: y1 - 36, w: x2 - x1 + 44, h: y2 - y1 + 52, depth: 0 }
    memo.set(gid, out)
    return out
  }
  const depthOf = (g: FlowGroup): number => {
    let d = 0
    let p = g.parent
    const seen = new Set<string>()
    while (p && !seen.has(p)) {
      seen.add(p)
      d++
      p = doc.groups.find((x) => x.id === p)?.parent
    }
    return d
  }
  const result = new Map<string, GroupBox>()
  for (const g of doc.groups) {
    const b = rec(g.id)
    if (b) result.set(g.id, { ...b, depth: depthOf(g) })
  }
  return result
}

/** 点所在的最内层分组（depth 最大者优先；excludeIds 内的组忽略）。 */
function groupAtPoint(
  doc: FlowDoc,
  gboxes: Map<string, GroupBox>,
  x: number,
  y: number,
  excludeIds?: Set<string>,
): string | undefined {
  let best: { id: string; depth: number } | null = null
  for (const g of doc.groups) {
    if (excludeIds?.has(g.id)) continue
    const b = gboxes.get(g.id)
    if (!b) continue
    if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) continue
    if (!best || b.depth > best.depth) best = { id: g.id, depth: b.depth }
  }
  return best?.id
}

/** 命中测试：返回包含点的节点 id（后声明者优先）。 */
function nodeAtPoint(doc: FlowDoc, boxes: Map<string, FlowBox>, x: number, y: number): string | null {
  for (let i = doc.nodes.length - 1; i >= 0; i--) {
    const b = boxes.get(doc.nodes[i].id)
    if (b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return doc.nodes[i].id
  }
  return null
}

/** 分组自身 + 全部子孙分组 id。 */
function groupSubtreeIds(doc: FlowDoc, gid: string): Set<string> {
  const all = new Set<string>([gid])
  let changed = true
  while (changed) {
    changed = false
    for (const g of doc.groups) {
      if (g.parent && all.has(g.parent) && !all.has(g.id)) {
        all.add(g.id)
        changed = true
      }
    }
  }
  return all
}

/** 分组（含子孙分组）内全部节点 id。 */
function groupMemberIds(doc: FlowDoc, gid: string): string[] {
  const gids = groupSubtreeIds(doc, gid)
  return doc.nodes.filter((n) => n.group && gids.has(n.group)).map((n) => n.id)
}

// ---------- 画布子组件 ----------

/** 画布变更入口（由 FlowGraphEditor 提供，两模式共享撤销栈）。 */
interface FlowMutate {
  /** 提交修改（默认入撤销栈 + 立即写回源码）。 */
  update: (next: FlowDoc, opts?: { history?: boolean; immediate?: boolean }) => void
  /** 仅把当前状态入栈（手势开始时调用，后续以 history:false 连续更新）。 */
  snapshot: () => void
  undo: () => void
  redo: () => void
}

type FlowSelection = { type: 'node'; id: string } | { type: 'edge'; index: number }

type FlowDrag =
  | { kind: 'node'; id: string; startWX: number; startWY: number; orig: [number, number]; moved: boolean }
  | { kind: 'group'; gid: string; ids: string[]; startWX: number; startWY: number; origs: Record<string, [number, number]>; moved: boolean }
  | { kind: 'pan'; startCX: number; startCY: number; orig: { x: number; y: number; k: number }; moved: boolean }
  | { kind: 'link'; from: string; ax: number; ay: number }

/** 节点形状 SVG 图形（按 mermaid 语法对应渲染；mini 用于工具条小图标）。 */
function FlowShapeFigure({
  shape,
  x,
  y,
  w,
  h,
  fill,
  selected,
  mini,
}: {
  shape: FlowNodeShape
  x: number
  y: number
  w: number
  h: number
  fill?: string
  selected?: boolean
  mini?: boolean
}) {
  const stroke = selected ? 'var(--primary)' : mini ? 'var(--muted-foreground)' : 'var(--border)'
  const style: React.CSSProperties = {
    fill: fill ?? 'var(--muted)',
    stroke,
    strokeWidth: selected ? 2.2 : 1.4,
  }
  switch (shape) {
    case 'round':
      return <rect x={x} y={y} width={w} height={h} rx={Math.min(w, h) / 2} style={style} />
    case 'default':
      return <rect x={x} y={y} width={w} height={h} rx={Math.min(10, w / 2, h / 2)} style={style} />
    case 'circle':
      return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} style={style} />
    case 'diamond':
      return (
        <polygon
          points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`}
          style={style}
        />
      )
    case 'hexagon': {
      const c = Math.min(16, w / 4)
      return (
        <polygon
          points={`${x + c},${y} ${x + w - c},${y} ${x + w},${y + h / 2} ${x + w - c},${y + h} ${x + c},${y + h} ${x},${y + h / 2}`}
          style={style}
        />
      )
    }
    case 'cylinder': {
      const ry = Math.min(7, h / 4)
      const rx = Math.min(16, w / 2)
      const body = `M ${x} ${y + ry} A ${rx} ${ry} 0 0 1 ${x + w} ${y + ry} L ${x + w} ${y + h - ry} A ${rx} ${ry} 0 0 1 ${x} ${y + h - ry} Z`
      return (
        <g>
          <path d={body} style={style} />
          <path
            d={`M ${x} ${y + ry} A ${rx} ${ry} 0 0 0 ${x + w} ${y + ry}`}
            fill="none"
            style={{ stroke, strokeWidth: 1.4 }}
          />
        </g>
      )
    }
    case 'parallelogram': {
      const s = Math.min(16, w / 3)
      return (
        <polygon points={`${x + s},${y} ${x + w},${y} ${x + w - s},${y + h} ${x},${y + h}`} style={style} />
      )
    }
    case 'rect':
    default:
      return <rect x={x} y={y} width={w} height={h} rx={2} style={style} />
  }
}

/** 画布模式：SVG 画布 + 工具栏（拖节点 / 锚点连线 / 缩放平移 / 形状填色 / 连线标签）。 */
function FlowCanvasEditor({ doc, mutate }: { doc: FlowDoc; mutate: FlowMutate }) {
  // ---- 本地 UI 状态 ----
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [tool, setTool] = React.useState<'select' | 'pan'>('select')
  const [snapGrid, setSnapGrid] = React.useState(true)
  const [arrowOn, setArrowOn] = React.useState(true)
  const [placing, setPlacing] = React.useState(false)
  const [selection, setSelection] = React.useState<FlowSelection | null>(null)
  const [view, setView] = React.useState({ x: 30, y: 30, k: 1 })
  const [rubber, setRubber] = React.useState<{ ax: number; ay: number; x: number; y: number } | null>(null)
  const [editing, setEditing] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState('')
  const [edgeDraft, setEdgeDraft] = React.useState('')

  // ---- 渲染期镜像 ref（手势处理里读最新值；通过 useLayoutEffect 同步写，
  //      既规避 ref-during-render 规则，又保证下一次浏览器事件触发前 ref 已是最新值） ----
  const docRef = React.useRef(doc)
  const viewRef = React.useRef(view)
  const boxesRef = React.useRef(new Map<string, FlowBox>())
  const gboxesRef = React.useRef(new Map<string, GroupBox>())
  const dragRef = React.useRef<FlowDrag | null>(null)
  const pointersRef = React.useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = React.useRef<{ d: number; cx: number; cy: number; view: { x: number; y: number; k: number } } | null>(null)
  const nudgeTsRef = React.useRef(0)
  const didFitRef = React.useRef(false)

  const boxes = React.useMemo(() => {
    const m = new Map<string, FlowBox>()
    for (const n of doc.nodes) m.set(n.id, flowNodeBox(n, doc.layout[n.id]))
    return m
  }, [doc])
  const gboxes = React.useMemo(() => flowGroupBoxes(doc, boxes), [doc, boxes])
  React.useLayoutEffect(() => {
    docRef.current = doc
  })
  React.useLayoutEffect(() => {
    viewRef.current = view
  })
  React.useLayoutEffect(() => {
    boxesRef.current = boxes
  })
  React.useLayoutEffect(() => {
    gboxesRef.current = gboxes
  })

  const selNode = selection?.type === 'node' ? doc.nodes.find((n) => n.id === selection.id) : undefined
  const selEdge =
    selection?.type === 'edge' && selection.index < doc.edges.length ? doc.edges[selection.index] : undefined

  // 选中连线变化 → 同步标签草稿
  React.useEffect(() => {
    if (selection?.type === 'edge') setEdgeDraft(docRef.current.edges[selection.index]?.label ?? '')
  }, [selection])

  // ---- 坐标换算 / 缩放平移 ----
  const toWorld = (clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect()
    const v = viewRef.current
    if (!rect) return { x: 0, y: 0 }
    return { x: (clientX - rect.left - v.x) / v.k, y: (clientY - rect.top - v.y) / v.k }
  }

  const zoomAt = React.useCallback((sx: number, sy: number, factor: number) => {
    const v = viewRef.current
    const k = Math.min(2.5, Math.max(0.3, v.k * factor))
    setView({ k, x: sx - (sx - v.x) * (k / v.k), y: sy - (sy - v.y) * (k / v.k) })
  }, [])

  const zoomCenter = (factor: number) => {
    const el = containerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    zoomAt(r.width / 2, r.height / 2, factor)
  }

  /** 适应内容（可传目标 doc，用于自动布局后立即取景）。 */
  const fitView = React.useCallback((target?: FlowDoc) => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width < 10 || rect.height < 10) return
    const d = target ?? docRef.current
    let x1 = Infinity
    let y1 = Infinity
    let x2 = -Infinity
    let y2 = -Infinity
    for (const n of d.nodes) {
      const b = flowNodeBox(n, d.layout[n.id])
      x1 = Math.min(x1, b.x)
      y1 = Math.min(y1, b.y)
      x2 = Math.max(x2, b.x + b.w)
      y2 = Math.max(y2, b.y + b.h)
    }
    if (x1 === Infinity || x2 <= x1 || y2 <= y1) {
      setView({ x: 30, y: 30, k: 1 })
      return
    }
    const pad = 36
    const k = Math.min(
      1.25,
      Math.max(0.3, Math.min((rect.width - pad * 2) / (x2 - x1), (rect.height - pad * 2) / (y2 - y1))),
    )
    setView({
      k,
      x: (rect.width - (x2 - x1) * k) / 2 - x1 * k,
      y: (rect.height - (y2 - y1) * k) / 2 - y1 * k,
    })
  }, [])

  // 滚轮缩放（非被动监听，拦截页面滚动）
  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0012))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  // 首次挂载自动适应内容
  React.useEffect(() => {
    if (didFitRef.current || docRef.current.nodes.length === 0) return
    didFitRef.current = true
    const raf = requestAnimationFrame(() => fitView())
    return () => cancelAnimationFrame(raf)
  }, [fitView, doc])

  // ---- 结构操作 ----
  const genId = () => {
    const d = docRef.current
    let i = d.nodes.length + 1
    let id = `N${i}`
    while (d.nodes.some((n) => n.id === id)) {
      i += 1
      id = `N${i}`
    }
    return id
  }

  /** 工具栏「+ 节点」后点击画布：落点放置（默认方形）+ 自动入所在分组 + 就地改名。 */
  const placeNode = (wx: number, wy: number) => {
    const d = docRef.current
    const id = genId()
    const pos: [number, number] = snapGrid
      ? [Math.round(wx / 10) * 10, Math.round(wy / 10) * 10]
      : [wx, wy]
    const gid = groupAtPoint(d, gboxesRef.current, pos[0], pos[1])
    mutate.update({
      ...d,
      nodes: [...d.nodes, { id, label: '新节点', shape: 'rect', group: gid }],
      layout: { ...d.layout, [id]: pos },
    })
    setSelection({ type: 'node', id })
    setDraft('新节点')
    setEditing(id)
  }

  const openRename = (id: string) => {
    setDraft(docRef.current.nodes.find((x) => x.id === id)?.label ?? '')
    setEditing(id)
  }

  /** 双击改名提交（bare 默认形状无法携带文字 → 自动升级为方形）。 */
  const commitRename = () => {
    const id = editing
    if (!id) return
    setEditing(null)
    const d = docRef.current
    const node = d.nodes.find((n) => n.id === id)
    if (!node) return
    const label = draft.trim()
    if (node.label === label) return
    mutate.update({
      ...d,
      nodes: d.nodes.map((n) =>
        n.id === id ? { ...n, label, shape: n.shape === 'default' ? 'rect' : n.shape } : n,
      ),
    })
  }

  const deleteSelection = () => {
    if (!selection) return
    const d = docRef.current
    if (selection.type === 'node') {
      mutate.update({
        ...d,
        nodes: d.nodes.filter((n) => n.id !== selection.id),
        edges: d.edges.filter((e) => e.from !== selection.id && e.to !== selection.id),
      })
    } else {
      mutate.update({ ...d, edges: d.edges.filter((_, i) => i !== selection.index) })
    }
    setSelection(null)
  }

  const setNodeShape = (shape: FlowNodeShape) => {
    if (selection?.type !== 'node') return
    const d = docRef.current
    mutate.update({ ...d, nodes: d.nodes.map((n) => (n.id === selection.id ? { ...n, shape } : n)) })
  }

  const setNodeFill = (fill?: string) => {
    if (selection?.type !== 'node') return
    const d = docRef.current
    mutate.update({ ...d, nodes: d.nodes.map((n) => (n.id === selection.id ? { ...n, fill } : n)) })
  }

  const commitEdgeLabel = () => {
    if (selection?.type !== 'edge') return
    const d = docRef.current
    const e = d.edges[selection.index]
    if (!e) return
    const label = edgeDraft.trim()
    if ((e.label ?? '') === label) return
    mutate.update({
      ...d,
      edges: d.edges.map((x, i) => (i === selection.index ? { ...x, label: label || undefined } : x)),
    })
  }

  const setEdgeStyle = (style: FlowEdgeStyle) => {
    if (selection?.type !== 'edge') return
    const d = docRef.current
    mutate.update({
      ...d,
      edges: d.edges.map((x, i) => (i === selection.index ? { ...x, style } : x)),
    })
  }

  const swapEdge = () => {
    if (selection?.type !== 'edge') return
    const d = docRef.current
    mutate.update({
      ...d,
      edges: d.edges.map((e, i) => (i === selection.index ? { ...e, from: e.to, to: e.from } : e)),
    })
  }

  const applyAutoLayout = () => {
    const d = docRef.current
    if (d.nodes.length === 0) return
    const next = { ...d, layout: autoLayout(d) }
    mutate.update(next)
    requestAnimationFrame(() => fitView(next))
  }

  // ---- 指针交互（单指拖动 / 锚点连线 / 双指缩放 / 抓手平移） ----
  const startPan = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = {
      kind: 'pan',
      startCX: e.clientX,
      startCY: e.clientY,
      orig: { ...viewRef.current },
      moved: false,
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const el = containerRef.current
    if (!el) return
    // 浮层（工具条 / 输入框）上的指针事件交给浮层自己
    if ((e.target as Element).closest?.('[data-overlay]')) return
    el.setPointerCapture(e.pointerId)
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointersRef.current.size === 2) {
      // 进入双指缩放：中止当前手势
      dragRef.current = null
      setRubber(null)
      const ps = [...pointersRef.current.values()]
      pinchRef.current = {
        d: Math.max(1, Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y)),
        cx: (ps[0].x + ps[1].x) / 2,
        cy: (ps[0].y + ps[1].y) / 2,
        view: { ...viewRef.current },
      }
      return
    }
    if (pointersRef.current.size > 2) return

    const target = e.target as Element
    const anchorEl = target.closest('[data-link-anchor]')
    const nodeEl = target.closest('[data-node-id]')
    const edgeEl = target.closest('[data-edge-index]')
    const groupEl = target.closest('[data-group-drag]')
    const w = toWorld(e.clientX, e.clientY)

    if (tool === 'pan' && !anchorEl && !nodeEl && !groupEl) {
      startPan(e)
      return
    }
    // 从锚点拖出橡皮筋连线
    if (anchorEl && nodeEl) {
      const id = nodeEl.getAttribute('data-node-id') as string
      const b = boxesRef.current.get(id)
      if (b) {
        const side = anchorEl.getAttribute('data-link-anchor')
        const pt =
          side === 't'
            ? { x: b.cx, y: b.y }
            : side === 'b'
              ? { x: b.cx, y: b.y + b.h }
              : side === 'l'
                ? { x: b.x, y: b.cy }
                : { x: b.x + b.w, y: b.cy }
        dragRef.current = { kind: 'link', from: id, ax: pt.x, ay: pt.y }
        setRubber({ ax: pt.x, ay: pt.y, x: w.x, y: w.y })
      }
      return
    }
    // 节点：选中 + 开始拖动
    if (nodeEl) {
      const id = nodeEl.getAttribute('data-node-id') as string
      setPlacing(false)
      setSelection({ type: 'node', id })
      const pos = docRef.current.layout[id]
      if (pos) {
        mutate.snapshot()
        dragRef.current = { kind: 'node', id, startWX: w.x, startWY: w.y, orig: pos, moved: false }
      }
      return
    }
    // 连线：选中
    if (edgeEl) {
      setPlacing(false)
      setSelection({ type: 'edge', index: Number(edgeEl.getAttribute('data-edge-index')) })
      return
    }
    // 分组标题条 / 边框：整组拖动（组内节点跟随）
    if (groupEl) {
      setPlacing(false)
      const gid = groupEl.getAttribute('data-group-drag') as string
      const d = docRef.current
      const ids = groupMemberIds(d, gid)
      if (ids.length) {
        mutate.snapshot()
        const origs: Record<string, [number, number]> = {}
        for (const nid of ids) origs[nid] = d.layout[nid] ?? [0, 0]
        dragRef.current = { kind: 'group', gid, ids, startWX: w.x, startWY: w.y, origs, moved: false }
      }
      return
    }
    // 背景：放置模式 → 建节点；否则拖动平移
    if (placing) {
      setPlacing(false)
      placeNode(w.x, w.y)
      return
    }
    startPan(e)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(e.pointerId)) return
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    // 双指缩放（围绕双指中心）
    if (pinchRef.current && pointersRef.current.size >= 2) {
      const ps = [...pointersRef.current.values()]
      const d = Math.max(1, Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y))
      const cx = (ps[0].x + ps[1].x) / 2
      const cy = (ps[0].y + ps[1].y) / 2
      const p = pinchRef.current
      const k = Math.min(2.5, Math.max(0.3, p.view.k * (d / p.d)))
      setView({
        k,
        x: cx - (p.cx - p.view.x) * (k / p.view.k),
        y: cy - (p.cy - p.view.y) * (k / p.view.k),
      })
      return
    }
    const drag = dragRef.current
    if (!drag) return
    const w = toWorld(e.clientX, e.clientY)
    const d = docRef.current
    const snap = (v: number) => (snapGrid ? Math.round(v / 10) * 10 : v)
    if (drag.kind === 'pan') {
      const dx = e.clientX - drag.startCX
      const dy = e.clientY - drag.startCY
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
      setView({ ...drag.orig, x: drag.orig.x + dx, y: drag.orig.y + dy })
      return
    }
    if (drag.kind === 'node') {
      const dx = w.x - drag.startWX
      const dy = w.y - drag.startWY
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true
      if (!drag.moved) return
      mutate.update(
        { ...d, layout: { ...d.layout, [drag.id]: [snap(drag.orig[0] + dx), snap(drag.orig[1] + dy)] } },
        { history: false, immediate: false },
      )
      return
    }
    if (drag.kind === 'group') {
      const dx = w.x - drag.startWX
      const dy = w.y - drag.startWY
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true
      if (!drag.moved) return
      const layout = { ...d.layout }
      for (const nid of drag.ids) {
        const o = drag.origs[nid]
        layout[nid] = [snap(o[0] + dx), snap(o[1] + dy)]
      }
      mutate.update({ ...d, layout }, { history: false, immediate: false })
      return
    }
    // link 橡皮筋
    setRubber({ ax: drag.ax, ay: drag.ay, x: w.x, y: w.y })
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = containerRef.current
    if (el?.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId)
    pointersRef.current.delete(e.pointerId)
    if (pinchRef.current) {
      if (pointersRef.current.size < 2) pinchRef.current = null
      dragRef.current = null
      return
    }
    const drag = dragRef.current
    dragRef.current = null
    if (!drag) return
    const d = docRef.current
    if (drag.kind === 'pan') {
      if (!drag.moved) setSelection(null) // 空白点按 → 取消选择
      return
    }
    if (drag.kind === 'node' && drag.moved) {
      let next = d
      const pos = d.layout[drag.id]
      if (pos) {
        // 拖出 / 拖入分组边界 → 换组（重写源码时移动到对应 subgraph 块）
        const gid = groupAtPoint(d, gboxesRef.current, pos[0], pos[1])
        const cur = d.nodes.find((n) => n.id === drag.id)?.group
        if ((gid ?? undefined) !== cur) {
          next = { ...next, nodes: next.nodes.map((n) => (n.id === drag.id ? { ...n, group: gid } : n)) }
        }
      }
      mutate.update(next, { history: false, immediate: true }) // 松手即持久（立即写回 %%layout）
      return
    }
    if (drag.kind === 'group' && drag.moved) {
      let next = d
      // 组中心进入其他组 → 嵌套为其子组；拖离父组 → 解除嵌套
      const cx = drag.ids.reduce((a, id) => a + (d.layout[id]?.[0] ?? 0), 0) / Math.max(drag.ids.length, 1)
      const cy = drag.ids.reduce((a, id) => a + (d.layout[id]?.[1] ?? 0), 0) / Math.max(drag.ids.length, 1)
      const gid = groupAtPoint(d, gboxesRef.current, cx, cy, groupSubtreeIds(d, drag.gid))
      const cur = d.groups.find((g) => g.id === drag.gid)?.parent
      if ((gid ?? undefined) !== cur) {
        next = { ...next, groups: next.groups.map((g) => (g.id === drag.gid ? { ...g, parent: gid } : g)) }
      }
      mutate.update(next, { history: false, immediate: true })
      return
    }
    if (drag.kind === 'link') {
      setRubber(null)
      const w = toWorld(e.clientX, e.clientY)
      const hit = nodeAtPoint(d, boxesRef.current, w.x, w.y)
      if (hit && hit !== drag.from) {
        const style: FlowEdgeStyle = arrowOn ? '-->' : '---'
        if (d.edges.some((x) => x.from === drag.from && x.to === hit && (x.style ?? '-->') === style)) {
          toast('这条连线已存在')
        } else {
          mutate.update({ ...d, edges: [...d.edges, { from: drag.from, to: hit, style }] })
        }
      }
      return
    }
  }

  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = containerRef.current
    if (el?.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId)
    pointersRef.current.delete(e.pointerId)
    if (pointersRef.current.size < 2) pinchRef.current = null
    dragRef.current = null
    setRubber(null)
  }

  // ---- 键盘：Delete 删除 / 方向键微移（±10px，Shift=1px） ----
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (e.key === 'Escape') {
      setPlacing(false)
      setEditing(null)
      setSelection(null)
      return
    }
    if (!selection) return
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      deleteSelection()
      return
    }
    if (selection.type === 'node') {
      const step = e.shiftKey ? 1 : 10
      const delta: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      }
      const dd = delta[e.key]
      if (!dd) return
      e.preventDefault()
      const d = docRef.current
      const cur = d.layout[selection.id] ?? [0, 0]
      // 连续微移 700ms 内只入一次撤销栈
      const now = Date.now()
      if (now - nudgeTsRef.current > 700) mutate.snapshot()
      nudgeTsRef.current = now
      mutate.update(
        { ...d, layout: { ...d.layout, [selection.id]: [cur[0] + dd[0], cur[1] + dd[1]] } },
        { history: false, immediate: true },
      )
    }
  }

  const tbBtn =
    'h-7 rounded-full px-2.5 text-xs font-normal outline-none transition-colors hover:bg-accent hover:text-accent-foreground'

  return (
    <div className="flex flex-col gap-1.5">
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="画布工具栏">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-pressed={placing}
          className={cn(tbBtn, placing && 'border-primary text-primary')}
          onClick={() => {
            setPlacing((p) => !p)
            setSelection(null)
          }}
        >
          <Plus className="size-3.5" /> 节点
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={tool === 'select' ? '当前为选择工具' : '切换为选择工具'}
          aria-pressed={tool === 'select'}
          className={cn(tbBtn, tool === 'select' && 'border-primary text-primary')}
          onClick={() => setTool('select')}
        >
          <MousePointer2 className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="抓手平移工具"
          aria-pressed={tool === 'pan'}
          className={cn(tbBtn, tool === 'pan' && 'border-primary text-primary')}
          onClick={() => setTool('pan')}
        >
          <Hand className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="新连线箭头开关（关则为无箭头连线）"
          aria-pressed={arrowOn}
          className={cn(tbBtn, arrowOn && 'border-primary text-primary')}
          onClick={() => setArrowOn((v) => !v)}
        >
          <MoveRight className="size-3.5" /> 箭头
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="网格吸附开关（10px）"
          aria-pressed={snapGrid}
          className={cn(tbBtn, snapGrid && 'border-primary text-primary')}
          onClick={() => setSnapGrid((v) => !v)}
        >
          <Magnet className="size-3.5" /> 吸附
        </Button>
        <Button type="button" variant="outline" size="sm" className={tbBtn} onClick={applyAutoLayout}>
          <Wand2 className="size-3.5" /> 自动布局
        </Button>
        <Button type="button" variant="outline" size="sm" className={tbBtn} onClick={() => fitView()}>
          <Maximize2 className="size-3.5" /> 适应
        </Button>
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="缩小"
            className="h-7 w-7 rounded-full p-0"
            onClick={() => zoomCenter(1 / 1.25)}
          >
            <ZoomOut className="size-3.5" />
          </Button>
          <span
            className="min-w-10 text-center text-[11px] tabular-nums text-muted-foreground"
            aria-label={`缩放 ${Math.round(view.k * 100)}%`}
          >
            {Math.round(view.k * 100)}%
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="放大"
            className="h-7 w-7 rounded-full p-0"
            onClick={() => zoomCenter(1.25)}
          >
            <ZoomIn className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* 画布 */}
      <div
        ref={containerRef}
        role="application"
        aria-label="流程图画布：拖动节点、从节点边缘圆点拖出连线、双击改文字、滚轮或双指缩放"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onContextMenu={(e) => e.preventDefault()}
        className={cn(
          'relative h-[46dvh] min-h-56 touch-none select-none overflow-hidden rounded-xl border border-border bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
          tool === 'pan' ? 'cursor-grab' : placing ? 'cursor-crosshair' : 'cursor-default',
        )}
        style={{
          backgroundImage: 'radial-gradient(var(--border) 1px, transparent 1px)',
          backgroundSize: `${20 * view.k}px ${20 * view.k}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      >
        <svg className="absolute inset-0 h-full w-full" aria-hidden>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {/* 分组容器（外层先画：虚线圆角大框 + 标题，标题条/边框可整体拖动） */}
            {[...gboxes.entries()]
              .sort((a, b) => a[1].depth - b[1].depth)
              .map(([gid, b]) => {
                const g = doc.groups.find((x) => x.id === gid)
                if (!g) return null
                return (
                  <g key={gid}>
                    <rect
                      x={b.x}
                      y={b.y}
                      width={b.w}
                      height={b.h}
                      rx={12}
                      className="fill-muted/20 stroke-muted-foreground/50"
                      style={{ strokeDasharray: '7 5', strokeWidth: 1.2 }}
                    />
                    <text x={b.x + 10} y={b.y + 18} fontSize={12} className="fill-muted-foreground">
                      {g.title}
                    </text>
                    <rect
                      x={b.x}
                      y={b.y}
                      width={b.w}
                      height={24}
                      fill="transparent"
                      data-group-drag={gid}
                      className="cursor-grab"
                    />
                    <rect
                      x={b.x}
                      y={b.y}
                      width={b.w}
                      height={b.h}
                      rx={12}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={12}
                      pointerEvents="stroke"
                      data-group-drag={gid}
                      className="cursor-grab"
                    />
                  </g>
                )
              })}

            {/* 连线（带箭头 + 标签） */}
            {doc.edges.map((e, i) => {
              const a = boxes.get(e.from)
              const b = boxes.get(e.to)
              if (!a || !b) return null
              const sel = selection?.type === 'edge' && selection.index === i
              const style = e.style ?? '-->'
              const hasArrow = style !== '---'
              const thick = style === '==>' ? 3 : 1.8
              let dstr: string
              let head: string | null = null
              let labelX: number
              let labelY: number
              if (e.from === e.to) {
                // 自环
                const lx = a.x
                const ly = a.cy
                const tx = a.cx
                const ty = a.y
                const c1x = lx - 48
                const c1y = ly + 30
                const c2x = lx - 48
                const c2y = ty - 44
                dstr = `M ${lx} ${ly} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`
                if (hasArrow) head = flowArrowHead(c2x, c2y, tx, ty, 8 + thick).head
                labelX = lx - 50
                labelY = ly - 18
              } else {
                const p = flowEdgeAnchors(a, b)
                const size = 8 + thick * 1.4
                const arr = hasArrow ? flowArrowHead(p.x1, p.y1, p.x2, p.y2, size) : null
                const end = arr ? arr.lineEnd : [p.x2, p.y2]
                dstr = `M ${p.x1} ${p.y1} L ${end[0]} ${end[1]}`
                head = arr?.head ?? null
                labelX = (p.x1 + p.x2) / 2
                labelY = (p.y1 + p.y2) / 2 - 7
              }
              return (
                <g key={i}>
                  <path
                    d={dstr}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={16}
                    pointerEvents="stroke"
                    data-edge-index={i}
                    className="cursor-pointer"
                  />
                  <path
                    d={dstr}
                    fill="none"
                    className={sel ? 'stroke-primary' : 'stroke-muted-foreground'}
                    style={{
                      strokeWidth: sel ? thick + 1.2 : thick,
                      strokeDasharray: style === '-.->' ? '7 5' : undefined,
                      strokeLinecap: 'round',
                    }}
                    pointerEvents="none"
                  />
                  {head && (
                    <path
                      d={head}
                      className={sel ? 'fill-primary' : 'fill-muted-foreground'}
                      pointerEvents="none"
                    />
                  )}
                  {e.label && (
                    <text
                      x={labelX}
                      y={labelY}
                      textAnchor="middle"
                      fontSize={11}
                      className="fill-foreground"
                      style={{ paintOrder: 'stroke', stroke: 'var(--background)', strokeWidth: 3.5 }}
                      pointerEvents="none"
                    >
                      {e.label}
                    </text>
                  )}
                </g>
              )
            })}

            {/* 节点 */}
            {doc.nodes.map((n) => {
              const b = boxes.get(n.id)
              if (!b) return null
              const sel = selection?.type === 'node' && selection.id === n.id
              return (
                <g
                  key={n.id}
                  data-node-id={n.id}
                  className="cursor-grab"
                  onDoubleClick={() => openRename(n.id)}
                >
                  <FlowShapeFigure
                    shape={n.shape}
                    x={b.x}
                    y={b.y}
                    w={b.w}
                    h={b.h}
                    fill={n.fill}
                    selected={sel}
                  />
                  {sel && (
                    <rect
                      x={b.x - 6}
                      y={b.y - 6}
                      width={b.w + 12}
                      height={b.h + 12}
                      rx={8}
                      fill="none"
                      stroke="var(--primary)"
                      style={{ strokeWidth: 1.2, strokeDasharray: '5 4' }}
                      pointerEvents="none"
                    />
                  )}
                  {b.lines.map((l, li) => (
                    <text
                      key={li}
                      x={b.cx}
                      y={b.cy + 4.5 + (li - (b.lines.length - 1) / 2) * 15}
                      textAnchor="middle"
                      fontSize={13}
                      style={n.fill ? { fill: '#111827' } : undefined}
                      className={n.fill ? undefined : 'fill-foreground'}
                      pointerEvents="none"
                    >
                      {l}
                    </text>
                  ))}
                </g>
              )
            })}

            {/* 选中节点的连接锚点（上下左右 4 个小圆点） */}
            {selNode &&
              (() => {
                const b = boxes.get(selNode.id)
                if (!b) return null
                const pts: Array<[string, number, number]> = [
                  ['t', b.cx, b.y],
                  ['r', b.x + b.w, b.cy],
                  ['b', b.cx, b.y + b.h],
                  ['l', b.x, b.cy],
                ]
                return pts.map(([side, ax, ay]) => (
                  <circle
                    key={side}
                    cx={ax}
                    cy={ay}
                    r={5}
                    data-link-anchor={side}
                    data-node-id={selNode.id}
                    className="fill-background stroke-primary cursor-crosshair"
                    style={{ strokeWidth: 1.6 }}
                  />
                ))
              })()}

            {/* 橡皮筋连线 */}
            {rubber && (
              <line
                x1={rubber.ax}
                y1={rubber.ay}
                x2={rubber.x}
                y2={rubber.y}
                className="stroke-primary"
                style={{ strokeWidth: 2, strokeDasharray: '6 4' }}
                pointerEvents="none"
              />
            )}
          </g>
        </svg>

        {/* 空画布提示 */}
        {doc.nodes.length === 0 && !placing && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
              画布为空，点工具栏「节点」添加
            </p>
          </div>
        )}

        {/* 放置模式提示 */}
        {placing && (
          <div className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full bg-primary px-3 py-1 text-[11px] text-primary-foreground shadow">
            点击画布放置节点，Esc 取消
          </div>
        )}

        {/* 选中节点：浮动工具条（形状 7 种 + 填充色 6 选 + 改名 + 删除） */}
        {selNode && (
          <div
            data-overlay
            className="absolute left-1/2 top-2 z-10 flex max-w-[calc(100%-12px)] -translate-x-1/2 flex-wrap items-center justify-center gap-0.5 rounded-xl border border-border bg-background/95 p-1 shadow-lg"
          >
            {FLOW_SHAPES.map((s) => (
              <button
                key={s.value}
                type="button"
                title={`${s.label} ${s.syntax}`}
                aria-label={`形状：${s.label}`}
                aria-pressed={selNode.shape === s.value}
                onClick={() => setNodeShape(s.value)}
                className={cn('rounded-lg p-1', selNode.shape === s.value ? 'bg-primary/10' : 'hover:bg-muted')}
              >
                <svg width={22} height={14} viewBox="0 0 22 14" aria-hidden>
                  <FlowShapeFigure
                    shape={s.value}
                    x={1.5}
                    y={1.5}
                    w={19}
                    h={11}
                    mini
                    selected={selNode.shape === s.value}
                  />
                </svg>
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            <button
              type="button"
              title="默认填充"
              aria-label="清除填充色"
              onClick={() => setNodeFill(undefined)}
              className="rounded-full p-0.5 hover:bg-muted"
            >
              <span className="block size-4 rounded-full border border-dashed border-border" aria-hidden />
            </button>
            {FLOW_FILLS.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                aria-label={`填充色 ${c}`}
                onClick={() => setNodeFill(c)}
                className={cn('rounded-full p-0.5 hover:bg-muted', selNode.fill === c && 'ring-2 ring-primary ring-offset-1')}
              >
                <span className="block size-4 rounded-full border border-border" style={{ background: c }} aria-hidden />
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            <button
              type="button"
              aria-label="重命名节点"
              onClick={() => openRename(selNode.id)}
              className="rounded-lg p-1.5 hover:bg-muted"
            >
              <Pencil className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label="删除节点"
              onClick={deleteSelection}
              className="rounded-lg p-1.5 hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        )}

        {/* 选中连线：标签 / 样式 / 反转 / 删除 */}
        {selEdge && (
          <div
            data-overlay
            className="absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 flex-wrap items-center gap-1 rounded-xl border border-border bg-background/95 p-1 shadow-lg"
          >
            <Input
              value={edgeDraft}
              onChange={(ev) => setEdgeDraft(ev.target.value)}
              onBlur={commitEdgeLabel}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') commitEdgeLabel()
              }}
              placeholder="连线标签"
              aria-label="连线标签"
              className="h-7 w-28 rounded-lg text-xs"
            />
            <Select value={selEdge.style ?? '-->'} onValueChange={(v) => setEdgeStyle(v as FlowEdgeStyle)}>
              <SelectTrigger size="sm" aria-label="连线样式" className="h-7 w-[96px] rounded-lg text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FLOW_EDGE_STYLES.map((s) => (
                  <SelectItem key={s.value} value={s.value} className="text-xs">
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              type="button"
              aria-label="反转连线方向"
              onClick={swapEdge}
              className="rounded-lg p-1.5 hover:bg-muted"
            >
              <ArrowLeftRight className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label="删除连线"
              onClick={deleteSelection}
              className="rounded-lg p-1.5 hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        )}

        {/* 就地改名输入框（跟随节点位置） */}
        {editing &&
          (() => {
            const b = boxes.get(editing)
            if (!b) return null
            const iw = Math.max(b.w * view.k, 64)
            return (
              <div
                data-overlay
                className="absolute z-20"
                style={{ left: b.cx * view.k + view.x - iw / 2, top: b.cy * view.k + view.y - 12, width: iw }}
              >
                <input
                  value={draft}
                  autoFocus
                  aria-label="节点名称"
                  onChange={(ev) => setDraft(ev.target.value)}
                  onFocus={(ev) => ev.target.select()}
                  onBlur={commitRename}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter') commitRename()
                    if (ev.key === 'Escape') setEditing(null)
                  }}
                  className="h-6 w-full rounded-md border-2 border-primary bg-background px-1 text-center text-xs outline-none"
                />
              </div>
            )
          })()}
      </div>
    </div>
  )
}

// ---------- 列表模式（表单编辑，与画布共享同一 FlowDoc 与撤销栈） ----------

function FlowListEditor({ doc, mutate }: { doc: FlowDoc; mutate: FlowMutate }) {
  const [section, setSection] = React.useState<'nodes' | 'edges'>('nodes')

  const genId = () => {
    let i = doc.nodes.length + 1
    let id = `N${i}`
    while (doc.nodes.some((n) => n.id === id)) {
      i += 1
      id = `N${i}`
    }
    return id
  }
  const setNode = (id: string, patch: Partial<FlowDocNode>) =>
    mutate.update({ ...doc, nodes: doc.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) })
  const addNode = () => {
    const id = genId()
    const k = doc.nodes.length
    mutate.update({
      ...doc,
      nodes: [...doc.nodes, { id, label: '新节点', shape: 'rect' }],
      layout: { ...doc.layout, [id]: [100 + (k % 5) * 110, 80 + Math.floor(k / 5) * 100] },
    })
  }
  const delNode = (id: string) =>
    mutate.update({
      ...doc,
      nodes: doc.nodes.filter((n) => n.id !== id),
      edges: doc.edges.filter((e) => e.from !== id && e.to !== id),
    })
  const setEdge = (i: number, patch: Partial<FlowDocEdge>) =>
    mutate.update({ ...doc, edges: doc.edges.map((e, k) => (k === i ? { ...e, ...patch } : e)) })
  const addEdge = () => {
    if (doc.nodes.length < 2) {
      toast.warning('请先添加至少两个节点')
      return
    }
    mutate.update({
      ...doc,
      edges: [...doc.edges, { from: doc.nodes[0].id, to: doc.nodes[1].id, style: '-->' }],
    })
  }

  const delBtn = 'shrink-0 rounded p-1 text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive'
  const groupTitleOf = (gid?: string) => doc.groups.find((g) => g.id === gid)?.title

  return (
    <div className="flex flex-col gap-2">
      {/* 分区切换 */}
      <div className="flex rounded-full bg-muted p-1" role="tablist" aria-label="流程图编辑分区">
        {(
          [
            { key: 'nodes' as const, label: `节点 ${doc.nodes.length}` },
            { key: 'edges' as const, label: `连线 ${doc.edges.length}` },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={section === t.key}
            onClick={() => setSection(t.key)}
            className={cn(
              'rounded-full px-3 py-1 text-xs transition-colors',
              section === t.key
                ? 'bg-background font-medium text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="max-h-[46dvh] space-y-1.5 overflow-y-auto rounded-xl border border-border p-2">
        {section === 'nodes' ? (
          <>
            {doc.nodes.map((n) => (
              <div key={n.id} className="flex flex-wrap items-center gap-1.5">
                <span
                  className="shrink-0 rounded-md bg-muted px-1.5 py-1 font-mono text-[10px] text-muted-foreground"
                  aria-label={`节点标识 ${n.id}`}
                >
                  {n.id}
                </span>
                <Input
                  value={n.label}
                  aria-label={`节点 ${n.id} 名称`}
                  onChange={(e) => setNode(n.id, { label: e.target.value })}
                  className="h-8 min-w-0 flex-1 rounded-lg text-sm"
                />
                {n.group && groupTitleOf(n.group) && (
                  <span
                    className="shrink-0 rounded-md border border-dashed border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                    title="所属分组（画布中拖出/拖入可换组）"
                  >
                    {groupTitleOf(n.group)}
                  </span>
                )}
                <Select value={n.shape} onValueChange={(v) => setNode(n.id, { shape: v as FlowNodeShape })}>
                  <SelectTrigger
                    size="sm"
                    aria-label={`节点 ${n.id} 形状`}
                    className="h-8 w-[122px] shrink-0 rounded-lg text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FLOW_SHAPES.map((s) => (
                      <SelectItem key={s.value} value={s.value} className="text-xs">
                        {s.label} {s.syntax}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <button
                  type="button"
                  aria-label={`删除节点 ${n.id}`}
                  onClick={() => delNode(n.id)}
                  className={delBtn}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-full rounded-full text-xs"
              onClick={addNode}
            >
              <Plus className="size-3.5" /> 添加节点
            </Button>
          </>
        ) : (
          <>
            {doc.edges.map((e, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1.5">
                <Select value={e.from} onValueChange={(v) => setEdge(i, { from: v })}>
                  <SelectTrigger
                    size="sm"
                    aria-label={`连线 ${i + 1} 起点`}
                    className="h-8 min-w-20 flex-1 rounded-lg text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {doc.nodes.map((n) => (
                      <SelectItem key={n.id} value={n.id} className="text-xs">
                        {n.label || n.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span aria-hidden className="text-xs text-muted-foreground">
                  {e.style === '---' ? '—' : e.style === '==>' ? '⇒' : e.style === '-.->' ? '⇢' : '→'}
                </span>
                <Select value={e.to} onValueChange={(v) => setEdge(i, { to: v })}>
                  <SelectTrigger
                    size="sm"
                    aria-label={`连线 ${i + 1} 终点`}
                    className="h-8 min-w-20 flex-1 rounded-lg text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {doc.nodes.map((n) => (
                      <SelectItem key={n.id} value={n.id} className="text-xs">
                        {n.label || n.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={e.label ?? ''}
                  placeholder="连线文字（可空）"
                  aria-label={`连线 ${i + 1} 文字`}
                  onChange={(ev) => setEdge(i, { label: ev.target.value || undefined })}
                  className="h-8 min-w-24 flex-1 rounded-lg text-xs"
                />
                <Select value={e.style ?? '-->'} onValueChange={(v) => setEdge(i, { style: v as FlowEdgeStyle })}>
                  <SelectTrigger
                    size="sm"
                    aria-label={`连线 ${i + 1} 样式`}
                    className="h-8 w-[108px] shrink-0 rounded-lg text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FLOW_EDGE_STYLES.map((s) => (
                      <SelectItem key={s.value} value={s.value} className="text-xs">
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <button
                  type="button"
                  aria-label={`删除连线 ${i + 1}`}
                  onClick={() => mutate.update({ ...doc, edges: doc.edges.filter((_, k) => k !== i) })}
                  className={delBtn}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-full rounded-full text-xs"
              onClick={addEdge}
              disabled={doc.nodes.length < 2}
            >
              <Plus className="size-3.5" /> 添加连线
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

// ---------- 流程图编辑器容器（画布 ⇄ 列表 + 方向 + 撤销重做） ----------

function FlowGraphEditor({
  doc,
  warn,
  onDocChange,
}: {
  doc: FlowDoc
  /** 解析容错黄条提示（null = 无） */
  warn: string | null
  /** immediate=false 时位置类修改防抖 600ms 写回源码 */
  onDocChange: (next: FlowDoc, immediate?: boolean) => void
}) {
  const [mode, setMode] = React.useState<'canvas' | 'list'>('canvas')
  const [hist, setHist] = React.useState<{ undo: FlowDoc[]; redo: FlowDoc[] }>({ undo: [], redo: [] })
  const docRef = React.useRef(doc)
  const histRef = React.useRef(hist)
  // 同步镜像 ref（撤销重做里读最新值；useLayoutEffect 保证下一次事件触发前已写入）
  React.useLayoutEffect(() => {
    docRef.current = doc
  })
  React.useLayoutEffect(() => {
    histRef.current = hist
  })
  const canUndo = hist.undo.length > 0
  const canRedo = hist.redo.length > 0

  // 撤销重做（独立于弹窗其它编辑器；栈深 50）
  const mutate = React.useMemo<FlowMutate>(
    () => ({
      snapshot: () => {
        const h = histRef.current
        setHist({ undo: [...h.undo, docRef.current].slice(-50), redo: [] })
      },
      update: (next, opts) => {
        if (opts?.history !== false) {
          const h = histRef.current
          setHist({ undo: [...h.undo, docRef.current].slice(-50), redo: [] })
        }
        onDocChange(next, opts?.immediate ?? true)
      },
      undo: () => {
        const h = histRef.current
        const prev = h.undo[h.undo.length - 1]
        if (!prev) return
        setHist({ undo: h.undo.slice(0, -1), redo: [...h.redo, docRef.current].slice(-50) })
        onDocChange(prev, true)
      },
      redo: () => {
        const h = histRef.current
        const next = h.redo[h.redo.length - 1]
        if (!next) return
        setHist({ undo: [...h.undo, docRef.current].slice(-50), redo: h.redo.slice(0, -1) })
        onDocChange(next, true)
      },
    }),
    [onDocChange],
  )

  return (
    <div className="flex flex-col gap-2">
      {/* 模式切换 + 撤销重做 + 方向 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-full bg-muted p-1" role="tablist" aria-label="流程图编辑模式">
          {(
            [
              { key: 'canvas' as const, label: '画布' },
              { key: 'list' as const, label: '列表' },
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={mode === t.key}
              onClick={() => setMode(t.key)}
              className={cn(
                'rounded-full px-3 py-1 text-xs transition-colors',
                mode === t.key
                  ? 'bg-background font-medium text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            aria-label="撤销"
            disabled={!canUndo}
            onClick={mutate.undo}
            className="h-7 w-7 rounded-full p-0"
          >
            <Undo2 className="size-3.5" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label="重做"
            disabled={!canRedo}
            onClick={mutate.redo}
            className="h-7 w-7 rounded-full p-0"
          >
            <Redo2 className="size-3.5" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label="自上而下布局"
            className={cn(
              'h-7 rounded-full px-2.5 text-xs',
              (doc.dir === 'TD' || doc.dir === 'TB') && 'border-primary text-primary',
            )}
            onClick={() => mutate.update({ ...doc, dir: 'TD' })}
          >
            纵向
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label="自左向右布局"
            className={cn('h-7 rounded-full px-2.5 text-xs', doc.dir === 'LR' && 'border-primary text-primary')}
            onClick={() => mutate.update({ ...doc, dir: 'LR' })}
          >
            横向
          </Button>
        </div>
      </div>

      {/* 解析容错黄条 */}
      {warn && (
        <div
          role="status"
          className="flex items-start gap-1.5 rounded-xl border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <p className="min-w-0 flex-1 break-words">{warn}</p>
        </div>
      )}

      {mode === 'canvas' ? (
        <FlowCanvasEditor doc={doc} mutate={mutate} />
      ) : (
        <FlowListEditor doc={doc} mutate={mutate} />
      )}

      <p className="text-[11px] text-muted-foreground">
        {mode === 'canvas'
          ? '拖动节点 / 分组标题排版（拖到虚线分组内外自动换组）；点选节点后从边缘圆点拖出连线（工具栏可关箭头）；双击改文字，Delete 删除；滚轮或双指缩放，空白处拖动平移，方向键微移'
          : '节点：改名 / 换形状 / 删除（自动移除相关连线）；连线：选起点终点、可加标签与样式；两模式共享同一数据与撤销栈'}
      </p>
    </div>
  )
}

// ---------- HTML 可视化编辑器（```html 围栏：结构树 + 属性面板 + 沙盒预览） ----------
//
// 数据流：源码 → DOMParser 宽容解析为可序列化的 HtmlTreeNode 树（script /
// on* / js: 在解析侧即剔除）→ 元素树 / 属性面板 / 快速插入的可视化操作
// 不可变更新 → serializeHtmlTree 写回宿主 src → 既有校验容错链
// （validateHtmlSrc 黄条 + AI 修复 + 仍用原文）照常工作。
// 自己 emit 的源码跳过回环解析（防打断输入焦点）；外部变化（源码 tab 手改 /
// AI 写入 / 重新打开引用）自动重解析。序列化输出保证：无 script、无 on*、
// 无 js: 链接（防溢出由渲染端沙盒的 max-width:100% 兜底）。

/** 嵌入 HTML 本地净化（与 rich-content 沙盒 sanitizeEmbeddedHtml 同一规则：
 *  去 <script> / on* 事件 / javascript: 链接）。 */
function sanitizeHtmlCode(code: string): string {
  return code
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/((?:xlink:)?href\s*=\s*)(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '$1"#"')
}

/** 可编辑树节点：元素（标签 + 属性 + 子节点）或文本 */
type HtmlTreeNode =
  | { type: 'el'; tag: string; attrs: Record<string, string>; children: HtmlTreeNode[] }
  | { type: 'text'; text: string }

type HtmlElNode = Extract<HtmlTreeNode, { type: 'el' }>

/** HTML void 元素（无闭合标签；序列化不输出 </tag>，校验不参与配对） */
const HTML_VOID_TAGS = new Set([
  'br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'track', 'wbr',
])

/** 块级元素集合（格式化时独立成行缩进；行内元素保持单行） */
const HTML_BLOCK_TAGS = new Set([
  'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody',
  'tfoot', 'tr', 'td', 'th', 'blockquote', 'section', 'article', 'header', 'footer', 'nav',
  'aside', 'main', 'figure', 'figcaption', 'form', 'details', 'summary', 'hr',
])

/** 标签变更候选（p↔h1..h6↔div 等常见互换） */
const HTML_RENAME_TAGS = [
  'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'blockquote', 'section',
] as const

const htmlEl = (tag: string, children: HtmlTreeNode[] = [], attrs: Record<string, string> = {}): HtmlElNode => ({
  type: 'el',
  tag,
  attrs,
  children,
})
const htmlText = (text: string): HtmlTreeNode => ({ type: 'text', text })

/** 快速插入图片的占位图（内联 SVG data URI，不依赖外部资源） */
const HTML_PLACEHOLDER_IMG =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="100%" height="100%" fill="#e4e4e7"/><text x="50%" y="50%" text-anchor="middle" dy="0.35em" font-size="12" fill="#71717a">图片</text></svg>',
  )

/** DOM 节点 → 可编辑树节点（script 剔除；on* 事件 / js: 属性剔除；空白文本丢弃） */
function domToHtmlNode(node: Node): HtmlTreeNode | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ')
    return text.trim() ? { type: 'text', text } : null
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null // 注释等不参与可视化
  const el = node as Element
  if (el.tagName.toLowerCase() === 'script') return null
  const attrs: Record<string, string> = {}
  for (const a of Array.from(el.attributes)) {
    if (/^on/i.test(a.name)) continue
    if (/^href$/i.test(a.name) && /^\s*javascript:/i.test(a.value)) continue
    attrs[a.name] = a.value
  }
  const children: HtmlTreeNode[] = []
  for (const c of Array.from(el.childNodes)) {
    const n = domToHtmlNode(c)
    if (n) children.push(n)
  }
  return { type: 'el', tag: el.tagName.toLowerCase(), attrs, children }
}

/** HTML 源码 → 顶层节点列表（DOMParser 宽容解析；异常回空树，原码不丢） */
function parseHtmlFragment(code: string): HtmlTreeNode[] {
  const t = (code || '').trim()
  if (!t) return []
  try {
    const doc = new DOMParser().parseFromString(t, 'text/html')
    // 常规片段：取 body 子节点；完整小页面（head 里有内容）时回退 documentElement
    let list = Array.from(doc.body.childNodes)
    if (list.length === 0 && doc.documentElement) list = Array.from(doc.documentElement.childNodes)
    const out: HtmlTreeNode[] = []
    for (const c of list) {
      const n = domToHtmlNode(c)
      if (n) out.push(n)
    }
    return out
  } catch {
    return []
  }
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/** 属性表 → 源码片段（输出侧再过滤一道 on* 事件 / js:，与解析侧双保险） */
function serializeHtmlAttrs(attrs: Record<string, string>): string {
  const parts = Object.entries(attrs)
    .filter(
      ([k, v]) => !/^on/i.test(k) && !(/^href$/i.test(k) && /^\s*javascript:/i.test(v)),
    )
    .map(([k, v]) => (v === '' ? k : `${k}="${escapeHtmlAttr(v)}"`))
  return parts.length ? ' ' + parts.join(' ') : ''
}

/** 树 → HTML 源码（script 不输出；void 元素不闭合；文本/属性转义） */
function serializeHtmlTree(nodes: HtmlTreeNode[]): string {
  const out = (n: HtmlTreeNode): string => {
    if (n.type === 'text') return escapeHtmlText(n.text)
    if (n.tag === 'script') return ''
    const open = `<${n.tag}${serializeHtmlAttrs(n.attrs)}>`
    if (HTML_VOID_TAGS.has(n.tag)) return open
    return `${open}${n.children.map(out).join('')}</${n.tag}>`
  }
  return nodes.map(out).join('\n')
}

// ---------- 路径操作（不可变更新） ----------

/** 取路径上的节点（null = 路径失效） */
function getNodeAt(nodes: HtmlTreeNode[], path: number[]): HtmlTreeNode | null {
  let cur: HtmlTreeNode | null = null
  let list: HtmlTreeNode[] = nodes
  for (const idx of path) {
    cur = list[idx] ?? null
    if (!cur) return null
    list = cur.type === 'el' ? cur.children : []
  }
  return cur
}

/** 按路径替换节点（不可变） */
function updateNodeAt(
  nodes: HtmlTreeNode[],
  path: number[],
  fn: (n: HtmlTreeNode) => HtmlTreeNode,
): HtmlTreeNode[] {
  if (path.length === 0) return nodes
  const [head, ...rest] = path
  return nodes.map((n, i) => {
    if (i !== head) return n
    if (rest.length === 0) return fn(n)
    if (n.type !== 'el') return n
    return { ...n, children: updateNodeAt(n.children, rest, fn) }
  })
}

/** 删除路径上的节点（不可变） */
function removeNodeAt(nodes: HtmlTreeNode[], path: number[]): HtmlTreeNode[] {
  if (path.length === 0) return nodes
  const parentPath = path.slice(0, -1)
  const idx = path[path.length - 1]
  return updateNodeAt(nodes, parentPath, (p) =>
    p.type === 'el' ? { ...p, children: p.children.filter((_, i) => i !== idx) } : p,
  )
}

/** 在路径节点之后插入兄弟（不可变） */
function insertAfterAt(nodes: HtmlTreeNode[], path: number[], node: HtmlTreeNode): HtmlTreeNode[] {
  if (path.length === 0) return [...nodes, node]
  const parentPath = path.slice(0, -1)
  const idx = path[path.length - 1]
  return updateNodeAt(nodes, parentPath, (p) =>
    p.type === 'el'
      ? { ...p, children: [...p.children.slice(0, idx + 1), node, ...p.children.slice(idx + 1)] }
      : p,
  )
}

/** 兄弟序上移/下移（不可变；越界原样返回） */
function moveSiblingAt(nodes: HtmlTreeNode[], path: number[], dir: -1 | 1): HtmlTreeNode[] {
  if (path.length === 0) return nodes
  const parentPath = path.slice(0, -1)
  const idx = path[path.length - 1]
  const j = idx + dir
  return updateNodeAt(nodes, parentPath, (p) => {
    if (p.type !== 'el') return p
    if (j < 0 || j >= p.children.length) return p
    const children = [...p.children]
    const [x] = children.splice(idx, 1)
    children.splice(j, 0, x)
    return { ...p, children }
  })
}

/** 深拷贝（复制元素用；树节点是纯数据） */
function cloneHtmlNode(n: HtmlTreeNode): HtmlTreeNode {
  return JSON.parse(JSON.stringify(n)) as HtmlTreeNode
}

// ---------- 内联样式 ⇄ 键值表 ----------

/** style 内联样式串 → 键值表（容错按 ; 与 : 拆分，键统一小写） */
function parseInlineStyle(style: string): Record<string, string> {
  const rec: Record<string, string> = {}
  for (const part of (style || '').split(';')) {
    const i = part.indexOf(':')
    if (i <= 0) continue
    const k = part.slice(0, i).trim().toLowerCase()
    const v = part.slice(i + 1).trim()
    if (k && v) rec[k] = v
  }
  return rec
}

/** 键值表 → style 串（保持插入顺序；空值剔除） */
function buildInlineStyle(rec: Record<string, string>): string {
  return Object.entries(rec)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ')
}

/** 任意 CSS 颜色值 → 可供 <input type="color"> 的 #rrggbb（解析不了回退默认） */
function toHexColor(v: string | undefined, fallback: string): string {
  const t = (v ?? '').trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(t)) return t
  const m = t.match(/^#([0-9a-f]{3})$/)
  if (m) return '#' + m[1].split('').map((c) => c + c).join('')
  return fallback
}

// ---------- 源码格式化（块级元素换行 + 两空格缩进） ----------

function prettyHtmlNodes(nodes: HtmlTreeNode[], depth: number): string[] {
  const pad = '  '.repeat(depth)
  const lines: string[] = []
  for (const n of nodes) {
    if (n.type === 'text') {
      const t = n.text.trim()
      if (t) lines.push(pad + escapeHtmlText(t))
      continue
    }
    // 行内元素（span/a/b/strong…）→ 保持单行（serializeHtmlTree 已含转义与子级）
    if (!HTML_BLOCK_TAGS.has(n.tag)) {
      lines.push(pad + serializeHtmlTree([n]))
      continue
    }
    // 块级元素：子级全是文本/行内元素 → 单行（p/h*/li/td 等最常见、最可读）
    const inlineOnly = n.children.every(
      (c) => c.type === 'text' || (c.type === 'el' && !HTML_BLOCK_TAGS.has(c.tag)),
    )
    if (inlineOnly) {
      lines.push(pad + serializeHtmlTree([n]))
      continue
    }
    const open = `<${n.tag}${serializeHtmlAttrs(n.attrs)}>`
    lines.push(pad + open)
    lines.push(...prettyHtmlNodes(n.children, depth + 1))
    lines.push(`${pad}</${n.tag}>`)
  }
  return lines
}

/** HTML 源码格式化：解析后按块级元素缩进重排（解析失败原样返回） */
function prettyPrintHtml(code: string): string {
  const nodes = parseHtmlFragment(code)
  if (nodes.length === 0) return code || ''
  return prettyHtmlNodes(nodes, 0).join('\n')
}

// ---------- 编辑器子组件 ----------

/** 编辑器内联预览：Shadow DOM 沙盒（样式/布局双向隔离 + max-width 防溢出） */
function HtmlPreviewSandbox({ html }: { html: string }) {
  const hostRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    // 与 rich-content 的 HtmlSandbox 同款基础样式：内容永不撑破容器
    root.innerHTML = `<style>
      :host { display: block; max-width: 100%; overflow-x: auto; contain: layout style; }
      * { max-width: 100%; }
      img { max-width: 100%; height: auto; }
      table { max-width: 100%; border-collapse: collapse; }
    </style>${sanitizeHtmlCode(html)}`
  }, [html])
  return <div ref={hostRef} className="min-w-0 max-w-full overflow-x-auto" />
}

/** 元素树节点行（递归；点击选中，可折叠） */
function HtmlTreeItemView({
  node,
  path,
  sel,
  onSelect,
}: {
  node: HtmlTreeNode
  path: number[]
  sel: number[] | null
  onSelect: (p: number[]) => void
}) {
  const [open, setOpen] = React.useState(true)
  const isSel = sel != null && sel.length === path.length && sel.every((v, i) => v === path[i])
  const hasElChildren = node.type === 'el' && node.children.some((c) => c.type === 'el')
  const label =
    node.type === 'text'
      ? node.text.trim().slice(0, 14) || '（空文本）'
      : (node.children.find((c) => c.type === 'text') as { text?: string } | undefined)?.text
          ?.trim()
          .slice(0, 14) ?? ''
  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-1 rounded-lg px-1',
          isSel && 'bg-accent',
        )}
      >
        {hasElChildren ? (
          <button
            type="button"
            aria-label={open ? '折叠' : '展开'}
            onClick={() => setOpen((o) => !o)}
            className="shrink-0 rounded p-0.5 text-muted-foreground"
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        ) : (
          <span className="w-[18px] shrink-0" />
        )}
        <button
          type="button"
          onClick={() => onSelect(path)}
          aria-label={`选中节点 ${node.type === 'el' ? node.tag : '文本'}`}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left"
        >
          {node.type === 'el' ? (
            <span
              className={cn(
                'shrink-0 rounded bg-muted px-1 py-0.5 font-mono text-[10px] font-semibold',
                isSel && 'bg-primary/15 text-primary',
              )}
            >
              {node.tag}
            </span>
          ) : (
            <Type className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-[11px] text-muted-foreground">{label}</span>
        </button>
      </div>
      {node.type === 'el' && open && node.children.length > 0 && (
        <div className="ml-3 border-l border-border pl-1">
          {node.children.map((c, i) => (
            <HtmlTreeItemView
              key={`${i}-${c.type === 'el' ? c.tag : 'text'}`}
              node={c}
              path={[...path, i]}
              sel={sel}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** 选中节点 → 属性面板：文字 / 标签 / 常用内联样式 / 专属属性 / 复制删除移动 */
function HtmlNodePanel({
  node,
  isFirst,
  isLast,
  onPatch,
  onDelete,
  onDuplicate,
  onMoveUp,
  onMoveDown,
}: {
  node: HtmlTreeNode
  /** 兄弟序：首个/末个（上移/下移禁用） */
  isFirst: boolean
  isLast: boolean
  /** 不可变更新当前节点 */
  onPatch: (fn: (n: HtmlTreeNode) => HtmlTreeNode) => void
  onDelete: () => void
  onDuplicate: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}) {
  const labelSm = 'text-[11px] font-medium text-muted-foreground'

  // ---- 文本节点：只编辑文字 ----
  if (node.type === 'text') {
    return (
      <div className="space-y-2">
        <p className="text-xs font-semibold">文本节点</p>
        <Textarea
          value={node.text}
          onChange={(e) => onPatch(() => ({ type: 'text', text: e.target.value }))}
          aria-label="文本内容"
          rows={3}
          className="min-h-16 resize-none rounded-xl bg-muted/40 text-sm"
        />
        <div className="flex flex-wrap gap-1.5">
          <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" disabled={isFirst} onClick={onMoveUp}>
            <ArrowUp className="size-3.5" /> 上移
          </Button>
          <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" disabled={isLast} onClick={onMoveDown}>
            <ArrowDown className="size-3.5" /> 下移
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-full text-xs text-destructive hover:bg-destructive/10"
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" /> 删除
          </Button>
        </div>
      </div>
    )
  }

  const el = node
  const style = parseInlineStyle(el.attrs.style ?? '')
  const textOnly = el.children.every((c) => c.type === 'text')
  const textContent = el.children.map((c) => (c.type === 'text' ? c.text : '')).join(' ')

  /** 改内联样式的单个键（null = 删除该键） */
  const patchStyle = (key: string, value: string | null) => {
    onPatch((n) => {
      if (n.type !== 'el') return n
      const rec = parseInlineStyle(n.attrs.style ?? '')
      if (value == null || value === '') delete rec[key]
      else rec[key] = value
      const styleStr = buildInlineStyle(rec)
      const attrs = { ...n.attrs }
      if (styleStr) attrs.style = styleStr
      else delete attrs.style
      return { ...n, attrs }
    })
  }
  /** 改普通属性（空值删除） */
  const patchAttr = (name: string, value: string) => {
    onPatch((n) => {
      if (n.type !== 'el') return n
      const attrs = { ...n.attrs }
      if (value === '') delete attrs[name]
      else attrs[name] = value
      return { ...n, attrs }
    })
  }
  /** 编辑纯文字内容（仅当子节点全为文本时可用） */
  const patchText = (text: string) => {
    onPatch((n) =>
      n.type === 'el'
        ? { ...n, children: text.trim() ? [{ type: 'text' as const, text }] : [] }
        : n,
    )
  }

  const bold = /^(bold|[7-9]00)$/i.test(style['font-weight'] ?? '')
  const italic = /^(italic|oblique)$/i.test(style['font-style'] ?? '')
  const tagOptions = (HTML_RENAME_TAGS as readonly string[]).includes(el.tag)
    ? [...HTML_RENAME_TAGS]
    : [el.tag, ...HTML_RENAME_TAGS]

  return (
    <div className="space-y-2.5">
      <p className="font-mono text-xs font-semibold">
        &lt;{el.tag}&gt; 元素
      </p>

      {/* 标签变更 */}
      <div className="flex items-center gap-2">
        <span className={labelSm}>标签</span>
        <Select
          value={el.tag}
          onValueChange={(v) => onPatch((n) => (n.type === 'el' ? { ...n, tag: v } : n))}
        >
          <SelectTrigger className="h-8 flex-1 rounded-lg text-xs" aria-label="变更标签">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {tagOptions.map((t) => (
              <SelectItem key={t} value={t} className="font-mono text-xs">
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* 文字内容（纯文本子节点可直接编辑） */}
      {textOnly ? (
        <div>
          <span className={labelSm}>文字内容</span>
          <Textarea
            value={textContent}
            onChange={(e) => patchText(e.target.value)}
            aria-label="元素文字内容"
            rows={2}
            className="mt-1 min-h-14 resize-none rounded-xl bg-muted/40 text-sm"
          />
        </div>
      ) : (
        <p className="rounded-lg bg-muted/40 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
          该元素包含子元素：请在左侧元素树中选择子节点编辑文字，或切换到源码模式
        </p>
      )}

      {/* 专属属性：img 的 src/alt、a 的 href */}
      {el.tag === 'img' && (
        <div className="grid gap-1.5">
          <div>
            <span className={labelSm}>图片地址 src</span>
            <Input
              value={el.attrs.src ?? ''}
              onChange={(e) => patchAttr('src', e.target.value)}
              aria-label="图片地址"
              className="mt-0.5 h-8 rounded-lg text-xs"
            />
          </div>
          <div>
            <span className={labelSm}>替代文字 alt</span>
            <Input
              value={el.attrs.alt ?? ''}
              onChange={(e) => patchAttr('alt', e.target.value)}
              aria-label="图片替代文字"
              className="mt-0.5 h-8 rounded-lg text-xs"
            />
          </div>
        </div>
      )}
      {el.tag === 'a' && (
        <div>
          <span className={labelSm}>链接地址 href</span>
          <Input
            value={el.attrs.href ?? ''}
            onChange={(e) => patchAttr('href', e.target.value)}
            aria-label="链接地址"
            className="mt-0.5 h-8 rounded-lg text-xs"
          />
        </div>
      )}

      {/* 常用内联样式 */}
      <div className="space-y-1.5">
        <span className={labelSm}>常用样式（内联 style）</span>
        <div className="grid grid-cols-2 gap-1.5">
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            字色
            <input
              type="color"
              value={toHexColor(style.color, '#18181b')}
              onChange={(e) => patchStyle('color', e.target.value)}
              aria-label="文字颜色"
              className="h-7 w-8 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
            />
            <button
              type="button"
              aria-label="清除文字颜色"
              title="清除"
              onClick={() => patchStyle('color', null)}
              className="rounded p-0.5 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
            >
              <Trash2 className="size-3" />
            </button>
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            背景
            <input
              type="color"
              value={toHexColor(style['background-color'], '#ffffff')}
              onChange={(e) => patchStyle('background-color', e.target.value)}
              aria-label="背景颜色"
              className="h-7 w-8 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
            />
            <button
              type="button"
              aria-label="清除背景颜色"
              title="清除"
              onClick={() => patchStyle('background-color', null)}
              className="rounded p-0.5 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
            >
              <Trash2 className="size-3" />
            </button>
          </label>
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            字号
            <Input
              value={style['font-size'] ?? ''}
              onChange={(e) => patchStyle('font-size', e.target.value || null)}
              placeholder="如 16px"
              aria-label="字号"
              className="h-7 flex-1 rounded-lg text-[11px]"
            />
          </label>
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            边距
            <Input
              value={style.margin ?? ''}
              onChange={(e) => patchStyle('margin', e.target.value || null)}
              placeholder="如 8px"
              aria-label="边距"
              className="h-7 flex-1 rounded-lg text-[11px]"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant={bold ? 'default' : 'outline'}
            size="sm"
            aria-pressed={bold}
            className="h-7 rounded-full px-2.5 text-[11px]"
            onClick={() => patchStyle('font-weight', bold ? null : 'bold')}
          >
            加粗
          </Button>
          <Button
            variant={italic ? 'default' : 'outline'}
            size="sm"
            aria-pressed={italic}
            className="h-7 rounded-full px-2.5 text-[11px]"
            onClick={() => patchStyle('font-style', italic ? null : 'italic')}
          >
            斜体
          </Button>
          <Select
            value={style['text-align'] ?? 'none'}
            onValueChange={(v) => patchStyle('text-align', v === 'none' ? null : v)}
          >
            <SelectTrigger className="h-7 w-24 rounded-full text-[11px]" aria-label="对齐方式">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none" className="text-xs">默认对齐</SelectItem>
              <SelectItem value="left" className="text-xs">左对齐</SelectItem>
              <SelectItem value="center" className="text-xs">居中</SelectItem>
              <SelectItem value="right" className="text-xs">右对齐</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* 结构操作 */}
      <div className="flex flex-wrap gap-1.5 border-t border-border pt-2">
        <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" disabled={isFirst} onClick={onMoveUp}>
          <ArrowUp className="size-3.5" /> 上移
        </Button>
        <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" disabled={isLast} onClick={onMoveDown}>
          <ArrowDown className="size-3.5" /> 下移
        </Button>
        <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" onClick={onDuplicate}>
          <Copy className="size-3.5" /> 复制
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 rounded-full text-xs text-destructive hover:bg-destructive/10"
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" /> 删除
        </Button>
      </div>
    </div>
  )
}

/** 快速插入模板（常用块） */
const HTML_TEMPLATES: Array<{ label: string; make: () => HtmlTreeNode }> = [
  { label: '标题', make: () => htmlEl('h2', [htmlText('标题文字')]) },
  { label: '段落', make: () => htmlEl('p', [htmlText('段落文字')]) },
  {
    label: '列表',
    make: () => htmlEl('ul', [htmlEl('li', [htmlText('条目一')]), htmlEl('li', [htmlText('条目二')])]),
  },
  {
    label: '表格',
    make: () =>
      htmlEl('table', [
        htmlEl('tbody', [
          htmlEl('tr', [htmlEl('td', [htmlText('表头一')]), htmlEl('td', [htmlText('表头二')])]),
          htmlEl('tr', [htmlEl('td', [htmlText('内容')]), htmlEl('td', [htmlText('内容')])]),
        ]),
      ]),
  },
  {
    label: '图片',
    make: () => htmlEl('img', [], { src: HTML_PLACEHOLDER_IMG, alt: '图片说明' }),
  },
  { label: '分割线', make: () => htmlEl('hr') },
  { label: '引用块', make: () => htmlEl('blockquote', [htmlEl('p', [htmlText('引用内容')])]) },
  {
    label: '两栏布局',
    make: () =>
      htmlEl(
        'div',
        [htmlEl('div', [htmlText('左栏')]), htmlEl('div', [htmlText('右栏')])],
        { style: 'display: flex; gap: 12px' },
      ),
  },
]

/** HTML 可视化编辑器：实时沙盒预览 + 元素树 + 属性面板 + 快速插入 */
function HtmlVisualEditor({ code, onChange }: { code: string; onChange: (c: string) => void }) {
  const [nodes, setNodes] = React.useState<HtmlTreeNode[]>([])
  const [sel, setSel] = React.useState<number[] | null>(null)
  /** 自己 emit 出去的最新源码（跳过回环解析，防打断输入焦点） */
  const emittedRef = React.useRef<string | null>(null)

  // 外部变化（源码 tab 手改 / AI 写入）→ 重解析；自己 emit 的跳过
  React.useEffect(() => {
    if (code === emittedRef.current) return
    setNodes(parseHtmlFragment(code))
    setSel(null)
  }, [code])

  /** 不可变更新树 + 序列化写回宿主 src */
  const emit = (next: HtmlTreeNode[]) => {
    setNodes(next)
    const out = serializeHtmlTree(next)
    emittedRef.current = out
    onChange(out)
  }

  const selNode = sel ? getNodeAt(nodes, sel) : null
  /** 选中节点所在的兄弟列表（用于判断首末位置） */
  const siblingList = sel
    ? (() => {
        const parent = sel.length > 1 ? getNodeAt(nodes, sel.slice(0, -1)) : null
        return parent && parent.type === 'el' ? parent.children : nodes
      })()
    : nodes
  const selIndex = sel ? sel[sel.length - 1] : -1

  const patchSelected = (fn: (n: HtmlTreeNode) => HtmlTreeNode) => {
    if (!sel) return
    emit(updateNodeAt(nodes, sel, fn))
  }
  const deleteSelected = () => {
    if (!sel) return
    emit(removeNodeAt(nodes, sel))
    setSel(null)
  }
  const duplicateSelected = () => {
    if (!sel) return
    const node = getNodeAt(nodes, sel)
    if (!node) return
    emit(insertAfterAt(nodes, sel, cloneHtmlNode(node)))
  }
  const moveSelected = (dir: -1 | 1) => {
    if (!sel) return
    emit(moveSiblingAt(nodes, sel, dir))
  }
  /** 快速插入：有选中 → 插到其后；无选中 → 追加到末尾 */
  const insertTemplate = (make: () => HtmlTreeNode) => {
    const node = make()
    emit(sel ? insertAfterAt(nodes, sel, node) : [...nodes, node])
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 实时预览（沙盒隔离 + 防溢出滚动） */}
      <div className="max-h-72 overflow-auto rounded-xl border border-border bg-background p-3">
        {nodes.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            暂无内容：用下方模板快速插入，或切换到源码模式粘贴 HTML
          </p>
        ) : (
          <HtmlPreviewSandbox html={serializeHtmlTree(nodes)} />
        )}
      </div>

      {/* 快速插入 */}
      <div className="flex flex-wrap gap-1.5">
        {HTML_TEMPLATES.map((t) => (
          <Button
            key={t.label}
            variant="outline"
            size="sm"
            className="h-8 rounded-full text-xs"
            onClick={() => insertTemplate(t.make)}
          >
            <Plus className="size-3.5" /> {t.label}
          </Button>
        ))}
      </div>

      {/* 元素树 + 属性面板（各自滚动；小屏单列堆叠，375px 可用） */}
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="max-h-56 overflow-y-auto rounded-xl border border-border p-1.5">
          {nodes.length === 0 ? (
            <p className="py-4 text-center text-[11px] text-muted-foreground">元素树为空</p>
          ) : (
            nodes.map((n, i) => (
              <HtmlTreeItemView
                key={`${i}-${n.type === 'el' ? n.tag : 'text'}`}
                node={n}
                path={[i]}
                sel={sel}
                onSelect={setSel}
              />
            ))
          )}
        </div>
        <div className="max-h-64 overflow-y-auto rounded-xl border border-border p-2.5">
          {selNode ? (
            <HtmlNodePanel
              node={selNode}
              isFirst={selIndex <= 0}
              isLast={selIndex < 0 || selIndex >= siblingList.length - 1}
              onPatch={patchSelected}
              onDelete={deleteSelected}
              onDuplicate={duplicateSelected}
              onMoveUp={() => moveSelected(-1)}
              onMoveDown={() => moveSelected(1)}
            />
          ) : (
            <p className="py-4 text-center text-[11px] leading-relaxed text-muted-foreground">
              点击左侧元素树中的节点，
              <br />
              在这里编辑文字、标签与样式
            </p>
          )}
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        预览即最终效果；修改实时写回源码（自动去除 script 等不安全内容），应用后替换原引用
      </p>
    </div>
  )
}

// ---------- 语法校验 + 部分加载 ----------

type Verdict = { ok: true } | { ok: false; message: string; line?: number }

/** mermaid 语法校验（动态加载 mermaid，与 rich-content 渲染同一内核）；错误信息带行号时提取。 */
async function validateMermaidSrc(code: string): Promise<Verdict> {
  if (!code.trim()) return { ok: true }
  try {
    const mermaid = (await import('mermaid')).default
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
    await mermaid.parse(code)
    return { ok: true }
  } catch (e) {
    const message =
      e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e ?? '')
    const m = message.match(/line\s*(\d+)/i) || message.match(/第\s*(\d+)\s*行/)
    const line = m ? parseInt(m[1], 10) : undefined
    return { ok: false, message: message.slice(0, 200) || '语法错误', line }
  }
}

/** SVG 源码校验（DOMParser parsererror）。 */
function validateSvgSrc(code: string): Verdict {
  if (!code.trim()) return { ok: true }
  try {
    const doc = new DOMParser().parseFromString(code, 'image/svg+xml')
    const err = doc.querySelector('parsererror')
    if (err) {
      return { ok: false, message: ('SVG 解析错误：' + (err.textContent || '')).slice(0, 200) }
    }
    if (doc.documentElement && doc.documentElement.tagName.toLowerCase() !== 'svg') {
      return { ok: false, message: 'SVG 源码必须以 <svg> 根元素开头' }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, message: (e instanceof Error ? e.message : 'SVG 解析失败').slice(0, 200) }
  }
}

/** LaTeX 公式校验（katex renderToString）。 */
function validateFormulaSrc(code: string): Verdict {
  if (!code.trim()) return { ok: true }
  try {
    katex.renderToString(code, { throwOnError: true, displayMode: true, output: 'html' })
    return { ok: true }
  } catch (e) {
    return {
      ok: false,
      message: ('公式语法错误：' + (e instanceof Error ? e.message : '')).slice(0, 200),
    }
  }
}

/**
 * HTML 源码校验：DOMParser 宽容解析（text/html 从不抛 parsererror，但确认 DOM
 * 可建）+ 标签配对自检（非 void 标签必须按序正确闭合；HTML5 自动闭合的
 * `<p>a<p>b` 也会被标记，便于统一交给 AI 修复规范化）。
 */
function validateHtmlSrc(code: string): Verdict {
  const t = (code || '').trim()
  if (!t) return { ok: true }
  // 1) DOMParser 宽容解析（异常即失败）
  try {
    new DOMParser().parseFromString(t, 'text/html')
  } catch (e) {
    return { ok: false, message: ('HTML 解析失败：' + (e instanceof Error ? e.message : '')).slice(0, 200) }
  }
  // 2) 标签配对自检：扫描标签 token，非 void 元素开闭配对、嵌套有序
  const stack: Array<{ tag: string; line: number }> = []
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(t)) !== null) {
    const closing = m[1] === '/'
    const tag = m[2].toLowerCase()
    if (HTML_VOID_TAGS.has(tag)) continue
    if (!closing) {
      if (!m[3].endsWith('/')) {
        stack.push({ tag, line: t.slice(0, m.index).split('\n').length })
      }
    } else {
      const top = stack.pop()
      if (!top) return { ok: false, message: `</${tag}> 没有对应的开始标签` }
      if (top.tag !== tag) {
        return {
          ok: false,
          message: `第 ${top.line} 行的 <${top.tag}> 未闭合（与 </${tag}> 不匹配）`,
          line: top.line,
        }
      }
    }
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1]
    return { ok: false, message: `第 ${top.line} 行的 <${top.tag}> 标签未闭合`, line: top.line }
  }
  return { ok: true }
}

async function validateMediaSrc(kind: MediaKind, code: string): Promise<Verdict> {
  if (kind === 'mermaid') return validateMermaidSrc(code)
  if (kind === 'svg') return validateSvgSrc(code)
  if (kind === 'html') return validateHtmlSrc(code)
  if (kind === 'formula') return validateFormulaSrc(code)
  return { ok: true } // table / code / image 不校验
}

/**
 * mermaid 部分加载：整体解析失败时按错误行号逐行剥离出错行重试（最多 6 次），
 * 成功返回净化版 + 被移除的原始行号；无法定位行号 / 剥到声明行 → null。
 */
async function partialLoadMermaid(
  code: string,
  first: Verdict,
): Promise<{ clean: string; removedOrig: number[] } | null> {
  if (!first.ok && first.line == null) return null
  const lines = code.split(/\r?\n/)
  const origIdx = lines.map((_, i) => i + 1)
  let errLine = first.ok ? undefined : first.line
  const removedOrig: number[] = []
  for (let iter = 0; iter < 6; iter++) {
    // 第 1 行是声明行（mindmap / graph TD），不能删；越界也无法继续
    if (errLine == null || errLine < 2 || errLine > lines.length) return null
    removedOrig.push(origIdx[errLine - 1])
    lines.splice(errLine - 1, 1)
    origIdx.splice(errLine - 1, 1)
    const verdict = await validateMermaidSrc(lines.join('\n'))
    if (verdict.ok) return { clean: lines.join('\n'), removedOrig }
    errLine = verdict.ok ? undefined : verdict.line
  }
  return null
}

// ---------- 主弹窗 ----------

type EditTab = 'visual' | 'source'

/** 实时校验状态 */
type CheckState =
  | { status: 'ok' }
  | { status: 'checking' }
  | { status: 'error'; message: string; line?: number }
  | { status: 'partial'; clean: string; removedOrig: number[]; message: string }

/** MediaKind → /api/media-ai kind */
function apiKindOf(ref: MediaRef): 'mermaid' | 'svg' | 'html' | 'table' | 'formula' | 'code' {
  if (
    ref.kind === 'mermaid' ||
    ref.kind === 'svg' ||
    ref.kind === 'html' ||
    ref.kind === 'table' ||
    ref.kind === 'formula'
  ) {
    return ref.kind
  }
  return 'code'
}

/** MediaRefKind → 可编辑类型（audio/video 按源码文本处理，同 code） */
function asMediaKind(k: MediaRefKind): MediaKind {
  return k === 'audio' || k === 'video' ? 'code' : k
}

/** 源码 → RichContent 可渲染文本（预览 / AI 修复预览共用） */
function renderableOf(kind: MediaKind, code: string): string {
  switch (kind) {
    case 'mermaid':
      return '```mermaid\n' + code + '\n```'
    case 'svg':
      return '```svg\n' + code + '\n```'
    case 'html':
      return '```html\n' + code + '\n```'
    case 'table':
      return code
    case 'formula':
      return '$$' + code + '$$'
    default:
      return '```\n' + code + '\n```'
  }
}

export function MediaEditDialog({
  mediaRef,
  onOpenChange,
  onApply,
}: {
  mediaRef: MediaRef | null
  onOpenChange: (open: boolean) => void
  /** 应用：用新源码替换块文本中的原引用（raw） */
  onApply: (ref: MediaRef, newSrc: string) => void
}) {
  const [tab, setTab] = React.useState<EditTab>('visual')
  const [src, setSrc] = React.useState('')
  const [grid, setGrid] = React.useState<RichTableGrid | null>(null)
  const [tree, setTree] = React.useState<MindNode | null>(null)
  const [flowDoc, setFlowDoc] = React.useState<FlowDoc | null>(null)
  const [flowWarn, setFlowWarn] = React.useState<string | null>(null)

  // 容错 + AI
  const [check, setCheck] = React.useState<CheckState>({ status: 'ok' })
  const [forceOriginal, setForceOriginal] = React.useState(false)
  const [fix, setFix] = React.useState<{
    loading: boolean
    code: string | null
    /** 来源标签：'fix' = AI 修复语法错误；'ai' = AI 助理生成代码（自动填入审批） */
    source?: 'fix' | 'ai'
  } | null>(null)
  const [applying, setApplying] = React.useState(false)
  const [aiOpen, setAiOpen] = React.useState(false)
  const checkGenRef = React.useRef(0)

  // 流程图画布：doc ⇄ 源码同步（结构变化立即写回；拖动位置防抖 600ms，松手 flush）
  const flowDocSyncRef = React.useRef<FlowDoc | null>(null)
  const flowSrcTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const syncFlowDoc = React.useCallback((next: FlowDoc, immediate = true) => {
    flowDocSyncRef.current = next
    setFlowDoc(next)
    if (flowSrcTimerRef.current) {
      clearTimeout(flowSrcTimerRef.current)
      flowSrcTimerRef.current = null
    }
    if (immediate) {
      setSrc(serializeFlowDoc(next))
    } else {
      flowSrcTimerRef.current = setTimeout(() => {
        flowSrcTimerRef.current = null
        setSrc(serializeFlowDoc(flowDocSyncRef.current ?? next))
      }, 600)
    }
  }, [])

  /** mermaid 源码 → FlowDoc（自动布局补坐标 + 解析容错黄条文案） */
  const parseFlowFromSrc = React.useCallback((code: string): FlowDoc | null => {
    const r = parseFlowDoc(code)
    if (!r) return null
    setFlowWarn(
      r.problems.length
        ? `第 ${r.problems.join('、')} 行无法解析为画布内容（已原样保留在源码中），画布仅显示可解析部分`
        : null,
    )
    return withAutoLayout(r.doc)
  }, [])

  React.useEffect(() => {
    if (!mediaRef) return
    if (flowSrcTimerRef.current) {
      clearTimeout(flowSrcTimerRef.current)
      flowSrcTimerRef.current = null
    }
    setSrc(mediaRef.src)
    setTab('visual')
    setForceOriginal(false)
    setFix(null)
    setAiOpen(false)
    setCheck({ status: 'ok' })
    setFlowWarn(null)
    if (mediaRef.kind === 'table') {
      setGrid(parseRichTable(mediaRef.src))
      setTree(null)
      setFlowDoc(null)
    } else if (mediaRef.kind === 'mermaid' && isMindmap(mediaRef.src)) {
      // mindmap → 树编辑器；graph/flowchart → 画布式流程图编辑器
      const t = parseMindmap(mediaRef.src)
      if (t) {
        setTree(t)
        setFlowDoc(null)
      } else {
        setTree(null)
        setFlowDoc(parseFlowFromSrc(mediaRef.src))
      }
    } else {
      setGrid(null)
      setTree(null)
      setFlowDoc(null)
    }
  }, [mediaRef, parseFlowFromSrc])

  // 实时校验（mermaid / svg / html / formula，防抖 600ms；mermaid 失败尝试部分加载）
  React.useEffect(() => {
    const kind = mediaRef?.kind
    if (!kind || (kind !== 'mermaid' && kind !== 'svg' && kind !== 'formula' && kind !== 'html')) {
      setCheck({ status: 'ok' })
      return
    }
    setForceOriginal(false)
    const gen = ++checkGenRef.current
    const timer = setTimeout(() => {
      void (async () => {
        setCheck({ status: 'checking' })
        const verdict = await validateMediaSrc(kind, src)
        if (checkGenRef.current !== gen) return
        if (verdict.ok) {
          setCheck({ status: 'ok' })
          return
        }
        if (kind === 'mermaid') {
          const partial = await partialLoadMermaid(src, verdict)
          if (checkGenRef.current !== gen) return
          if (partial) {
            setCheck({
              status: 'partial',
              clean: partial.clean,
              removedOrig: partial.removedOrig,
              message: verdict.message,
            })
            return
          }
        }
        setCheck({ status: 'error', message: verdict.message, line: verdict.line })
      })()
    }, 600)
    return () => clearTimeout(timer)
  }, [src, mediaRef])

  if (!mediaRef) return null
  const ref = mediaRef

  // 可视化模式可用性（svg / html 始终可用：编辑器内部容错解析）
  const visualAvailable =
    (ref.kind === 'table' && !!grid) ||
    (ref.kind === 'mermaid' && (!!tree || !!flowDoc)) ||
    ref.kind === 'formula' ||
    ref.kind === 'svg' ||
    ref.kind === 'html'
  const activeTab: EditTab = tab === 'visual' && !visualAvailable ? 'source' : tab

  // 预览用源码：mermaid 部分加载成功时用净化版
  const previewSrc =
    ref.kind === 'mermaid' && check.status === 'partial' ? check.clean : src

  /** 外部写入新代码（AI 助理应用 / AI 修复接纳）→ 重新解析可视化结构 */
  const reparseVisual = (code: string) => {
    if (ref.kind === 'table') {
      setGrid(parseRichTable(code))
    } else if (ref.kind === 'mermaid') {
      const t = parseMindmap(code)
      if (t) {
        setTree(t)
        setFlowDoc(null)
      } else {
        setTree(null)
        setFlowDoc(parseFlowFromSrc(code))
      }
    }
  }

  /** AI 生成代码写入编辑器：写入源码 + 重解析 + 切回可视化（可继续可视化编辑） */
  const applyAiCode = (code: string) => {
    setSrc(code)
    setForceOriginal(false)
    reparseVisual(code)
    const can =
      ref.kind === 'table'
        ? !!parseRichTable(code)
        : ref.kind === 'mermaid'
          ? !!(parseMindmap(code) || parseFlowDoc(code))
          : ref.kind === 'formula' || ref.kind === 'svg' || ref.kind === 'html'
    setTab(can ? 'visual' : 'source')
    toast.success('AI 代码已写入，可继续可视化编辑')
  }

  /** 源码模式「格式化」（html 专属：块级元素换行缩进重排） */
  const handleFormatHtml = () => {
    const pretty = prettyPrintHtml(src)
    if (!pretty.trim()) {
      toast.warning('源码为空或无法解析，请先修正')
      return
    }
    setSrc(pretty)
    toast.success('已格式化（块级元素缩进重排）')
  }

  /** AI 修复语法错误（结果先预览，接纳 / 撤销 / 仍用原文） */
  const startFix = async (errMsg: string) => {
    if (fix?.loading) return
    setFix({ loading: true, code: null, source: 'fix' })
    try {
      const res = await fetch('/api/media-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: apiKindOf(ref),
          currentCode: src,
          instruction: `修复语法错误，尽量保留原有内容与结构。错误信息：${errMsg}`,
        }),
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(err.error || `请求失败（${res.status}）`)
      }
      const data = (await res.json()) as { code?: string }
      const code = typeof data.code === 'string' ? data.code : ''
      if (!code.trim()) throw new Error('AI 返回为空')
      setFix({ loading: false, code, source: 'fix' })
    } catch (e) {
      setFix(null)
      toast.error('AI 修复失败：' + (e instanceof Error ? e.message : '未知错误'))
    }
  }

  /** AI 助理生成代码 → 自动填入预览审批区（不直接覆盖编辑器源码） */
  const previewFromAi = (code: string) => {
    if (!code.trim()) return
    setFix({ loading: false, code, source: 'ai' })
    toast.success('AI 代码已填入预览，请审核后接纳')
  }

  const acceptFix = () => {
    if (!fix?.code) return
    setSrc(fix.code)
    setFix(null)
    setForceOriginal(false)
    reparseVisual(fix.code)
    toast.success(
      fix.source === 'ai' ? '已应用 AI 助理代码（校验将自动重跑）' : '已应用 AI 修复代码（校验将自动重跑）',
    )
  }

  /**
   * 切换编辑模式；切回可视化时 mermaid 流程图从当前源码重新容错解析
   * （解析多少显示多少；不再是流程图则保留画布旧状态 + 黄条提示）。
   */
  const switchTab = (t: EditTab) => {
    if (t === 'visual' && tab !== 'visual' && ref.kind === 'mermaid' && !tree) {
      const d = parseFlowFromSrc(src)
      if (d) setFlowDoc(d)
      else setFlowWarn('源码缺少 graph/flowchart 声明，画布暂保留旧内容；请先在源码中修正')
    }
    setTab(t)
  }

  const apply = async () => {
    if (applying) return
    let newSrc = src
    if (activeTab === 'visual') {
      if (ref.kind === 'table' && grid) newSrc = serializeRichTable(grid)
      else if (ref.kind === 'mermaid' && tree) newSrc = serializeMindmap(tree)
      else if (ref.kind === 'mermaid' && flowDoc) newSrc = serializeFlowDoc(flowDoc)
    }
    if (!newSrc.trim()) {
      toast.warning('内容不能为空')
      return
    }
    // 校验策略：已点「仍用原文」或部分加载已确认（预览用净化版、应用用原文）时跳过；
    // 可视化编辑器序列化出的新代码始终校验。
    const skipValidate =
      forceOriginal || (newSrc === src && check.status === 'partial')
    if (!skipValidate) {
      setApplying(true)
      try {
        const verdict = await validateMediaSrc(asMediaKind(ref.kind), newSrc)
        if (!verdict.ok) {
          setCheck({ status: 'error', message: verdict.message, line: verdict.line })
          toast.error('存在语法错误：可点击「AI 修复」，或「仍用原文」继续应用')
          return
        }
      } finally {
        setApplying(false)
      }
    }
    // html kind：宿主（material-editor）按 kind 决定围栏包裹（mermaid/svg/code 会包
    // ```lang 围栏），'html' 不在其列 → 以 kind 'code' + lang 'html' 传回，宿主即包出
    // 正确的 ```html 围栏（raw 仍是原文定位，不受影响）。
    onApply(ref.kind === 'html' ? { ...ref, kind: 'code' } : ref, newSrc)
  }

  /**
   * 点击 / 聚焦 AI 助理悬浮窗时不关闭本弹窗（非模态组合）。
   * Radix 外部事件是 CustomEvent，真实点击目标在 detail.originalEvent.target。
   */
  const outsideGuard = (e: {
    target?: EventTarget | null
    detail?: { originalEvent?: { target?: EventTarget | null } }
    preventDefault: () => void
  }) => {
    const t = (e.detail?.originalEvent?.target ?? e.target) as HTMLElement | null
    if (t && typeof t.closest === 'function' && t.closest('[data-ai-assist]')) e.preventDefault()
  }

  const bannerVisible =
    !forceOriginal && (check.status === 'error' || check.status === 'partial')
  const bannerMsg =
    check.status === 'partial'
      ? `第 ${check.removedOrig.join('、')} 行有误已忽略（预览用净化版）：${check.message}`
      : check.status === 'error'
        ? `语法校验未通过：${check.message}`
        : ''

  return (
    <>
      <Dialog
        open={!!ref}
        onOpenChange={(o) => {
          if (!o) setAiOpen(false)
          onOpenChange(o)
        }}
        modal={false}
      >
        <DialogContent
          className="max-h-[88dvh] overflow-y-auto rounded-2xl sm:max-w-xl"
          onPointerDownOutside={outsideGuard}
          onFocusOutside={outsideGuard}
          // AI 助理悬浮窗打开时，Esc 只关悬浮窗、不关编辑弹窗
          onEscapeKeyDown={(e) => {
            if (aiOpen) e.preventDefault()
          }}
        >
          <DialogHeader className="flex-row items-start justify-between gap-2 space-y-0 pr-10">
            <div className="min-w-0">
              <DialogTitle>编辑{MEDIA_KIND_LABEL[ref.kind]}</DialogTitle>
              <DialogDescription>
                可视化 ⇄ 源码双模式，应用后替换原引用（可撤销）
              </DialogDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0 rounded-full text-xs"
              onClick={() => setAiOpen(true)}
            >
              <Sparkles className="size-3.5" /> AI 助理
            </Button>
          </DialogHeader>

          {/* 校验 / 部分加载横幅 */}
          {bannerVisible && (
            <div
              role="alert"
              className={cn(
                'rounded-xl border px-3 py-2 text-xs',
                check.status === 'partial'
                  ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'
                  : 'border-destructive/40 bg-destructive/10 text-destructive',
              )}
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <p className="min-w-0 flex-1 break-words">{bannerMsg}</p>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-2 pl-6">
                <Button
                  size="sm"
                  className="h-7 rounded-full bg-zinc-900 px-3 text-[11px] font-medium text-white hover:bg-zinc-800"
                  disabled={fix?.loading}
                  onClick={() => void startFix(bannerMsg)}
                >
                  <Wand2 className="size-3" /> AI修复
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-full px-3 text-[11px]"
                  onClick={() => setForceOriginal(true)}
                >
                  仍用原文
                </Button>
              </div>
            </div>
          )}

          {/* AI 修复 / 助理代码预览（接纳 / 撤销 / 仍用原文） */}
          {fix && (
            <div className="flex flex-col gap-2 rounded-xl border border-emerald-300 bg-emerald-50/70 p-3 dark:border-emerald-500/40 dark:bg-emerald-500/10">
              {fix.loading ? (
                <p className="flex items-center gap-2 text-xs text-emerald-800 dark:text-emerald-300">
                  <Loader2 className="size-4 animate-spin" /> AI 正在生成代码…
                </p>
              ) : (
                fix.code != null && (
                  <>
                    <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-800 dark:text-emerald-300">
                      <Sparkles className="size-3.5" />
                      {fix.source === 'ai'
                        ? 'AI 助理代码（已自动填入预览，请审核）'
                        : 'AI 修复建议（先预览，再决定）'}
                    </div>

                    {/* 对比预览：原文（灰） vs 修复后（高亮）；小屏单列堆叠 */}
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <div className="min-w-0 rounded-lg border border-border bg-muted/30 p-2">
                        <p className="mb-1 text-[11px] text-muted-foreground">原文（当前编辑器）</p>
                        <div className="max-h-[40vh] overflow-auto rounded bg-background/60 p-2 opacity-70">
                          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
                            {src || '（空）'}
                          </pre>
                        </div>
                      </div>
                      <div className="min-w-0 rounded-lg border border-emerald-400 bg-background p-2 ring-1 ring-emerald-400/40">
                        <p className="mb-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                          修复后预览
                        </p>
                        <div className="max-h-[40vh] overflow-auto rounded bg-background p-2">
                          <React.Suspense
                            fallback={
                              <p className="py-2 text-center text-xs text-muted-foreground">渲染中…</p>
                            }
                          >
                            {/* 公式 / mermaid / svg / html / table 均经 renderableOf 包装；
                                KaTeX 矩阵 / 化学式等扩展由 rich-content 同源渲染 */}
                            <RichContentLazy
                              content={renderableOf(asMediaKind(ref.kind), fix.code)}
                            />
                          </React.Suspense>
                        </div>
                      </div>
                    </div>

                    {/* 修复后源码（可折叠；宽内容横向滚动不被截断） */}
                    <details className="group">
                      <summary className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground">
                        <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
                        查看修复后源码
                      </summary>
                      <pre className="mt-1 max-h-32 overflow-auto rounded-lg bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
                        {fix.code}
                      </pre>
                    </details>

                    {/* 操作按钮（接纳 / 撤销 / 仍用原文）固定底部不挡内容；小屏堆叠 */}
                    <div className="flex flex-col gap-2 border-t border-emerald-300/60 pt-2 sm:flex-row sm:items-center sm:justify-end sm:gap-2 sm:border-t-0 sm:pt-0">
                      <Button
                        size="sm"
                        className="h-9 rounded-full bg-emerald-600 px-4 text-xs font-medium text-white hover:bg-emerald-700"
                        onClick={acceptFix}
                      >
                        <Check className="size-3.5" /> 接纳应用到编辑器
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-9 rounded-full px-4 text-xs"
                        onClick={() => setFix(null)}
                      >
                        <Undo2 className="size-3.5" /> 撤销
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-9 rounded-full px-4 text-xs text-muted-foreground"
                        onClick={() => {
                          setFix(null)
                          setForceOriginal(true)
                          toast.info('已保留原文')
                        }}
                      >
                        仍用原文
                      </Button>
                    </div>
                  </>
                )
              )}
            </div>
          )}

          {/* 模式切换 */}
          <div className="flex rounded-full bg-muted p-1" role="tablist" aria-label="编辑模式">
            {(
              [
                { key: 'visual' as EditTab, label: '可视化', icon: Eye, disabled: !visualAvailable },
                { key: 'source' as EditTab, label: '源码', icon: Code2, disabled: false },
              ] as const
            ).map((t) => {
              const Icon = t.icon
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === t.key}
                  disabled={t.disabled}
                  onClick={() => switchTab(t.key)}
                  className={cn(
                    'flex flex-1 items-center justify-center gap-1.5 rounded-full py-1.5 text-sm transition-colors',
                    activeTab === t.key
                      ? 'bg-background font-medium text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                    t.disabled && 'opacity-40',
                  )}
                >
                  <Icon className="size-4" /> {t.label}
                  {!visualAvailable && t.key === 'visual' ? '（源码类型）' : ''}
                </button>
              )
            })}
          </div>

          <div className="min-h-40">
            {activeTab === 'visual' ? (
              ref.kind === 'table' && grid ? (
                <TableGridEditor grid={grid} onChange={setGrid} />
              ) : ref.kind === 'formula' ? (
                <FormulaEditor src={src} onChange={setSrc} />
              ) : ref.kind === 'mermaid' && tree ? (
                <MindmapEditor root={tree} onChange={setTree} />
              ) : ref.kind === 'mermaid' && flowDoc ? (
                <FlowGraphEditor doc={flowDoc} warn={flowWarn} onDocChange={syncFlowDoc} />
              ) : ref.kind === 'svg' ? (
                <SvgVisualEditor code={src} onChange={setSrc} />
              ) : ref.kind === 'html' ? (
                <HtmlVisualEditor code={src} onChange={setSrc} />
              ) : null
            ) : (
              <div className="flex flex-col gap-3">
                <Textarea
                  value={src}
                  onChange={(e) => setSrc(e.target.value)}
                  aria-label={`${MEDIA_KIND_LABEL[ref.kind]}源码`}
                  placeholder="编辑源码…"
                  className="min-h-36 resize-none rounded-xl bg-muted/40 font-mono text-sm"
                />
                {ref.kind === 'html' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 self-start rounded-full text-xs"
                    onClick={handleFormatHtml}
                  >
                    <Wand2 className="size-3.5" /> 格式化
                  </Button>
                )}
                {ref.kind !== 'formula' && (
                  <div className="max-h-40 overflow-auto rounded-xl bg-muted/50 p-2">
                    <p className="pb-1 text-[11px] text-muted-foreground">
                      预览{check.status === 'partial' ? '（净化版，出错行已忽略）' : ''}
                    </p>
                    <React.Suspense fallback={<p className="text-xs text-muted-foreground">渲染中…</p>}>
                      {/* 预览同样带统一富媒体交互（点击/悬浮可放大详情、下载） */}
                      <RichContentLazy content={renderableOf(asMediaKind(ref.kind), previewSrc)} />
                    </React.Suspense>
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              className="flex-1 rounded-full"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              className="flex-1 rounded-full bg-zinc-900 font-semibold text-white hover:bg-zinc-800"
              onClick={() => void apply()}
              disabled={applying || (!src.trim() && !grid && !tree && !flowDoc)}
            >
              {applying ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> 校验中…
                </>
              ) : (
                '应用修改'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AI 助理悬浮窗（非模态，portal 到 body，不打断编辑器） */}
      <AiAssistPopover
        open={aiOpen}
        onOpenChange={setAiOpen}
        kind={asMediaKind(ref.kind)}
        currentCode={src}
        onApply={applyAiCode}
        onPreview={previewFromAi}
      />
    </>
  )
}
