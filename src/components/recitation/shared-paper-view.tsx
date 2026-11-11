'use client'

// 访客端「共享试卷」页 —— 渲染 /api/share/:token 返回的试卷分享（kind='paper'）。
//   • 自检测分流：响应含 paper 字段 → 试卷视图；否则（卡片/对话分享链接误入
//     /s/<token>）委托 SharedConversationView 渲染 —— 与 /share/[token] 页面的
//     「组件内自检测 + 委托」模式一致（SharedConversationView 再委托卡片视图）。
//   • 每题渲染：题号 / 题型徽标 / 题干（RichContent 富文本富媒体）/ 选项 /
//     答案 / 解析；支持整体隐藏答案（自测 / 打印无答案卷）。
//   • 移动优先 + A4 打印友好（@media print：隐藏工具条、题目不跨页断裂）。
//   • embedded：分享管理内嵌预览（Dialog 中使用，隐藏页头/页脚/打印）。
import * as React from 'react'
import { AlertCircle, ArrowLeft, Eye, EyeOff, FileText, Printer } from 'lucide-react'

import { cn } from '@/lib/utils'
import RichContent from '@/components/recitation/rich-content'
import { SharedConversationView } from '@/components/recitation/shared-conversation-view'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

/** 试卷中的单道题（与 /api/papers 的 PaperItem 结构一致，公开端原样返回） */
interface SharedPaperItem {
  type: string
  question: string
  answer: string
  options?: string[]
  explanation?: string
}

/** GET /api/share/:token 的试卷载荷（kind='paper'） */
interface SharedPaper {
  title: string
  cardTitle: string
  count: number
  items: SharedPaperItem[]
  createdAt: string
}

const TYPE_LABEL: Record<string, string> = {
  fill: '填空',
  short: '简答',
  choice: '单选',
  multi: '多选',
  judge: '判断',
}

/** 宽松归一化公开端返回的题目数组（脏数据兜底为空题干，绝不抛错） */
function normItems(raw: unknown[]): SharedPaperItem[] {
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((it) => ({
      type: typeof it.type === 'string' ? it.type : '',
      question: typeof it.question === 'string' ? it.question : '',
      answer: typeof it.answer === 'string' ? it.answer : '',
      options: Array.isArray(it.options)
        ? it.options.map((o) => (typeof o === 'string' ? o : String(o ?? '')))
        : undefined,
      explanation: typeof it.explanation === 'string' ? it.explanation : '',
    }))
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN', { hour12: false })
}

function getExpiryBadge(expiresAt: string | null): { label: string; className: string } {
  const ok =
    'border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400'
  if (!expiresAt) return { label: '永久有效', className: ok }
  const d = new Date(expiresAt)
  if (Number.isNaN(d.getTime())) return { label: '永久有效', className: ok }
  return { label: `有效期至 ${d.toLocaleDateString('zh-CN')}`, className: ok }
}

/** 打印样式：A4 页边距 + 工具条隐藏 + 题目卡片不跨页断裂 */
const PRINT_STYLES = `@media print {
  @page { size: A4; margin: 14mm 13mm; }
  html, body { background: #ffffff !important; }
  .spp-no-print { display: none !important; }
  .spp-q { break-inside: avoid; page-break-inside: avoid; }
  .spp-main { max-width: none !important; padding: 0 !important; }
}`

export interface SharedPaperViewProps {
  token: string
  /** 全屏形态的返回回调；内嵌预览（embedded）可不传。 */
  onExit?: () => void
  /** 内嵌预览（分享管理 Dialog）：隐藏页头/页脚/打印按钮。 */
  embedded?: boolean
}

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'paper'; paper: SharedPaper; expiresAt: string | null }
  | { status: 'other' }

export function SharedPaperView({ token, onExit, embedded = false }: SharedPaperViewProps) {
  const [state, setState] = React.useState<ViewState>({ status: 'loading' })
  const [showAnswers, setShowAnswers] = React.useState(true)

  React.useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    fetch(`/api/share/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          paper?: {
            title?: unknown
            cardTitle?: unknown
            count?: unknown
            items?: unknown
            createdAt?: unknown
          }
          share?: { expiresAt?: unknown } | null
          error?: string
        }
        if (!res.ok) throw new Error(data.error || '分享链接不存在或已失效')
        if (data.paper && typeof data.paper === 'object') {
          return {
            paper: {
              title: typeof data.paper.title === 'string' ? data.paper.title : '',
              cardTitle: typeof data.paper.cardTitle === 'string' ? data.paper.cardTitle : '',
              count: typeof data.paper.count === 'number' ? data.paper.count : 0,
              items: normItems(Array.isArray(data.paper.items) ? data.paper.items : []),
              createdAt: typeof data.paper.createdAt === 'string' ? data.paper.createdAt : '',
            } satisfies SharedPaper,
            expiresAt:
              data.share && typeof data.share.expiresAt === 'string'
                ? data.share.expiresAt
                : null,
          } as const
        }
        return 'other' as const
      })
      .then((data) => {
        if (!alive) return
        if (data === 'other') setState({ status: 'other' })
        else setState({ status: 'paper', paper: data.paper, expiresAt: data.expiresAt })
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

  // ---------- 非试卷分享（卡片/对话）→ 委托 SharedConversationView 自检测渲染 ----------
  if (state.status === 'other') {
    return <SharedConversationView token={token} onExit={onExit ?? (() => {})} embedded={embedded} />
  }

  // ---------- 加载 / 错误 ----------
  if (state.status === 'loading') {
    return (
      <div
        className={cn(
          'flex w-full flex-col',
          embedded ? 'min-h-64 gap-3 p-2' : 'mx-auto w-full max-w-2xl flex-1 gap-4 px-4 py-8',
        )}
      >
        <Skeleton className={cn(embedded ? 'h-6' : 'h-8')} />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-24 w-full rounded-2xl" />
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-3xl border border-dashed border-border px-6 py-16 text-center">
        <AlertCircle className="size-12 text-destructive/60" strokeWidth={1.25} />
        <div>
          <p className="text-base font-medium">{state.message}</p>
          <p className="mt-1 text-sm text-muted-foreground/70">
            分享已过期或已被取消，请联系分享者重新获取链接
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

  // ---------- 试卷分享 ----------
  const { paper } = state
  const badge = getExpiryBadge(state.expiresAt)
  const items = paper.items

  return (
    <div className={cn('flex min-h-full w-full flex-1 flex-col bg-background text-foreground')}>
      {/* 打印样式（A4 + 隐藏工具条 + 题目不跨页） */}
      <style>{PRINT_STYLES}</style>

      {/* ---------- header（内嵌预览隐藏） ---------- */}
      {!embedded && (
        <header className="spp-no-print sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
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
            <h1 className="truncate text-base font-bold">共享试卷</h1>
            <span
              className={cn(
                'ml-auto inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-[11px] font-medium',
                badge.className,
              )}
            >
              {badge.label}
            </span>
          </div>
        </header>
      )}

      {/* ---------- body ---------- */}
      <main className="spp-main mx-auto w-full max-w-2xl flex-1 px-4 pb-16 pt-6">
        <h2 className="text-2xl font-bold leading-snug tracking-tight">
          {paper.title || '未命名试卷'}
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>共 {paper.count || items.length} 题</span>
          {paper.cardTitle && (
            <>
              <span aria-hidden>·</span>
              <span className="max-w-48 truncate">《{paper.cardTitle}》</span>
            </>
          )}
          {paper.createdAt && (
            <>
              <span aria-hidden>·</span>
              <span>创建于 {formatDateTime(paper.createdAt)}</span>
            </>
          )}
        </div>

        {/* 工具条：显示/隐藏答案 + 打印（内嵌预览隐藏） */}
        {!embedded && (
          <div className="spp-no-print mt-5 flex w-fit gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-9 rounded-full px-4"
              onClick={() => setShowAnswers((v) => !v)}
            >
              {showAnswers ? (
                <EyeOff className="size-4" strokeWidth={1.75} />
              ) : (
                <Eye className="size-4" strokeWidth={1.75} />
              )}
              {showAnswers ? '隐藏答案' : '显示答案'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 rounded-full px-4"
              onClick={() => window.print()}
            >
              <Printer className="size-4" strokeWidth={1.75} />
              打印 / 存为 PDF
            </Button>
          </div>
        )}

        {/* 题目列表 */}
        <div className={cn('space-y-3', !embedded && 'mt-6')}>
          {items.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">这份试卷没有题目</p>
          ) : (
            items.map((it, i) => (
              <section
                key={i}
                className="spp-q rounded-2xl border border-border bg-card px-4 py-3.5"
              >
                <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="text-xs font-semibold text-muted-foreground">第 {i + 1} 题</span>
                  <Badge variant="secondary" className="px-1.5 text-[10px]">
                    {TYPE_LABEL[it.type] ?? it.type ?? '题目'}
                  </Badge>
                </div>
                {/* 题干：富媒体防护容器（break-words + max-w 封顶，绝不撑破题框） */}
                <div className="min-w-0 max-w-full overflow-hidden break-words">
                  <RichContent content={it.question ?? ''} />
                </div>
                {Array.isArray(it.options) && it.options.length > 0 && (
                  <div className="mt-2 space-y-1 text-sm">
                    {it.options.map((o, j) => (
                      <p key={j} className="min-w-0 break-words text-muted-foreground">
                        {String.fromCharCode(65 + j)}. {o}
                      </p>
                    ))}
                  </div>
                )}
                {showAnswers && (it.answer ?? '').trim() && (
                  <div className="mt-2.5 min-w-0 max-w-full overflow-hidden break-words rounded-xl bg-emerald-500/5 px-3 py-2">
                    <p className="mb-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                      答案
                    </p>
                    <RichContent content={it.answer} className="text-sm leading-relaxed" />
                  </div>
                )}
                {showAnswers && (it.explanation ?? '').trim() && (
                  <div className="mt-2 min-w-0 max-w-full overflow-hidden break-words rounded-xl bg-muted/50 px-3 py-2">
                    <p className="mb-1 text-xs font-semibold text-muted-foreground">解析</p>
                    <RichContent
                      content={it.explanation ?? ''}
                      className="text-sm leading-relaxed text-foreground/80"
                    />
                  </div>
                )}
              </section>
            ))
          )}
        </div>
      </main>

      {/* ---------- footer（内嵌预览隐藏） ---------- */}
      {!embedded && (
        <footer className="spp-no-print mt-auto border-t bg-background">
          <div className="mx-auto flex max-w-2xl items-center justify-center gap-1.5 px-4 py-3 text-[11px] text-muted-foreground">
            <FileText className="size-3.5 text-emerald-600" strokeWidth={1.75} />
            来自背书吧的分享
          </div>
        </footer>
      )}
    </div>
  )
}

export default SharedPaperView
