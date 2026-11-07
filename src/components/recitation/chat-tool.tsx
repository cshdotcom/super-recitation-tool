'use client'

import * as React from 'react'
import { Send, Loader2, MessageCircleQuestion } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import type { ChatMessage } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface ChatToolProps {
  mode: 'supervise' | 'ask'
  content: string
}

interface UIMessage {
  role: 'user' | 'assistant'
  content: string
}

export function ChatTool({ mode, content }: ChatToolProps) {
  const [messages, setMessages] = React.useState<UIMessage[]>([])
  const [input, setInput] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const seededRef = React.useRef(false)

  const send = React.useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      if (!content.trim()) {
        toast.error('请先选择一张有内容的背书卡')
        return
      }
      const nextMessages: UIMessage[] = [
        ...messages,
        { role: 'user', content: trimmed },
      ]
      setMessages(nextMessages)
      setInput('')
      setLoading(true)
      try {
        const payload: ChatMessage[] = nextMessages.map((m) => ({
          role: m.role,
          content: m.content,
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
    [messages, content, mode],
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    send(input)
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
              <div
                className={cn(
                  'max-w-[85%] whitespace-pre-wrap px-3 py-2 text-sm leading-relaxed',
                  m.role === 'user'
                    ? 'rounded-2xl rounded-br-sm bg-primary text-primary-foreground'
                    : 'rounded-2xl rounded-bl-sm bg-muted',
                )}
              >
                {m.content}
              </div>
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

      <form onSubmit={handleSubmit} className="flex items-center gap-2">
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
          disabled={loading || !input.trim()}
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
