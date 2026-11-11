'use client'

// 收藏题目（favorite=true 的 QuizItem）+ AI 能力（与错题本完全对齐）：
//   • 搜索（题目/答案/书名输入即筛 + 命中高亮）、排序（时间/字母 正倒序，localStorage 记忆）
//   • 筛选（卡片分类 + 时间段含自定义）、统计（总数/题型分布）
//   • 朗读（useQuickTts 'quiz'，题干+答案）、举一反三（AI 讲解变式题 extend / 直接练习相似题
//     /api/quiz similar）、AI 解析（/api/chat mode:'analyze'，课文上下文 /api/cards 缓存）
//   • 批量（多选长按/右键）：练习所选 / 举一反三 / AI 批量讲解汇总（mode:'ask'）/
//     导出选中 / 取消收藏 / 删除；智能菜单（AI 智能勾选 pick / 按题型 / 反选 / 全选）
//   • 导出 CSV / Markdown / TXT / 复制 / 打印
//   • 解析 Dialog 内选中文本 → 浮动「🔍 追问」按钮 →
//     dispatch window 'app:followup' {text, source:'favorite', cardId, cardTitle}
//     （追问弹层接管），随后关闭 Dialog。
import * as React from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowUpDown,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  Copy,
  Download,
  GraduationCap,
  Lightbulb,
  Loader2,
  MoreVertical,
  Play,
  Printer,
  Save,
  Search,
  Sparkles,
  Square,
  Star,
  Trash2,
  Volume2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import type { QuizItemData, QuizType } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useLocalStorage } from '@/lib/use-local-storage'
import { useSettingsLite } from '@/lib/voice-prefs'
import { useQuickTts } from '@/components/recitation/tts-player'
import RichContent from '@/components/recitation/rich-content'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { BottomSheet } from '@/components/recitation/bottom-sheet'
import { PracticeBoard, PracticeDone } from '@/components/recitation/wrong-questions-view'

interface FavoritesViewProps {
  onBack: () => void
}

const TYPE_LABEL: Record<QuizType, string> = {
  fill: '填空',
  short: '简答',
  choice: '选择',
}

type TimeKey = 'all' | 'today' | '3d' | '7d' | '30d' | 'custom'

const TIME_OPTIONS: { key: TimeKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今天' },
  { key: '3d', label: '近3天' },
  { key: '7d', label: '近7天' },
  { key: '30d', label: '近30天' },
  { key: 'custom', label: '自定义' },
]

// ---------- 排序（与错题本同款；useLocalStorage 记忆，key 各自独立） ----------
type SortKey = 'time-desc' | 'time-asc' | 'alpha-asc' | 'alpha-desc'

const SORT_OPTIONS: { key: SortKey; label: string; short: string }[] = [
  { key: 'time-desc', label: '时间 · 最新在前', short: '最新在前' },
  { key: 'time-asc', label: '时间 · 最早在前', short: '最早在前' },
  { key: 'alpha-asc', label: '题目 · A→Z', short: 'A→Z' },
  { key: 'alpha-desc', label: '题目 · Z→A', short: 'Z→A' },
]

/** 告知 AI 可用富文本格式回答（拼进 user prompt，回答由 RichContent 原样渲染） */
const RICH_FORMAT_HINT =
  '你可以在回答中使用以下格式，会原样渲染：Markdown（标题/列表/表格/加粗）、LaTeX 公式（$...$ 行内与 $$...$$ 展示）、mermaid 图表（```mermaid 代码块，支持思维导图 mindmap / 树状图 / 流程图）、HTML 片段、代码块。请按需选择最清晰的表达格式。'

/** 搜索：多个关键词（空白分隔）全部命中才算匹配（题目/答案/书名/选项） */
function matchQuery(item: QuizItemData, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = [item.question, item.answer, item.cardTitle, ...item.options]
    .join('\n')
    .toLowerCase()
  return words.every((w) => hay.includes(w))
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`
  if (d.getFullYear() === now.getFullYear())
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

// 高亮搜索命中词（大小写不敏感，最多标 10 处；与目录/搜索浮层同款样式）
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const lower = text.toLowerCase()
  const ql = query.toLowerCase()
  const parts: React.ReactNode[] = []
  let cursor = 0
  let pos = lower.indexOf(ql)
  let k = 0
  while (pos >= 0 && k < 10) {
    k++
    if (pos > cursor) parts.push(text.slice(cursor, pos))
    parts.push(
      <mark
        key={`hl-${k}`}
        className="rounded-sm bg-[#4f5cd1]/15 px-0.5 font-semibold text-[#4f5cd1]"
      >
        {text.slice(pos, pos + query.length)}
      </mark>,
    )
    cursor = pos + query.length
    pos = lower.indexOf(ql, cursor)
  }
  parts.push(text.slice(cursor))
  return <>{parts}</>
}

// ---------- 试卷条目（存为试卷用；兼容 QuizItem 形状 + 可选解析） ----------
interface PaperItem {
  type: 'short'
  question: string
  answer: string
  analysis?: string
}

/** 从一段 section 文本里抽取 `**题目：** …` / `**答案：** …` / `**解析：** …` 字段。 */
function extractField(body: string, label: string): string | null {
  const re = new RegExp(
    `\\*{0,2}${label}\\s*[：:]\\*{0,2}\\s*([\\s\\S]*?)(?=\\n\\s*\\*{0,2}(?:题目|答案|解析)\\s*[：:]|$)`,
  )
  const m = body.match(re)
  return m ? m[1].trim() : null
}

/**
 * 解析「举一反三」AI 文本为试卷题目：
 * 按 `## 第N题` 分节，节内抽 题目/答案/解析；
 * 完全解析不出时，把整段文本作为一道简答题存入（兜底）。
 */
function parseExtendItems(text: string): PaperItem[] {
  const normalized = (text || '').trim()
  if (!normalized) return []
  const headingRe = /^##\s*第\s*[0-9一二三四五六七八九十百]+\s*题[^\n]*$/gm
  const idxs: number[] = []
  let m: RegExpExecArray | null
  while ((m = headingRe.exec(normalized)) !== null) idxs.push(m.index)
  if (idxs.length === 0) {
    return [{ type: 'short', question: normalized.slice(0, 4000), answer: '' }]
  }
  const out: PaperItem[] = []
  for (let i = 0; i < idxs.length; i++) {
    const body = normalized.slice(idxs[i], i + 1 < idxs.length ? idxs[i + 1] : normalized.length)
    const question = extractField(body, '题目') ?? body.replace(/^##[^\n]*\n?/, '').trim()
    if (!question) continue
    out.push({
      type: 'short',
      question: question.slice(0, 500),
      answer: (extractField(body, '答案') ?? '').slice(0, 2000),
      analysis: (extractField(body, '解析') ?? '').slice(0, 2000) || undefined,
    })
  }
  if (out.length === 0) {
    return [{ type: 'short', question: normalized.slice(0, 4000), answer: '' }]
  }
  return out
}

function truncate(text: string, n: number): string {
  return text.length > n ? text.slice(0, n) + '…' : text
}

/** 触发浏览器下载（CSV/MD/TXT 共用） */
function downloadBlob(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// 空状态简笔画：打开的纸箱（浅紫箱体 + 黑描边 + 白标签 + 上方放射短线）
function EmptyFavoritesIllustration() {
  return (
    <svg viewBox="0 0 140 120" className="h-28 w-32" fill="none" aria-hidden role="img">
      {/* 放射短线 */}
      <path
        d="M70 22 V10 M50 26 l-6 -9 M90 26 l6 -9 M34 38 l-10 -5 M106 38 l10 -5"
        stroke="#171717"
        strokeWidth="2"
        strokeLinecap="round"
      />
      {/* 打开的纸箱：后箱壁 */}
      <path
        d="M36 58 L70 44 L104 58 L104 92 L70 106 L36 92 Z"
        fill="#c7c9f5"
        stroke="#171717"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* 翻开的两片盖子 */}
      <path
        d="M36 58 L14 48 L46 36 L70 44 Z"
        fill="#dcdcfb"
        stroke="#171717"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M104 58 L126 48 L94 36 L70 44 Z"
        fill="#dcdcfb"
        stroke="#171717"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* 前箱壁 */}
      <path
        d="M36 58 L70 72 L104 58 L104 92 L70 106 L36 92 Z"
        fill="#c7c9f5"
        stroke="#171717"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* 白色标签 */}
      <rect x="56" y="76" width="28" height="18" rx="3" fill="#ffffff" stroke="#171717" strokeWidth="1.6" />
      <path d="M61 82 h18 M61 87 h12" stroke="#171717" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

const SCROLLBAR =
  '[scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:min-h-6 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent'

// 黑色圆形勾选框（多选模式，与错题本同款）
function RoundCheckbox({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2',
        checked
          ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
          : 'border-zinc-400 bg-transparent text-transparent dark:border-zinc-600',
      )}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-3"
        aria-hidden
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </span>
  )
}

type FavMode = 'list' | 'practice' | 'similar' | 'done'
type AiOpen = 'extend' | 'analyze' | 'batch' | null

// 收藏题目：搜索/排序/筛选/统计 + 朗读 + AI（解析/举一反三/批量讲解）+ 批量操作 + 导出（全屏视图）
export function FavoritesView({ onBack }: FavoritesViewProps) {
  const [items, setItems] = React.useState<QuizItemData[]>([])
  const [loading, setLoading] = React.useState(true)
  const [removingId, setRemovingId] = React.useState<string | null>(null)

  // ---------- 搜索 / 排序 / 筛选 ----------
  const [query, setQuery] = React.useState('')
  const [sortKey, setSortKey] = useLocalStorage<SortKey>('bb-fav-sort', 'time-desc')
  const [cardFilter, setCardFilter] = React.useState<string>('all')
  const [timeFilter, setTimeFilter] = React.useState<TimeKey>('all')
  // 自定义时间段：customStart/customEnd 为输入草稿，customRange 为点「确定」后生效的范围（空串 = 该侧不限）
  const [customStart, setCustomStart] = React.useState('')
  const [customEnd, setCustomEnd] = React.useState('')
  const [customRange, setCustomRange] = React.useState<{ start: string; end: string } | null>(
    null,
  )

  // ---------- TTS（context 'quiz'，随设置里的音色/语速；朗读题干+答案） ----------
  const settings = useSettingsLite()
  const tts = useQuickTts('quiz', settings)

  // ---------- 选择模式 / 练习（勾选练习 + AI 智能勾选） ----------
  const [mode, setMode] = React.useState<FavMode>('list')
  const [selectMode, setSelectMode] = React.useState(false)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [aiPickBusy, setAiPickBusy] = React.useState(false)
  const [practiceItems, setPracticeItems] = React.useState<QuizItemData[]>([])
  const [done, setDone] = React.useState<{ right: number; total: number } | null>(null)
  const [batchBusy, setBatchBusy] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)

  // ---------- 举一反三（直接练习相似题 /api/quiz similar） ----------
  const [similarBusy, setSimilarBusy] = React.useState(false)
  const [similarItems, setSimilarItems] = React.useState<QuizItemData[]>([])
  /** 举一反三方式选择弹层：大按钮/单题行内按钮点击后弹（AI 讲解变式题 / 直接练习相似题）。 */
  const [extendChoice, setExtendChoice] = React.useState<{ base: QuizItemData[] } | null>(null)

  // ---------- AI（举一反三 / 解析 / 批量讲解） ----------
  const [aiOpen, setAiOpen] = React.useState<AiOpen>(null)
  const [aiItem, setAiItem] = React.useState<QuizItemData | null>(null)
  const [aiCount, setAiCount] = React.useState(0)
  const [aiText, setAiText] = React.useState('')
  const [aiLoading, setAiLoading] = React.useState(false)
  const [savingPaper, setSavingPaper] = React.useState(false)
  // 选中文本追问（解析 Dialog）
  const [selFollow, setSelFollow] = React.useState<{ text: string; x: number; y: number } | null>(
    null,
  )
  const contentRef = React.useRef<HTMLDivElement>(null)
  // 课文内容缓存（AI解析上下文）：cardId -> content（'' = 已知无课文）
  const cardContentCache = React.useRef(new Map<string, string>())

  const loadItems = React.useCallback(async () => {
    try {
      const res = await fetch('/api/quiz-items?favorite=1')
      if (!res.ok) throw new Error('加载收藏失败')
      const data = (await res.json()) as { items: QuizItemData[] }
      setItems(data.items ?? [])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载收藏失败')
    }
  }, [])

  React.useEffect(() => {
    let alive = true
    ;(async () => {
      await loadItems()
      if (alive) setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [loadItems])

  // 卸载时停止朗读
  React.useEffect(() => {
    const stop = tts.stop
    return () => stop()
  }, [tts.stop])

  const unfavorite = async (id: string) => {
    setRemovingId(id)
    try {
      const res = await fetch('/api/quiz-items', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, favorite: false }),
      })
      if (!res.ok) throw new Error('取消收藏失败')
      setItems((list) => list.filter((i) => i.id !== id))
      toast.success('已取消收藏')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '取消收藏失败')
    } finally {
      setRemovingId(null)
    }
  }

  // ---------- 筛选 + 搜索 + 排序 ----------
  const cards = React.useMemo(() => {
    const map = new Map<string, string>()
    items.forEach((i) => {
      if (i.cardId && !map.has(i.cardId)) map.set(i.cardId, i.cardTitle || '未命名卡片')
    })
    return [...map.entries()].map(([id, title]) => ({ id, title }))
  }, [items])

  const cardLabel =
    cardFilter === 'all'
      ? '全部卡片'
      : (cards.find((c) => c.id === cardFilter)?.title ?? '全部卡片')

  const filteredItems = React.useMemo(() => {
    const q = query.trim()
    const now = Date.now()
    const passed = items.filter((i) => {
      if (cardFilter !== 'all' && i.cardId !== cardFilter) return false
      if (timeFilter !== 'all') {
        // 按收藏/最近变动时间（updatedAt）筛选；自定义区间含起止当天
        const t = new Date(i.updatedAt).getTime()
        if (Number.isNaN(t)) return false
        if (timeFilter === 'today')
          return new Date(t).toDateString() === new Date(now).toDateString()
        if (timeFilter === '3d') return now - t <= 3 * 86400000
        if (timeFilter === '7d') return now - t <= 7 * 86400000
        if (timeFilter === '30d') return now - t <= 30 * 86400000
        // 自定义：未点「确定」前暂不筛选
        const range = customRange
        if (!range) return true
        if (range.start && t < new Date(`${range.start}T00:00:00`).getTime()) return false
        if (range.end && t > new Date(`${range.end}T23:59:59.999`).getTime()) return false
      }
      return !q || matchQuery(i, q)
    })
    // 排序：时间 = 收藏/最近变动（updatedAt）；字母 = 题干中文拼音序（zh-CN）
    const cmp =
      sortKey === 'time-desc'
        ? (a: QuizItemData, b: QuizItemData) => b.updatedAt.localeCompare(a.updatedAt)
        : sortKey === 'time-asc'
          ? (a: QuizItemData, b: QuizItemData) => a.updatedAt.localeCompare(b.updatedAt)
          : sortKey === 'alpha-asc'
            ? (a: QuizItemData, b: QuizItemData) =>
                a.question.localeCompare(b.question, 'zh-CN') || a.updatedAt.localeCompare(b.updatedAt)
            : (a: QuizItemData, b: QuizItemData) =>
                b.question.localeCompare(a.question, 'zh-CN') || a.updatedAt.localeCompare(b.updatedAt)
    return [...passed].sort(cmp)
  }, [items, query, cardFilter, timeFilter, customRange, sortKey])

  // 时间筛选是否真正生效（自定义未确定范围时不算）
  const timeActive = timeFilter !== 'all' && (timeFilter !== 'custom' || !!customRange)
  const customRangeText = customRange
    ? `${customRange.start || '最早'} ~ ${customRange.end || '今天'}`
    : ''

  const applyCustomRange = () => {
    const start = customStart.trim()
    const end = customEnd.trim()
    if (!start && !end) {
      toast.warning('请选择开始或结束日期')
      return
    }
    if (start && end && start > end) {
      toast.warning('开始日期不能晚于结束日期')
      return
    }
    setCustomRange({ start, end })
  }

  // ---------- 统计（2×2：总数 + 题型分布） ----------
  const favStats = React.useMemo(
    () => [
      { value: items.length, label: '收藏题' },
      { value: items.filter((i) => i.type === 'fill').length, label: '填空' },
      { value: items.filter((i) => i.type === 'short').length, label: '简答' },
      { value: items.filter((i) => i.type === 'choice').length, label: '选择' },
    ],
    [items],
  )

  // ---------- 选择模式（参考错题本：长按 / 右键 / 顶栏入口） ----------
  const selectedItems = filteredItems.filter((i) => selected.has(i.id))
  const allSelected = filteredItems.length > 0 && filteredItems.every((i) => selected.has(i.id))

  const toggleSelectItem = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(filteredItems.map((i) => i.id)))
  }

  const invertSelect = () =>
    setSelected(new Set(filteredItems.filter((i) => !selected.has(i.id)).map((i) => i.id)))

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelected(new Set())
  }

  // ---- 智能勾选（按题型 / 反选），与错题本智能菜单同款交互 ----
  const smartSelect = (kind: 'fill' | 'short' | 'choice' | 'invert') => {
    if (filteredItems.length === 0) {
      toast('当前筛选下没有收藏题')
      return
    }
    let next: Set<string>
    if (kind === 'invert') {
      next = new Set(filteredItems.filter((i) => !selected.has(i.id)).map((i) => i.id))
      toast.success(`已反选 ${next.size} 道`)
    } else {
      next = new Set(filteredItems.filter((i) => i.type === kind).map((i) => i.id))
      toast.success(`已选${TYPE_LABEL[kind]}题 ${next.size} 道`)
    }
    setSelected(next)
  }

  // ---- 长按进入多选 ----
  const pressTimer = React.useRef<number | null>(null)
  const clearPress = React.useCallback(() => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
  }, [])
  React.useEffect(() => clearPress, [clearPress])
  const startPress = (id: string) => {
    clearPress()
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null
      if (!selectMode && mode === 'list') {
        setSelectMode(true)
        setSelected(new Set([id]))
      }
    }, 500)
  }

  // ---------- AI 智能勾选（/api/chat mode:'pick'，与错题本同款契约） ----------
  const aiPick = async () => {
    if (filteredItems.length === 0) {
      toast('当前筛选下没有收藏题')
      return
    }
    const count = Math.min(10, filteredItems.length)
    setAiPickBusy(true)
    const tid = toast.loading(`AI 正在挑选最值得练习的 ${count} 道题…`)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'pick',
          questions: filteredItems.map((i) => ({ question: i.question, reason: '收藏题' })),
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
              typeof n === 'number' &&
              Number.isInteger(n) &&
              n >= 0 &&
              n < filteredItems.length,
          )
        : []
      if (idxs.length === 0) throw new Error('AI 未返回有效选择，请重试')
      setSelected(new Set(idxs.map((n) => filteredItems[n].id)))
      toast.success(`AI 已勾选 ${idxs.length} 道题`, { id: tid })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'AI 勾选失败', { id: tid })
    } finally {
      setAiPickBusy(false)
    }
  }

  // ---------- 批量操作：取消收藏 / 删除 ----------
  const runBatch = async (kind: 'unfav' | 'delete') => {
    const ids = [...selected]
    if (ids.length === 0) return
    setBatchBusy(true)
    try {
      await Promise.all(
        ids.map(async (id) => {
          if (kind === 'delete') {
            const res = await fetch(`/api/quiz-items?id=${id}`, { method: 'DELETE' })
            if (!res.ok) throw new Error('删除失败')
          } else {
            const res = await fetch('/api/quiz-items', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id, favorite: false }),
            })
            if (!res.ok) throw new Error('操作失败')
          }
        }),
      )
      toast.success(
        kind === 'delete' ? `已删除 ${ids.length} 道题目` : `已取消收藏 ${ids.length} 道题`,
      )
      exitSelectMode()
      await loadItems()
    } catch {
      toast.error('批量操作失败，请重试')
    } finally {
      setBatchBusy(false)
    }
  }

  // ---------- 练习所选（复用错题本 PracticeBoard：作答上报 /api/quiz-items） ----------
  const startPractice = (list: QuizItemData[]) => {
    if (list.length === 0) {
      toast('请先勾选要练习的题目')
      return
    }
    setPracticeItems(list)
    setMode('practice')
  }

  const onPracticeDone = (right: number) => {
    const total = mode === 'similar' ? similarItems.length : practiceItems.length
    setDone({ right, total })
    setMode('done')
    void loadItems() // 练习可能改变收藏/答对次数，静默刷新
  }

  // ---------- 朗读收藏题：题干 + 答案（答案常显，与错题本展开态一致） ----------
  const speakItem = (item: QuizItemData) => {
    if (tts.speaking) {
      tts.stop()
      return
    }
    const opts = item.options.length > 0 ? `。选项：${item.options.join('；')}` : ''
    tts.speak(
      item.answer
        ? `题目：${item.question}${opts}。答案：${item.answer}`
        : `题目：${item.question}${opts}`,
    )
  }

  // ---------- 顶栏返回 ----------
  const handleBack = () => {
    if (selectMode) {
      exitSelectMode()
      return
    }
    if (mode === 'practice' || mode === 'similar' || mode === 'done') {
      setMode('list')
      return
    }
    onBack()
  }

  // ---------- 课文上下文（缓存，一次拉全量卡） ----------
  const getCardContent = React.useCallback(async (cardId: string): Promise<string> => {
    if (!cardId) return ''
    const cache = cardContentCache.current
    const hit = cache.get(cardId)
    if (hit !== undefined) return hit
    try {
      const res = await fetch('/api/cards')
      if (res.ok) {
        const data = (await res.json()) as { cards?: { id: string; content: string }[] }
        for (const c of data.cards ?? []) cache.set(c.id, c.content)
      }
    } catch {
      /* 上下文缺省也能解析 */
    }
    if (!cache.has(cardId)) cache.set(cardId, '') // 负缓存：该书已删除/无内容
    return cache.get(cardId) ?? ''
  }, [])

  // ---------- 举一反三（AI 讲解变式题，mode:'extend'） ----------
  const runExtend = async (baseItems: QuizItemData[]) => {
    if (baseItems.length === 0) {
      toast.warning('请先选择题目')
      return
    }
    if (baseItems.length > 8) toast('一次最多 8 道题，已取前 8 道生成')
    const use = baseItems.slice(0, 8)
    setAiItem(use[0] ?? null)
    setAiCount(use.length)
    setAiOpen('extend')
    setAiText('')
    setAiLoading(true)
    const tid = toast.loading('AI 正在举一反三…')
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'extend',
          items: use.map((i) => ({ question: i.question, answer: i.answer, type: i.type })),
          count: 3,
        }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '生成失败')
      const data = (await res.json()) as { text?: string }
      if (!data.text) throw new Error('AI 未返回内容')
      setAiText(data.text)
      toast.success('已生成变式题', { id: tid })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '举一反三失败', { id: tid })
      setAiOpen(null)
    } finally {
      setAiLoading(false)
    }
  }

  // ---------- 举一反三（直接练习相似题，/api/quiz mode:'similar'） ----------
  const startSimilar = async (baseItems: QuizItemData[]) => {
    if (baseItems.length === 0) {
      toast.warning('请先选择题目')
      return
    }
    setSimilarBusy(true)
    const tid = toast.loading('AI 正在生成相似新题…')
    try {
      const res = await fetch('/api/quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'similar',
          questions: baseItems.slice(0, 10).map((i) => ({
            question: i.question,
            answer: i.answer,
            type: i.type,
            options: i.options,
          })),
        }),
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(err.error || '出题失败')
      }
      const data = (await res.json()) as {
        questions?: { type: string; question: string; answer: string; options?: string[] }[]
      }
      const qs = data.questions ?? []
      if (qs.length === 0) throw new Error('AI 未返回新题，请重试')
      const src = baseItems[0]
      const mapped: QuizItemData[] = qs.map((q, i) => {
        let type: QuizType = 'fill'
        let options: string[] = []
        let answer = q.answer
        if (q.type === 'choice') {
          type = 'choice'
          options = q.options ?? []
        } else if (q.type === 'short') {
          type = 'short'
        }
        return {
          id: `sim-${Date.now()}-${i}`,
          cardId: src?.cardId ?? '',
          cardTitle: baseItems.length === 1 ? src?.cardTitle || '举一反三' : '举一反三',
          type,
          question: q.question,
          answer,
          options,
          wrongCount: 0,
          rightCount: 0,
          favorite: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      })
      setSimilarItems(mapped)
      setMode('similar')
      toast.success(`已生成 ${mapped.length} 道相似新题`, { id: tid })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '举一反三失败', { id: tid })
    } finally {
      setSimilarBusy(false)
    }
  }

  // ---------- AI 解析（单题，mode:'analyze'，课文上下文） ----------
  const runAnalyze = async (item: QuizItemData) => {
    setAiItem(item)
    setAiCount(1)
    setAiOpen('analyze')
    setAiText('')
    setAiLoading(true)
    const tid = toast.loading('正在获取课文上下文…')
    try {
      const context = await getCardContent(item.cardId)
      toast.loading('AI 正在解析…', { id: tid })
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'analyze',
          question: item.question,
          answer: item.answer || undefined,
          context,
        }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '解析失败')
      const data = (await res.json()) as { text?: string }
      if (!data.text) throw new Error('AI 未返回内容')
      setAiText(data.text)
      toast.success('解析已生成', { id: tid })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'AI 解析失败', { id: tid })
      setAiOpen(null)
    } finally {
      setAiLoading(false)
    }
  }

  // ---------- AI 批量讲解汇总（mode:'ask'，逐题讲解 + 共性总结） ----------
  const runBatchExplain = async (list: QuizItemData[]) => {
    if (list.length === 0) {
      toast('请先勾选要讲解的题目')
      return
    }
    const use = list.slice(0, 8)
    if (list.length > 8) toast('一次最多讲解 8 道题，已取前 8 道')
    setAiItem(use[0] ?? null)
    setAiCount(use.length)
    setAiOpen('batch')
    setAiText('')
    setAiLoading(true)
    const tid = toast.loading(`AI 正在讲解 ${use.length} 道题…`)
    try {
      const lines = [
        use.length > 1
          ? `逐题讲解下面 ${use.length} 道收藏题的知识点与思路，最后总结共性：`
          : '讲解这道题涉及的知识点：',
        ...use.map(
          (i, n) =>
            `${n + 1}. [${TYPE_LABEL[i.type] ?? '题目'}] ${i.question}${i.answer ? `（答案：${i.answer}）` : ''}`,
        ),
        RICH_FORMAT_HINT,
      ]
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'ask',
          content: use[0].cardTitle ? `来自卡片「${use[0].cardTitle}」的收藏题` : '收藏题目讲解',
          messages: [{ role: 'user', content: lines.join('\n') }],
        }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'AI 讲解失败')
      const data = (await res.json()) as { reply?: string }
      if (!data.reply) throw new Error('AI 未返回内容')
      setAiText(data.reply)
      toast.success('讲解已生成', { id: tid })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'AI 讲解失败', { id: tid })
      setAiOpen(null)
    } finally {
      setAiLoading(false)
    }
  }

  // ---------- 存为试卷 ----------
  const saveAsPaper = async () => {
    if (!aiItem || !aiText) return
    if (!aiItem.cardId) {
      toast.error('该题没有关联书本，无法存为试卷')
      return
    }
    setSavingPaper(true)
    try {
      const paperItems = parseExtendItems(aiText)
      const res = await fetch('/api/papers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardId: aiItem.cardId,
          title: `举一反三 ${aiItem.question.slice(0, 10)}`,
          items: paperItems,
          source: 'manual',
        }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '保存失败')
      toast.success(`已存为试卷（${paperItems.length} 题）`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '存为试卷失败')
    } finally {
      setSavingPaper(false)
    }
  }

  /** 举一反三讲解直接载入练习：解析变式题后进入作答流。 */
  const practiceExtend = () => {
    const parsed = parseExtendItems(aiText).filter((p) => p.question)
    if (parsed.length === 0) {
      toast.warning('讲解中没有解析出可练习的变式题，可先「存为试卷」')
      return
    }
    const src = aiItem
    const mapped: QuizItemData[] = parsed.map((q, i) => ({
      id: `ext-${Date.now()}-${i}`,
      cardId: src?.cardId ?? '',
      cardTitle: aiCount === 1 ? src?.cardTitle || '举一反三' : '举一反三',
      type: 'short',
      question: q.question,
      answer: q.answer,
      options: [],
      wrongCount: 0,
      rightCount: 0,
      favorite: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }))
    setAiOpen(null)
    setSimilarItems(mapped)
    setMode('similar')
    toast.success(`已载入 ${mapped.length} 道变式题，开始练习`)
  }

  // ---------- 导出（CSV / Markdown / TXT / 复制 / 打印） ----------
  const exportList = (list?: QuizItemData[]) => {
    const target = list ?? filteredItems
    if (target.length === 0) {
      toast(list ? '未选中任何收藏题' : '当前筛选下没有收藏题')
      return null
    }
    return target
  }

  const exportCSV = (list?: QuizItemData[]) => {
    const target = exportList(list)
    if (!target) return
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const rows: string[][] = [
      ['题目', '类型', '答案', '来源卡片', '时间'],
      ...target.map((i) => [
        i.question,
        TYPE_LABEL[i.type] ?? i.type,
        i.answer,
        i.cardTitle,
        new Date(i.updatedAt).toLocaleString('zh-CN'),
      ]),
    ]
    const csv = '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n')
    const tag = list && list.length < filteredItems.length ? `_选中${list.length}` : ''
    downloadBlob(csv, `收藏题目_${new Date().toISOString().slice(0, 10)}${tag}.csv`, 'text/csv;charset=utf-8')
    toast.success(`已导出 ${target.length} 道收藏题`)
  }

  const buildMD = (list: QuizItemData[]) =>
    [
      '# 收藏题目导出',
      `> 共 ${list.length} 道 · 导出于 ${new Date().toLocaleString('zh-CN')}`,
      '',
      ...list.flatMap((i, n) => [
        `## ${n + 1}. [${TYPE_LABEL[i.type] ?? i.type}] ${i.question}`,
        `- **答案**：${i.answer || '（无标准答案）'}`,
        i.cardTitle ? `- **来源**：《${i.cardTitle}》` : '',
        `- **时间**：${formatDate(i.updatedAt)}`,
        '',
      ]),
    ]
      .filter((l) => l !== '')
      .join('\n')

  const buildTXT = (list: QuizItemData[]) =>
    [
      `收藏题目导出（共 ${list.length} 道 · ${new Date().toLocaleString('zh-CN')}）`,
      '',
      ...list.flatMap((i, n) => [
        `${n + 1}. [${TYPE_LABEL[i.type] ?? i.type}] ${i.question}`,
        `   答案：${i.answer || '（无标准答案）'}`,
        i.cardTitle ? `   来源：${i.cardTitle}` : '',
        `   时间：${formatDate(i.updatedAt)}`,
        '',
      ]),
    ].join('\n')

  const exportMD = (list?: QuizItemData[]) => {
    const target = exportList(list)
    if (!target) return
    const tag = list && list.length < filteredItems.length ? `_选中${list.length}` : ''
    downloadBlob(
      buildMD(target),
      `收藏题目_${new Date().toISOString().slice(0, 10)}${tag}.md`,
      'text/markdown;charset=utf-8',
    )
    toast.success(`已导出 Markdown（${target.length} 题）`)
  }

  const exportTXT = (list?: QuizItemData[]) => {
    const target = exportList(list)
    if (!target) return
    const tag = list && list.length < filteredItems.length ? `_选中${list.length}` : ''
    downloadBlob(
      buildTXT(target),
      `收藏题目_${new Date().toISOString().slice(0, 10)}${tag}.txt`,
      'text/plain;charset=utf-8',
    )
    toast.success(`已导出 TXT（${target.length} 题）`)
  }

  const copyAll = async (list?: QuizItemData[]) => {
    const target = exportList(list)
    if (!target) return
    try {
      await navigator.clipboard.writeText(buildTXT(target))
      toast.success(`已复制 ${target.length} 道收藏题`)
    } catch {
      toast.error('复制失败，请重试')
    }
  }

  // ---------- 解析 Dialog：选中文本 → 浮动追问按钮 ----------
  const checkSelection = React.useCallback(() => {
    const container = contentRef.current
    if (!container) {
      setSelFollow(null)
      return
    }
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setSelFollow(null)
      return
    }
    const raw = sel.toString().trim().replace(/\s+/g, ' ')
    if (!raw) {
      setSelFollow(null)
      return
    }
    const node = sel.anchorNode
    if (!node) {
      setSelFollow(null)
      return
    }
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
    if (!el || !container.contains(el)) {
      setSelFollow(null)
      return
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    const vw = window.innerWidth || 375
    const vh = window.innerHeight || 667
    setSelFollow({
      text: raw.slice(0, 500),
      x: Math.min(Math.max(rect.left + rect.width / 2, 96), vw - 96),
      y: Math.min(rect.bottom + 10, vh - 64),
    })
  }, [])

  React.useEffect(() => {
    if (aiOpen !== 'analyze' || !aiText) return
    document.addEventListener('selectionchange', checkSelection)
    document.addEventListener('mouseup', checkSelection)
    document.addEventListener('touchend', checkSelection)
    return () => {
      document.removeEventListener('selectionchange', checkSelection)
      document.removeEventListener('mouseup', checkSelection)
      document.removeEventListener('touchend', checkSelection)
      setSelFollow(null)
    }
  }, [aiOpen, aiText, checkSelection])

  const sendFollowup = () => {
    if (!selFollow) return
    window.dispatchEvent(
      new CustomEvent('app:followup', {
        detail: {
          text: selFollow.text,
          source: 'favorite',
          cardId: aiItem?.cardId ?? '',
          cardTitle: aiItem?.cardTitle ?? '',
        },
      }),
    )
    try {
      window.getSelection()?.removeAllRanges()
    } catch {
      /* ignore */
    }
    setSelFollow(null)
    setAiOpen(null)
    toast.success('已发送追问')
  }

  const sortLabel = SORT_OPTIONS.find((s) => s.key === sortKey)?.short ?? '最新在前'
  const hlQuery = query.trim()

  return (
    <div className="min-h-dvh bg-muted/40">
      {/* 打印样式：仅显示收藏题单 */}
      <style>{`@media print {
        body * { visibility: hidden !important; }
        #fav-print, #fav-print * { visibility: visible !important; }
        #fav-print { position: absolute; left: 0; top: 0; width: 100%; display: block !important; padding: 0 12px; }
      }`}</style>

      {/* 顶栏 */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="relative mx-auto flex h-14 max-w-2xl items-center px-4">
          <button
            type="button"
            aria-label="返回"
            onClick={handleBack}
            className="shrink-0 rounded-full p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="size-6 text-foreground" strokeWidth={2} />
          </button>
          <h1 className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-lg font-bold">
            {mode === 'similar'
              ? '举一反三'
              : mode === 'practice'
                ? '练习收藏'
                : selectMode
                  ? `已选 ${selected.size}`
                  : '收藏题目'}
          </h1>
          {mode === 'list' && !selectMode && (
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={() => {
                  setSelectMode(true)
                  setSelected(new Set())
                }}
                disabled={filteredItems.length === 0}
                className="px-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
              >
                选择
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="更多操作"
                    className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <MoreVertical className="size-5" strokeWidth={2} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => exportCSV()}>
                    <Download className="size-4" /> 导出 CSV
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => exportMD()}>
                    <Download className="size-4" /> 导出 Markdown
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => exportTXT()}>
                    <Download className="size-4" /> 导出 TXT
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void copyAll()}>
                    <Copy className="size-4" /> 复制全部
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => window.print()}>
                    <Printer className="size-4" /> 打印
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
          {mode === 'list' && selectMode && (
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="智能选择"
                    className="rounded-full px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Sparkles className="inline size-4 align-[-2px]" strokeWidth={1.75} />
                    <span className="ml-0.5">智能</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => void aiPick()} disabled={aiPickBusy}>
                    {aiPickBusy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Sparkles className="size-4" />
                    )}
                    AI 智能勾选
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => smartSelect('fill')}>只选填空题</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => smartSelect('short')}>只选简答题</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => smartSelect('choice')}>只选选择题</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => smartSelect('invert')}>反选</DropdownMenuItem>
                  <DropdownMenuItem onClick={toggleSelectAll}>
                    {allSelected ? '取消全选' : '全选'}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </header>

      <main
        className={cn(
          'mx-auto w-full max-w-2xl px-4 pt-4',
          selectMode && mode === 'list' ? 'pb-64' : 'pb-16',
        )}
      >
        {mode === 'practice' ? (
          <PracticeBoard
            items={practiceItems}
            autoRemove={2}
            onDone={onPracticeDone}
            onExit={() => setMode('list')}
          />
        ) : mode === 'similar' ? (
          <PracticeBoard
            items={similarItems}
            autoRemove={2}
            onDone={onPracticeDone}
            onExit={() => setMode('list')}
          />
        ) : mode === 'done' && done ? (
          <PracticeDone right={done.right} total={done.total} onBack={() => setMode('list')} />
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 py-24 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            <span className="text-sm">加载中…</span>
          </div>
        ) : (
          <>
            {/* 搜索框：题目 / 答案 / 书名输入即筛 */}
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                strokeWidth={2}
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索题目、答案或书名"
                aria-label="搜索收藏题"
                className="h-10 w-full rounded-full border border-border bg-card pl-10 pr-10 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring"
              />
              {query && (
                <button
                  type="button"
                  aria-label="清除搜索"
                  onClick={() => setQuery('')}
                  className="absolute right-1.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="size-4" strokeWidth={2} />
                </button>
              )}
            </div>

            {/* 筛选行：卡片分类 + 时间 pills（含自定义时间段） */}
            <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="max-w-32 truncate">{cardLabel}</span>
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
                  <DropdownMenuItem
                    onClick={() => setCardFilter('all')}
                    className={cn(cardFilter === 'all' && 'font-bold text-red-500')}
                  >
                    全部卡片
                  </DropdownMenuItem>
                  {cards.map((c) => (
                    <DropdownMenuItem
                      key={c.id}
                      onClick={() => setCardFilter(c.id)}
                      className={cn(cardFilter === c.id && 'font-bold text-red-500')}
                    >
                      <span className="max-w-48 truncate">{c.title}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <div className="flex gap-1.5">
                {TIME_OPTIONS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setTimeFilter(t.key)}
                    className={cn(
                      'h-8 shrink-0 rounded-full px-3 text-xs transition-colors',
                      timeFilter === t.key
                        ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                        : 'border border-border bg-card text-muted-foreground hover:bg-accent',
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 自定义时间段：起止日期 + 确定 */}
            {timeFilter === 'custom' && (
              <div className="pt-1">
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    aria-label="开始日期"
                    value={customStart}
                    max={customEnd || undefined}
                    onChange={(e) => setCustomStart(e.target.value)}
                    className="h-8 min-w-0 flex-1 rounded-full border border-border bg-card px-3 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring dark:[color-scheme:dark]"
                  />
                  <span className="shrink-0 text-xs text-muted-foreground">至</span>
                  <input
                    type="date"
                    aria-label="结束日期"
                    value={customEnd}
                    min={customStart || undefined}
                    onChange={(e) => setCustomEnd(e.target.value)}
                    className="h-8 min-w-0 flex-1 rounded-full border border-border bg-card px-3 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring dark:[color-scheme:dark]"
                  />
                  <button
                    type="button"
                    onClick={applyCustomRange}
                    className="h-8 shrink-0 rounded-full bg-zinc-900 px-3.5 text-xs font-medium text-white transition-transform active:scale-95 dark:bg-zinc-100 dark:text-zinc-900"
                  >
                    确定
                  </button>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {customRange
                    ? `已筛选：${customRangeText}（含起止当天）`
                    : '请选择开始/结束日期后点「确定」'}
                </p>
              </div>
            )}

            {/* 统计 2×2（总数 + 题型分布） */}
            <div className="mt-3 grid grid-cols-2 rounded-2xl bg-card py-2">
              {favStats.map((cell, i) => (
                <div
                  key={cell.label}
                  className={cn(
                    'flex flex-col items-center justify-center gap-1 py-5',
                    i % 2 === 0 && 'border-r border-border',
                    i < 2 && 'border-b border-border',
                  )}
                >
                  <span className="text-4xl font-bold leading-none">{cell.value}</span>
                  <span className="text-sm text-muted-foreground">{cell.label}</span>
                </div>
              ))}
            </div>

            {/* 列表标题 + 排序 */}
            <div className="mb-2 mt-6 flex items-center justify-between gap-2">
              <h2 className="text-base font-bold">
                收藏列表
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  {filteredItems.length} 道
                </span>
              </h2>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="排序方式"
                    className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ArrowUpDown className="size-3.5 text-muted-foreground" strokeWidth={2} />
                    {sortLabel}
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {SORT_OPTIONS.map((s) => (
                    <DropdownMenuItem
                      key={s.key}
                      onClick={() => setSortKey(s.key)}
                      className={cn(sortKey === s.key && 'font-bold text-red-500')}
                    >
                      {s.label}
                      {sortKey === s.key && <Check className="ml-auto size-3.5" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {filteredItems.length === 0 ? (
              items.length === 0 ? (
                <div className="flex flex-col items-center gap-4 pt-8 text-center">
                  <EmptyFavoritesIllustration />
                  <p className="text-sm text-muted-foreground">暂无收藏题目，快去添加吧</p>
                </div>
              ) : (
                <div className="rounded-2xl bg-card py-14 text-center text-sm text-muted-foreground">
                  {hlQuery
                    ? `没有找到与「${truncate(hlQuery, 12)}」匹配的收藏题`
                    : timeActive
                      ? '该时间段没有收藏题'
                      : '当前筛选下没有收藏题'}
                </div>
              )
            ) : (
              <div className={cn('flex max-h-[72vh] flex-col gap-3 overflow-y-auto', SCROLLBAR)}>
                {filteredItems.map((item) => {
                  const isSel = selected.has(item.id)
                  return (
                    <div
                      key={item.id}
                      className={cn(
                        'rounded-2xl bg-card p-4 transition-shadow',
                        isSel && 'ring-1 ring-zinc-900 dark:ring-zinc-100/50',
                      )}
                      onContextMenu={(e) => {
                        if (!selectMode && mode === 'list') {
                          e.preventDefault()
                          setSelectMode(true)
                          setSelected(new Set([item.id]))
                        }
                      }}
                      onTouchStart={() => startPress(item.id)}
                      onTouchEnd={clearPress}
                      onTouchMove={clearPress}
                      onMouseDown={() => startPress(item.id)}
                      onMouseUp={clearPress}
                      onMouseLeave={clearPress}
                    >
                      <button
                        type="button"
                        className="flex w-full items-start gap-2 text-left"
                        onClick={() => {
                          if (selectMode) toggleSelectItem(item.id)
                        }}
                      >
                        {selectMode && <RoundCheckbox checked={isSel} />}
                        <span className="shrink-0 rounded-lg bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          {TYPE_LABEL[item.type] ?? '题目'}
                        </span>
                        <p className="text-[15px] font-medium leading-relaxed">
                          <Highlight text={item.question} query={hlQuery} />
                        </p>
                      </button>
                      <div className="mt-3 rounded-lg bg-muted px-3 py-2">
                        <p className="text-xs text-muted-foreground">
                          答案{item.cardTitle ? ' · ' : ''}
                          {item.cardTitle && <Highlight text={item.cardTitle} query={hlQuery} />}
                        </p>
                        <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed">
                          <Highlight text={item.answer || '（无标准答案）'} query={hlQuery} />
                        </p>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground/80">
                        <span>{formatDate(item.updatedAt)}</span>
                      </div>
                      {!selectMode && (
                        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => speakItem(item)}
                            aria-label={tts.speaking ? '停止朗读' : '朗读题目和答案'}
                            className="flex h-9 items-center gap-1.5 rounded-full border border-border px-3.5 text-sm text-muted-foreground transition-colors hover:bg-accent"
                          >
                            {tts.speaking ? (
                              <Square className="size-3.5" />
                            ) : (
                              <Volume2 className="size-3.5" />
                            )}
                            {tts.speaking ? '停止' : '朗读'}
                          </button>
                          <button
                            type="button"
                            disabled={aiLoading || similarBusy}
                            onClick={() => setExtendChoice({ base: [item] })}
                            className="flex h-9 items-center gap-1.5 rounded-full border border-border px-4 text-sm text-muted-foreground transition-colors hover:border-emerald-500/40 hover:text-emerald-600 disabled:opacity-50"
                          >
                            {similarBusy ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Lightbulb className="size-3.5" strokeWidth={2} />
                            )}
                            举一反三
                          </button>
                          <button
                            type="button"
                            disabled={aiLoading}
                            onClick={() => void runAnalyze(item)}
                            className="flex h-9 items-center gap-1.5 rounded-full border border-border px-4 text-sm text-muted-foreground transition-colors hover:border-emerald-500/40 hover:text-emerald-600 disabled:opacity-50"
                          >
                            <BookOpen className="size-3.5" strokeWidth={2} />
                            AI 解析
                          </button>
                          <button
                            type="button"
                            disabled={removingId === item.id || aiLoading}
                            onClick={() => unfavorite(item.id)}
                            className="flex h-9 items-center gap-1.5 rounded-full border border-border px-4 text-sm text-muted-foreground transition-colors hover:border-red-500/40 hover:text-red-500 disabled:opacity-50"
                          >
                            {removingId === item.id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Star className="size-3.5" strokeWidth={2} />
                            )}
                            取消收藏
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </main>

      {/* 底部：选择模式批量栏（练习 / 举一反三 / AI 讲解 / 导出 / 取消收藏 / 删除） */}
      {mode === 'list' && selectMode && (
        <div className="fixed inset-x-0 bottom-[calc(1.5rem+env(safe-area-inset-bottom))] z-40 flex justify-center px-4">
          <div className="w-full max-w-2xl rounded-2xl border border-border bg-card/95 p-3 shadow-lg shadow-black/10 backdrop-blur">
            <p className="pb-2 text-center text-xs text-muted-foreground">
              已选 {selected.size} 道收藏题
            </p>
            <div className="mb-2">
              <button
                type="button"
                disabled={selected.size === 0 || aiPickBusy}
                onClick={() => startPractice(selectedItems)}
                className="flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-zinc-900 text-sm font-semibold text-white transition-transform hover:scale-[1.01] active:scale-95 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
              >
                <Play className="size-4" strokeWidth={2} />
                练习所选（{selected.size}）
              </button>
            </div>
            <div className="mb-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={filteredItems.length === 0 || aiLoading || similarBusy || batchBusy}
                onClick={() =>
                  setExtendChoice({
                    base: selectedItems.length > 0 ? selectedItems : filteredItems,
                  })
                }
                className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-40"
              >
                {aiLoading || similarBusy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                举一反三
                {selectedItems.length > 0
                  ? `（所选 ${selectedItems.length} 道）`
                  : `（全部 ${filteredItems.length} 道）`}
              </button>
              <button
                type="button"
                disabled={selected.size === 0 || aiLoading || batchBusy}
                onClick={() => void runBatchExplain(selectedItems)}
                className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-purple-500/40 bg-card text-sm font-medium text-purple-700 transition-colors hover:bg-purple-500/10 disabled:opacity-40 dark:text-purple-400"
              >
                {aiLoading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <GraduationCap className="size-4" />
                )}
                AI 讲解{selected.size > 0 ? `（${selected.size}）` : ''}
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={selected.size === 0 || batchBusy}
                    className="flex h-11 flex-col items-center justify-center gap-0.5 rounded-xl border border-border bg-card text-[11px] font-medium transition-colors hover:bg-accent disabled:opacity-40"
                  >
                    <Download className="size-4" />
                    导出选中
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onClick={() => exportCSV(selectedItems)}>
                    <Download className="size-4" /> 导出 CSV
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => exportMD(selectedItems)}>
                    <Download className="size-4" /> 导出 Markdown
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => exportTXT(selectedItems)}>
                    <Download className="size-4" /> 导出 TXT
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void copyAll(selectedItems)}>
                    <Copy className="size-4" /> 复制所选
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <button
                type="button"
                disabled={selected.size === 0 || batchBusy}
                onClick={() => runBatch('unfav')}
                className="flex h-11 flex-col items-center justify-center gap-0.5 rounded-xl border border-amber-500/40 bg-card text-[11px] font-medium text-amber-600 transition-colors hover:bg-amber-500/10 disabled:opacity-40 dark:text-amber-400"
              >
                <Star className="size-4" fill="currentColor" />
                取消收藏
              </button>
              <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
                <AlertDialogTrigger asChild>
                  <button
                    type="button"
                    disabled={selected.size === 0 || batchBusy}
                    className="flex h-11 flex-col items-center justify-center gap-0.5 rounded-xl border border-destructive/40 bg-card text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-40"
                  >
                    <Trash2 className="size-4" />
                    删除
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>删除 {selected.size} 道题目？</AlertDialogTitle>
                    <AlertDialogDescription>
                      将彻底删除所选收藏题（含答题记录），此操作不可撤销。若只想移出收藏夹，请用「取消收藏」。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-white hover:bg-destructive/90"
                      onClick={() => {
                        setDeleteOpen(false)
                        void runBatch('delete')
                      }}
                    >
                      删除
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </div>
      )}

      {/* AI（举一反三 / 解析 / 批量讲解）结果 Dialog */}
      <Dialog
        open={aiOpen !== null}
        onOpenChange={(o) => {
          if (!o && !aiLoading) {
            setAiOpen(null)
            setSelFollow(null)
          }
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          className="flex max-h-[88dvh] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-lg"
        >
          <DialogHeader className="border-b border-border px-4 py-3 pr-12">
            <DialogTitle className="text-base">
              {aiOpen === 'extend'
                ? '举一反三'
                : aiOpen === 'batch'
                  ? `AI 批量讲解（${aiCount} 题）`
                  : 'AI 解析'}
              {aiOpen !== 'batch' && aiItem && (
                <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                  · {truncate(aiItem.question, 16)}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          <div
            ref={contentRef}
            className={cn('relative min-h-0 flex-1 overflow-y-auto px-4 py-3', SCROLLBAR)}
          >
            {aiLoading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
                <span className="text-sm">
                  {aiOpen === 'extend'
                    ? 'AI 正在举一反三…'
                    : aiOpen === 'batch'
                      ? `AI 正在讲解 ${aiCount} 道题…`
                      : 'AI 正在解析…'}
                </span>
              </div>
            ) : aiText ? (
              <div className="min-w-0 max-w-full break-words">
                <RichContent content={aiText} />
              </div>
            ) : null}
          </div>
          {aiOpen === 'analyze' && !aiLoading && aiText && (
            <p className="border-t border-border px-4 py-2 text-center text-[11px] text-muted-foreground/80">
              选中解析内容中的文字，可继续「追问」
            </p>
          )}
          {aiOpen === 'extend' && !aiLoading && aiText && (
            <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
              <p className="text-xs text-muted-foreground">AI 文本将解析为题目；解析不出则整段存为简答题</p>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 rounded-full"
                  disabled={savingPaper}
                  onClick={practiceExtend}
                >
                  <Play className="size-3.5" strokeWidth={2} />
                  直接练习
                </Button>
                <Button
                  size="sm"
                  className="h-9 shrink-0 rounded-full"
                  disabled={savingPaper}
                  onClick={() => void saveAsPaper()}
                >
                  {savingPaper ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Save className="size-3.5" strokeWidth={2} />
                  )}
                  存为试卷
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 举一反三方式选择：AI 讲解变式题 / 直接练习相似题（与错题本同款） */}
      <BottomSheet
        open={!!extendChoice}
        onOpenChange={(o) => {
          if (!o) setExtendChoice(null)
        }}
        title="举一反三"
        className="h-auto"
      >
        <div className="mt-4 space-y-2.5 pb-2">
          <p className="text-center text-xs text-muted-foreground">
            基于 {extendChoice?.base.length ?? 0} 道题目 · 讲解最多取前 8 道
          </p>
          <button
            type="button"
            disabled={aiLoading}
            onClick={() => {
              const base = extendChoice?.base ?? []
              setExtendChoice(null)
              void runExtend(base)
            }}
            className="flex w-full items-start gap-3 rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:bg-accent disabled:opacity-40"
          >
            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <GraduationCap className="size-4.5" strokeWidth={1.75} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold">AI 讲解变式题</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                AI 生成变式题并讲解思路，看完可存为试卷或直接练习
              </span>
            </span>
          </button>
          <button
            type="button"
            disabled={similarBusy}
            onClick={() => {
              const base = extendChoice?.base ?? []
              setExtendChoice(null)
              void startSimilar(base)
            }}
            className="flex w-full items-start gap-3 rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:bg-accent disabled:opacity-40"
          >
            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-zinc-900/5 text-foreground dark:bg-zinc-100/10">
              <Play className="size-4.5" strokeWidth={1.75} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold">直接练习相似题</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                立即生成相似新题并进入练习（不讲解）
              </span>
            </span>
          </button>
        </div>
      </BottomSheet>

      {/* 解析 Dialog：选中文本 → 浮动「🔍 追问」按钮（portal 到 body，
          避开 Dialog transform 对 fixed 定位的影响；追问弹层接管） */}
      {selFollow &&
        aiOpen === 'analyze' &&
        createPortal(
          <button
            type="button"
            onClick={sendFollowup}
            style={{ left: selFollow.x, top: selFollow.y }}
            className="fixed z-[70] -translate-x-1/2 rounded-full border border-emerald-600/40 bg-background px-3.5 py-2 text-xs font-medium text-emerald-700 shadow-lg transition-transform active:scale-95 dark:text-emerald-300"
          >
            <span className="flex items-center gap-1.5">
              <Search className="size-3.5" strokeWidth={2} aria-hidden />
              追问
              <span className="max-w-[140px] truncate text-muted-foreground">
                {truncate(selFollow.text, 14)}
              </span>
            </span>
          </button>,
          document.body,
        )}

      {/* 打印题单（仅打印时显示） */}
      <div id="fav-print" className="hidden print:block">
        <h2 className="mb-1 text-lg font-bold">收藏题目 · {new Date().toLocaleDateString('zh-CN')}</h2>
        <p className="mb-4 text-xs">
          共 {filteredItems.length} 道
          {cardFilter !== 'all' ? ` · ${cardLabel}` : ''}
          {query.trim() ? ` · 搜索「${query.trim()}」` : ''}
        </p>
        {filteredItems.map((item, i) => (
          <div key={item.id} className="mb-3 border-b border-neutral-300 pb-2 text-sm">
            <p className="font-medium">
              {i + 1}. [{TYPE_LABEL[item.type] ?? item.type}] {item.question}
            </p>
            <p className="mt-1 text-xs">答案：{item.answer || '（无标准答案）'}</p>
            <p className="mt-0.5 text-xs text-neutral-500">
              {item.cardTitle} · {formatDate(item.updatedAt)}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}
