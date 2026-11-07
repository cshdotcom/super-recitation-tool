'use client'

import * as React from 'react'
import { Check, ChevronLeft, ChevronRight, Eye, EyeOff, RotateCcw, Square, Volume2 } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { normalize, similarity } from '@/lib/cloze'
import { splitSentences } from '@/lib/sentences'
import { useSettingsLite } from '@/lib/voice-prefs'
import { useQuickTts, VoiceSpeedBar } from '@/components/recitation/tts-player'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

interface CopywritePanelProps {
  content: string
}

interface CopywriteResult {
  score: number
  missed: string[]
}

// 摹写：看句子默写，逐字检查
export function CopywritePanel({ content }: CopywritePanelProps) {
  const settings = useSettingsLite()
  const tts = useQuickTts('copywrite', settings)
  const sentences = React.useMemo(() => splitSentences(content), [content])
  const [idx, setIdx] = React.useState(0)
  const [input, setInput] = React.useState('')
  const [showOriginal, setShowOriginal] = React.useState(true)
  const [result, setResult] = React.useState<CopywriteResult | null>(null)

  const current = sentences[idx] ?? ''

  React.useEffect(() => {
    setIdx(0)
    setInput('')
    setResult(null)
    setShowOriginal(true)
  }, [content])

  React.useEffect(() => {
    // 切换句子时停止上一句的朗读
    tts.stop()
  }, [idx])

  const handleCheck = () => {
    if (!input.trim()) {
      toast.error('请先默写内容')
      return
    }
    const score = Math.round(similarity(current, input) * 100)
    // char-level diff: chars in original missing from typed (multiset)
    const orig = Array.from(normalize(current))
    const typed = Array.from(normalize(input))
    const typedCount = new Map<string, number>()
    for (const ch of typed) typedCount.set(ch, (typedCount.get(ch) ?? 0) + 1)
    const missed: string[] = []
    for (const ch of orig) {
      const c = typedCount.get(ch) ?? 0
      if (c > 0) typedCount.set(ch, c - 1)
      else missed.push(ch)
    }
    setResult({ score, missed })
    if (score >= 90) toast.success(`几乎全对！相似度 ${score}%`)
    else if (score >= 70) toast.info(`相似度 ${score}%，还有 ${missed.length} 个字漏掉了`)
    else toast.warning(`相似度 ${score}%，对照原文再练一遍吧`)
  }

  const go = (delta: number) => {
    setIdx((i) => Math.min(sentences.length - 1, Math.max(0, i + delta)))
    setInput('')
    setResult(null)
  }

  if (sentences.length === 0) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">内容为空，无法摹写</div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* progress */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          第 {idx + 1} / {sentences.length} 句
        </span>
        <div className="flex gap-1">
          {sentences.map((_, i) => (
            <span
              key={i}
              className={cn(
                'h-1.5 w-4 rounded-full transition-colors',
                i === idx ? 'bg-emerald-600' : i < idx ? 'bg-emerald-600/40' : 'bg-muted',
              )}
            />
          ))}
        </div>
      </div>

      {/* original toggle */}
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">默写这一句</p>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground"
          onClick={() => setShowOriginal((v) => !v)}
        >
          {showOriginal ? (
            <>
              <EyeOff className="size-3.5" /> 隐藏原文
            </>
          ) : (
            <>
              <Eye className="size-3.5" /> 显示原文
            </>
          )}
        </Button>
      </div>

      {showOriginal ? (
        <div className="rounded-2xl border border-border bg-card px-5 py-5 text-center shadow-sm">
          <p className="text-lg font-medium leading-loose">{current}</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-border px-5 py-5 text-center text-sm text-muted-foreground">
          原文已隐藏，凭记忆默写吧
        </div>
      )}

      {/* 朗读这句 + 音色/倍速选择（可设为默认） */}
      <div className="flex items-center justify-between gap-2">
        <VoiceSpeedBar context="copywrite" pref={tts.pref} onChange={tts.setPref} />
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 rounded-full text-xs"
          disabled={!current.trim()}
          onClick={() => (tts.speaking ? tts.stop() : tts.speak(current))}
        >
          {tts.speaking ? (
            <Square className="size-3.5" />
          ) : (
            <Volume2 className="size-3.5" />
          )}
          {tts.speaking ? '停止朗读' : '朗读这句'}
        </Button>
      </div>

      <Textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="在此默写这句话…"
        className="min-h-28 resize-none rounded-2xl bg-muted/30 leading-relaxed"
      />

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          className="size-11 shrink-0 rounded-full"
          aria-label="上一句"
          disabled={idx <= 0}
          onClick={() => go(-1)}
        >
          <ChevronLeft className="size-5" strokeWidth={1.75} />
        </Button>
        <Button
          className="h-11 flex-1 rounded-full bg-emerald-600 text-white hover:bg-emerald-700"
          onClick={handleCheck}
          disabled={!input.trim()}
        >
          <Check className="size-4" strokeWidth={1.75} />
          检查
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-11 shrink-0 rounded-full"
          aria-label="下一句"
          disabled={idx >= sentences.length - 1}
          onClick={() => go(1)}
        >
          <ChevronRight className="size-5" strokeWidth={1.75} />
        </Button>
      </div>

      {/* result */}
      {result && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">默写相似度</span>
            <span
              className={cn(
                'text-2xl font-bold',
                result.score >= 90
                  ? 'text-emerald-600'
                  : result.score >= 70
                    ? 'text-amber-600'
                    : 'text-destructive',
              )}
            >
              {result.score}%
            </span>
          </div>
          {result.missed.length > 0 ? (
            <div className="mt-3">
              <p className="mb-1.5 text-xs text-muted-foreground">漏掉 / 写错的字：</p>
              <div className="flex flex-wrap gap-1.5">
                {result.missed.slice(0, 30).map((ch, i) => (
                  <span
                    key={i}
                    className="rounded-md bg-destructive/10 px-2 py-1 text-sm font-medium text-destructive"
                  >
                    {ch}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <p className="mt-3 flex items-center gap-1.5 text-sm text-emerald-600">
              <Check className="size-4" /> 一个字都没漏，太厉害了！
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            className="mt-3 w-full rounded-full"
            onClick={() => {
              setInput('')
              setResult(null)
            }}
          >
            <RotateCcw className="size-3.5" /> 重新默写
          </Button>
        </div>
      )}
    </div>
  )
}
