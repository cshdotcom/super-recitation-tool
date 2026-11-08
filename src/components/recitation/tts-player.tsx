'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'
import {
  AlarmClock,
  AudioLines,
  AudioWaveform,
  ChevronDown,
  ChevronUp,
  FastForward,
  Gauge,
  List,
  Loader2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Rewind,
  Star,
  Volume2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import type { SettingsData, VoiceProvider } from '@/lib/types'
import { TTS_VOICES } from '@/lib/types'
import { clampSpeed, SPEED_OPTIONS, saveVoicePref } from '@/lib/voice-prefs'
import { splitSentences } from '@/lib/sentences'
import { useLocalStorage } from '@/lib/use-local-storage'
import { getState, putState } from '@/lib/server-state'
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
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { PhoneTapIll } from '@/components/recitation/illustrations'

const CUSTOM_VOICE_KEY = 'tts-custom-voice'
/** 服务端持久化 key（/api/state）— 自定义音色真源。 */
const VOICE_STATE_KEY = 'ui:tts-custom-voice'

/** Max chars per utterance — speechSynthesis silently drops long utterances. */
const MAX_CHUNK_LEN = 120

/** 播放模式：顺序播放 → 单曲循环 → 本书循环 */
type PlayMode = 'order' | 'repeat-one' | 'loop-all'

const PLAY_MODES: {
  value: PlayMode
  label: string
  icon: typeof Repeat
}[] = [
  { value: 'order', label: '顺序播放', icon: List },
  { value: 'repeat-one', label: '单曲循环', icon: Repeat1 },
  { value: 'loop-all', label: '本书循环', icon: Repeat },
]

/** 定时预设（分钟） */
const TIMER_PRESETS = [5, 10, 15, 20, 30, 45, 60]

/** 倍速选项（当前句用 playbackRate，后续句子按该倍速重新合成） */
const PLAY_SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0]

/** 每句音频缓存上限（超过后淘汰最早一句并释放 blob URL） */
const MAX_CACHE_ENTRIES = 40

export interface TtsPlayerProps {
  text: string
  settings: SettingsData
  /** Feature context key for per-context voice defaults (VOICE_CONTEXTS). */
  context?: string
  /** Optional externally-driven 定时 minutes (non-null >0 starts the timer). */
  timerMinutes?: number | null
  /** Called when the timer reaches 0 (playback was stopped). */
  onTimerEnd?: () => void
  /** 卡片标题：用于「正在播放：xxx」胶囊与难块收藏的默认存储 key。 */
  cardTitle?: string
  /** 难块收藏持久化 key（建议传 card.id，缺省退回 cardTitle / 全局默认）。 */
  favoritesKey?: string
  /** 关闭播放器：停止播放并清理后回调父级卸载本组件。 */
  onClose?: () => void
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

function formatSpeed(v: number): string {
  return v.toFixed(v === Math.floor(v) ? 1 : 2)
}

/**
 * 拼音注音占位组件 — 接入拼音数据源（如 pinyin-pro）后，
 * 在此按 text 渲染每句上方的拼音行；当前仅保留开关与展示位。
 */
function PinyinLine({ text }: { text: string }) {
  void text
  return null
}

/**
 * 句子卡片：左上 ☆ 收藏为难块、右上「纠错」、正文可点击播放；
 * 播放中的句子 primary 浅底高亮 + 右侧圆形播放/暂停小按钮。
 */
function SentenceCard({
  sentence,
  index,
  active,
  playing,
  favorite,
  pinyinOn,
  cardRef,
  onPlay,
  onToggleFavorite,
  onReport,
}: {
  sentence: string
  index: number
  active: boolean
  playing: boolean
  favorite: boolean
  pinyinOn: boolean
  cardRef?: (el: HTMLDivElement | null) => void
  onPlay: () => void
  onToggleFavorite: () => void
  onReport: () => void
}) {
  return (
    <div
      ref={cardRef}
      role="listitem"
      tabIndex={0}
      aria-label={`第 ${index + 1} 句，点击播放`}
      onClick={onPlay}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onPlay()
        }
      }}
      className={cn(
        'relative cursor-pointer rounded-2xl border p-3 transition-colors',
        active
          ? 'border-primary/25 bg-primary/10'
          : 'border-border bg-card hover:border-primary/25',
      )}
    >
      <div className="flex items-center justify-between">
        <button
          type="button"
          aria-label={favorite ? '取消难块标记' : '标记为难块'}
          aria-pressed={favorite}
          onClick={(e) => {
            e.stopPropagation()
            onToggleFavorite()
          }}
          className="-ml-1 flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
        >
          <Star
            className={cn(
              'size-4.5',
              favorite && 'fill-amber-400 text-amber-500',
            )}
          />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onReport()
          }}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          纠错
        </button>
      </div>
      {pinyinOn && <PinyinLine text={sentence} />}
      <p
        className={cn(
          'text-[15px] leading-relaxed',
          active && 'pr-10 font-medium text-primary',
        )}
      >
        {sentence}
      </p>
      {active && (
        <button
          type="button"
          aria-label={playing ? '暂停' : '播放该句'}
          onClick={(e) => {
            e.stopPropagation()
            onPlay()
          }}
          className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md transition-transform active:scale-95"
        >
          {playing ? (
            <Pause className="size-4 fill-current" />
          ) : (
            <Play className="size-4 translate-x-px fill-current" />
          )}
        </button>
      )}
    </div>
  )
}

/**
 * 音乐播放器形态的 AI 朗读：
 * 顶栏（收起 / 全文·难块分段切换 / 注音）+ 句子卡片列表 + 底部三行控制区
 * （定时/倍速/音色 · 上一句/进度/下一句 · 播放模式/快退/大圆播放/快进/目录），
 * 可收起为底部迷你悬浮条，音频不中断。
 */
export function TtsPlayer({
  text,
  settings,
  context = 'tts',
  timerMinutes = null,
  onTimerEnd,
  cardTitle,
  favoritesKey,
  onClose,
}: TtsPlayerProps) {
  // Voice defaults for this context, captured once on mount.
  const [seeded] = React.useState(() => settings.voicePrefs?.[context]?.tts)

  // ---- 引擎：provider / voice / speed ----
  const [provider, setProvider] = React.useState<VoiceProvider>(
    () => seeded?.provider ?? settings.ttsProvider,
  )
  const [speed, setSpeed] = React.useState<number>(() => clampSpeed(seeded?.speed ?? 1))
  const audioRef = React.useRef<HTMLAudioElement>(null)
  const audioUrlRef = React.useRef<string | null>(null)
  const [audioUrl, setAudioUrl] = React.useState<string | null>(null)
  const [audioPlaying, setAudioPlaying] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  /** 请求代际：跳句/停止后丢弃过期的合成结果 */
  const genRef = React.useRef(0)

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

  // Ref mirrors —— 供合成/跳句回调读取最新值（避免闭包陈旧 & 依赖抖动）。
  const providerRef = React.useRef(provider)
  const speedRef = React.useRef(speed)
  const voiceRef = React.useRef(voice)
  const customVoiceRef = React.useRef(customVoice)
  const voiceURIRef = React.useRef(voiceURI)
  const voicesRef = React.useRef(voices)

  // ---- 句子与播放 ----
  const sentences = React.useMemo(() => splitSentences(text), [text])
  const len = sentences.length
  const [sentenceIdx, setSentenceIdx] = React.useState(0)
  const sentenceIdxRef = React.useRef(0)
  /** 当前 <audio> 里加载的是第几句（-1 = 已播完/未加载，播放键需重新开始） */
  const loadedIdxRef = React.useRef(-1)
  const [playMode, setPlayMode] = React.useState<PlayMode>('order')
  const playModeRef = React.useRef<PlayMode>('order')
  const itemRefs = React.useRef<Array<HTMLDivElement | null>>([])

  // ---- 每句音频缓存（key: provider|voice|speed|idx） ----
  const cacheRef = React.useRef<Map<string, string>>(new Map())

  // ---- 难块收藏（按句子文本持久化，文本改动不丢收藏） ----
  const favStorageKey = `bb-tts-hardblocks:${favoritesKey ?? cardTitle ?? 'default'}`
  const [favTexts, setFavTexts] = useLocalStorage<string[]>(favStorageKey, [])
  const favSet = React.useMemo(() => new Set(favTexts), [favTexts])
  const hardSentences = React.useMemo(
    () =>
      sentences
        .map((s, i) => ({ sentence: s, index: i }))
        .filter(({ sentence }) => favSet.has(sentence)),
    [sentences, favSet],
  )

  // ---- 注音开关（占位：拼音数据源接入后生效） ----
  const [pinyinOn, setPinyinOn] = useLocalStorage('bb-tts-pinyin', false)

  // ---- 定时停止 timer ----
  const [timerTotal, setTimerTotal] = React.useState<number | null>(null)
  const [timerLeft, setTimerLeft] = React.useState<number | null>(null)
  const [customTimer, setCustomTimer] = React.useState('')
  const timerIvRef = React.useRef<ReturnType<typeof setInterval> | null>(null)
  const timerLeftRef = React.useRef(0)
  const onTimerEndRef = React.useRef(onTimerEnd)
  React.useEffect(() => {
    onTimerEndRef.current = onTimerEnd
  }, [onTimerEnd])

  // ---- UI 状态 ----
  const [tab, setTab] = React.useState<'full' | 'hard'>('full')
  const [collapsed, setCollapsed] = React.useState(false)
  const [tocOpen, setTocOpen] = React.useState(false)
  const [mounted, setMounted] = React.useState(false)
  const [dragIdx, setDragIdx] = React.useState<number | null>(null)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  // Restore persisted custom voice (SSR-safe); context pref wins.
  // 服务端为真源：先读本地镜像立即回显，再拉服务端覆盖；本地旧值自动迁移。
  React.useEffect(() => {
    let alive = true
    const stored = localStorage.getItem(CUSTOM_VOICE_KEY) || ''
    const next = seeded?.provider === 'custom' && seeded.voice ? seeded.voice : stored
    customVoiceRef.current = next
    setCustomVoice(next)
    void getState([VOICE_STATE_KEY]).then((vals) => {
      if (!alive) return
      const sv = vals[VOICE_STATE_KEY]
      if (typeof sv === 'string' && sv) {
        if (!(seeded?.provider === 'custom' && seeded.voice)) {
          customVoiceRef.current = sv
          setCustomVoice(sv)
        }
      } else if (stored) {
        void putState(VOICE_STATE_KEY, stored)
      }
    })
    return () => {
      alive = false
    }
  }, [seeded])

  React.useEffect(() => {
    voicesRef.current = voices
  }, [voices])

  // Reset pointer & per-text audio cache when the text changes.
  React.useEffect(() => {
    // 作废在途合成请求，避免旧文本的音频回填到新文本会话
    genRef.current += 1
    speechGenRef.current += 1
    window.speechSynthesis?.cancel()
    audioRef.current?.pause()
    setAudioPlaying(false)
    setSpeaking(false)
    setLoading(false)
    sentenceIdxRef.current = 0
    setSentenceIdx(0)
    loadedIdxRef.current = -1
    itemRefs.current = []
    for (const url of cacheRef.current.values()) URL.revokeObjectURL(url)
    cacheRef.current.clear()
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
      toast.success(`定时 ${minutes} 分钟后自动暂停`)
      timerIvRef.current = setInterval(() => {
        timerLeftRef.current -= 1
        setTimerLeft(timerLeftRef.current)
        if (timerLeftRef.current <= 0) {
          clearTimerIv()
          stopAllPlayback()
          setTimerTotal(null)
          setTimerLeft(null)
          toast.info('定时时间到，已自动暂停播放')
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

  // Cleanup timers / speech / audio blob URLs on unmount.
  React.useEffect(() => {
    return () => {
      clearTimerIv()
      genRef.current += 1
      speechGenRef.current += 1
      window.speechSynthesis?.cancel()
      for (const url of cacheRef.current.values()) URL.revokeObjectURL(url)
      cacheRef.current.clear()
    }
  }, [clearTimerIv])

  // Keep audio playbackRate in sync with the speed chips (当前句即时生效).
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
    const next = (zh ?? voices[0]).voiceURI
    voiceURIRef.current = next
    setVoiceURI(next)
  }, [voices, provider, voiceURI])

  // Switch engine → stop current playback to avoid mixing two engines.
  React.useEffect(() => {
    speechGenRef.current += 1
    genRef.current += 1
    window.speechSynthesis?.cancel()
    audioRef.current?.pause()
    setSpeaking(false)
    setAudioPlaying(false)
  }, [provider])

  // Auto-play whenever a freshly synthesized sentence lands on the <audio>.
  React.useEffect(() => {
    const a = audioRef.current
    if (!a || !audioUrl) return
    a.playbackRate = speedRef.current
    a.play().catch(() => {
      /* autoplay blocked; user uses controls */
    })
  }, [audioUrl])

  const isPlaying = provider === 'browser' ? speaking : audioPlaying && !loading

  // 播放中随句子推进自动滚动到可视区。
  React.useEffect(() => {
    if (tab !== 'full') return
    if (!isPlaying && !loading) return
    itemRefs.current[sentenceIdx]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [sentenceIdx, isPlaying, loading, tab])

  const moveTo = (idx: number) => {
    sentenceIdxRef.current = idx
    setSentenceIdx(idx)
  }

  const cachePut = (key: string, url: string) => {
    const m = cacheRef.current
    if (m.has(key)) return
    m.set(key, url)
    while (m.size > MAX_CACHE_ENTRIES) {
      const oldest = m.keys().next().value
      if (oldest === undefined) break
      const oldUrl = m.get(oldest)
      m.delete(oldest)
      if (oldUrl && oldUrl !== audioUrlRef.current) URL.revokeObjectURL(oldUrl)
    }
  }

  /** 加载一句音频到 <audio>（同 URL 直接重播；新 URL 由 effect 自动播放）。 */
  const startAudio = (url: string) => {
    const a = audioRef.current
    setAudioUrl(url)
    if (!a) return
    if (audioUrlRef.current === url) {
      a.currentTime = 0
      a.playbackRate = speedRef.current
      a.play().catch(() => {
        /* ignore */
      })
    }
    audioUrlRef.current = url
  }

  // ---- browser synthesis：只朗读指定的一句（Web Speech API） ----
  const speakSentenceBrowser = (idx: number) => {
    const synth = window.speechSynthesis
    if (!synth) {
      toast.error('当前浏览器不支持语音合成，请使用 Chrome / Edge')
      return
    }
    const s = sentences[idx]
    if (!s || !s.trim()) {
      toast.error('没有可朗读的内容')
      return
    }
    synth.cancel()
    const gen = ++speechGenRef.current
    const selected =
      voicesRef.current.find((v) => v.voiceURI === voiceURIRef.current) ?? null
    const chunks = splitSpeechChunks(s)
    chunks.forEach((chunk, ci) => {
      const u = new SpeechSynthesisUtterance(chunk)
      if (selected) {
        u.voice = selected
        u.lang = selected.lang
      } else {
        u.lang = 'zh-CN'
      }
      u.rate = speedRef.current
      u.pitch = 1
      if (ci === chunks.length - 1) {
        u.onend = () => {
          if (speechGenRef.current !== gen) return
          setSpeaking(false)
          // 按播放模式推进
          if (playModeRef.current === 'repeat-one') {
            speakSentenceBrowser(idx)
            return
          }
          if (idx >= len - 1) {
            if (playModeRef.current === 'loop-all') {
              moveTo(0)
              speakSentenceBrowser(0)
            }
            return
          }
          moveTo(idx + 1)
          speakSentenceBrowser(idx + 1)
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

  // ---- 核心：从第 idx 句开始播放（缓存命中直接播，否则 /api/tts 合成） ----
  const playSentenceAt = (idx: number) => {
    const s = sentences[idx]
    if (!s || !s.trim()) {
      toast.error('没有可朗读的内容')
      return
    }
    moveTo(idx)
    if (providerRef.current === 'browser') {
      speakSentenceBrowser(idx)
      return
    }
    const gen = ++genRef.current
    audioRef.current?.pause()
    setAudioPlaying(false)
    const cacheKey = `${providerRef.current}|${providerRef.current === 'custom' ? customVoiceRef.current.trim() : voiceRef.current}|${speedRef.current.toFixed(2)}|${idx}`
    const cached = cacheRef.current.get(cacheKey)
    if (cached) {
      loadedIdxRef.current = idx
      setLoading(false)
      startAudio(cached)
      return
    }
    setLoading(true)
    void (async () => {
      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: s,
            voice:
              providerRef.current === 'custom'
                ? customVoiceRef.current.trim() || undefined
                : voiceRef.current,
            speed: speedRef.current,
            provider: providerRef.current,
          }),
        })
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(err.error || '生成语音失败')
        }
        const blob = await res.blob()
        if (genRef.current !== gen) return // 已被更新的播放请求取代
        const url = URL.createObjectURL(blob)
        cachePut(cacheKey, url)
        setLoading(false)
        loadedIdxRef.current = idx
        startAudio(url)
      } catch (err) {
        if (genRef.current === gen) {
          setLoading(false)
          toast.error(
            '语音生成失败：' + (err instanceof Error ? err.message : '未知错误'),
          )
        }
      }
    })()
  }

  // 一句播完 → 按播放模式推进（顺序/单曲循环/本书循环）。
  const handleEnded = () => {
    setAudioPlaying(false)
    if (playModeRef.current === 'repeat-one') {
      const a = audioRef.current
      if (a) {
        a.currentTime = 0
        a.playbackRate = speedRef.current
        a.play().catch(() => {
          /* ignore */
        })
      }
      return
    }
    const cur = sentenceIdxRef.current
    if (cur >= len - 1) {
      if (playModeRef.current === 'loop-all') {
        playSentenceAt(0)
      } else {
        loadedIdxRef.current = -1
      }
      return
    }
    playSentenceAt(cur + 1)
  }

  // ---- 主按钮：播放 / 暂停 ----
  const handleMainToggle = () => {
    if (provider === 'browser') {
      if (speaking) stopBrowser()
      else playSentenceAt(sentenceIdx)
      return
    }
    if (isPlaying) {
      audioRef.current?.pause()
      return
    }
    if (audioUrl && loadedIdxRef.current === sentenceIdx) {
      // 暂停在当前句：续播
      audioRef.current?.play().catch(() => {
        /* ignore */
      })
      return
    }
    playSentenceAt(sentenceIdx)
  }

  // 卡片/小按钮点击：播放该句；若正在播这一句则暂停。
  const handleCardPlay = (i: number) => {
    if (i === sentenceIdx && isPlaying) {
      if (provider === 'browser') stopBrowser()
      else audioRef.current?.pause()
      return
    }
    playSentenceAt(i)
  }

  const handlePrevNext = (delta: number) => {
    const next = Math.min(len - 1, Math.max(0, sentenceIdx + delta))
    if (next === sentenceIdx) return
    if (isPlaying || loading) playSentenceAt(next)
    else moveTo(next)
  }

  // 快退/快进：总是立即播放（边界处重播当前句）。
  const handleRewind = () => playSentenceAt(Math.max(0, sentenceIdx - 1))
  const handleFastForward = () => playSentenceAt(Math.min(len - 1, sentenceIdx + 1))

  const handleSliderCommit = (v: number) => {
    const idx = Math.min(len - 1, Math.max(0, v))
    if (isPlaying || loading || speaking) playSentenceAt(idx)
    else moveTo(idx)
  }

  const cyclePlayMode = () => {
    const cur = PLAY_MODES.findIndex((m) => m.value === playModeRef.current)
    const next = PLAY_MODES[(cur + 1) % PLAY_MODES.length]
    playModeRef.current = next.value
    setPlayMode(next.value)
  }

  const handleSpeedChange = (s: number) => {
    speedRef.current = s
    setSpeed(s)
    // 当前句用 playbackRate 立即生效；后续句子按新倍速重新合成（缓存键含 speed）。
    if (audioRef.current) audioRef.current.playbackRate = s
  }

  const handleVoiceChange = (v: string) => {
    voiceRef.current = v
    setVoice(v)
    // 播放中换音色：用新音色重合成当前句并继续播放。
    if (providerRef.current === 'zai' && (audioPlaying || loading)) {
      playSentenceAt(sentenceIdxRef.current)
    }
  }

  const handleCustomVoiceChange = (v: string) => {
    customVoiceRef.current = v
    setCustomVoice(v)
    // 服务端真源 + 本地镜像（离线兑底）
    try {
      localStorage.setItem(CUSTOM_VOICE_KEY, v)
    } catch {}
    void putState(VOICE_STATE_KEY, v)
  }

  const handleVoiceURIChange = (v: string) => {
    voiceURIRef.current = v
    setVoiceURI(v)
  }

  const handleProviderChange = (v: VoiceProvider) => {
    providerRef.current = v
    setProvider(v)
    stopAllPlayback()
  }

  const handlePinyinToggle = (v: boolean) => {
    setPinyinOn(v)
    toast.info(v ? '已开启注音显示' : '已关闭注音显示')
  }

  const toggleFavorite = (s: string) => {
    setFavTexts((prev) =>
      prev.includes(s) ? prev.filter((t) => t !== s) : [...prev, s],
    )
  }

  const handleReport = () => {
    toast.success('已收到纠错反馈，我们会尽快核实')
  }

  const handleClose = () => {
    stopAllPlayback()
    cancelTimer()
    onClose?.()
  }

  const voiceShortLabel =
    provider === 'zai'
      ? TTS_VOICES.find((v) => v.value === voice)?.label.split('·')[0]?.trim() ?? '童童'
      : provider === 'custom'
        ? customVoice.trim() || '自定义音色'
        : voices.find((v) => v.voiceURI === voiceURI)?.name ?? '系统语音'

  const speedLabel = formatSpeed(speed)
  const playing = isPlaying || loading
  const currentSentence = sentences[sentenceIdx] ?? '准备播放…'
  const nowPlayingLabel = `正在播放：${cardTitle ?? '全文'} · 第 ${Math.min(sentenceIdx + 1, Math.max(len, 1))}/${Math.max(len, 1)} 句`
  const ModeIcon = PLAY_MODES.find((m) => m.value === playMode)?.icon ?? List

  // ---- 迷你悬浮条（收起态；portal 到 body，播放不中断） ----
  const miniBar =
    collapsed && mounted ? (
      createPortal(
        <div className="fixed inset-x-3 bottom-3 z-[70]">
          <style>{`@keyframes tts-marquee { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }`}</style>
          <div className="flex items-center gap-2 rounded-full border border-border bg-background/95 py-2 pl-2 pr-2 shadow-xl backdrop-blur">
            <button
              type="button"
              aria-label={isPlaying ? '暂停' : '播放'}
              onClick={handleMainToggle}
              className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform active:scale-95"
            >
              {loading ? (
                <Loader2 className="size-4.5 animate-spin" />
              ) : isPlaying ? (
                <Pause className="size-5 fill-current" />
              ) : (
                <Play className="size-5 translate-x-px fill-current" />
              )}
            </button>
            <button
              type="button"
              aria-label="展开播放器"
              onClick={() => setCollapsed(false)}
              className="min-w-0 flex-1 overflow-hidden text-left"
            >
              {currentSentence.length > 18 && isPlaying ? (
                <p className="w-max whitespace-nowrap text-xs font-medium [animation:tts-marquee_16s_linear_infinite]">
                  {currentSentence}
                  {'　　'}
                  {currentSentence}
                </p>
              ) : (
                <p className="truncate text-xs font-medium">{currentSentence}</p>
              )}
              <p className="truncate text-[10px] text-muted-foreground">
                {cardTitle ?? '全文朗读'} · 第 {sentenceIdx + 1}/{len} 句
              </p>
            </button>
            <button
              type="button"
              aria-label="展开播放器"
              onClick={() => setCollapsed(false)}
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronUp className="size-5" />
            </button>
            {onClose && (
              <button
                type="button"
                aria-label="关闭播放器"
                onClick={handleClose}
                className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
        </div>,
        document.body,
      )
    ) : null

  return (
    <>
      {/* 播放引擎挂载点：<audio> 全程保持挂载，收起/展开不打断播放 */}
      <audio
        ref={audioRef}
        src={audioUrl ?? undefined}
        onPlay={() => setAudioPlaying(true)}
        onPause={() => setAudioPlaying(false)}
        onEnded={handleEnded}
        className="hidden"
        aria-hidden
        tabIndex={-1}
      />
      {miniBar}

      {!collapsed && (
        <div className="flex flex-col">
          {/* ---------- 顶栏：收起 / 全文·难块 / 注音 ---------- */}
          <div className="sticky top-0 z-20 flex items-center justify-between gap-1.5 bg-background py-1.5">
            <Button
              variant="ghost"
              size="icon"
              className="size-9 shrink-0 rounded-full"
              aria-label="收起播放器"
              onClick={() => setCollapsed(true)}
            >
              <ChevronDown className="size-5" strokeWidth={1.75} />
            </Button>

            <div
              className="flex items-center rounded-full bg-muted p-1"
              role="tablist"
              aria-label="播放内容切换"
            >
              {(
                [
                  { key: 'full' as const, label: '全文' },
                  { key: 'hard' as const, label: '难块' },
                ]
              ).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}
                  className={cn(
                    'flex items-center gap-1 rounded-full px-3.5 py-1.5 text-sm transition-all',
                    tab === t.key
                      ? 'bg-background font-semibold text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t.key === 'full' && playing && (
                    <AudioLines className="size-3.5 text-primary" />
                  )}
                  {t.label}
                </button>
              ))}
            </div>

            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  className={cn(
                    'h-9 shrink-0 rounded-full px-3 text-sm font-medium',
                    pinyinOn && 'text-primary',
                  )}
                  aria-label="拼音注音设置"
                >
                  注音
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                side="bottom"
                className="w-60 rounded-2xl p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label htmlFor="tts-pinyin-switch" className="text-sm font-medium">
                      拼音注音
                    </Label>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      在每句上方显示拼音行
                    </p>
                  </div>
                  <Switch
                    id="tts-pinyin-switch"
                    checked={pinyinOn}
                    onCheckedChange={handlePinyinToggle}
                  />
                </div>
              </PopoverContent>
            </Popover>
          </div>

          {/* ---------- 内容区 ---------- */}
          {len === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              暂无可朗读的内容
            </div>
          ) : tab === 'full' ? (
            <div className="flex flex-col gap-2 pb-2" role="list" aria-label="全文句子">
              {pinyinOn && (
                <p className="px-1 text-xs text-emerald-600">
                  注音显示已开启，拼音行将在数据源接入后展示
                </p>
              )}
              {sentences.map((s, i) => {
                const active = i === sentenceIdx && playing
                return (
                  <SentenceCard
                    key={i}
                    sentence={s}
                    index={i}
                    active={active}
                    playing={active && isPlaying}
                    favorite={favSet.has(s)}
                    pinyinOn={pinyinOn}
                    cardRef={(el) => {
                      itemRefs.current[i] = el
                    }}
                    onPlay={() => handleCardPlay(i)}
                    onToggleFavorite={() => toggleFavorite(s)}
                    onReport={handleReport}
                  />
                )
              })}
            </div>
          ) : hardSentences.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-5 py-12 text-center">
              <PhoneTapIll className="size-32" />
              <p className="max-w-64 text-sm leading-relaxed text-muted-foreground">
                在全文中点击"☆"标记难点，收藏后会出现在这里
              </p>
              <Button
                variant="outline"
                className="h-10 rounded-full px-7"
                onClick={() => setTab('full')}
              >
                去全文标记
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2 pb-2" role="list" aria-label="难块句子">
              <p className="px-1 text-xs text-muted-foreground">
                共 {hardSentences.length} 句难块 · 点击播放
              </p>
              {hardSentences.map(({ sentence, index }) => {
                const active = index === sentenceIdx && playing
                return (
                  <SentenceCard
                    key={index}
                    sentence={sentence}
                    index={index}
                    active={active}
                    playing={active && isPlaying}
                    favorite
                    pinyinOn={pinyinOn}
                    onPlay={() => handleCardPlay(index)}
                    onToggleFavorite={() => toggleFavorite(sentence)}
                    onReport={handleReport}
                  />
                )
              })}
            </div>
          )}

          {/* ---------- 播放器控制区（固定底部） ---------- */}
          <div className="sticky bottom-0 z-20 bg-background">
            {/* 正在播放胶囊 */}
            {playing && (
              <div className="flex justify-center pb-2">
                <div className="flex max-w-full items-center gap-1.5 rounded-full border border-border bg-background px-4 py-1.5 shadow-sm">
                  <AudioLines className="size-3.5 shrink-0 animate-pulse text-primary" />
                  <span className="truncate text-xs">{nowPlayingLabel}</span>
                </div>
              </div>
            )}

            {/* 第一行：定时 / 倍速 / 音色 */}
            <div className="grid grid-cols-3">
              {/* 定时 */}
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="flex flex-col items-center gap-0.5 rounded-xl py-1.5 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <AlarmClock
                      className={cn('size-5', timerLeft != null && 'text-amber-500')}
                      strokeWidth={1.75}
                    />
                    <span
                      className={cn(
                        'text-xs tabular-nums',
                        timerLeft != null && 'font-medium text-amber-600',
                      )}
                    >
                      {timerLeft != null ? formatMMSS(timerLeft) : '定时'}
                    </span>
                  </button>
                </PopoverTrigger>
                <PopoverContent side="top" align="start" className="w-64 rounded-2xl p-4">
                  <p className="text-sm font-semibold">定时停止</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    倒计时结束后自动暂停播放
                  </p>
                  <div className="mt-3 grid grid-cols-4 gap-1.5">
                    {TIMER_PRESETS.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => startTimer(m)}
                        className={cn(
                          'rounded-full border py-1.5 text-xs transition-colors',
                          timerTotal === m * 60
                            ? 'border-emerald-600 bg-emerald-600/10 font-medium text-emerald-600'
                            : 'border-border text-muted-foreground hover:border-emerald-600/40 hover:text-emerald-600',
                        )}
                      >
                        {m}分
                      </button>
                    ))}
                  </div>
                  <div className="mt-2.5 flex items-center gap-2">
                    <Input
                      type="number"
                      min={1}
                      max={600}
                      value={customTimer}
                      onChange={(e) => setCustomTimer(e.target.value)}
                      placeholder="自定义分钟"
                      aria-label="自定义定时时长（分钟）"
                      className="h-8 flex-1 text-xs"
                    />
                    <Button
                      size="sm"
                      className="h-8 rounded-full px-3 text-xs"
                      onClick={() => {
                        const v = Number.parseFloat(customTimer)
                        if (!Number.isFinite(v) || v <= 0) {
                          toast.error('请输入有效的分钟数')
                          return
                        }
                        startTimer(v)
                        setCustomTimer('')
                      }}
                    >
                      确定
                    </Button>
                  </div>
                  {timerTotal != null && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-1.5 w-full text-xs text-muted-foreground"
                      onClick={cancelTimer}
                    >
                      取消定时
                    </Button>
                  )}
                </PopoverContent>
              </Popover>

              {/* 倍速 */}
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="flex flex-col items-center gap-0.5 rounded-xl py-1.5 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <Gauge className="size-5" strokeWidth={1.75} />
                    <span className="text-xs tabular-nums">{speedLabel}</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent side="top" align="center" className="w-64 rounded-2xl p-4">
                  <p className="text-sm font-semibold">倍速</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    当前句立即生效，后续句子按新倍速合成
                  </p>
                  <div className="mt-3 grid grid-cols-4 gap-1.5">
                    {PLAY_SPEEDS.map((s) => {
                      const active = Math.abs(speed - s) < 0.001
                      return (
                        <button
                          key={s}
                          type="button"
                          aria-pressed={active}
                          onClick={() => handleSpeedChange(s)}
                          className={cn(
                            'rounded-full border py-1.5 text-xs transition-colors',
                            active
                              ? 'border-emerald-600 bg-emerald-600 font-medium text-white'
                              : 'border-border text-muted-foreground hover:border-emerald-600/40 hover:text-emerald-600',
                          )}
                        >
                          {formatSpeed(s)}x
                        </button>
                      )
                    })}
                  </div>
                </PopoverContent>
              </Popover>

              {/* 音色 */}
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="flex flex-col items-center gap-0.5 rounded-xl py-1.5 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <AudioWaveform className="size-5" strokeWidth={1.75} />
                    <span className="max-w-20 truncate text-xs">音色</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent side="top" align="end" className="w-72 rounded-2xl p-4">
                  <p className="text-sm font-semibold">音色</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    当前：{voiceShortLabel}
                  </p>
                  <div className="mt-3 flex flex-col gap-1.5">
                    <Label className="text-xs text-muted-foreground">朗读引擎</Label>
                    <Select
                      value={provider}
                      onValueChange={(v) => handleProviderChange(v as VoiceProvider)}
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

                  {provider === 'zai' && (
                    <div className="mt-3 grid grid-cols-2 gap-1.5">
                      {TTS_VOICES.map((v) => {
                        const active = voice === v.value
                        return (
                          <button
                            key={v.value}
                            type="button"
                            aria-pressed={active}
                            onClick={() => handleVoiceChange(v.value)}
                            className={cn(
                              'truncate rounded-full border px-2.5 py-1.5 text-xs transition-colors',
                              active
                                ? 'border-emerald-600 bg-emerald-600/10 font-medium text-emerald-600'
                                : 'border-border text-muted-foreground hover:border-emerald-600/40 hover:text-emerald-600',
                            )}
                          >
                            {v.label}
                          </button>
                        )
                      })}
                    </div>
                  )}

                  {provider === 'custom' && (
                    <div className="mt-3">
                      <Input
                        value={customVoice}
                        onChange={(e) => handleCustomVoiceChange(e.target.value)}
                        placeholder="音色名，如 alloy / nova / 清心"
                        className="h-9"
                      />
                    </div>
                  )}

                  {provider === 'browser' && (
                    <div className="mt-3">
                      {voices.length > 0 ? (
                        <Select value={voiceURI} onValueChange={handleVoiceURIChange}>
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
                        <div className="text-xs text-muted-foreground">
                          正在加载系统语音列表…
                        </div>
                      )}
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            </div>

            {/* 第二行：上一句 / 句子进度 / 下一句 */}
            <div className="flex items-center gap-2 py-2.5">
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0 rounded-full px-3.5 text-xs font-medium"
                aria-label="上一句"
                onClick={() => handlePrevNext(-1)}
              >
                上一句
              </Button>
              <Slider
                value={[Math.min(dragIdx ?? sentenceIdx, Math.max(len - 1, 0))]}
                min={0}
                max={Math.max(len - 1, 0)}
                step={1}
                disabled={len <= 1}
                aria-label="句子进度"
                onValueChange={([v]) => setDragIdx(v)}
                onValueCommit={([v]) => {
                  setDragIdx(null)
                  handleSliderCommit(v)
                }}
              />
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0 rounded-full px-3.5 text-xs font-medium"
                aria-label="下一句"
                onClick={() => handlePrevNext(1)}
              >
                下一句
              </Button>
            </div>

            {/* 第三行：播放模式 / 快退 / 大圆播放 / 快进 / 目录 */}
            <div className="flex items-center justify-between pb-2.5">
              <button
                type="button"
                aria-label={`播放模式：${PLAY_MODES.find((m) => m.value === playMode)?.label}`}
                onClick={cyclePlayMode}
                className="flex w-14 flex-col items-center gap-0.5 rounded-xl py-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                <ModeIcon
                  className={cn('size-5', playMode !== 'order' && 'text-primary')}
                  strokeWidth={1.75}
                />
                <span className="text-[10px] leading-none">
                  {PLAY_MODES.find((m) => m.value === playMode)?.label}
                </span>
              </button>

              <button
                type="button"
                aria-label="快退一句"
                onClick={handleRewind}
                disabled={len === 0}
                className="flex size-10 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted disabled:opacity-40"
              >
                <Rewind className="size-6 fill-current" strokeWidth={1} />
              </button>

              <button
                type="button"
                aria-label={isPlaying ? '暂停' : '播放'}
                onClick={handleMainToggle}
                disabled={loading || len === 0}
                className="flex size-20 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform active:scale-95 disabled:opacity-60"
              >
                {loading ? (
                  <Loader2 className="size-8 animate-spin" />
                ) : isPlaying ? (
                  <Pause className="size-9 fill-current" />
                ) : (
                  <Play className="size-9 translate-x-0.5 fill-current" />
                )}
              </button>

              <button
                type="button"
                aria-label="快进一句"
                onClick={handleFastForward}
                disabled={len === 0}
                className="flex size-10 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted disabled:opacity-40"
              >
                <FastForward className="size-6 fill-current" strokeWidth={1} />
              </button>

              <button
                type="button"
                aria-label="句子目录"
                onClick={() => setTocOpen(true)}
                disabled={len === 0}
                className="flex w-14 flex-col items-center gap-0.5 rounded-xl py-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
              >
                <List className="size-5" strokeWidth={1.75} />
                <span className="text-[10px] leading-none">目录</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- 句子目录 ---------- */}
      <Sheet open={tocOpen} onOpenChange={setTocOpen}>
        <SheetContent
          side="bottom"
          className="mx-auto flex h-[60vh] max-w-2xl flex-col rounded-t-3xl px-0 pb-4"
        >
          <SheetHeader className="px-5 pt-1">
            <SheetTitle className="text-base font-bold">句子目录</SheetTitle>
            <p className="text-xs text-muted-foreground">
              共 {len} 句 · 点击跳到该句播放
            </p>
          </SheetHeader>
          <div className="mt-2 flex-1 overflow-y-auto px-3 pb-2">
            {sentences.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  setTocOpen(false)
                  playSentenceAt(i)
                }}
                className={cn(
                  'flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm leading-relaxed transition-colors',
                  i === sentenceIdx
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-foreground/90 hover:bg-muted',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 shrink-0 text-xs tabular-nums',
                    i === sentenceIdx ? 'text-primary' : 'text-muted-foreground',
                  )}
                >
                  {i + 1}
                </span>
                <span className="line-clamp-2">{s}</span>
              </button>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
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
