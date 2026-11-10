'use client'

// 收藏题目（favorite=true 的 QuizItem）+ AI 能力：
//   • 举一反三（POST /api/chat mode:'extend'）→ Dialog 富媒体展示（RichContent）
//     +「存为试卷」（POST /api/papers，解析 ## 第N题 结构，失败兜底整段简答题）
//   • AI 解析（POST /api/chat mode:'analyze'，课文上下文来自 /api/cards 并缓存）
//   • 解析 Dialog 内选中文本 → 浮动「🔍 追问」按钮 →
//     dispatch window 'app:followup' {text, source:'favorite', cardId, cardTitle}
//     （Task 2-c 的追问弹层接管），随后关闭 Dialog。
import * as React from 'react'
import { createPortal } from 'react-dom'
import {
  BookOpen,
  ChevronLeft,
  Lightbulb,
  Loader2,
  Save,
  Search,
  Star,
} from 'lucide-react'
import { toast } from 'sonner'

import type { QuizItemData, QuizType } from '@/lib/types'
import { cn } from '@/lib/utils'
import RichContent from '@/components/recitation/rich-content'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface FavoritesViewProps {
  onBack: () => void
}

const TYPE_LABEL: Record<QuizType, string> = {
  fill: '填空',
  short: '简答',
  choice: '选择',
}

// ---------- 试卷条目（存为试卷用；兼容 QuizItem 形状 + 可选解析） ----------
interface PaperItem {
  type: 'short'
  question: string
  answer: string
  analysis?: string
}

/** 从一段 section 文本里抽取 `**题目：** …` / `**答案：** …` / `**解析：** …` 字段。 */
function extractField(body: string, label: string): string | null {
  const re = new RegExp(
    `\\*{0,2}${label}\\s*[：:]\\*{0,2}\\s*([\\s\\S]*?)(?=\\n\\s*\\*{0,2}(?:题目|答案|解析)\\s*[：:]|$)`,
  )
  const m = body.match(re)
  return m ? m[1].trim() : null
}

/**
 * 解析「举一反三」AI 文本为试卷题目：
 * 按 `## 第N题` 分节，节内抽 题目/答案/解析；
 * 完全解析不出时，把整段文本作为一道简答题存入（兜底）。
 */
function parseExtendItems(text: string): PaperItem[] {
  const normalized = (text || '').trim()
  if (!normalized) return []
  const headingRe = /^##\s*第\s*[0-9一二三四五六七八九十百]+\s*题[^\n]*$/gm
  const idxs: number[] = []
  let m: RegExpExecArray | null
  while ((m = headingRe.exec(normalized)) !== null) idxs.push(m.index)
  if (idxs.length === 0) {
    return [{ type: 'short', question: normalized.slice(0, 4000), answer: '' }]
  }
  const out: PaperItem[] = []
  for (let i = 0; i < idxs.length; i++) {
    const body = normalized.slice(idxs[i], i + 1 < idxs.length ? idxs[i + 1] : normalized.length)
    const question = extractField(body, '题目') ?? body.replace(/^##[^\n]*\n?/, '').trim()
    if (!question) continue
    out.push({
      type: 'short',
      question: question.slice(0, 500),
      answer: (extractField(body, '答案') ?? '').slice(0, 2000),
      analysis: (extractField(body, '解析') ?? '').slice(0, 2000) || undefined,
    })
  }
  if (out.length === 0) {
    return [{ type: 'short', question: normalized.slice(0, 4000), answer: '' }]
  }
  return out
}

function truncate(text: string, n: number): string {
  return text.length > n ? text.slice(0, n) + '…' : text
}

// 空状态简笔画：打开的纸箱（浅紫箱体 + 黑描边 + 白标签 + 上方放射短线）
function EmptyFavoritesIllustration() {
  return (
    <svg viewBox="0 0 140 120" className="h-28 w-32" fill="none" aria-hidden role="img">
      {/* 放射短线 */}
      <path
        d="M70 22 V10 M50 26 l-6 -9 M90 26 l6 -9 M34 38 l-10 -5 M106 38 l10 -5"
        stroke="#171717"
        strokeWidth="2"
        strokeLinecap="round"
      />
      {/* 打开的纸箱：后箱壁 */}
      <path
        d="M36 58 L70 44 L104 58 L104 92 L70 106 L36 92 Z"
        fill="#c7c9f5"
        stroke="#171717"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* 翻开的两片盖子 */}
      <path
        d="M36 58 L14 48 L46 36 L70 44 Z"
        fill="#dcdcfb"
        stroke="#171717"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M104 58 L126 48 L94 36 L70 44 Z"
        fill="#dcdcfb"
        stroke="#171717"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* 前箱壁 */}
      <path
        d="M36 58 L70 72 L104 58 L104 92 L70 106 L36 92 Z"
        fill="#c7c9f5"
        stroke="#171717"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* 白色标签 */}
      <rect x="56" y="76" width="28" height="18" rx="3" fill="#ffffff" stroke="#171717" strokeWidth="1.6" />
      <path d="M61 82 h18 M61 87 h12" stroke="#171717" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

const SCROLLBAR =
  '[scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:min-h-6 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent'

// 收藏题目：列表 + 取消收藏 + AI（举一反三 / 解析 / 选中文本追问）（全屏视图）
export function FavoritesView({ onBack }: FavoritesViewProps) {
  const [items, setItems] = React.useState<QuizItemData[]>([])
  const [loading, setLoading] = React.useState(true)
  const [removingId, setRemovingId] = React.useState<string | null>(null)

  // ---------- AI（举一反三 / 解析） ----------
  const [aiOpen, setAiOpen] = React.useState<'extend' | 'analyze' | null>(null)
  const [aiItem, setAiItem] = React.useState<QuizItemData | null>(null)
  const [aiText, setAiText] = React.useState('')
  const [aiLoading, setAiLoading] = React.useState(false)
  const [savingPaper, setSavingPaper] = React.useState(false)
  // 选中文本追问（仅解析 Dialog）
  const [selFollow, setSelFollow] = React.useState<{ text: string; x: number; y: number } | null>(
    null,
  )
  const contentRef = React.useRef<HTMLDivElement>(null)
  // 课文内容缓存（AI解析上下文）：cardId -> content（'' = 已知无课文）
  const cardContentCache = React.useRef(new Map<string, string>())

  React.useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await fetch('/api/quiz-items?favorite=1')
        if (!res.ok) throw new Error('加载收藏失败')
        const data = (await res.json()) as { items: QuizItemData[] }
        if (alive) setItems(data.items ?? [])
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '加载收藏失败')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const unfavorite = async (id: string) => {
    setRemovingId(id)
    try {
      const res = await fetch('/api/quiz-items', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, favorite: false }),
      })
      if (!res.ok) throw new Error('取消收藏失败')
      setItems((list) => list.filter((i) => i.id !== id))
      toast.success('已取消收藏')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '取消收藏失败')
    } finally {
      setRemovingId(null)
    }
  }

  // ---------- 课文上下文（缓存，一次拉全量卡） ----------
  const getCardContent = React.useCallback(async (cardId: string): Promise<string> => {
    if (!cardId) return ''
    const cache = cardContentCache.current
    const hit = cache.get(cardId)
    if (hit !== undefined) return hit
    try {
      const res = await fetch('/api/cards')
      if (res.ok) {
        const data = (await res.json()) as { cards?: { id: string; content: string }[] }
        for (const c of data.cards ?? []) cache.set(c.id, c.content)
      }
    } catch {
      /* 上下文缺省也能解析 */
    }
    if (!cache.has(cardId)) cache.set(cardId, '') // 负缓存：该书已删除/无内容
    return cache.get(cardId) ?? ''
  }, [])

  // ---------- 举一反三 ----------
  const runExtend = async (item: QuizItemData) => {
    setAiItem(item)
    setAiOpen('extend')
    setAiText('')
    setAiLoading(true)
    const tid = toast.loading('AI 正在举一反三…')
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'extend',
          items: [{ question: item.question, answer: item.answer, type: item.type }],
          count: 3,
        }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '生成失败')
      const data = (await res.json()) as { text?: string }
      if (!data.text) throw new Error('AI 未返回内容')
      setAiText(data.text)
      toast.success('已生成变式题', { id: tid })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '举一反三失败', { id: tid })
      setAiOpen(null)
    } finally {
      setAiLoading(false)
    }
  }

  // ---------- AI 解析 ----------
  const runAnalyze = async (item: QuizItemData) => {
    setAiItem(item)
    setAiOpen('analyze')
    setAiText('')
    setAiLoading(true)
    const tid = toast.loading('正在获取课文上下文…')
    try {
      const context = await getCardContent(item.cardId)
      toast.loading('AI 正在解析…', { id: tid })
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'analyze',
          question: item.question,
          answer: item.answer || undefined,
          context,
        }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '解析失败')
      const data = (await res.json()) as { text?: string }
      if (!data.text) throw new Error('AI 未返回内容')
      setAiText(data.text)
      toast.success('解析已生成', { id: tid })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'AI 解析失败', { id: tid })
      setAiOpen(null)
    } finally {
      setAiLoading(false)
    }
  }

  // ---------- 存为试卷 ----------
  const saveAsPaper = async () => {
    if (!aiItem || !aiText) return
    if (!aiItem.cardId) {
      toast.error('该题没有关联书本，无法存为试卷')
      return
    }
    setSavingPaper(true)
    try {
      const paperItems = parseExtendItems(aiText)
      const res = await fetch('/api/papers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardId: aiItem.cardId,
          title: `举一反三 ${aiItem.question.slice(0, 10)}`,
          items: paperItems,
          source: 'manual',
        }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '保存失败')
      toast.success(`已存为试卷（${paperItems.length} 题）`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '存为试卷失败')
    } finally {
      setSavingPaper(false)
    }
  }

  // ---------- 解析 Dialog：选中文本 → 浮动追问按钮 ----------
  const checkSelection = React.useCallback(() => {
    const container = contentRef.current
    if (!container) {
      setSelFollow(null)
      return
    }
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setSelFollow(null)
      return
    }
    const raw = sel.toString().trim().replace(/\s+/g, ' ')
    if (!raw) {
      setSelFollow(null)
      return
    }
    const node = sel.anchorNode
    if (!node) {
      setSelFollow(null)
      return
    }
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
    if (!el || !container.contains(el)) {
      setSelFollow(null)
      return
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    const vw = window.innerWidth || 375
    const vh = window.innerHeight || 667
    setSelFollow({
      text: raw.slice(0, 500),
      x: Math.min(Math.max(rect.left + rect.width / 2, 96), vw - 96),
      y: Math.min(rect.bottom + 10, vh - 64),
    })
  }, [])

  React.useEffect(() => {
    if (aiOpen !== 'analyze' || !aiText) return
    document.addEventListener('selectionchange', checkSelection)
    document.addEventListener('mouseup', checkSelection)
    document.addEventListener('touchend', checkSelection)
    return () => {
      document.removeEventListener('selectionchange', checkSelection)
      document.removeEventListener('mouseup', checkSelection)
      document.removeEventListener('touchend', checkSelection)
      setSelFollow(null)
    }
  }, [aiOpen, aiText, checkSelection])

  const sendFollowup = () => {
    if (!selFollow) return
    window.dispatchEvent(
      new CustomEvent('app:followup', {
        detail: {
          text: selFollow.text,
          source: 'favorite',
          cardId: aiItem?.cardId ?? '',
          cardTitle: aiItem?.cardTitle ?? '',
        },
      }),
    )
    try {
      window.getSelection()?.removeAllRanges()
    } catch {
      /* ignore */
    }
    setSelFollow(null)
    setAiOpen(null)
    toast.success('已发送追问')
  }

  return (
    <div className="min-h-dvh bg-muted/40">
      {/* 顶栏 */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="relative mx-auto flex h-14 max-w-2xl items-center px-4">
          <button
            type="button"
            aria-label="返回"
            onClick={onBack}
            className="shrink-0 rounded-full p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="size-6 text-foreground" strokeWidth={2} />
          </button>
          <h1 className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-lg font-bold">
            收藏题目
          </h1>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 pb-16 pt-4">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-24 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            <span className="text-sm">加载中…</span>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-4 pt-16 text-center">
            <EmptyFavoritesIllustration />
            <p className="text-sm text-muted-foreground">暂无收藏题目，快去添加吧</p>
          </div>
        ) : (
          <div className={cn('flex max-h-[72vh] flex-col gap-3 overflow-y-auto', SCROLLBAR)}>
            {items.map((item) => (
              <div key={item.id} className="rounded-2xl bg-card p-4">
                <div className="flex items-start gap-2">
                  <span className="shrink-0 rounded-lg bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {TYPE_LABEL[item.type] ?? '题目'}
                  </span>
                  <p className="text-[15px] font-medium leading-relaxed">{item.question}</p>
                </div>
                <div className="mt-3 rounded-lg bg-muted px-3 py-2">
                  <p className="text-xs text-muted-foreground">
                    答案{item.cardTitle ? ` · ${item.cardTitle}` : ''}
                  </p>
                  <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed">
                    {item.answer || '（无标准答案）'}
                  </p>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    disabled={aiLoading}
                    onClick={() => void runExtend(item)}
                    className="flex h-9 items-center gap-1.5 rounded-full border border-border px-4 text-sm text-muted-foreground transition-colors hover:border-emerald-500/40 hover:text-emerald-600 disabled:opacity-50"
                  >
                    <Lightbulb className="size-3.5" strokeWidth={2} />
                    举一反三
                  </button>
                  <button
                    type="button"
                    disabled={aiLoading}
                    onClick={() => void runAnalyze(item)}
                    className="flex h-9 items-center gap-1.5 rounded-full border border-border px-4 text-sm text-muted-foreground transition-colors hover:border-emerald-500/40 hover:text-emerald-600 disabled:opacity-50"
                  >
                    <BookOpen className="size-3.5" strokeWidth={2} />
                    AI解析
                  </button>
                  <button
                    type="button"
                    disabled={removingId === item.id || aiLoading}
                    onClick={() => unfavorite(item.id)}
                    className="flex h-9 items-center gap-1.5 rounded-full border border-border px-4 text-sm text-muted-foreground transition-colors hover:border-red-500/40 hover:text-red-500 disabled:opacity-50"
                  >
                    {removingId === item.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Star className="size-3.5" strokeWidth={2} />
                    )}
                    取消收藏
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* AI（举一反三 / 解析）结果 Dialog */}
      <Dialog
        open={aiOpen !== null}
        onOpenChange={(o) => {
          if (!o) {
            setAiOpen(null)
            setSelFollow(null)
          }
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          className="flex max-h-[88dvh] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-lg"
        >
          <DialogHeader className="border-b border-border px-4 py-3 pr-12">
            <DialogTitle className="text-base">
              {aiOpen === 'extend' ? '举一反三' : 'AI 解析'}
              {aiItem && (
                <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                  · {truncate(aiItem.question, 16)}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          <div
            ref={contentRef}
            className={cn('relative min-h-0 flex-1 overflow-y-auto px-4 py-3', SCROLLBAR)}
          >
            {aiLoading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
                <span className="text-sm">
                  {aiOpen === 'extend' ? 'AI 正在举一反三…' : 'AI 正在解析…'}
                </span>
              </div>
            ) : aiText ? (
              <RichContent content={aiText} />
            ) : null}
          </div>
          {aiOpen === 'analyze' && !aiLoading && aiText && (
            <p className="border-t border-border px-4 py-2 text-center text-[11px] text-muted-foreground/80">
              选中解析内容中的文字，可继续「追问」
            </p>
          )}
          {aiOpen === 'extend' && !aiLoading && aiText && (
            <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
              <p className="text-xs text-muted-foreground">AI 文本将解析为题目；解析不出则整段存为简答题</p>
              <Button
                size="sm"
                className="h-9 shrink-0 rounded-full"
                disabled={savingPaper}
                onClick={() => void saveAsPaper()}
              >
                {savingPaper ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Save className="size-3.5" strokeWidth={2} />
                )}
                存为试卷
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 解析 Dialog：选中文本 → 浮动「🔍 追问」按钮（portal 到 body，
          避开 Dialog transform 对 fixed 定位的影响；Task 2-c 弹层接管） */}
      {selFollow &&
        aiOpen === 'analyze' &&
        createPortal(
          <button
            type="button"
            onClick={sendFollowup}
            style={{ left: selFollow.x, top: selFollow.y }}
            className="fixed z-[70] -translate-x-1/2 rounded-full border border-emerald-600/40 bg-background px-3.5 py-2 text-xs font-medium text-emerald-700 shadow-lg transition-transform active:scale-95 dark:text-emerald-300"
          >
            <span className="flex items-center gap-1.5">
              <Search className="size-3.5" strokeWidth={2} aria-hidden />
              追问
              <span className="max-w-[140px] truncate text-muted-foreground">
                {truncate(selFollow.text, 14)}
              </span>
            </span>
          </button>,
          document.body,
        )}
    </div>
  )
}
