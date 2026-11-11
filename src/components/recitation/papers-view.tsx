'use client'

// 试卷夹 — 按书本（Card）独立划分的试卷管理（自带 bottom Sheet，open 由 props 控制）。
//
// 功能：
//   • 按书本独立：顶部书本切换（当前书 / 全部书 / 其他书 — cards prop 或 GET /api/cards）
//   • 时间轴浏览：按日期分组（今天 / 昨天 / 本周 / 更早）
//   • 搜索：过滤试卷标题 + items[].question 题目内容
//   • 排序：创建时间 / 标题 / 题数 × 正序/倒序（偏好存 localStorage）
//   • 日期筛选：全部 / 近7天 / 近30天 / 近90天
//   • 批量管理：复选框模式 — 全选 / 批量删除（确认）/ 批量导出（合并 MD / 合并
//     HTML / 合并 PDF 打印）
//   • 试卷详情：内联展开，RichContent 渲染每题（题干+选项+答案，富媒体绝不溢出）
//     每题可勾选；全选/反选 + AI 智能勾选（/api/chat mode:'pick'）+ 练习所选；
//     「开始练习」→ onPractice(items, title) 由宿主接入答题流程；
//     导出单份 MD / TXT / HTML / PDF（打印）
//
// API（src/app/api/papers/route.ts）：
//   GET    /api/papers?cardId=<id> → { papers }（省略 cardId = 全部，时间倒序）
//   PUT    /api/papers { id, title?, items? } → { ok }
//   DELETE /api/papers?id= | ?ids=a,b
import * as React from 'react'
import {
  ArrowDownUp,
  BookOpen,
  CalendarRange,
  Check,
  Download,
  FileCode2,
  FileText,
  FolderOpen,
  Loader2,
  MoreVertical,
  Pencil,
  Play,
  Printer,
  Search,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { RichContent } from '@/components/recitation/rich-content'
import {
  escapeHtml,
  mediaRefsToText,
  printHtmlDocument,
  renderMarkdown,
} from '@/lib/export-utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

// ---------- 类型 ----------
/** 试卷中的单道题（与 /api/quiz 的题目结构一致，原样 JSON 存取） */
export interface PaperItem {
  type: string
  question: string
  answer: string
  options?: string[]
  /** 解析（可选：AI 出题/举一反三来源可能携带） */
  explanation?: string
}

export interface PaperData {
  id: string
  cardId: string
  cardTitle: string
  title: string
  count: number
  items: PaperItem[]
  source: string
  createdAt: string
  updatedAt: string
}

export interface PapersViewProps {
  /** 当前书本 id（初始选中的书；空串则默认「全部书」） */
  cardId: string
  /** 当前书本标题 */
  cardTitle: string
  /** Sheet 开关（受控） */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** 开始练习回调：把试卷题目交给宿主的答题流程 */
  onPractice?: (items: unknown[], title: string) => void
  /** 可选：书本列表（不传则自行 GET /api/cards） */
  cards?: Array<{ id: string; title: string }>
}

// ---------- 常量 ----------
const TYPE_LABEL: Record<string, string> = {
  fill: '填空',
  short: '简答',
  choice: '单选',
  multi: '多选',
  judge: '判断',
}

const SOURCE_LABEL: Record<string, string> = {
  ai: 'AI出题',
  manual: '手动',
  wrong: '错题',
  extend: '举一反三',
}

function sourceLabel(s: string): string {
  return SOURCE_LABEL[s] ?? '手动'
}

// ---------- 排序偏好（与 chat-sidebar 同款：key × 正序/倒序，存 localStorage） ----------
type SortKey = 'created' | 'title' | 'count'
type SortDir = 'asc' | 'desc'

interface SortPref {
  key: SortKey
  dir: SortDir
}

const SORT_PREF_KEY = 'bs:papers-sort'
/** 默认：创建时间 + 倒序（与历史「最新创建」行为一致）。 */
const DEFAULT_SORT: SortPref = { key: 'created', dir: 'desc' }

const SORT_KEY_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'created', label: '创建时间' },
  { value: 'title', label: '标题' },
  { value: 'count', label: '题数' },
]

const SORT_DIR_HINT: Record<SortKey, { asc: string; desc: string }> = {
  created: { asc: '旧→新', desc: '新→旧' },
  title: { asc: 'A→Z', desc: 'Z→A' },
  count: { asc: '少→多', desc: '多→少' },
}

function loadSortPref(): SortPref {
  try {
    const raw = window.localStorage.getItem(SORT_PREF_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<SortPref>
      if (
        (p.key === 'created' || p.key === 'title' || p.key === 'count') &&
        (p.dir === 'asc' || p.dir === 'desc')
      ) {
        return { key: p.key, dir: p.dir }
      }
    }
  } catch {
    /* 损坏则用默认 */
  }
  return DEFAULT_SORT
}

const DATE_OPTIONS = [
  { key: 'all', label: '全部时间' },
  { key: '7', label: '近7天' },
  { key: '30', label: '近30天' },
  { key: '90', label: '近90天' },
] as const
type DateKey = (typeof DATE_OPTIONS)[number]['key']

type Bucket = 'today' | 'yesterday' | 'week' | 'earlier'
const BUCKET_ORDER: Bucket[] = ['today', 'yesterday', 'week', 'earlier']
const BUCKET_LABEL: Record<Bucket, string> = {
  today: '今天',
  yesterday: '昨天',
  week: '本周',
  earlier: '更早',
}

function dateBucket(iso: string): Bucket {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 'earlier'
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (t >= startOfToday) return 'today'
  if (t >= startOfToday - 86400000) return 'yesterday'
  if (t >= startOfToday - 6 * 86400000) return 'week'
  return 'earlier'
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === new Date().toDateString()) return `今天 ${hm}`
  if (d.getFullYear() === new Date().getFullYear())
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

// ---------- 导出 ----------
function downloadText(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function safeFilename(s: string): string {
  return (s.trim() || '试卷').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
}

/** 导出格式：md / txt / html / pdf（打印链路，浏览器「另存为 PDF」） */
type PaperExportFormat = 'md' | 'txt' | 'html' | 'pdf'

/** 单份试卷 → Markdown（试卷标题 + 题目 + 选项 + 答案 + 解析；富媒体保留源码原样） */
function paperToMarkdown(p: PaperData): string {
  const head: string[] = [
    `# ${p.title}`,
    '',
    `> ${sourceLabel(p.source)} · 共 ${p.count} 题 · ${formatDate(p.createdAt)}${p.cardTitle ? ` · ${p.cardTitle}` : ''}`,
    '',
  ]
  const body: string[] = []
  ;(p.items ?? []).forEach((it, i) => {
    body.push(`## ${i + 1}. [${TYPE_LABEL[it.type] ?? it.type ?? '题目'}]`)
    body.push(it.question ?? '')
    if (Array.isArray(it.options) && it.options.length > 0) {
      body.push('')
      it.options.forEach((o, j) => body.push(`${String.fromCharCode(65 + j)}. ${o}`))
    }
    body.push('')
    body.push(`**答案：** ${it.answer ?? ''}`)
    if ((it.explanation ?? '').trim()) {
      body.push('')
      body.push(`**解析：** ${it.explanation ?? ''}`)
    }
    body.push('')
  })
  return [...head, ...body].join('\n')
}

/** 单份试卷 → 纯文本（音视频引用转为全角占位，不裸露 [[audio:]] 语法） */
function paperToText(p: PaperData): string {
  const lines: string[] = [`试卷：${p.title}`, `共 ${p.count} 题 · ${formatDate(p.createdAt)}`, '']
  ;(p.items ?? []).forEach((it, i) => {
    lines.push(`第${i + 1}题 [${TYPE_LABEL[it.type] ?? it.type ?? '题目'}]`)
    lines.push(mediaRefsToText(it.question ?? ''))
    if (Array.isArray(it.options) && it.options.length > 0) {
      it.options.forEach((o, j) => lines.push(`${String.fromCharCode(65 + j)}. ${mediaRefsToText(o)}`))
    }
    lines.push(`答案：${mediaRefsToText(it.answer ?? '')}`)
    if ((it.explanation ?? '').trim()) lines.push(`解析：${mediaRefsToText(it.explanation ?? '')}`)
    lines.push('')
  })
  return lines.join('\n')
}

// ---------- 试卷 HTML / 打印 PDF 导出 ----------

/** 试卷导出文档样式（屏幕阅读 + @media print A4 打印规则） */
const PAPER_DOC_STYLES = `* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: #f5f5f2; color: #26262a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', 'WenQuanYi Micro Hei', sans-serif; font-size: 16px; line-height: 1.85; -webkit-font-smoothing: antialiased; }
.wrap { max-width: 760px; margin: 0 auto; padding: 48px 28px 40px; background: #ffffff; min-height: 100vh; }
.paper + .paper { margin-top: 48px; }
.paper-title { margin: 0 0 8px; font-size: 1.5em; line-height: 1.4; font-weight: 700; text-align: center; }
.paper-meta { margin: 0 0 18px; text-align: center; font-size: 13px; color: #9a9aa0; }
.q { border: 1px solid #e6e6e0; border-radius: 12px; padding: 16px 20px; margin: 14px 0; page-break-inside: avoid; break-inside: avoid; }
.q > h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; font-size: 1em; font-weight: 700; }
.q .no { color: #0b7a5b; }
.q .tp { font-size: 12px; font-weight: 600; color: #0b7a5b; background: #e8f6f0; border-radius: 999px; padding: 1px 10px; white-space: nowrap; }
.stem p { margin: 0 0 0.7em; }
.stem img { max-width: 100%; height: auto; border-radius: 8px; }
.stem ul, .stem ol { margin: 0.4em 0 0.8em; padding-left: 1.6em; }
.stem blockquote { margin: 0.7em 0; padding: 2px 14px; border-left: 3px solid #d8d8d0; background: #fafaf6; color: #55555c; }
.stem pre { background: #f6f6f2; border: 1px solid #e6e6e0; border-radius: 10px; padding: 10px 14px; overflow-x: auto; font-size: 0.86em; }
.stem code { font-family: ui-monospace, Menlo, Consolas, monospace; background: #f2f2ee; border-radius: 5px; padding: 1px 5px; font-size: 0.88em; }
.stem pre code { background: none; padding: 0; }
.stem table, .val table { border-collapse: collapse; width: 100%; margin: 0.8em 0; font-size: 0.92em; }
.stem th, .stem td, .val th, .val td { border: 1px solid #dcdcd4; padding: 6px 10px; text-align: left; vertical-align: top; }
.stem th, .val th { background: #f2f2ec; font-weight: 600; }
.opts { margin: 8px 0 2px; }
.opt { margin: 4px 0; }
.opt .key { font-weight: 600; color: #0b7a5b; margin-right: 4px; }
.ans, .exp { margin-top: 10px; border-top: 1px dashed #e6e6e0; padding-top: 8px; }
.ans .lbl, .exp .lbl { display: inline-block; font-size: 12px; font-weight: 700; color: #ffffff; background: #0e9f6e; border-radius: 999px; padding: 1px 10px; margin-bottom: 6px; }
.exp .lbl { background: #6b7280; }
.ans .val, .exp .val { color: #1f2937; }
.ans .val p, .exp .val p { margin: 0 0 0.5em; }
.doc-footer { margin-top: 44px; padding-top: 14px; border-top: 1px solid #e6e6e0; text-align: center; color: #a0a0a6; font-size: 12px; }
@media print {
  @page { size: A4; margin: 14mm 13mm; }
  html, body { background: #ffffff; }
  body { font-size: 12pt; }
  .wrap { max-width: none; padding: 0; min-height: auto; }
  .paper.break-before { page-break-before: always; break-before: page; }
  .doc-footer { margin-top: 24px; }
}`

/** 单份试卷正文（标题 + meta + 题目：题号题型 + 题干 + 选项 + 答案 + 解析）。 */
function paperSectionHtml(
  p: PaperData,
  opts: { headingTag?: 'h1' | 'h2'; breakBefore?: boolean } = {},
): string {
  const items = p.items ?? []
  const h = opts.headingTag ?? 'h1'
  const meta = [
    sourceLabel(p.source),
    `共 ${p.count || items.length} 题`,
    formatDate(p.createdAt),
    p.cardTitle ? `《${escapeHtml(p.cardTitle)}》` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const qs = items
    .map((it, i) => {
      const optsHtml =
        Array.isArray(it.options) && it.options.length > 0
          ? `<div class="opts">${it.options
              .map(
                (o, j) =>
                  `<p class="opt"><span class="key">${String.fromCharCode(65 + j)}.</span> ${escapeHtml(o)}</p>`,
              )
              .join('')}</div>`
          : ''
      const answer = (it.answer ?? '').trim()
      const explanation = (it.explanation ?? '').trim()
      return `<section class="q">
  <h3><span class="no">第 ${i + 1} 题</span><span class="tp">${escapeHtml(TYPE_LABEL[it.type] ?? it.type ?? '题目')}</span></h3>
  <div class="stem">${renderMarkdown(it.question ?? '')}</div>${optsHtml ? `\n  ${optsHtml}` : ''}${answer ? `\n  <div class="ans"><span class="lbl">答案</span><div class="val">${renderMarkdown(answer)}</div></div>` : ''}${explanation ? `\n  <div class="exp"><span class="lbl">解析</span><div class="val">${renderMarkdown(explanation)}</div></div>` : ''}
</section>`
    })
    .join('\n')
  return `<section class="paper${opts.breakBefore ? ' break-before' : ''}">
  <${h} class="paper-title">${escapeHtml(p.title)}</${h}>
  <p class="paper-meta">${meta}</p>
${qs ? `  ${qs}\n` : '  <p class="paper-meta">（这份试卷没有题目）</p>\n'}</section>`
}

/** 完整独立 HTML 文档（内联 CSS；autoPrint 时加载完自动调起打印）。 */
function buildPaperHtmlDoc(
  sections: string,
  opts: { docTitle: string; autoPrint?: boolean },
): string {
  const autoPrintScript = opts.autoPrint
    ? `\n  <script>
    window.addEventListener('load', function () {
      setTimeout(function () { try { window.focus(); window.print(); } catch (e) {} }, 200);
    });
  </script>`
    : ''
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(opts.docTitle)}</title>
<style>${PAPER_DOC_STYLES}</style>
</head>
<body>
  <main class="wrap">
${sections}
  <footer class="doc-footer">导出自「背书吧」试卷夹 · ${new Date().toLocaleString('zh-CN', { hour12: false })}</footer>
  </main>${autoPrintScript}
</body>
</html>`
}

/** 单份试卷 → 独立 HTML 文档。 */
function buildPaperHtml(p: PaperData, opts: { autoPrint?: boolean } = {}): string {
  return buildPaperHtmlDoc(paperSectionHtml(p), { docTitle: p.title, autoPrint: opts.autoPrint })
}

/** 多份试卷 → 合并 HTML 文档（每份试卷打印时另起一页）。 */
function buildMergedPaperHtml(list: PaperData[], opts: { autoPrint?: boolean } = {}): string {
  const sections = list
    .map((p, i) => paperSectionHtml(p, { headingTag: 'h2', breakBefore: i > 0 }))
    .join('\n')
  return buildPaperHtmlDoc(sections, {
    docTitle: `试卷合并导出（${list.length} 份）`,
    autoPrint: opts.autoPrint,
  })
}

/** 打印试卷（隐藏 iframe + A4 打印样式；打印窗口选「另存为 PDF」即得 PDF）。 */
function printPaper(p: PaperData): void {
  printHtmlDocument(buildPaperHtml(p, { autoPrint: true }))
}

// ---------- 主组件 ----------
export function PapersView({
  cardId,
  cardTitle,
  open = false,
  onOpenChange,
  onPractice,
  cards: cardsProp,
}: PapersViewProps) {
  // ---- 数据 ----
  const [papers, setPapers] = React.useState<PaperData[]>([])
  const [loading, setLoading] = React.useState(false)
  const [cardList, setCardList] = React.useState<Array<{ id: string; title: string }>>(
    cardsProp ?? [],
  )

  // ---- 视图状态 ----
  const [bookId, setBookId] = React.useState<string>(cardId || 'all')
  const [search, setSearch] = React.useState('')
  const [sortPref, setSortPref] = React.useState<SortPref>(DEFAULT_SORT)
  const [dateRange, setDateRange] = React.useState<DateKey>('all')
  const [manageMode, setManageMode] = React.useState(false)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [expandedId, setExpandedId] = React.useState<string | null>(null)

  // ---- 弹窗 ----
  const [renaming, setRenaming] = React.useState<{ id: string; title: string } | null>(null)
  const [deleteId, setDeleteId] = React.useState<string | null>(null)
  const [batchDeleteOpen, setBatchDeleteOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  // 书本跟随 props 变化（切换卡片时回到当前书）
  React.useEffect(() => {
    setBookId(cardId || 'all')
  }, [cardId])

  // 排序偏好：挂载读取 localStorage，变化时写回（先读后写，避免默认值覆盖存量）
  React.useEffect(() => {
    setSortPref(loadSortPref())
  }, [])
  React.useEffect(() => {
    try {
      window.localStorage.setItem(SORT_PREF_KEY, JSON.stringify(sortPref))
    } catch {
      /* 隐私模式忽略 */
    }
  }, [sortPref])

  React.useEffect(() => {
    if (cardsProp) setCardList(cardsProp)
  }, [cardsProp])

  // ---- 加载试卷 ----
  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const url = bookId === 'all' ? '/api/papers' : `/api/papers?cardId=${encodeURIComponent(bookId)}`
      const res = await fetch(url)
      if (!res.ok) throw new Error('加载试卷失败')
      const data = (await res.json()) as { papers?: PaperData[] }
      setPapers(
        (data.papers ?? []).map((p) => ({
          ...p,
          items: Array.isArray(p.items) ? p.items : [],
          count: typeof p.count === 'number' ? p.count : (p.items ?? []).length,
        })),
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载试卷失败')
    } finally {
      setLoading(false)
    }
  }, [bookId])

  React.useEffect(() => {
    if (open) void load()
  }, [open, load])

  // 书本列表（props 未提供时自行拉取 /api/cards）
  React.useEffect(() => {
    if (!open || cardsProp) return
    let alive = true
    void (async () => {
      try {
        const res = await fetch('/api/cards')
        if (!res.ok) return
        const data = (await res.json()) as { cards?: Array<{ id: string; title: string }> }
        if (alive && Array.isArray(data.cards)) setCardList(data.cards)
      } catch {
        /* 静默降级：书本切换里至少有「全部书」与当前书 */
      }
    })()
    return () => {
      alive = false
    }
  }, [open, cardsProp])

  // ---- 筛选 / 排序 / 搜索 ----
  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    const now = Date.now()
    let list = papers.filter((p) => {
      if (dateRange !== 'all') {
        const t = new Date(p.createdAt).getTime()
        if (Number.isNaN(t) || now - t > Number(dateRange) * 86400000) return false
      }
      if (!q) return true
      if (p.title.toLowerCase().includes(q)) return true
      return (p.items ?? []).some((it) => (it?.question ?? '').toLowerCase().includes(q))
    })
    list = [...list]
    switch (sortPref.key) {
      case 'title': {
        const cmp = (a: PaperData, b: PaperData) =>
          a.title.localeCompare(b.title, 'zh-Hans-CN') || a.createdAt.localeCompare(b.createdAt)
        list.sort(cmp)
        if (sortPref.dir === 'desc') list.reverse()
        break
      }
      case 'count': {
        const cmp = (a: PaperData, b: PaperData) =>
          a.count - b.count || b.createdAt.localeCompare(a.createdAt)
        list.sort(cmp)
        if (sortPref.dir === 'desc') list.reverse()
        break
      }
      case 'created':
      default: {
        const cmp = (a: PaperData, b: PaperData) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
        list.sort(cmp)
        if (sortPref.dir === 'desc') list.reverse()
        break
      }
    }
    return list
  }, [papers, search, sortPref, dateRange])

  // 时间轴分组（仅「创建时间·倒序」时分组展示，其他排序平铺）
  const groups = React.useMemo(() => {
    if (!(sortPref.key === 'created' && sortPref.dir === 'desc'))
      return [{ bucket: null as Bucket | null, list: filtered }]
    const map = new Map<Bucket, PaperData[]>()
    for (const p of filtered) {
      const b = dateBucket(p.createdAt)
      if (!map.has(b)) map.set(b, [])
      map.get(b)!.push(p)
    }
    return BUCKET_ORDER.filter((b) => map.has(b)).map((b) => ({ bucket: b, list: map.get(b)! }))
  }, [filtered, sortPref])

  // ---- 批量 ----
  const allSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.id))
  const selectedPapers = filtered.filter((p) => selected.has(p.id))

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(filtered.map((p) => p.id)))
  }

  const exitManage = () => {
    setManageMode(false)
    setSelected(new Set())
  }

  const switchBook = (id: string) => {
    setBookId(id)
    setExpandedId(null)
    if (manageMode) exitManage()
  }

  // ---- 单份操作 ----
  const confirmRename = async () => {
    if (!renaming) return
    const title = renaming.title.trim()
    if (!title) {
      toast.warning('标题不能为空')
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/papers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: renaming.id, title }),
      })
      if (!res.ok) throw new Error('重命名失败')
      setPapers((prev) => prev.map((p) => (p.id === renaming.id ? { ...p, title } : p)))
      toast.success('已重命名')
      setRenaming(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重命名失败')
    } finally {
      setBusy(false)
    }
  }

  const deletePaper = async (id: string) => {
    setBusy(true)
    try {
      const res = await fetch(`/api/papers?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('删除失败')
      setPapers((prev) => prev.filter((p) => p.id !== id))
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      if (expandedId === id) setExpandedId(null)
      toast.success('已删除试卷')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  const batchDelete = async () => {
    const ids = [...selected]
    if (ids.length === 0) return
    setBusy(true)
    try {
      const res = await fetch(`/api/papers?ids=${encodeURIComponent(ids.join(','))}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error('删除失败')
      setPapers((prev) => prev.filter((p) => !selected.has(p.id)))
      toast.success(`已删除 ${ids.length} 份试卷`)
      exitManage()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  const exportOne = (p: PaperData, fmt: PaperExportFormat) => {
    const name = safeFilename(p.title)
    switch (fmt) {
      case 'md':
        downloadText(`${name}.md`, paperToMarkdown(p), 'text/markdown;charset=utf-8')
        toast.success('已导出 Markdown 文件')
        break
      case 'txt':
        downloadText(`${name}.txt`, paperToText(p), 'text/plain;charset=utf-8')
        toast.success('已导出 TXT 文件')
        break
      case 'html':
        downloadText(`${name}.html`, buildPaperHtml(p), 'text/html;charset=utf-8')
        toast.success('已导出 HTML 文件')
        break
      case 'pdf':
        toast.info('已打开打印窗口，选择「另存为 PDF」即可导出')
        printPaper(p)
        break
    }
  }

  /** 批量导出：md = 合并 Markdown；html = 合并独立 HTML；pdf = 合并打印（每卷另起一页） */
  const exportBatch = (fmt: 'md' | 'html' | 'pdf') => {
    if (selectedPapers.length === 0) {
      toast('未选中任何试卷')
      return
    }
    const stamp = new Date().toISOString().slice(0, 10)
    if (fmt === 'md') {
      const md = selectedPapers.map((p) => paperToMarkdown(p)).join('\n\n---\n\n')
      downloadText(
        `试卷夹_合并导出_${stamp}.md`,
        md,
        'text/markdown;charset=utf-8',
      )
      toast.success(`已合并导出 ${selectedPapers.length} 份试卷（MD）`)
    } else if (fmt === 'html') {
      downloadText(
        `试卷夹_合并导出_${stamp}.html`,
        buildMergedPaperHtml(selectedPapers),
        'text/html;charset=utf-8',
      )
      toast.success(`已合并导出 ${selectedPapers.length} 份试卷（HTML）`)
    } else {
      toast.info('已打开打印窗口，选择「另存为 PDF」即可导出')
      printHtmlDocument(buildMergedPaperHtml(selectedPapers, { autoPrint: true }))
    }
  }

  // ---- 书本切换列表：当前书 + 全部书 + 其他书 ----
  const bookLabel =
    bookId === 'all'
      ? '全部书本'
      : (cardList.find((c) => c.id === bookId)?.title ?? (bookId === cardId ? cardTitle : '未知书本'))
  const otherBooks = cardList.filter((c) => c.id !== bookId && c.id !== cardId)

  const sortLabel = `${SORT_KEY_OPTIONS.find((s) => s.value === sortPref.key)?.label ?? '创建时间'} · ${
    sortPref.dir === 'asc' ? '正序' : '倒序'
  }`
  const dateLabel = DATE_OPTIONS.find((d) => d.key === dateRange)?.label ?? '全部时间'

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="flex h-[92dvh] flex-col gap-0 rounded-t-3xl p-0"
      >
        {/* 头部 */}
        <SheetHeader className="shrink-0 border-b border-border/60 pb-3">
          <SheetTitle className="pr-10 text-left text-base font-bold">试卷夹</SheetTitle>
          <SheetDescription className="text-left text-xs">
            {bookLabel} · 共 {filtered.length} 份试卷
            {manageMode && ' · 管理模式'}
          </SheetDescription>
        </SheetHeader>

        {/* 筛选区：第 1 行 书本切换 + 搜索；第 2 行 排序 + 日期 + 管理 */}
        <div className="shrink-0 space-y-2 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="切换书本"
                  className="flex h-11 min-w-0 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <BookOpen className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span className="max-w-28 truncate">{bookLabel}</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
                {cardId && (
                  <DropdownMenuItem
                    onClick={() => switchBook(cardId)}
                    className={cn(bookId === cardId && 'font-bold text-red-500')}
                  >
                    <span className="max-w-48 truncate">{cardTitle || '当前书本'}</span>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => switchBook('all')}
                  className={cn(bookId === 'all' && 'font-bold text-red-500')}
                >
                  全部书本
                </DropdownMenuItem>
                {otherBooks.map((c) => (
                  <DropdownMenuItem
                    key={c.id}
                    onClick={() => switchBook(c.id)}
                    className={cn(bookId === c.id && 'font-bold text-red-500')}
                  >
                    <span className="max-w-48 truncate">{c.title}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                strokeWidth={1.75}
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索标题或题目…"
                aria-label="搜索试卷"
                className="h-11 rounded-full pl-9 text-sm"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="排序方式"
                  className="flex h-11 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ArrowDownUp className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span>{sortLabel}</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-44">
                {SORT_KEY_OPTIONS.map((opt) => (
                  <DropdownMenuItem
                    key={opt.value}
                    onClick={() => setSortPref((p) => ({ ...p, key: opt.value }))}
                  >
                    <span className="flex size-4 items-center justify-center">
                      {sortPref.key === opt.value ? (
                        <Check className="size-4 text-emerald-600" />
                      ) : null}
                    </span>
                    {opt.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setSortPref((p) => ({ ...p, dir: 'asc' }))}
                >
                  <span className="flex size-4 items-center justify-center">
                    {sortPref.dir === 'asc' ? (
                      <Check className="size-4 text-emerald-600" />
                    ) : null}
                  </span>
                  正序
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {SORT_DIR_HINT[sortPref.key].asc}
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setSortPref((p) => ({ ...p, dir: 'desc' }))}
                >
                  <span className="flex size-4 items-center justify-center">
                    {sortPref.dir === 'desc' ? (
                      <Check className="size-4 text-emerald-600" />
                    ) : null}
                  </span>
                  倒序
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {SORT_DIR_HINT[sortPref.key].desc}
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="日期筛选"
                  className="flex h-11 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <CalendarRange className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span>{dateLabel}</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {DATE_OPTIONS.map((d) => (
                  <DropdownMenuItem
                    key={d.key}
                    onClick={() => setDateRange(d.key)}
                    className={cn(dateRange === d.key && 'font-bold text-red-500')}
                  >
                    {d.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              aria-pressed={manageMode}
              onClick={() => (manageMode ? exitManage() : setManageMode(true))}
              disabled={papers.length === 0}
              className={cn(
                'ml-auto flex h-11 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium transition-colors disabled:opacity-40',
                manageMode
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'border border-border bg-card text-muted-foreground hover:bg-accent',
              )}
            >
              {manageMode ? (
                <Check className="size-3.5" strokeWidth={2} />
              ) : (
                <Square className="size-3.5" strokeWidth={1.75} />
              )}
              {manageMode ? '完成' : '管理'}
            </button>
          </div>
        </div>

        {/* 列表（时间轴分组） */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-20 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
              <span className="text-sm">加载中…</span>
            </div>
          ) : papers.length === 0 ? (
            <EmptyPapers hasSearch={false} />
          ) : filtered.length === 0 ? (
            <EmptyPapers hasSearch />
          ) : (
            groups.map((g) => (
              <section key={g.bucket ?? 'all'} className="mb-4">
                <h3 className="mb-2 text-xs font-semibold text-muted-foreground">
                  {g.bucket ? BUCKET_LABEL[g.bucket] : '全部试卷'}
                  <span className="ml-1 font-normal">（{g.list.length}）</span>
                </h3>
                <div className="flex flex-col gap-2.5">
                  {g.list.map((p) => (
                    <PaperCard
                      key={p.id}
                      paper={p}
                      showBook={bookId === 'all'}
                      manageMode={manageMode}
                      selected={selected.has(p.id)}
                      expanded={expandedId === p.id}
                      canPractice={!!onPractice}
                      onToggleSelect={() => toggleSelect(p.id)}
                      onToggleExpand={() => setExpandedId(expandedId === p.id ? null : p.id)}
                      onPractice={(items) => onPractice?.(items ?? p.items, p.title)}
                      onExport={(fmt) => exportOne(p, fmt)}
                      onRename={() => setRenaming({ id: p.id, title: p.title })}
                      onDelete={() => setDeleteId(p.id)}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>

        {/* 批量管理底栏 */}
        {manageMode && (
          <div className="shrink-0 border-t border-border bg-card/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>已选 {selected.size} 份</span>
              <button
                type="button"
                onClick={toggleSelectAll}
                className="rounded-full px-2 py-1 font-medium text-foreground transition-colors hover:bg-accent"
              >
                {allSelected ? '取消全选' : '全选'}
              </button>
            </div>
            <div className="flex gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    disabled={selected.size === 0 || busy}
                    className="h-11 flex-1 rounded-full text-sm"
                  >
                    <Download className="size-4" strokeWidth={1.75} /> 批量导出
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-52">
                  <DropdownMenuItem onClick={() => exportBatch('md')}>
                    <FileText className="size-4" strokeWidth={1.75} /> 合并导出 MD
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => exportBatch('html')}>
                    <FileCode2 className="size-4" strokeWidth={1.75} /> 合并导出 HTML
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => exportBatch('pdf')}>
                    <Printer className="size-4" strokeWidth={1.75} /> 合并导出 PDF（打印）
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <AlertDialog open={batchDeleteOpen} onOpenChange={setBatchDeleteOpen}>
                <Button
                  variant="outline"
                  disabled={selected.size === 0 || busy}
                  onClick={() => setBatchDeleteOpen(true)}
                  className="h-11 flex-1 rounded-full border-destructive/40 text-sm text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="size-4" strokeWidth={1.75} /> 删除所选
                </Button>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>删除 {selected.size} 份试卷？</AlertDialogTitle>
                    <AlertDialogDescription>
                      将彻底删除所选试卷及其全部题目，此操作不可撤销。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-white hover:bg-destructive/90"
                      onClick={() => {
                        setBatchDeleteOpen(false)
                        void batchDelete()
                      }}
                    >
                      删除
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        )}

        {/* 重命名弹窗 */}
        <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
          <DialogContent className="max-w-sm rounded-2xl">
            <DialogHeader>
              <DialogTitle>重命名试卷</DialogTitle>
            </DialogHeader>
            <Input
              value={renaming?.title ?? ''}
              onChange={(e) =>
                setRenaming((prev) => (prev ? { ...prev, title: e.target.value } : prev))
              }
              placeholder="输入新的试卷标题"
              aria-label="试卷标题"
              className="h-11 rounded-xl"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void confirmRename()
              }}
            />
            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                className="flex-1 rounded-full"
                onClick={() => setRenaming(null)}
                disabled={busy}
              >
                取消
              </Button>
              <Button
                className="flex-1 rounded-full bg-zinc-900 text-white hover:bg-zinc-800"
                onClick={() => void confirmRename()}
                disabled={busy || !(renaming?.title ?? '').trim()}
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                保存
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 单份删除确认 */}
        <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除这份试卷？</AlertDialogTitle>
              <AlertDialogDescription>
                「{papers.find((p) => p.id === deleteId)?.title ?? ''}」将被彻底删除，此操作不可撤销。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => {
                  const id = deleteId
                  setDeleteId(null)
                  if (id) void deletePaper(id)
                }}
              >
                删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  )
}

// ---------- 试卷卡片 ----------
function PaperCard({
  paper,
  showBook,
  manageMode,
  selected,
  expanded,
  canPractice,
  onToggleSelect,
  onToggleExpand,
  onPractice,
  onExport,
  onRename,
  onDelete,
}: {
  paper: PaperData
  showBook: boolean
  manageMode: boolean
  selected: boolean
  expanded: boolean
  canPractice: boolean
  onToggleSelect: () => void
  onToggleExpand: () => void
  /** 开始练习：不传 items = 全部题目；传入 = 只练勾选的题 */
  onPractice: (items?: PaperItem[]) => void
  onExport: (fmt: PaperExportFormat) => void
  onRename: () => void
  onDelete: () => void
}) {
  // ---- 题目勾选（练习所选 / AI 智能勾选；随试卷卡片 key 重建自动清空） ----
  const items = paper.items ?? []
  const [sel, setSel] = React.useState<Set<number>>(new Set())
  const [aiPickBusy, setAiPickBusy] = React.useState(false)
  const allSel = items.length > 0 && items.every((_, i) => sel.has(i))

  const toggleSel = (i: number) => {
    setSel((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const invertSel = () => setSel(new Set(items.map((_, i) => i).filter((i) => !sel.has(i))))

  /** AI 智能勾选：把试卷题目发给 /api/chat mode:'pick'，挑最值得练的题（与错题本同款契约） */
  const aiPick = async () => {
    if (items.length === 0 || aiPickBusy) return
    const count = Math.min(10, items.length)
    setAiPickBusy(true)
    const tid = toast.loading(`AI 正在挑选最值得练习的 ${count} 道题…`)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'pick',
          questions: items.map((it, i) => ({
            question: it.question ?? '',
            reason: `《${paper.title}》第${i + 1}题`,
          })),
          count,
        }),
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(err.error || 'AI 勾选失败')
      }
      const data = (await res.json()) as { indices?: unknown }
      const idxs = Array.isArray(data.indices)
        ? data.indices.filter(
            (n): n is number =>
              typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < items.length,
          )
        : []
      if (idxs.length === 0) throw new Error('AI 未返回有效选择，请重试')
      setSel(new Set(idxs))
      toast.success(`AI 已勾选 ${idxs.length} 道题`, { id: tid })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'AI 勾选失败', { id: tid })
    } finally {
      setAiPickBusy(false)
    }
  }

  return (
    <div
      className={cn(
        'rounded-2xl bg-card transition-shadow',
        selected && 'ring-1 ring-zinc-900 dark:ring-zinc-100/50',
      )}
    >
      <div className="flex w-full items-start gap-3 p-4">
        {manageMode && (
          <button
            type="button"
            role="checkbox"
            aria-checked={selected}
            aria-label={`选择试卷：${paper.title}`}
            onClick={onToggleSelect}
            className={cn(
              'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border-2 transition-colors',
              selected
                ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                : 'border-zinc-400 bg-transparent text-transparent dark:border-zinc-600',
            )}
          >
            <Check className="size-3.5" strokeWidth={3} />
          </button>
        )}
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => (manageMode ? onToggleSelect() : onToggleExpand())}
        >
          <p className="break-words text-sm font-medium leading-relaxed">{paper.title}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <Badge variant="secondary" className="px-1.5 text-[10px]">
              {paper.count} 题
            </Badge>
            <Badge
              variant="secondary"
              className={cn(
                'px-1.5 text-[10px]',
                paper.source === 'ai' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
                paper.source === 'wrong' && 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
                paper.source === 'extend' && 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
              )}
            >
              {sourceLabel(paper.source)}
            </Badge>
            {showBook && paper.cardTitle && (
              <span className="max-w-32 truncate">《{paper.cardTitle}》</span>
            )}
            <span>{formatDate(paper.createdAt)}</span>
          </div>
        </button>
        {!manageMode && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="试卷操作"
                className="shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <MoreVertical className="size-5" strokeWidth={2} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onToggleExpand}>
                {expanded ? '收起详情' : '查看详情'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onRename}>
                <Pencil className="size-4" strokeWidth={1.75} /> 重命名
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport('md')}>
                <Download className="size-4" strokeWidth={1.75} /> 导出 MD
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport('txt')}>
                <FileText className="size-4" strokeWidth={1.75} /> 导出 TXT
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport('html')}>
                <FileCode2 className="size-4" strokeWidth={1.75} /> 导出 HTML
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport('pdf')}>
                <Printer className="size-4" strokeWidth={1.75} /> 导出 PDF（打印）
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDelete} className="text-destructive">
                <Trash2 className="size-4" strokeWidth={1.75} /> 删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* 详情（内联展开）：题目勾选 + 题目列表 + 练习/导出 */}
      {expanded && (
        <div className="border-t border-border px-4 py-3">
          {/* 工具行：全选/反选 + AI 智能勾选 + 已选计数（有题时显示） */}
          {items.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
              <button
                type="button"
                onClick={() => setSel(allSel ? new Set() : new Set(items.map((_, i) => i)))}
                className="h-8 rounded-full border border-border bg-card px-3 font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {allSel ? '取消全选' : '全选'}
              </button>
              <button
                type="button"
                onClick={invertSel}
                className="h-8 rounded-full border border-border bg-card px-3 font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                反选
              </button>
              <button
                type="button"
                onClick={() => void aiPick()}
                disabled={aiPickBusy}
                className="flex h-8 items-center gap-1 rounded-full border border-purple-500/40 px-3 font-medium text-purple-700 transition-colors hover:bg-purple-500/10 disabled:opacity-50 dark:text-purple-400"
              >
                {aiPickBusy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Sparkles className="size-3.5" />
                )}
                AI 智能勾选
              </button>
              <span className="ml-auto shrink-0 text-muted-foreground">
                已选 {sel.size} / {items.length} 题
              </span>
            </div>
          )}
          <div className="max-h-96 space-y-2.5 overflow-y-auto overscroll-contain">
            {items.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">这份试卷没有题目</p>
            ) : (
              items.map((it, i) => (
                <div key={i} className="rounded-xl bg-muted/40 p-3">
                  <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={sel.has(i)}
                      aria-label={`选择第${i + 1}题`}
                      onClick={() => toggleSel(i)}
                      className="-ml-1 flex size-8 shrink-0 items-center justify-center rounded-full transition-transform active:scale-90"
                    >
                      <RoundCheckbox checked={sel.has(i)} />
                    </button>
                    <span className="text-xs font-semibold text-muted-foreground">第{i + 1}题</span>
                    <Badge variant="secondary" className="px-1.5 text-[10px]">
                      {TYPE_LABEL[it.type] ?? it.type ?? '题目'}
                    </Badge>
                  </div>
                  {/* 题干：富媒体防护容器（break-words + max-w 封顶，绝不撑破题框） */}
                  <div className="min-w-0 max-w-full overflow-hidden break-words">
                    <RichContent content={it.question ?? ''} />
                  </div>
                  {Array.isArray(it.options) && it.options.length > 0 && (
                    <div className="mt-1.5 space-y-1 text-sm">
                      {it.options.map((o, j) => (
                        <p key={j} className="min-w-0 break-words text-muted-foreground">
                          {String.fromCharCode(65 + j)}. {o}
                        </p>
                      ))}
                    </div>
                  )}
                  {(it.answer ?? '').trim() && (
                    <div className="mt-2 min-w-0 max-w-full overflow-hidden break-words rounded-lg bg-emerald-500/5 px-2.5 py-1.5 text-sm">
                      <span className="mr-1 text-xs text-muted-foreground">答案：</span>
                      <span className="font-medium text-emerald-700 dark:text-emerald-300">
                        {it.answer}
                      </span>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {canPractice && (
              <Button
                onClick={() => onPractice()}
                disabled={items.length === 0}
                className="h-11 flex-1 rounded-full bg-zinc-900 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
              >
                <Play className="size-4" strokeWidth={2} /> 开始练习
              </Button>
            )}
            {canPractice && (
              <Button
                onClick={() => onPractice(items.filter((_, i) => sel.has(i)))}
                disabled={sel.size === 0}
                className="h-11 flex-1 rounded-full bg-emerald-600 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
              >
                <Play className="size-4" strokeWidth={2} /> 练习所选（{sel.size}）
              </Button>
            )}
            {/* 导出格式按钮排：MD / TXT / HTML / PDF（打印） */}
            <div className="flex w-full flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => onExport('md')}
                className="h-11 min-w-0 flex-1 rounded-full px-2 text-xs"
              >
                <Download className="size-4 shrink-0" strokeWidth={1.75} /> MD
              </Button>
              <Button
                variant="outline"
                onClick={() => onExport('txt')}
                className="h-11 min-w-0 flex-1 rounded-full px-2 text-xs"
              >
                <FileText className="size-4 shrink-0" strokeWidth={1.75} /> TXT
              </Button>
              <Button
                variant="outline"
                onClick={() => onExport('html')}
                className="h-11 min-w-0 flex-1 rounded-full px-2 text-xs"
              >
                <FileCode2 className="size-4 shrink-0" strokeWidth={1.75} /> HTML
              </Button>
              <Button
                variant="outline"
                onClick={() => onExport('pdf')}
                className="h-11 min-w-0 flex-1 rounded-full px-2 text-xs"
              >
                <Printer className="size-4 shrink-0" strokeWidth={1.75} /> PDF
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- 黑色圆形勾选框（题目勾选，与错题本同款） ----------
function RoundCheckbox({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-full border-2',
        checked
          ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
          : 'border-zinc-400 bg-transparent text-transparent dark:border-zinc-600',
      )}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" className="size-3" aria-hidden>
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </span>
  )
}

// ---------- 空状态 ----------
function EmptyPapers({ hasSearch }: { hasSearch: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl bg-card py-16 text-center">
      <FolderOpen className="size-10 text-muted-foreground/30" strokeWidth={1.5} />
      <p className="text-sm font-medium text-muted-foreground">
        {hasSearch ? '没有匹配的试卷' : '还没有试卷'}
      </p>
      {!hasSearch && (
        <p className="max-w-64 text-xs leading-relaxed text-muted-foreground/70">
          在「AI 出题」生成题目后点「存为试卷」，或把错题「举一反三」的结果存进来，就能在这里随时重练
        </p>
      )}
    </div>
  )
}

export default PapersView
