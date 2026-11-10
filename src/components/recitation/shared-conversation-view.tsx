'use client'

// SharedConversationView — 公开「AI 对话」分享视图（访客无需登录）。
// 自取数：GET /api/share/:token →
//   • 响应含 conversation 字段 → 渲染只读对话（user 右绿 / assistant 左灰白
//     气泡，消息用 RichContent 渲染 MD/LaTeX/mermaid/SVG/HTML/代码块/图片）；
//     消息内图片 max-w-full 渲染，点击放大 Dialog。
//   • 响应含 card 字段（书籍内容分享）→ 内部委托 <SharedCardView> 兼容渲染，
//     因此 page.tsx 只需挂载本组件即可同时服务两类分享（无需预知类型）。
//   • 404 / 410 / 网络错误 → “分享不存在/已过期”错误态。
//
// 两种形态：
//   • 全屏（onExit 提供时显示返回按钮）——供 /share/[token] 页面挂载；
//   • embedded（嵌入 Dialog 预览）——供分享中心「预览」按钮使用。
import * as React from 'react'
import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import { AlertCircle, ArrowLeft, BookOpenText } from 'lucide-react'

import type { ShareInfo } from '@/lib/types'
import { cn } from '@/lib/utils'
import { SharedCardView } from '@/components/recitation/shared-card-view'
import RichContent from '@/components/recitation/rich-content'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'

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

export function SharedConversationView({ token, onExit, embedded = false }: SharedConversationViewProps) {
  const [state, setState] = React.useState<ViewState>({ status: 'loading' })
  const [zoomImg, setZoomImg] = React.useState<string | null>(null)

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
            <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm leading-relaxed text-primary-foreground">
              {m.images.length > 0 && (
                <div className="mb-1.5 flex max-w-[220px] flex-wrap gap-1.5">
                  {m.images.map((src, i) => (
                    <button
                      key={i}
                      type="button"
                      aria-label="放大图片"
                      onClick={() => setZoomImg(src)}
                      className="overflow-hidden rounded-lg ring-1 ring-primary-foreground/20 transition-opacity hover:opacity-90"
                    >
                      { }
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
            {m.images.length > 0 && (
              <div className="flex max-w-[85%] flex-wrap gap-1.5">
                {m.images.map((src, i) => (
                  <button
                    key={i}
                    type="button"
                    aria-label="放大图片"
                    onClick={() => setZoomImg(src)}
                    className="overflow-hidden rounded-xl border border-border"
                  >
                    { }
                    <img src={src} alt="附图" className="max-w-full rounded-xl" loading="lazy" />
                  </button>
                ))}
              </div>
            )}
            {m.content && (
              <RichContent
                content={m.content}
                className="max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3 py-2"
              />
            )}
            <time className="pl-1 text-[10px] text-muted-foreground/70">{fmtTime(m.createdAt)}</time>
          </li>
        ),
      )}
    </ol>
  )

  const zoomDialog = (
    <Dialog open={!!zoomImg} onOpenChange={(o) => { if (!o) setZoomImg(null) }}>
      <DialogContent
        aria-describedby={undefined}
        className="flex max-h-[92dvh] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-md"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>查看图片</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/5 p-3">
          {zoomImg && (
             
            <img
              src={zoomImg}
              alt="消息附图"
              className="max-h-[80dvh] max-w-full rounded-xl object-contain"
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
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
        <div className="px-4 pb-4 pt-5">{messageList}</div>
        <div className="mt-auto px-4">{watermark}</div>
        {zoomDialog}
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
          {badge && (
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
        <div className="mt-6">{messageList}</div>
      </main>

      <footer className="mt-auto border-t bg-background">
        <div className="mx-auto max-w-2xl px-4 py-3">{watermark}</div>
      </footer>

      {zoomDialog}
    </div>
  )
}

export default SharedConversationView
