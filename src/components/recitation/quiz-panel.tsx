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
} from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import type { QuizQuestion } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'

interface QuizPanelProps {
  content: string
  keywords: string[]
}

const TYPE_LABEL: Record<QuizQuestion['type'], string> = {
  fill: '填空',
  short: '简答',
  choice: '选择',
}

export function QuizPanel({ content, keywords }: QuizPanelProps) {
  const [questions, setQuestions] = React.useState<QuizQuestion[]>([])
  const [loading, setLoading] = React.useState(false)
  const [answers, setAnswers] = React.useState<Record<number, string>>({})
  const [revealed, setRevealed] = React.useState<Set<number>>(new Set())

  const handleGenerate = async () => {
    if (!content.trim()) {
      toast.error('内容为空，无法出题')
      return
    }
    setLoading(true)
    const tid = toast.loading('AI 正在出题…')
    try {
      const res = await fetch('/api/quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, keywords, count: 5 }),
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

  const toggleReveal = (idx: number) => {
    setRevealed((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  const setAnswer = (idx: number, val: string) => {
    setAnswers((prev) => ({ ...prev, [idx]: val }))
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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          {questions.length > 0
            ? `共 ${questions.length} 题 · 已答对 ${correctCount.count}`
            : '点击下方按钮生成练习题'}
        </div>
        <Button
          size="sm"
          onClick={handleGenerate}
          disabled={loading || !content.trim()}
          className="bg-emerald-600 text-white hover:bg-emerald-700"
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <FileQuestion className="size-3.5" />
          )}
          {questions.length > 0 ? '重新生成' : '生成练习题'}
        </Button>
      </div>

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
          }}
          className="w-full text-muted-foreground"
        >
          <RotateCcw className="size-3.5" /> 清空答题
        </Button>
      )}
    </div>
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
