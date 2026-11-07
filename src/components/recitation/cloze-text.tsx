'use client'

import * as React from 'react'

import { cn } from '@/lib/utils'
import { splitParagraphs, tokenize } from '@/lib/cloze'
import type { ClozeStyle } from '@/lib/types'

const WORD_SPLIT_RE = /([\u4e00-\u9fff\u3400-\u4dbf]+|[a-zA-Z0-9]+)/
const WORD_FULL_RE = /^([\u4e00-\u9fff\u3400-\u4dbf]+|[a-zA-Z0-9]+)$/

interface WordToken {
  text: string
  isWord: boolean // word token (toggleable) vs separator
}

// Split a segment into word tokens + separators so individual words can be
// toggled by 挖空刷 (brush) / 手动挖空 (dblclick).
function splitWords(text: string): WordToken[] {
  return text
    .split(WORD_SPLIT_RE)
    .filter((p) => p !== '' && p !== undefined)
    .map((p) => ({ text: p, isWord: WORD_FULL_RE.test(p) }))
}

interface ClozeTextProps {
  content: string
  keywords: string[]
  style: ClozeStyle
  showAnswers: boolean
  fontSize: number
  /** 挖空刷 mode: drag over words to blank them. */
  brushMode?: boolean
  /** 手动挖空 mode: double-click words to blank them. */
  manualMode?: boolean
  /** When provided (AI快速分块), render numbered chunk blocks instead of plain paragraphs. */
  chunks?: string[] | null
  /** When provided (paged mode), render horizontal snap pages. */
  pages?: string[] | null
  onPageChange?: (page: number, total: number) => void
  revealed: Set<number>
  onReveal: (idx: number) => void
  onToggleKeyword: (word: string) => void
}

export function ClozeText({
  content,
  keywords,
  style,
  showAnswers,
  fontSize,
  brushMode = false,
  manualMode = false,
  chunks = null,
  pages = null,
  onPageChange,
  revealed,
  onReveal,
  onToggleKeyword,
}: ClozeTextProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const draggingRef = React.useRef(false)
  const touchedRef = React.useRef<Set<string>>(new Set())
  const [page, setPage] = React.useState(0)

  const keywordSet = React.useMemo(() => new Set(keywords), [keywords])

  // ---- brush drag handlers (work for both mouse and touch) ----
  React.useEffect(() => {
    const end = () => {
      draggingRef.current = false
    }
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [])

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!brushMode) return
    draggingRef.current = true
    touchedRef.current.clear()
    // If the drag starts on a word, blank it immediately.
    const target = e.target as HTMLElement
    const wordEl = target.closest?.('[data-word]') as HTMLElement | null
    if (wordEl?.dataset.word) {
      const w = wordEl.dataset.word
      touchedRef.current.add(w)
      onToggleKeyword(w)
    }
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!brushMode || !draggingRef.current) return
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const wordEl = el?.closest('[data-word]') as HTMLElement | null
    if (!wordEl?.dataset.word) return
    const w = wordEl.dataset.word
    if (touchedRef.current.has(w)) return
    touchedRef.current.add(w)
    onToggleKeyword(w)
  }

  const scrollToPage = (idx: number) => {
    const el = containerRef.current
    if (!el) return
    const target = Math.max(0, Math.min(idx, (pages?.length ?? 1) - 1))
    el.scrollTo({ left: target * el.clientWidth, behavior: 'smooth' })
    setPage(target)
  }

  // Report page changes for the reader's page indicator.
  React.useEffect(() => {
    onPageChange?.(page, pages?.length ?? 1)
  }, [page, pages?.length])

  // ---- build all content JSX; the blank counter lives inside this pure
  // function so every blank gets a stable running index across paragraphs. ----
  const buildContent = (): React.ReactNode => {
    let blankIdx = -1

    const renderBlank = (text: string) => {
      blankIdx += 1
      const idx = blankIdx
      const isRevealed = revealed.has(idx)
      const visible = showAnswers || isRevealed
      const isCircle = style === 'circle'
      return (
        <span
          key={`b-${idx}`}
          role="button"
          tabIndex={0}
          aria-label={visible ? `已显示：${text}` : '点击显示答案'}
          data-word={text}
          onClick={(e) => {
            e.stopPropagation()
            if (!brushMode) onReveal(idx)
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            onToggleKeyword(text)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              if (!brushMode) onReveal(idx)
            }
          }}
          className={cn(
            'cursor-pointer select-none align-middle transition-colors',
            isCircle
              ? cn(
                  'inline-block rounded-[50%] border-2 px-2 text-center',
                  !visible && 'border-foreground/50 text-transparent',
                  visible &&
                    isRevealed &&
                    'border-emerald-500/60 bg-amber-200/70 text-foreground dark:bg-amber-500/30',
                  visible &&
                    !isRevealed &&
                    'border-emerald-500/40 bg-emerald-500/10 text-foreground/90',
                )
              : cn(
                  'border-b-2',
                  !visible && 'border-dashed border-foreground/50 text-transparent',
                  visible &&
                    isRevealed &&
                    'border-emerald-500/60 bg-amber-200/70 text-foreground dark:bg-amber-500/30',
                  visible &&
                    !isRevealed &&
                    'border-emerald-500/40 bg-emerald-500/10 text-foreground/90',
                ),
          )}
          style={{ minWidth: '1.5em' }}
        >
          {text}
        </span>
      )
    }

    const renderParagraph = (para: string, paraKey: string): React.ReactNode => {
      const tokens = brushMode || manualMode ? null : tokenize(para, keywords)

      if (tokens) {
        // Normal (non-toggle) rendering: keyword segments become blanks.
        return (
          <p key={paraKey} className="whitespace-pre-wrap">
            {tokens.map((seg, i) =>
              seg.isBlank ? (
                renderBlank(seg.text)
              ) : (
                <span key={`s-${i}`}>{seg.text}</span>
              ),
            )}
          </p>
        )
      }

      // Word-level rendering for 挖空刷 / 手动挖空.
      const words = splitWords(para)
      return (
        <p key={paraKey} className="whitespace-pre-wrap">
          {words.map((w, i) => {
            if (!w.isWord) return <span key={`w-${i}`}>{w.text}</span>
            if (keywordSet.has(w.text)) {
              return renderBlank(w.text)
            }
            return (
              <span
                key={`w-${i}`}
                data-word={w.text}
                className={cn(
                  brushMode && 'cursor-crosshair rounded-sm transition-colors hover:bg-accent/70',
                  manualMode && 'cursor-text rounded-sm transition-colors hover:bg-accent/70',
                )}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  onToggleKeyword(w.text)
                }}
              >
                {w.text}
              </span>
            )
          })}
        </p>
      )
    }

    // ---- layouts ----
    if (chunks) {
      // AI快速分块: numbered bordered blocks.
      return (
        <div className="flex flex-col gap-3">
          {chunks.map((chunk, ci) => (
            <div
              key={`chunk-${ci}`}
              className="rounded-xl border border-border bg-card p-4 shadow-sm"
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="flex size-6 items-center justify-center rounded-full bg-emerald-600 text-xs font-semibold text-white">
                  {ci + 1}
                </span>
                <span className="text-xs text-muted-foreground">
                  第 {ci + 1} 块 · {chunk.length} 字
                </span>
              </div>
              <div className="space-y-3">
                {splitParagraphs(chunk).map((p, pi) => renderParagraph(p, `c${ci}-p${pi}`))}
              </div>
            </div>
          ))}
        </div>
      )
    }

    if (pages) {
      // Paged mode: horizontal snap pages.
      return (
        <div className="relative">
          <div
            ref={containerRef}
            className="flex snap-x snap-mandatory overflow-x-auto scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            onScroll={(e) => {
              const el = e.currentTarget
              const cur = Math.round(el.scrollLeft / Math.max(1, el.clientWidth))
              if (cur !== page) setPage(cur)
            }}
          >
            {pages.map((pageText, pi) => (
              <div key={`page-${pi}`} className="w-full shrink-0 snap-center px-1">
                <div className="space-y-3">
                  {splitParagraphs(pageText).map((p, pi2) =>
                    renderParagraph(p, `pg${pi}-p${pi2}`),
                  )}
                </div>
              </div>
            ))}
          </div>
          {pages.length > 1 && (
            <>
              <button
                type="button"
                aria-label="上一页"
                disabled={page <= 0}
                onClick={() => scrollToPage(page - 1)}
                className="absolute left-0 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background/90 shadow-md transition-opacity disabled:opacity-25"
              >
                ‹
              </button>
              <button
                type="button"
                aria-label="下一页"
                disabled={page >= pages.length - 1}
                onClick={() => scrollToPage(page + 1)}
                className="absolute right-0 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background/90 shadow-md transition-opacity disabled:opacity-25"
              >
                ›
              </button>
            </>
          )}
        </div>
      )
    }

    // Scroll mode: plain paragraphs.
    return (
      <div className="space-y-3">
        {splitParagraphs(content).map((p, pi) => renderParagraph(p, `p${pi}`))}
      </div>
    )
  }

  return (
    <div
      className={cn(
        'leading-loose text-zinc-800 dark:text-zinc-200',
        brushMode && 'touch-none select-none',
      )}
      style={{ fontSize: `${fontSize}px` }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={() => {
        draggingRef.current = false
      }}
    >
      {buildContent()}
    </div>
  )
}
