'use client'

import * as React from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Mic,
  Square,
  Volume2,
} from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { similarity } from '@/lib/cloze'
import { splitSentences } from '@/lib/sentences'
import { useSettingsLite } from '@/lib/voice-prefs'
import { useQuickTts, VoiceSpeedBar } from '@/components/recitation/tts-player'
import { Button } from '@/components/ui/button'

interface EarbackPanelProps {
  content: string
}

interface EarbackResult {
  text: string
  score: number
}

// 耳返背书：逐句朗读 + 跟读对比打分
export function EarbackPanel({ content }: EarbackPanelProps) {
  const settings = useSettingsLite()
  const tts = useQuickTts('earback', settings)
  const sentences = React.useMemo(() => splitSentences(content), [content])
  const [idx, setIdx] = React.useState(0)
  const [recording, setRecording] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [result, setResult] = React.useState<EarbackResult | null>(null)

  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null)
  const chunksRef = React.useRef<Blob[]>([])
  const streamRef = React.useRef<MediaStream | null>(null)

  const current = sentences[idx] ?? ''

  React.useEffect(() => {
    setIdx(0)
    setResult(null)
  }, [content])

  // cleanup media on unmount
  React.useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  const handleSpeak = () => {
    if (!current.trim()) return
    if (tts.speaking) {
      tts.stop()
      return
    }
    tts.speak(current)
  }

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    mediaRecorderRef.current = null
    chunksRef.current = []
  }

  const startRecording = async () => {
    setResult(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
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
    } catch (err) {
      if (
        err instanceof DOMException &&
        (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
      ) {
        toast.error('未授予麦克风权限，请在浏览器中允许后重试')
      } else {
        toast.error('无法访问麦克风：' + (err instanceof Error ? err.message : '未知错误'))
      }
      stopStream()
    }
  }

  const stopRecording = () => {
    const rec = mediaRecorderRef.current
    if (rec && rec.state !== 'inactive') rec.stop()
    setRecording(false)
  }

  const handleStop = async () => {
    setLoading(true)
    const tid = toast.loading('正在识别你的跟读…')
    const mimeType = mediaRecorderRef.current?.mimeType || 'audio/webm'
    const blob = new Blob(chunksRef.current, { type: mimeType })
    stopStream()
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
      const data = (await res.json()) as { text?: string }
      const text = (data.text || '').trim()
      if (!text) {
        toast.warning('未识别到内容，请再试一次', { id: tid })
        setLoading(false)
        return
      }
      const score = Math.round(similarity(current, text) * 100)
      setResult({ text, score })
      if (score >= 80) toast.success(`太棒了！相似度 ${score}%`, { id: tid })
      else if (score >= 60) toast.info(`不错，相似度 ${score}%，再试试`, { id: tid })
      else toast.warning(`相似度 ${score}%，跟着语音再多读几遍`, { id: tid })
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

  if (sentences.length === 0) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        内容为空，无法耳返背书
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
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

      {/* current sentence */}
      <div className="rounded-2xl border border-border bg-card px-5 py-6 text-center shadow-sm">
        <p className="text-xl font-medium leading-loose">{current}</p>
      </div>

      {/* voice + speed picker (音色/倍速，可设为默认) */}
      <div className="flex justify-center">
        <VoiceSpeedBar context="earback" pref={tts.pref} onChange={tts.setPref} />
      </div>

      {/* controls */}
      <div className="flex items-center justify-center gap-6">
        <Button
          variant="outline"
          size="icon"
          className="size-11 rounded-full"
          aria-label="上一句"
          disabled={idx <= 0 || recording || loading}
          onClick={() => {
            setResult(null)
            setIdx((i) => Math.max(0, i - 1))
          }}
        >
          <ChevronLeft className="size-5" strokeWidth={1.75} />
        </Button>

        <Button
          className="h-11 flex-1 rounded-full bg-emerald-600 text-white hover:bg-emerald-700"
          onClick={handleSpeak}
          disabled={recording || loading}
        >
          {tts.speaking ? (
            <Square className="size-4" />
          ) : (
            <Volume2 className="size-4" strokeWidth={1.75} />
          )}
          {tts.speaking ? '停止朗读' : '朗读这句'}
        </Button>

        <button
          type="button"
          aria-label={recording ? '停止跟读' : '开始跟读'}
          disabled={loading}
          onClick={recording ? stopRecording : () => void startRecording()}
          className={cn(
            'flex size-14 shrink-0 items-center justify-center rounded-full transition-all',
            recording
              ? 'animate-pulse bg-destructive text-white shadow-lg shadow-destructive/30'
              : 'bg-zinc-700 text-white shadow-lg hover:bg-zinc-600',
          )}
        >
          {recording ? <Square className="size-5" /> : <Mic className="size-5" strokeWidth={1.75} />}
        </button>

        <Button
          variant="outline"
          size="icon"
          className="size-11 rounded-full"
          aria-label="下一句"
          disabled={idx >= sentences.length - 1 || recording || loading}
          onClick={() => {
            setResult(null)
            setIdx((i) => Math.min(sentences.length - 1, i + 1))
          }}
        >
          <ChevronRight className="size-5" strokeWidth={1.75} />
        </Button>
      </div>

      <p className="text-center text-xs text-muted-foreground">
        {recording
          ? '录音中… 再次点击麦克风结束'
          : loading
            ? '识别中…'
            : tts.speaking
              ? '正在朗读，可点击停止'
              : '先听朗读，再点麦克风跟读这句话'}
      </p>

      {/* result */}
      {result && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">跟读相似度</span>
            <span className={cn('text-2xl font-bold', scoreColor)}>{result.score}%</span>
          </div>
          <div className="mt-2 rounded-xl bg-muted/40 p-3 text-sm leading-relaxed">
            <span className="text-xs text-muted-foreground">识别结果：</span>
            {result.text}
          </div>
          {result.score < 80 && (
            <Button
              variant="outline"
              size="sm"
              className="mt-3 w-full rounded-full"
              onClick={() => setResult(null)}
            >
              再跟读一次
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
