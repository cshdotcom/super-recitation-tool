'use client'

// ChatTool — AI督背 (supervise) & AI问问 (ask) chat panel.
// Features:
//   • 服务端持久化：全部对话（含附图）存 SQLite（/api/chat-log），
//     切卡片/刷新/换设备均从服务端加载历史；删除/清空同步服务端。
//   • 对话模式（conversationId prop，/api/conversations）：侧边栏对话的
//     载入/发送/批量入库/自动重命名；头部提供侧边栏开关、对话内搜索、
//     新建对话、更多（分享/导出/重命名/清空）；监听 app:chatSend /
//     app:newConversation 窗口事件；AI 回复的 <thinking> 块渲染为可折叠
//     「💭 思考过程」；追问弹层新建对话后自动补一条 AI 回复。
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
  Brain,
  Check,
  ChevronRight,
  Copy,
  Download,
  ImagePlus,
  Loader2,
  MessageCircleQuestion,
  MoreVertical,
  PanelLeft,
  Pause,
  Pencil,
  Plus,
  Search,
  Send,
  Settings2,
  Share2,
  Sparkles,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { VoiceInput } from '@/components/recitation/voice-input'
import {
  convTypeMeta,
  exportConversation,
  shareConversationLink,
  type ConversationSummary,
} from '@/components/recitation/chat-sidebar'
import { FOLLOWUP_THINKING_KEY } from '@/components/recitation/followup-popover'

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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const MAX_IMAGES = 4
/** Files smaller than this keep their original data URL; larger get compressed. */
const COMPRESS_OVER = 300 * 1024
const MAX_IMAGE_DIM = 1024
/** Assistant bubble internal scroll cap (px). */
const REPLY_MAX_H = 320
/** 对话模式：传给 /api/chat 的最近消息窗口（含本次提问）。 */
const CONV_CONTEXT_WINDOW = 12
/** 对话打开时，末尾未回复的用户消息在多久内才自动补 AI 回复（追问场景）。 */
const AUTO_REPLY_FRESH_MS = 5 * 60 * 1000

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
  /**
   * 对话模式：绑定 /api/conversations 的对话 id（侧边栏对话）。
   * 设置后历史从 /api/conversations/:id 载入，消息成对入库，
   * 持久化优先于 cardId 的 ChatLog 通道。
   */
  conversationId?: string
  /** 侧边栏开关回调；未传时 dispatch window 'app:toggleChatSidebar'。 */
  onOpenSidebar?: () => void
  /** 活动对话变化通知（组件内新建/切换对话后上报 page.tsx）。 */
  onConversationChange?: (id: string | null) => void
}

interface UIMessage {
  id: string
  /** 服务端 ChatLog 行 id（历史消息与已同步的新消息）。 */
  sid?: string
  role: 'user' | 'assistant'
  content: string
  images?: string[]
  /** 对话模式：服务端消息时间（自动补回复的新鲜度判断用）。 */
  createdAt?: string
}

interface ServerChatMsg {
  id: string
  role: 'user' | 'assistant'
  content: string
  images?: string[]
}

/** /api/conversations/:id 返回的消息行。 */
interface ServerConvMsg {
  id: string
  role: 'user' | 'assistant'
  content: string
  images?: string[]
  createdAt: string
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

/** 拆出 AI 回复开头的 <thinking>…</thinking> 自我思考块（容错未闭合）。 */
function splitThinking(raw: string): { thinking: string; body: string } {
  const closed = raw.match(/<thinking>([\s\S]*?)<\/thinking>/i)
  if (closed && closed.index !== undefined) {
    const body = (raw.slice(0, closed.index) + raw.slice(closed.index + closed[0].length)).trim()
    return { thinking: closed[1].trim(), body }
  }
  const open = raw.match(/<thinking>([\s\S]*)$/i)
  if (open && open.index !== undefined) {
    return { thinking: open[1].trim(), body: raw.slice(0, open.index).trim() }
  }
  return { thinking: '', body: raw }
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
  // 自我思考块整块跳过，不朗读
  t = t.replace(/<thinking>[\s\S]*?(<\/thinking>|$)/gi, ' ')
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

// ---------- thinking disclosure ----------

/** AI 回复的 <thinking> 块 → 可折叠「💭 思考过程」（默认收起）。 */
function ThinkingBlock({ text }: { text: string }) {
  return (
    <Collapsible className="w-[85%]">
      <CollapsibleTrigger className="group flex items-center gap-1.5 rounded-full border border-violet-400/30 bg-violet-500/5 px-2.5 py-1 text-xs text-violet-600 transition-colors hover:bg-violet-500/10 dark:text-violet-300">
        <Brain className="size-3.5" strokeWidth={2} />
        思考过程
        <ChevronRight
          className="size-3.5 transition-transform group-data-[state=open]:rotate-90"
          strokeWidth={2}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-violet-400/20 bg-violet-500/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border">
          {text}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

// ---------- main component ----------

export function ChatTool({
  mode,
  content,
  allowImages = false,
  cardId,
  settings,
  conversationId,
  onOpenSidebar,
  onConversationChange,
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

  // ---------- 对话模式（conversationId，/api/conversations） ----------
  // 有效对话 id：组件内新建的（Plus/侧边栏事件）优先，其次 prop。
  const [localConvId, setLocalConvId] = React.useState<string | null>(null)
  const convId = localConvId ?? conversationId ?? null
  const inConvMode = !!convId
  const convIdRef = React.useRef<string | null>(null)
  convIdRef.current = convId
  /** 对话元信息（标题/类型/cardId）。 */
  const [convMeta, setConvMeta] = React.useState<ConversationSummary | null>(null)
  const convMetaRef = React.useRef<ConversationSummary | null>(null)
  convMetaRef.current = convMeta
  /** 对话来源卡片内容缓存（cardId → content）。 */
  const convCardContentRef = React.useRef<Map<string, string>>(new Map())
  /** 对话内搜索。 */
  const [convSearchOpen, setConvSearchOpen] = React.useState(false)
  const [convSearchQ, setConvSearchQ] = React.useState('')
  const [convSearching, setConvSearching] = React.useState(false)
  const [convSearchHits, setConvSearchHits] = React.useState<
    { messageId: string; snippet: string; role: string; createdAt: string }[]
  >([])
  /** 搜索定位高亮的消息 id。 */
  const [highlightId, setHighlightId] = React.useState<string | null>(null)
  const highlightTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 图片放大预览。 */
  const [zoomImage, setZoomImage] = React.useState<string | null>(null)
  /** 重命名 / 清空确认。 */
  const [renameOpen, setRenameOpen] = React.useState(false)
  const [renameValue, setRenameValue] = React.useState('')
  const [renaming, setRenaming] = React.useState(false)
  const [confirmClearOpen, setConfirmClearOpen] = React.useState(false)
  /** 自动补回复的一次性开关（防止重复触发）。 */
  const autoRepliedRef = React.useRef<string | null>(null)

  // prop 绑定的对话变化时清除组件内覆盖（避免旧 override 遮蔽新对话）
  React.useEffect(() => {
    setLocalConvId(null)
  }, [conversationId])

  // 活动对话变化上报（page.tsx 用于标题 / FollowupPopover 当前对话判断）
  React.useEffect(() => {
    onConversationChange?.(convId)
  }, [convId, onConversationChange])

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
    () =>
      convId
        ? `chat:conv:${mode}:${convId}`
        : cardId
          ? `chat:ask:${mode}:${cardId}`
          : '',
    [convId, mode, cardId],
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
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    }
  }, [])

  // ---------- 对话模式：内容解析 / 请求 / 入库 ----------

  /** 解析 /api/chat 的 content：优先对话来源卡片内容，回退对话首条用户消息 / 本次提问。 */
  const resolveConvContent = React.useCallback(
    async (fallbackText: string, list: UIMessage[] = []): Promise<string> => {
      const meta = convMetaRef.current
      const convCardId = meta?.cardId ?? ''
      // 对话未绑卡片，或绑定的就是当前传入卡 → 直接用父级 content
      if (!convCardId || (cardId && convCardId === cardId)) {
        if (content.trim()) return content
      } else {
        // 对话绑定了其他卡片 → 拉取该卡内容（带缓存）
        const cached = convCardContentRef.current.get(convCardId)
        if (cached !== undefined) {
          if (cached.trim()) return cached
        } else {
          try {
            const res = await fetch(`/api/cards/${encodeURIComponent(convCardId)}`)
            if (res.ok) {
              const card = (await res.json()) as { content?: string }
              const c = typeof card?.content === 'string' ? card.content : ''
              convCardContentRef.current.set(convCardId, c)
              if (c.trim()) return c
            } else {
              convCardContentRef.current.set(convCardId, '')
            }
          } catch {
            /* 拉取失败走回退 */
          }
        }
      }
      // 回退：对话首条用户消息
      const firstUser = list.find((m) => m.role === 'user')
      if (firstUser?.content.trim()) return firstUser.content
      // 最后回退：本次提问文本
      return fallbackText
    },
    [cardId, content],
  )

  /** /api/chat 请求核心（对话模式与追问共用）。 */
  const requestReply = React.useCallback(
    async (
      windowMsgs: UIMessage[],
      effContent: string,
      selfThinking?: boolean,
    ): Promise<string> => {
      // supervise mode (allowImages=false) strips images entirely
      const payload: ChatMessage[] = windowMsgs.map((m) => ({
        role: m.role,
        content: m.content,
        ...(allowImages && m.images && m.images.length > 0
          ? { images: m.images }
          : {}),
      }))
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          messages: payload,
          content: effContent,
          ...(typeof selfThinking === 'boolean' ? { selfThinking } : {}),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '请求失败')
      }
      const data = (await res.json()) as { reply: string }
      return (data.reply || '').trim() || '（无回复）'
    },
    [mode, allowImages],
  )

  /** 对话消息批量入库；成功后回填服务端 id。 */
  const persistConvMessages = React.useCallback(
    async (cid: string, msgs: UIMessage[]): Promise<void> => {
      try {
        const res = await fetch(`/api/conversations/${encodeURIComponent(cid)}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: msgs.map((m) => ({
              role: m.role,
              content: m.content,
              ...(m.images && m.images.length > 0 ? { images: m.images } : {}),
            })),
          }),
        })
        if (!res.ok) return
        const data = (await res.json()) as { messages?: { id: string }[] }
        const created = data.messages ?? []
        if (created.length === msgs.length) {
          setMessages((prev) =>
            prev.map((x) => {
              const i = msgs.findIndex((m) => m.id === x.id)
              return i >= 0 && created[i]?.id ? { ...x, sid: created[i].id } : x
            }),
          )
        }
      } catch {
        /* 入库失败静默（本地对话不受影响） */
      }
    },
    [],
  )

  /** 首次问答后自动 AI 重命名（消息数≥2 且标题仍为默认「新对话」）。 */
  const maybeAutoRename = React.useCallback(
    async (cid: string, prevCount: number) => {
      const meta = convMetaRef.current
      if (!meta || prevCount >= 2) return
      if (meta.title && meta.title !== '新对话') return
      try {
        const res = await fetch(`/api/conversations/${encodeURIComponent(cid)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ autoRename: true }),
        })
        if (!res.ok) return
        const data = (await res.json()) as { conversation?: ConversationSummary }
        if (data.conversation?.title) {
          setConvMeta(data.conversation)
          convMetaRef.current = data.conversation
        }
      } catch {
        /* 重命名失败静默 */
      }
    },
    [],
  )

  /** 对话模式：为末尾“未回复的用户消息”补一条 AI 回复（追问弹层新建对话后打开）。 */
  const replyToLast = React.useCallback(
    async (list: UIMessage[], selfThinking?: boolean) => {
      const cid = convIdRef.current
      if (!cid) return
      const last = list[list.length - 1]
      if (!last || last.role !== 'user') return
      setLoading(true)
      try {
        const effContent = await resolveConvContent('', list)
        const reply = await requestReply(
          list.slice(-CONV_CONTEXT_WINDOW),
          effContent,
          selfThinking,
        )
        idRef.current += 1
        const aiMsg: UIMessage = {
          id: `a-${idRef.current}-${Date.now().toString(36)}`,
          role: 'assistant',
          content: reply,
        }
        setMessages((prev) => [...prev, aiMsg])
        if (autoSpeakRef.current && reply !== '（无回复）') {
          setSpeakingId(aiMsg.id)
          tts.speak(speakableText(reply))
        }
        await persistConvMessages(cid, [aiMsg])
      } catch (err) {
        toast.error(mode === 'supervise' ? '督背请求失败' : '追问回复失败')
        toast.error(err instanceof Error ? err.message : '未知错误')
      } finally {
        setLoading(false)
      }
    },
    [mode, resolveConvContent, requestReply, persistConvMessages, tts.speak],
  )

  // 供历史加载 effect 调用（避免把 replyToLast 加进 effect 依赖导致重加载）
  const replyToLastRef = React.useRef(replyToLast)
  replyToLastRef.current = replyToLast

  /** 新建空对话（头部 Plus / 'app:newConversation' 事件），组件内切换。 */
  const createConversation = React.useCallback(
    async (type?: string) => {
      try {
        const res = await fetch('/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: type || 'chat', cardId: cardId ?? '' }),
        })
        if (!res.ok) {
          const e = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(e.error || '新建对话失败')
        }
        const data = (await res.json()) as { conversation?: ConversationSummary }
        const conv = data.conversation
        if (!conv?.id) throw new Error('新建对话失败')
        setMessages([])
        setAskAnswered({})
        setConvSearchOpen(false)
        setConvSearchQ('')
        setConvSearchHits([])
        setLocalConvId(conv.id)
        setConvMeta(conv)
        convMetaRef.current = conv
        toast.success('已新建对话')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '新建对话失败')
      }
    },
    [cardId],
  )

  // ---------- 服务端历史加载 ----------
  React.useEffect(() => {
    // ---- 对话模式：/api/conversations/:id ----
    if (convId) {
      let alive = true
      setHistoryReady(false)
      seededRef.current = false
      setConvSearchOpen(false)
      setConvSearchQ('')
      setConvSearchHits([])
      ;(async () => {
        try {
          const res = await fetch(`/api/conversations/${encodeURIComponent(convId)}`)
          if (!res.ok) return
          const data = (await res.json()) as {
            conversation?: ConversationSummary
            messages?: ServerConvMsg[]
          }
          if (!alive || !data.conversation) return
          setConvMeta(data.conversation)
          convMetaRef.current = data.conversation
          const list: UIMessage[] = (data.messages || []).map((m) => ({
            id: m.id,
            sid: m.id,
            role: m.role,
            content: m.content,
            createdAt: m.createdAt,
            ...(m.images && m.images.length > 0 ? { images: m.images } : {}),
          }))
          setMessages(list)
          if (list.length > 0) seededRef.current = true
          // 追问弹层新建的对话：末尾是刚写入的用户消息 → 自动补 AI 回复
          const last = list[list.length - 1]
          if (last && last.role === 'user' && autoRepliedRef.current !== last.id) {
            const created = last.createdAt ? Date.parse(last.createdAt) : NaN
            const fresh =
              Number.isFinite(created) && Date.now() - created <= AUTO_REPLY_FRESH_MS
            if (fresh) {
              // 读取并清除追问弹层留下的一次性「自我思考」偏好
              let think: boolean | undefined
              try {
                const flag = window.sessionStorage.getItem(FOLLOWUP_THINKING_KEY)
                if (flag === '1') think = true
                else if (flag === '0') think = false
                if (flag !== null) {
                  window.sessionStorage.removeItem(FOLLOWUP_THINKING_KEY)
                }
              } catch {
                /* 隐私模式忽略 */
              }
              autoRepliedRef.current = last.id
              // 等一次渲染（消息入 state）再请求
              window.setTimeout(() => {
                if (alive) void replyToLastRef.current(list, think)
              }, 120)
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
    }
    // ---- 卡片模式（原 ChatLog 通道） ----
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
  }, [convId, cardId, mode, stateKey])

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
    async (text: string, images: string[] = [], selfThinking?: boolean) => {
      let trimmed = text.trim()
      const imgs = allowImages ? images.filter(Boolean) : []
      // allow sending images without any text
      if (!trimmed && imgs.length > 0) {
        trimmed = '请看这些图片并结合课文回答'
      }
      if (!trimmed) return
      const cid = convIdRef.current
      if (!cid && !content.trim()) {
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
        // ---- 对话模式：最近 N 条消息 + 解析后的 content，一问一答成对入库 ----
        if (cid) {
          const effContent = await resolveConvContent(trimmed, messages)
          const reply = await requestReply(
            nextMessages.slice(-CONV_CONTEXT_WINDOW),
            effContent,
            selfThinking,
          )
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
          const prevCount = messages.length
          await persistConvMessages(cid, [userMsg, aiMsg])
          // 首次问答完成后自动 AI 重命名（消息数≥2 且标题仍为默认）
          void maybeAutoRename(cid, prevCount)
          return
        }
        // ---- 卡片/自由模式（原 ChatLog 通道） ----
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
    [
      messages,
      content,
      mode,
      allowImages,
      tts.speak,
      resolveConvContent,
      requestReply,
      persistConvMessages,
      maybeAutoRename,
    ],
  )

  // 监听 'app:chatSend'：在当前对话内追加用户消息并触发 AI 回复（追问弹层派发）。
  // 仅对话模式实例处理（携带 conversationId 时需匹配），避免工具面板的
  // cardId 模式实例重复消费同一事件。
  React.useEffect(() => {
    const onChatSend = (
      e: Event,
    ) => {
      const d = (e as CustomEvent<{ text?: string; images?: string[]; selfThinking?: boolean; conversationId?: string }>)
        .detail
      if (!d || typeof d.text !== 'string' || !d.text.trim()) return
      const cid = convIdRef.current
      if (!cid) return // 非对话模式实例不处理
      if (typeof d.conversationId === 'string' && d.conversationId && d.conversationId !== cid) {
        return // 目标对话不是本实例绑定的对话
      }
      const imgs = Array.isArray(d.images)
        ? d.images.filter((x): x is string => typeof x === 'string')
        : []
      void send(
        d.text,
        imgs,
        typeof d.selfThinking === 'boolean' ? d.selfThinking : undefined,
      )
    }
    window.addEventListener('app:chatSend', onChatSend)
    return () => {
      window.removeEventListener('app:chatSend', onChatSend)
    }
  }, [send])

  // 监听 'app:newConversation'：新建对话（本组件自建并切换；page.tsx 不应重复创建）
  React.useEffect(() => {
    const onNewConv = (e: Event) => {
      const d = (e as CustomEvent<{ type?: string }>).detail
      void createConversation(typeof d?.type === 'string' ? d.type : undefined)
    }
    window.addEventListener('app:newConversation', onNewConv)
    return () => {
      window.removeEventListener('app:newConversation', onNewConv)
    }
  }, [createConversation])

  // Auto-seed a greeting for supervise mode（仅在服务端历史为空时；对话模式不自动打招呼）
  React.useEffect(() => {
    if (!historyReady) return
    if (seededRef.current) return
    if (inConvMode) {
      seededRef.current = true
      return
    }
    if (!content.trim()) return
    if (mode === 'supervise' && messages.length === 0) {
      seededRef.current = true
      void send('开始背诵吧，请引导我。')
    } else {
      seededRef.current = true
    }
  }, [historyReady, mode, content, messages.length, send, inConvMode])

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
    const remaining: UIMessage[] = [...messages]
    remaining.splice(idx, 1)
    if (prevUser) remaining.splice(idx - 1, 1)
    setMessages(remaining)
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
    const cid = convIdRef.current
    if (cid) {
      // 对话消息无单条删除接口 → 清空后批量写回剩余消息（服务端全量重建）
      void (async () => {
        try {
          const res = await fetch(
            `/api/conversations/${encodeURIComponent(cid)}/messages`,
            { method: 'DELETE' },
          )
          if (!res.ok) return
          if (remaining.length > 0) await persistConvMessages(cid, remaining)
        } catch {
          /* 同步失败静默 */
        }
      })()
      return
    }
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
    const cid = convIdRef.current
    if (cid) {
      // 对话模式：清空该对话全部消息
      void fetch(`/api/conversations/${encodeURIComponent(cid)}/messages`, {
        method: 'DELETE',
      }).catch(() => {})
      if (stateKey) {
        void fetch(`/api/state?key=${encodeURIComponent(stateKey)}`, {
          method: 'DELETE',
        }).catch(() => {})
      }
    } else if (cardId) {
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

  // askAnswered 以 question 文本为键（而非消息 id）— 刷新/重载后消息 id
  // 会变成服务端行 id，按 question 记忆才能让「已回答」状态跨会话生效。
  const handleAskSend = (question: string, text: string) => {
    setAskAnswered((prev) => ({ ...prev, [question]: text }))
    void send(text)
  }

  // ---------- 对话模式头部操作 ----------

  const openSidebar = () => {
    if (onOpenSidebar) {
      onOpenSidebar()
    } else {
      window.dispatchEvent(new CustomEvent('app:toggleChatSidebar'))
    }
  }

  const newConversation = () => {
    // 经自身监听器创建（与侧边栏派发的 'app:newConversation' 同一通道）
    window.dispatchEvent(
      new CustomEvent('app:newConversation', {
        detail: { type: convMeta?.type || 'chat' },
      }),
    )
  }

  const runConvSearch = async () => {
    const cid = convIdRef.current
    const q = convSearchQ.trim()
    if (!cid || !q) {
      setConvSearchHits([])
      return
    }
    setConvSearching(true)
    try {
      const res = await fetch(
        `/api/conversations?q=${encodeURIComponent(q)}&conversationId=${encodeURIComponent(cid)}`,
      )
      if (!res.ok) return
      const data = (await res.json()) as {
        messageHits?: { messageId: string; snippet: string; role: string; createdAt: string }[]
      }
      setConvSearchHits(data.messageHits ?? [])
    } catch {
      /* 搜索失败保留空 */
    } finally {
      setConvSearching(false)
    }
  }

  const locateMessage = (messageId: string) => {
    const el = scrollRef.current?.querySelector(
      `[data-mid="${messageId.replace(/["'\\]/g, '')}"]`,
    )
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setHighlightId(messageId)
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
      highlightTimerRef.current = setTimeout(() => setHighlightId(null), 1800)
    } else {
      toast.info('该消息不在当前对话中')
    }
  }

  const handleConvRename = async () => {
    const cid = convIdRef.current
    const title = renameValue.trim()
    if (!cid || !title) return
    setRenaming(true)
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(cid)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      })
      if (!res.ok) throw new Error('重命名失败')
      const data = (await res.json()) as { conversation?: ConversationSummary }
      if (data.conversation) {
        setConvMeta(data.conversation)
        convMetaRef.current = data.conversation
      }
      toast.success('已重命名')
      setRenameOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重命名失败')
    } finally {
      setRenaming(false)
    }
  }

  const exportConv = async (format: 'txt' | 'md' | 'json') => {
    if (!convId || !convMeta) return
    await exportConversation(convMeta, format)
  }

  return (
    <div
      className="flex h-[60vh] flex-col gap-3"
      style={
        kbOffset > 0 ? { height: `calc(60vh - ${kbOffset}px)` } : undefined
      }
    >
      {/* 对话头部：侧边栏开关 / 标题 / 搜索 / 新建 / 更多
          （侧边栏入口与新建对话在旧版 AI问问 模式也可用，便于随时进入对话管理） */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={openSidebar}
          aria-label="打开对话列表"
          title="对话列表"
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
            HIT_AREA,
          )}
        >
          <PanelLeft className="size-4" strokeWidth={1.75} />
        </button>
        <div className="min-w-0 flex-1">
          {inConvMode ? (
            <>
              <p className="truncate text-sm font-semibold">
                {convMeta?.title || '新对话'}
              </p>
              <p className="truncate text-[11px] text-muted-foreground">
                {convTypeMeta(convMeta?.type ?? '').emoji}{' '}
                {convTypeMeta(convMeta?.type ?? '').label} · {messages.length} 条消息
              </p>
            </>
          ) : (
            <p className="truncate text-sm font-semibold">AI 问问</p>
          )}
        </div>
        {inConvMode && (
          <button
            type="button"
            onClick={() => {
              setConvSearchOpen((v) => !v)
              setConvSearchHits([])
              setConvSearchQ('')
            }}
            aria-pressed={convSearchOpen}
            aria-label="搜索本对话"
            title="搜索本对话"
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-full border transition-colors',
              HIT_AREA,
              convSearchOpen
                ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <Search className="size-4" strokeWidth={1.75} />
          </button>
        )}
          <button
            type="button"
            onClick={newConversation}
            aria-label="新建对话"
            title="新建对话"
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
              HIT_AREA,
            )}
          >
            <Plus className="size-4" strokeWidth={1.75} />
          </button>
          {inConvMode && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="更多对话操作"
                  title="更多"
                  className={cn(
                    'flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                    HIT_AREA,
                  )}
                >
                  <MoreVertical className="size-4" strokeWidth={1.75} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem
                  onClick={() => {
                    if (convId) void shareConversationLink(convId)
                  }}
                >
                  <Share2 className="size-4" />
                  分享
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Download className="size-4" />
                    导出
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem onClick={() => void exportConv('txt')}>
                      导出 TXT
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void exportConv('md')}>
                      导出 Markdown
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void exportConv('json')}>
                      导出 JSON
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem
                  onClick={() => {
                    setRenameValue(convMeta?.title ?? '')
                    setRenameOpen(true)
                  }}
                >
                  <Pencil className="size-4" />
                  重命名
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => setConfirmClearOpen(true)}>
                  <Trash2 className="size-4" />
                  清空消息
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

      {/* 对话内搜索条（命中后点击滚动定位） */}
      {inConvMode && convSearchOpen && (
        <div className="flex flex-col gap-1.5">
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              void runConvSearch()
            }}
          >
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <Input
                value={convSearchQ}
                onChange={(e) => setConvSearchQ(e.target.value)}
                placeholder="搜索本对话…"
                aria-label="搜索本对话"
                className="h-9 rounded-full pl-8 pr-3 text-sm"
              />
            </div>
            <Button
              type="submit"
              variant="outline"
              size="icon"
              aria-label="搜索"
              className="size-9 shrink-0"
              disabled={convSearching || !convSearchQ.trim()}
            >
              {convSearching ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Search className="size-4" />
              )}
            </Button>
          </form>
          {convSearchHits.length > 0 && (
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-border bg-muted/30 p-1 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border">
              {convSearchHits.map((h) => (
                <button
                  key={h.messageId}
                  type="button"
                  onClick={() => locateMessage(h.messageId)}
                  className="block w-full rounded-lg px-2 py-1.5 text-left text-xs leading-relaxed transition-colors hover:bg-accent"
                >
                  <span className="mr-1 text-[10px] text-muted-foreground">
                    {h.role === 'user' ? '我' : 'AI'}
                  </span>
                  {h.snippet}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

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
              {inConvMode
                ? '开始你的第一句对话吧，选中阅读内容还能随时追问。'
                : mode === 'supervise'
                  ? 'AI 督背老师将引导你逐句背诵，准备好后说「开始」。'
                  : allowImages
                    ? '对课文有疑问？尽管问 AI，也可以附上课本照片。'
                    : '对课文有疑问？尽管问 AI。'}
            </div>
          )}

          {messages.map((m, idx) => {
            const mid = m.sid ?? m.id
            const think = m.role === 'assistant' ? splitThinking(m.content) : null
            return (
              <div
                key={m.id}
                data-mid={mid}
                className={cn(
                  'flex w-full rounded-2xl transition-shadow',
                  m.role === 'user' ? 'justify-end' : 'justify-start',
                  highlightId === mid && 'ring-2 ring-emerald-500/60 ring-offset-1',
                )}
              >
                {m.role === 'user' ? (
                  <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm leading-relaxed text-primary-foreground">
                    {m.images && m.images.length > 0 && (
                      <div className="mb-1.5 flex max-w-[200px] flex-wrap gap-1.5">
                        {m.images.map((src, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => setZoomImage(src)}
                            aria-label="放大图片"
                            className="after:absolute after:-inset-1 after:rounded-lg after:content-['']"
                          >
                            <img
                              src={src}
                              alt="附图"
                              className="h-16 w-16 max-w-full rounded-lg object-cover"
                            />
                          </button>
                        ))}
                      </div>
                    )}
                    {m.content}
                  </div>
                ) : (
                  <div className="flex w-full flex-col items-start gap-1">
                    {think && think.thinking ? <ThinkingBlock text={think.thinking} /> : null}
                    {splitAskSegments(think ? think.body : m.content).map((seg, i) =>
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
            )
          })}

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

      {/* 图片放大预览 */}
      <Dialog
        open={!!zoomImage}
        onOpenChange={(o) => {
          if (!o) setZoomImage(null)
        }}
      >
        <DialogContent className="max-w-[92vw] rounded-2xl sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>图片预览</DialogTitle>
          </DialogHeader>
          {zoomImage && (
            <div className="overflow-auto rounded-xl [scrollbar-width:thin]">
              <img
                src={zoomImage}
                alt="图片预览"
                className="max-h-[70vh] w-full max-w-full object-contain"
              />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 对话重命名 */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>重命名对话</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="输入新名称"
            aria-label="新名称"
            className="h-10 rounded-xl"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                void handleConvRename()
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" className="rounded-full" onClick={() => setRenameOpen(false)}>
              取消
            </Button>
            <Button
              className="rounded-full"
              disabled={renaming || !renameValue.trim()}
              onClick={() => void handleConvRename()}
            >
              {renaming && <Loader2 className="size-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 对话模式清空消息确认（更多菜单入口） */}
      <AlertDialog open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清空对话</AlertDialogTitle>
            <AlertDialogDescription>
              确定清空「{convMeta?.title || '当前对话'}」的全部消息吗？此操作无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                clearConversation()
                setConfirmClearOpen(false)
              }}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              清空
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
