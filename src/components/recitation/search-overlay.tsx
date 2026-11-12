'use client'

// SearchOverlay — 统一检索组件（一个组件两种模式）：
//
//   • mode='home'  底部大浮层（Sheet side="bottom"，移动优先）：
//     书本（卡片）/ 文章（卡片 Q&A 素材 blocks）/ AI 对话 全局混合检索。
//     语音输入（复用 VoiceInput）、范围 Tab（全部|书本|文章|对话）、
//     命中词高亮、最近搜索（localStorage ≤ 8 条）、300ms 防抖。
//     点击结果派发 window 事件（app:openCard / app:openConversation），
//     由主页 page.tsx 接线打开对应视图，随后关闭浮层。
//
//   • mode='share' 分享中心内嵌检索条（非浮层）：对父组件传入的 shares
//     列表做 标题/token 匹配 + 全部/有效/已过期 筛选 + 创建/过期时间排序，
//     每次条件变化通过 onFiltered 把结果交回父组件渲染。
//     ⚠ 父组件必须用 React.useCallback 包裹 onFiltered（本组件用受控 effect
//     回调，不稳定的回调会触发渲染循环）。open=false 时渲染 null，
//     父组件在 onOpenChange(false) 时应把展示列表重置为全量。
import * as React from 'react'
import { formatDistanceToNow } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import {
  BookOpen,
  Clock,
  Feather,
  MessageSquare,
  Search,
  X,
} from 'lucide-react'

import type { CardData } from '@/lib/types'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { VoiceInput } from '@/components/recitation/voice-input'

// ---------- 事件 detail 契约（主页 page.tsx 接线用） ----------

/** app:openCard 事件 detail —— 打开某本书（reader=背书页 / blocks=文章素材编辑器）。 */
export interface AppOpenCardDetail {
  cardId: string
  target?: 'reader' | 'blocks'
}

/** app:openConversation 事件 detail —— 打开某个 AI 对话。 */
export interface AppOpenConversationDetail {
  id: string
}

// ---------- 共享类型 ----------

/** GET /api/shares 返回的单条分享（share-manager-view 与本组件共用）。 */
export interface ShareSearchRow {
  id: string
  token: string
  kind: 'card' | 'conversation'
  cardId: string
  refId: string
  title: string
  expiresAt: string | null
  createdAt: string
}

export type ShareStatusFilter = 'all' | 'valid' | 'expired'
export type ShareSortKey = 'created' | 'expires'

export interface SearchOverlayProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode?: 'home' | 'share'
  /** share 模式：待检索的分享列表（通常为当前分类 Tab 过滤后的列表）。 */
  shares?: ShareSearchRow[] | null
  /** share 模式：筛选/排序结果回调（父组件需 useCallback）。 */
  onFiltered?: (list: ShareSearchRow[] | null) => void
}

// ---------- home 模式：检索结果 ----------

interface HitFrag {
  before: string
  hit: string
  after: string
}

interface ResultItem {
  key: string
  type: 'book' | 'article' | 'conversation'
  title: string
  titleHit?: HitFrag | null
  /** 内容/消息命中片段（高亮渲染）。 */
  snippet?: HitFrag | null
  /** 无命中词的纯文本片段（标题命中型对话的最近消息）。 */
  snippetPlain?: string
  /** 来源标签（书本 / 卡名 / 对话类型）。 */
  source: string
  /** ISO 时间。 */
  time: string
  cardId?: string
  target?: 'reader' | 'blocks'
  conversationId?: string
}

type Scope = 'all' | 'books' | 'articles' | 'conversations'

const SCOPES: readonly { key: Scope; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'books', label: '书本' },
  { key: 'articles', label: '文章' },
  { key: 'conversations', label: '对话' },
]

const TYPE_META: Record<
  ResultItem['type'],
  { icon: typeof BookOpen; badge: string; box: string }
> = {
  book: {
    icon: BookOpen,
    badge: '书本',
    box: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  },
  article: {
    icon: Feather,
    badge: '文章',
    box: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  },
  conversation: {
    icon: MessageSquare,
    badge: '对话',
    box: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  },
}

/** 对话类型 → 来源徽章文案（type 由创建方任意指定，兜底为「AI 对话」）。 */
const CONV_TYPE_LABEL: Record<string, string> = {
  chat: 'AI 对话',
  ask: 'AI 问问',
  supervise: 'AI 督背',
  earback: '耳背',
}

// ---------- 最近搜索（localStorage ≤ 8 条） ----------

const RECENT_KEY = 'sb-search-recent-v1'
const RECENT_MAX = 8

function loadRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

function saveRecent(list: string[]) {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)))
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

// ---------- 工具 ----------

/** 在 text 中不区分大小写找 kw，返回 命中词±radius 的高亮片段。 */
function makeHit(text: string, kw: string, radius = 24): HitFrag | null {
  if (!text) return null
  const idx = text.toLowerCase().indexOf(kw.toLowerCase())
  if (idx < 0) return null
  const start = Math.max(0, idx - radius)
  const end = idx + kw.length + radius
  return {
    before: (start > 0 ? '…' : '') + text.slice(start, idx),
    hit: text.slice(idx, idx + kw.length),
    after: text.slice(idx + kw.length, Math.min(end, text.length)) + (end < text.length ? '…' : ''),
  }
}

function timeAgo(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return formatDistanceToNow(d, { addSuffix: true, locale: zhCN })
  } catch {
    return ''
  }
}

function truncate(text: string, n: number): string {
  return text.length > n ? text.slice(0, n) + '…' : text
}

// ---------- 命中高亮渲染 ----------

function HitText({ frag }: { frag: HitFrag }) {
  return (
    <>
      {frag.before}
      <mark className="rounded bg-yellow-200/50 px-0.5 text-inherit dark:bg-yellow-500/25 dark:text-yellow-200">
        {frag.hit}
      </mark>
      {frag.after}
    </>
  )
}

// ---------- 对话搜索接口类型（GET /api/conversations?q=） ----------

interface ConvRow {
  id: string
  title: string
  type: string
  updatedAt: string
  lastMessage: string
}

interface MessageHit {
  messageId: string
  conversationId: string
  role: string
  snippet: string
  createdAt: string
}

// =====================================================================
// 组件
// =====================================================================

export function SearchOverlay({
  open,
  onOpenChange,
  mode = 'home',
  shares = null,
  onFiltered,
}: SearchOverlayProps) {
  const [query, setQuery] = React.useState('')
  // home 模式状态
  const [scope, setScope] = React.useState<Scope>('all')
  const [results, setResults] = React.useState<ResultItem[] | null>(null)
  const [searching, setSearching] = React.useState(false)
  const [recent, setRecent] = React.useState<string[]>([])
  // share 模式状态
  const [status, setStatus] = React.useState<ShareStatusFilter>('all')
  const [sort, setSort] = React.useState<ShareSortKey>('created')

  const inputRef = React.useRef<HTMLInputElement>(null)
  const seqRef = React.useRef(0)

  // hydration 后再读 localStorage，避免 SSR/CSR 不一致
  React.useEffect(() => {
    setRecent(loadRecent())
  }, [])

  // 打开 home 浮层时聚焦输入框
  React.useEffect(() => {
    if (mode === 'home' && open) {
      const t = setTimeout(() => inputRef.current?.focus(), 120)
      return () => clearTimeout(t)
    }
  }, [mode, open])

  // ---------- home：执行检索 ----------
  const runSearch = React.useCallback(
    async (q: string, sc: Scope) => {
      const seq = ++seqRef.current
      const books: ResultItem[] = []
      const articles: ResultItem[] = []
      const convs: ResultItem[] = []

      // 书本 + 文章素材：一次拉全量卡（单用户量小），本地匹配
      if (sc === 'all' || sc === 'books' || sc === 'articles') {
        try {
          const res = await fetch('/api/cards')
          if (!res.ok) throw new Error('加载书本失败')
          const data = (await res.json()) as { cards?: CardData[] }
          const cards = data.cards ?? []
          for (const card of cards) {
            const title = card.title || '未命名卡片'
            const titleHit = sc !== 'articles' ? makeHit(title, q) : null
            const contentHit = sc !== 'articles' ? makeHit(card.content, q, 30) : null
            if (sc !== 'articles' && (titleHit || contentHit)) {
              books.push({
                key: `book-${card.id}`,
                type: 'book',
                title,
                titleHit,
                snippet: contentHit,
                source: '书本',
                time: card.updatedAt,
                cardId: card.id,
                target: 'reader',
              })
            }
            // 文章：Q&A 素材 blocks（front/back 命中即可，每本书取第一个命中块）
            if (sc !== 'books' && Array.isArray(card.blocks) && card.blocks.length) {
              for (let i = 0; i < card.blocks.length; i++) {
                const b = card.blocks[i]
                const frag = makeHit(b.front, q) ?? makeHit(b.back, q)
                if (frag) {
                  articles.push({
                    key: `article-${card.id}-${i}`,
                    type: 'article',
                    title: `${title} · 素材`,
                    snippet: frag,
                    source: title,
                    time: card.updatedAt,
                    cardId: card.id,
                    target: 'blocks',
                  })
                  break
                }
              }
            }
          }
        } catch (err) {
          // 局部失败仅轻提示，其余类型照常展示
          toast.error(err instanceof Error ? err.message : '加载书本失败')
        }
      }

      // AI 对话：服务端全局搜索（标题 + 全部消息）
      if (sc === 'all' || sc === 'conversations') {
        try {
          const res = await fetch(`/api/conversations?q=${encodeURIComponent(q)}`)
          if (!res.ok) throw new Error('搜索对话失败')
          const data = (await res.json()) as {
            conversations?: ConvRow[]
            titleHits?: string[]
            messageHits?: MessageHit[]
          }
          const titleHitIds = new Set(data.titleHits ?? [])
          // messageHits 按创建时间倒序 → 每个对话取最新一条命中
          const firstMsgByConv = new Map<string, MessageHit>()
          for (const mh of data.messageHits ?? []) {
            if (!firstMsgByConv.has(mh.conversationId)) firstMsgByConv.set(mh.conversationId, mh)
          }
          for (const c of data.conversations ?? []) {
            const titleHit = titleHitIds.has(c.id) ? makeHit(c.title || '未命名对话', q) : null
            const mh = firstMsgByConv.get(c.id)
            if (!titleHit && !mh) continue
            convs.push({
              key: `conv-${c.id}`,
              type: 'conversation',
              title: c.title || '未命名对话',
              titleHit,
              snippet: mh ? makeHit(mh.snippet, q, 16) : null,
              snippetPlain: mh ? undefined : c.lastMessage ? truncate(c.lastMessage, 64) : '',
              source: CONV_TYPE_LABEL[c.type] ?? 'AI 对话',
              time: mh?.createdAt ?? c.updatedAt,
              conversationId: c.id,
            })
          }
        } catch (err) {
          toast.error(err instanceof Error ? err.message : '搜索对话失败')
        }
      }

      // 过期请求（用户已关闭/输入已变）不再落盘
      if (seqRef.current !== seq) return
      const merged =
        sc === 'books' ? books : sc === 'articles' ? articles : sc === 'conversations' ? convs : [...books, ...articles, ...convs]
      merged.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
      setResults(merged)
      setSearching(false)
      // 记录最近搜索（去重置顶，≤8 条）
      setRecent((prev) => {
        const next = [q, ...prev.filter((x) => x !== q)].slice(0, RECENT_MAX)
        saveRecent(next)
        return next
      })
    },
    [],
  )

  // home：防抖 300ms 触发检索（换范围 Tab / 重新打开也会重搜）
  React.useEffect(() => {
    if (mode !== 'home' || !open) return
    const q = query.trim()
    if (!q) {
      setResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = setTimeout(() => void runSearch(q, scope), 300)
    return () => clearTimeout(timer)
  }, [query, scope, open, mode, runSearch])

  // ---------- home：点击结果 → 派发事件 ----------
  const pickResult = (r: ResultItem) => {
    if (r.type === 'conversation') {
      if (r.conversationId) {
        window.dispatchEvent(
          new CustomEvent<AppOpenConversationDetail>('app:openConversation', {
            detail: { id: r.conversationId },
          }),
        )
      }
    } else if (r.cardId) {
      window.dispatchEvent(
        new CustomEvent<AppOpenCardDetail>('app:openCard', {
          detail: { cardId: r.cardId, target: r.target ?? 'reader' },
        }),
      )
    }
    onOpenChange(false)
  }

  // ---------- share：筛选 + 排序，结果回调 ----------
  React.useEffect(() => {
    if (mode !== 'share' || !open) return
    const list = shares ?? null
    const kw = query.trim().toLowerCase()
    let out = list ?? []
    if (kw) {
      out = out.filter(
        (s) => s.title.toLowerCase().includes(kw) || s.token.toLowerCase().includes(kw),
      )
    }
    const now = Date.now()
    if (status === 'valid') {
      out = out.filter((s) => !s.expiresAt || new Date(s.expiresAt).getTime() >= now)
    } else if (status === 'expired') {
      out = out.filter((s) => !!s.expiresAt && new Date(s.expiresAt).getTime() < now)
    }
    const expTs = (s: ShareSearchRow) =>
      s.expiresAt ? new Date(s.expiresAt).getTime() : Number.MAX_SAFE_INTEGER
    out = [...out].sort((a, b) =>
      sort === 'created'
        ? new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        : expTs(a) - expTs(b),
    )
    onFiltered?.(out)
  }, [mode, open, shares, query, status, sort, onFiltered])

  // =====================================================================
  // share 模式：内嵌检索条
  // =====================================================================
  if (mode === 'share') {
    if (!open) return null
    return (
      <div className="space-y-2.5">
        <div className="flex items-center gap-1.5 rounded-full border border-border bg-card pl-3 pr-1.5">
          <Search className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题 / 链接 token…"
            aria-label="搜索分享"
            className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          />
          {query && (
            <button
              type="button"
              aria-label="清空搜索词"
              onClick={() => setQuery('')}
              className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" strokeWidth={1.75} />
            </button>
          )}
          <VoiceInput size="sm" context="search" onText={(t) => setQuery(t)} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              { key: 'all', label: '全部' },
              { key: 'valid', label: '有效' },
              { key: 'expired', label: '已过期' },
            ] as const
          ).map((s) => (
            <Chip
              key={s.key}
              active={status === s.key}
              onClick={() => setStatus(s.key)}
              ariaLabel={`筛选：${s.label}`}
            >
              {s.label}
            </Chip>
          ))}
          <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
          <span className="text-xs text-muted-foreground">排序</span>
          {(
            [
              { key: 'created', label: '创建时间' },
              { key: 'expires', label: '过期时间' },
            ] as const
          ).map((s) => (
            <Chip
              key={s.key}
              active={sort === s.key}
              onClick={() => setSort(s.key)}
              ariaLabel={`按${s.label}排序`}
            >
              {s.label}
            </Chip>
          ))}
        </div>
      </div>
    )
  }

  // =====================================================================
  // home 模式：底部大浮层
  // =====================================================================
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        aria-describedby={undefined}
        className="flex h-[92dvh] flex-col gap-0 rounded-t-3xl p-0"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>全局搜索</SheetTitle>
        </SheetHeader>

        {/* 搜索框 + 语音 + 关闭（内置 X） */}
        <div className="px-4 pt-3">
          <div className="flex items-center gap-1 rounded-full border border-border bg-card pl-3.5 pr-12">
            <Search className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索书本、文章、对话…"
              aria-label="全局搜索"
              className="h-11 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground/60"
            />
            {query && (
              <button
                type="button"
                aria-label="清空搜索词"
                onClick={() => setQuery('')}
                className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" strokeWidth={1.75} />
              </button>
            )}
            <VoiceInput size="sm" context="search" onText={(t) => setQuery(t)} />
          </div>
        </div>

        {/* 范围 Tab */}
        <div className="mt-3 flex gap-1.5 px-4" role="tablist" aria-label="搜索范围">
          {SCOPES.map((s) => (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={scope === s.key}
              onClick={() => setScope(s.key)}
              className={cn(
                'h-8 rounded-full px-3.5 text-sm font-medium transition-colors',
                scope === s.key
                  ? 'bg-emerald-600 text-white shadow-sm'
                  : 'text-muted-foreground hover:bg-accent',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* 结果 / 最近搜索 / 空态 */}
        <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-[max(1rem,env(safe-area-inset-bottom))] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:min-h-6 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent">
          {searching ? (
            <div className="space-y-2 px-2 pt-2">
              <Skeleton className="h-16 rounded-2xl" />
              <Skeleton className="h-16 rounded-2xl" />
              <Skeleton className="h-16 rounded-2xl" />
            </div>
          ) : results === null ? (
            query.trim() ? null : recent.length > 0 ? (
              <div className="pt-2">
                <div className="flex items-center justify-between px-2 pb-2">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                    <Clock className="size-3.5" strokeWidth={1.75} aria-hidden />
                    最近搜索
                  </p>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground/70 transition-colors hover:text-destructive"
                    onClick={() => {
                      setRecent([])
                      saveRecent([])
                    }}
                  >
                    清空
                  </button>
                </div>
                <div className="flex flex-wrap gap-2 px-2">
                  {recent.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setQuery(r)}
                      className="max-w-full truncate rounded-full border border-border bg-card px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 pt-16 text-center">
                <Search className="size-10 text-muted-foreground/25" strokeWidth={1.25} aria-hidden />
                <p className="text-sm text-muted-foreground">
                  搜索书本、文章素材与 AI 对话
                </p>
                <p className="text-xs text-muted-foreground/70">支持关键词输入与 🎤 语音搜索</p>
              </div>
            )
          ) : results.length === 0 ? (
            <div className="flex flex-col items-center gap-3 pt-16 text-center">
              <Search className="size-10 text-muted-foreground/25" strokeWidth={1.25} aria-hidden />
              <p className="text-sm text-muted-foreground">没有找到相关内容</p>
              <p className="text-xs text-muted-foreground/70">换个关键词试试，或用 🎤 语音搜索</p>
            </div>
          ) : (
            <ul className="pt-1" role="list">
              {results.map((r) => {
                const meta = TYPE_META[r.type]
                const Icon = meta.icon
                return (
                  <li key={r.key}>
                    <button
                      type="button"
                      onClick={() => pickResult(r)}
                      className="flex w-full items-start gap-3 rounded-2xl px-2.5 py-2.5 text-left transition-colors hover:bg-accent"
                    >
                      <span
                        className={cn(
                          'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl',
                          meta.box,
                        )}
                        aria-hidden
                      >
                        <Icon className="size-4.5" strokeWidth={1.75} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="min-w-0 truncate text-sm font-medium text-foreground">
                            {r.titleHit ? <HitText frag={r.titleHit} /> : r.title}
                          </span>
                          <Badge
                            variant="outline"
                            className="shrink-0 px-1.5 py-0 text-[10px] text-muted-foreground"
                          >
                            {meta.badge}
                          </Badge>
                        </span>
                        {(r.snippet || r.snippetPlain) && (
                          <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-muted-foreground">
                            {r.snippet ? <HitText frag={r.snippet} /> : r.snippetPlain}
                          </span>
                        )}
                        <span className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground/80">
                          <span className="truncate">{r.source}</span>
                          {timeAgo(r.time) && (
                            <>
                              <span aria-hidden>·</span>
                              {timeAgo(r.time)}
                            </>
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ---------- 小件 ----------

function Chip({
  active,
  onClick,
  children,
  ariaLabel,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  ariaLabel?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={ariaLabel}
      onClick={onClick}
      className={cn(
        'h-7 rounded-full border px-3 text-xs font-medium transition-colors',
        active
          ? 'border-emerald-600/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
          : 'border-border text-muted-foreground hover:bg-accent',
      )}
    >
      {children}
    </button>
  )
}

export default SearchOverlay
