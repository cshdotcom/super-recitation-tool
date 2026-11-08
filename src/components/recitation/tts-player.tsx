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
  Languages,
  List,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  Repeat,
  Repeat1,
  Rewind,
  Star,
  Trash2,
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

/** 自定义音色（第三方 API）名称 — useLocalStorage 本地 + 服务端自动同步。 */
const CUSTOM_VOICE_KEY = 'tts-custom-voice'

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

// ---------------------------------------------------------------------------
// 发音设置：用户自定义「原文 → 读法」替换规则（如 地 → de），合成前应用，
// 让多音字/专名读得更准。按卡持久化于 AppState（tts:pron:<cardId>），
// 无 cardId 时回退全局 tts:pron:global。
// ---------------------------------------------------------------------------

export interface PronRule {
  /** 原文（将被替换的文本片段） */
  from: string
  /** 读法（替换后的文本，交给 TTS 发音） */
  to: string
}

/** 全局发音规则 key（无 cardId 时的回退存储）。 */
export const GLOBAL_PRON_KEY = 'tts:pron:global'

/** 发音规则存储 key：优先卡片级，其次全局。 */
export function pronStateKey(cardId?: string | null): string {
  return cardId ? `tts:pron:${cardId}` : GLOBAL_PRON_KEY
}

/** Defensively parse the persisted rules JSON array [{ from, to }]. */
export function parsePronRules(raw: unknown): PronRule[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    const out: PronRule[] = []
    for (const r of arr) {
      if (!r || typeof r !== 'object') continue
      const from = String((r as Partial<PronRule>).from ?? '')
      const to = String((r as Partial<PronRule>).to ?? '')
      if (from) out.push({ from, to })
    }
    return out
  } catch {
    return []
  }
}

/**
 * Apply ALL pronunciation rules to text BEFORE synthesis (every provider).
 * Longest `from` first so longer phrases win; every occurrence is replaced.
 */
export function applyPronRules(text: string, rules: PronRule[]): string {
  if (!text || rules.length === 0) return text
  let out = text
  for (const r of [...rules].sort((a, b) => b.from.length - a.from.length)) {
    if (r.from && r.from !== r.to) out = out.split(r.from).join(r.to)
  }
  return out
}

// Module-level cache of the global rules — speakOnce()/useQuickTts() apply them
// without prop drilling; the 发音设置 sheet refreshes the cache after saving.
let globalPronCache: PronRule[] = []
let globalPronReady = false
async function ensureGlobalPronRules(): Promise<PronRule[]> {
  if (globalPronReady) return globalPronCache
  globalPronReady = true
  try {
    const vals = await getState([GLOBAL_PRON_KEY])
    globalPronCache = parsePronRules(vals[GLOBAL_PRON_KEY])
  } catch {
    globalPronCache = []
  }
  return globalPronCache
}
function cacheGlobalPronRules(rules: PronRule[]): void {
  globalPronCache = rules
  globalPronReady = true
}

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
  /** 卡片 id：发音规则按卡存储（tts:pron:<cardId>），缺省用全局规则。 */
  cardId?: string
  /** 关闭播放器：停止播放并清理后回调父级卸载本组件。 */
  onClose?: () => void
  /** 受控收起态（true=迷你悬浮条，false=完整面板）。父级控制以便联动 Sheet 开合。 */
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
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

/**
 * Shared /api/tts synthesis request — 主播放器 / 快捷朗读 / 选区朗读共用
 * 同一请求体（custom 音色 trim + 空值回退 undefined），错误统一抛出。
 */
async function requestTtsAudio(
  text: string,
  opts: { provider: VoiceProvider; voice: string; speed: number },
): Promise<Blob> {
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      voice: opts.provider === 'custom' ? opts.voice.trim() || undefined : opts.voice,
      speed: opts.speed,
      provider: opts.provider,
    }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error || '生成语音失败')
  }
  return res.blob()
}

/**
 * Shared Web Speech playback: splitSpeechChunks 分块 + 可选系统音色；
 * onEnd/onError 在最后一块结束时触发（请求代际校验留在调用方）。
 */
function speakChunksBrowser(
  synth: SpeechSynthesis,
  text: string,
  opts: {
    voice?: SpeechSynthesisVoice | null
    speed: number
    onEnd?: () => void
    onError?: () => void
  },
): void {
  const chunks = splitSpeechChunks(text)
  chunks.forEach((chunk, i) => {
    const u = new SpeechSynthesisUtterance(chunk)
    if (opts.voice) {
      u.voice = opts.voice
      u.lang = opts.voice.lang
    } else {
      u.lang = 'zh-CN'
    }
    u.rate = opts.speed
    u.pitch = 1
    if (i === chunks.length - 1) {
      u.onend = () => opts.onEnd?.()
      u.onerror = () => opts.onError?.()
    }
    synth.speak(u)
  })
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
 * 朗读引擎描述（播放前告知用户将用什么朗读）：
 * zai → 「童童（AI 音色）· 1.0x」；custom → 「自定义 TTS（nova）· 1.0x」；
 * browser → 「系统语音 · 1.0x」（已选具体系统音色时显示其名称）。
 */
function describeTtsEngine(cfg: {
  provider: VoiceProvider
  voice: string
  customVoice: string
  voiceURI: string
  voices: SpeechSynthesisVoice[]
  speed: number
}): string {
  const sx = `${formatSpeed(cfg.speed)}x`
  if (cfg.provider === 'zai') {
    const label =
      TTS_VOICES.find((v) => v.value === cfg.voice)?.label.split('·')[0]?.trim() || '童童'
    return `${label}（AI 音色）· ${sx}`
  }
  if (cfg.provider === 'custom') {
    const cv = cfg.customVoice.trim()
    return cv ? `自定义 TTS（${cv}）· ${sx}` : `自定义 TTS · ${sx}`
  }
  const v = cfg.voices.find((x) => x.voiceURI === cfg.voiceURI)
  return `${v ? v.name : '系统语音'} · ${sx}`
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
  cardId,
  onClose,
  collapsed: collapsedProp,
  onCollapsedChange,
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
  // 自定义音色：useLocalStorage（本地 + 服务端自动同步），替代手写 localStorage。
  const [customVoice, setCustomVoice] = useLocalStorage<string>(CUSTOM_VOICE_KEY, '')

  // ---- browser ----
  const [voiceURI, setVoiceURI] = React.useState<string>(
    () => (seeded?.provider === 'browser' ? seeded.voiceURI ?? '' : ''),
  )
  const voices = useBrowserVoices(provider === 'browser')
  const [speaking, setSpeaking] = React.useState(false)
  const speechGenRef = React.useRef(0)

  // ---- 选中文本继续朗读：监听 'sb-read-selection' → 临时浮层（见文件末尾） ----
  const selectionTts = useSelectionTtsHost(settings, context)

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

  // ---- 发音规则（多音字/专名读法替换）：合成前应用，规则变化即重合成 ----
  const pronKey = cardId ? `tts:pron:${cardId}` : GLOBAL_PRON_KEY
  const [pronRules, setPronRules] = React.useState<PronRule[]>([])
  const [pronVersion, setPronVersion] = React.useState(0)
  const pronRef = React.useRef<PronRule[]>([])
  React.useEffect(() => {
    pronRef.current = pronRules
  }, [pronRules])
  React.useEffect(() => {
    let alive = true
    void getState([pronKey]).then((vals) => {
      if (!alive) return
      const rules = parsePronRules(vals[pronKey])
      setPronRules(rules)
      setPronVersion((v) => v + 1)
    })
    return () => {
      alive = false
    }
  }, [pronKey])

  // ---- 发音设置 sheet ----
  const [pronOpen, setPronOpen] = React.useState(false)
  const [pronPrefill, setPronPrefill] = React.useState<PronRule | null>(null)
  const openPronSheet = React.useCallback(
    (prefill: PronRule | null) => {
      setPronPrefill(prefill)
      setPronOpen(true)
    },
    [setPronPrefill, setPronOpen],
  )
  const commitPronRules = React.useCallback(
    (rules: PronRule[]) => {
      setPronRules(rules)
      pronRef.current = rules
      setPronVersion((v) => v + 1)
      void putState(pronKey, JSON.stringify(rules))
      if (!cardId) cacheGlobalPronRules(rules)
      toast.success('发音规则已保存，重新播放生效')
    },
    [pronKey, cardId],
  )

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
  // 收起态：受控（父级联动 Sheet 开合），缺省内部自管
  const [collapsedInternal, setCollapsedInternal] = React.useState(false)
  const collapsed = collapsedProp ?? collapsedInternal
  const setCollapsed = React.useCallback(
    (v: boolean | ((prev: boolean) => boolean)) => {
      const next = typeof v === 'function' ? v(collapsed) : v
      onCollapsedChange?.(next)
      if (onCollapsedChange === undefined) setCollapsedInternal(next)
    },
    [collapsed, onCollapsedChange],
  )
  const [tocOpen, setTocOpen] = React.useState(false)
  const [mounted, setMounted] = React.useState(false)
  const [dragIdx, setDragIdx] = React.useState<number | null>(null)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  // 自定义音色：useLocalStorage 负责水合与持久化（本地 + 服务端自动同步）。
  // 上下文默认（设为默认）仍优先：水合后应用一次 seed 值。
  React.useEffect(() => {
    if (seeded?.provider === 'custom' && seeded.voice) {
      customVoiceRef.current = seeded.voice
      setCustomVoice(seeded.voice)
    }
  }, [seeded, setCustomVoice])

  // Ref mirror 跟随水合/服务端同步回填的最新值。
  React.useEffect(() => {
    customVoiceRef.current = customVoice
  }, [customVoice])

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

  // 选区朗读（'sb-read-selection'）开始时主播放器让路：注册停止回调。
  React.useEffect(() => {
    mainChannelStoppers.add(stopAllPlayback)
    return () => {
      mainChannelStoppers.delete(stopAllPlayback)
    }
  }, [stopAllPlayback])

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
    const s = applyPronRules(sentences[idx] ?? '', pronRef.current)
    if (!s || !s.trim()) {
      toast.error('没有可朗读的内容')
      return
    }
    synth.cancel()
    const gen = ++speechGenRef.current
    const selected =
      voicesRef.current.find((v) => v.voiceURI === voiceURIRef.current) ?? null
    speakChunksBrowser(synth, s, {
      voice: selected,
      speed: speedRef.current,
      onEnd: () => {
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
      },
      onError: () => {
        if (speechGenRef.current === gen) setSpeaking(false)
      },
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
    // 主播放器开始播放：先停掉选区朗读，避免双声道。
    cancelSelectionRead()
    // 朗读按钮说明用什么播放：引擎组合首次（或变化后）toast 提示。
    maybeAnnounceEngine()
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
    const cacheKey = `${providerRef.current}|${providerRef.current === 'custom' ? customVoiceRef.current.trim() : voiceRef.current}|${speedRef.current.toFixed(2)}|p${pronVersion}|${idx}`
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
        const blob = await requestTtsAudio(applyPronRules(s, pronRef.current), {
          provider: providerRef.current,
          voice:
            providerRef.current === 'custom' ? customVoiceRef.current : voiceRef.current,
          speed: speedRef.current,
        })
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
      // 暂停在当前句：续播（先停选区朗读，避免双声道）
      cancelSelectionRead()
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
    // useLocalStorage：本地 + 服务端自动同步
    setCustomVoice(v)
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

  // 纠错：打开发音设置，预填该句原文，让用户直接改读法。
  const handleReport = (sentence: string) => {
    openPronSheet({ from: sentence, to: '' })
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
  // ---- 朗读引擎说明：控制区 chip + 首次播放 toast（如「童童（AI 音色）· 1.0x」） ----
  const engineDesc = describeTtsEngine({
    provider,
    voice,
    customVoice,
    voiceURI,
    voices,
    speed,
  })
  const engineSig = `${provider}|${voice}|${customVoice.trim()}|${voiceURI}|${speed}`
  const announcedEngineRef = React.useRef<string | null>(null)
  const maybeAnnounceEngine = () => {
    if (announcedEngineRef.current === engineSig) return
    announcedEngineRef.current = engineSig
    toast.info(`将使用：${engineDesc}`)
  }
  const playing = isPlaying || loading
  const currentSentence = sentences[sentenceIdx] ?? '准备播放…'
  const nowPlayingLabel = `正在播放：${cardTitle ?? '全文'} · 第 ${Math.min(sentenceIdx + 1, Math.max(len, 1))}/${Math.max(len, 1)} 句`
  const ModeIcon = PLAY_MODES.find((m) => m.value === playMode)?.icon ?? List

  // ---- 迷你悬浮条（收起态；portal 到 body，播放不中断） ----
  const miniBar =
    collapsed && mounted ? (
      createPortal(
        <div className="fixed inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-[70]">
          <style>{`@keyframes tts-marquee { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }`}</style>
          <div className="flex items-center gap-2 rounded-full border border-border bg-background/95 py-2 pl-2 pr-2 shadow-xl backdrop-blur">
            <button
              type="button"
              aria-label={isPlaying ? '暂停' : '播放'}
              onClick={handleMainToggle}
              className={cn(
                'flex size-10 shrink-0 items-center justify-center rounded-full text-primary-foreground shadow-md transition-all active:scale-95',
                isPlaying ? 'bg-emerald-600' : 'bg-primary',
              )}
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
      {/* 选中文本朗读临时浮层（portal 到 body，位于迷你条上方） */}
      {mounted && selectionTts.isRenderer && selectionTts.state.open ? (
        <SelectionReadOverlay state={selectionTts.state} />
      ) : null}

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
                    onReport={() => handleReport(s)}
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
                    onReport={() => handleReport(sentence)}
                  />
                )
              })}
            </div>
          )}

          {/* ---------- 播放器控制区（固定底部，含安全区内边距） ---------- */}
          <div className="sticky bottom-0 z-20 bg-background pb-[env(safe-area-inset-bottom)]">
            {/* 正在播放胶囊 / 朗读引擎说明 chip（点按也可查看将使用的引擎） */}
            {playing ? (
              <div className="flex justify-center pb-2">
                <div className="flex max-w-full items-center gap-1.5 rounded-full border border-border bg-background px-4 py-1.5 shadow-sm">
                  <AudioLines className="size-3.5 shrink-0 animate-pulse text-primary" />
                  <span className="truncate text-xs">{nowPlayingLabel}</span>
                </div>
              </div>
            ) : (
              <div className="flex justify-center pb-2">
                <button
                  type="button"
                  onClick={() => toast.info(`将使用：${engineDesc}`)}
                  aria-label={`朗读引擎：${engineDesc}，点击查看`}
                  className="flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/60 px-3.5 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Volume2 className="size-3.5 shrink-0" />
                  <span className="truncate text-xs">将使用：{engineDesc}</span>
                </button>
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

                  <button
                    type="button"
                    onClick={() => openPronSheet(null)}
                    className="mt-3 flex w-full items-center justify-between rounded-xl border border-border px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                  >
                    <span className="flex items-center gap-2">
                      <Languages className="size-4 text-muted-foreground" />
                      发音设置
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {pronRules.length > 0 ? `${pronRules.length} 条规则` : '多音字读法'}
                    </span>
                  </button>
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
                className={cn(
                  'flex size-20 items-center justify-center rounded-full shadow-lg transition-all active:scale-95 disabled:opacity-60',
                  isPlaying
                    ? 'bg-emerald-600 text-white shadow-emerald-600/30'
                    : 'bg-primary text-primary-foreground',
                )}
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

      {/* 发音设置：多音字/专名读法替换规则 */}
      <PronSheet
        open={pronOpen}
        rules={pronRules}
        prefill={pronPrefill}
        onOpenChange={(v) => {
          setPronOpen(v)
          if (!v) setPronPrefill(null)
        }}
        onCommit={commitPronRules}
      />
    </>
  )
}

/**
 * 发音设置 Sheet：维护「原文 → 读法」替换规则列表。
 * 保存后立即生效（合成前替换，所有引擎），并按卡/全局持久化。
 */
function PronSheet({
  open,
  rules,
  prefill,
  onOpenChange,
  onCommit,
}: {
  open: boolean
  rules: PronRule[]
  prefill: PronRule | null
  onOpenChange: (v: boolean) => void
  onCommit: (rules: PronRule[]) => void
}) {
  const [draft, setDraft] = React.useState<PronRule[]>([])

  React.useEffect(() => {
    if (!open) return
    const next = [...rules.map((r) => ({ ...r }))]
    if (prefill && !next.some((r) => r.from === prefill.from)) next.push({ ...prefill })
    setDraft(next)
  }, [open, rules, prefill])

  const save = () => {
    const cleaned = draft
      .map((r) => ({ from: r.from.trim(), to: r.to.trim() }))
      .filter((r) => r.from)
    const seen = new Set<string>()
    const deduped = cleaned.filter((r) => {
      if (seen.has(r.from)) return false
      seen.add(r.from)
      return true
    })
    onCommit(deduped)
    onOpenChange(false)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="flex max-h-[82vh] flex-col rounded-t-3xl p-0">
        <SheetHeader className="shrink-0 border-b border-border px-5 pb-3 pt-4">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Languages className="size-4.5" strokeWidth={1.75} />
            发音设置
          </SheetTitle>
          <p className="text-xs leading-relaxed text-muted-foreground">
            让某些字词按指定读法朗读，如多音字「地 → de」、专名替换。对所有朗读引擎生效。
          </p>
        </SheetHeader>
        <div className="flex-1 space-y-2 overflow-y-auto px-5 py-4">
          {draft.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              还没有发音规则，点击下方按钮添加
            </p>
          )}
          {draft.map((r, i) => (
            <div
              key={i}
              className="flex items-center gap-2 rounded-2xl border border-border bg-card p-2"
            >
              <Input
                value={r.from}
                onChange={(e) =>
                  setDraft((prev) =>
                    prev.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)),
                  )
                }
                placeholder="原文，如：地"
                aria-label="原文"
                className="h-9 flex-1 text-sm"
              />
              <span className="shrink-0 text-xs text-muted-foreground">读作</span>
              <Input
                value={r.to}
                onChange={(e) =>
                  setDraft((prev) =>
                    prev.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)),
                  )
                }
                placeholder="读法，如：de"
                aria-label="读法"
                className="h-9 flex-1 text-sm"
              />
              <button
                type="button"
                aria-label={`删除第 ${i + 1} 条规则`}
                onClick={() => setDraft((prev) => prev.filter((_, j) => j !== i))}
                className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setDraft((prev) => [...prev, { from: '', to: '' }])}
            className="flex h-10 w-full items-center justify-center gap-1.5 rounded-2xl border border-dashed border-border text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
          >
            <Plus className="size-4" /> 添加规则
          </button>
        </div>
        <div className="shrink-0 border-t border-border px-5 py-3">
          <Button className="h-11 w-full rounded-full" onClick={save}>
            保存规则
          </Button>
        </div>
      </SheetContent>
    </Sheet>
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

  // 发音规则：懒加载全局规则，speak 前应用。
  React.useEffect(() => {
    void ensureGlobalPronRules()
  }, [])

  const stop = React.useCallback(() => {
    genRef.current += 1
    window.speechSynthesis?.cancel()
    if (audioRef.current) audioRef.current.pause()
    setSpeaking(false)
  }, [])

  const speak = React.useCallback(
    (raw: string) => {
      const t0 = raw.trim()
      if (!t0) {
        toast.error('没有可朗读的内容')
        return
      }
      const t = globalPronReady ? applyPronRules(t0, globalPronCache) : t0
      cancelSelectionRead() // 与选区朗读互斥，避免双声道
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
        speakChunksBrowser(synth, t, {
          voice: selected,
          speed: pref.speed,
          onEnd: () => {
            if (genRef.current === gen) setSpeaking(false)
          },
          onError: () => {
            if (genRef.current === gen) setSpeaking(false)
          },
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
          const blob = await requestTtsAudio(t, {
            provider: pref.provider,
            voice: pref.voice,
            speed: pref.speed,
          })
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

// ---------------------------------------------------------------------------
// speakOnce: one-shot TTS with the DEFAULT configured provider for a context.
// Used by the reader's selection popup (朗读) and other one-off speak spots so
// they follow the user's voice prefs instead of always using the browser API.
// ---------------------------------------------------------------------------
let speakOnceAudio: HTMLAudioElement | null = null
let speakOnceUrl: string | null = null
let speakOnceGen = 0

export function stopSpeakOnce(): void {
  speakOnceGen += 1
  try {
    window.speechSynthesis?.cancel()
  } catch {
    /* ignore */
  }
  if (speakOnceAudio) {
    speakOnceAudio.pause()
    speakOnceAudio = null
  }
  if (speakOnceUrl) {
    URL.revokeObjectURL(speakOnceUrl)
    speakOnceUrl = null
  }
}

export function speakOnce(
  text: string,
  opts: {
    context: string
    settings: SettingsData | null
    onEnd?: () => void
  },
): void {
  const raw = (text || '').trim()
  if (!raw) {
    toast.error('没有可朗读的内容')
    return
  }
  stopSpeakOnce()
  cancelSelectionRead() // 与选区朗读互斥，避免双声道
  const gen = ++speakOnceGen
  const pref = seedQuickPref(opts.context, opts.settings)
  void ensureGlobalPronRules().then((rules) => {
    if (gen !== speakOnceGen) return
    const t = applyPronRules(raw, rules)
    if (pref.provider === 'browser') {
      const synth = window.speechSynthesis
      if (!synth) {
        toast.error('当前浏览器不支持语音合成，请使用 Chrome / Edge')
        return
      }
      synth.cancel()
      speakChunksBrowser(synth, t, {
        speed: pref.speed,
        onEnd: () => {
          if (gen === speakOnceGen) opts.onEnd?.()
        },
      })
      return
    }
    void (async () => {
      try {
        const blob = await requestTtsAudio(t, {
          provider: pref.provider,
          voice: pref.voice,
          speed: pref.speed,
        })
        if (gen !== speakOnceGen) return
        speakOnceUrl = URL.createObjectURL(blob)
        const audio = new Audio(speakOnceUrl)
        audio.playbackRate = pref.speed
        audio.onended = () => {
          if (gen === speakOnceGen) opts.onEnd?.()
        }
        speakOnceAudio = audio
        void audio.play()
      } catch (err) {
        if (gen === speakOnceGen) {
          toast.error('朗读失败：' + (err instanceof Error ? err.message : '未知错误'))
        }
      }
    })()
  })
}

// ---------------------------------------------------------------------------
// 选中文本继续朗读：临时迷你播放器（浮层）。
// reader-view 选中文本后 dispatch 'sb-read-selection'（detail: { text }），
// 本模块用与主播放器相同的引擎逻辑（/api/tts 或 speechSynthesis + 发音规则）
// 逐小句朗读选区，并通过 'sb-read-selection-progress' 广播进度供原文高亮；
// 全部读完 1s 后自动收起，取消后浮层立即消失。
// ---------------------------------------------------------------------------

/** 请求事件名：reader-view 选中文本朗读时派发，detail = { text: string }。 */
export const READ_SELECTION_EVENT = 'sb-read-selection'
/** 进度事件名：选区朗读时派发，供原文侧高亮当前小句。 */
export const READ_SELECTION_PROGRESS_EVENT = 'sb-read-selection-progress'

export interface ReadSelectionDetail {
  text: string
}

export interface ReadSelectionProgressDetail {
  /** 当前小句序号（0-based） */
  index: number
  /** 小句总数 */
  total: number
  /** 当前正在朗读的小句文本 */
  text: string
  /** 是否结束（全部完成或被取消） */
  done: boolean
  /** done 时有效：是否被用户取消 */
  cancelled?: boolean
}

/** 派发选区朗读请求（reader-view 侧可直接调用，等价于 dispatch 事件）。 */
export function dispatchReadSelection(text: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<ReadSelectionDetail>(READ_SELECTION_EVENT, { detail: { text } }),
  )
}

interface SelectionTtsState {
  open: boolean
  /** 原始选中文本 */
  text: string
  /** splitSentences 拆出的小句 */
  parts: string[]
  index: number
  playing: boolean
  loading: boolean
  paused: boolean
  /** 引擎描述（如「童童（AI 音色）· 1.0x」） */
  engine: string
}

const SELECTION_TTS_CLOSED: SelectionTtsState = {
  open: false,
  text: '',
  parts: [],
  index: 0,
  playing: false,
  loading: false,
  paused: false,
  engine: '',
}

let selState: SelectionTtsState = SELECTION_TTS_CLOSED
const selSubs = new Set<() => void>()

function notifySelectionTts(): void {
  for (const cb of selSubs) cb()
}
function subscribeSelectionTts(cb: () => void): () => void {
  selSubs.add(cb)
  return () => {
    selSubs.delete(cb)
  }
}
function getSelectionTtsSnapshot(): SelectionTtsState {
  return selState
}

/** host（挂载点）提供的配置：settings + context（音色默认）+ 系统音色列表。 */
interface SelectionHostConfig {
  settings: SettingsData | null
  context: string
  voices: SpeechSynthesisVoice[]
}

interface SelectionHost {
  id: number
  getConfig: () => SelectionHostConfig
}

const selHosts: SelectionHost[] = []
let selNextHostId = 1
let selListenerInstalled = false

/** 其它 TTS 通道（主播放器等）注册的停止回调：选区朗读开始前全部调用。 */
const mainChannelStoppers = new Set<() => void>()

/** 当前负责渲染浮层的 host（最后注册者优先；卸载后自动让位）。 */
function selectionRendererId(): number {
  return selHosts.length > 0 ? selHosts[selHosts.length - 1].id : 0
}

function ensureSelectionListener(): void {
  if (selListenerInstalled || typeof window === 'undefined') return
  selListenerInstalled = true
  window.addEventListener(READ_SELECTION_EVENT, (e: Event) => {
    const detail = (e as CustomEvent<ReadSelectionDetail>).detail
    if (!detail || typeof detail.text !== 'string' || !detail.text.trim()) return
    const host = selHosts[selHosts.length - 1]
    if (!host) return
    startSelectionReadInternal(detail.text, host.getConfig())
  })
}

function registerSelectionHost(getConfig: () => SelectionHostConfig): number {
  const host: SelectionHost = { id: selNextHostId++, getConfig }
  selHosts.push(host)
  ensureSelectionListener()
  notifySelectionTts()
  return host.id
}

function unregisterSelectionHost(id: number): void {
  const i = selHosts.findIndex((h) => h.id === id)
  if (i === -1) return
  selHosts.splice(i, 1)
  notifySelectionTts()
  // 最后一个 host 卸载时若仍在朗读：立即取消，避免无人控制的音频。
  if (selHosts.length === 0 && (selState.playing || selState.loading)) {
    cancelSelectionRead()
  }
}

// ---- 选区朗读引擎（模块级单例；复用主播放器的合成路径） ----
let selAudio: HTMLAudioElement | null = null
let selAudioUrl: string | null = null
let selGen = 0
let selPaused = false

interface SelectionSession {
  parts: string[]
  pref: QuickTtsPref
  voices: SpeechSynthesisVoice[]
  rules: PronRule[]
  gen: number
}
let selSession: SelectionSession | null = null

function setSelState(patch: Partial<SelectionTtsState>): void {
  if (patch.paused !== undefined) selPaused = patch.paused
  selState = { ...selState, ...patch }
  notifySelectionTts()
}

function dispatchSelProgress(detail: ReadSelectionProgressDetail): void {
  window.dispatchEvent(
    new CustomEvent<ReadSelectionProgressDetail>(READ_SELECTION_PROGRESS_EVENT, {
      detail,
    }),
  )
}

function stopSelectionAudio(): void {
  try {
    window.speechSynthesis?.cancel()
  } catch {
    /* ignore */
  }
  if (selAudio) {
    selAudio.onended = null
    selAudio.pause()
    selAudio = null
  }
  if (selAudioUrl) {
    URL.revokeObjectURL(selAudioUrl)
    selAudioUrl = null
  }
}

function startSelectionReadInternal(text: string, config: SelectionHostConfig): void {
  const raw = (text || '').trim()
  if (!raw) {
    toast.error('没有可朗读的内容')
    return
  }
  // 与主播放器/一次性朗读互斥：开始前先停掉其它通道。
  for (const stop of mainChannelStoppers) {
    try {
      stop()
    } catch {
      /* ignore */
    }
  }
  stopSpeakOnce()
  cancelSelectionRead() // 取代上一次未完成的选区朗读

  const parts = splitSentences(raw)
  const pref = seedQuickPref(config.context, config.settings)
  const voices =
    config.voices.length > 0
      ? config.voices
      : [...(window.speechSynthesis?.getVoices() ?? [])]
  const engine = describeTtsEngine({
    provider: pref.provider,
    voice: pref.voice,
    customVoice: pref.provider === 'custom' ? pref.voice : '',
    voiceURI: pref.voiceURI ?? '',
    voices,
    speed: pref.speed,
  })
  const gen = ++selGen
  selSession = { parts, pref, voices, rules: [], gen }
  selPaused = false
  setSelState({
    open: true,
    text: raw,
    parts,
    index: 0,
    playing: true,
    loading: false,
    paused: false,
    engine,
  })
  void ensureGlobalPronRules().then((rules) => {
    if (!selSession || selSession.gen !== gen) return
    selSession.rules = rules
    readSelectionPart(0)
  })
}

/** 逐小句朗读：每句开始前派发进度事件；结束派发 done，1s 后收起浮层。 */
function readSelectionPart(idx: number): void {
  const s = selSession
  if (!s || s.gen !== selGen) return
  // 与上一句音频解绑，避免暂停/恢复期间误重播旧句。
  if (selAudio) {
    selAudio.onended = null
    selAudio = null
  }
  if (idx >= s.parts.length) {
    const lastIdx = Math.max(s.parts.length - 1, 0)
    const last = s.parts[lastIdx] ?? ''
    selSession = null
    setSelState({ playing: false, loading: false, paused: false })
    dispatchSelProgress({ index: lastIdx, total: s.parts.length, text: last, done: true })
    window.setTimeout(() => {
      if (selGen === s.gen && selState.open) setSelState({ open: false })
    }, 1000)
    return
  }
  const rawPart = s.parts[idx]
  setSelState({ index: idx, loading: true, paused: false })
  dispatchSelProgress({ index: idx, total: s.parts.length, text: rawPart, done: false })
  const part = applyPronRules(rawPart, s.rules)

  if (s.pref.provider === 'browser') {
    const synth = window.speechSynthesis
    if (!synth) {
      toast.error('当前浏览器不支持语音合成，请使用 Chrome / Edge')
      cancelSelectionRead()
      return
    }
    synth.cancel()
    const selected = s.pref.voiceURI
      ? s.voices.find((v) => v.voiceURI === s.pref.voiceURI) ?? null
      : null
    speakChunksBrowser(synth, part, {
      voice: selected,
      speed: s.pref.speed,
      onEnd: () => {
        if (!selSession || selSession.gen !== selGen) return
        readSelectionPart(idx + 1)
      },
      onError: () => {
        if (!selSession || selSession.gen !== selGen) return
        cancelSelectionRead()
      },
    })
    setSelState({ loading: false, playing: true })
    return
  }

  void (async () => {
    try {
      const blob = await requestTtsAudio(part, {
        provider: s.pref.provider,
        voice: s.pref.voice,
        speed: s.pref.speed,
      })
      if (!selSession || selSession.gen !== selGen) return
      if (selAudioUrl) URL.revokeObjectURL(selAudioUrl)
      selAudioUrl = URL.createObjectURL(blob)
      const audio = new Audio(selAudioUrl)
      audio.playbackRate = s.pref.speed
      audio.onended = () => {
        if (!selSession || selSession.gen !== selGen) return
        readSelectionPart(idx + 1)
      }
      selAudio = audio
      setSelState({ loading: false, playing: true })
      if (!selPaused) {
        try {
          await audio.play()
        } catch {
          /* autoplay blocked */
        }
      }
    } catch (err) {
      if (!selSession || selSession.gen !== selGen) return
      toast.error('朗读失败：' + (err instanceof Error ? err.message : '未知错误'))
      cancelSelectionRead()
    }
  })()
}

/** 暂停/继续：SDK 走 audio.pause()/play()，浏览器走 speechSynthesis.pause()/resume()。 */
function toggleSelectionReadPause(): void {
  if (!selState.open || !selState.playing) return
  if (selState.paused) {
    if (selAudio) {
      void selAudio.play().catch(() => {
        /* ignore */
      })
    } else {
      try {
        window.speechSynthesis?.resume()
      } catch {
        /* ignore */
      }
    }
    setSelState({ paused: false })
  } else {
    if (selAudio) selAudio.pause()
    else {
      try {
        window.speechSynthesis?.pause()
      } catch {
        /* ignore */
      }
    }
    setSelState({ paused: true })
  }
}

/** 取消：立即停合成/音频，浮层消失，派发 done + cancelled。 */
function cancelSelectionRead(): void {
  const session = selSession
  selGen++
  selSession = null
  selPaused = false
  stopSelectionAudio()
  if (!selState.open) return
  const idx = selState.index
  const total = selState.parts.length
  const text = selState.parts[idx] ?? selState.text
  setSelState({ open: false, playing: false, loading: false, paused: false })
  if (session) {
    dispatchSelProgress({ index: idx, total, text, done: true, cancelled: true })
  }
}

/**
 * 选区朗读 host：注册配置（settings/context/voices）并订阅浮层状态。
 * 最后注册的 host 负责渲染浮层，卸载后自动让位给其它 host，
 * 因此浮层不依赖某个具体组件的存活（如主播放器 Sheet 关闭）。
 */
function useSelectionTtsHost(
  settings: SettingsData | null,
  context: string,
): { state: SelectionTtsState; isRenderer: boolean } {
  const configRef = React.useRef<SelectionHostConfig>({
    settings,
    context,
    voices: [],
  })
  const voices = useBrowserVoices(true)
  React.useEffect(() => {
    configRef.current = { settings, context, voices }
  }, [settings, context, voices])

  const [hostId, setHostId] = React.useState(0)

  React.useEffect(() => {
    const id = registerSelectionHost(() => configRef.current)
    setHostId(id)
    return () => unregisterSelectionHost(id)
  }, [])

  const state = React.useSyncExternalStore(
    subscribeSelectionTts,
    getSelectionTtsSnapshot,
    () => SELECTION_TTS_CLOSED,
  )

  const isRenderer = hostId !== 0 && selectionRendererId() === hostId
  return { state, isRenderer }
}

/** 选区朗读临时浮层：portal 到 body，底部居中（主播放器迷你条上方）。 */
function SelectionReadOverlay({ state }: { state: SelectionTtsState }) {
  const total = Math.max(state.parts.length, 1)
  const current = state.parts[state.index] ?? state.text
  return createPortal(
    <div
      role="status"
      aria-label="选区朗读"
      className="animate-in slide-in-from-bottom-2 fade-in-0 fixed inset-x-3 bottom-20 z-[75] mx-auto flex max-w-md duration-200"
    >
      <div className="flex w-full items-center gap-2.5 rounded-2xl border border-border bg-background/95 py-2 pl-2 pr-2 shadow-xl backdrop-blur">
        <button
          type="button"
          aria-label={state.paused ? '继续朗读选中内容' : '暂停朗读选中内容'}
          onClick={toggleSelectionReadPause}
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-full text-primary-foreground shadow-md transition-all active:scale-95',
            state.playing && !state.paused ? 'bg-emerald-600' : 'bg-primary',
          )}
        >
          {state.loading ? (
            <Loader2 className="size-4.5 animate-spin" />
          ) : state.paused ? (
            <Play className="size-5 translate-x-px fill-current" />
          ) : (
            <Pause className="size-5 fill-current" />
          )}
        </button>
        <div className="min-w-0 flex-1 text-left">
          <p className="line-clamp-2 text-xs font-medium leading-relaxed">{current}</p>
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
            {state.engine} · 第 {Math.min(state.index + 1, total)}/{total} 句
            {state.paused ? ' · 已暂停' : state.loading ? ' · 合成中…' : ''}
          </p>
        </div>
        <button
          type="button"
          aria-label="取消朗读选中内容"
          onClick={cancelSelectionRead}
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>,
    document.body,
  )
}

/**
 * 选区朗读挂载点：放在页面级（如 reader-view 根部）即可在主播放器未打开时
 * 也响应 'sb-read-selection' 事件；浮层由最后注册的 host 渲染，不重复。
 */
export function SelectionReadPlayer({
  settings,
  context = 'reader',
}: {
  settings: SettingsData | null
  context?: string
}) {
  const { state, isRenderer } = useSelectionTtsHost(settings, context)
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => {
    setMounted(true)
  }, [])
  if (!mounted || !isRenderer || !state.open) return null
  return <SelectionReadOverlay state={state} />
}
