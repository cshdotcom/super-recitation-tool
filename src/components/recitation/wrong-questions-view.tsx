'use client'

import * as React from 'react'
import {
  ChevronDown,
  ChevronLeft,
  Download,
  EyeOff,
  GraduationCap,
  Loader2,
  MoreVertical,
  Play,
  Printer,
  Sparkles,
  Square,
  Star,
  Trash2,
  Volume2,
} from 'lucide-react'
import { toast } from 'sonner'

import type { AutoRemoveThreshold, QuizItemData, QuizType, WrongStats } from '@/lib/types'
import { cn } from '@/lib/utils'
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
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

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

type TimeKey = 'today' | '7d' | '30d' | 'all'

const TIME_OPTIONS: { key: TimeKey; label: string }[] = [
  { key: 'today', label: '今天' },
  { key: '7d', label: '近7天' },
  { key: '30d', label: '近30天' },
  { key: 'all', label: '全部' },
]

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

  // ---- 筛选 ----
  const [cardFilter, setCardFilter] = React.useState<string>('all')
  const [timeFilter, setTimeFilter] = React.useState<TimeKey>('all')

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

  // ---- AI 解析 ----
  const [explainItem, setExplainItem] = React.useState<QuizItemData | null>(null)
  const [explainLoading, setExplainLoading] = React.useState(false)
  const [explainReply, setExplainReply] = React.useState('')
  const [explainError, setExplainError] = React.useState('')
  const explainAbortRef = React.useRef<AbortController | null>(null)

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
    return items.filter((i) => {
      if (cardFilter !== 'all' && i.cardId !== cardFilter) return false
      if (timeFilter === 'all') return true
      const t = new Date(i.updatedAt).getTime()
      if (Number.isNaN(t)) return false
      if (timeFilter === 'today') return new Date(t).toDateString() === new Date(now).toDateString()
      if (timeFilter === '7d') return now - t <= 7 * 86400000
      return now - t <= 30 * 86400000
    })
  }, [items, cardFilter, timeFilter])

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
      toast.success(`已生成 ${mapped.length} 道相似新题`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '举一反三失败')
    } finally {
      setSimilarBusy(false)
    }
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

  // ---- AI 解析：讲解错题涉及的知识点 ----
  const openExplain = (item: QuizItemData) => {
    explainAbortRef.current?.abort()
    const ctrl = new AbortController()
    explainAbortRef.current = ctrl
    setExplainItem(item)
    setExplainReply('')
    setExplainError('')
    setExplainLoading(true)
    const my = userAnswers[userAnswerKey(item.cardId, item.question)]?.userAnswer
    const lines = [
      '讲解这道错题涉及的知识点：',
      `题目：${item.question}`,
      ...(item.options.length > 0 ? [`选项：${item.options.join('；')}`] : []),
      `正确答案：${item.answer || '（无标准答案）'}`,
      ...(my ? [`我的答案：${my}`] : []),
    ]
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        mode: 'ask',
        content: item.cardTitle
          ? `来自卡片「${item.cardTitle}」的错题：${item.question}`
          : item.question,
        messages: [{ role: 'user', content: lines.join('\n') }],
      }),
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { reply?: string; error?: string }
        if (!res.ok) throw new Error(data.error || 'AI 解析失败')
        setExplainReply(data.reply || '')
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setExplainError(err instanceof Error ? err.message : 'AI 解析失败')
        toast.error(err instanceof Error ? err.message : 'AI 解析失败')
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setExplainLoading(false)
      })
  }

  const closeExplain = () => {
    explainAbortRef.current?.abort()
    setExplainItem(null)
    setExplainLoading(false)
    tts.stop()
  }

  // ---- 导出 CSV ----
  const exportCSV = () => {
    if (filteredItems.length === 0) {
      toast('当前筛选下没有错题')
      return
    }
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const rows: string[][] = [
      ['题目', '类型', '我的答案', '正确答案', '错误次数', '来源卡片', '时间'],
      ...filteredItems.map((i) => [
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
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `错题本_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.success(`已导出 ${filteredItems.length} 道错题`)
  }

  // ---- 顶栏返回 ----
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

  const startPractice = () => {
    if (filteredItems.length === 0) {
      toast('暂无错题')
      return
    }
    setMode('practice')
  }

  const onPracticeDone = (right: number) => {
    const total = mode === 'similar' ? similarItems.length : filteredItems.length
    setDone({ right, total })
    setMode('done')
    void fetchQuizUserAnswers().then(setUserAnswers)
    Promise.all([loadStats(), loadItems()])
  }

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
                  <DropdownMenuItem onClick={exportCSV}>
                    <Download className="size-4" /> 导出 CSV
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
            <button
              type="button"
              onClick={toggleSelectAll}
              className="ml-auto shrink-0 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {allSelected ? '取消全选' : '全选'}
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 pb-32 pt-4">
        {mode === 'practice' ? (
          <PracticeBoard
            items={filteredItems}
            autoRemove={removeN}
            onDone={onPracticeDone}
            onExit={() => setMode('list')}
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
            {/* 筛选行：卡片分类 + 时间 chips */}
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
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

            {/* 错题列表 */}
            <div className="mb-2 mt-6 flex items-center justify-between">
              <h2 className="text-base font-bold">
                错题列表
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  {filteredItems.length} 道
                </span>
              </h2>
              {selectMode && (
                <span className="text-xs text-muted-foreground">长按或点「选择」可多选</span>
              )}
            </div>

            {filteredItems.length === 0 ? (
              <div className="rounded-2xl bg-card py-14 text-center text-sm text-muted-foreground">
                {items.length === 0 ? '暂无错题，快去练习吧' : '当前筛选下没有错题'}
              </div>
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
                            {item.question}
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
                                {item.answer || '（无标准答案）'}
                              </span>
                            </p>
                          </div>
                          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                            <span>
                              错 {item.wrongCount} 次 · 对 {item.rightCount} 次
                            </span>
                            {item.cardTitle && <span>来源：{item.cardTitle}</span>}
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
                              onClick={() => openExplain(item)}
                              className="flex h-9 items-center gap-1.5 rounded-full border border-purple-500/40 px-3.5 text-xs font-medium text-purple-700 transition-colors hover:bg-purple-500/10 dark:text-purple-400"
                            >
                              <GraduationCap className="size-3.5" />
                              AI 解析
                            </button>
                            <button
                              type="button"
                              disabled={similarBusy}
                              onClick={() => startSimilar([item])}
                              className="flex h-9 items-center gap-1.5 rounded-full border border-emerald-600/40 px-3.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/10 disabled:opacity-50 dark:text-emerald-400"
                            >
                              {similarBusy ? (
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
        <div className="fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
          <div className="w-full max-w-2xl rounded-2xl border border-border bg-card/95 p-3 shadow-lg shadow-black/10 backdrop-blur">
            <p className="pb-2 text-center text-xs text-muted-foreground">
              已选 {selected.size} 道错题
            </p>
            <div className="grid grid-cols-4 gap-2">
              <button
                type="button"
                disabled={selected.size === 0 || similarBusy || batchBusy}
                onClick={() => startSimilar(selectedItems)}
                className="flex h-11 flex-col items-center justify-center gap-0.5 rounded-xl bg-emerald-600 text-[11px] font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-40"
              >
                {similarBusy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                举一反三
              </button>
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
        <div className="fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
          <button
            type="button"
            onClick={startPractice}
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

      {/* AI 解析弹窗 */}
      <Dialog
        open={!!explainItem}
        onOpenChange={(o) => {
          if (!o) closeExplain()
        }}
      >
        <DialogContent className="rounded-2xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle>AI 解析</DialogTitle>
            <DialogDescription className="line-clamp-2 text-xs leading-relaxed">
              {explainItem?.question}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto overscroll-contain">
            {explainLoading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                AI 正在解析…
              </div>
            ) : explainError ? (
              <p className="py-8 text-center text-sm text-destructive">{explainError}</p>
            ) : (
              <RichContent content={explainReply} />
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* 打印题单（仅打印时显示） */}
      <div id="wrong-print" className="hidden print:block">
        <h2 className="mb-1 text-lg font-bold">错题本 · {new Date().toLocaleDateString('zh-CN')}</h2>
        <p className="mb-4 text-xs">
          共 {filteredItems.length} 道
          {cardFilter !== 'all' ? ` · ${cardLabel}` : ''}
          {timeFilter !== 'all'
            ? ` · ${TIME_OPTIONS.find((t) => t.key === timeFilter)?.label ?? ''}`
            : ''}
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

// ---------- 内嵌练习模式 ----------

function PracticeBoard({
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
