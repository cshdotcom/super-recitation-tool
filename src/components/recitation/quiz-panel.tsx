'use client'

import * as React from 'react'
import {
  Loader2,
  FileQuestion,
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  RotateCcw,
  Check,
  ChevronRight,
  BookOpen,
  FileStack,
  SlidersHorizontal,
  Star,
} from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { splitParagraphs } from '@/lib/cloze'
import type { QuizQuestion } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { BottomSheet } from '@/components/recitation/bottom-sheet'

interface QuizPanelProps {
  content: string
  keywords: string[]
  /** 错题/收藏上报归属卡 */
  cardId?: string
  cardTitle?: string
  /** 答对后自动移除错题 — 答对N次后 */
  autoRemove?: number
}

type QuizScope = 'chapter' | 'book' | 'custom'

const SCOPE_LABEL: Record<QuizScope, string> = {
  chapter: '本章节',
  book: '整本书',
  custom: '自定义段落',
}

/** Content below this length is too short for book/custom scope. */
const MIN_SCOPE_LEN = 120

const TYPE_LABEL: Record<QuizQuestion['type'], string> = {
  fill: '填空',
  short: '简答',
  choice: '选择',
}

export function QuizPanel({ content, keywords, cardId, cardTitle, autoRemove = 2 }: QuizPanelProps) {
  const [questions, setQuestions] = React.useState<QuizQuestion[]>([])
  const [loading, setLoading] = React.useState(false)
  const [answers, setAnswers] = React.useState<Record<number, string>>({})
  const [revealed, setRevealed] = React.useState<Set<number>>(new Set())
  const [favorites, setFavorites] = React.useState<Set<number>>(new Set())
  const [quizStart, setQuizStart] = React.useState<number>(Date.now())

  // ---- scope selection (请选择出题范围 sheet, opens first every time) ----
  const [scopeOpen, setScopeOpen] = React.useState(false)
  const [scope, setScope] = React.useState<QuizScope>('chapter')
  const [customSel, setCustomSel] = React.useState<Set<number>>(new Set())
  const [activeScope, setActiveScope] = React.useState<QuizScope | null>(null)
  const [preparing, setPreparing] = React.useState(false)

  const paragraphs = React.useMemo(() => splitParagraphs(content), [content])
  const tooShort = content.trim().length < MIN_SCOPE_LEN

  const openScopeSheet = React.useCallback(() => {
    // 自定义默认全选
    setCustomSel(new Set(paragraphs.map((_, i) => i)))
    setScopeOpen(true)
  }, [paragraphs])

  // Show the scope sheet every time the quiz tool opens.
  React.useEffect(() => {
    const t = window.setTimeout(() => openScopeSheet(), 250)
    return () => window.clearTimeout(t)
  }, [openScopeSheet])

  const generate = async (finalContent: string, kw: string[]) => {
    setLoading(true)
    const tid = toast.loading('AI 正在出题…')
    try {
      const res = await fetch('/api/quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: finalContent, keywords: kw, count: 5 }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '出题失败')
      }
      const data = (await res.json()) as { questions: QuizQuestion[] }
      const qs = data.questions || []
      if (qs.length === 0) {
        toast.warning('AI 未返回题目', { id: tid })
        return
      }
      setQuestions(qs)
      setAnswers({})
      setRevealed(new Set())
      setFavorites(new Set())
      setQuizStart(Date.now())
      toast.success(`已生成 ${qs.length} 道题`, { id: tid })
    } catch (err) {
      toast.error(
        '出题失败：' + (err instanceof Error ? err.message : '未知错误'),
        { id: tid },
      )
    } finally {
      setLoading(false)
    }
  }

  // 下一步：resolve the chosen scope into text, then generate.
  const startGeneration = async () => {
    if (!content.trim()) {
      toast.error('内容为空，无法出题')
      return
    }
    if (scope === 'book') {
      setPreparing(true)
      const tid = toast.loading('正在汇总全书内容…')
      try {
        const res = await fetch('/api/cards')
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || '获取背书卡失败')
        }
        const data = (await res.json()) as {
          cards?: { title: string; content: string }[]
        }
        const cards = data.cards ?? []
        // concat titles + contents, cap 6000 chars total
        let merged = ''
        for (const c of cards) {
          const part = `${c.title}\n${c.content}`.trim()
          if (!part) continue
          if (merged.length + part.length > 6000) {
            merged += (merged ? '\n\n' : '') + part.slice(0, 6000 - merged.length)
            break
          }
          merged += (merged ? '\n\n' : '') + part
        }
        if (!merged.trim()) {
          toast.warning('没有可用的背书卡内容', { id: tid })
          setPreparing(false)
          return
        }
        toast.success(`已汇总 ${cards.length} 张背书卡`, { id: tid })
        setActiveScope('book')
        setScopeOpen(false)
        setPreparing(false)
        await generate(merged, [])
      } catch (err) {
        toast.error(
          '汇总全书失败：' + (err instanceof Error ? err.message : '未知错误'),
          { id: tid },
        )
        setPreparing(false)
      }
      return
    }

    let finalContent = content
    if (scope === 'custom') {
      const sel = paragraphs.filter((_, i) => customSel.has(i))
      if (sel.length === 0) {
        toast.warning('请至少勾选一个段落')
        return
      }
      finalContent = sel.join('\n')
    }
    setActiveScope(scope)
    setScopeOpen(false)
    await generate(finalContent, keywords)
  }

  const toggleReveal = (idx: number) => {
    setRevealed((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
    // 第一次看答案时判定对错并上报错题/答题报告（服务端持久化）。
    const q = questions[idx]
    if (q && !revealed.has(idx)) {
      const ans = (answers[idx] || '').trim()
      const right = !!ans && ans === q.answer.trim()
      void fetch('/api/quiz-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardId,
          cardTitle,
          type: q.type,
          question: q.question,
          answer: q.answer,
          options: q.options ?? [],
          result: right ? 'right' : 'wrong',
          autoRemove,
          durationSec: Math.min(600, Math.round((Date.now() - quizStart) / 1000)),
        }),
      }).catch(() => {})
      if (!right) toast.warning('已加入错题本')
    }
  }

  const setAnswer = (idx: number, val: string) => {
    setAnswers((prev) => ({ ...prev, [idx]: val }))
  }

  const toggleCustomPara = (i: number) => {
    setCustomSel((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  // 收藏题目：POST upsert（favorite:true/false），本地 optimistic 更新。
  const toggleFavorite = (idx: number) => {
    const q = questions[idx]
    if (!q) return
    const willFav = !favorites.has(idx)
    setFavorites((prev) => {
      const next = new Set(prev)
      if (willFav) next.add(idx)
      else next.delete(idx)
      return next
    })
    void fetch('/api/quiz-items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cardId,
        cardTitle,
        type: q.type,
        question: q.question,
        answer: q.answer,
        options: q.options ?? [],
        favorite: willFav,
      }),
    })
      .then(() => toast.success(willFav ? '已收藏题目' : '已取消收藏'))
      .catch(() => toast.error('收藏失败，请重试'))
  }

  // Auto-evaluate choice questions (counted only when revealed)
  const correctCount = React.useMemo(() => {
    let count = 0
    let total = 0
    questions.forEach((q, idx) => {
      if (q.type === 'choice') {
        total++
        const ans = answers[idx]
        if (revealed.has(idx) && ans && ans === q.answer) count++
      } else if (revealed.has(idx)) {
        total++
        // self-checked: assume correct if user marked revealed
        // (no auto-eval; we count it as "self-assessed correct" only if answer matches)
        const ans = (answers[idx] || '').trim()
        if (ans && ans === q.answer.trim()) count++
      }
    })
    return { count, total }
  }, [questions, answers, revealed])

  const scopeHint =
    scope === 'chapter'
      ? '使用当前背书卡的全部内容出题'
      : scope === 'book'
        ? '汇总全部背书卡内容出题（前 6000 字）'
        : '勾选当前卡片中需要的段落范围'

  return (
    <div className="flex flex-col gap-3">
      {/* scope chip + generate */}
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-sm text-muted-foreground">
          {questions.length > 0
            ? `共 ${questions.length} 题 · 已答对 ${correctCount.count}`
            : '点击下方按钮生成练习题'}
        </div>
        <Button
          size="sm"
          onClick={openScopeSheet}
          disabled={loading || !content.trim()}
          className="shrink-0 bg-emerald-600 text-white hover:bg-emerald-700"
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <FileQuestion className="size-3.5" />
          )}
          {questions.length > 0 ? '重新生成' : '生成练习题'}
        </Button>
      </div>

      {activeScope && (
        <button
          type="button"
          onClick={openScopeSheet}
          className="flex w-full items-center justify-between rounded-xl border border-border bg-card px-3 py-2 text-left text-xs transition-colors hover:bg-accent/50"
        >
          <span className="text-muted-foreground">
            出题范围：
            <span className="font-semibold text-emerald-600">
              {SCOPE_LABEL[activeScope]}
            </span>
          </span>
          <span className="flex items-center text-muted-foreground">
            更换范围 <ChevronRight className="size-3.5" />
          </span>
        </button>
      )}

      {questions.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
          <FileQuestion className="size-8 text-muted-foreground/40" />
          AI 将根据课文自动生成填空、简答与选择题
        </div>
      ) : (
        <ol className="flex flex-col gap-3">
          {questions.map((q, idx) => {
            const isRevealed = revealed.has(idx)
            const userAnswer = answers[idx] || ''
            const isChoice = q.type === 'choice'
            const isCorrect =
              isRevealed && userAnswer === q.answer
            return (
              <li key={idx}>
                <Card className="gap-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2">
                      <span className="text-xs font-semibold text-muted-foreground">
                        {idx + 1}.
                      </span>
                      <p className="text-sm leading-relaxed">
                        {renderQuestionText(q.question)}
                      </p>
                    </div>
                    <Badge
                      variant="secondary"
                      className={cn(
                        'shrink-0',
                        q.type === 'choice'
                          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                          : q.type === 'fill'
                            ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                            : 'bg-secondary',
                      )}
                    >
                      {TYPE_LABEL[q.type]}
                    </Badge>
                    <button
                      type="button"
                      aria-label={favorites.has(idx) ? '取消收藏' : '收藏题目'}
                      onClick={() => toggleFavorite(idx)}
                      className={cn(
                        'shrink-0 rounded-full p-1.5 transition-colors',
                        favorites.has(idx)
                          ? 'text-amber-400 hover:text-amber-500'
                          : 'text-muted-foreground/50 hover:text-amber-400',
                      )}
                    >
                      <Star
                        className="size-4"
                        strokeWidth={1.75}
                        fill={favorites.has(idx) ? 'currentColor' : 'none'}
                      />
                    </button>
                  </div>

                  {isChoice && q.options ? (
                    <div className="flex flex-col gap-1.5">
                      {q.options.map((opt, oIdx) => {
                        const selected = userAnswer === opt
                        const correctOpt = isRevealed && opt === q.answer
                        const wrongPick =
                          isRevealed && selected && opt !== q.answer
                        return (
                          <button
                            key={oIdx}
                            type="button"
                            onClick={() => setAnswer(idx, opt)}
                            disabled={isRevealed}
                            className={cn(
                              'flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors',
                              !isRevealed && selected
                                ? 'border-emerald-500/50 bg-emerald-500/10'
                                : 'hover:bg-accent',
                              correctOpt &&
                                'border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
                              wrongPick &&
                                'border-destructive/40 bg-destructive/10 text-destructive',
                            )}
                          >
                            <span>{opt}</span>
                            {correctOpt && (
                              <CheckCircle2 className="size-4 text-emerald-600" />
                            )}
                            {wrongPick && (
                              <XCircle className="size-4 text-destructive" />
                            )}
                          </button>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      <Input
                        value={userAnswer}
                        onChange={(e) => setAnswer(idx, e.target.value)}
                        placeholder="在此输入你的答案…"
                        disabled={isRevealed}
                      />
                      {isRevealed && (
                        <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                          <span className="text-muted-foreground">参考答案：</span>
                          <span className="font-medium text-emerald-700 dark:text-emerald-300">
                            {q.answer}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex items-center justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleReveal(idx)}
                      className="text-xs text-muted-foreground"
                    >
                      {isRevealed ? (
                        <>
                          <EyeOff className="size-3" /> 隐藏答案
                        </>
                      ) : (
                        <>
                          <Eye className="size-3" /> 查看答案
                        </>
                      )}
                    </Button>
                  </div>
                </Card>
              </li>
            )
          })}

          <li className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-2 text-sm">
            <span className="text-muted-foreground">练习得分</span>
            <span className="font-semibold">
              {correctCount.count} / {correctCount.total || questions.length}
            </span>
          </li>
        </ol>
      )}

      {questions.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setAnswers({})
            setRevealed(new Set())
            setQuizStart(Date.now())
          }}
          className="w-full text-muted-foreground"
        >
          <RotateCcw className="size-3.5" /> 清空答题
        </Button>
      )}

      {/* ---------- 出题范围 sheet ---------- */}
      <BottomSheet
        open={scopeOpen}
        onOpenChange={setScopeOpen}
        title="请选择出题范围"
        className="h-auto min-h-[320px]"
      >
        <div className="mt-4 flex flex-col gap-3 pb-4">
          {tooShort && (
            <p className="rounded-xl bg-muted/60 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
              背书原文内容较少，范围仅支持选择按本章节
            </p>
          )}

          <ScopeRow
            icon={BookOpen}
            label="按章节"
            desc="使用当前背书卡的全部内容出题"
            active={scope === 'chapter'}
            onSelect={() => setScope('chapter')}
          />
          <ScopeRow
            icon={FileStack}
            label="按本书"
            desc="汇总全部背书卡内容出题（前 6000 字）"
            active={scope === 'book'}
            disabled={tooShort}
            onSelect={() => setScope('book')}
          />
          <ScopeRow
            icon={SlidersHorizontal}
            label="自定义"
            desc="勾选当前卡片中需要的段落范围"
            active={scope === 'custom'}
            disabled={tooShort}
            onSelect={() => setScope('custom')}
          />

          {scope === 'custom' && !tooShort && (
            <div className="max-h-48 overflow-y-auto rounded-2xl border border-border bg-card p-2">
              {paragraphs.map((p, i) => (
                <label
                  key={i}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-accent/50"
                >
                  <Checkbox
                    checked={customSel.has(i)}
                    onCheckedChange={() => toggleCustomPara(i)}
                    aria-label={`选择第 ${i + 1} 段`}
                    className="data-[state=checked]:bg-emerald-600 data-[state=checked]:border-emerald-600"
                  />
                  <span className="min-w-0 flex-1 truncate text-xs">
                    <span className="mr-1 font-semibold text-muted-foreground">
                      第{i + 1}段
                    </span>
                    {p.trim() || '（空段落）'}
                  </span>
                </label>
              ))}
            </div>
          )}

          <p className="px-1 text-[11px] text-muted-foreground">{scopeHint}</p>

          <Button
            onClick={() => void startGeneration()}
            disabled={preparing || !content.trim() || (scope === 'book' && tooShort)}
            className="h-12 w-full rounded-full bg-primary text-base font-semibold"
          >
            {preparing && <Loader2 className="size-4 animate-spin" />}
            下一步
          </Button>
        </div>
      </BottomSheet>
    </div>
  )
}

// Big white option row (screenshot style).
function ScopeRow({
  icon: Icon,
  label,
  desc,
  active,
  disabled,
  onSelect,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
  label: string
  desc: string
  active: boolean
  disabled?: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex items-center justify-between gap-3 rounded-2xl border px-4 py-3.5 text-left transition-colors',
        active
          ? 'border-emerald-600/50 bg-emerald-500/10'
          : 'border-border bg-card hover:bg-accent/50',
        disabled && 'cursor-not-allowed opacity-45 hover:bg-card',
      )}
    >
      <span className="flex min-w-0 items-center gap-3">
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-xl',
            active ? 'bg-emerald-600/15 text-emerald-600' : 'bg-muted text-muted-foreground',
            disabled && 'text-muted-foreground/50',
          )}
        >
          <Icon className="size-4.5" strokeWidth={1.75} />
        </span>
        <span className="min-w-0">
          <span
            className={cn(
              'block text-sm font-bold',
              disabled && 'text-muted-foreground/60',
            )}
          >
            {label}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{desc}</span>
        </span>
      </span>
      <span
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full border',
          active
            ? 'border-emerald-600 bg-emerald-600 text-white'
            : 'border-border bg-transparent text-transparent',
        )}
      >
        <Check className="size-3" strokeWidth={2.5} />
      </span>
    </button>
  )
}

function renderQuestionText(text: string): React.ReactNode {
  // Highlight ____ fill placeholders
  if (!text) return null
  const parts = text.split(/_{2,}/)
  if (parts.length === 1) return text
  return (
    <>
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {p}
          {i < parts.length - 1 && (
            <span className="mx-1 inline-block min-w-[3rem] border-b-2 border-dashed border-foreground/40 align-baseline" />
          )}
        </React.Fragment>
      ))}
    </>
  )
}
