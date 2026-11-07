'use client'

import * as React from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Play,
  Repeat,
  RotateCcw,
  Square,
  Timer,
  Volume2,
} from 'lucide-react'
import { toast } from 'sonner'

import type { SettingsData, VoiceProvider } from '@/lib/types'
import { TTS_VOICES } from '@/lib/types'
import { clampSpeed, SPEED_OPTIONS, saveVoicePref } from '@/lib/voice-prefs'
import { splitSentences } from '@/lib/sentences'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const CUSTOM_VOICE_KEY = 'tts-custom-voice'

/** Max chars per utterance — speechSynthesis silently drops long utterances. */
const MAX_CHUNK_LEN = 120

export interface TtsPlayerProps {
  text: string
  settings: SettingsData
  /** Feature context key for per-context voice defaults (VOICE_CONTEXTS). */
  context?: string
  /** Optional externally-driven 定时 minutes (non-null >0 starts the timer). */
  timerMinutes?: number | null
  /** Called when the timer reaches 0 (playback was stopped). */
  onTimerEnd?: () => void
}

/**
 * Split text into <=120-char chunks, preferring cuts at sentence punctuation.
 */
function splitSpeechChunks(text: string, maxLen = MAX_CHUNK_LEN): string[] {
  const chunks: string[] = []
  let buf = ''
  const push = () => {
    const t = buf.trim()
    if (t) chunks.push(t)
    buf = ''
  }
  for (const ch of text) {
    buf += ch
    if (/[。！？；!?;\n]/.test(ch) || buf.length >= maxLen) push()
  }
  push()
  return chunks
}

/** zh voices first, then alphabetical — stable & readable list. */
function sortVoices(a: SpeechSynthesisVoice, b: SpeechSynthesisVoice): number {
  const az = a.lang.toLowerCase().startsWith('zh') ? 0 : 1
  const bz = b.lang.toLowerCase().startsWith('zh') ? 0 : 1
  if (az !== bz) return az - bz
  return a.name.localeCompare(b.name)
}

/** Load system speechSynthesis voices (SSR-safe, refreshes on voiceschanged). */
function useBrowserVoices(active: boolean): SpeechSynthesisVoice[] {
  const [voices, setVoices] = React.useState<SpeechSynthesisVoice[]>([])
  React.useEffect(() => {
    if (!active) return
    const synth = window.speechSynthesis
    if (!synth) return
    const load = () => {
      const vs = synth.getVoices()
      if (vs.length > 0) setVoices([...vs].sort(sortVoices))
    }
    load()
    synth.addEventListener('voiceschanged', load)
    return () => {
      synth.removeEventListener('voiceschanged', load)
    }
  }, [active])
  return voices
}

function formatMMSS(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function TtsPlayer({
  text,
  settings,
  context = 'tts',
  timerMinutes = null,
  onTimerEnd,
}: TtsPlayerProps) {
  // Voice defaults for this context, captured once on mount.
  const [seeded] = React.useState(() => settings.voicePrefs?.[context]?.tts)

  // ---- shared ----
  const [provider, setProvider] = React.useState<VoiceProvider>(
    () => seeded?.provider ?? settings.ttsProvider,
  )
  const [speed, setSpeed] = React.useState<number>(() => clampSpeed(seeded?.speed ?? 1))
  const audioRef = React.useRef<HTMLAudioElement>(null)
  const audioUrlRef = React.useRef<string | null>(null)
  const audioTextRef = React.useRef<string | null>(null)
  const [audioUrl, setAudioUrl] = React.useState<string | null>(null)
  const [audioPlaying, setAudioPlaying] = React.useState(false)
  const [loading, setLoading] = React.useState(false)

  // ---- zai / custom ----
  const [voice, setVoice] = React.useState<string>(() => {
    if (seeded?.provider === 'zai' && seeded.voice && TTS_VOICES.some((v) => v.value === seeded.voice)) {
      return seeded.voice
    }
    return 'tongtong'
  })
  const [customVoice, setCustomVoice] = React.useState('')

  // ---- browser ----
  const [voiceURI, setVoiceURI] = React.useState<string>(
    () => (seeded?.provider === 'browser' ? seeded.voiceURI ?? '' : ''),
  )
  const voices = useBrowserVoices(provider === 'browser')
  const [speaking, setSpeaking] = React.useState(false)
  const speechGenRef = React.useRef(0)

  // ---- sentence navigation / loop ----
  const sentences = React.useMemo(() => splitSentences(text), [text])
  const [sentenceIdx, setSentenceIdx] = React.useState(0)
  const [loop, setLoop] = React.useState(false)
  const loopRef = React.useRef(loop)
  React.useEffect(() => {
    loopRef.current = loop
  }, [loop])

  // ---- 定时停止 timer ----
  const [timerTotal, setTimerTotal] = React.useState<number | null>(null)
  const [timerLeft, setTimerLeft] = React.useState<number | null>(null)
  const timerIvRef = React.useRef<ReturnType<typeof setInterval> | null>(null)
  const timerLeftRef = React.useRef(0)
  const onTimerEndRef = React.useRef(onTimerEnd)
  React.useEffect(() => {
    onTimerEndRef.current = onTimerEnd
  }, [onTimerEnd])

  // Restore persisted custom voice (SSR-safe); context pref wins.
  React.useEffect(() => {
    const stored = localStorage.getItem(CUSTOM_VOICE_KEY) || ''
    setCustomVoice(
      seeded?.provider === 'custom' && seeded.voice ? seeded.voice : stored,
    )
  }, [seeded])

  // Reset sentence pointer when the text changes.
  React.useEffect(() => {
    setSentenceIdx(0)
  }, [text])

  const clearTimerIv = React.useCallback(() => {
    if (timerIvRef.current) {
      clearInterval(timerIvRef.current)
      timerIvRef.current = null
    }
  }, [])

  // Stop every playback channel (audio element + browser speech).
  const stopAllPlayback = React.useCallback(() => {
    speechGenRef.current += 1
    window.speechSynthesis?.cancel()
    audioRef.current?.pause()
    setAudioPlaying(false)
    setSpeaking(false)
  }, [])

  const startTimer = React.useCallback(
    (minutes: number) => {
      clearTimerIv()
      const total = Math.max(1, Math.round(minutes * 60))
      timerLeftRef.current = total
      setTimerTotal(total)
      setTimerLeft(total)
      timerIvRef.current = setInterval(() => {
        timerLeftRef.current -= 1
        setTimerLeft(timerLeftRef.current)
        if (timerLeftRef.current <= 0) {
          clearTimerIv()
          stopAllPlayback()
          setTimerTotal(null)
          setTimerLeft(null)
          toast.info('定时朗读时间到，已停止播放')
          onTimerEndRef.current?.()
        }
      }, 1000)
    },
    [clearTimerIv, stopAllPlayback],
  )

  const cancelTimer = React.useCallback(() => {
    clearTimerIv()
    setTimerTotal(null)
    setTimerLeft(null)
  }, [clearTimerIv])

  // External timer control (optional prop).
  const lastPropTimerRef = React.useRef<number | null | undefined>(undefined)
  React.useEffect(() => {
    if (timerMinutes === lastPropTimerRef.current) return
    lastPropTimerRef.current = timerMinutes
    if (typeof timerMinutes === 'number' && timerMinutes > 0) startTimer(timerMinutes)
  }, [timerMinutes, startTimer])

  // Cleanup timers / speech / audio blob URL on unmount.
  React.useEffect(() => {
    return () => {
      clearTimerIv()
      speechGenRef.current += 1
      window.speechSynthesis?.cancel()
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
    }
  }, [clearTimerIv])

  // Keep audio playbackRate in sync with the speed chips (live 倍速播放调整).
  React.useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = speed
    }
  }, [speed, audioUrl])

  // Default to the first zh voice once the list arrives (pref voiceURI wins).
  React.useEffect(() => {
    if (provider !== 'browser') return
    if (voices.length === 0) return
    if (voiceURI && voices.some((v) => v.voiceURI === voiceURI)) return
    const zh = voices.find((v) => v.lang.toLowerCase().startsWith('zh'))
    setVoiceURI((zh ?? voices[0]).voiceURI)
  }, [voices, provider, voiceURI])

  // Cancel any browser speech on provider switch.
  React.useEffect(() => {
    speechGenRef.current += 1
    window.speechSynthesis?.cancel()
    setSpeaking(false)
  }, [provider])

  const targetText = React.useMemo(
    () => sentences.slice(sentenceIdx).join(''),
    [sentences, sentenceIdx],
  )

  // ---- server synthesis (zai / custom) ----
  const generateFrom = async (fromIdx: number) => {
    const target = sentences.slice(fromIdx).join('')
    if (!target.trim()) {
      toast.error('没有可朗读的内容')
      return
    }
    setLoading(true)
    const tid = toast.loading('正在生成语音…')
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: target,
          voice: provider === 'custom' ? customVoice.trim() || undefined : voice,
          speed,
          provider,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '生成语音失败')
      }
      const blob = await res.blob()
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
      const url = URL.createObjectURL(blob)
      audioUrlRef.current = url
      audioTextRef.current = target
      setAudioUrl(url)
      toast.success('语音已生成', { id: tid })
      // auto-play after state updates
      setTimeout(() => {
        if (audioRef.current) {
          audioRef.current.playbackRate = speed
          audioRef.current.play().catch(() => {
            /* autoplay blocked; user uses controls */
          })
        }
      }, 80)
    } catch (err) {
      toast.error(
        '语音生成失败：' + (err instanceof Error ? err.message : '未知错误'),
        { id: tid },
      )
    } finally {
      setLoading(false)
    }
  }

  // ---- browser synthesis (Web Speech API) ----
  const speakBrowser = (fromIdx: number) => {
    const synth = window.speechSynthesis
    if (!synth) {
      toast.error('当前浏览器不支持语音合成，请使用 Chrome / Edge')
      return
    }
    const rest = sentences.slice(fromIdx).join('')
    if (!rest.trim()) {
      toast.error('没有可朗读的内容')
      return
    }
    const chunks = splitSpeechChunks(rest)
    if (chunks.length === 0) {
      toast.error('没有可朗读的内容')
      return
    }
    synth.cancel()
    const gen = ++speechGenRef.current
    const selected = voices.find((v) => v.voiceURI === voiceURI) ?? null
    chunks.forEach((chunk, i) => {
      const u = new SpeechSynthesisUtterance(chunk)
      if (selected) {
        u.voice = selected
        u.lang = selected.lang
      } else {
        u.lang = 'zh-CN'
      }
      u.rate = speed
      u.pitch = 1
      if (i === chunks.length - 1) {
        u.onend = () => {
          if (speechGenRef.current !== gen) return
          if (loopRef.current) {
            // 本书循环：回到第一句继续朗读
            setSentenceIdx(0)
            speakBrowser(0)
            return
          }
          setSpeaking(false)
        }
        u.onerror = () => {
          if (speechGenRef.current === gen) setSpeaking(false)
        }
      }
      synth.speak(u)
    })
    setSpeaking(true)
  }

  const stopBrowser = () => {
    speechGenRef.current += 1 // invalidate old onend handlers
    window.speechSynthesis?.cancel()
    setSpeaking(false)
  }

  // ---- sentence navigation ----
  const jumpSentence = (delta: number) => {
    const next = Math.min(sentences.length - 1, Math.max(0, sentenceIdx + delta))
    if (next === sentenceIdx) return
    setSentenceIdx(next)
    if (provider === 'browser') {
      if (speaking) speakBrowser(next)
    } else if (audioPlaying || loading) {
      // 朗读中跳句：从新句子重新生成并继续播放
      void generateFrom(next)
    }
  }

  // ---- main button: 朗读全文 / 停止 ----
  const handleMain = () => {
    if (provider === 'browser') {
      if (speaking) stopBrowser()
      else speakBrowser(sentenceIdx)
      return
    }
    if (audioPlaying) {
      audioRef.current?.pause()
      return
    }
    if (audioUrl && audioTextRef.current === targetText) {
      // replay the already generated audio for the same text
      audioRef.current?.play().catch(() => {
        /* ignore */
      })
      return
    }
    void generateFrom(sentenceIdx)
  }

  // ---- 设为默认（保存该功能的音色/倍速） ----
  const handleSaveDefault = () => {
    void saveVoicePref(context, {
      tts: {
        provider,
        voice:
          provider === 'browser'
            ? ''
            : provider === 'custom'
              ? customVoice.trim()
              : voice,
        speed,
        ...(provider === 'browser' ? { voiceURI } : {}),
      },
    })
  }

  const isStop =
    provider === 'browser' ? speaking : audioPlaying && !loading

  const footerHint =
    provider === 'zai'
      ? '语音由 z-ai SDK 合成'
      : provider === 'custom'
        ? '语音由第三方 API 合成'
        : '浏览器系统语音合成'

  const voiceShortLabel =
    provider === 'zai'
      ? TTS_VOICES.find((v) => v.value === voice)?.label.split('·')[0]?.trim() ?? '童童'
      : provider === 'custom'
        ? customVoice.trim() || '自定义音色'
        : voices.find((v) => v.voiceURI === voiceURI)?.name ?? '系统语音'

  return (
    <div className="flex flex-col gap-4">
      {/* provider picker */}
      <div className="flex flex-col gap-2">
        <Label className="text-sm">朗读引擎</Label>
        <Select value={provider} onValueChange={(v) => setProvider(v as VoiceProvider)}>
          <SelectTrigger className="h-9 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="zai">AI云端（z-ai）</SelectItem>
            <SelectItem value="custom">第三方 API</SelectItem>
            <SelectItem value="browser">浏览器语音</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* voice picker */}
      {provider === 'zai' && (
        <div className="flex flex-col gap-2">
          <Label className="text-sm">音色</Label>
          <Select value={voice} onValueChange={setVoice}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TTS_VOICES.map((v) => (
                <SelectItem key={v.value} value={v.value}>
                  {v.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {provider === 'custom' && (
        <div className="flex flex-col gap-2">
          <Label className="text-sm">音色</Label>
          <Input
            value={customVoice}
            onChange={(e) => setCustomVoice(e.target.value)}
            placeholder="音色名，如 alloy / nova / 清心"
          />
        </div>
      )}

      {provider === 'browser' && (
        <div className="flex flex-col gap-2">
          <Label className="text-sm">系统语音</Label>
          {voices.length > 0 ? (
            <Select value={voiceURI} onValueChange={setVoiceURI}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择系统语音" />
              </SelectTrigger>
              <SelectContent>
                {voices.map((v) => (
                  <SelectItem key={v.voiceURI} value={v.voiceURI}>
                    {v.name} ({v.lang})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="text-xs text-muted-foreground">
              正在加载系统语音列表…
            </div>
          )}
        </div>
      )}

      {/* speed chips */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label className="text-sm">倍速</Label>
          <span className="text-xs text-muted-foreground">
            {voiceShortLabel} · {speed.toFixed(speed === Math.floor(speed) ? 1 : 2)}x
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="倍速选择">
          {SPEED_OPTIONS.map((s) => {
            const active = Math.abs(speed - s) < 0.001
            return (
              <button
                key={s}
                type="button"
                aria-pressed={active}
                onClick={() => setSpeed(s)}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs transition-colors',
                  active
                    ? 'border-emerald-600 bg-emerald-600 text-white'
                    : 'border-border bg-card text-muted-foreground hover:text-foreground',
                )}
              >
                {s}x
              </button>
            )
          })}
        </div>
        {provider === 'browser' && (
          <div className="text-xs text-muted-foreground">
            语速对下一段朗读生效
          </div>
        )}
      </div>

      {/* sentence navigation + loop */}
      {sentences.length > 1 && (
        <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-muted/30 p-2.5">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 flex-1 rounded-full"
              aria-label="上一句"
              disabled={sentenceIdx <= 0}
              onClick={() => jumpSentence(-1)}
            >
              <ChevronLeft className="size-3.5" /> 上一句
            </Button>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {sentenceIdx + 1}/{sentences.length}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-8 flex-1 rounded-full"
              aria-label="下一句"
              disabled={sentenceIdx >= sentences.length - 1}
              onClick={() => jumpSentence(1)}
            >
              下一句 <ChevronRight className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 rounded-full"
              aria-label={loop ? '关闭本书循环' : '开启本书循环'}
              aria-pressed={loop}
              onClick={() => setLoop((v) => !v)}
            >
              <Repeat className={cn('size-4', loop && 'text-emerald-600')} />
            </Button>
          </div>
          <p className="line-clamp-2 px-1 text-xs leading-relaxed text-muted-foreground">
            {sentences[sentenceIdx]}
          </p>
        </div>
      )}

      {/* 定时停止 */}
      <div className="flex items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 rounded-full px-3 text-xs">
              <Timer className="size-3.5" /> 定时停止
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-44 rounded-2xl p-3" side="top">
            <p className="mb-2 text-xs font-semibold">定时停止播放</p>
            <div className="grid grid-cols-2 gap-2">
              {[5, 10, 15, 30].map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => startTimer(m)}
                  className={cn(
                    'rounded-xl border border-border py-1.5 text-xs text-muted-foreground transition-colors hover:border-emerald-600/40 hover:text-emerald-600',
                    timerTotal === m * 60 && 'border-emerald-600/50 text-emerald-600',
                  )}
                >
                  {m} 分钟
                </button>
              ))}
            </div>
            {timerTotal != null && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 w-full text-xs text-muted-foreground"
                onClick={cancelTimer}
              >
                取消定时
              </Button>
            )}
          </PopoverContent>
        </Popover>
        {timerLeft != null && timerTotal != null && (
          <button
            type="button"
            aria-label="取消定时"
            onClick={cancelTimer}
            className="flex items-center gap-1.5 rounded-full bg-emerald-600/10 px-2.5 py-1 text-xs font-medium tabular-nums text-emerald-600"
          >
            <Timer className="size-3" />
            {formatMMSS(timerLeft)}
            <span className="text-emerald-600/60">/ {formatMMSS(timerTotal)}</span>
          </button>
        )}
      </div>

      {/* main button */}
      <Button
        onClick={handleMain}
        disabled={loading || !text.trim()}
        className="bg-emerald-600 text-white hover:bg-emerald-700"
      >
        {loading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : isStop ? (
          <Square className="size-4" />
        ) : (
          <Play className="size-4" />
        )}
        {isStop ? '停止' : sentenceIdx > 0 ? `从第 ${sentenceIdx + 1} 句朗读` : '朗读全文'}
      </Button>

      {/* generated audio (server providers) */}
      {provider !== 'browser' && audioUrl && (
        <div className="flex flex-col gap-2">
          <audio
            ref={audioRef}
            src={audioUrl}
            controls
            className="w-full"
            onPlay={() => setAudioPlaying(true)}
            onPause={() => setAudioPlaying(false)}
            onEnded={() => {
              if (loopRef.current && audioRef.current) {
                // 本书循环：播完最后一句后从头再来
                audioRef.current.currentTime = 0
                audioRef.current.play().catch(() => {
                  /* ignore */
                })
              } else {
                setAudioPlaying(false)
              }
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void generateFrom(sentenceIdx)}
            disabled={loading}
            className="text-muted-foreground"
          >
            <RotateCcw className="size-3.5" /> 重新生成
          </Button>
        </div>
      )}

      {/* 设为默认 */}
      <Button
        variant="outline"
        size="sm"
        onClick={handleSaveDefault}
        className="h-8 w-full rounded-full text-xs text-muted-foreground"
      >
        设为默认
      </Button>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Volume2 className="size-3.5" />
        共 {text.length} 字 · {footerHint}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared quick-TTS hook + compact voice/speed picker for tool panels
// (耳返背书 / 摹写 / 轮盘抽背), so every surface that reads aloud supports
// per-context voice + speed with a 设为默认 shortcut.
// ---------------------------------------------------------------------------

export interface QuickTtsPref {
  provider: VoiceProvider
  voice: string
  speed: number
  voiceURI?: string
}

function seedQuickPref(context: string, settings: SettingsData | null): QuickTtsPref {
  const p = settings?.voicePrefs?.[context]?.tts
  const provider = p?.provider ?? settings?.ttsProvider ?? 'zai'
  const voice =
    provider === 'zai'
      ? p?.voice && TTS_VOICES.some((v) => v.value === p.voice)
        ? p.voice
        : 'tongtong'
      : provider === 'custom'
        ? p?.voice ?? ''
        : ''
  return {
    provider,
    voice,
    speed: clampSpeed(p?.speed ?? 1),
    voiceURI: provider === 'browser' ? p?.voiceURI ?? '' : undefined,
  }
}

interface QuickSpeakState {
  pref: QuickTtsPref
  /** Update the pref (marks it dirty so async settings don't overwrite it). */
  setPref: (p: QuickTtsPref) => void
  /** Speak the given text with the current pref (all providers). */
  speak: (text: string) => void
  /** Stop any ongoing playback. */
  stop: () => void
  speaking: boolean
}

/**
 * Lightweight TTS playback hook for tool panels: resolves provider/voice/speed
 * from settings.voicePrefs[context]?.tts (falling back to the global TTS
 * provider) and plays via /api/tts or the Web Speech API.
 */
export function useQuickTts(context: string, settings: SettingsData | null): QuickSpeakState {
  const [pref, setPrefState] = React.useState<QuickTtsPref>(() =>
    seedQuickPref(context, settings),
  )
  const dirtyRef = React.useRef(false)
  const [speaking, setSpeaking] = React.useState(false)
  const audioRef = React.useRef<HTMLAudioElement | null>(null)
  const urlRef = React.useRef<string | null>(null)
  const genRef = React.useRef(0)

  const setPref = React.useCallback((p: QuickTtsPref) => {
    dirtyRef.current = true
    setPrefState(p)
  }, [])

  // Re-seed once settings arrive (async) unless the user already changed controls.
  React.useEffect(() => {
    if (!settings || dirtyRef.current) return
    setPrefState(seedQuickPref(context, settings))
  }, [settings, context])

  const browserVoices = useBrowserVoices(pref.provider === 'browser')

  const stop = React.useCallback(() => {
    genRef.current += 1
    window.speechSynthesis?.cancel()
    if (audioRef.current) audioRef.current.pause()
    setSpeaking(false)
  }, [])

  const speak = React.useCallback(
    (raw: string) => {
      const t = raw.trim()
      if (!t) {
        toast.error('没有可朗读的内容')
        return
      }
      if (pref.provider === 'browser') {
        const synth = window.speechSynthesis
        if (!synth) {
          toast.error('当前浏览器不支持语音合成，请使用 Chrome / Edge')
          return
        }
        synth.cancel()
        const gen = ++genRef.current
        const selected =
          browserVoices.find((v) => v.voiceURI === pref.voiceURI) ?? null
        const chunks = splitSpeechChunks(t)
        chunks.forEach((chunk, i) => {
          const u = new SpeechSynthesisUtterance(chunk)
          if (selected) {
            u.voice = selected
            u.lang = selected.lang
          } else {
            u.lang = 'zh-CN'
          }
          u.rate = pref.speed
          if (i === chunks.length - 1) {
            u.onend = () => {
              if (genRef.current === gen) setSpeaking(false)
            }
            u.onerror = () => {
              if (genRef.current === gen) setSpeaking(false)
            }
          }
          synth.speak(u)
        })
        setSpeaking(true)
        return
      }
      // server providers (zai / custom)
      genRef.current += 1
      const gen = genRef.current
      if (audioRef.current) audioRef.current.pause()
      setSpeaking(true)
      void (async () => {
        const tid = toast.loading('正在生成语音…')
        try {
          const res = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: t,
              voice:
                pref.provider === 'custom'
                  ? pref.voice.trim() || undefined
                  : pref.voice,
              speed: pref.speed,
              provider: pref.provider,
            }),
          })
          if (!res.ok) {
            const err = await res.json().catch(() => ({}))
            throw new Error(err.error || '生成语音失败')
          }
          const blob = await res.blob()
          if (genRef.current !== gen) {
            // stopped / superseded while generating — drop the result
            toast.dismiss(tid)
            return
          }
          if (urlRef.current) URL.revokeObjectURL(urlRef.current)
          const url = URL.createObjectURL(blob)
          urlRef.current = url
          const audio = new Audio(url)
          audio.playbackRate = pref.speed
          audio.onended = () => setSpeaking(false)
          audioRef.current = audio
          toast.success('开始朗读', { id: tid })
          try {
            await audio.play()
          } catch {
            /* autoplay blocked */
          }
        } catch (err) {
          if (genRef.current === gen) {
            toast.error(
              '朗读失败：' + (err instanceof Error ? err.message : '未知错误'),
              { id: tid },
            )
          } else {
            toast.dismiss(tid)
          }
          setSpeaking(false)
        }
      })()
    },
    [pref, browserVoices],
  )

  // Cleanup on unmount.
  React.useEffect(() => {
    return () => {
      genRef.current += 1
      window.speechSynthesis?.cancel()
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    }
  }, [])

  return { pref, setPref, speak, stop, speaking }
}

interface VoiceSpeedBarProps {
  /** Feature context used when saving the default (VOICE_CONTEXTS key). */
  context: string
  /** Current controlled pref. */
  pref: QuickTtsPref
  onChange: (p: QuickTtsPref) => void
  /** Render the picker content inline (no popover trigger). */
  inline?: boolean
  /** Called after the pref was successfully saved as the context default. */
  onSaved?: (p: QuickTtsPref) => void
  /** Label for the save-default button (defaults to 设为默认). */
  saveLabel?: string
  className?: string
}

/** Compact 音色+倍速 pill (popover picker) for panels that read aloud. */
export function VoiceSpeedBar({
  context,
  pref,
  onChange,
  inline = false,
  onSaved,
  saveLabel = '设为默认',
  className,
}: VoiceSpeedBarProps) {
  const [open, setOpen] = React.useState(false)
  const voices = useBrowserVoices(pref.provider === 'browser' || open)
  const [saving, setSaving] = React.useState(false)

  const voiceShortLabel =
    pref.provider === 'zai'
      ? TTS_VOICES.find((v) => v.value === pref.voice)?.label.split('·')[0]?.trim() ??
        'AI音色'
      : pref.provider === 'custom'
        ? pref.voice.trim() || '自定义音色'
        : voices.find((v) => v.voiceURI === pref.voiceURI)?.name ?? '系统语音'

  const handleSaveDefault = async () => {
    setSaving(true)
    const ok = await saveVoicePref(context, {
      tts: {
        provider: pref.provider,
        voice: pref.provider === 'browser' ? '' : pref.voice.trim(),
        speed: pref.speed,
        ...(pref.provider === 'browser' ? { voiceURI: pref.voiceURI } : {}),
      },
    })
    setSaving(false)
    if (ok) {
      onSaved?.(pref)
      if (!inline) setOpen(false)
    }
  }

  const content = (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">引擎</Label>
        <Select
          value={pref.provider}
          onValueChange={(v) => onChange({ ...pref, provider: v as VoiceProvider })}
        >
          <SelectTrigger className="h-9 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="zai">AI云端（z-ai）</SelectItem>
            <SelectItem value="custom">第三方 API</SelectItem>
            <SelectItem value="browser">浏览器语音</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {pref.provider === 'zai' && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">音色</Label>
          <Select value={pref.voice} onValueChange={(v) => onChange({ ...pref, voice: v })}>
            <SelectTrigger className="h-9 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TTS_VOICES.map((v) => (
                <SelectItem key={v.value} value={v.value}>
                  {v.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {pref.provider === 'custom' && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">音色</Label>
          <Input
            value={pref.voice}
            onChange={(e) => onChange({ ...pref, voice: e.target.value })}
            placeholder="音色名，如 alloy / nova"
            className="h-9"
          />
        </div>
      )}

      {pref.provider === 'browser' && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">系统语音</Label>
          {voices.length > 0 ? (
            <Select
              value={pref.voiceURI ?? ''}
              onValueChange={(v) => onChange({ ...pref, voiceURI: v })}
            >
              <SelectTrigger className="h-9 w-full">
                <SelectValue placeholder="选择系统语音" />
              </SelectTrigger>
              <SelectContent>
                {voices.map((v) => (
                  <SelectItem key={v.voiceURI} value={v.voiceURI}>
                    {v.name} ({v.lang})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="text-xs text-muted-foreground">正在加载系统语音…</div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">倍速</Label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="倍速选择">
          {SPEED_OPTIONS.map((s) => {
            const active = Math.abs(pref.speed - s) < 0.001
            return (
              <button
                key={s}
                type="button"
                aria-pressed={active}
                onClick={() => onChange({ ...pref, speed: s })}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs transition-colors',
                  active
                    ? 'border-emerald-600 bg-emerald-600 text-white'
                    : 'border-border bg-card text-muted-foreground hover:text-foreground',
                )}
              >
                {s}x
              </button>
            )
          })}
        </div>
      </div>

      <Button
        variant="outline"
        size="sm"
        onClick={() => void handleSaveDefault()}
        disabled={saving}
        className="h-8 w-full rounded-full text-xs"
      >
        {saving && <Loader2 className="size-3.5 animate-spin" />}
        {saveLabel}
      </Button>
    </div>
  )

  if (inline) return content

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 rounded-full px-2.5 text-xs text-muted-foreground"
          aria-label="音色与倍速设置"
        >
          <Volume2 className="size-3.5" />
          <span className="max-w-[8rem] truncate">{voiceShortLabel}</span>
          <span className="tabular-nums">{pref.speed}x</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 rounded-2xl p-4" side="top" align="end">
        {content}
      </PopoverContent>
    </Popover>
  )
}
