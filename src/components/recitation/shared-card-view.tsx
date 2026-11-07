'use client'

import * as React from 'react'
import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import { AlertCircle, ArrowLeft, BookOpenText } from 'lucide-react'

import type { ShareInfo } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

/** Read-only card payload returned by the public share endpoint. */
interface SharedCard {
  id: string
  title: string
  content: string
  keywords: string[]
  createdAt: string
  updatedAt: string
}

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; card: SharedCard; share: ShareInfo | null }

interface SharedCardViewProps {
  token: string
  onExit: () => void
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getExpiryBadge(share: ShareInfo | null): { label: string; className: string } {
  const ok =
    'border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400'
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

export function SharedCardView({ token, onExit }: SharedCardViewProps) {
  const [state, setState] = React.useState<ViewState>({ status: 'loading' })

  React.useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    fetch(`/api/share/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || '分享链接不存在或已失效')
        return data as { card: SharedCard; share: ShareInfo | null }
      })
      .then((data) => {
        if (alive) setState({ status: 'ok', card: data.card, share: data.share ?? null })
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

  // Memoized keyword-highlighted paragraphs. Safe against empty / duplicate /
  // overlapping keywords: dedupe, drop empties, longest-first alternation.
  const renderParagraphs = React.useCallback((card: SharedCard): React.ReactNode[] => {
    const paragraphs = card.content.split('\n')
    const keywords = Array.from(
      new Set(card.keywords.map((k) => k.trim()).filter((k) => k.length > 0)),
    ).sort((a, b) => b.length - a.length)
    const keywordSet = new Set(keywords)

    const renderText = (text: string, keyPrefix: string): React.ReactNode[] => {
      if (keywords.length === 0) return [text]
      const re = new RegExp(`(${keywords.map(escapeRegExp).join('|')})`, 'g')
      const parts = text.split(re)
      return parts.map((part, i) =>
        keywordSet.has(part) ? (
          <mark
            key={`${keyPrefix}-${i}`}
            className="rounded-md bg-emerald-500/15 px-1 py-0.5 font-medium text-emerald-700 dark:text-emerald-300"
          >
            {part}
          </mark>
        ) : (
          <React.Fragment key={`${keyPrefix}-${i}`}>{part}</React.Fragment>
        ),
      )
    }

    return paragraphs.map((p, i) => {
      if (!p.trim()) return <div key={`p-${i}`} className="h-3" aria-hidden />
      return (
        <p key={`p-${i}`} className="text-[15px] leading-8 text-foreground/90">
          {renderText(p, `p-${i}`)}
        </p>
      )
    })
  }, [])

  const badge = state.status === 'ok' ? getExpiryBadge(state.share) : null

  return (
    <div className="flex min-h-screen flex-1 flex-col bg-background text-foreground">
      {/* ---------- header ---------- */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-2 px-4">
          <Button
            variant="ghost"
            size="icon"
            aria-label="返回"
            className="size-9 shrink-0 text-muted-foreground"
            onClick={onExit}
          >
            <ArrowLeft className="size-5" strokeWidth={1.75} />
          </Button>
          <h1 className="truncate text-base font-bold">共享背书卡</h1>
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

      {/* ---------- body ---------- */}
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pb-16 pt-6">
        {state.status === 'loading' ? (
          <div className="space-y-4">
            <Skeleton className="h-8 w-2/3 rounded-xl" />
            <Skeleton className="h-4 w-full rounded-md" />
            <Skeleton className="h-4 w-11/12 rounded-md" />
            <Skeleton className="h-4 w-full rounded-md" />
            <Skeleton className="h-4 w-3/4 rounded-md" />
            <Skeleton className="mt-6 h-4 w-5/6 rounded-md" />
            <Skeleton className="h-4 w-full rounded-md" />
          </div>
        ) : state.status === 'error' ? (
          <div className="flex flex-col items-center justify-center gap-4 rounded-3xl border border-dashed border-border py-24 text-center">
            <AlertCircle className="size-12 text-destructive/60" strokeWidth={1.25} />
            <div>
              <p className="text-base font-medium">{state.message}</p>
              <p className="mt-1 text-sm text-muted-foreground/70">
                链接可能已被取消共享或已过期
              </p>
            </div>
            <Button variant="outline" className="h-10 rounded-full px-6" onClick={onExit}>
              返回首页
            </Button>
          </div>
        ) : (
          <>
            <h2 className="text-2xl font-bold leading-snug tracking-tight">
              {state.card.title || '未命名背书卡'}
            </h2>
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <span>{state.card.content.length} 字</span>
              <span aria-hidden>·</span>
              <span>
                创建于{' '}
                {format(
                  new Date(state.card.createdAt),
                  'yyyy/MM/dd HH:mm',
                  { locale: zhCN },
                )}
              </span>
            </div>
            <div className="mt-6 space-y-3">{renderParagraphs(state.card)}</div>
          </>
        )}
      </main>

      {/* ---------- footer ---------- */}
      <footer className="mt-auto border-t bg-background">
        <div className="mx-auto flex max-w-2xl items-center justify-center gap-1.5 px-4 py-3 text-[11px] text-muted-foreground">
          <BookOpenText className="size-3.5 text-emerald-600" strokeWidth={1.75} />
          来自背书吧的分享
        </div>
      </footer>
    </div>
  )
}
