'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'
import { Copy, Eraser, Eye, Flag, RotateCcw, Volume2 } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { splitCharTokens, splitParagraphs, tokenize } from '@/lib/cloze'
import type { ClozeStyle } from '@/lib/types'
import { LongPressMenu, type MenuAction } from '@/components/recitation/long-press-menu'

const LONG_PRESS_MS = 420
const MOVE_TOLERANCE = 12
const SEL_MENU_WIDTH = 196
const SEL_MENU_PAD = 14
const SEL_ROW_HEIGHT = 42
const VIEWPORT_INSET = 8

interface CharToken {
  text: string
  isChar: boolean // 字 token (toggleable) vs separator
}

interface ClozeTextProps {
  content: string
  keywords: string[]
  style: ClozeStyle
  showAnswers: boolean
  fontSize: number
  /** 挖空刷 mode: drag over 字 to blank them. */
  brushMode?: boolean
  /** 手动挖空 mode: double-click 字 to blank them. */
  manualMode?: boolean
  /** When provided (AI快速分块), render numbered chunk blocks instead of plain paragraphs. */
  chunks?: string[] | null
  /** When provided (paged mode), render horizontal snap pages. */
  pages?: string[] | null
  onPageChange?: (page: number, total: number) => void
  revealed: Set<number>
  onReveal: (idx: number) => void
  onToggleKeyword: (word: string) => void
  /** 挖空编辑模式: tapping a blank removes it; the selection menu's 挖空 action
   * routes to onSelectCloze instead of the reader keyword updater. */
  selectionMode?: boolean
  /** Called with the trimmed selected text when 挖空选中 is tapped (编辑模式). */
  onSelectCloze?: (text: string) => void
  /** ALWAYS-ON custom selection menu (reader mode): captures long-press
   * (mobile) + right-click (desktop) character selection and shows a floating
   * menu with a 挖空 button. */
  selectMenuEnabled?: boolean
  /** 挖空 the selected substring (multi-字 selection blanks that whole part). */
  onSelectionCloze?: (text: string) => void
  /** 取消挖空 — called when the selection is an existing keyword. */
  onSelectionUncloze?: (text: string) => void
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
  selectMenuEnabled = false,
  onSelectionCloze,
  onSelectionUncloze,
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

  // 朗读该字 — browser speechSynthesis only, no server call.
  const speakText = (text: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      toast.error('当前浏览器不支持朗读')
      return
    }
    try {
      window.speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'zh-CN'
      u.rate = 0.9
      window.speechSynthesis.speak(u)
    } catch {
      toast.error('朗读失败，请重试')
    }
  }

  // 复制文本
  const copyText = (text: string) => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => toast.success(`已复制「${text.slice(0, 12)}${text.length > 12 ? '…' : ''}」`))
      .catch(() => toast.error('复制失败，请长按手动复制'))
  }

  const handleBlankMenuAction = (key: string, word: string, idx: number) => {
    switch (key) {
      case 'reveal':
        tempReveal(idx)
        break
      case 'speak':
        speakText(word)
        break
      case 'copy':
        copyText(word)
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

  const keywordSet = React.useMemo(() => new Set(keywords), [keywords])

  // ===========================================================================
  // 自定义选择菜单 (character-level): captures long-press (touch) + right-click
  // (desktop), highlights selected 字 spans and shows a floating menu with a
  // 挖空选中 button — replaces the native selection callout.
  // ===========================================================================
  const menuEnabled = (selectionMode || selectMenuEnabled) && !brushMode
  const [selHL, setSelHL] = React.useState<Set<number>>(new Set())
  const [selMenu, setSelMenu] = React.useState<{
    x: number
    y: number
    above: boolean
    text: string
    isKeyword: boolean
  } | null>(null)
  const selectingRef = React.useRef(false)
  const pressTimerRef = React.useRef<number | null>(null)
  const pressStartRef = React.useRef<{ x: number; y: number } | null>(null)
  const anchorRef = React.useRef<number>(-1)
  const focusRef = React.useRef<number>(-1)
  const [selMounted, setSelMounted] = React.useState(false)
  React.useEffect(() => setSelMounted(true), [])

  // Ordered char spans (document order == render order).
  const getCharEls = React.useCallback((): HTMLElement[] => {
    const root = rootRef.current
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLElement>('[data-char]'))
  }, [])

  const clearSelHighlight = React.useCallback(() => {
    anchorRef.current = -1
    focusRef.current = -1
    setSelHL(new Set())
  }, [])

  const highlightRange = React.useCallback(
    (a: number, f: number) => {
      const els = getCharEls()
      if (!els.length) return
      const lo = Math.max(0, Math.min(a, f))
      const hi = Math.min(els.length - 1, Math.max(a, f))
      const s = new Set<number>()
      for (let i = lo; i <= hi; i++) s.add(i)
      anchorRef.current = a
      focusRef.current = f
      setSelHL(s)
    },
    [getCharEls],
  )

  const extractSelText = React.useCallback(
    (a: number, f: number): string => {
      const els = getCharEls()
      const lo = Math.max(0, Math.min(a, f))
      const hi = Math.min(els.length - 1, Math.max(a, f))
      let out = ''
      for (let i = lo; i <= hi; i++) {
        const el = els[i]
        out += el.getAttribute('data-word') ?? el.textContent ?? ''
      }
      return out.trim()
    },
    [getCharEls],
  )

  const clearPressTimer = () => {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current)
      pressTimerRef.current = null
    }
  }

  const closeSelMenu = React.useCallback(() => {
    setSelMenu(null)
    clearSelHighlight()
  }, [clearSelHighlight])

  const charIdxFromEvent = (e: { clientX: number; clientY: number }): number => {
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const charEl = el?.closest('[data-char]') as HTMLElement | null
    if (!charEl) return -1
    const els = getCharEls()
    return els.indexOf(charEl)
  }

  const openMenuForRange = React.useCallback(
    (a: number, f: number, at?: { x: number; y: number }) => {
      const els = getCharEls()
      const lo = Math.max(0, Math.min(a, f))
      const hi = Math.min(els.length - 1, Math.max(a, f))
      if (hi < lo) return
      const text = extractSelText(a, f)
      if (!text) return
      const r1 = els[lo].getBoundingClientRect()
      const r2 = els[hi].getBoundingClientRect()
      const top = Math.min(r1.top, r2.top)
      const bottom = Math.max(r1.bottom, r2.bottom)
      const left = Math.min(r1.left, r2.left)
      const right = Math.max(r1.right, r2.right)
      const above = top > 96
      const x = Math.min(
        Math.max((left + right) / 2, SEL_MENU_WIDTH / 2 + VIEWPORT_INSET),
        window.innerWidth - SEL_MENU_WIDTH / 2 - VIEWPORT_INSET,
      )
      const y = above ? top - 8 : bottom + 8
      if (at) {
        setSelMenu({ x: at.x, y: at.y, above: at.y > window.innerHeight / 2, text, isKeyword: keywordSet.has(text) })
      } else {
        setSelMenu({ x, y, above, text, isKeyword: keywordSet.has(text) })
      }
    },
    [extractSelText, getCharEls, keywordSet],
  )

  // ---- pointer flow (touch long-press drag selection) ----
  const handleRootPointerDown = (e: React.PointerEvent) => {
    if (!menuEnabled) return
    if (e.pointerType === 'mouse') return // mouse uses right-click
    if (selMenu) return // menu open: backdrop handles closing
    const target = e.target as HTMLElement
    // Blanks wrapped by LongPressMenu handle their own long-press menu.
    const inBlank = !!target.closest('[data-word]')
    const charEl = target.closest('[data-char]') as HTMLElement | null
    if (!charEl) return
    if (inBlank && !selectionMode) return
    pressStartRef.current = { x: e.clientX, y: e.clientY }
    clearPressTimer()
    pressTimerRef.current = window.setTimeout(() => {
      pressTimerRef.current = null
      const idx = getCharEls().indexOf(charEl)
      if (idx < 0) return
      try {
        navigator.vibrate?.(25)
      } catch {
        /* haptics unsupported */
      }
      selectingRef.current = true
      highlightRange(idx, idx)
    }, LONG_PRESS_MS)
  }

  const handleRootPointerMove = (e: React.PointerEvent) => {
    if (!menuEnabled) return
    const start = pressStartRef.current
    if (selectingRef.current) {
      const idx = charIdxFromEvent(e)
      if (idx >= 0 && idx !== focusRef.current) {
        highlightRange(anchorRef.current, idx)
      }
      return
    }
    if (!start || pressTimerRef.current === null) return
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > MOVE_TOLERANCE) {
      clearPressTimer()
      pressStartRef.current = null
    }
  }

  const handleRootPointerEnd = (e: React.PointerEvent) => {
    if (!menuEnabled) return
    if (selectingRef.current) {
      selectingRef.current = false
      pressStartRef.current = null
      const a = anchorRef.current
      const f = focusRef.current
      if (a >= 0 && f >= 0) {
        openMenuForRange(a, f)
      }
      return
    }
    clearPressTimer()
    pressStartRef.current = null
    void e
  }

  // ---- right-click (desktop): native selection OR char under cursor ----
  const handleRootContextMenu = (e: React.MouseEvent) => {
    if (!menuEnabled) return
    const target = e.target as HTMLElement
    const inBlank = !!target.closest('[data-word]')
    if (inBlank && !selectionMode) return // LongPressMenu on the blank handles it
    e.preventDefault()
    clearPressTimer()

    const sel = document.getSelection()
    const selText = (sel?.toString() ?? '').trim()
    const root = rootRef.current
    const nativeInside =
      sel &&
      !sel.isCollapsed &&
      sel.rangeCount > 0 &&
      root &&
      sel.anchorNode &&
      sel.focusNode &&
      root.contains(sel.anchorNode) &&
      root.contains(sel.focusNode)

    if (nativeInside && selText && selText.length <= 200) {
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      const x = Math.min(
        Math.max(e.clientX, SEL_MENU_WIDTH / 2 + VIEWPORT_INSET),
        window.innerWidth - SEL_MENU_WIDTH / 2 - VIEWPORT_INSET,
      )
      const y = Math.min(Math.max(e.clientY, VIEWPORT_INSET + 8), window.innerHeight - 8)
      setSelMenu({
        x,
        y,
        above: y > window.innerHeight / 2,
        text: selText,
        isKeyword: keywordSet.has(selText),
      })
      return
    }

    // No native selection: select the 字 under the cursor.
    const idx = charIdxFromEvent(e)
    if (idx < 0) return
    highlightRange(idx, idx)
    openMenuForRange(idx, idx, { x: e.clientX, y: e.clientY })
  }

  const handleSelMenuAction = (key: string) => {
    const cur = selMenu
    if (!cur) return
    switch (key) {
      case 'cloze': {
        const text = cur.text
        if (cur.isKeyword) {
          // already blanked → uncloze
          if (selectionMode) {
            onToggleKeyword(text)
          } else {
            onSelectionUncloze?.(text)
            toast.success(`已取消挖空「${text.slice(0, 10)}${text.length > 10 ? '…' : ''}」`)
          }
        } else if (selectionMode) {
          onSelectCloze?.(text)
        } else {
          onSelectionCloze?.(text)
          toast.success(
            `已挖空 ${Array.from(text).length} 字「${text.slice(0, 10)}${text.length > 10 ? '…' : ''}」`,
          )
        }
        closeSelMenu()
        document.getSelection()?.removeAllRanges()
        break
      }
      case 'copy':
        copyText(cur.text)
        break
      case 'speak':
        speakText(cur.text)
        break
    }
  }

  // Global close listeners while the selection menu is open.
  React.useEffect(() => {
    if (!selMenu) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') closeSelMenu()
    }
    const onScroll = () => closeSelMenu()
    const onResize = () => closeSelMenu()
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [selMenu, closeSelMenu])

  React.useEffect(() => clearPressTimer, [])

  const selMenuH = 3 * SEL_ROW_HEIGHT + SEL_MENU_PAD
  const selOriginX = selMenu
    ? selMenu.x > window.innerWidth / 2
      ? 'right'
      : 'left'
    : 'left'
  const selOriginY = selMenu
    ? selMenu.above
      ? 'bottom'
      : 'top'
    : 'top'

  const selMenuPanel = selMenu ? (
    <div
      className="fixed inset-0 z-[9999]"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={closeSelMenu}
      onContextMenu={(e) => {
        e.preventDefault()
        closeSelMenu()
      }}
    >
      <div
        role="menu"
        aria-label="选择菜单"
        style={{
          position: 'fixed',
          left: selMenu.x,
          top: selMenu.y,
          width: SEL_MENU_WIDTH,
          transformOrigin: `${selOriginX} ${selOriginY}`,
          transform: 'translate(-50%, -50%)',
        }}
        className="pointer-events-auto rounded-2xl border border-white/10 bg-zinc-900/95 p-1.5 text-white shadow-2xl backdrop-blur"
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        <button
          type="button"
          role="menuitem"
          onClick={(e) => {
            e.stopPropagation()
            handleSelMenuAction('cloze')
          }}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] transition-colors',
            selMenu.isKeyword
              ? 'text-amber-300 hover:bg-amber-400/15'
              : 'text-emerald-300 hover:bg-emerald-400/15',
          )}
        >
          {selMenu.isKeyword ? (
            <RotateCcw className="size-4 shrink-0" strokeWidth={1.75} />
          ) : (
            <Eraser className="size-4 shrink-0" strokeWidth={1.75} />
          )}
          <span className="truncate">
            {selMenu.isKeyword
              ? `取消挖空「${selMenu.text.slice(0, 6)}${selMenu.text.length > 6 ? '…' : ''}」`
              : `挖空选中${Array.from(selMenu.text).length > 1 ? `（${Array.from(selMenu.text).length}字）` : ''}`}
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={(e) => {
            e.stopPropagation()
            handleSelMenuAction('speak')
          }}
          className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-zinc-100 transition-colors hover:bg-white/10"
        >
          <Volume2 className="size-4 shrink-0" strokeWidth={1.75} />
          <span className="truncate">朗读</span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={(e) => {
            e.stopPropagation()
            handleSelMenuAction('copy')
          }}
          className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-zinc-100 transition-colors hover:bg-white/10"
        >
          <Copy className="size-4 shrink-0" strokeWidth={1.75} />
          <span className="truncate">复制</span>
        </button>
      </div>
    </div>
  ) : null

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

  const handleBrushPointerDown = (e: React.PointerEvent) => {
    if (!brushMode) return
    draggingRef.current = true
    touchedRef.current.clear()
    // If the drag starts on a 字, blank it immediately.
    const target = e.target as HTMLElement
    const wordEl = target.closest?.('[data-word]') as HTMLElement | null
    if (wordEl?.dataset.word) {
      const w = wordEl.dataset.word
      touchedRef.current.add(w)
      onToggleKeyword(w)
    }
  }

  const handleBrushPointerMove = (e: React.PointerEvent) => {
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

  // ---- build all content JSX; blanks AND 字 tokens get running indices so
  // the selection layer can highlight arbitrary ranges. ----
  const buildContent = (): React.ReactNode => {
    let blankIdx = -1
    let charIdx = -1

    // Highlight classes applied while the custom selection covers this token.
    const hlCls = (isBlank: boolean) =>
      selHL.size > 0 && charIdx >= 0 && selHL.has(charIdx)
        ? isBlank
          ? 'outline-2 outline-amber-500/80'
          : 'rounded-sm bg-amber-300/70 outline-2 outline-amber-500/80 dark:bg-amber-500/40'
        : undefined

    const renderBlank = (text: string) => {
      blankIdx += 1
      const idx = blankIdx
      charIdx += 1
      const ci = charIdx
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
          data-char="1"
          data-ci={ci}
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
            'select-none [-webkit-touch-callout:none]',
            style !== 'blur' && 'transition-colors',
            styleCls,
            hlCls(true),
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

      // 编辑模式: render blanks bare — tapping a blank toggles it off; the
      // unified selection menu handles long-press/right-click.
      if (selectionMode) return blank

      const blankActions: MenuAction[] =
        menuActions ??
        [
          { key: 'reveal', label: '查看答案', icon: <Eye className="size-3.5" strokeWidth={1.75} /> },
          { key: 'speak', label: '朗读该字', icon: <Volume2 className="size-3.5" strokeWidth={1.75} /> },
          { key: 'copy', label: '复制', icon: <Copy className="size-3.5" strokeWidth={1.75} /> },
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

    const renderParagraph = (para: string, paraKey: string, tocPara?: number): React.ReactNode => {
      const tokens = brushMode || manualMode ? null : tokenize(para, keywords)

      if (tokens) {
        // Normal (non-toggle) rendering: keyword segments become blanks,
        // everything else splits into 字 tokens (selection targets).
        return (
          <p key={paraKey} data-toc-para={tocPara} className="whitespace-pre-wrap">
            {tokens.flatMap((seg, i) => {
              if (seg.isBlank) return [renderBlank(seg.text)]
              const parts = splitCharTokens(seg.text)
              return parts.map((w, j) => {
                if (!w.isChar) {
                  return <span key={`s${i}-${j}`}>{w.text}</span>
                }
                charIdx += 1
                const ci = charIdx
                return (
                  <span
                    key={`s${i}-${j}`}
                    data-char="1"
                    data-ci={ci}
                    className={cn(
                      'select-none [-webkit-touch-callout:none]',
                      hlCls(false),
                    )}
                  >
                    {w.text}
                  </span>
                )
              })
            })}
          </p>
        )
      }

      // 字-level rendering for 挖空刷 / 手动挖空 / selection.
      const chars = splitCharTokens(para)
      return (
        <p key={paraKey} data-toc-para={tocPara} className="whitespace-pre-wrap">
          {chars.map((w, i) => {
            if (!w.isChar) return <span key={`w-${i}`}>{w.text}</span>
            if (keywordSet.has(w.text)) {
              return renderBlank(w.text)
            }
            charIdx += 1
            const ci = charIdx
            if (selectionMode) {
              // 编辑模式: plain 字 stay plain — new blanks are added via the
              // selection menu, not dblclick.
              return (
                <span
                  key={`w-${i}`}
                  data-char="1"
                  data-ci={ci}
                  className={cn(
                    'select-none [-webkit-touch-callout:none]',
                    hlCls(false),
                  )}
                >
                  {w.text}
                </span>
              )
            }
            return (
              <span
                key={`w-${i}`}
                data-char="1"
                data-ci={ci}
                data-word={brushMode ? w.text : undefined}
                className={cn(
                  'select-none [-webkit-touch-callout:none]',
                  brushMode && 'cursor-crosshair rounded-sm transition-colors hover:bg-accent/70',
                  manualMode && 'cursor-text rounded-sm transition-colors hover:bg-accent/70',
                  hlCls(false),
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
          {chunks.map((chunk, ci2) => (
            <div
              key={`chunk-${ci2}`}
              data-toc-chunk={ci2}
              className="rounded-xl border border-border bg-card p-4 shadow-sm"
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="flex size-6 items-center justify-center rounded-full bg-emerald-600 text-xs font-semibold text-white">
                  {ci2 + 1}
                </span>
                <span className="text-xs text-muted-foreground">
                  第 {ci2 + 1} 块 · {chunk.length} 字
                </span>
              </div>
              <div className="space-y-3">
                {splitParagraphs(chunk).map((p, pi) => renderParagraph(p, `c${ci2}-p${pi}`))}
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
        {splitParagraphs(content).map((p, pi) => renderParagraph(p, `p${pi}`, pi))}
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className={cn(
        'leading-loose text-zinc-800 dark:text-zinc-200',
        brushMode && 'touch-none select-none',
        menuEnabled && 'select-none [-webkit-touch-callout:none]',
      )}
      style={{ fontSize: `${fontSize}px` }}
      onPointerDown={(e) => {
        handleBrushPointerDown(e)
        handleRootPointerDown(e)
      }}
      onPointerMove={(e) => {
        handleBrushPointerMove(e)
        handleRootPointerMove(e)
      }}
      onPointerUp={(e) => {
        draggingRef.current = false
        handleRootPointerEnd(e)
      }}
      onPointerCancel={(e) => {
        draggingRef.current = false
        handleRootPointerEnd(e)
      }}
      onContextMenu={handleRootContextMenu}
    >
      {buildContent()}
      {selMounted && selMenuPanel ? createPortal(selMenuPanel, document.body) : null}
    </div>
  )
}
