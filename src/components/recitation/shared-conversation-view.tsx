'use client'

// SharedConversationView — 公开「AI 对话」分享视图（访客无需登录）。
// 自取数：GET /api/share/:token →
//   • 响应含 conversation 字段 → 渲染只读对话（user 右绿 / assistant 左灰白
//     气泡，消息用 RichContent 渲染 MD/LaTeX/mermaid/SVG/HTML/代码块/图片）；
//     消息内图片点击进入全功能图片查看器（缩放/平移/旋转/下载）。
//   • 响应含 card 字段（书籍内容分享）→ 内部委托 <SharedCardView> 兼容渲染，
//     因此 page.tsx 只需挂载本组件即可同时服务两类分享（无需预知类型）。
//   • 404 / 410 / 网络错误 → “分享不存在/已过期”错误态。
//
// 每条 AI 消息的自研操作菜单（风格与背书 long-press-menu 一致：长按 / 右键 /
// 点消息下方的 ⋯ 按钮）：
//   • 复制   — 复制该条消息原文
//   • 朗读   — 服务端 /api/tts + Audio（与 ChatTool 同机制）；访客未登录时
//              自动回退浏览器 speechSynthesis
//   • 追问   — 以该消息为上下文发起追问（新建 followup 对话并跳转；
//              分享中心预览内则派发 app:openConversation）
//   • 多选   — 复选框模式：全选 / 复制 / 导出（conversation-export 引擎，
//              MD/HTML/TXT/PDF/图片/剪贴板/JSON + 格式选项弹窗）
//
// 两种形态：
//   • 全屏（onExit 提供时显示返回按钮）——供 /share/[token] 页面挂载；
//   • embedded（嵌入 Dialog 预览）——供分享中心「预览」按钮使用。
import * as React from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import {
  AlertCircle,
  ArrowLeft,
  BookOpenText,
  CheckSquare,
  ClipboardCopy,
  Copy,
  Download,
  Loader2,
  MessageCircleQuestion,
  MoreHorizontal,
  Pause,
  Send,
  Volume2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import type { ShareInfo } from '@/lib/types'
import { cn } from '@/lib/utils'
import { SharedCardView } from '@/components/recitation/shared-card-view'
import RichContent from '@/components/recitation/rich-content'
import { ImageViewer } from '@/components/recitation/image-viewer'
import { ConversationExportDialog } from '@/components/recitation/conversation-export-dialog'
import type { ExportMessage } from '@/lib/conversation-export'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'

export interface SharedConversationViewProps {
  token: string
  /** 全屏形态的返回回调；Dialog 预览（embedded）可不传。 */
  onExit?: () => void
  /** true = 嵌入 Dialog 预览：去掉页面级 sticky 头，正文随容器滚动。 */
  embedded?: boolean
}

interface SharedMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  images: string[]
  createdAt: string
}

interface ConvPayload {
  conversation: { id: string; title: string; type: string; createdAt: string }
  messages: SharedMessage[]
  share: ShareInfo | null
}

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'conversation'; payload: ConvPayload }
  | { status: 'card' }

/** 对话类型徽章（type 由创建方任意指定，兜底「AI 对话」）。 */
const CONV_TYPE_LABEL: Record<string, string> = {
  chat: 'AI 对话',
  ask: 'AI 问问',
  supervise: 'AI 督背',
  earback: '耳背',
  shared: '对话分享',
}

function convTypeLabel(type: string): string {
  return CONV_TYPE_LABEL[type] ?? 'AI 对话'
}

function fmtTime(iso: string): string {
  try {
    return format(new Date(iso), 'yyyy/MM/dd HH:mm', { locale: zhCN })
  } catch {
    return ''
  }
}

function getExpiryBadge(share: ShareInfo | null): { label: string; className: string } {
  const ok = 'border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400'
  if (!share) return { label: '共享内容', className: ok }
  if (!share.expiresAt) return { label: '永久有效', className: ok }
  const d = new Date(share.expiresAt)
  if (Number.isNaN(d.getTime())) return { label: '永久有效', className: ok }
  if (d.getTime() < Date.now()) {
    return {
      label: '已过期',
      className: 'border-destructive/40 bg-destructive/10 text-destructive',
    }
  }
  return { label: `有效期至 ${format(d, 'yyyy/MM/dd')}`, className: ok }
}

/** 轻量剥离 markdown 语法用于朗读（与 chat-tool 的 speakableText 同思路）。 */
function speakableText(raw: string): string {
  let t = raw || ''
  t = t.replace(/<thinking>[\s\S]*?(<\/thinking>|$)/gi, ' ')
  t = t.replace(/```ask[ \t]*\r?\n?[\s\S]*?```/g, ' ')
  t = t.replace(/```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/g, '$1')
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  t = t.replace(/^\s*>\s?/gm, '')
  t = t.replace(/^\s*[-*+]\s+/gm, '')
  t = t.replace(/(\*\*|__)(.*?)\1/g, '$2')
  t = t.replace(/(\*|_)(.*?)\1/g, '$2')
  t = t.replace(/`([^`]+)`/g, '$1')
  t = t.replace(/\|/g, ' ')
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 浏览器语音合成分块朗读（长文本按句切分，避免引擎截断）。 */
function browserSpeakChunks(text: string, onEnd: () => void): () => void {
  const synth = window.speechSynthesis
  if (!synth) {
    toast.error('当前浏览器不支持语音合成')
    onEnd()
    return () => {}
  }
  synth.cancel()
  const chunks: string[] = []
  let buf = ''
  for (const seg of text.match(/[^。！？!?.\n]+[。！？!?.\n]?/g) ?? [text]) {
    if ((buf + seg).length > 180) {
      if (buf) chunks.push(buf)
      buf = seg
    } else {
      buf += seg
    }
  }
  if (buf.trim()) chunks.push(buf)
  if (chunks.length === 0) {
    onEnd()
    return () => {}
  }
  let cancelled = false
  chunks.forEach((chunk, i) => {
    const u = new SpeechSynthesisUtterance(chunk)
    u.lang = 'zh-CN'
    if (i === chunks.length - 1) {
      u.onend = () => {
        if (!cancelled) onEnd()
      }
      u.onerror = () => {
        if (!cancelled) onEnd()
      }
    }
    synth.speak(u)
  })
  return () => {
    cancelled = true
    synth.cancel()
  }
}

// ---------- 自研浮动操作菜单（风格复刻 long-press-menu.tsx） ----------

const MENU_WIDTH = 184
const ROW_HEIGHT = 42
const MENU_PAD = 14
const VIEWPORT_INSET = 8
const LONG_PRESS_MS = 480
const MOVE_TOLERANCE = 10

interface MenuAction {
  key: string
  label: string
  icon: React.ReactNode
  danger?: boolean
}

/**
 * 消息操作菜单：长按（480ms）/ 右键消息气泡，或点击 ⋯ 按钮打开。
 * 面板样式与背书 long-press-menu 完全一致（zinc 深色圆角 + framer-motion）。
 */
function BubbleMenu({
  actions,
  onAction,
  children,
  menuAt,
  onOpenAt,
  className,
}: {
  actions: MenuAction[]
  onAction: (key: string) => void
  children: React.ReactNode
  /** 外部点击入口（⋯ 按钮）传入坐标打开菜单。 */
  menuAt: { x: number; y: number } | null
  onOpenAt: (pos: { x: number; y: number } | null) => void
  className?: string
}) {
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])

  const timerRef = React.useRef<number | null>(null)
  const startRef = React.useRef<{ x: number; y: number } | null>(null)
  const longPressedRef = React.useRef(false)

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const open = menuAt !== null

  const clampPos = (x: number, y: number) => {
    const menuH = actions.length * ROW_HEIGHT + MENU_PAD
    const cx = Math.max(
      VIEWPORT_INSET,
      Math.min(x, window.innerWidth - MENU_WIDTH - VIEWPORT_INSET),
    )
    const cy = Math.max(
      VIEWPORT_INSET,
      Math.min(y, window.innerHeight - menuH - VIEWPORT_INSET),
    )
    return { x: cx, y: cy }
  }

  const openAt = (x: number, y: number) => {
    longPressedRef.current = true
    try {
      navigator.vibrate?.(30)
    } catch {
      /* haptics unsupported */
    }
    onOpenAt(clampPos(x, y))
  }

  // 外部（⋯ 按钮）传入坐标
  React.useEffect(() => {
    if (menuAt) longPressedRef.current = true
  }, [menuAt])

  const close = React.useCallback(() => {
    onOpenAt(null)
    // 释放后短暂吞掉后续 click（长按后立刻抬手）
    window.setTimeout(() => {
      longPressedRef.current = false
    }, 350)
  }, [onOpenAt])

  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const onScroll = () => close()
    const onResize = () => close()
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, close])

  React.useEffect(() => clearTimer, [])

  const handleAction = (key: string) => {
    onAction(key)
    close()
  }

  const menuH = actions.length * ROW_HEIGHT + MENU_PAD
  const originX = menuAt ? (menuAt.x > window.innerWidth / 2 ? 'right' : 'left') : 'left'
  const originY = menuAt
    ? menuAt.y + menuH > window.innerHeight - 24
      ? 'bottom'
      : 'top'
    : 'top'

  const panel =
    open && menuAt ? (
      <div
        className="fixed inset-0 z-[9999]"
        onClick={close}
        onContextMenu={(e) => {
          e.preventDefault()
          close()
        }}
      >
        <motion.div
          role="menu"
          aria-label="消息操作菜单"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.14, ease: 'easeOut' }}
          style={{
            position: 'fixed',
            left: menuAt.x,
            top: menuAt.y,
            width: MENU_WIDTH,
            transformOrigin: `${originX} ${originY}`,
          }}
          className="pointer-events-auto rounded-2xl border border-white/10 bg-zinc-900/95 p-1.5 text-white shadow-2xl backdrop-blur"
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation()
                handleAction(a.key)
              }}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] transition-colors',
                a.danger ? 'text-red-400 hover:bg-red-500/15' : 'text-zinc-100 hover:bg-white/10',
              )}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">{a.icon}</span>
              <span className="truncate">{a.label}</span>
            </button>
          ))}
        </motion.div>
      </div>
    ) : null

  return (
    <>
      <span
        className={cn('inline-block select-none [-webkit-touch-callout:none]', className)}
        onContextMenu={(e) => {
          e.preventDefault()
          clearTimer()
          startRef.current = null
          openAt(e.clientX, e.clientY)
        }}
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse') return // 鼠标走右键
          if (menuAt !== null) return // 菜单已打开，不重复触发
          startRef.current = { x: e.clientX, y: e.clientY }
          clearTimer()
          timerRef.current = window.setTimeout(() => {
            timerRef.current = null
            const p = startRef.current
            if (!p) return
            openAt(p.x, p.y)
          }, LONG_PRESS_MS)
        }}
        onPointerMove={(e) => {
          const p = startRef.current
          if (!p || timerRef.current === null) return
          if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_TOLERANCE) {
            clearTimer()
            startRef.current = null
          }
        }}
        onPointerUp={() => {
          clearTimer()
          startRef.current = null
        }}
        onPointerCancel={() => {
          clearTimer()
          startRef.current = null
        }}
        onClickCapture={(e) => {
          // 长按后的抬手 click 不透传（避免误触发内容内交互）
          if (!longPressedRef.current) return
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        {children}
      </span>
      {mounted && panel ? createPortal(panel, document.body) : null}
    </>
  )
}

// ---------- 主组件 ----------

export function SharedConversationView({ token, onExit, embedded = false }: SharedConversationViewProps) {
  const [state, setState] = React.useState<ViewState>({ status: 'loading' })
  const [zoomImg, setZoomImg] = React.useState<string | null>(null)
  // ---- 自研菜单 / 多选 / 追问 / 导出 ----
  const [menuFor, setMenuFor] = React.useState<string | null>(null)
  const [menuAt, setMenuAt] = React.useState<{ x: number; y: number } | null>(null)
  const [selectMode, setSelectMode] = React.useState(false)
  const [checked, setChecked] = React.useState<Set<string>>(new Set())
  const [exportOpen, setExportOpen] = React.useState(false)
  const [followupFor, setFollowupFor] = React.useState<SharedMessage | null>(null)
  const [followupQ, setFollowupQ] = React.useState('')
  const [followupBusy, setFollowupBusy] = React.useState(false)
  // ---- 朗读（/api/tts + Audio，访客回退浏览器语音合成） ----
  const [speakingId, setSpeakingId] = React.useState<string | null>(null)
  const audioRef = React.useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = React.useRef<string | null>(null)
  const browserStopRef = React.useRef<(() => void) | null>(null)

  React.useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    fetch(`/api/share/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          conversation?: ConvPayload['conversation']
          messages?: SharedMessage[]
          share?: ShareInfo | null
          card?: unknown
          error?: string
        }
        if (!res.ok) throw new Error(data.error || '分享链接不存在或已失效')
        if (data.conversation && Array.isArray(data.messages)) {
          return {
            conversation: data.conversation,
            messages: data.messages,
            share: data.share ?? null,
          } as ConvPayload
        }
        if (data.card) return 'card' as const
        throw new Error('分享内容格式不受支持')
      })
      .then((data) => {
        if (!alive) return
        if (data === 'card') setState({ status: 'card' })
        else setState({ status: 'conversation', payload: data })
      })
      .catch((err) => {
        if (alive) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : '加载失败',
          })
        }
      })
    return () => {
      alive = false
    }
  }, [token])

  // 卸载停止朗读
  React.useEffect(() => {
    return () => {
      window.speechSynthesis?.cancel()
      audioRef.current?.pause()
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
    }
  }, [])

  const stopSpeak = React.useCallback(() => {
    browserStopRef.current?.()
    browserStopRef.current = null
    window.speechSynthesis?.cancel()
    audioRef.current?.pause()
    audioRef.current = null
    setSpeakingId(null)
  }, [])

  const speakMessage = React.useCallback(
    (m: SharedMessage) => {
      if (speakingId === m.id) {
        stopSpeak()
        return
      }
      stopSpeak()
      const text = speakableText(m.content)
      if (!text) {
        toast.error('没有可朗读的内容')
        return
      }
      setSpeakingId(m.id)
      void (async () => {
        try {
          // 与 ChatTool 相同的服务端 TTS 机制（/api/tts + Audio）
          const res = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice: 'tongtong', speed: 1 }),
          })
          if (res.status === 401) throw new Error('未登录')
          if (!res.ok) throw new Error('生成语音失败')
          const blob = await res.blob()
          if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
          const url = URL.createObjectURL(blob)
          audioUrlRef.current = url
          const audio = new Audio(url)
          audio.onended = () => setSpeakingId(null)
          audio.onerror = () => setSpeakingId(null)
          audioRef.current = audio
          try {
            await audio.play()
          } catch {
            setSpeakingId(null)
          }
        } catch {
          // 访客未登录 / 服务端失败 → 浏览器语音合成兜底
          browserStopRef.current = browserSpeakChunks(text, () => setSpeakingId(null))
        }
      })()
    },
    [speakingId, stopSpeak],
  )

  // ---------- 书籍内容分享 → 委托 SharedCardView（其内部自取数渲染） ----------
  if (state.status === 'card') {
    return <SharedCardView token={token} onExit={onExit ?? (() => {})} />
  }

  const badge = state.status === 'conversation' ? getExpiryBadge(state.payload.share) : null

  // ---------- 错误 / 加载 ----------
  if (state.status === 'error') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-3xl border border-dashed border-border px-6 py-20 text-center">
        <AlertCircle className="size-12 text-destructive/60" strokeWidth={1.25} />
        <div>
          <p className="text-base font-medium">{state.message}</p>
          <p className="mt-1 text-sm text-muted-foreground/70">
            分享不存在或已过期，链接可能已被取消共享
          </p>
        </div>
        {!embedded && onExit && (
          <Button variant="outline" className="h-10 rounded-full px-6" onClick={onExit}>
            返回首页
          </Button>
        )}
      </div>
    )
  }

  if (state.status === 'loading') {
    return (
      <div className="flex-1 space-y-4 px-1 py-4">
        <Skeleton className="h-7 w-2/3 rounded-lg" />
        <div className="flex justify-end">
          <Skeleton className="h-10 w-2/3 rounded-2xl" />
        </div>
        <div className="flex justify-start">
          <Skeleton className="h-16 w-3/4 rounded-2xl" />
        </div>
        <div className="flex justify-end">
          <Skeleton className="h-10 w-1/2 rounded-2xl" />
        </div>
        <div className="flex justify-start">
          <Skeleton className="h-20 w-2/3 rounded-2xl" />
        </div>
      </div>
    )
  }

  // ---------- 对话视图 ----------
  const { conversation, messages } = state.payload
  const typeLabel = convTypeLabel(conversation.type)

  // ---- 多选 ----
  const checkedMessages = messages.filter((m) => checked.has(m.id))
  const allChecked = messages.length > 0 && checkedMessages.length === messages.length
  const toggleChecked = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const exitSelect = () => {
    setSelectMode(false)
    setChecked(new Set())
  }

  // ---- 单条操作菜单 ----
  const openMenuFor = (m: SharedMessage, x: number, y: number) => {
    setMenuFor(m.id)
    setMenuAt({ x, y })
  }

  const handleMenuAction = (key: string) => {
    const m = messages.find((x) => x.id === menuFor)
    if (!m) return
    if (key === 'copy') {
      void navigator.clipboard
        .writeText(m.content)
        .then(() => toast.success('已复制该消息'))
        .catch(() => toast.error('复制失败'))
    } else if (key === 'speak') {
      speakMessage(m)
    } else if (key === 'followup') {
      setFollowupQ('')
      setFollowupFor(m)
    } else if (key === 'select') {
      setSelectMode(true)
      setChecked((prev) => new Set(prev).add(m.id))
    }
  }

  // ---- 追问提交（复用 followup-popover 的数据流：新建 followup 对话 + 写入
  //      首条用户消息 + 打开；分享页全屏形态跳主应用 ?conv=，预览形态派发事件） ----
  const submitFollowup = async () => {
    if (!followupFor) return
    const q = followupQ.trim()
    if (!q) return
    setFollowupBusy(true)
    try {
      const convRes = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'followup',
          title: followupFor.content.slice(0, 12) || '追问',
        }),
      })
      if (!convRes.ok) {
        const e = (await convRes.json().catch(() => ({}))) as { error?: string }
        throw new Error(e.error || '登录后才能追问')
      }
      const convData = (await convRes.json()) as { conversation?: { id?: string } }
      const convId = convData.conversation?.id
      if (!convId) throw new Error('新建追问对话失败')
      const content = `【选中文本】\n${followupFor.content.slice(0, 2000)}\n\n【来源】共享对话「${conversation.title}」\n\n【追问】\n${q}`
      const msgRes = await fetch(`/api/conversations/${encodeURIComponent(convId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content }] }),
      })
      if (!msgRes.ok) {
        void fetch(`/api/conversations/${encodeURIComponent(convId)}`, { method: 'DELETE' }).catch(() => {})
        throw new Error('保存追问失败')
      }
      setFollowupFor(null)
      setFollowupQ('')
      toast.success('已发起追问')
      if (embedded) {
        window.dispatchEvent(new CustomEvent('app:openConversation', { detail: { id: convId } }))
      } else {
        window.location.href = `/?conv=${encodeURIComponent(convId)}`
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '追问失败，请重试')
    } finally {
      setFollowupBusy(false)
    }
  }

  const headerBlock = (
    <div className={cn('flex items-start gap-2', embedded ? 'pr-10' : 'pr-2')}>
      <div className="min-w-0 flex-1">
        <h2 className="text-xl font-bold leading-snug tracking-tight">
          {conversation.title || '未命名对话'}
        </h2>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:text-violet-300">
            {typeLabel}
          </span>
          <span>{messages.length} 条消息</span>
          <span aria-hidden>·</span>
          <span>创建于 {fmtTime(conversation.createdAt)}</span>
        </div>
      </div>
      {badge && (
        <span
          className={cn(
            'inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-[11px] font-medium',
            badge.className,
          )}
        >
          {badge.label}
        </span>
      )}
    </div>
  )

  const messageList = messages.length === 0 ? (
    <div className="flex items-center justify-center rounded-2xl border border-dashed border-border py-16 text-sm text-muted-foreground">
      对话内容为空
    </div>
  ) : (
    <ol className="space-y-4" role="list" aria-label="对话消息">
      {messages.map((m) =>
        m.role === 'user' ? (
          <li key={m.id} className="flex flex-col items-end gap-1">
            {selectMode && (
              <Checkbox
                checked={checked.has(m.id)}
                onCheckedChange={() => toggleChecked(m.id)}
                aria-label="选择该消息"
                className="mr-auto self-start"
              />
            )}
            <div
              className={cn(
                'max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm leading-relaxed text-primary-foreground',
                selectMode && 'pointer-events-none',
              )}
              onClick={selectMode ? () => toggleChecked(m.id) : undefined}
            >
              {m.images.length > 0 && (
                <div className="mb-1.5 flex max-w-[220px] flex-wrap gap-1.5">
                  {m.images.map((src, i) => (
                    <button
                      key={i}
                      type="button"
                      aria-label="放大图片"
                      onClick={(e) => {
                        e.stopPropagation()
                        setZoomImg(src)
                      }}
                      className="overflow-hidden rounded-lg ring-1 ring-primary-foreground/20 transition-opacity hover:opacity-90"
                    >
                      <img src={src} alt="附图" className="h-20 w-20 max-w-full object-cover" loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
              {m.content && <p className="whitespace-pre-wrap break-words">{m.content}</p>}
            </div>
            <time className="pr-1 text-[10px] text-muted-foreground/70">{fmtTime(m.createdAt)}</time>
          </li>
        ) : (
          <li key={m.id} className="flex flex-col items-start gap-1">
            {selectMode && (
              <Checkbox
                checked={checked.has(m.id)}
                onCheckedChange={() => toggleChecked(m.id)}
                aria-label="选择该消息"
              />
            )}
            <div
              className={cn(
                'flex max-w-[85%] flex-col items-start gap-1.5',
                selectMode && 'pointer-events-none',
              )}
              onClick={selectMode ? () => toggleChecked(m.id) : undefined}
            >
              {m.images.length > 0 && (
                <div className="flex max-w-full flex-wrap gap-1.5">
                  {m.images.map((src, i) => (
                    <button
                      key={i}
                      type="button"
                      aria-label="放大图片"
                      onClick={(e) => {
                        e.stopPropagation()
                        setZoomImg(src)
                      }}
                      className="overflow-hidden rounded-xl border border-border"
                    >
                      <img src={src} alt="附图" className="max-w-full rounded-xl" loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
              <BubbleMenu
                actions={[
                  { key: 'copy', label: '复制', icon: <Copy className="size-4" /> },
                  {
                    key: 'speak',
                    label: speakingId === m.id ? '停止朗读' : '朗读',
                    icon: speakingId === m.id
                      ? <Pause className="size-4" />
                      : <Volume2 className="size-4" />,
                  },
                  { key: 'followup', label: '追问', icon: <MessageCircleQuestion className="size-4" /> },
                  { key: 'select', label: '多选', icon: <CheckSquare className="size-4" /> },
                ]}
                onAction={handleMenuAction}
                menuAt={menuFor === m.id ? menuAt : null}
                onOpenAt={(pos) => {
                  if (pos) {
                    setMenuFor(m.id)
                    setMenuAt(pos)
                  } else {
                    setMenuFor(null)
                    setMenuAt(null)
                  }
                }}
                className="max-w-full"
              >
                {m.content ? (
                  <RichContent
                    content={m.content}
                    className="rounded-2xl rounded-bl-sm bg-muted px-3 py-2"
                  />
                ) : (
                  <span />
                )}
              </BubbleMenu>
            </div>
            <div className="flex items-center gap-1 pl-1">
              <time className="text-[10px] text-muted-foreground/70">{fmtTime(m.createdAt)}</time>
              {!selectMode && (
                <button
                  type="button"
                  aria-label="消息操作"
                  title="复制 / 朗读 / 追问 / 多选"
                  onClick={(e) => openMenuFor(m, e.clientX - 40, e.clientY + 8)}
                  className="flex size-6 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
              )}
              {!selectMode && speakingId === m.id && (
                <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                  <Loader2 className="size-3 animate-spin" />
                  朗读中…
                </span>
              )}
            </div>
          </li>
        ),
      )}
    </ol>
  )

  /** 多选模式复选框列（覆盖在每条消息左侧）。 */
  const selectBar = selectMode ? (
    <div className={cn(
      'flex flex-wrap items-center gap-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-2',
      embedded ? 'mb-3' : 'mb-3',
    )}>
      <button
        type="button"
        onClick={() => setChecked(allChecked ? new Set() : new Set(messages.map((m) => m.id)))}
        className="flex h-8 shrink-0 items-center rounded-full border border-border bg-background px-2.5 text-xs transition-colors hover:bg-accent"
      >
        {allChecked ? '取消全选' : '全选'}
      </button>
      <span className="min-w-0 flex-1 basis-14 truncate text-xs text-muted-foreground">
        已选 {checkedMessages.length} / {messages.length} 条
      </span>
      <Button
        variant="outline"
        size="sm"
        className="h-8 rounded-full text-xs"
        disabled={checkedMessages.length === 0}
        onClick={() => {
          void navigator.clipboard
            .writeText(checkedMessages.map((m) => `[${m.role === 'user' ? '用户' : 'AI'}]\n${m.content}`).join('\n\n'))
            .then(() => toast.success('已复制所选消息'))
            .catch(() => toast.error('复制失败'))
        }}
      >
        <ClipboardCopy className="size-3.5" />
        复制
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-8 rounded-full text-xs"
        disabled={checkedMessages.length === 0}
        onClick={() => setExportOpen(true)}
      >
        <Download className="size-3.5" />
        导出
      </Button>
      <Button variant="outline" size="sm" className="h-8 shrink-0 rounded-full text-xs" onClick={exitSelect}>
        完成
      </Button>
    </div>
  ) : null

  const zoomViewer = (
    <ImageViewer
      src={zoomImg}
      open={!!zoomImg}
      onOpenChange={(o) => {
        if (!o) setZoomImg(null)
      }}
    />
  )

  const watermark = (
    <div
      className={cn(
        'flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground',
        embedded ? 'border-t border-border py-3' : '',
      )}
    >
      <BookOpenText className="size-3.5 text-emerald-600" strokeWidth={1.75} aria-hidden />
      由背书吧分享
    </div>
  )

  // ---------- 形态分支 ----------
  if (embedded) {
    return (
      <div className="flex min-h-0 flex-col">
        <div className="px-4 pt-4">{headerBlock}</div>
        <div className="px-4 pb-4 pt-5">
          {selectBar}
          {messageList}
        </div>
        <div className="mt-auto px-4">{watermark}</div>
        {zoomViewer}
        <FollowupDialog
          message={followupFor}
          question={followupQ}
          onQuestionChange={setFollowupQ}
          busy={followupBusy}
          onCancel={() => setFollowupFor(null)}
          onSubmit={() => void submitFollowup()}
        />
        <ConversationExportDialog
          open={exportOpen}
          onOpenChange={setExportOpen}
          sections={[
            {
              title: conversation.title || '共享对话',
              type: conversation.type,
              messages: checkedMessages.map((m): ExportMessage => ({
                id: m.id,
                role: m.role,
                content: m.content,
                images: m.images,
                createdAt: m.createdAt,
              })),
            },
          ]}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-1 flex-col bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-2 px-4">
          {onExit && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="返回"
              className="size-9 shrink-0 text-muted-foreground"
              onClick={onExit}
            >
              <ArrowLeft className="size-5" strokeWidth={1.75} />
            </Button>
          )}
          <h1 className="truncate text-base font-bold">共享对话</h1>
          {selectMode && (
            <button
              type="button"
              onClick={exitSelect}
              aria-label="退出多选"
              className="ml-auto flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          )}
          {badge && !selectMode && (
            <span
              className={cn(
                'ml-auto inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-[11px] font-medium',
                badge.className,
              )}
            >
              {badge.label}
            </span>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pb-10 pt-6">
        {headerBlock}
        <div className="mt-6">
          {selectBar}
          {messageList}
        </div>
      </main>

      <footer className="mt-auto border-t bg-background">
        <div className="mx-auto max-w-2xl px-4 py-3">{watermark}</div>
      </footer>

      {zoomViewer}
      <FollowupDialog
        message={followupFor}
        question={followupQ}
        onQuestionChange={setFollowupQ}
        busy={followupBusy}
        onCancel={() => setFollowupFor(null)}
        onSubmit={() => void submitFollowup()}
      />
      <ConversationExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        sections={[
          {
            title: conversation.title || '共享对话',
            type: conversation.type,
            messages: checkedMessages.map((m): ExportMessage => ({
              id: m.id,
              role: m.role,
              content: m.content,
              images: m.images,
              createdAt: m.createdAt,
            })),
          },
        ]}
      />
    </div>
  )
}

// ---------- 追问弹层（复刻 followup-popover 的交互：内容预览 + 问题输入） ----------

function FollowupDialog({
  message,
  question,
  onQuestionChange,
  busy,
  onCancel,
  onSubmit,
}: {
  message: SharedMessage | null
  question: string
  onQuestionChange: (q: string) => void
  busy: boolean
  onCancel: () => void
  onSubmit: () => void
}) {
  if (!message) return null
  const preview = message.content.slice(0, 500)
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onCancel() }}>
      <DialogContent className="rounded-2xl sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>追问</DialogTitle>
        </DialogHeader>
        <div className="max-h-40 overflow-y-auto rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-[13px] leading-relaxed text-foreground/85">
          {preview}
          {message.content.length > 500 ? '…' : ''}
        </div>
        <Textarea
          value={question}
          onChange={(e) => onQuestionChange(e.target.value)}
          placeholder="针对这条内容追问…"
          aria-label="追问内容"
          className="min-h-20 rounded-xl text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              onSubmit()
            }
          }}
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          将新建一条追问对话并跳转继续（需登录）。
        </p>
        <DialogFooter>
          <Button variant="outline" className="rounded-full" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button className="rounded-full" disabled={busy || !question.trim()} onClick={onSubmit}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            发起追问
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default SharedConversationView
