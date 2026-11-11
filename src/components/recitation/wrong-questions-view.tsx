'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronLeft,
  Copy,
  Download,
  EyeOff,
  FolderPlus,
  GraduationCap,
  Loader2,
  MoreVertical,
  Play,
  Printer,
  Search,
  Sparkles,
  Square,
  Star,
  Trash2,
  Volume2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import type { AutoRemoveThreshold, QuizItemData, QuizType, WrongStats } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useLocalStorage } from '@/lib/use-local-storage'
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
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  fetchQuizUserAnswers,
  recordQuizUserAnswer,
  userAnswerKey,
} from '@/components/recitation/quiz-panel'
import { VoiceInput } from '@/components/recitation/voice-input'
import { useSettingsLite } from '@/lib/voice-prefs'
import { useQuickTts } from '@/components/recitation/tts-player'
import { RichContent } from '@/components/recitation/rich-content'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { BottomSheet } from '@/components/recitation/bottom-sheet'

interface WrongQuestionsViewProps {
  onBack: () => void
  /** 当前 quizAutoRemove 设置（父组件持有则传入） */
  autoRemove?: AutoRemoveThreshold
  /** 修改 quizAutoRemove（父组件传入则同时通知父组件；组件内部始终会 PATCH settings） */
  onChangeAutoRemove?: (n: AutoRemoveThreshold) => void
}

const REMOVE_OPTIONS: AutoRemoveThreshold[] = [1, 2, 3, 5]

const BUCKETS: { key: keyof WrongStats['buckets']; label: string }[] = [
  { key: 'fivePlus', label: '答错5次及以上' },
  { key: 'three', label: '答错3次' },
  { key: 'two', label: '答错2次' },
  { key: 'one', label: '答错1次' },
]

type TimeKey = 'all' | 'today' | '3d' | '7d' | '30d' | 'custom'

const TIME_OPTIONS: { key: TimeKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今天' },
  { key: '3d', label: '近3天' },
  { key: '7d', label: '近7天' },
  { key: '30d', label: '近30天' },
  { key: 'custom', label: '自定义' },
]

/** 告知 AI 可用富文本格式回答（拼进 user prompt，回答由 RichContent 原样渲染） */
const RICH_FORMAT_HINT =
  '你可以在回答中使用以下格式，会原样渲染：Markdown（标题/列表/表格/加粗）、LaTeX 公式（$...$ 行内与 $$...$$ 展示）、mermaid 图表（```mermaid 代码块，支持思维导图 mindmap / 树状图 / 流程图）、HTML 片段、代码块。请按需选择最清晰的表达格式。'

// ---------- 排序（与收藏夹同款；useLocalStorage 记忆，key 各自独立） ----------
type SortKey = 'time-desc' | 'time-asc' | 'alpha-asc' | 'alpha-desc'

const SORT_OPTIONS: { key: SortKey; label: string; short: string }[] = [
  { key: 'time-desc', label: '时间 · 最新在前', short: '最新在前' },
  { key: 'time-asc', label: '时间 · 最早在前', short: '最早在前' },
  { key: 'alpha-asc', label: '题目 · A→Z', short: 'A→Z' },
  { key: 'alpha-desc', label: '题目 · Z→A', short: 'Z→A' },
]

/** 搜索：多个关键词（空白分隔）全部命中才算匹配（题目/答案/书名/选项） */
function matchQuery(item: QuizItemData, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = [item.question, item.answer, item.cardTitle, ...item.options]
    .join('\n')
    .toLowerCase()
  return words.every((w) => hay.includes(w))
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

// 空状态简笔画：错题本（浅紫本子 + 黑描边 + 红色 ✗，与收藏夹空态插画同风格）
function EmptyWrongIllustration() {
  return (
    <svg viewBox="0 0 140 120" className="h-28 w-32" fill="none" aria-hidden role="img">
      {/* 放射短线 */}
      <path
        d="M70 26 V12 M48 30 l-7 -10 M92 30 l7 -10 M30 44 l-11 -6 M110 44 l11 -6"
        stroke="#171717"
        strokeWidth="2"
        strokeLinecap="round"
      />
      {/* 本子主体 */}
      <rect x="34" y="40" width="72" height="60" rx="6" fill="#dcdcfb" stroke="#171717" strokeWidth="2" />
      {/* 书脊装订线 */}
      <path d="M44 40 v60" stroke="#171717" strokeWidth="2" strokeLinecap="round" />
      {/* 内页横线 */}
      <path
        d="M52 54 h44 M52 66 h44 M52 78 h30"
        stroke="#171717"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.45"
      />
      {/* 红色 ✗ */}
      <path
        d="M84 66 l20 20 M104 66 l-20 20"
        stroke="#ef4444"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  )
}

const DISPLAY_LABEL: Record<string, string> = {
  fill: '填空',
  short: '简答',
  choice: '单选',
  multi: '多选',
  judge: '判断',
}

const JUDGE_ANSWERS = ['正确', '错误', '对', '错', '√', '×']

function normJudge(s: string): string {
  const t = (s || '').trim()
  if (['对', '正确', '√', '是', 'T', 'true'].includes(t)) return '正确'
  if (['错', '错误', '×', 'X', '否', 'F', 'false'].includes(t)) return '错误'
  return t
}

/**
 * 推断展示用题型：判断题按双选项单选存储（answer 为 正确/错误）、
 * 多选题按填空存储（answer 为多个选项文本），此处还原为真实题型展示。
 */
function displayType(item: QuizItemData): string {
  const a = (item.answer || '').trim()
  const parts = a
    .split(/[、,，;；]/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (item.type === 'choice') {
    if (JUDGE_ANSWERS.includes(a)) return 'judge'
    if (
      parts.length > 1 &&
      item.options.length > 0 &&
      parts.every((p) => item.options.includes(p))
    )
      return 'multi'
    return 'choice'
  }
  if (item.type === 'fill') {
    if (JUDGE_ANSWERS.includes(a)) return 'judge'
    if (
      parts.length > 1 &&
      item.options.length >= 2 &&
      parts.every((p) => item.options.includes(p))
    )
      return 'multi'
  }
  return item.type
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

/** 举一反三试卷默认标题：「举一反三 M月D日 HH:mm」 */
function extendPaperTitle(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `举一反三 ${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 解析举一反三返回的 Markdown（「## 第N题」小节 + 加粗的题目/答案标记）为试卷条目；
 * 解析不出任何题时返回空数组（调用方回退到保存所选原题）。 */
function parseExtendPaper(
  md: string,
): Array<{ type: string; question: string; answer: string }> {
  const out: Array<{ type: string; question: string; answer: string }> = []
  const sections = md.split(/^##\s*/m).slice(1)
  for (const sec of sections) {
    const body = sec.replace(/^[^\n]*题[^\n]*\n?/, '')
    const qm = body.match(/\*\*题目[:：]\*\*\s*([\s\S]*?)(?=\*\*(?:答案|解析)[:：]\*\*|$)/)
    if (!qm) continue
    const am = body.match(/\*\*答案[:：]\*\*\s*([\s\S]*?)(?=\*\*解析[:：]\*\*|$)/)
    out.push({
      type: 'short',
      question: qm[1].trim(),
      answer: (am?.[1] ?? '').trim(),
    })
  }
  return out
}

type ViewMode = 'list' | 'practice' | 'similar' | 'done'

// 错题本：统计 + 筛选 + 错题列表 + 批量操作 + 举一反三 + 导出/打印
export function WrongQuestionsView({
  onBack,
  autoRemove,
  onChangeAutoRemove,
}: WrongQuestionsViewProps) {
  const [stats, setStats] = React.useState<WrongStats | null>(null)
  const [items, setItems] = React.useState<QuizItemData[]>([])
  const [loading, setLoading] = React.useState(true)
  const [clearing, setClearing] = React.useState(false)
  const [removeN, setRemoveN] = React.useState<AutoRemoveThreshold>(autoRemove ?? 2)
  const [mode, setMode] = React.useState<ViewMode>('list')
  const [done, setDone] = React.useState<{ right: number; total: number } | null>(null)

  // ---- TTS（context 'quiz'，随设置里的音色/语速） ----
  const settings = useSettingsLite()
  const tts = useQuickTts('quiz', settings)

  // ---- 搜索 / 排序（排序用 useLocalStorage 记忆，key 与收藏夹各自独立） ----
  const [query, setQuery] = React.useState('')
  const [sortKey, setSortKey] = useLocalStorage<SortKey>('bb-wrong-sort', 'time-desc')

  // ---- 筛选 ----
  const [cardFilter, setCardFilter] = React.useState<string>('all')
  const [timeFilter, setTimeFilter] = React.useState<TimeKey>('all')
  // 自定义时间段：customStart/customEnd 为输入草稿，customRange 为点「确定」后生效的范围（空串 = 该侧不限）
  const [customStart, setCustomStart] = React.useState('')
  const [customEnd, setCustomEnd] = React.useState('')
  const [customRange, setCustomRange] = React.useState<{ start: string; end: string } | null>(
    null,
  )

  // ---- 多选 / 批量 ----
  const [selectMode, setSelectMode] = React.useState(false)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [expanded, setExpanded] = React.useState<string | null>(null)
  const [batchBusy, setBatchBusy] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [clearOpen, setClearOpen] = React.useState(false)

  // ---- 举一反三 ----
  const [similarBusy, setSimilarBusy] = React.useState(false)
  const [similarItems, setSimilarItems] = React.useState<QuizItemData[]>([])

  // ---- AI 智能选题（mode:'pick'）/ 批量举一反三（mode:'extend'，可存为试卷） ----
  const [aiPickBusy, setAiPickBusy] = React.useState(false)
  const [extendBusy, setExtendBusy] = React.useState(false)
  const [extendOpen, setExtendOpen] = React.useState(false)
  const [extendText, setExtendText] = React.useState('')
  const [extendError, setExtendError] = React.useState('')
  const [extendSaving, setExtendSaving] = React.useState(false)
  const [extendBase, setExtendBase] = React.useState<QuizItemData[]>([])
  /** 举一反三方式选择弹层：大按钮/单题行内按钮点击后弹（AI 讲解变式题 / 直接练习相似题）。 */
  const [extendChoice, setExtendChoice] = React.useState<{ base: QuizItemData[] } | null>(null)
  /** 勾选练习的错题子集（null = 全部筛选错题）。 */
  const [practiceItems, setPracticeItems] = React.useState<QuizItemData[] | null>(null)

  // ---- AI 解析（单题）/ AI 批量讲解汇总 + 选中文本追问 ----
  const [explainItems, setExplainItems] = React.useState<QuizItemData[] | null>(null)
  const [explainLoading, setExplainLoading] = React.useState(false)
  const [explainReply, setExplainReply] = React.useState('')
  const [explainError, setExplainError] = React.useState('')
  const explainAbortRef = React.useRef<AbortController | null>(null)
  // 选中文本追问（解析 Dialog 内浮动按钮）
  const [explainFollow, setExplainFollow] = React.useState<{
    text: string
    x: number
    y: number
  } | null>(null)
  const explainContentRef = React.useRef<HTMLDivElement>(null)
  // 课文内容缓存（AI 解析上下文）：cardId -> content（'' = 已知无课文）
  const cardContentCache = React.useRef(new Map<string, string>())

  // ---- 本地「我的答案」记录 ----
  const [userAnswers, setUserAnswers] = React.useState<
    Record<string, { userAnswer: string; at: number }>
  >({})

  React.useEffect(() => {
    if (typeof autoRemove === 'number') setRemoveN(autoRemove)
  }, [autoRemove])

  // 卸载时停止朗读并中断进行中的 AI 解析（tts.stop 引用稳定，仅卸载时执行一次）
  React.useEffect(() => {
    const stop = tts.stop
    return () => {
      explainAbortRef.current?.abort()
      stop()
    }
  }, [tts.stop])

  React.useEffect(() => {
    let alive = true
    // 作答记录从服务端加载（自动迁移本地旧数据）
    void fetchQuizUserAnswers().then((all) => {
      if (alive) setUserAnswers(all)
    })
    return () => {
      alive = false
    }
  }, [])

  const loadStats = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/quiz-items?stats=1&tzOffset=${new Date().getTimezoneOffset()}`)
      if (!res.ok) throw new Error('加载统计失败')
      setStats((await res.json()) as WrongStats)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载统计失败')
    }
  }, [])

  const loadItems = React.useCallback(async () => {
    try {
      const res = await fetch('/api/quiz-items?wrong=1')
      if (!res.ok) throw new Error('加载错题失败')
      const data = (await res.json()) as { items: QuizItemData[] }
      setItems(data.items ?? [])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载错题失败')
    }
  }, [])

  React.useEffect(() => {
    setLoading(true)
    Promise.all([loadStats(), loadItems()]).finally(() => setLoading(false))
  }, [loadStats, loadItems])

  // ---- 筛选逻辑 ----
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
    const now = Date.now()
    const q = query.trim()
    const passed = items.filter((i) => {
      if (cardFilter !== 'all' && i.cardId !== cardFilter) return false
      // 搜索：题目 / 答案 / 书名 / 选项多关键词全命中
      if (q && !matchQuery(i, q)) return false
      if (timeFilter === 'all') return true
      // 按错题产生时间（createdAt）筛选；自定义区间含起止当天
      const t = new Date(i.createdAt).getTime()
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
      return true
    })
    // 排序：时间 = 错题收录时间（createdAt，与时间筛选一致）；字母 = 题干中文拼音序
    const cmp =
      sortKey === 'time-desc'
        ? (a: QuizItemData, b: QuizItemData) => b.createdAt.localeCompare(a.createdAt)
        : sortKey === 'time-asc'
          ? (a: QuizItemData, b: QuizItemData) => a.createdAt.localeCompare(b.createdAt)
          : sortKey === 'alpha-asc'
            ? (a: QuizItemData, b: QuizItemData) =>
                a.question.localeCompare(b.question, 'zh-CN') ||
                a.createdAt.localeCompare(b.createdAt)
            : (a: QuizItemData, b: QuizItemData) =>
                b.question.localeCompare(a.question, 'zh-CN') ||
                a.createdAt.localeCompare(b.createdAt)
    return [...passed].sort(cmp)
  }, [items, query, cardFilter, timeFilter, customRange, sortKey])

  // ---- 时间筛选展示文案 / 自定义区间应用 ----
  // timeActive：时间条件是否真正生效（自定义未确定范围时不算）
  const timeActive = timeFilter !== 'all' && (timeFilter !== 'custom' || !!customRange)
  const customRangeText = customRange
    ? `${customRange.start || '最早'} ~ ${customRange.end || '今天'}`
    : ''
  const timeFilterText =
    timeFilter === 'all'
      ? ''
      : timeFilter === 'custom'
        ? customRange
          ? `自定义（${customRangeText}，含当天）`
          : '自定义'
        : (TIME_OPTIONS.find((t) => t.key === timeFilter)?.label ?? '')

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

  // ---- 多选 ----
  const selectedItems = filteredItems.filter((i) => selected.has(i.id))
  const allSelected = filteredItems.length > 0 && filteredItems.every((i) => selected.has(i.id))
  const allFav = selectedItems.length > 0 && selectedItems.every((i) => i.favorite)

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

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelected(new Set())
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
        setExpanded(null)
      }
    }, 500)
  }

  const changeAutoRemove = async (n: AutoRemoveThreshold) => {
    setRemoveN(n)
    onChangeAutoRemove?.(n)
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quizAutoRemove: n }),
      })
      if (!res.ok) throw new Error('保存失败')
      toast.success(`答对 ${n} 次后自动移除错题`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    }
  }

  const clearAll = async () => {
    setClearing(true)
    try {
      const res = await fetch('/api/quiz-items?wrong=1', { method: 'DELETE' })
      if (!res.ok) throw new Error('清空失败')
      toast.success('错题已清空')
      setSelectMode(false)
      setSelected(new Set())
      await Promise.all([loadStats(), loadItems()])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '清空失败')
    } finally {
      setClearing(false)
    }
  }

  // ---- 批量操作：删除 / 移出错题 / 收藏·取消收藏 ----
  const runBatch = async (kind: 'delete' | 'remove' | 'fav' | 'unfav') => {
    const ids = [...selected]
    if (ids.length === 0) return
    setBatchBusy(true)
    try {
      if (kind === 'delete') {
        await Promise.all(
          ids.map(async (id) => {
            const res = await fetch(`/api/quiz-items?id=${id}`, { method: 'DELETE' })
            if (!res.ok) throw new Error('删除失败')
          }),
        )
      } else {
        await Promise.all(
          ids.map(async (id) => {
            const res = await fetch('/api/quiz-items', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(
                kind === 'remove' ? { id, removed: true } : { id, favorite: kind === 'fav' },
              ),
            })
            if (!res.ok) throw new Error('操作失败')
          }),
        )
      }
      toast.success(
        kind === 'delete'
          ? `已删除 ${ids.length} 道错题`
          : kind === 'remove'
            ? `已移出 ${ids.length} 道错题`
            : kind === 'fav'
              ? '已收藏所选错题'
              : '已取消收藏所选错题',
      )
      exitSelectMode()
      await Promise.all([loadStats(), loadItems()])
    } catch {
      toast.error('批量操作失败，请重试')
    } finally {
      setBatchBusy(false)
    }
  }

  // ---- 单条收藏/取消收藏 ----
  const toggleFavorite = async (item: QuizItemData) => {
    try {
      const res = await fetch('/api/quiz-items', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, favorite: !item.favorite }),
      })
      if (!res.ok) throw new Error('操作失败')
      setItems((list) =>
        list.map((i) => (i.id === item.id ? { ...i, favorite: !item.favorite } : i)),
      )
      toast.success(item.favorite ? '已取消收藏' : '已收藏')
    } catch {
      toast.error('操作失败，请重试')
    }
  }

  // ---- 举一反三：基于错题出相似新题并进入作答 ----
  const startSimilar = async (baseItems: QuizItemData[]) => {
    if (baseItems.length === 0) {
      toast.warning('请先选择错题')
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
        const err = await res.json().catch(() => ({}))
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
        } else if (q.type === 'judge') {
          // 判断题以双选项单选形式练习
          type = 'choice'
          options = ['正确', '错误']
          answer = normJudge(q.answer)
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

  // ---- AI 智能选题：让 AI 从当前筛选列表中挑最值得练习的题并勾选 ----
  const aiPick = async () => {
    if (filteredItems.length === 0) {
      toast('当前筛选下没有错题')
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
          questions: filteredItems.map((i) => ({ question: i.question, reason: `错${i.wrongCount}次` })),
          count,
        }),
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(err.error || 'AI 选题失败')
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
      toast.success(`AI 已选出 ${idxs.length} 道最值得练习的题`, { id: tid })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'AI 选题失败', { id: tid })
    } finally {
      setAiPickBusy(false)
    }
  }

  // ---- 批量举一反三（mode:'extend'）：生成变式题讲解，可一键存入试卷夹 ----
  const startExtend = async (baseItems: QuizItemData[]) => {
    if (baseItems.length === 0) {
      toast.warning('请先选择错题')
      return
    }
    if (baseItems.length > 8) toast('一次最多 8 道错题，已取前 8 道生成')
    const use = baseItems.slice(0, 8)
    setExtendBusy(true)
    setExtendOpen(true)
    setExtendText('')
    setExtendError('')
    setExtendBase(use)
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
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(err.error || '生成失败')
      }
      const data = (await res.json()) as { text?: string }
      const text = (data.text ?? '').trim()
      if (!text) throw new Error('AI 未返回内容，请重试')
      setExtendText(text)
      toast.dismiss(tid)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '生成失败'
      setExtendError(msg)
      toast.error(msg, { id: tid })
    } finally {
      setExtendBusy(false)
    }
  }

  /** 把举一反三结果存为试卷：优先保存 AI 变式题，解析不出则保存所选原题。
   *  错题可能跨卡 — 简单方案：存到第一道所选错题所属书。 */
  const saveExtendAsPaper = async () => {
    const cardId0 = extendBase[0]?.cardId
    if (!cardId0) {
      toast.error('缺少书本信息，无法保存到试卷夹')
      return
    }
    const parsed = parseExtendPaper(extendText)
    const items: Array<{ type: string; question: string; answer: string; options?: string[] }> =
      parsed.length > 0
        ? parsed
        : extendBase.map((i) => ({
            type: i.type,
            question: i.question,
            answer: i.answer,
            options: i.options,
          }))
    if (items.length === 0) {
      toast.warning('没有可保存的题目')
      return
    }
    setExtendSaving(true)
    try {
      const res = await fetch('/api/papers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardId: cardId0,
          title: extendPaperTitle(),
          items,
          source: 'extend',
        }),
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(err.error || '保存失败')
      }
      toast.success('已存入试卷夹')
      setExtendOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setExtendSaving(false)
    }
  }

  /** 把举一反三讲解直接载入练习：解析变式题后走与「直接练习相似题」相同的作答流。 */
  const practiceExtend = () => {
    const parsed = parseExtendPaper(extendText)
    if (parsed.length === 0) {
      toast.warning('讲解中没有解析出可练习的变式题，可先「存为试卷」')
      return
    }
    const src = extendBase[0]
    const mapped: QuizItemData[] = parsed.map((q, i) => ({
      id: `ext-${Date.now()}-${i}`,
      cardId: src?.cardId ?? '',
      cardTitle: extendBase.length === 1 ? src?.cardTitle || '举一反三' : '举一反三',
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
    setExtendOpen(false)
    setSimilarItems(mapped)
    setMode('similar')
    toast.success(`已载入 ${mapped.length} 道变式题，开始练习`)
  }

  // ---- 朗读错题：题目（展开态附带正确答案） ----
  const speakItem = (item: QuizItemData, includeAnswer: boolean) => {
    if (tts.speaking) {
      tts.stop()
      return
    }
    tts.speak(
      includeAnswer && item.answer
        ? `题目：${item.question}。正确答案：${item.answer}`
        : item.question,
    )
  }

  // ---- AI 解析：讲解错题涉及的知识点（analyze 模式，带课文上下文，与收藏夹同款） ----
  // 课文内容缓存：一次拉全量卡，后续命中缓存
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

  const openExplain = async (item: QuizItemData) => {
    explainAbortRef.current?.abort()
    const ctrl = new AbortController()
    explainAbortRef.current = ctrl
    setExplainItems([item])
    setExplainReply('')
    setExplainError('')
    setExplainLoading(true)
    try {
      const context = await getCardContent(item.cardId)
      const my = userAnswers[userAnswerKey(item.cardId, item.question)]?.userAnswer
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          mode: 'analyze',
          question: item.question,
          answer: item.answer || undefined,
          context,
          extra: my
            ? `这是学生的错题，学生曾答「${my.slice(0, 200)}」答错了，请针对易错点重点讲解。`
            : '这是学生的错题，请针对易错点重点讲解。',
        }),
      })
      const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string }
      if (!res.ok) throw new Error(data.error || 'AI 解析失败')
      setExplainReply(data.text || '')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setExplainError(err instanceof Error ? err.message : 'AI 解析失败')
      toast.error(err instanceof Error ? err.message : 'AI 解析失败')
    } finally {
      if (!ctrl.signal.aborted) setExplainLoading(false)
    }
  }

  // ---- AI 批量讲解汇总：勾选多题一次讲完（ask 模式，逐题讲解 + 共性总结，与收藏夹同款） ----
  const openBatchExplain = (list: QuizItemData[]) => {
    if (list.length === 0) {
      toast('请先勾选要讲解的错题')
      return
    }
    const use = list.slice(0, 8)
    if (list.length > 8) toast('一次最多讲解 8 道题，已取前 8 道')
    explainAbortRef.current?.abort()
    const ctrl = new AbortController()
    explainAbortRef.current = ctrl
    setExplainItems(use)
    setExplainReply('')
    setExplainError('')
    setExplainLoading(true)
    const lines = [
      `逐题讲解下面 ${use.length} 道错题的知识点与解题思路，最后总结共性易错点：`,
      ...use.map(
        (i, n) =>
          `${n + 1}. [${DISPLAY_LABEL[displayType(i)] ?? i.type}] ${i.question}${i.answer ? `（正确答案：${i.answer}）` : ''}`,
      ),
      // 告知 AI 可用富文本格式回答（markdown/LaTeX/mermaid/HTML），回答由 RichContent 原样渲染
      RICH_FORMAT_HINT,
    ]
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        mode: 'ask',
        content: use[0].cardTitle ? `来自卡片「${use[0].cardTitle}」的错题` : '错题讲解',
        messages: [{ role: 'user', content: lines.join('\n') }],
      }),
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { reply?: string; error?: string }
        if (!res.ok) throw new Error(data.error || 'AI 讲解失败')
        setExplainReply(data.reply || '')
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setExplainError(err instanceof Error ? err.message : 'AI 讲解失败')
        toast.error(err instanceof Error ? err.message : 'AI 讲解失败')
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setExplainLoading(false)
      })
  }

  const closeExplain = () => {
    explainAbortRef.current?.abort()
    setExplainItems(null)
    setExplainLoading(false)
    setExplainFollow(null)
    tts.stop()
  }

  // ---- 解析 Dialog：选中文本 → 浮动「🔍 追问」按钮（与收藏夹同款；source:'analysis'） ----
  const checkExplainSelection = React.useCallback(() => {
    const container = explainContentRef.current
    if (!container) {
      setExplainFollow(null)
      return
    }
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setExplainFollow(null)
      return
    }
    const raw = sel.toString().trim().replace(/\s+/g, ' ')
    if (!raw) {
      setExplainFollow(null)
      return
    }
    const node = sel.anchorNode
    if (!node) {
      setExplainFollow(null)
      return
    }
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
    if (!el || !container.contains(el)) {
      setExplainFollow(null)
      return
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    const vw = window.innerWidth || 375
    const vh = window.innerHeight || 667
    setExplainFollow({
      text: raw.slice(0, 500),
      x: Math.min(Math.max(rect.left + rect.width / 2, 96), vw - 96),
      y: Math.min(rect.bottom + 10, vh - 64),
    })
  }, [])

  React.useEffect(() => {
    if (!explainItems || explainLoading || !explainReply) return
    document.addEventListener('selectionchange', checkExplainSelection)
    document.addEventListener('mouseup', checkExplainSelection)
    document.addEventListener('touchend', checkExplainSelection)
    return () => {
      document.removeEventListener('selectionchange', checkExplainSelection)
      document.removeEventListener('mouseup', checkExplainSelection)
      document.removeEventListener('touchend', checkExplainSelection)
      setExplainFollow(null)
    }
  }, [explainItems, explainLoading, explainReply, checkExplainSelection])

  const sendExplainFollowup = () => {
    if (!explainFollow) return
    window.dispatchEvent(
      new CustomEvent('app:followup', {
        detail: {
          text: explainFollow.text,
          source: 'analysis',
          cardId: explainItems?.[0]?.cardId ?? '',
          cardTitle: explainItems?.[0]?.cardTitle ?? '',
        },
      }),
    )
    try {
      window.getSelection()?.removeAllRanges()
    } catch {
      /* ignore */
    }
    setExplainFollow(null)
    setExplainItems(null)
    toast.success('已发送追问')
  }

  // ---- 导出 CSV ----
  // items 参数：缺省=当前筛选全部；传入子集=批量导出选中。
  const exportCSV = (items?: QuizItemData[]) => {
    const list = items ?? filteredItems
    if (list.length === 0) {
      toast(items ? '未选中任何错题' : '当前筛选下没有错题')
      return
    }
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const rows: string[][] = [
      ['题目', '类型', '我的答案', '正确答案', '错误次数', '来源卡片', '时间'],
      ...list.map((i) => [
        i.question,
        DISPLAY_LABEL[displayType(i)] ?? i.type,
        userAnswers[userAnswerKey(i.cardId, i.question)]?.userAnswer ?? '',
        i.answer,
        String(i.wrongCount),
        i.cardTitle,
        new Date(i.updatedAt).toLocaleString('zh-CN'),
      ]),
    ]
    const csv = '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n')
    const tag = items && items.length < filteredItems.length ? `_选中${items.length}` : ''
    downloadBlob(csv, `错题本_${new Date().toISOString().slice(0, 10)}${tag}.csv`, 'text/csv;charset=utf-8')
    toast.success(`已导出 ${list.length} 道错题`)
  }

  // ---- 导出 Markdown / TXT / 复制（与收藏夹同款格式） ----
  // items 参数：缺省=当前筛选全部；传入子集=批量导出选中。
  const exportList = (items?: QuizItemData[]) => {
    const list = items ?? filteredItems
    if (list.length === 0) {
      toast(items ? '未选中任何错题' : '当前筛选下没有错题')
      return null
    }
    return list
  }

  const buildMD = (list: QuizItemData[]) =>
    [
      '# 错题本导出',
      `> 共 ${list.length} 道 · 导出于 ${new Date().toLocaleString('zh-CN')}`,
      '',
      ...list.flatMap((i, n) => [
        `## ${n + 1}. [${DISPLAY_LABEL[displayType(i)] ?? i.type}] ${i.question}`,
        `- **我的答案**：${userAnswers[userAnswerKey(i.cardId, i.question)]?.userAnswer || '（未记录）'}`,
        `- **正确答案**：${i.answer || '（无标准答案）'}`,
        `- **错误次数**：${i.wrongCount}`,
        i.cardTitle ? `- **来源**：《${i.cardTitle}》` : '',
        `- **时间**：${formatDate(i.updatedAt)}`,
        '',
      ]),
    ]
      .filter((l) => l !== '')
      .join('\n')

  const buildTXT = (list: QuizItemData[]) =>
    [
      `错题本导出（共 ${list.length} 道 · ${new Date().toLocaleString('zh-CN')}）`,
      '',
      ...list.flatMap((i, n) => [
        `${n + 1}. [${DISPLAY_LABEL[displayType(i)] ?? i.type}] ${i.question}`,
        `   我的答案：${userAnswers[userAnswerKey(i.cardId, i.question)]?.userAnswer || '（未记录）'}`,
        `   正确答案：${i.answer || '（无标准答案）'}`,
        `   错误次数：${i.wrongCount}`,
        i.cardTitle ? `   来源：${i.cardTitle}` : '',
        `   时间：${formatDate(i.updatedAt)}`,
        '',
      ]),
    ].join('\n')

  const exportMD = (items?: QuizItemData[]) => {
    const list = exportList(items)
    if (!list) return
    const tag = items && items.length < filteredItems.length ? `_选中${items.length}` : ''
    downloadBlob(
      buildMD(list),
      `错题本_${new Date().toISOString().slice(0, 10)}${tag}.md`,
      'text/markdown;charset=utf-8',
    )
    toast.success(`已导出 Markdown（${list.length} 题）`)
  }

  const exportTXT = (items?: QuizItemData[]) => {
    const list = exportList(items)
    if (!list) return
    const tag = items && items.length < filteredItems.length ? `_选中${items.length}` : ''
    downloadBlob(
      buildTXT(list),
      `错题本_${new Date().toISOString().slice(0, 10)}${tag}.txt`,
      'text/plain;charset=utf-8',
    )
    toast.success(`已导出 TXT（${list.length} 题）`)
  }

  const copyAll = async (items?: QuizItemData[]) => {
    const list = exportList(items)
    if (!list) return
    try {
      await navigator.clipboard.writeText(buildTXT(list))
      toast.success(`已复制 ${list.length} 道错题`)
    } catch {
      toast.error('复制失败，请重试')
    }
  }

  // ---- 智能选错题：按错次/收藏/时间自动勾选 ----
  const smartSelect = (mode: 'ge3' | 'ge5' | 'fav' | 'recent7' | 'invert') => {
    const filtered = filteredItems
    if (filtered.length === 0) {
      toast('当前筛选下没有错题')
      return
    }
    let next: Set<string>
    switch (mode) {
      case 'ge3':
        next = new Set(filtered.filter((i) => i.wrongCount >= 3).map((i) => i.id))
        toast.success(`已选错次≥3 的 ${next.size} 道`)
        break
      case 'ge5':
        next = new Set(filtered.filter((i) => i.wrongCount >= 5).map((i) => i.id))
        toast.success(`已选错次≥5 的 ${next.size} 道`)
        break
      case 'fav':
        next = new Set(filtered.filter((i) => i.favorite).map((i) => i.id))
        toast.success(`已选收藏的 ${next.size} 道`)
        break
      case 'recent7': {
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
        next = new Set(
          filtered.filter((i) => new Date(i.updatedAt).getTime() >= cutoff).map((i) => i.id),
        )
        toast.success(`已选近 7 天错的 ${next.size} 道`)
        break
      }
      case 'invert':
        next = new Set(filtered.filter((i) => !selected.has(i.id)).map((i) => i.id))
        toast.success(`已反选 ${next.size} 道`)
        break
    }
    setSelected(next)
  }

  // ---- 顶栏返回 ----
  const handleBack = () => {
    if (selectMode) {
      exitSelectMode()
      return
    }
    if (mode === 'practice' || mode === 'similar' || mode === 'done') {
      setMode('list')
      setPracticeItems(null)
      return
    }
    onBack()
  }

  /** 开始练习：不传 list = 全部筛选错题；传入 = 只练勾选的错题。 */
  const startPractice = (list?: QuizItemData[]) => {
    const target = list ?? filteredItems
    if (target.length === 0) {
      toast('暂无错题')
      return
    }
    setPracticeItems(list ?? null)
    setMode('practice')
  }

  const onPracticeDone = (right: number) => {
    const total = mode === 'similar' ? similarItems.length : (practiceItems ?? filteredItems).length
    setDone({ right, total })
    setMode('done')
    setPracticeItems(null)
    void fetchQuizUserAnswers().then(setUserAnswers)
    Promise.all([loadStats(), loadItems()])
  }

  // 列表渲染用的排序文案 / 高亮关键词
  const sortLabel = SORT_OPTIONS.find((s) => s.key === sortKey)?.short ?? '最新在前'
  const hlQuery = query.trim()

  return (
    <div className="min-h-dvh bg-muted/40">
      {/* 打印样式：仅显示题单 */}
      <style>{`@media print {
        body * { visibility: hidden !important; }
        #wrong-print, #wrong-print * { visibility: visible !important; }
        #wrong-print { position: absolute; left: 0; top: 0; width: 100%; display: block !important; padding: 0 12px; }
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
              : selectMode
                ? `已选 ${selected.size}`
                : '错题本'}
          </h1>
          {mode === 'list' && !selectMode && (
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={() => {
                  setSelectMode(true)
                  setSelected(new Set())
                  setExpanded(null)
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
                  <DropdownMenuItem onClick={() => setClearOpen(true)} className="text-destructive">
                    <Trash2 className="size-4" /> 清空错题
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
                    AI 智能选题
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => smartSelect('ge5')}>
                    错次 ≥ 5（高频错）
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => smartSelect('ge3')}>
                    错次 ≥ 3
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => smartSelect('fav')}>
                    收藏的错题
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => smartSelect('recent7')}>
                    最近 7 天错的
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => smartSelect('invert')}>
                    反选
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={toggleSelectAll}>
                    {allSelected ? '取消全选' : '全选'}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 pb-32 pt-4">
        {mode === 'practice' ? (
          <PracticeBoard
            items={practiceItems ?? filteredItems}
            autoRemove={removeN}
            onDone={onPracticeDone}
            onExit={() => {
              setMode('list')
              setPracticeItems(null)
            }}
          />
        ) : mode === 'similar' ? (
          <PracticeBoard
            items={similarItems}
            autoRemove={removeN}
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
            {/* 搜索框：题目 / 答案 / 书名输入即筛（多关键词全命中） */}
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
                aria-label="搜索错题"
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

            {/* 统计 2×2 */}
            <div className="mt-3 grid grid-cols-2 rounded-2xl bg-card py-2">
              {(
                [
                  { value: `${stats?.rate ?? 0}%`, label: '错题率' },
                  { value: stats?.wrongCount ?? 0, label: '错题数' },
                  { value: stats?.todayWrong ?? 0, label: '今日错题' },
                  { value: stats?.multiWrong ?? 0, label: '多次做错' },
                ] as const
              ).map((cell, i) => (
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

            {/* 错题列表 + 排序 */}
            <div className="mb-2 mt-6 flex items-center justify-between gap-2">
              <h2 className="text-base font-bold">
                错题列表
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  {filteredItems.length} 道
                </span>
                {selectMode && (
                  <span className="ml-1 hidden text-xs font-normal text-muted-foreground sm:inline">
                    长按或点「选择」可多选
                  </span>
                )}
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
                <div className="flex flex-col items-center gap-4 pt-4 text-center">
                  <EmptyWrongIllustration />
                  <p className="text-sm text-muted-foreground">暂无错题，快去练习吧</p>
                </div>
              ) : (
                <div className="rounded-2xl bg-card py-14 text-center text-sm text-muted-foreground">
                  {query.trim()
                    ? `没有找到与「${query.trim().slice(0, 12)}」匹配的错题`
                    : timeActive
                      ? '该时间段没有错题'
                      : '当前筛选下没有错题'}
                </div>
              )
            ) : (
              <div className="flex flex-col gap-2.5">
                {filteredItems.map((item) => {
                  const isSelected = selected.has(item.id)
                  const isExpanded = !selectMode && expanded === item.id
                  return (
                    <div
                      key={item.id}
                      className={cn(
                        'rounded-2xl bg-card transition-shadow',
                        isSelected && 'ring-1 ring-zinc-900 dark:ring-zinc-100/50',
                      )}
                      onContextMenu={(e) => {
                        if (!selectMode && mode === 'list') {
                          e.preventDefault()
                          setSelectMode(true)
                          setSelected(new Set([item.id]))
                          setExpanded(null)
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
                        className="flex w-full items-start gap-3 p-4 text-left"
                        onClick={() => {
                          if (selectMode) toggleSelectItem(item.id)
                          else setExpanded(isExpanded ? null : item.id)
                        }}
                      >
                        {selectMode && <RoundCheckbox checked={isSelected} />}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="rounded-lg bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                              {DISPLAY_LABEL[displayType(item)] ?? item.type}
                            </span>
                            <span className="text-xs font-medium text-red-500">
                              错{item.wrongCount}次
                            </span>
                            {item.favorite && (
                              <span className="flex items-center gap-0.5 text-xs text-amber-500">
                                <Star className="size-3" fill="currentColor" strokeWidth={0} />
                              </span>
                            )}
                          </div>
                          <p
                            className={cn(
                              'mt-1.5 text-sm leading-relaxed',
                              !isExpanded && 'line-clamp-2',
                            )}
                          >
                            <Highlight text={item.question} query={hlQuery} />
                          </p>
                        </div>
                        <ChevronDown
                          className={cn(
                            'mt-1 size-4 shrink-0 text-muted-foreground transition-transform',
                            isExpanded && 'rotate-180',
                          )}
                        />
                      </button>

                      {isExpanded && (
                        <div className="border-t border-border px-4 py-3">
                          <div className="space-y-2 rounded-xl bg-muted/40 p-3">
                            <p className="text-sm leading-relaxed">
                              <span className="mr-1 text-xs text-muted-foreground">我的答案：</span>
                              <span className="break-all font-medium text-destructive">
                                {userAnswers[userAnswerKey(item.cardId, item.question)]
                                  ?.userAnswer || '（未记录）'}
                              </span>
                            </p>
                            <p className="text-sm leading-relaxed">
                              <span className="mr-1 text-xs text-muted-foreground">正确答案：</span>
                              <span className="break-all font-medium text-emerald-700 dark:text-emerald-300">
                                <Highlight text={item.answer || '（无标准答案）'} query={hlQuery} />
                              </span>
                            </p>
                          </div>
                          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                            <span>
                              错 {item.wrongCount} 次 · 对 {item.rightCount} 次
                            </span>
                            {item.cardTitle && (
                              <span>
                                来源：<Highlight text={item.cardTitle} query={hlQuery} />
                              </span>
                            )}
                            <span>{formatDate(item.updatedAt)}</span>
                          </div>
                          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => speakItem(item, true)}
                              aria-label={tts.speaking ? '停止朗读' : '朗读题目和答案'}
                              className="flex h-9 items-center gap-1.5 rounded-full border border-border px-3.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
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
                              onClick={() => void openExplain(item)}
                              className="flex h-9 items-center gap-1.5 rounded-full border border-purple-500/40 px-3.5 text-xs font-medium text-purple-700 transition-colors hover:bg-purple-500/10 dark:text-purple-400"
                            >
                              <GraduationCap className="size-3.5" />
                              AI 解析
                            </button>
                            <button
                              type="button"
                              disabled={similarBusy || extendBusy}
                              onClick={() => setExtendChoice({ base: [item] })}
                              className="flex h-9 items-center gap-1.5 rounded-full border border-emerald-600/40 px-3.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/10 disabled:opacity-50 dark:text-emerald-400"
                            >
                              {similarBusy || extendBusy ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Sparkles className="size-3.5" />
                              )}
                              举一反三
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleFavorite(item)}
                              className={cn(
                                'flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-xs transition-colors',
                                item.favorite
                                  ? 'border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                                  : 'border-border text-muted-foreground hover:bg-accent',
                              )}
                            >
                              <Star
                                className="size-3.5"
                                fill={item.favorite ? 'currentColor' : 'none'}
                              />
                              {item.favorite ? '取消收藏' : '收藏'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* 错题分类 */}
            <h2 className="mb-2 mt-6 text-base font-bold">错题分类</h2>
            <div className="grid grid-cols-2 gap-3 rounded-2xl bg-card p-3">
              {BUCKETS.map((b) => (
                <div
                  key={b.key}
                  className="flex h-12 items-center justify-between rounded-lg bg-muted px-4"
                >
                  <span className="text-sm">{b.label}</span>
                  <span className="text-sm font-bold">{stats?.buckets[b.key] ?? 0}</span>
                </div>
              ))}
            </div>

            {/* 设置行 */}
            <div className="mt-6 flex h-14 items-center justify-between rounded-xl bg-card px-4">
              <span className="text-sm font-medium">答对后自动移除错题</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex shrink-0 items-center gap-1 text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span>
                      答对<span className="mx-0.5 font-bold text-red-500">{removeN}</span>次后
                    </span>
                    <ChevronDown className="size-4" strokeWidth={2} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {REMOVE_OPTIONS.map((n) => (
                    <DropdownMenuItem
                      key={n}
                      onClick={() => changeAutoRemove(n)}
                      className={cn(removeN === n && 'font-bold text-red-500')}
                    >
                      答对 {n} 次后
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </>
        )}
      </main>

      {/* 底部：多选批量操作栏 / 去练习 */}
      {mode === 'list' && selectMode ? (
        <div className="fixed inset-x-0 bottom-[calc(1.5rem+env(safe-area-inset-bottom))] z-40 flex justify-center px-4">
          <div className="w-full max-w-2xl rounded-2xl border border-border bg-card/95 p-3 shadow-lg shadow-black/10 backdrop-blur">
            <p className="pb-2 text-center text-xs text-muted-foreground">
              已选 {selected.size} 道错题
            </p>
            <div className="mb-2">
              {/* 练习所选：只练勾选的错题（全量练习用底部「去练习」） */}
              <button
                type="button"
                disabled={selected.size === 0 || batchBusy}
                onClick={() => startPractice(selectedItems)}
                className="flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-zinc-900 text-sm font-semibold text-white transition-transform hover:scale-[1.01] active:scale-95 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
              >
                <Play className="size-4" strokeWidth={2} />
                练习所选（{selected.size}）
              </button>
            </div>
            <div className="mb-2 grid grid-cols-2 gap-2">
              {/* 举一反三：弹方式选择（AI 讲解变式题 / 直接练习相似题）；有选中用所选，无选中用全部筛选错题 */}
              <button
                type="button"
                disabled={filteredItems.length === 0 || extendBusy || batchBusy || similarBusy}
                onClick={() =>
                  setExtendChoice({
                    base: selectedItems.length > 0 ? selectedItems : filteredItems,
                  })
                }
                className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-1 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-40"
              >
                {extendBusy || similarBusy ? (
                  <Loader2 className="size-4 shrink-0 animate-spin" />
                ) : (
                  <Sparkles className="size-4 shrink-0" />
                )}
                <span className="truncate">
                  举一反三
                  {selectedItems.length > 0
                    ? `（所选 ${selectedItems.length} 道）`
                    : `（全部 ${filteredItems.length} 道）`}
                </span>
              </button>
              {/* AI 批量讲解汇总：勾选的错题一次讲完（与收藏夹同款） */}
              <button
                type="button"
                disabled={selected.size === 0 || explainLoading || batchBusy}
                onClick={() => openBatchExplain(selectedItems)}
                className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-purple-500/40 bg-card px-1 text-sm font-medium text-purple-700 transition-colors hover:bg-purple-500/10 disabled:opacity-40 dark:text-purple-400"
              >
                {explainLoading ? (
                  <Loader2 className="size-4 shrink-0 animate-spin" />
                ) : (
                  <GraduationCap className="size-4 shrink-0" />
                )}
                <span className="truncate">AI 讲解（{selected.size}）</span>
              </button>
            </div>
            <div className="grid grid-cols-4 gap-2">
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
                onClick={() => runBatch('remove')}
                className="flex h-11 flex-col items-center justify-center gap-0.5 rounded-xl border border-border bg-card text-[11px] font-medium transition-colors hover:bg-accent disabled:opacity-40"
              >
                <EyeOff className="size-4" />
                移出错题
              </button>
              <button
                type="button"
                disabled={selected.size === 0 || batchBusy}
                onClick={() => runBatch(allFav ? 'unfav' : 'fav')}
                className="flex h-11 flex-col items-center justify-center gap-0.5 rounded-xl border border-border bg-card text-[11px] font-medium transition-colors hover:bg-accent disabled:opacity-40"
              >
                <Star className="size-4" fill={allFav ? 'currentColor' : 'none'} />
                {allFav ? '取消收藏' : '收藏'}
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
                    <AlertDialogTitle>删除 {selected.size} 道错题？</AlertDialogTitle>
                    <AlertDialogDescription>
                      将从错题本中彻底删除所选错题，此操作不可撤销。
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
      ) : mode === 'list' ? (
        <div className="fixed inset-x-0 bottom-[calc(1.5rem+env(safe-area-inset-bottom))] z-40 flex justify-center px-4">
          <button
            type="button"
            onClick={() => startPractice()}
            className="flex h-12 w-full max-w-2xl items-center justify-center gap-2 rounded-full bg-zinc-900 text-base font-semibold text-white shadow-lg shadow-black/20 transition-transform hover:scale-[1.02] active:scale-95 dark:bg-zinc-100 dark:text-zinc-900"
          >
            <Play className="size-4.5" strokeWidth={2} aria-hidden />
            去练习{filteredItems.length > 0 ? `（${filteredItems.length} 题）` : ''}
          </button>
        </div>
      ) : null}

      {/* 清空错题确认 */}
      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清空错题？</AlertDialogTitle>
            <AlertDialogDescription>
              将移除全部 {stats?.wrongCount ?? items.length} 道错题，此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                setClearOpen(false)
                void clearAll()
              }}
            >
              清空
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* AI 解析 / 批量讲解弹窗（RichContent 渲染 + 选中文本追问） */}
      <Dialog
        open={!!explainItems}
        onOpenChange={(o) => {
          if (!o && !explainLoading) closeExplain()
        }}
      >
        <DialogContent className="rounded-2xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {explainItems && explainItems.length > 1
                ? `AI 批量讲解（${explainItems.length} 题）`
                : 'AI 解析'}
            </DialogTitle>
            <DialogDescription className="line-clamp-2 text-xs leading-relaxed">
              {explainItems && explainItems.length > 1
                ? '逐题讲解所选错题，并总结共性易错点'
                : explainItems?.[0]?.question}
            </DialogDescription>
          </DialogHeader>
          <div
            ref={explainContentRef}
            className="max-h-[60vh] overflow-y-auto overscroll-contain"
          >
            {explainLoading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {explainItems && explainItems.length > 1
                  ? `AI 正在讲解 ${explainItems.length} 道题…`
                  : 'AI 正在解析…'}
              </div>
            ) : explainError ? (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <p className="text-sm text-destructive">{explainError}</p>
                <Button
                  variant="outline"
                  className="rounded-full"
                  onClick={() => {
                    if (explainItems && explainItems.length === 1) void openExplain(explainItems[0])
                    else if (explainItems) openBatchExplain(explainItems)
                  }}
                >
                  重试
                </Button>
              </div>
            ) : (
              /* 富媒体防护容器：讲解内容绝不撑破弹窗 */
              <div className="min-w-0 max-w-full break-words">
                <RichContent content={explainReply} />
              </div>
            )}
          </div>
          {!explainLoading && !explainError && explainReply && (
            <p className="border-t border-border px-4 py-2 text-center text-[11px] text-muted-foreground/80">
              选中讲解内容中的文字，可继续「追问」
            </p>
          )}
        </DialogContent>
      </Dialog>

      {/* 解析弹窗：选中文本 → 浮动「🔍 追问」按钮（portal 到 body，避开 Dialog
          transform 对 fixed 定位的影响；追问弹层接管，source:'analysis'） */}
      {explainFollow &&
        !!explainItems &&
        createPortal(
          <button
            type="button"
            onClick={sendExplainFollowup}
            style={{ left: explainFollow.x, top: explainFollow.y }}
            className="fixed z-[70] -translate-x-1/2 rounded-full border border-emerald-600/40 bg-background px-3.5 py-2 text-xs font-medium text-emerald-700 shadow-lg transition-transform active:scale-95 dark:text-emerald-300"
          >
            <span className="flex items-center gap-1.5">
              <Search className="size-3.5" strokeWidth={2} aria-hidden />
              追问
              <span className="max-w-[140px] truncate text-muted-foreground">
                {explainFollow.text.slice(0, 14)}
                {explainFollow.text.length > 14 ? '…' : ''}
              </span>
            </span>
          </button>,
          document.body,
        )}

      {/* 批量举一反三弹窗：AI 变式题讲解（RichContent 渲染）+ 存为试卷 */}
      <Dialog
        open={extendOpen}
        onOpenChange={(o) => {
          if (!o && !extendBusy) setExtendOpen(false)
        }}
      >
        <DialogContent className="rounded-2xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle>AI 举一反三</DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              基于 {extendBase.length} 道错题生成的变式题与讲解
              {extendBase.length > 0 && extendBase[0].cardTitle
                ? ` · 将存入《${extendBase[0].cardTitle}》`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto overscroll-contain">
            {extendBusy ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
                AI 正在举一反三…
              </div>
            ) : extendError ? (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <p className="text-sm text-destructive">{extendError}</p>
                <Button
                  variant="outline"
                  className="rounded-full"
                  onClick={() => void startExtend(extendBase)}
                >
                  重试
                </Button>
              </div>
            ) : (
              /* 富媒体防护容器：变式题讲解绝撑不破弹窗 */
              <div className="min-w-0 max-w-full break-words">
                <RichContent content={extendText} />
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              className="rounded-full"
              onClick={() => setExtendOpen(false)}
              disabled={extendBusy}
            >
              关闭
            </Button>
            <Button
              className="flex-1 rounded-full bg-emerald-600 text-white hover:bg-emerald-700"
              onClick={practiceExtend}
              disabled={extendBusy || extendSaving || !extendText.trim()}
            >
              <Play className="size-4" strokeWidth={2} />
              直接练习
            </Button>
            <Button
              className="flex-1 rounded-full bg-zinc-900 text-white hover:bg-zinc-800"
              onClick={() => void saveExtendAsPaper()}
              disabled={extendBusy || extendSaving || !extendText.trim()}
            >
              {extendSaving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <FolderPlus className="size-4" />
              )}
              存为试卷
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 举一反三方式选择：AI 讲解变式题 / 直接练习相似题 */}
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
            disabled={extendBusy}
            onClick={() => {
              const base = extendChoice?.base ?? []
              setExtendChoice(null)
              void startExtend(base)
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

      {/* 打印题单（仅打印时显示） */}
      <div id="wrong-print" className="hidden print:block">
        <h2 className="mb-1 text-lg font-bold">错题本 · {new Date().toLocaleDateString('zh-CN')}</h2>
        <p className="mb-4 text-xs">
          共 {filteredItems.length} 道
          {cardFilter !== 'all' ? ` · ${cardLabel}` : ''}
          {timeFilterText ? ` · ${timeFilterText}` : ''}
          {hlQuery ? ` · 搜索「${hlQuery}」` : ''}
        </p>
        {filteredItems.map((item, i) => (
          <div key={item.id} className="mb-3 border-b border-neutral-300 pb-2 text-sm">
            <p className="font-medium">
              {i + 1}. [{DISPLAY_LABEL[displayType(item)] ?? item.type}] {item.question}
            </p>
            <p className="mt-1 text-xs">
              我的答案：{userAnswers[userAnswerKey(item.cardId, item.question)]?.userAnswer || '（未记录）'}
            </p>
            <p className="mt-0.5 text-xs">正确答案：{item.answer || '（无标准答案）'}</p>
            <p className="mt-0.5 text-xs text-neutral-500">
              错 {item.wrongCount} 次 / 对 {item.rightCount} 次 · {item.cardTitle} ·{' '}
              {formatDate(item.updatedAt)}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

// 黑色圆形勾选框（多选模式）
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

// ---------- 内嵌练习模式（错题本 / 收藏题目 共用） ----------

export function PracticeBoard({
  items,
  autoRemove,
  onDone,
  onExit,
}: {
  items: QuizItemData[]
  autoRemove: AutoRemoveThreshold
  onDone: (right: number) => void
  onExit: () => void
}) {
  const [idx, setIdx] = React.useState(0)
  const [revealed, setRevealed] = React.useState(false)
  const [input, setInput] = React.useState('')
  const [picked, setPicked] = React.useState<string | null>(null)
  const [right, setRight] = React.useState(0)
  const [submitting, setSubmitting] = React.useState(false)
  const startAtRef = React.useRef<number>(Date.now())

  // 练习模式 TTS（context 'quiz'）：朗读题目，显示答案后一并朗读
  const settings = useSettingsLite()
  const tts = useQuickTts('quiz', settings)

  // 切题 / 卸载时停止上一题的朗读
  React.useEffect(() => {
    tts.stop()
     
  }, [idx])
  React.useEffect(() => {
    const stop = tts.stop
    return () => stop()
  }, [tts.stop])

  const finish = React.useRef<(right: number) => void>(onDone)
  finish.current = onDone

  const item = items[idx]
  const total = items.length

  React.useEffect(() => {
    startAtRef.current = Date.now()
  }, [idx])

  if (total === 0 || !item) {
    return (
      <div className="flex flex-col items-center gap-4 py-24 text-center">
        <p className="text-sm text-muted-foreground">暂无错题</p>
        <button
          type="button"
          onClick={onExit}
          className="h-11 rounded-full bg-zinc-900 px-8 text-sm font-semibold text-white"
        >
          返回
        </button>
      </div>
    )
  }

  const report = async (result: 'right' | 'wrong') => {
    if (submitting) return
    setSubmitting(true)
    const durationSec = Math.round((Date.now() - startAtRef.current) / 1000)
    const myAnswer = picked || input || ''
    const nextRight = result === 'right' ? right + 1 : right
    try {
      const res = await fetch('/api/quiz-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardId: item.cardId,
          cardTitle: item.cardTitle,
          type: item.type,
          question: item.question,
          answer: item.answer,
          options: item.options,
          result,
          autoRemove,
          durationSec,
          userAnswer: myAnswer.slice(0, 500),
        }),
      })
      if (!res.ok) throw new Error('上报失败')
      recordQuizUserAnswer(item.cardId, item.question, myAnswer)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '上报失败')
    } finally {
      setSubmitting(false)
    }
    if (idx + 1 >= total) {
      setRight(nextRight)
      finish.current(nextRight)
      return
    }
    setRight(nextRight)
    setIdx((i) => i + 1)
    setRevealed(false)
    setInput('')
    setPicked(null)
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 进度 */}
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          第 <span className="font-bold text-foreground">{idx + 1}</span> / {total} 题
        </span>
        <span>答对 {right}</span>
      </div>

      {/* 题目卡片 */}
      <div className="rounded-2xl bg-card p-4">
        <div className="flex items-center gap-2">
          <span className="rounded-lg bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {item.type === 'choice'
              ? item.options.length === 2 && JUDGE_ANSWERS.includes((item.answer || '').trim())
                ? '判断'
                : '选择'
              : item.type === 'fill'
                ? '填空'
                : '简答'}
          </span>
          <span className="truncate text-xs text-muted-foreground">{item.cardTitle}</span>
          <button
            type="button"
            aria-label={tts.speaking ? '停止朗读' : '朗读题目'}
            onClick={() =>
              tts.speaking
                ? tts.stop()
                : tts.speak(
                    revealed && item.answer
                      ? `题目：${item.question}。正确答案：${item.answer}`
                      : item.question,
                  )
            }
            className="ml-auto flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-emerald-600"
          >
            {tts.speaking ? (
              <Square className="size-4" strokeWidth={1.9} />
            ) : (
              <Volume2 className="size-4" strokeWidth={1.9} />
            )}
          </button>
        </div>
        <p className="mt-3 whitespace-pre-wrap text-[15px] font-medium leading-relaxed">
          {item.question}
        </p>

        {item.type === 'choice' && item.options.length > 0 ? (
          <div className="mt-4 flex flex-col gap-2">
            {item.options.map((opt, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setPicked(opt)}
                className={cn(
                  'min-h-11 rounded-xl border border-border px-4 py-2.5 text-left text-sm leading-relaxed transition-colors',
                  picked === opt
                    ? 'border-zinc-900 bg-zinc-900/5 font-medium dark:border-zinc-100/60 dark:bg-zinc-100/10'
                    : 'hover:bg-muted/60',
                )}
              >
                {String.fromCharCode(65 + i)}. {opt}
              </button>
            ))}
          </div>
        ) : (
          <div className="mt-4 flex items-center gap-1.5">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="输入你的答案（可语音输入）"
              className="h-11 rounded-xl"
            />
            <VoiceInput
              size="sm"
              context="quiz"
              disabled={revealed}
              onText={(t) => setInput((p) => (p ? p + t : t))}
            />
          </div>
        )}
      </div>

      {!revealed ? (
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="h-12 rounded-full bg-zinc-900 text-base font-semibold text-white transition-transform hover:scale-[1.02] active:scale-95 dark:bg-zinc-100 dark:text-zinc-900"
        >
          显示答案
        </button>
      ) : (
        <>
          {/* 答案 */}
          <div className="rounded-2xl bg-card p-4">
            <p className="text-xs text-muted-foreground">正确答案</p>
            <p className="mt-1.5 whitespace-pre-wrap text-[15px] font-bold leading-relaxed">
              {item.answer || '（无标准答案）'}
            </p>
            {picked && (
              <p className="mt-2 text-xs text-muted-foreground">
                你的选择：{picked}
                {input && item.type !== 'choice' ? ` · 你的输入：${input}` : ''}
              </p>
            )}
            {!picked && input && item.type !== 'choice' && (
              <p className="mt-2 text-xs text-muted-foreground">你的输入：{input}</p>
            )}
          </div>

          {/* 判定 */}
          <div className="flex gap-3">
            <button
              type="button"
              disabled={submitting}
              onClick={() => report('wrong')}
              className="flex h-12 flex-1 items-center justify-center rounded-full border border-border bg-card text-base font-semibold disabled:opacity-50"
            >
              答错
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => report('right')}
              className="flex h-12 flex-1 items-center justify-center rounded-full bg-zinc-900 text-base font-semibold text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              答对
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// 练习完成页（由父组件在 done 模式渲染）
export function PracticeDone({
  right,
  total,
  onBack,
}: {
  right: number
  total: number
  onBack: () => void
}) {
  return (
    <div className="flex flex-col items-center gap-5 py-24 text-center">
      <p className="text-2xl font-bold">练习完成 🎉</p>
      <p className="text-sm text-muted-foreground">
        答对 <span className="font-bold text-red-500">{right}</span> / 共 {total}
      </p>
      <button
        type="button"
        onClick={onBack}
        className="h-12 rounded-full bg-zinc-900 px-10 text-base font-semibold text-white transition-transform hover:scale-[1.02] active:scale-95 dark:bg-zinc-100 dark:text-zinc-900"
      >
        返回
      </button>
    </div>
  )
}
