'use client'

import * as React from 'react'
import { Mic, Square, Loader2, RotateCcw, CheckCircle2, XCircle } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { similarity, normalize } from '@/lib/cloze'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

interface AsrRecorderProps {
  originalText: string
  keywords: string[]
}

interface AsrResult {
  text: string
  score: number
  missed: string[]
  matched: string[]
}

export function AsrRecorder({ originalText, keywords }: AsrRecorderProps) {
  const [recording, setRecording] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [seconds, setSeconds] = React.useState(0)
  const [result, setResult] = React.useState<AsrResult | null>(null)

  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null)
  const chunksRef = React.useRef<Blob[]>([])
  const streamRef = React.useRef<MediaStream | null>(null)
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null)

  const cleanup = React.useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    mediaRecorderRef.current = null
    chunksRef.current = []
  }, [])

  React.useEffect(() => () => cleanup(), [cleanup])

  const startRecording = async () => {
    if (!originalText.trim()) {
      toast.error('请先选择一张有内容的背书卡')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      })
      streamRef.current = stream
      let recorder: MediaRecorder
      try {
        recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      } catch {
        recorder = new MediaRecorder(stream)
      }
      chunksRef.current = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = handleStop
      recorder.start()
      mediaRecorderRef.current = recorder
      setRecording(true)
      setResult(null)
      setSeconds(0)
      timerRef.current = setInterval(() => {
        setSeconds((s) => s + 1)
      }, 1000)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : '未知错误'
      if (
        err instanceof DOMException &&
        (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
      ) {
        toast.error('未授予麦克风权限，请在浏览器中允许后重试')
      } else {
        toast.error('无法访问麦克风：' + message)
      }
      cleanup()
    }
  }

  const stopRecording = () => {
    const rec = mediaRecorderRef.current
    if (rec && rec.state !== 'inactive') {
      rec.stop()
    }
    setRecording(false)
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  const handleStop = async () => {
    setLoading(true)
    const tid = toast.loading('正在识别语音…')
    const mimeType = mediaRecorderRef.current?.mimeType || 'audio/webm'
    const blob = new Blob(chunksRef.current, { type: mimeType })
    cleanup()
    if (blob.size === 0) {
      toast.error('录音内容为空', { id: tid })
      setLoading(false)
      return
    }
    try {
      const fd = new FormData()
      fd.append('file', blob, 'rec.webm')
      const res = await fetch('/api/asr', { method: 'POST', body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '识别失败')
      }
      const data = (await res.json()) as { text: string }
      const text = (data.text || '').trim()
      if (!text) {
        toast.warning('未识别到内容', { id: tid })
        setLoading(false)
        return
      }
      const score = Math.round(similarity(originalText, text) * 100)
      const normText = normalize(text)
      const missed: string[] = []
      const matched: string[] = []
      for (const k of keywords) {
        if (normText.includes(normalize(k))) matched.push(k)
        else missed.push(k)
      }
      setResult({ text, score, missed, matched })
      toast.success(`识别完成 · 准确率 ${score}%`, { id: tid })
    } catch (err) {
      toast.error(
        '识别失败：' + (err instanceof Error ? err.message : '未知错误'),
        { id: tid },
      )
    } finally {
      setLoading(false)
    }
  }

  const scoreColor =
    result == null
      ? ''
      : result.score >= 80
        ? 'text-emerald-600'
        : result.score >= 60
          ? 'text-amber-600'
          : 'text-destructive'

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-center gap-3 py-4">
        <button
          type="button"
          onClick={recording ? stopRecording : startRecording}
          disabled={loading}
          className={cn(
            'flex size-20 items-center justify-center rounded-full transition-all',
            recording
              ? 'bg-destructive text-white shadow-lg shadow-destructive/30'
              : 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/30 hover:bg-emerald-700',
            recording && 'animate-pulse',
          )}
          aria-label={recording ? '停止录音' : '开始录音'}
        >
          {loading ? (
            <Loader2 className="size-7 animate-spin" />
          ) : recording ? (
            <Square className="size-7" />
          ) : (
            <Mic className="size-7" />
          )}
        </button>
        <div className="text-sm text-muted-foreground">
          {recording
            ? `录音中… ${seconds}s（点击停止）`
            : loading
              ? '识别中…'
              : '点击麦克风开始背诵'}
        </div>
      </div>

      {result && (
        <div className="flex flex-col gap-3 rounded-lg border p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className={cn('text-3xl font-bold', scoreColor)}>
                {result.score}
                <span className="text-base font-normal">%</span>
              </div>
              <div className="text-xs text-muted-foreground">背诵准确率</div>
            </div>
            <div className="text-right">
              <div className="text-lg font-semibold">
                {result.matched.length}
                <span className="text-muted-foreground">
                  /{keywords.length}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">关键词掌握</div>
            </div>
          </div>

          {result.missed.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted-foreground">未掌握的关键词</div>
              <div className="flex flex-wrap gap-1">
                {result.missed.map((k) => (
                  <Badge
                    key={k}
                    variant="secondary"
                    className="bg-destructive/10 text-destructive"
                  >
                    <XCircle className="size-3" /> {k}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {result.matched.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-muted-foreground">已掌握的关键词</div>
              <div className="flex flex-wrap gap-1">
                {result.matched.slice(0, 12).map((k) => (
                  <Badge
                    key={k}
                    variant="secondary"
                    className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  >
                    <CheckCircle2 className="size-3" /> {k}
                  </Badge>
                ))}
                {result.matched.length > 12 && (
                  <span className="text-xs text-muted-foreground">
                    等 {result.matched.length} 个
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="rounded-md border bg-muted/30 p-3">
            <div className="mb-1 text-xs text-muted-foreground">你的背诵内容</div>
            <p className="max-h-40 overflow-y-auto text-sm leading-relaxed">
              {result.text}
            </p>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={startRecording}
            disabled={loading}
            className="w-full"
          >
            <RotateCcw className="size-3.5" /> 再录一次
          </Button>
        </div>
      )}

      {!originalText.trim() && (
        <div className="text-center text-xs text-muted-foreground">
          请先选择一张有内容的背书卡
        </div>
      )}
    </div>
  )
}
