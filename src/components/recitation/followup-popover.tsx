'use client'

// FollowupPopover — 全局追问弹层。
// 任何界面选中文本后 dispatch window 事件 `app:followup`
//   detail: { text, source: 'chat'|'analysis'|'favorite'|'reader'|'quiz',
//             cardId?, cardTitle?, conversationId? }
// 即可在底部弹出「🔍 追问」弹层：
//   • 选中文本预览（≤3行截断）+ 来源标签
//   • 追问输入框 + 语音输入（VoiceInput）+ 附图（≤2张，canvas 压缩 ≤800px）
//   • 「自我思考」开关（默认读 GET /api/settings 的 aiSelfThinking，本地覆盖本次）
// 提交分支：
//   • source==='chat' 且有活动对话（事件携带 conversationId，或
//     getActiveConversationId prop，或监听 `app:currentConversation` 事件）
//     → dispatch `app:chatSend` 在当前对话接续追问；
//   • 其余来源 → POST /api/conversations 新建 type='followup' 对话并写入
//     首条用户消息 → dispatch `app:openConversation` 让 page.tsx 打开该对话
//     （ChatTool 检测到"最近未回答的用户消息"会自动生成 AI 回复）。
// 跨组件「自我思考」一次性偏好：sessionStorage `bs:followup-thinking`
// （ChatTool 自动回复时读取并清除）。
import * as React from 'react'
import { createPortal } from 'react-dom'
import { ImagePlus, Loader2, Search, Send, X } from 'lucide-react'
import { toast } from 'sonner'

import { VoiceInput } from '@/components/recitation/voice-input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

/** FollowupPopover 一次性自我思考偏好的 sessionStorage key（ChatTool 消费后清除）。 */
export const FOLLOWUP_THINKING_KEY = 'bs:followup-thinking'

/** `app:followup` 事件 detail 契约。 */
export interface FollowupDetail {
  text: string
  source: 'chat' | 'analysis' | 'favorite' | 'reader' | 'quiz'
  cardId?: string
  cardTitle?: string
  conversationId?: string
}

/** `app:currentConversation` 事件 detail（page.tsx 活动对话变化时派发）。 */
interface CurrentConversationDetail {
  id: string | null
}

/** `app:chatSend` 事件 detail（ChatTool 监听）。 */
export interface ChatSendDetail {
  text: string
  images?: string[]
  /** 可选扩展：本次请求覆盖「自我思考」设置（ChatTool → /api/chat）。 */
  selfThinking?: boolean
  /** 可选扩展：目标对话 id（多 ChatTool 实例时用于精确匹配）。 */
  conversationId?: string
}

const SOURCE_LABELS: Record<FollowupDetail['source'], string> = {
  chat: 'AI 对话',
  analysis: '题目解析',
  favorite: '收藏解析',
  reader: '阅读内容',
  quiz: '答题',
}

/** 追问弹层最多附带图片数。 */
const MAX_IMAGES = 2
/** 附图压缩上限（长边 px）。 */
const MAX_IMAGE_DIM = 800
/** 小于该体积（字节）的图片直接保留原 dataURL。 */
const COMPRESS_OVER = 120 * 1024

interface FollowupPopoverProps {
  /**
   * 获取当前活动对话 id（提交时调用取最新值）。未传时回退：
   * 1) 事件 detail.conversationId；2) 监听 `app:currentConversation` 事件
   * （page.tsx 在活动对话变化时 dispatch detail {id}，传 null 表示关闭）。
   */
  getActiveConversationId?: () => string | undefined
}

interface PendingImage {
  id: string
  dataUrl: string
}

function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 图片文件 → dataURL（长边 >800px 或 >120KB 时 canvas 压缩为 800px JPEG）。 */
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
          resolve(dataUrl)
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

export function FollowupPopover({ getActiveConversationId }: FollowupPopoverProps) {
  const [detail, setDetail] = React.useState<FollowupDetail | null>(null)
  const [question, setQuestion] = React.useState('')
  const [images, setImages] = React.useState<PendingImage[]>([])
  const [selfThinking, setSelfThinking] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [mounted, setMounted] = React.useState(false)
  /** 活动对话 id（由 `app:currentConversation` 事件维护）。 */
  const activeIdRef = React.useRef<string | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const inputRef = React.useRef<HTMLTextAreaElement>(null)

  React.useEffect(() => {
    setMounted(true)
    return () => setMounted(false)
  }, [])

  const close = React.useCallback(() => {
    if (submitting) return
    setDetail(null)
    setQuestion('')
    setImages([])
  }, [submitting])

  // ---------- 监听活动对话变化（page.tsx dispatch `app:currentConversation`） ----------
  React.useEffect(() => {
    const onCurrent = (e: Event) => {
      const d = (e as CustomEvent<CurrentConversationDetail>).detail
      activeIdRef.current = d && typeof d.id === 'string' && d.id ? d.id : null
    }
    window.addEventListener('app:currentConversation', onCurrent)
    return () => {
      window.removeEventListener('app:currentConversation', onCurrent)
    }
  }, [])

  // ---------- 监听 `app:followup` 打开弹层 ----------
  React.useEffect(() => {
    const onFollowup = (e: Event) => {
      const d = (e as CustomEvent<FollowupDetail>).detail
      if (!d || typeof d.text !== 'string' || !d.text.trim()) return
      setDetail({
        text: d.text.trim().slice(0, 2000),
        source: d.source ?? 'reader',
        ...(d.cardId ? { cardId: d.cardId } : {}),
        ...(d.cardTitle ? { cardTitle: d.cardTitle } : {}),
        ...(d.conversationId ? { conversationId: d.conversationId } : {}),
      })
      if (d.conversationId) activeIdRef.current = d.conversationId
      setQuestion('')
      setImages([])
      setSubmitting(false)
      // 「自我思考」默认值跟随服务端设置（字段就绪前缺省 false）
      void (async () => {
        try {
          const res = await fetch('/api/settings')
          if (!res.ok) return
          const data = (await res.json()) as Record<string, unknown>
          setSelfThinking(data?.aiSelfThinking === true)
        } catch {
          /* 读取失败保持当前值 */
        }
      })()
      window.setTimeout(() => {
        inputRef.current?.focus()
      }, 350)
    }
    window.addEventListener('app:followup', onFollowup)
    return () => {
      window.removeEventListener('app:followup', onFollowup)
    }
  }, [])

  // Esc 关闭
  React.useEffect(() => {
    if (!detail) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [detail, close])

  const handleFilesChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // 允许重复选择同一文件
    if (files.length === 0) return
    const room = MAX_IMAGES - images.length
    if (room <= 0) {
      toast.warning(`追问最多附 ${MAX_IMAGES} 张图片`)
      return
    }
    if (files.length > room) {
      toast.warning(`追问最多附 ${MAX_IMAGES} 张图片，已保留前 ${room} 张`)
    }
    const results = await Promise.allSettled(
      files.slice(0, room).map((f) => processImageFile(f)),
    )
    const urls: string[] = []
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') urls.push(r.value)
      else toast.error(`第 ${i + 1} 张图片处理失败`)
    })
    if (urls.length > 0) {
      setImages((prev) => [...prev, ...urls.map((dataUrl) => ({ id: uid(), dataUrl }))])
    }
  }

  const removeImage = (id: string) => {
    setImages((prev) => prev.filter((p) => p.id !== id))
  }

  const submit = async () => {
    if (!detail || submitting) return
    const selected = detail.text.trim()
    const q = question.trim()
    if (!selected || !q) return
    setSubmitting(true)
    const imgs = images.map((p) => p.dataUrl)
    try {
      // ---- 分支一：AI 对话内追问 → 当前对话接续 ----
      if (detail.source === 'chat') {
        const convId =
          detail.conversationId ||
          (typeof getActiveConversationId === 'function'
            ? getActiveConversationId()
            : undefined) ||
          activeIdRef.current ||
          undefined
        if (convId) {
          window.dispatchEvent(
            new CustomEvent<ChatSendDetail>('app:chatSend', {
              detail: {
                text: `关于「${selected}」：${q}`,
                ...(imgs.length > 0 ? { images: imgs } : {}),
                selfThinking,
                conversationId: convId,
              },
            }),
          )
          setDetail(null)
          setQuestion('')
          setImages([])
          toast.success('已在当前对话追问')
          return
        }
      }

      // ---- 分支二：解析/阅读场景 → 新建 followup 对话 ----
      const convRes = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'followup',
          cardId: detail.cardId ?? '',
          title: selected.slice(0, 12),
        }),
      })
      if (!convRes.ok) {
        const err = (await convRes.json().catch(() => ({}))) as { error?: string }
        throw new Error(err.error || '新建追问对话失败')
      }
      const convData = (await convRes.json()) as {
        conversation?: { id?: string }
      }
      const convId = convData.conversation?.id
      if (!convId) throw new Error('新建追问对话失败')

      const content = `【选中文本】\n${selected}\n\n【来源】${
        detail.cardTitle || '阅读内容'
      }\n\n【追问】\n${q}`
      const msgRes = await fetch(`/api/conversations/${encodeURIComponent(convId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content,
              ...(imgs.length > 0 ? { images: imgs } : {}),
            },
          ],
        }),
      })
      if (!msgRes.ok) {
        // 消息写入失败时删除刚建的空对话，避免遗留垃圾数据
        void fetch(`/api/conversations/${encodeURIComponent(convId)}`, {
          method: 'DELETE',
        }).catch(() => {})
        throw new Error('保存追问失败')
      }

      // 一次性「自我思考」偏好（ChatTool 自动回复时读取并清除）
      try {
        window.sessionStorage.setItem(FOLLOWUP_THINKING_KEY, selfThinking ? '1' : '0')
      } catch {
        /* 隐私模式下忽略 */
      }

      window.dispatchEvent(
        new CustomEvent('app:openConversation', { detail: { id: convId } }),
      )
      setDetail(null)
      setQuestion('')
      setImages([])
      toast.success('已发起追问')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '追问失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  if (!mounted || !detail) return null

  return createPortal(
    <>
      {/* 背板：点外部关闭 */}
      <div
        className="fixed inset-0 z-[94] bg-black/40 backdrop-blur-[2px] animate-in fade-in duration-200"
        onClick={close}
        aria-hidden
      />
      {/* 追问弹层卡片：渐变描边 + 微光晕 + 底部滑入 */}
      <div
        role="dialog"
        aria-label="追问"
        className="fixed inset-x-3 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-[95] mx-auto max-w-lg"
      >
        <div className="animate-in slide-in-from-bottom-8 fade-in duration-300 rounded-[1.4rem] bg-gradient-to-br from-emerald-400 via-sky-400 to-violet-500 p-[1.5px] shadow-[0_0_44px_-10px_rgba(56,189,248,0.55)]">
          <div className="rounded-[calc(1.4rem-1.5px)] bg-background p-4">
            {/* 标题行 */}
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 bg-gradient-to-r from-emerald-500 to-sky-500 bg-clip-text text-sm font-bold text-transparent">
                <Search className="size-4 text-emerald-500" strokeWidth={2.25} />
                追问
              </span>
              <div className="flex items-center gap-2">
                <span className="rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground">
                  {SOURCE_LABELS[detail.source] ?? detail.source}
                </span>
                <button
                  type="button"
                  onClick={close}
                  aria-label="关闭追问"
                  className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>

            {/* 选中文本预览（≤3 行截断） */}
            <div className="mt-2.5 line-clamp-3 rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-[13px] leading-relaxed text-foreground/85">
              {detail.text}
            </div>

            {/* 附图预览 */}
            {images.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-2">
                {images.map((p) => (
                  <div key={p.id} className="relative">
                    <img
                      src={p.dataUrl}
                      alt="追问附图"
                      className="size-14 rounded-lg border object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removeImage(p.id)}
                      aria-label="移除图片"
                      className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-destructive text-white shadow"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* 输入区 */}
            <div className="mt-3 flex items-end gap-1.5">
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
                variant="outline"
                size="icon"
                aria-label="添加图片"
                className="size-11 shrink-0 sm:size-9"
                disabled={submitting || images.length >= MAX_IMAGES}
                onClick={() => fileInputRef.current?.click()}
              >
                <ImagePlus className="size-4" />
              </Button>
              <textarea
                ref={inputRef}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void submit()
                  }
                }}
                rows={2}
                placeholder="针对选中内容继续提问…"
                aria-label="追问内容"
                className="max-h-28 min-h-11 flex-1 resize-none rounded-xl border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50"
              />
              <VoiceInput
                size="sm"
                variant="outline"
                context="ask"
                disabled={submitting}
                className="[&>button]:size-11 sm:[&>button]:size-9"
                onText={(t) => setQuestion((prev) => (prev ? prev + t : t))}
              />
              <Button
                type="button"
                size="icon"
                aria-label="发送追问"
                className="size-11 shrink-0 bg-gradient-to-br from-emerald-500 to-sky-500 text-white hover:from-emerald-600 hover:to-sky-600 sm:size-9"
                disabled={submitting || !question.trim()}
                onClick={() => void submit()}
              >
                {submitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Send className="size-4" />
                )}
              </Button>
            </div>

            {/* 自我思考开关 */}
            <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 px-3 py-2">
              <Label
                htmlFor="followup-self-thinking"
                className="cursor-pointer text-xs font-medium text-muted-foreground"
              >
                💭 自我思考
                <span className="ml-1 text-muted-foreground/70">
                  （AI 先简短思考再回答，仅本次追问生效）
                </span>
              </Label>
              <Switch
                id="followup-self-thinking"
                checked={selfThinking}
                onCheckedChange={setSelfThinking}
                aria-label="自我思考开关"
                className="data-[state=checked]:bg-emerald-600"
              />
            </div>
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}
