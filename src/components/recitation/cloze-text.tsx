'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'
import { Copy, Eraser, Eye, Flag, Volume2 } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { splitParagraphs, tokenize } from '@/lib/cloze'
import type { ClozeStyle } from '@/lib/types'
import { LongPressMenu, type MenuAction } from '@/components/recitation/long-press-menu'

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
  /** 挖空编辑模式: watch text selection → 挖空选中 floating button; tapping a
   * blank removes it instead of revealing the answer. */
  selectionMode?: boolean
  /** Called with the trimmed selected text when 挖空选中 is tapped. */
  onSelectCloze?: (text: string) => void
  /** Full override of the per-blank long-press menu actions. */
  menuActions?: MenuAction[]
  /** 取消挖空 — only adds the menu action when provided. */
  onRemoveKeyword?: (word: string) => void
  /** 标记难点 — only adds the menu action when provided. */
  onMarkHard?: (word: string) => void
  /** Fallback for custom keys when menuActions is overridden. */
  onMenuAction?: (key: string, word: string, idx: number) => void
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
  selectionMode = false,
  onSelectCloze,
  menuActions,
  onRemoveKeyword,
  onMarkHard,
  onMenuAction,
}: ClozeTextProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const draggingRef = React.useRef(false)
  const touchedRef = React.useRef<Set<string>>(new Set())
  const [page, setPage] = React.useState(0)
  // 查看答案 (per-blank menu): single blanks revealed for 2s, independent of
  // the global showAnswers toggle.
  const [tempRevealed, setTempRevealed] = React.useState<Set<number>>(new Set())
  const tempTimersRef = React.useRef<Map<number, number>>(new Map())

  React.useEffect(() => {
    const timers = tempTimersRef.current
    return () => {
      timers.forEach((t) => window.clearTimeout(t))
      timers.clear()
    }
  }, [])

  const tempReveal = (idx: number) => {
    setTempRevealed((prev) => {
      const n = new Set(prev)
      n.add(idx)
      return n
    })
    const prevTimer = tempTimersRef.current.get(idx)
    if (prevTimer) window.clearTimeout(prevTimer)
    const t = window.setTimeout(() => {
      tempTimersRef.current.delete(idx)
      setTempRevealed((prev) => {
        const n = new Set(prev)
        n.delete(idx)
        return n
      })
    }, 2000)
    tempTimersRef.current.set(idx, t)
  }

  // 朗读该词 — browser speechSynthesis only, no server call.
  const speakWord = (word: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      toast.error('当前浏览器不支持朗读')
      return
    }
    try {
      window.speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(word)
      u.lang = 'zh-CN'
      u.rate = 0.9
      window.speechSynthesis.speak(u)
    } catch {
      toast.error('朗读失败，请重试')
    }
  }

  // 复制词语
  const copyWord = (word: string) => {
    navigator.clipboard
      ?.writeText(word)
      .then(() => toast.success(`已复制「${word}」`))
      .catch(() => toast.error('复制失败，请重试'))
  }

  const handleBlankMenuAction = (key: string, word: string, idx: number) => {
    switch (key) {
      case 'reveal':
        tempReveal(idx)
        break
      case 'speak':
        speakWord(word)
        break
      case 'copy':
        copyWord(word)
        break
      case 'remove':
        if (onRemoveKeyword) {
          onRemoveKeyword(word)
          toast.success(`已取消挖空「${word}」`)
        }
        break
      case 'mark':
        if (onMarkHard) {
          onMarkHard(word)
          toast.success(`已标记难点「${word}」`)
        }
        break
      default:
        onMenuAction?.(key, word, idx)
    }
  }

  // ---- 挖空编辑模式 (selectionMode): watch text selection inside the root
  // element and surface a floating 挖空选中 pill near the selection. ----
  const [selAction, setSelAction] = React.useState<{
    x: number
    y: number
    above: boolean
    text: string
  } | null>(null)
  const selBtnRef = React.useRef<HTMLButtonElement>(null)
  const selDebounceRef = React.useRef<number | null>(null)
  const [selMounted, setSelMounted] = React.useState(false)
  React.useEffect(() => setSelMounted(true), [])

  const evaluateSelection = React.useCallback(() => {
    if (!selectionMode) {
      setSelAction(null)
      return
    }
    const sel = document.getSelection()
    const text = (sel?.toString() ?? '').trim()
    const container = rootRef.current
    if (
      !sel ||
      sel.isCollapsed ||
      sel.rangeCount === 0 ||
      text.length < 1 ||
      text.length > 50 ||
      !container ||
      !sel.anchorNode ||
      !sel.focusNode ||
      !container.contains(sel.anchorNode) ||
      !container.contains(sel.focusNode)
    ) {
      setSelAction(null)
      return
    }
    let rect: DOMRect | null = null
    try {
      rect = sel.getRangeAt(0).getBoundingClientRect()
    } catch {
      rect = null
    }
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      setSelAction(null)
      return
    }
    const above = rect.top > 64
    const x = Math.min(Math.max(rect.left + rect.width / 2, 80), window.innerWidth - 80)
    const y = above ? rect.top - 10 : rect.bottom + 10
    setSelAction({ x, y, above, text })
  }, [selectionMode])

  const handleSelectionTouchEnd = React.useCallback(() => {
    // The selection may still settle after touchend; the debounced
    // selectionchange listener below corrects any drift.
    window.setTimeout(evaluateSelection, 0)
  }, [evaluateSelection])

  const handleSelectCloze = () => {
    if (!selAction) return
    const text = selAction.text
    setSelAction(null)
    document.getSelection()?.removeAllRanges()
    onSelectCloze?.(text)
  }

  React.useEffect(() => {
    if (!selectionMode) {
      setSelAction(null)
      return
    }
    const onSelectionChange = () => {
      if (selDebounceRef.current !== null) window.clearTimeout(selDebounceRef.current)
      selDebounceRef.current = window.setTimeout(() => {
        selDebounceRef.current = null
        evaluateSelection()
      }, 250)
    }
    const onDocPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (target && selBtnRef.current?.contains(target)) return
      setSelAction(null)
    }
    const hide = () => setSelAction(null)
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('pointerdown', onDocPointerDown)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('pointerdown', onDocPointerDown)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
      if (selDebounceRef.current !== null) window.clearTimeout(selDebounceRef.current)
      selDebounceRef.current = null
    }
  }, [selectionMode, evaluateSelection])

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
      const tempOn = tempRevealed.has(idx)
      const visible = showAnswers || isRevealed || tempOn
      const effRevealed = isRevealed || tempOn

      // Shared answer-state tints: amber once this blank's answer is shown as
      // revealed, emerald when answers are globally on but not peeked here.
      const revealedCls = 'bg-amber-200/70 text-foreground dark:bg-amber-500/30'
      const peekedCls = 'bg-emerald-500/10 text-foreground/90'

      let styleCls = ''
      let inner: React.ReactNode = text
      switch (style) {
        case 'circle':
          styleCls = cn(
            'inline-block rounded-[50%] border-2 px-2 text-center',
            !visible && 'border-foreground/50 text-transparent',
            visible && effRevealed && cn('border-emerald-500/60', revealedCls),
            visible && !effRevealed && cn('border-emerald-500/40', peekedCls),
          )
          break
        case 'underline':
          styleCls = cn(
            'border-b-2',
            !visible && 'border-dashed border-foreground/50 text-transparent',
            visible && effRevealed && cn('border-emerald-500/60', revealedCls),
            visible && !effRevealed && cn('border-emerald-500/40', peekedCls),
          )
          break
        case 'blur':
          // Text stays in place but blurred; the blur lifts (with a filter
          // transition) when the answer shows.
          styleCls = cn(
            'rounded-sm',
            !visible && 'opacity-80',
            visible && effRevealed && revealedCls,
            visible && !effRevealed && peekedCls,
          )
          break
        case 'star':
          styleCls = cn(
            !visible && 'text-foreground/45',
            visible && effRevealed && cn('rounded-sm', revealedCls),
            visible && !effRevealed && cn('rounded-sm', peekedCls),
          )
          // One * per character (JSX-level swap; data-word keeps the real text).
          if (!visible) inner = '*'.repeat(Array.from(text).length)
          break
        case 'blank':
          styleCls = cn(
            'rounded',
            !visible && 'bg-muted-foreground/15 text-transparent',
            visible && effRevealed && revealedCls,
            visible && !effRevealed && peekedCls,
          )
          break
        case 'highlight':
          styleCls = cn(
            'rounded',
            !visible && 'bg-amber-300/60 text-transparent',
            visible && effRevealed && revealedCls,
            visible && !effRevealed && peekedCls,
          )
          break
      }

      const blank = (
        <span
          key={`b-${idx}`}
          role="button"
          tabIndex={0}
          aria-label={
            selectionMode
              ? `已挖空：${text}，点击取消挖空`
              : visible
                ? `已显示：${text}`
                : '点击显示答案'
          }
          data-word={text}
          onClick={(e) => {
            e.stopPropagation()
            if (!brushMode) {
              if (selectionMode) onToggleKeyword(text)
              else onReveal(idx)
            }
          }}
          onDoubleClick={
            selectionMode
              ? undefined
              : (e) => {
                  e.stopPropagation()
                  onToggleKeyword(text)
                }
          }
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              if (!brushMode) {
                if (selectionMode) onToggleKeyword(text)
                else onReveal(idx)
              }
            }
          }}
          className={cn(
            'cursor-pointer align-middle',
            selectionMode ? 'select-text' : 'select-none',
            style !== 'blur' && 'transition-colors',
            styleCls,
          )}
          style={{
            minWidth: '1.5em',
            ...(style === 'blur'
              ? {
                  filter: !visible ? 'blur(5px)' : 'blur(0px)',
                  transition:
                    'filter 200ms ease, opacity 200ms ease, background-color 200ms ease, color 200ms ease',
                }
              : {}),
          }}
        >
          {inner}
        </span>
      )

      // 编辑模式: render blanks bare so native long-press text selection works
      // (the long-press menu would swallow it); tapping a blank toggles it off.
      if (selectionMode) return blank

      const blankActions: MenuAction[] =
        menuActions ??
        [
          { key: 'reveal', label: '查看答案', icon: <Eye className="size-3.5" strokeWidth={1.75} /> },
          { key: 'speak', label: '朗读该词', icon: <Volume2 className="size-3.5" strokeWidth={1.75} /> },
          { key: 'copy', label: '复制词语', icon: <Copy className="size-3.5" strokeWidth={1.75} /> },
          ...(onRemoveKeyword
            ? [{ key: 'remove', label: '取消挖空', icon: <Eraser className="size-3.5" strokeWidth={1.75} /> }]
            : []),
          ...(onMarkHard
            ? [{ key: 'mark', label: '标记难点', icon: <Flag className="size-3.5" strokeWidth={1.75} /> }]
            : []),
        ]

      return (
        <LongPressMenu
          key={`b-${idx}`}
          actions={blankActions}
          onAction={(key) => handleBlankMenuAction(key, text, idx)}
        >
          {blank}
        </LongPressMenu>
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
            if (selectionMode) {
              // 编辑模式: plain words stay plain — new blanks are added via the
              // selection floating button, not dblclick.
              return <span key={`w-${i}`}>{w.text}</span>
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
      ref={rootRef}
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
      onMouseUp={selectionMode ? evaluateSelection : undefined}
      onTouchEnd={selectionMode ? handleSelectionTouchEnd : undefined}
    >
      {buildContent()}
      {selMounted &&
        selectionMode &&
        selAction &&
        createPortal(
          <button
            ref={selBtnRef}
            type="button"
            aria-label="挖空选中"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={handleSelectCloze}
            style={{ left: selAction.x, top: selAction.y }}
            className={cn(
              'fixed left-0 top-0 z-50 -translate-x-1/2 whitespace-nowrap rounded-full bg-zinc-900/95 px-4 py-2 text-sm font-medium text-white shadow-xl backdrop-blur',
              selAction.above ? '-translate-y-full' : 'translate-y-0',
            )}
          >
            挖空选中
          </button>,
          document.body,
        )}
    </div>
  )
}
