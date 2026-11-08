'use client'

// VoiceInput — 通用语音输入按钮，可插入任何输入框（AI问问/督背、简答题
// 作答、自定义知识点、搜索框、笔记、编辑器等）。
// 双引擎：跟随设置里的 ASR Provider ——
//   • zai / custom  → MediaRecorder 录音 → POST /api/asr 云端识别
//   • browser       → webkitSpeechRecognition 实时转写（显示中间结果）
// 全局同一时间只允许一个按钮录音（模块级 activeStopRef 互斥）。
import * as React from 'react'
import { Loader2, Mic, Square } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { useSettingsLite } from '@/lib/voice-prefs'

// ---------- minimal Web Speech typings (local) ----------
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

/** 服务器识别模式的最长录音时长（自动停止并送识别）。 */
const MAX_SECONDS = 60

/** 模块级互斥：当前正在录音的按钮的“停止函数”。 */
const activeStopRef: { current: (() => void) | null } = { current: null }

export interface VoiceInputProps {
  /** 识别完成后的文本回调（由调用方决定追加/替换/提交）。 */
  onText: (text: string) => void
  /** 语音偏好上下文 key（读取该功能默认引擎/语言）。 */
  context?: string
  disabled?: boolean
  /** 视觉尺寸：sm = size-8（紧凑输入条），md = size-9（默认）。 */
  size?: 'sm' | 'md'
  variant?: 'ghost' | 'outline'
  className?: string
  'aria-label'?: string
}

export function VoiceInput({
  onText,
  context = 'voice-input',
  disabled = false,
  size = 'md',
  variant = 'ghost',
  className,
  ...rest
}: VoiceInputProps) {
  const settings = useSettingsLite()
  const [recording, setRecording] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [seconds, setSeconds] = React.useState(0)
  const [interim, setInterim] = React.useState('')

  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null)
  const chunksRef = React.useRef<Blob[]>([])
  const streamRef = React.useRef<MediaStream | null>(null)
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null)
  const recogRef = React.useRef<SpeechRecognitionLike | null>(null)
  const finalRef = React.useRef('')
  const interimRef = React.useRef('')
  const keepAliveRef = React.useRef(false)
  const stoppedRef = React.useRef(false)

  const provider =
    settings?.voicePrefs?.[context]?.asr?.provider ??
    settings?.asrProvider ??
    'zai'
  const lang =
    settings?.voicePrefs?.[context]?.asr?.lang ?? 'zh-CN'

  const clearTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  const teardown = React.useCallback(() => {
    clearTimer()
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    mediaRecorderRef.current = null
    chunksRef.current = []
    const recog = recogRef.current
    if (recog) {
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
    finalRef.current = ''
    interimRef.current = ''
    setInterim('')
    setRecording(false)
    setSeconds(0)
    activeStopRef.current = null
  }, [])

  React.useEffect(() => {
    return () => {
      // 卸载时若仍在录音则彻底清理
      teardown()
    }
  }, [teardown])

  const startTimer = () => {
    setSeconds(0)
    timerRef.current = setInterval(() => {
      setSeconds((s) => {
        if (s + 1 >= MAX_SECONDS) {
          // 到达上限自动停止
          setTimeout(() => stopAll(), 0)
        }
        return s + 1
      })
    }, 1000)
  }

  // ---------- server flow ----------
  const startServer = async () => {
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
      recorder.onstop = handleServerStop
      recorder.start()
      mediaRecorderRef.current = recorder
      setRecording(true)
      startTimer()
    } catch (err) {
      if (
        err instanceof DOMException &&
        (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
      ) {
        toast.error('未授予麦克风权限，请在浏览器中允许后重试')
      } else {
        toast.error('无法访问麦克风：' + (err instanceof Error ? err.message : '未知错误'))
      }
      teardown()
    }
  }

  const handleServerStop = async () => {
    const mimeType = mediaRecorderRef.current?.mimeType || 'audio/webm'
    const blob = new Blob(chunksRef.current, { type: mimeType })
    const hadRecording = blob.size > 0
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    mediaRecorderRef.current = null
    chunksRef.current = []
    clearTimer()
    setRecording(false)
    activeStopRef.current = null
    if (!hadRecording) {
      toast.warning('录音内容为空')
      return
    }
    setLoading(true)
    const tid = toast.loading('正在识别语音…')
    try {
      const fd = new FormData()
      fd.append('file', blob, 'voice-input.webm')
      fd.append('provider', provider)
      const res = await fetch('/api/asr', { method: 'POST', body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error((err as { error?: string }).error || '识别失败')
      }
      const data = (await res.json()) as { text: string }
      const text = (data.text || '').trim()
      if (!text) {
        toast.warning('未识别到内容，请靠近麦克风再试一次', { id: tid })
      } else {
        toast.success('语音识别完成', { id: tid })
        onText(text)
      }
    } catch (err) {
      toast.error(
        '识别失败：' + (err instanceof Error ? err.message : '未知错误'),
        { id: tid },
      )
    } finally {
      setLoading(false)
    }
  }

  // ---------- browser flow ----------
  const startBrowser = () => {
    const Ctor = getRecognitionCtor()
    if (!Ctor) {
      toast.error('当前浏览器不支持语音识别，可在设置中切换为 z-ai 引擎')
      return
    }
    finalRef.current = ''
    interimRef.current = ''
    stoppedRef.current = false
    keepAliveRef.current = true
    const recog = new Ctor()
    recog.lang = lang === 'auto' ? '' : lang
    recog.continuous = true
    recog.interimResults = true
    recog.maxAlternatives = 1
    recog.onresult = (e) => {
      let it = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        const t = r[0]?.transcript ?? ''
        if (r.isFinal) finalRef.current += t
        else it += t
      }
      interimRef.current = it
      setInterim(it)
    }
    recog.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        keepAliveRef.current = false
        toast.error('未授予麦克风权限，请在浏览器中允许后重试')
        teardown()
      } else if (e.error === 'no-speech') {
        toast.warning('没有检测到语音，请靠近麦克风再说一次')
      } else if (e.error !== 'aborted') {
        toast.error('识别出错：' + e.error)
      }
    }
    recog.onend = () => {
      if (keepAliveRef.current) {
        try {
          recog.start()
        } catch {
          /* ignore */
        }
        return
      }
      if (stoppedRef.current) {
        const raw = (finalRef.current + interimRef.current).trim()
        recogRef.current = null
        teardown()
        if (raw) onText(raw)
        else toast.warning('未识别到内容，请靠近麦克风再试一次')
      }
    }
    try {
      recog.start()
    } catch (err) {
      keepAliveRef.current = false
      toast.error(
        '无法启动语音识别：' + (err instanceof Error ? err.message : '未知错误'),
      )
      return
    }
    recogRef.current = recog
    setRecording(true)
    startTimer()
  }

  const startAll = () => {
    if (activeStopRef.current) activeStopRef.current() // 互斥：先停掉别处的录音
    setInterim('')
    if (provider === 'browser') startBrowser()
    else void startServer()
  }

  const stopAll = () => {
    if (provider === 'browser') {
      stoppedRef.current = true
      keepAliveRef.current = false
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
      activeStopRef.current = null
    } else {
      const rec = mediaRecorderRef.current
      if (rec && rec.state !== 'inactive') {
        rec.stop() // onstop -> handleServerStop
      } else {
        teardown()
      }
    }
  }

  // 把停止函数注册到模块级互斥锁
  React.useEffect(() => {
    if (recording) {
      activeStopRef.current = stopAll
    }
  }, [recording, stopAll])

  const box = size === 'sm' ? 'size-8' : 'size-9'

  return (
    <div className={cn('relative flex flex-col items-center', className)}>
      {(recording || loading) && (
        <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-max max-w-[240px] -translate-x-1/2 rounded-xl border border-border bg-popover px-3 py-2 text-left shadow-lg">
          <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
            <span className="size-1.5 animate-pulse rounded-full bg-destructive" />
            {loading ? '识别中…' : `录音中 ${seconds}s · 点击停止`}
          </div>
          {recording && provider === 'browser' && (
            <div className="mt-1 max-h-16 overflow-y-auto text-xs leading-relaxed text-muted-foreground">
              {interim || '聆听中…'}
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={recording ? stopAll : startAll}
        disabled={disabled || loading}
        aria-label={rest['aria-label'] || (recording ? '停止语音输入' : '语音输入')}
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full transition-colors',
          box,
          recording
            ? 'bg-destructive text-white shadow-md shadow-destructive/30'
            : variant === 'outline'
              ? 'border border-border text-muted-foreground hover:border-emerald-500/60 hover:text-emerald-600'
              : 'text-muted-foreground hover:bg-accent hover:text-emerald-600',
          disabled && 'pointer-events-none opacity-50',
        )}
      >
        {loading ? (
          <Loader2 className={size === 'sm' ? 'size-3.5 animate-spin' : 'size-4 animate-spin'} />
        ) : recording ? (
          <Square className={size === 'sm' ? 'size-3.5' : 'size-4'} />
        ) : (
          <Mic className={size === 'sm' ? 'size-4' : 'size-4.5'} strokeWidth={1.9} />
        )}
      </button>
    </div>
  )
}
