'use client'

// AiAssistPopover — 富媒体编辑器的临时 AI 助理悬浮窗（右下角，非模态）。
//   • 临时会话：消息只存组件 state（内存），关闭即清空，绝不落库
//   • 上下文：每次发送都带当前媒体 kind + 最新代码（POST /api/media-ai）
//   • AI 回复：代码块带「应用到编辑器」（写入编辑器源码并切回可视化继续编辑）
//     / 复制；消息级「朗读」（/api/tts，401 或失败回退 speechSynthesis zh-CN）
// 实现说明：纯 createPortal 悬浮层（z-[80]，不遮罩、无焦点陷阱），打开时不
// 打断宿主编辑器；点击外部不关闭（防误触丢会话），仅 X / 应用后关闭。宿主
// MediaEditDialog 通过 data-ai-assist 识别本层，点击/聚焦此处不会误关编辑器。

import * as React from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  Copy,
  Loader2,
  Send,
  Sparkles,
  Square,
  Volume2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { MEDIA_KIND_LABEL, type MediaKind } from '@/components/recitation/media-refs'

/** 临时消息（内存态） */
interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
}

/** MediaKind → /api/media-ai 的 kind */
const API_KIND: Record<MediaKind, 'mermaid' | 'svg' | 'table' | 'formula' | 'code'> = {
  image: 'code',
  table: 'table',
  mermaid: 'mermaid',
  svg: 'svg',
  code: 'code',
  formula: 'formula',
}

// ---------- 中文朗读（/api/tts → speechSynthesis 兜底） ----------

/**
 * 轻量中文朗读 hook：优先 POST /api/tts 播放合成音频，
 * 401 / 请求失败时回退浏览器 speechSynthesis（zh-CN）。
 */
export function useChineseSpeech(): {
  speak: (text: string) => void
  stop: () => void
  speaking: boolean
} {
  const [speaking, setSpeaking] = React.useState(false)
  const audioRef = React.useRef<HTMLAudioElement | null>(null)
  const urlRef = React.useRef<string | null>(null)
  const genRef = React.useRef(0)

  const stop = React.useCallback(() => {
    genRef.current += 1
    window.speechSynthesis?.cancel()
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
    setSpeaking(false)
  }, [])

  const speak = React.useCallback(
    (raw: string) => {
      const text = (raw || '').trim().replace(/\s+/g, ' ').slice(0, 800)
      if (!text) {
        toast.warning('没有可朗读的内容')
        return
      }
      genRef.current += 1
      const gen = genRef.current
      window.speechSynthesis?.cancel()
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
      setSpeaking(true)
      void (async () => {
        const tid = toast.loading('正在生成语音…')
        try {
          const res = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice: 'tongtong', speed: 1 }),
          })
          if (!res.ok) throw new Error(`tts ${res.status}`)
          const blob = await res.blob()
          if (genRef.current !== gen) {
            toast.dismiss(tid)
            return
          }
          const url = URL.createObjectURL(blob)
          if (urlRef.current) URL.revokeObjectURL(urlRef.current)
          urlRef.current = url
          const audio = new Audio(url)
          audio.onended = () => {
            if (genRef.current === gen) setSpeaking(false)
          }
          audio.onerror = () => {
            if (genRef.current === gen) setSpeaking(false)
          }
          audioRef.current = audio
          toast.success('开始朗读', { id: tid })
          try {
            await audio.play()
          } catch {
            /* autoplay blocked — 忽略 */
          }
        } catch {
          toast.dismiss(tid)
          // 回退：浏览器语音合成（zh-CN）
          const synth = window.speechSynthesis
          if (!synth) {
            toast.error('当前浏览器不支持语音合成')
            setSpeaking(false)
            return
          }
          const u = new SpeechSynthesisUtterance(text)
          u.lang = 'zh-CN'
          u.onend = () => {
            if (genRef.current === gen) setSpeaking(false)
          }
          u.onerror = () => {
            if (genRef.current === gen) setSpeaking(false)
          }
          synth.speak(u)
        }
      })()
    },
    [],
  )

  React.useEffect(() => {
    return () => {
      genRef.current += 1
      window.speechSynthesis?.cancel()
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    }
  }, [])

  return { speak, stop, speaking }
}

// ---------- AI 回复分段（提示词要求纯代码，但模型常带围栏/解释） ----------

function splitCodeFences(text: string): Array<{ type: 'text' | 'code'; value: string }> {
  const out: Array<{ type: 'text' | 'code'; value: string }> = []
  const re = /```[A-Za-z0-9_-]*\r?\n([\s\S]*?)```/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last && text.slice(last, m.index).trim()) {
      out.push({ type: 'text', value: text.slice(last, m.index).trim() })
    }
    if (m[1].trim()) out.push({ type: 'code', value: m[1] })
    last = m.index + m[0].length
  }
  if (last < text.length && text.slice(last).trim()) {
    out.push({ type: 'text', value: text.slice(last).trim() })
  }
  if (out.length === 0 && text.trim()) out.push({ type: 'code', value: text.trim() })
  return out
}

// ---------- 主组件 ----------

export function AiAssistPopover({
  open,
  onOpenChange,
  kind,
  currentCode,
  onApply,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  /** 当前编辑的富媒体类型（上下文提示词带上） */
  kind: MediaKind
  /** 当前编辑器内的最新源码（每次发送时取） */
  currentCode: string
  /** 把 AI 生成的代码写入编辑器（宿主负责切回可视化 tab） */
  onApply: (code: string) => void
}) {
  const [messages, setMessages] = React.useState<ChatMsg[]>([])
  const [input, setInput] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const { speak, stop: stopSpeech, speaking } = useChineseSpeech()

  // 关闭即清空（临时对话，不保存记录）
  React.useEffect(() => {
    if (!open) {
      stopSpeech()
      setMessages([])
      setInput('')
      setLoading(false)
    }
  }, [open, stopSpeech])

  React.useEffect(() => {
    if (open) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, loading, open])

  const send = async () => {
    const text = input.trim()
    if (!text || loading) return
    const history = messages.slice(-20)
    setInput('')
    setLoading(true)
    setMessages((m) => [...m, { role: 'user', content: text }])
    try {
      const res = await fetch('/api/media-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: API_KIND[kind],
          currentCode,
          instruction: text,
          history,
        }),
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(err.error || `请求失败（${res.status}）`)
      }
      const data = (await res.json()) as { code?: string }
      const reply = typeof data.code === 'string' ? data.code : ''
      if (!reply.trim()) throw new Error('AI 返回为空，请重试')
      setMessages((m) => [...m, { role: 'assistant', content: reply }])
    } catch (e) {
      const msg = e instanceof Error ? e.message : '未知错误'
      setMessages((m) => [...m, { role: 'assistant', content: `（生成失败：${msg}）` }])
      toast.error('AI 生成失败：' + msg)
    } finally {
      setLoading(false)
    }
  }

  const applyCode = (code: string) => {
    onApply(code)
    onOpenChange(false)
  }

  // Esc 关闭（自管，不用 Radix 层）
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  if (!open || typeof document === 'undefined') return null

  // 纯 portal 悬浮层（非 Radix）：不打断宿主编辑器、点击外部不关闭（防误触丢会话）。
  // 宿主编辑器（MediaEditDialog）通过 data-ai-assist 识别本层，外部点击时不误关。
  return createPortal(
    <div
      data-ai-assist="1"
      role="dialog"
      aria-modal="false"
      aria-label="AI 助理"
      className="fixed bottom-3 left-3 right-3 z-[80] flex h-[60dvh] w-auto flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl sm:bottom-5 sm:left-auto sm:right-5 sm:w-[min(92vw,400px)]"
    >
      {/* 头部 */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Sparkles className="size-4" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">AI 助理</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {MEDIA_KIND_LABEL[kind]} · 临时对话 · 不保存记录
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="关闭 AI 助理"
          className="size-8 shrink-0 rounded-full"
          onClick={() => onOpenChange(false)}
        >
          <X className="size-4" />
        </Button>
      </div>

        {/* 会话区 */}
        <div ref={scrollRef} className="flex-1 space-y-2.5 overflow-y-auto overscroll-contain px-3 py-3">
          {messages.length === 0 && !loading && (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
              <Sparkles className="size-6 text-muted-foreground/50" strokeWidth={1.5} />
              <p className="text-xs leading-relaxed text-muted-foreground">
                告诉 AI 你想要什么，例如：
                <br />
                「画一个三次函数图像」
                <br />
                「把这张思维导图再扩充一层」
                <br />
                「生成一张苏轼生平时间线表格」
              </p>
              <p className="text-[11px] text-muted-foreground/70">
                AI 写好的代码会出现在这里，点击即可应用到编辑器，之后仍可可视化编辑
              </p>
            </div>
          )}
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3 py-2 text-sm text-primary-foreground">
                  {m.content}
                </p>
              </div>
            ) : (
              <div key={i} className="flex flex-col items-start gap-1">
                <div className="flex items-center gap-1 self-start">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                    AI
                  </span>
                  <button
                    type="button"
                    aria-label={speaking ? '停止朗读' : '朗读 AI 回复'}
                    title={speaking ? '停止朗读' : '朗读'}
                    onClick={() => (speaking ? stopSpeech() : speak(m.content))}
                    className="rounded p-1 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {speaking ? <Square className="size-3" /> : <Volume2 className="size-3" />}
                  </button>
                </div>
                {splitCodeFences(m.content).map((seg, j) =>
                  seg.type === 'text' ? (
                    <p
                      key={j}
                      className="max-w-[92%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-muted px-3 py-2 text-sm"
                    >
                      {seg.value}
                    </p>
                  ) : (
                    <div
                      key={j}
                      className="w-full overflow-hidden rounded-2xl rounded-bl-md border border-border"
                    >
                      <div className="flex items-center justify-between gap-2 bg-muted/70 px-2.5 py-1.5">
                        <span className="text-[10px] font-medium text-muted-foreground">
                          {MEDIA_KIND_LABEL[kind]}代码
                        </span>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 rounded-full px-2 text-[11px] text-muted-foreground"
                            onClick={() => {
                              void navigator.clipboard
                                .writeText(seg.value)
                                .then(() => toast.success('代码已复制'))
                                .catch(() => toast.error('复制失败'))
                            }}
                          >
                            <Copy className="size-3" /> 复制
                          </Button>
                          <Button
                            size="sm"
                            className="h-7 rounded-full bg-zinc-900 px-2.5 text-[11px] font-medium text-white hover:bg-zinc-800"
                            onClick={() => applyCode(seg.value)}
                          >
                            <Check className="size-3" /> 应用到编辑器
                          </Button>
                        </div>
                      </div>
                      <pre className="max-h-44 overflow-auto bg-muted/30 p-2.5 font-mono text-[11px] leading-relaxed">
                        {seg.value}
                      </pre>
                    </div>
                  ),
                )}
              </div>
            ),
          )}
          {loading && (
            <div className="flex items-center gap-2 self-start rounded-2xl rounded-bl-md bg-muted px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> AI 正在生成…
            </div>
          )}
        </div>

        {/* 输入区 */}
        <div className="border-t border-border p-2.5">
          <div className="flex items-end gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send()
                }
              }}
              rows={2}
              aria-label="对 AI 的指令"
              placeholder={`描述你想要的${MEDIA_KIND_LABEL[kind]}…`}
              className="min-h-11 flex-1 resize-none rounded-xl bg-muted/40 text-sm"
            />
            <Button
              size="icon"
              aria-label="发送"
              disabled={!input.trim() || loading}
              onClick={() => void send()}
              className="size-11 shrink-0 rounded-full bg-zinc-900 text-white hover:bg-zinc-800"
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            </Button>
          </div>
          <p className={cn('pt-1.5 text-center text-[10px] text-muted-foreground/70')}>
            Enter 发送 · Shift+Enter 换行 · 应用后可继续可视化编辑
          </p>
        </div>
    </div>,
    document.body,
  )
}
