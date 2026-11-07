'use client'

import * as React from 'react'
import { Send, Loader2, MessageCircleQuestion, ImagePlus, X } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import type { ChatMessage } from '@/lib/types'
import { RichContent } from '@/components/recitation/rich-content'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const MAX_IMAGES = 4
/** Files smaller than this keep their original data URL; larger get compressed. */
const COMPRESS_OVER = 300 * 1024
const MAX_IMAGE_DIM = 1024

interface ChatToolProps {
  mode: 'supervise' | 'ask'
  content: string
  /** Ask mode allows attaching images (vision) to user messages. */
  allowImages?: boolean
}

interface UIMessage {
  role: 'user' | 'assistant'
  content: string
  images?: string[]
}

interface PendingImage {
  id: string
  dataUrl: string
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

export function ChatTool({ mode, content, allowImages = false }: ChatToolProps) {
  const [messages, setMessages] = React.useState<UIMessage[]>([])
  const [input, setInput] = React.useState('')
  const [pending, setPending] = React.useState<PendingImage[]>([])
  const [loading, setLoading] = React.useState(false)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const seededRef = React.useRef(false)
  const idRef = React.useRef(0)

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
      const nextMessages: UIMessage[] = [
        ...messages,
        {
          role: 'user',
          content: trimmed,
          ...(imgs.length > 0 ? { images: imgs } : {}),
        },
      ]
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
        setMessages((prev) => [...prev, { role: 'assistant', content: reply }])
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

  // Auto-seed a greeting for supervise mode
  React.useEffect(() => {
    if (seededRef.current) return
    if (!content.trim()) return
    if (mode === 'supervise') {
      seededRef.current = true
      send('开始背诵吧，请引导我。')
    } else {
      seededRef.current = true
    }
  }, [mode, content, send])

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
    send(input, images)
  }

  return (
    <div className="flex h-[60vh] flex-col gap-3">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto rounded-md"
      >
        <div className="flex flex-col gap-3 p-1">
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
              key={idx}
              className={cn(
                'flex w-full',
                m.role === 'user' ? 'justify-end' : 'justify-start',
              )}
            >
              {m.role === 'user' ? (
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm leading-relaxed text-primary-foreground">
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
                // Assistant messages render as markdown (code, tables, mermaid…)
                <RichContent
                  content={m.content}
                  className="max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3 py-2"
                />
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
              ? '回复督背老师…'
              : '输入你的问题…'
          }
          disabled={loading}
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
