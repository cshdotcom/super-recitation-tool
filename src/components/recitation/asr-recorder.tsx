'use client'

import * as React from 'react'
import { Mic, Square, Loader2, RotateCcw, CheckCircle2, XCircle, Star } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import type { SettingsData, VoiceProvider } from '@/lib/types'
import { similarity, normalize } from '@/lib/cloze'
import { saveVoicePref } from '@/lib/voice-prefs'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// ---------- minimal local types for the Web Speech recognition API ----------
// (kept local so we don't depend on lib.dom SpeechRecognition typings)
interface SpeechRecognitionAlternativeLike {
  transcript: string
}

interface SpeechRecognitionResultLike {
  isFinal: boolean
  length: number
  [index: number]: SpeechRecognitionAlternativeLike
}

interface SpeechRecognitionResultListLike {
  length: number
  [index: number]: SpeechRecognitionResultLike
}

interface SpeechRecognitionEventLike {
  resultIndex: number
  results: SpeechRecognitionResultListLike
}

interface SpeechRecognitionErrorEventLike {
  error: string
}

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

// ---------------------------------------------------------------------------

interface AsrRecorderProps {
  originalText: string
  keywords: string[]
  settings: SettingsData
  /** Feature context key for per-context voice defaults (VOICE_CONTEXTS). */
  context?: string
}

interface AsrResult {
  text: string
  score: number
  missed: string[]
  matched: string[]
}

export function AsrRecorder({
  originalText,
  keywords,
  settings,
  context = 'asr',
}: AsrRecorderProps) {
  // Per-context ASR defaults captured once on mount (fall back to global).
  const [seeded] = React.useState(() => settings.voicePrefs?.[context]?.asr)
  const [provider, setProvider] = React.useState<VoiceProvider>(
    () => seeded?.provider ?? settings.asrProvider,
  )
  // Recognition language (browser provider): zh-CN / en-US / auto(中英混合).
  const [lang, setLang] = React.useState<string>(() => seeded?.lang ?? 'zh-CN')

  const [recording, setRecording] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [seconds, setSeconds] = React.useState(0)
  const [result, setResult] = React.useState<AsrResult | null>(null)

  // MediaRecorder flow (zai / custom providers)
  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null)
  const chunksRef = React.useRef<Blob[]>([])
  const streamRef = React.useRef<MediaStream | null>(null)

  // Browser SpeechRecognition flow (browser provider)
  const [supported, setSupported] = React.useState(false)
  const [interim, setInterim] = React.useState('')
  const recogRef = React.useRef<SpeechRecognitionLike | null>(null)
  const finalRef = React.useRef<string>('')
  const interimRef = React.useRef<string>('')
  const recordingRef = React.useRef<boolean>(false)
  const skipFinalizeRef = React.useRef<boolean>(false)

  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null)

  const clearTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  const cleanup = React.useCallback(() => {
    clearTimer()
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    mediaRecorderRef.current = null
    chunksRef.current = []
  }, [])

  const cleanupBrowser = React.useCallback(() => {
    const recog = recogRef.current
    if (recog) {
      // remove listeners then abort
      recog.onresult = null
      recog.onerror = null
      recog.onend = null
      try {
        recog.abort()
      } catch {
        /* ignore */
      }
      recogRef.current = null
    }
    clearTimer()
    finalRef.current = ''
    interimRef.current = ''
    setInterim('')
  }, [])

  React.useEffect(() => {
    return () => {
      cleanup()
      recordingRef.current = false
      cleanupBrowser()
    }
  }, [cleanup, cleanupBrowser])

  // Detect Web Speech recognition availability once (Firefox lacks it).
  React.useEffect(() => {
    setSupported(getRecognitionCtor() !== null)
  }, [])

  /** Shared scoring logic for all providers. */
  const finishWithText = React.useCallback(
    (raw: string, tid?: string | number) => {
      const text = raw.trim()
      if (!text) {
        toast.warning('未识别到内容，请靠近麦克风再试一次', tid ? { id: tid } : undefined)
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
      if (tid) toast.success(`识别完成 · 准确率 ${score}%`, { id: tid })
    },
    [originalText, keywords],
  )

  // ---------- server flow (zai / custom): MediaRecorder ----------
  const startServer = async () => {
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

  const stopServer = () => {
    const rec = mediaRecorderRef.current
    if (rec && rec.state !== 'inactive') {
      rec.stop()
    }
    setRecording(false)
    clearTimer()
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
      fd.append('provider', provider) // 'zai' | 'custom'
      const res = await fetch('/api/asr', { method: 'POST', body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '识别失败')
      }
      const data = (await res.json()) as { text: string }
      finishWithText(data.text || '', tid)
    } catch (err) {
      toast.error(
        '识别失败：' + (err instanceof Error ? err.message : '未知错误'),
        { id: tid },
      )
    } finally {
      setLoading(false)
    }
  }

  // ---------- browser flow: webkitSpeechRecognition ----------
  const startBrowser = () => {
    const Ctor = getRecognitionCtor()
    if (!Ctor) {
      toast.error('当前浏览器不支持语音识别，建议使用 Chrome / Edge 浏览器')
      return
    }
    if (!originalText.trim()) {
      toast.error('请先选择一张有内容的背书卡')
      return
    }
    finalRef.current = ''
    interimRef.current = ''
    setInterim('')
    setResult(null)
    setSeconds(0)
    skipFinalizeRef.current = false
    recordingRef.current = true

    const recog = new Ctor()
    recog.lang = lang === 'auto' ? '' : lang
    recog.continuous = true
    recog.interimResults = true
    recog.maxAlternatives = 1

    recog.onresult = (e) => {
      let interimText = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        const t = r[0]?.transcript ?? ''
        if (r.isFinal) finalRef.current += t
        else interimText += t
      }
      interimRef.current = interimText
      setInterim(interimText)
    }

    recog.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        recordingRef.current = false
        skipFinalizeRef.current = true
        toast.error('未授予麦克风权限，请在浏览器中允许后重试')
      } else if (e.error === 'no-speech') {
        toast.warning('没有检测到语音，请靠近麦克风再说一次')
      } else if (e.error !== 'aborted') {
        toast.error('识别出错：' + e.error)
      }
    }

    recog.onend = () => {
      if (recordingRef.current) {
        // Chrome auto-stops after silence — restart to keep listening.
        try {
          recog.start()
        } catch {
          /* ignore */
        }
        return
      }
      if (skipFinalizeRef.current) {
        skipFinalizeRef.current = false
        cleanupBrowser()
        return
      }
      // manual stop → assemble final transcript and score it
      const raw = (finalRef.current + interimRef.current).trim()
      cleanupBrowser()
      finishWithText(raw)
    }

    try {
      recog.start()
    } catch (err) {
      recordingRef.current = false
      toast.error(
        '无法启动语音识别：' +
          (err instanceof Error ? err.message : '未知错误'),
      )
      return
    }
    recogRef.current = recog
    setRecording(true)
    timerRef.current = setInterval(() => {
      setSeconds((s) => s + 1)
    }, 1000)
  }

  const stopBrowser = () => {
    recordingRef.current = false
    const recog = recogRef.current
    if (recog) {
      try {
        recog.stop()
      } catch {
        /* ignore */
      }
    }
    setRecording(false)
    clearTimer()
  }

  const startRecording = () => {
    if (provider === 'browser') startBrowser()
    else startServer()
  }

  const stopRecording = () => {
    if (provider === 'browser') stopBrowser()
    else stopServer()
  }

  const engineLabel =
    provider === 'zai'
      ? '识别引擎：z-ai'
      : provider === 'custom'
        ? '识别引擎：第三方API'
        : '识别引擎：浏览器内置'

  const browserUnavailable = provider === 'browser' && !supported

  const handleSaveDefault = () => {
    void saveVoicePref(context, {
      asr: {
        provider,
        ...(provider === 'browser' ? { lang } : {}),
      },
    })
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
      {/* provider + language pickers */}
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/30 p-3">
        <div className="flex items-center gap-2">
          <Label className="shrink-0 text-xs text-muted-foreground">识别引擎</Label>
          <Select value={provider} onValueChange={(v) => setProvider(v as VoiceProvider)}>
            <SelectTrigger className="h-8 flex-1 rounded-lg text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zai">AI云端（z-ai）</SelectItem>
              <SelectItem value="custom">第三方 API</SelectItem>
              <SelectItem value="browser">浏览器内置</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {provider === 'browser' && (
          <div className="flex items-center gap-2">
            <Label className="shrink-0 text-xs text-muted-foreground">换语言</Label>
            <Select value={lang} onValueChange={setLang}>
              <SelectTrigger className="h-8 flex-1 rounded-lg text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="zh-CN">中文普通话</SelectItem>
                <SelectItem value="en-US">English (US)</SelectItem>
                <SelectItem value="auto">中英混合（自动）</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={handleSaveDefault}
          className="h-7 w-full rounded-full text-xs text-muted-foreground"
        >
          <Star className="size-3" /> 设为默认
        </Button>
      </div>

      <div className="flex flex-col items-center gap-3 py-4">
        {!browserUnavailable ? (
          <>
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
            <div className="text-xs text-muted-foreground">{engineLabel}</div>
            {recording && provider === 'browser' && (
              <div className="min-h-10 w-full rounded-md border bg-muted/30 p-2 text-xs leading-relaxed text-muted-foreground">
                {interim || '聆听中…'}
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center gap-1.5 py-8 text-center">
            <Mic className="size-8 text-muted-foreground/40" />
            <div className="text-sm text-muted-foreground">
              当前浏览器不支持内置语音识别
            </div>
            <div className="text-xs text-muted-foreground">
              建议使用 Chrome / Edge 浏览器，或在设置中将识别引擎切换为 z-ai /
              自定义 API
            </div>
          </div>
        )}
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
