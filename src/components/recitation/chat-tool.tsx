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
import * as React from 'react'
import {
  Check,
  Copy,
  ImagePlus,
  Loader2,
  MessageCircleQuestion,
  Send,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { VoiceInput } from '@/components/recitation/voice-input'

import { cn } from '@/lib/utils'
import type { ChatMessage } from '@/lib/types'
import { RichContent } from '@/components/recitation/rich-content'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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

interface ChatToolProps {
  mode: 'supervise' | 'ask'
  content: string
  /** Ask mode allows attaching images (vision) to user messages. */
  allowImages?: boolean
  /** 当前卡片 id — 对话历史按 cardId+mode 存在服务端。 */
  cardId?: string
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

/** Split assistant content into markdown and ```ask segments.
 *  Invalid ask JSON degrades to the raw fenced code block. */
function splitAskSegments(content: string): AskSegment[] {
  const parts = content.split(/```ask[ \t]*\r?\n?([\s\S]*?)```/g)
  const segs: AskSegment[] = []
  for (let i = 0; i < parts.length; i += 1) {
    if (i % 2 === 0) {
      segs.push({ kind: 'md', value: parts[i] })
      continue
    }
    let ask: AskBlock | null = null
    try {
      const obj = JSON.parse(parts[i]) as { question?: unknown; options?: unknown }
      if (typeof obj?.question === 'string' && Array.isArray(obj.options)) {
        const options = obj.options
          .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
          .slice(0, 6)
        if (obj.question.trim() && options.length > 0) {
          ask = { question: obj.question.trim(), options }
        }
      }
    } catch {
      // not valid JSON — fall through to raw rendering
    }
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
      <div className="mb-2 flex items-start gap-2">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <Sparkles className="size-3.5" strokeWidth={2} />
        </span>
        <p className="text-sm font-medium leading-relaxed">{ask.question}</p>
      </div>
      <div className="space-y-1.5">
        {ask.options.map((opt) => {
          const chosen = done && answered === opt
          return (
            <button
              key={opt}
              type="button"
              disabled={done || busy}
              onClick={() => onSend(opt)}
              className={cn(
                'flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-sm transition-colors',
                chosen
                  ? 'border-emerald-600 bg-emerald-600 text-white'
                  : 'border-border bg-card hover:border-emerald-500/60 hover:bg-emerald-500/10 disabled:pointer-events-none disabled:opacity-50',
              )}
            >
              <span className="min-w-0 break-words">{opt}</span>
              {chosen && <Check className="size-4 shrink-0" strokeWidth={2.5} />}
            </button>
          )
        })}
      </div>
      {done ? (
        <div className="mt-2 flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
          <Check className="size-3.5" strokeWidth={2.5} />
          已回答：{answered}
        </div>
      ) : (
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
            placeholder="自定义回答…"
            disabled={busy}
            className="h-8 bg-card text-xs"
            aria-label="自定义回答"
          />
          <VoiceInput
            size="sm"
            context="ask"
            disabled={busy}
            onText={(t) => setCustom((p) => (p ? p + t : t))}
          />
          <Button
            type="submit"
            size="icon"
            className="size-8 shrink-0"
            disabled={busy || !custom.trim()}
            aria-label="发送自定义回答"
          >
            <Send className="size-3.5" />
          </Button>
        </form>
      )}
    </div>
  )
}

// ---------- main component ----------

export function ChatTool({ mode, content, allowImages = false, cardId }: ChatToolProps) {
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
  const stateKey = React.useMemo(
    () => (cardId ? `chat:ask:${mode}:${cardId}` : ''),
    [mode, cardId],
  )

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
    [messages, content, mode, allowImages],
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
  }, [messages, loading])

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
    setMessages((prev) => {
      const next = [...prev]
      next.splice(idx, 1)
      if (prevUser) next.splice(idx - 1, 1)
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
    setMessages([])
    setAskAnswered({})
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

  const handleAskSend = (msgId: string, text: string) => {
    setAskAnswered((prev) => ({ ...prev, [msgId]: text }))
    void send(text)
  }

  return (
    <div className="flex h-[60vh] flex-col gap-3">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto rounded-md"
      >
        <div className="flex flex-col gap-3 p-1">
          {messages.length > 0 && (
            <div className="flex justify-end">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded-full px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
                        answered={askAnswered[m.id]}
                        busy={loading}
                        onSend={(text) => handleAskSend(m.id, text)}
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
                  {/* reply actions: copy / delete */}
                  <div className="ml-1 flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => void copyReply(m)}
                      aria-label="复制该回复"
                      className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
                      className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-red-600"
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
                className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-destructive text-white shadow"
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
          onText={(t) => setInput((prev) => (prev ? prev + t : t))}
        />
        <Button
          type="submit"
          size="icon"
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
