'use client'

// 目录 / 搜本书 — document outline + in-book search panel (1:1 reference):
//   • Tabs centered at top: 目录 | 搜本书, active tab = blue text + blue
//     underline, gray X close button on the right.
//   • Outline: document title + "N/N 页" header row, then numbered entries
//     (blue when hovered/active) with a ⋯ button on the right; tap → jump.
//   • 搜本书: search input + matched lines with the keyword highlighted;
//     tap a result → jump to that paragraph.

import * as React from 'react'
import { MoreHorizontal, Search, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { CardData } from '@/lib/types'
import { splitParagraphs } from '@/lib/cloze'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'

export interface TocEntry {
  label: string // display text, e.g. 第1段的开头…
  index: number // chunk/paragraph index to jump to
}

interface TocSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  card: CardData
  /** Active outline source: AI 分块 chunks when present, else paragraphs. */
  chunks: string[] | null
  /** Jump handler: receives the outline index (chunk or paragraph). */
  onJump: (index: number) => void
}

type Tab = 'toc' | 'search'

const TAB_ACTIVE =
  'text-[#4f5cd1] after:absolute after:inset-x-0 after:-bottom-2 after:h-0.5 after:rounded-full after:bg-[#4f5cd1]'

export function TocSheet({ open, onOpenChange, card, chunks, onJump }: TocSheetProps) {
  const [tab, setTab] = React.useState<Tab>('toc')
  const [query, setQuery] = React.useState('')
  const [lastQuery, setLastQuery] = React.useState('')

  React.useEffect(() => {
    if (open) {
      setTab('toc')
      setQuery('')
      setLastQuery('')
    }
  }, [open])

  const outline: string[] = React.useMemo(() => {
    if (chunks && chunks.length > 0) return chunks
    return splitParagraphs(card.content)
  }, [chunks, card.content])

  const isChunks = !!(chunks && chunks.length > 0)

  const handleJump = (index: number) => {
    onJump(index)
    onOpenChange(false)
  }

  // ---------- search ----------
  const results = React.useMemo(() => {
    const q = lastQuery.trim()
    if (!q) return []
    const paragraphs = splitParagraphs(card.content)
    const out: { paraIndex: number; line: string }[] = []
    paragraphs.forEach((p, pi) => {
      const lower = p.toLowerCase()
      let pos = lower.indexOf(q.toLowerCase())
      let guard = 0
      while (pos >= 0 && guard < 3) {
        guard++
        const start = Math.max(0, pos - 12)
        const end = Math.min(p.length, pos + q.length + 24)
        out.push({
          paraIndex: pi,
          line:
            (start > 0 ? '…' : '') +
            p.slice(start, end) +
            (end < p.length ? '…' : ''),
        })
        pos = lower.indexOf(q.toLowerCase(), pos + Math.max(1, q.length))
        if (out.length >= 50) break
      }
    })
    return out
  }, [lastQuery, card.content])

  const submitSearch = () => {
    setLastQuery(query)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto h-[80vh] max-w-2xl rounded-t-3xl border-border bg-[#f4f4f6] px-0 pb-6 [&>button]:hidden sm:rounded-t-3xl"
      >
        {/* header: centered tabs + close */}
        <div className="relative px-4 pt-2">
          <div
            aria-hidden
            className="mx-auto h-1.5 w-10 rounded-full bg-muted-foreground/20"
          />
          <div className="mt-4 flex items-center justify-center gap-10">
            {(
              [
                { key: 'toc' as Tab, label: '目录' },
                { key: 'search' as Tab, label: '搜本书' },
              ]
            ).map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                aria-selected={tab === t.key}
                role="tab"
                className={cn(
                  'relative pb-2 text-xl font-bold transition-colors',
                  tab === t.key
                    ? TAB_ACTIVE
                    : 'text-zinc-800 hover:text-zinc-600 dark:text-zinc-200',
                )}
              >
                {t.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="关闭"
              className="absolute right-4 top-0 flex size-9 items-center justify-center rounded-full bg-zinc-200 text-zinc-500 transition-colors hover:text-zinc-800 dark:bg-zinc-800 dark:text-zinc-400"
            >
              <X className="size-5" strokeWidth={1.75} />
            </button>
          </div>
          <SheetTitle className="sr-only">目录与搜索</SheetTitle>
        </div>

        {/* ---------- 目录 tab ---------- */}
        {tab === 'toc' && (
          <div className="mt-4 flex h-[calc(100%-4.5rem)] flex-col overflow-hidden">
            <div className="px-5">
              <h3 className="text-2xl font-bold leading-snug">{card.title}</h3>
              <p className="mt-1.5 text-sm text-zinc-400">
                {isChunks ? `${outline.length}/${outline.length} 块` : '1/1 页'}
              </p>
            </div>
            <div className="mt-4 flex-1 overflow-y-auto px-5 pb-4">
              {outline.length === 0 ? (
                <p className="mt-16 text-center text-sm text-zinc-400">
                  暂无内容，先导入课文吧
                </p>
              ) : (
                <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {outline.map((chunk, i) => (
                    <div key={`toc-${i}`} className="group flex items-center gap-2 py-3.5">
                      <button
                        type="button"
                        onClick={() => handleJump(i)}
                        className="flex-1 text-left text-base font-semibold text-[#4f5cd1] transition-colors hover:opacity-80"
                      >
                        <span className="mr-1">{i + 1}.</span>
                        {chunk.trim().slice(0, 24) || '（空）'}
                        {chunk.trim().length > 24 ? '…' : ''}
                      </button>
                      <button
                        type="button"
                        aria-label={`第 ${i + 1} 块选项`}
                        onClick={() => handleJump(i)}
                        className="shrink-0 text-zinc-400 transition-colors hover:text-zinc-600"
                      >
                        <MoreHorizontal className="size-4.5" strokeWidth={1.75} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ---------- 搜本书 tab ---------- */}
        {tab === 'search' && (
          <div className="mt-4 flex h-[calc(100%-4.5rem)] flex-col overflow-hidden px-5">
            <div className="flex items-center gap-2">
              <div className="flex h-11 flex-1 items-center gap-2 rounded-full bg-white px-4 shadow-sm dark:bg-zinc-900">
                <Search className="size-4 shrink-0 text-zinc-400" strokeWidth={1.75} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitSearch()
                  }}
                  placeholder="搜索本书内容"
                  aria-label="搜索本书内容"
                  className="h-full flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400"
                />
                {query && (
                  <button
                    type="button"
                    aria-label="清空搜索"
                    onClick={() => setQuery('')}
                    className="text-zinc-400 hover:text-zinc-600"
                  >
                    <X className="size-3.5" strokeWidth={1.75} />
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={submitSearch}
                className="h-11 shrink-0 rounded-full bg-[#4f5cd1] px-5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
              >
                搜索
              </button>
            </div>

            <div className="mt-4 flex-1 overflow-y-auto pb-4">
              {!lastQuery.trim() ? (
                <p className="mt-16 text-center text-sm text-zinc-400">
                  输入关键字，搜索这本书的内容
                </p>
              ) : results.length === 0 ? (
                <p className="mt-16 text-center text-sm text-zinc-400">
                  未找到「{lastQuery}」相关内容
                </p>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-zinc-400">共 {results.length} 条结果</p>
                  {results.map((r, i) => (
                    <button
                      key={`res-${i}`}
                      type="button"
                      onClick={() => handleJump(r.paraIndex)}
                      className="block w-full rounded-xl bg-white px-4 py-3 text-left text-sm leading-relaxed shadow-sm transition-colors hover:bg-accent dark:bg-zinc-900"
                    >
                      <Highlight text={r.line} query={lastQuery.trim()} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

// Highlight every occurrence of `query` inside `text`.
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const lower = text.toLowerCase()
  const ql = query.toLowerCase()
  const parts: React.ReactNode[] = []
  let cursor = 0
  let pos = lower.indexOf(ql)
  let k = 0
  while (pos >= 0 && k < 10) {
    k++
    if (pos > cursor) parts.push(text.slice(cursor, pos))
    parts.push(
      <mark
        key={`hl-${k}`}
        className="rounded-sm bg-[#4f5cd1]/15 px-0.5 font-semibold text-[#4f5cd1]"
      >
        {text.slice(pos, pos + query.length)}
      </mark>,
    )
    cursor = pos + query.length
    pos = lower.indexOf(ql, cursor)
  }
  parts.push(text.slice(cursor))
  return <>{parts}</>
}
