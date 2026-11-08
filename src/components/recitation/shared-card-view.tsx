'use client'

// Guest view of /share/[token] — read-only shared card with two modes:
//   阅读 (green keyword highlighting) and 背书 (cloze recitation).
// Guests are NOT logged in: nothing here may PATCH/POST the card, and TTS is
// browser-only (window.speechSynthesis) because /api/tts requires auth.
import * as React from 'react'
import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import { AlertCircle, ArrowLeft, BookOpenText, Eye, EyeOff } from 'lucide-react'
import { toast } from 'sonner'

import type { ShareInfo } from '@/lib/types'
import { cn } from '@/lib/utils'
import { normKeywordEntries, keywordTexts } from '@/lib/cloze'
import { ClozeText } from '@/components/recitation/cloze-text'
import RichContent from '@/components/recitation/rich-content'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

/** Read-only card payload returned by the public share endpoint. */
interface SharedCard {
  id: string
  title: string
  content: string
  /** 旧版 string[] 或新版 [{t, occ}] 均可（读取时归一化）。 */
  keywords: unknown[]
  createdAt: string
  updatedAt: string
}

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; card: SharedCard; share: ShareInfo | null }

type GuestTab = 'read' | 'cloze'

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

/**
 * Guest TTS — browser-only. The server /api/tts endpoint requires a logged-in
 * session, so the shared (guest) view always speaks via speechSynthesis with a
 * Chinese voice, cancelling any previous utterance first.
 */
function speakWithBrowser(text: string): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    toast.error('当前浏览器不支持朗读')
    return
  }
  const synth = window.speechSynthesis
  try {
    synth.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'zh-CN'
    u.rate = 0.9
    // Prefer a Chinese voice when one is installed (list may be async — the
    // zh-CN lang hint is the reliable fallback).
    const zhVoice = synth
      .getVoices()
      .find((v) => v.lang.replace('_', '-').toLowerCase().startsWith('zh'))
    if (zhVoice) u.voice = zhVoice
    synth.speak(u)
  } catch {
    toast.error('朗读失败，请重试')
  }
}

export function SharedCardView({ token, onExit }: SharedCardViewProps) {
  const [state, setState] = React.useState<ViewState>({ status: 'loading' })
  const [tab, setTab] = React.useState<GuestTab>('read')
  // 背书 mode local state — never persisted (guests cannot modify the card).
  const [showAnswers, setShowAnswers] = React.useState(false)
  const [revealed, setRevealed] = React.useState<Set<number>>(new Set())

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

  // Tap a blank to reveal it locally (same semantics as the reader view).
  const handleReveal = React.useCallback((idx: number) => {
    setRevealed((prev) => {
      if (prev.has(idx)) return prev
      const next = new Set(prev)
      next.add(idx)
      return next
    })
  }, [])

  // readOnly mode never invokes editing callbacks — this no-op only satisfies
  // the (currently required) prop signature without persisting anything.
  const noopKeyword = React.useCallback(() => {}, [])

  // 阅读 tab：超级编辑器富文本渲染（颜色/荧光笔/表格/公式/图片/挖空标记），
  // 并叠加关键词高亮。与主阅读器观感一致。
  const guestHtml = React.useMemo(() => {
    if (state.status !== 'ok') return ''
    const kws = keywordTexts(normKeywordEntries(state.card.keywords))
      .map((k) => k.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
    let s = String(state.card.content ?? '')
    // 1) 转义原生 HTML（防注入；RichContent 的 rehypeRaw 只应渲染我们生成的标签）
    s = s.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // 2) 关键词高亮（先于自定义标记，标记符号不会被关键词误伤）
    if (kws.length) {
      const re = new RegExp(`(${kws.map(escapeRegExp).join('|')})`, 'g')
      s = s.replace(
        re,
        '<mark class="rounded-md bg-emerald-500/15 px-1 py-0.5 font-medium text-emerald-700 dark:text-emerald-300">$1</mark>',
      )
    }
    // 3) 编辑器自定义标记 → 标准 HTML
    // 字色 %%#dc2626|文%% → <span style="color:#dc2626">（颜色值白名单校验）
    s = s.replace(/%%([^|%\n]+)\|([\s\S]*?)%%/g, (_m, color: string, text: string) => {
      const c = color.trim()
      const safe = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)$/.test(c) ? c : 'inherit'
      return `<span style="color:${safe}">${text}</span>`
    })
    // 荧光笔 ==文== → <mark>（嵌套时外层已存在 mark 也可接受）
    s = s.replace(/==([^=\n]+)==/g, '<mark class="rounded bg-amber-300/70 px-0.5 dark:bg-amber-500/40">$1</mark>')
    // 挖空标记 {{词}} → 加粗（阅读态提示重点）
    s = s.replace(/\{\{([^}]+)\}\}/g, '<strong>$1</strong>')
    return s
  }, [state])

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

            {/* ---------- segmented tabs ---------- */}
            <div
              role="tablist"
              aria-label="查看方式"
              className="mt-6 flex w-fit rounded-full border border-border bg-muted p-1"
            >
              {(
                [
                  { key: 'read', label: '阅读' },
                  { key: 'cloze', label: '背书' },
                ] as const
              ).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}
                  className={cn(
                    'flex h-9 min-w-24 items-center justify-center rounded-full px-5 text-sm font-medium transition-colors',
                    tab === t.key
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {tab === 'read' ? (
              <div className="mt-6">
                <RichContent content={guestHtml} className="text-[15px] leading-8 text-foreground/90" />
              </div>
            ) : (
              <div className="mt-6">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">
                    点击挖空处显示答案 · 长按可朗读
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 shrink-0 rounded-full px-4"
                    onClick={() => setShowAnswers((v) => !v)}
                  >
                    {showAnswers ? (
                      <EyeOff className="size-4" strokeWidth={1.75} />
                    ) : (
                      <Eye className="size-4" strokeWidth={1.75} />
                    )}
                    {showAnswers ? '隐藏答案' : '显示答案'}
                  </Button>
                </div>
                <ClozeText
                  content={state.card.content}
                  keywords={normKeywordEntries(state.card.keywords)}
                  style="circle"
                  showAnswers={showAnswers}
                  fontSize={18}
                  selectMenuEnabled
                  readOnly
                  speakText={speakWithBrowser}
                  revealed={revealed}
                  onReveal={handleReveal}
                  onToggleKeyword={noopKeyword}
                />
              </div>
            )}
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
