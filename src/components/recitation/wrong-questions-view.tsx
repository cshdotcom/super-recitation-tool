'use client'

import * as React from 'react'
import {
  ChevronDown,
  ChevronLeft,
  Loader2,
  Play,
} from 'lucide-react'
import { toast } from 'sonner'

import type { AutoRemoveThreshold, QuizItemData, WrongStats } from '@/lib/types'
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

interface WrongQuestionsViewProps {
  onBack: () => void
  /** 当前 quizAutoRemove 设置（父组件持有则传入） */
  autoRemove?: AutoRemoveThreshold
  /** 修改 quizAutoRemove（父组件传入则同时通知父组件；组件内部始终会 PATCH settings） */
  onChangeAutoRemove?: (n: AutoRemoveThreshold) => void
}

const TYPE_LABEL: Record<string, string> = {
  fill: '填空',
  short: '简答',
  choice: '选择',
}

const REMOVE_OPTIONS: AutoRemoveThreshold[] = [1, 2, 3, 5]

const BUCKETS: { key: keyof WrongStats['buckets']; label: string }[] = [
  { key: 'fivePlus', label: '答错5次及以上' },
  { key: 'three', label: '答错3次' },
  { key: 'two', label: '答错2次' },
  { key: 'one', label: '答错1次' },
]

// 错题本：统计 + 分类 + 逐题练习（全屏视图）
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
  const [mode, setMode] = React.useState<'list' | 'practice' | 'done'>('list')
  const [done, setDone] = React.useState<{ right: number; total: number } | null>(null)

  React.useEffect(() => {
    if (typeof autoRemove === 'number') setRemoveN(autoRemove)
  }, [autoRemove])

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
      await Promise.all([loadStats(), loadItems()])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '清空失败')
    } finally {
      setClearing(false)
    }
  }

  const startPractice = () => {
    if (items.length === 0) {
      toast('暂无错题')
      return
    }
    setMode('practice')
  }

  const onPracticeDone = (right: number) => {
    setDone({ right, total: items.length })
    setMode('done')
    Promise.all([loadStats(), loadItems()])
  }

  return (
    <div className="min-h-dvh bg-muted/40">
      {/* 顶栏 */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="relative mx-auto flex h-14 max-w-2xl items-center px-4">
          <button
            type="button"
            aria-label="返回"
            onClick={mode === 'practice' || mode === 'done' ? () => setMode('list') : onBack}
            className="shrink-0 rounded-full p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="size-6 text-foreground" strokeWidth={2} />
          </button>
          <h1 className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-lg font-bold">
            错题本
          </h1>
          {mode === 'list' && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button
                  type="button"
                  disabled={clearing}
                  className="ml-auto shrink-0 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  {clearing ? '清空中…' : '清空错题'}
                </button>
              </AlertDialogTrigger>
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
                    onClick={clearAll}
                  >
                    清空
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 pb-32 pt-4">
        {mode === 'practice' ? (
          <PracticeBoard
            items={items}
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
            {/* 设置行 */}
            <div className="flex h-14 items-center justify-between rounded-xl bg-card px-4">
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
                  <span className="text-5xl font-bold leading-none">{cell.value}</span>
                  <span className="text-sm text-muted-foreground">{cell.label}</span>
                </div>
              ))}
            </div>

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
          </>
        )}
      </main>

      {/* 底部黑色胶囊：去练习（练习模式中隐藏） */}
      {mode === 'list' && (
        <div className="fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
          <button
            type="button"
            onClick={startPractice}
            className="flex h-12 w-full max-w-2xl items-center justify-center gap-2 rounded-full bg-zinc-900 text-base font-semibold text-white shadow-lg shadow-black/20 transition-transform hover:scale-[1.02] active:scale-95"
          >
            <Play className="size-4.5" strokeWidth={2} aria-hidden />
            去练习
          </button>
        </div>
      )}
    </div>
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
        }),
      })
      if (!res.ok) throw new Error('上报失败')
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
            {TYPE_LABEL[item.type] ?? '题目'}
          </span>
          <span className="truncate text-xs text-muted-foreground">{item.cardTitle}</span>
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
                    ? 'border-zinc-900 bg-zinc-900/5 font-medium'
                    : 'hover:bg-muted/60',
                )}
              >
                {String.fromCharCode(65 + i)}. {opt}
              </button>
            ))}
          </div>
        ) : (
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入你的答案"
            className="mt-4 h-11 rounded-xl"
          />
        )}
      </div>

      {!revealed ? (
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="h-12 rounded-full bg-zinc-900 text-base font-semibold text-white transition-transform hover:scale-[1.02] active:scale-95"
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
              className="flex h-12 flex-1 items-center justify-center rounded-full bg-zinc-900 text-base font-semibold text-white disabled:opacity-50"
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
        className="h-12 rounded-full bg-zinc-900 px-10 text-base font-semibold text-white transition-transform hover:scale-[1.02] active:scale-95"
      >
        返回
      </button>
    </div>
  )
}
