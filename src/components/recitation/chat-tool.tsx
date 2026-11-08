'use client'

// ChatTool — AI督背 (supervise) & AI问问 (ask) chat panel.
// Features:
//   • 服务端持久化：全部对话（含附图）存 SQLite（/api/chat-log），
//     切卡片/刷新/换设备均从服务端加载历史；删除/清空同步服务端。
//   • 语音输入：输入框与 AI 提问卡的自定义回答均支持麦克风一键转文字。
//   • per-reply actions: copy (copy icon) and delete (trash icon — also drops
//     the adjacent user message that this reply answers)
//   • 清空对话 header button with AlertDialog confirmation
//   • AI visual questions: the model may emit a ```ask fenced block with
//     {"question","options"} JSON — rendered as an emerald question card
//     instead of raw code. Tapping an option (or the custom input) sends that
//     text as the user message and marks the card as answered.
//   • long replies render via RichContent (markdown / tables / mermaid /
//     LaTeX / code) with an internal max-height scroll.
//   • TTS 朗读：每条 AI 回复可点击喇叭播放（useQuickTts，按 ask/supervise
//     上下文取音色）；顶栏可开关「自动朗读」（默认关，/api/state 记忆）与
//     「音色设置」（引擎/音色/倍速，PATCH /api/settings + sb-voice-prefs-changed）。
//   • 移动端：visualViewport 感知软键盘并等量收窄面板高度（输入框不被遮挡）；
//     小图标按钮用 after 伪元素把触控热区扩到 ≥44px（视觉不变）。
import * as React from 'react'
import {
  Check,
  Copy,
  ImagePlus,
  Loader2,
  MessageCircleQuestion,
  Pause,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { VoiceInput } from '@/components/recitation/voice-input'

import { cn } from '@/lib/utils'
import type {
  ChatMessage,
  SettingsData,
  VoicePrefTTS,
  VoiceProvider,
} from '@/lib/types'
import { TTS_VOICES } from '@/lib/types'
import { clampSpeed, useSettingsLite } from '@/lib/voice-prefs'
import { getState, putState } from '@/lib/server-state'
import {
  useQuickTts,
  type QuickTtsPref,
} from '@/components/recitation/tts-player'
import { RichContent } from '@/components/recitation/rich-content'
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
import { Slider } from '@/components/ui/slider'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

const MAX_IMAGES = 4
/** Files smaller than this keep their original data URL; larger get compressed. */
const COMPRESS_OVER = 300 * 1024
const MAX_IMAGE_DIM = 1024
/** Assistant bubble internal scroll cap (px). */
const REPLY_MAX_H = 320

/** 小图标按钮的触控热区扩展（after 伪元素，视觉不变、命中区 ≥44px）。 */
const HIT_AREA =
  "relative after:absolute after:-inset-2 after:rounded-[inherit] after:content-['']"
/** 更矮的文字按钮（如「清空对话」）用更大的外扩半径凑足 44px。 */
const HIT_AREA_LG =
  "relative after:absolute after:-inset-2.5 after:rounded-[inherit] after:content-['']"

/** 移动端图标按钮 ≥44px 触控尺寸，sm 及以上恢复紧凑视觉尺寸。 */
const TOUCH_SM = 'size-11 sm:size-9'
const TOUCH_XS = 'size-11 sm:size-8'
/** VoiceInput 的按钮在子元素上，用 arbitrary child variant 覆盖其尺寸。 */
const TOUCH_MIC = '[&>button]:size-11 sm:[&>button]:size-8'

/** 聚焦输入框后，等软键盘弹出动画结束再把元素滚入可视区（防遮挡兜底）。 */
function keepInputVisible(e: React.FocusEvent<HTMLElement>) {
  const el = e.currentTarget
  window.setTimeout(() => {
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, 350)
}

interface ChatToolProps {
  mode: 'supervise' | 'ask'
  content: string
  /** Ask mode allows attaching images (vision) to user messages. */
  allowImages?: boolean
  /** 当前卡片 id — 对话历史按 cardId+mode 存在服务端。 */
  cardId?: string
  /** App settings（含 voicePrefs）。不传时组件自行拉取 /api/settings 兜底。 */
  settings?: SettingsData | null
}

interface UIMessage {
  id: string
  /** 服务端 ChatLog 行 id（历史消息与已同步的新消息）。 */
  sid?: string
  role: 'user' | 'assistant'
  content: string
  images?: string[]
}

interface ServerChatMsg {
  id: string
  role: 'user' | 'assistant'
  content: string
  images?: string[]
}

interface PendingImage {
  id: string
  dataUrl: string
}

/** Parsed ```ask question block emitted by the AI. */
interface AskBlock {
  question: string
  options: string[]
}

type AskSegment =
  | { kind: 'md'; value: string }
  | { kind: 'ask'; ask: AskBlock }

/** 把一条消息写入服务端 ChatLog，返回行 id（失败返回 null，静默降级）。 */
async function persistMessage(
  cardId: string,
  mode: 'supervise' | 'ask',
  m: UIMessage,
): Promise<string | null> {
  try {
    const res = await fetch('/api/chat-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cardId,
        mode,
        role: m.role,
        content: m.content,
        images: m.images ?? [],
      }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { id?: string }
    return data.id ?? null
  } catch {
    return null
  }
}

function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Lenient parse of an ```ask payload: tolerates surrounding prose,
 *  pretty-printed newlines and trailing commas. Returns null when the
 *  payload is unusable (caller degrades to plain-text rendering). */
function tryParseAskBlock(raw: string): AskBlock | null {
  const candidates = [raw.trim()]
  const brace = raw.match(/\{[\s\S]*\}/)
  if (brace) candidates.push(brace[0])
  for (const c of candidates) {
    // second pass: strip trailing commas (common model slip)
    for (const t of [c, c.replace(/,\s*([}\]])/g, '$1')]) {
      try {
        const obj = JSON.parse(t) as { question?: unknown; options?: unknown }
        if (typeof obj?.question === 'string' && Array.isArray(obj.options)) {
          const options = obj.options
            .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
            .map((o) => o.trim())
            .slice(0, 6)
          const question = obj.question.trim()
          if (question && options.length > 0) {
            return { question, options }
          }
        }
      } catch {
        // try the next candidate
      }
    }
  }
  return null
}

/** Split assistant content into markdown and ```ask segments.
 *  Invalid ask JSON degrades to the raw fenced code block (plain text). */
function splitAskSegments(content: string): AskSegment[] {
  const parts = content.split(/```ask[ \t]*\r?\n?([\s\S]*?)```/g)
  const segs: AskSegment[] = []
  for (let i = 0; i < parts.length; i += 1) {
    if (i % 2 === 0) {
      segs.push({ kind: 'md', value: parts[i] })
      continue
    }
    const ask = tryParseAskBlock(parts[i])
    if (ask) {
      segs.push({ kind: 'ask', ask })
    } else {
      segs.push({ kind: 'md', value: `\`\`\`ask\n${parts[i]}\`\`\`` })
    }
  }
  return segs
}

/** Convert a picked image file to a data URL, compressing oversized ones. */
function processImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.onload = () => {
      const dataUrl = reader.result as string
      if (file.size < COMPRESS_OVER) {
        resolve(dataUrl)
        return
      }
      // client-side compression: canvas, max 1024px, JPEG 0.85
      const img = new Image()
      img.onerror = () => reject(new Error('图片解析失败'))
      img.onload = () => {
        let w = img.width
        let h = img.height
        if (w > MAX_IMAGE_DIM || h > MAX_IMAGE_DIM) {
          const scale = Math.min(MAX_IMAGE_DIM / w, MAX_IMAGE_DIM / h)
          w = Math.round(w * scale)
          h = Math.round(h * scale)
        }
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('无法处理图片'))
          return
        }
        ctx.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      }
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  })
}

// ---------- TTS 朗读（AI 回复播放 / 自动朗读 / 音色设置） ----------

/** 自动朗读开关的服务端 KV key（/api/state，value: 'on' | 'off'）。 */
const autoSpeakKey = (mode: 'supervise' | 'ask') => `chat:autospeak:${mode}`

/** 轻量剥离 markdown 语法用于朗读：去代码围栏标记/图片/链接/强调等，保留文字。 */
function speakableText(raw: string): string {
  let t = raw || ''
  // 交互式 ask 卡片（JSON）整块跳过，不朗读
  t = t.replace(/```ask[ \t]*\r?\n?[\s\S]*?```/g, ' ')
  // 其余代码围栏：去掉围栏标记，保留内容文字
  t = t.replace(/```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/g, '$1')
  // 图片 → 去掉；链接 → 保留文字
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 标题 / 引用 / 列表标记
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  t = t.replace(/^\s*>\s?/gm, '')
  t = t.replace(/^\s*[-*+]\s+/gm, '')
  // 粗斜体 / 行内代码
  t = t.replace(/(\*\*|__)(.*?)\1/g, '$2')
  t = t.replace(/(\*|_)(.*?)\1/g, '$2')
  t = t.replace(/`([^`]+)`/g, '$1')
  // 表格竖线
  t = t.replace(/\|/g, ' ')
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function sortVoicesZhFirst(a: SpeechSynthesisVoice, b: SpeechSynthesisVoice): number {
  const az = a.lang.toLowerCase().startsWith('zh') ? 0 : 1
  const bz = b.lang.toLowerCase().startsWith('zh') ? 0 : 1
  if (az !== bz) return az - bz
  return a.name.localeCompare(b.name)
}

/** 加载系统 speechSynthesis 音色（中文优先，SSR 安全，监听 voiceschanged）。 */
function useBrowserVoiceList(active: boolean): SpeechSynthesisVoice[] {
  const [voices, setVoices] = React.useState<SpeechSynthesisVoice[]>([])
  React.useEffect(() => {
    if (!active) return
    const synth = window.speechSynthesis
    if (!synth) return
    const load = () => {
      const vs = synth.getVoices()
      if (vs.length > 0) setVoices([...vs].sort(sortVoicesZhFirst))
    }
    load()
    synth.addEventListener('voiceschanged', load)
    return () => {
      synth.removeEventListener('voiceschanged', load)
    }
  }, [active])
  return voices
}

// ---------- ask question card ----------

function AskCard({
  ask,
  answered,
  busy,
  onSend,
}: {
  ask: AskBlock
  /** Text chosen by the user, when this card has been answered. */
  answered?: string
  busy: boolean
  onSend: (text: string) => void
}) {
  const [custom, setCustom] = React.useState('')
  const done = typeof answered === 'string'

  const submitCustom = () => {
    const t = custom.trim()
    if (!t || done || busy) return
    onSend(t)
  }

  return (
    <div
      className={cn(
        'w-[85%] rounded-2xl border-2 p-3 transition-colors',
        done
          ? 'border-emerald-600/30 bg-emerald-500/5'
          : 'border-emerald-500/60 bg-emerald-500/5 shadow-sm',
      )}
      aria-label="AI 提问卡片"
    >
      {done ? (
        // 已回答后折叠为单行提示：不再持续展示问题/选项/输入框，
        // 避免每次渲染都像「弹出提问框」一样重新冒出来。
        <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
          <Check className="size-3.5 shrink-0" strokeWidth={2.5} />
          <span className="min-w-0 break-words">已回答：{answered}</span>
        </div>
      ) : (
        <>
          <div className="mb-2 flex items-start gap-2">
            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
              <Sparkles className="size-3.5" strokeWidth={2} />
            </span>
            <p className="text-sm font-medium leading-relaxed">{ask.question}</p>
          </div>
          <div className="space-y-1.5">
            {ask.options.map((opt) => (
              <button
                key={opt}
                type="button"
                disabled={busy}
                onClick={() => onSend(opt)}
                className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2 text-left text-sm transition-colors hover:border-emerald-500/60 hover:bg-emerald-500/10 disabled:pointer-events-none disabled:opacity-50 sm:min-h-0"
              >
                <span className="min-w-0 break-words">{opt}</span>
              </button>
            ))}
          </div>
          <form
            className="mt-2 flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              submitCustom()
            }}
          >
            <Input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onFocus={keepInputVisible}
              placeholder="自定义回答…"
              disabled={busy}
              className="h-10 bg-card text-xs sm:h-8"
              aria-label="自定义回答"
            />
            <VoiceInput
              size="sm"
              context="ask"
              disabled={busy}
              className={TOUCH_MIC}
              onText={(t) => setCustom((p) => (p ? p + t : t))}
            />
            <Button
              type="submit"
              size="icon"
              className={TOUCH_XS}
              disabled={busy || !custom.trim()}
              aria-label="发送自定义回答"
            >
              <Send className="size-3.5" />
            </Button>
          </form>
        </>
      )}
    </div>
  )
}

// ---------- main component ----------

export function ChatTool({
  mode,
  content,
  allowImages = false,
  cardId,
  settings,
}: ChatToolProps) {
  const [messages, setMessages] = React.useState<UIMessage[]>([])
  const [askAnswered, setAskAnswered] = React.useState<Record<string, string>>({})
  const [copiedId, setCopiedId] = React.useState<string | null>(null)
  const [input, setInput] = React.useState('')
  const [pending, setPending] = React.useState<PendingImage[]>([])
  const [loading, setLoading] = React.useState(false)
  /** 服务端历史是否已加载完成（防止自动打招呼与历史重复）。 */
  const [historyReady, setHistoryReady] = React.useState(false)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const seededRef = React.useRef(false)
  const copyTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const idRef = React.useRef(0)

  // ---------- 移动端软键盘适配 ----------
  // 键盘弹出压缩 visualViewport 时把面板高度等量收窄，输入框始终可见
  // （layout viewport 不随键盘变化，仅靠 CSS 无法解决，需 JS 补偿）。
  const [kbOffset, setKbOffset] = React.useState(0)
  React.useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => {
      const hidden = Math.max(
        0,
        Math.round(window.innerHeight - vv.height - vv.offsetTop),
      )
      setKbOffset(hidden)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])

  const stateKey = React.useMemo(
    () => (cardId ? `chat:ask:${mode}:${cardId}` : ''),
    [mode, cardId],
  )

  // ---------- TTS 朗读 ----------
  // settings 优先用父级传入；未传时自行拉取一次（useSettingsLite）。
  const fallbackSettings = useSettingsLite()
  const effectiveSettings = settings !== undefined ? settings : fallbackSettings
  const voiceCtx = mode // 'ask' | 'supervise' — 与 voicePrefs 上下文 key 一致
  const tts = useQuickTts(voiceCtx, effectiveSettings)
  /** 正在朗读的消息 id（用于切换播放/暂停图标）。 */
  const [speakingId, setSpeakingId] = React.useState<string | null>(null)
  /** 自动朗读：默认关闭（避免打扰），尊重服务端记忆。 */
  const [autoSpeak, setAutoSpeak] = React.useState(false)
  const autoSpeakRef = React.useRef(false)
  const [voiceOpen, setVoiceOpen] = React.useState(false)
  const voiceDirtyRef = React.useRef(false)
  const browserVoices = useBrowserVoiceList(voiceOpen && tts.pref.provider === 'browser')

  // 朗读结束 / 失败 → 清除播放中图标
  React.useEffect(() => {
    if (!tts.speaking) setSpeakingId(null)
  }, [tts.speaking])

  // 加载自动朗读开关（服务端记忆，默认关）
  React.useEffect(() => {
    let alive = true
    void (async () => {
      const values = await getState([autoSpeakKey(mode)])
      if (!alive) return
      const on = values[autoSpeakKey(mode)] === 'on'
      setAutoSpeak(on)
      autoSpeakRef.current = on
    })()
    return () => {
      alive = false
    }
  }, [mode])

  const toggleAutoSpeak = () => {
    const next = !autoSpeak
    setAutoSpeak(next)
    autoSpeakRef.current = next
    void putState(autoSpeakKey(mode), next ? 'on' : 'off')
  }

  const speakMessage = (m: UIMessage) => {
    if (speakingId === m.id) {
      tts.stop()
      setSpeakingId(null)
      return
    }
    tts.stop()
    const text = speakableText(m.content)
    if (!text) {
      toast.error('没有可朗读的内容')
      return
    }
    setSpeakingId(m.id)
    tts.speak(text)
  }

  const changeTtsPref = (p: QuickTtsPref) => {
    voiceDirtyRef.current = true
    tts.setPref(p)
  }

  // 关闭音色设置弹层时提交保存：PATCH 该上下文的完整合并 voicePrefs
  // （服务端按上下文整体替换，必须带上原 asr 等字段），并广播
  // sb-voice-prefs-changed 让父级应用同步状态。
  const handleVoiceOpenChange = (open: boolean) => {
    setVoiceOpen(open)
    if (open || !voiceDirtyRef.current) return
    voiceDirtyRef.current = false
    const p = tts.pref
    const ctx = voiceCtx
    const ttsPref: VoicePrefTTS = {
      provider: p.provider,
      voice: p.provider === 'browser' ? '' : p.voice.trim(),
      speed: p.speed,
      ...(p.provider === 'browser' && p.voiceURI ? { voiceURI: p.voiceURI } : {}),
    }
    void (async () => {
      try {
        const res = await fetch('/api/settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            voicePrefs: {
              [ctx]: { ...(effectiveSettings?.voicePrefs?.[ctx] ?? {}), tts: ttsPref },
            },
          }),
        })
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(err.error || '保存失败')
        }
        window.dispatchEvent(
          new CustomEvent('sb-voice-prefs-changed', {
            detail: { context: ctx, tts: ttsPref },
          }),
        )
        toast.success('音色设置已保存')
      } catch (err) {
        toast.error('保存音色设置失败：' + (err instanceof Error ? err.message : '未知错误'))
      }
    })()
  }

  React.useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    }
  }, [])

  // ---------- 服务端历史加载 ----------
  React.useEffect(() => {
    if (!cardId) {
      setHistoryReady(true)
      return
    }
    let alive = true
    setHistoryReady(false)
    seededRef.current = false
    const key = stateKey
    ;(async () => {
      try {
        const res = await fetch(
          `/api/chat-log?cardId=${encodeURIComponent(cardId)}&mode=${mode}`,
        )
        if (!res.ok) return
        const data = (await res.json()) as { messages?: ServerChatMsg[] }
        if (!alive) return
        const list: UIMessage[] = (data.messages || []).map((m) => ({
          id: m.id,
          sid: m.id,
          role: m.role,
          content: m.content,
          ...(m.images && m.images.length > 0 ? { images: m.images } : {}),
        }))
        setMessages(list)
        if (list.length > 0) seededRef.current = true // 有历史则不再自动打招呼
        // AI 提问卡的已回答状态
        if (key) {
          const stRes = await fetch(`/api/state?key=${encodeURIComponent(key)}`)
          if (stRes.ok) {
            const st = (await stRes.json()) as { values?: Record<string, string | null> }
            const raw = st.values?.[key]
            if (raw) {
              try {
                const parsed = JSON.parse(raw) as Record<string, string>
                if (alive && parsed && typeof parsed === 'object') setAskAnswered(parsed)
              } catch {}
            }
          }
        }
      } catch {
        /* 加载失败 → 空对话，不影响使用 */
      } finally {
        if (alive) setHistoryReady(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [cardId, mode, stateKey])

  // 已回答状态同步到服务端
  React.useEffect(() => {
    if (!stateKey || !historyReady) return
    void fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: stateKey, value: JSON.stringify(askAnswered) }),
    }).catch(() => {})
  }, [askAnswered, stateKey, historyReady])

  const send = React.useCallback(
    async (text: string, images: string[] = []) => {
      let trimmed = text.trim()
      const imgs = allowImages ? images.filter(Boolean) : []
      // allow sending images without any text
      if (!trimmed && imgs.length > 0) {
        trimmed = '请看这些图片并结合课文回答'
      }
      if (!trimmed) return
      if (!content.trim()) {
        toast.error('请先选择一张有内容的背书卡')
        return
      }
      idRef.current += 1
      const userMsg: UIMessage = {
        id: `u-${idRef.current}-${Date.now().toString(36)}`,
        role: 'user',
        content: trimmed,
        ...(imgs.length > 0 ? { images: imgs } : {}),
      }
      const nextMessages: UIMessage[] = [...messages, userMsg]
      setMessages(nextMessages)
      setInput('')
      setPending([])
      setLoading(true)
      try {
        // supervise mode (allowImages=false) strips images entirely
        const payload: ChatMessage[] = nextMessages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(allowImages && m.images && m.images.length > 0
            ? { images: m.images }
            : {}),
        }))
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, messages: payload, content }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || '请求失败')
        }
        const data = (await res.json()) as { reply: string }
        const reply = (data.reply || '').trim() || '（无回复）'
        idRef.current += 1
        const aiMsg: UIMessage = {
          id: `a-${idRef.current}-${Date.now().toString(36)}`,
          role: 'assistant',
          content: reply,
        }
        setMessages((prev) => [...prev, aiMsg])
        // 自动朗读（仅朗读新回复，不读历史；默认关闭）
        if (autoSpeakRef.current && reply !== '（无回复）') {
          setSpeakingId(aiMsg.id)
          tts.speak(speakableText(reply))
        }
        // 服务端持久化（user + assistant 两条）；失败静默，不影响使用
        if (cardId) {
          void (async () => {
            const sidU = await persistMessage(cardId, mode, userMsg)
            if (sidU) {
              setMessages((prev) =>
                prev.map((x) => (x.id === userMsg.id ? { ...x, sid: sidU } : x)),
              )
            }
            const sidA = await persistMessage(cardId, mode, aiMsg)
            if (sidA) {
              setMessages((prev) =>
                prev.map((x) => (x.id === aiMsg.id ? { ...x, sid: sidA } : x)),
              )
            }
          })()
        }
      } catch (err) {
        toast.error(
          mode === 'supervise' ? '督背请求失败' : '提问请求失败',
        )
        toast.error(
          err instanceof Error ? err.message : '未知错误',
        )
      } finally {
        setLoading(false)
      }
    },
    [messages, content, mode, allowImages, tts.speak],
  )

  // Auto-seed a greeting for supervise mode（仅在服务端历史为空时）
  React.useEffect(() => {
    if (!historyReady) return
    if (seededRef.current) return
    if (!content.trim()) return
    if (mode === 'supervise' && messages.length === 0) {
      seededRef.current = true
      void send('开始背诵吧，请引导我。')
    } else {
      seededRef.current = true
    }
  }, [historyReady, mode, content, messages.length, send])

  React.useEffect(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, loading, kbOffset])

  const removePending = (id: string) => {
    setPending((prev) => prev.filter((p) => p.id !== id))
  }

  const handleFilesChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // allow re-picking the same file
    if (files.length === 0) return
    const room = MAX_IMAGES - pending.length
    if (room <= 0) {
      toast.warning(`每条消息最多 ${MAX_IMAGES} 张图片`)
      return
    }
    if (files.length > room) {
      toast.warning(`每条消息最多 ${MAX_IMAGES} 张图片，已保留前 ${room} 张`)
    }
    const chosen = files.slice(0, room)
    const results = await Promise.allSettled(
      chosen.map((f) => processImageFile(f)),
    )
    const urls: string[] = []
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        urls.push(r.value)
      } else {
        toast.error(`第 ${i + 1} 张图片处理失败`)
      }
    })
    if (urls.length > 0) {
      setPending((prev) => [
        ...prev,
        ...urls.map((dataUrl) => {
          idRef.current += 1
          return { id: `img-${idRef.current}`, dataUrl }
        }),
      ])
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (loading) return
    const images = allowImages ? pending.map((p) => p.dataUrl) : []
    void send(input, images)
  }

  // ---------- per-reply actions ----------

  const copyReply = async (m: UIMessage) => {
    try {
      await navigator.clipboard.writeText(m.content)
      setCopiedId(m.id)
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopiedId(null), 1600)
    } catch {
      toast.error('复制失败')
    }
  }

  /** Delete an assistant reply together with the adjacent (preceding) user message. */
  const deleteReply = (idx: number) => {
    const target = messages[idx]
    if (!target || target.role !== 'assistant') return
    const prevUser = idx > 0 && messages[idx - 1]?.role === 'user' ? messages[idx - 1] : null
    if (speakingId === target.id) tts.stop() // 停掉正在朗读的被删回复
    setMessages((prev) => {
      const next = [...prev]
      next.splice(idx, 1)
      if (prevUser) next.splice(idx - 1, 1)
      return next
    })
    // 已回答状态按 question 记忆 — 清理被删回复中 ask 卡片对应的键
    setAskAnswered((prev) => {
      const keys = splitAskSegments(target.content).flatMap((s) =>
        s.kind === 'ask' ? [s.ask.question] : [],
      )
      const usable = keys.filter((q) => q in prev)
      if (usable.length === 0) return prev
      const next = { ...prev }
      for (const q of usable) delete next[q]
      return next
    })
    // 同步删除服务端记录
    for (const sid of [target.sid, prevUser?.sid]) {
      if (sid) {
        void fetch(`/api/chat-log?id=${encodeURIComponent(sid)}`, {
          method: 'DELETE',
        }).catch(() => {})
      }
    }
  }

  const clearConversation = () => {
    tts.stop() // 清空时停掉朗读，避免孤儿播放
    setMessages([])
    setAskAnswered({})
    // 允许督背模式在清空后重新自动打招呼
    seededRef.current = false
    if (cardId) {
      void fetch(
        `/api/chat-log?cardId=${encodeURIComponent(cardId)}&mode=${mode}`,
        { method: 'DELETE' },
      ).catch(() => {})
      if (stateKey) {
        void fetch(`/api/state?key=${encodeURIComponent(stateKey)}`, {
          method: 'DELETE',
        }).catch(() => {})
      }
    }
    toast.success('对话已清空')
  }

  // ---------- ask card plumbing ----------

  // askAnswered 以 question 文本为键（而非消息 id）— 刷新/重载后消息 id
  // 会变成服务端行 id，按 question 记忆才能让「已回答」状态跨会话生效。
  const handleAskSend = (question: string, text: string) => {
    setAskAnswered((prev) => ({ ...prev, [question]: text }))
    void send(text)
  }

  return (
    <div
      className="flex h-[60vh] flex-col gap-3"
      style={
        kbOffset > 0 ? { height: `calc(60vh - ${kbOffset}px)` } : undefined
      }
    >
      {/* 顶部工具条：自动朗读开关 + 音色设置 */}
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={toggleAutoSpeak}
          aria-pressed={autoSpeak}
          aria-label={autoSpeak ? '关闭自动朗读' : '开启自动朗读'}
          title={autoSpeak ? '关闭自动朗读' : '开启自动朗读'}
          className={cn(
            'flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors',
            HIT_AREA,
            autoSpeak
              ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          {autoSpeak ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
          自动朗读
        </button>
        <Popover open={voiceOpen} onOpenChange={handleVoiceOpenChange}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="音色设置"
              title="音色设置"
              className={cn(
                'flex size-8 items-center justify-center rounded-full border transition-colors',
                HIT_AREA,
                voiceOpen
                  ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <Settings2 className="size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 rounded-2xl">
            <div className="flex flex-col gap-3">
              <p className="text-sm font-semibold">朗读音色</p>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">引擎</Label>
                <Select
                  value={tts.pref.provider}
                  onValueChange={(v) =>
                    changeTtsPref({ ...tts.pref, provider: v as VoiceProvider })
                  }
                >
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="zai">AI云端</SelectItem>
                    <SelectItem value="custom">自定义API</SelectItem>
                    <SelectItem value="browser">浏览器</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {tts.pref.provider === 'zai' && (
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">音色</Label>
                  <Select
                    value={tts.pref.voice}
                    onValueChange={(v) => changeTtsPref({ ...tts.pref, voice: v })}
                  >
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
              {tts.pref.provider === 'custom' && (
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">音色</Label>
                  <Input
                    value={tts.pref.voice}
                    onChange={(e) => changeTtsPref({ ...tts.pref, voice: e.target.value })}
                    placeholder="音色名，如 alloy / nova"
                    className="h-9"
                  />
                </div>
              )}
              {tts.pref.provider === 'browser' && (
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">系统语音</Label>
                  {browserVoices.length > 0 ? (
                    <Select
                      value={tts.pref.voiceURI ?? ''}
                      onValueChange={(v) => changeTtsPref({ ...tts.pref, voiceURI: v })}
                    >
                      <SelectTrigger className="h-9 w-full">
                        <SelectValue placeholder="选择系统语音" />
                      </SelectTrigger>
                      <SelectContent>
                        {browserVoices.map((v) => (
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
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-muted-foreground">朗读速度</Label>
                  <span className="text-xs font-medium tabular-nums">
                    {tts.pref.speed.toFixed(
                      tts.pref.speed === Math.floor(tts.pref.speed) ? 1 : 2,
                    )}
                    x
                  </span>
                </div>
                <Slider
                  value={[tts.pref.speed]}
                  min={0.5}
                  max={3}
                  step={0.05}
                  aria-label="朗读速度"
                  onValueChange={(vals) =>
                    changeTtsPref({ ...tts.pref, speed: clampSpeed(vals[0]) })
                  }
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>0.5x</span>
                  <span>3x</span>
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                更改在关闭弹层时保存为「{mode === 'supervise' ? 'AI 督背' : 'AI 问问'}」默认音色
              </p>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto rounded-md [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:min-h-6 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent"
      >
        <div className="flex flex-col gap-3 p-1">
          {messages.length > 0 && (
            <div className="flex justify-end">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'flex items-center gap-1 rounded-full px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                      HIT_AREA_LG,
                    )}
                  >
                    <Trash2 className="size-3.5" strokeWidth={1.75} />
                    清空对话
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>清空对话</AlertDialogTitle>
                    <AlertDialogDescription>
                      确定清空全部对话记录吗？此操作无法恢复。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={clearConversation}
                      className="bg-red-600 text-white hover:bg-red-700"
                    >
                      清空
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}

          {messages.length === 0 && !loading && (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
              <MessageCircleQuestion className="size-8 text-muted-foreground/40" />
              {mode === 'supervise'
                ? 'AI 督背老师将引导你逐句背诵，准备好后说「开始」。'
                : allowImages
                  ? '对课文有疑问？尽管问 AI，也可以附上课本照片。'
                  : '对课文有疑问？尽管问 AI。'}
            </div>
          )}

          {messages.map((m, idx) => (
            <div
              key={m.id}
              className={cn(
                'flex w-full',
                m.role === 'user' ? 'justify-end' : 'justify-start',
              )}
            >
              {m.role === 'user' ? (
                <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm leading-relaxed text-primary-foreground">
                  {m.images && m.images.length > 0 && (
                    <div className="mb-1.5 flex max-w-[200px] flex-wrap gap-1.5">
                      {m.images.map((src, i) => (
                        <img
                          key={i}
                          src={src}
                          alt="附图"
                          className="h-16 w-16 rounded-lg object-cover"
                        />
                      ))}
                    </div>
                  )}
                  {m.content}
                </div>
              ) : (
                <div className="flex w-full flex-col items-start gap-1">
                  {splitAskSegments(m.content).map((seg, i) =>
                    seg.kind === 'ask' ? (
                      <AskCard
                        key={i}
                        ask={seg.ask}
                        answered={askAnswered[seg.ask.question]}
                        busy={loading}
                        onSend={(text) => handleAskSend(seg.ask.question, text)}
                      />
                    ) : seg.value.trim() ? (
                      <RichContent
                        key={i}
                        content={seg.value}
                        className="max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3 py-2"
                        maxHeight={REPLY_MAX_H}
                      />
                    ) : null,
                  )}
                  {/* reply actions: speak / copy / delete */}
                  <div className="ml-1 flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => speakMessage(m)}
                      aria-label={speakingId === m.id ? '停止朗读' : '朗读该回复'}
                      title={speakingId === m.id ? '停止朗读' : '朗读该回复'}
                      className={cn(
                        'flex size-7 items-center justify-center rounded-lg transition-colors hover:bg-accent',
                        HIT_AREA,
                        speakingId === m.id
                          ? 'text-emerald-600'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {speakingId === m.id ? (
                        <Pause className="size-3.5" strokeWidth={2} />
                      ) : (
                        <Volume2 className="size-3.5" strokeWidth={1.75} />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => void copyReply(m)}
                      aria-label="复制该回复"
                      className={cn(
                        'flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                        HIT_AREA,
                      )}
                    >
                      {copiedId === m.id ? (
                        <Check className="size-3.5 text-emerald-600" strokeWidth={2} />
                      ) : (
                        <Copy className="size-3.5" strokeWidth={1.75} />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteReply(idx)}
                      aria-label="删除该回复（连带相邻提问）"
                      className={cn(
                        'flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-red-600',
                        HIT_AREA,
                      )}
                    >
                      <Trash2 className="size-3.5" strokeWidth={1.75} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm bg-muted px-3 py-2">
                <Dot delay="0ms" />
                <Dot delay="150ms" />
                <Dot delay="300ms" />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* pending image thumbnails */}
      {allowImages && pending.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1">
          {pending.map((p) => (
            <div key={p.id} className="relative">
              <img
                src={p.dataUrl}
                alt="待发送图片"
                className="size-16 rounded-lg border object-cover"
              />
              <button
                type="button"
                onClick={() => removePending(p.id)}
                aria-label="移除图片"
                className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-destructive text-white shadow after:absolute after:-inset-3 after:rounded-[inherit] after:content-['']"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        {allowImages && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={handleFilesChange}
            />
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label="添加图片"
              className={TOUCH_SM}
              onClick={() => fileInputRef.current?.click()}
              disabled={loading || pending.length >= MAX_IMAGES}
            >
              <ImagePlus className="size-4" />
            </Button>
          </>
        )}
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={keepInputVisible}
          placeholder={
            mode === 'supervise'
              ? '回复督背老师…（可语音输入）'
              : '输入你的问题…（可语音输入）'
          }
          disabled={loading}
        />
        {/* 语音输入：识别结果追加到输入框 */}
        <VoiceInput
          size="sm"
          variant="outline"
          context={mode === 'supervise' ? 'supervise' : 'ask'}
          disabled={loading}
          className={TOUCH_MIC}
          onText={(t) => setInput((prev) => (prev ? prev + t : t))}
        />
        <Button
          type="submit"
          size="icon"
          className={TOUCH_SM}
          disabled={loading || (!input.trim() && pending.length === 0)}
          aria-label="发送"
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
        </Button>
      </form>
    </div>
  )
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="size-1.5 animate-bounce rounded-full bg-muted-foreground/70"
      style={{ animationDelay: delay }}
    />
  )
}
