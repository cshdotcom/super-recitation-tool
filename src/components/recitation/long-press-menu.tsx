'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'

import { cn } from '@/lib/utils'

export interface MenuAction {
  key: string
  label: string
  icon?: React.ReactNode
  danger?: boolean
  disabled?: boolean
  /** Keep the menu open after tapping this action (e.g. inline palette toggles). */
  keepOpen?: boolean
}

interface LongPressMenuProps {
  actions: MenuAction[]
  onAction: (key: string) => void
  children: React.ReactNode
  /** Attach handlers to the child element itself instead of a wrapper span. */
  asChild?: boolean
  className?: string
  /** Called right when the menu opens (e.g. cancel an in-progress stroke). */
  onOpen?: () => void
}

const LONG_PRESS_MS = 480
const MOVE_TOLERANCE = 10
const MENU_WIDTH = 184
const ROW_HEIGHT = 42
const MENU_PAD = 14
const VIEWPORT_INSET = 8

/**
 * Reusable floating context menu: opens on right-click (desktop) or a 480ms
 * touch long-press (mobile, with haptic feedback). Renders in a portal with a
 * framer-motion scale/fade animation; closes on backdrop tap / Escape / scroll.
 */
export function LongPressMenu({
  actions,
  onAction,
  children,
  asChild = false,
  className,
  onOpen,
}: LongPressMenuProps) {
  const [open, setOpen] = React.useState<{ x: number; y: number } | null>(null)
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])

  const timerRef = React.useRef<number | null>(null)
  const startRef = React.useRef<{ x: number; y: number } | null>(null)
  const openRef = React.useRef(false)
  const suppressClickRef = React.useRef(false)
  const onOpenRef = React.useRef(onOpen)
  React.useEffect(() => {
    onOpenRef.current = onOpen
  })

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const clampPos = (x: number, y: number) => {
    const menuH = actions.length * ROW_HEIGHT + MENU_PAD
    const cx = Math.max(
      VIEWPORT_INSET,
      Math.min(x, window.innerWidth - MENU_WIDTH - VIEWPORT_INSET),
    )
    const cy = Math.max(
      VIEWPORT_INSET,
      Math.min(y, window.innerHeight - menuH - VIEWPORT_INSET),
    )
    return { x: cx, y: cy }
  }

  const openAt = (x: number, y: number) => {
    suppressClickRef.current = true
    openRef.current = true
    setOpen(clampPos(x, y))
    onOpenRef.current?.()
  }

  const close = React.useCallback(() => {
    if (!openRef.current) return
    openRef.current = false
    suppressClickRef.current = false
    setOpen(null)
  }, [])

  const handleAction = (key: string, keepOpen?: boolean) => {
    onAction(key)
    if (!keepOpen) close()
  }

  // ---------- trigger handlers ----------
  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') return // mouse uses right-click
    if (openRef.current) return
    startRef.current = { x: e.clientX, y: e.clientY }
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      const p = startRef.current
      if (!p) return
      try {
        navigator.vibrate?.(30)
      } catch {
        // haptics unsupported — ignore
      }
      openAt(p.x, p.y)
    }, LONG_PRESS_MS)
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    const p = startRef.current
    if (!p || timerRef.current === null) return
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_TOLERANCE) {
      clearTimer()
      startRef.current = null
    }
  }

  const handlePointerEnd = () => {
    clearTimer()
    startRef.current = null
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    clearTimer()
    startRef.current = null
    if (!openRef.current) openAt(e.clientX, e.clientY)
  }

  // Swallow the click that follows a long-press so the wrapped element's own
  // onClick (e.g. blank reveal) doesn't fire after opening the menu.
  const handleClickCapture = (e: React.MouseEvent) => {
    if (!suppressClickRef.current) return
    e.preventDefault()
    e.stopPropagation()
  }

  // ---------- global close listeners while open ----------
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const onScroll = () => close()
    const onResize = () => close()
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, close])

  React.useEffect(() => clearTimer, [])

  // ---------- menu panel (portal renders only while open so closed menus
  // never block page interaction) ----------
  const menuH = actions.length * ROW_HEIGHT + MENU_PAD
  const originX = open ? (open.x > window.innerWidth / 2 ? 'right' : 'left') : 'left'
  const originY = open
    ? open.y + menuH > window.innerHeight - 24
      ? 'bottom'
      : 'top'
    : 'top'

  const panel = open ? (
    <div
      className="fixed inset-0 z-[9999]"
      onClick={close}
      onContextMenu={(e) => {
        e.preventDefault()
        close()
      }}
    >
      <motion.div
        role="menu"
        aria-label="快捷菜单"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.14, ease: 'easeOut' }}
        style={{
          position: 'fixed',
          left: open.x,
          top: open.y,
          width: MENU_WIDTH,
          transformOrigin: `${originX} ${originY}`,
        }}
        className="pointer-events-auto rounded-2xl border border-white/10 bg-zinc-900/95 p-1.5 text-white shadow-2xl backdrop-blur"
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {actions.map((a) => (
          <button
            key={a.key}
            type="button"
            role="menuitem"
            disabled={a.disabled}
            onClick={(e) => {
              e.stopPropagation()
              handleAction(a.key, a.keepOpen)
            }}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] transition-colors',
              a.danger
                ? 'text-red-400 hover:bg-red-500/15'
                : 'text-zinc-100 hover:bg-white/10',
              a.disabled && 'pointer-events-none opacity-35',
            )}
          >
            {a.icon && <span className="flex size-4 shrink-0 items-center justify-center">{a.icon}</span>}
            <span className="truncate">{a.label}</span>
          </button>
        ))}
      </motion.div>
    </div>
  ) : null

  // asChild: instead of cloning props onto the child, render a transparent
  // (display:contents) capture-phase wrapper. Events aimed at the child pass
  // through it first (capture), so the menu triggers without altering the
  // child element's own props or DOM behavior.
  if (asChild) {
    return (
      <>
        <span
          style={{ display: 'contents' }}
          onContextMenuCapture={handleContextMenu}
          onPointerDownCapture={handlePointerDown}
          onPointerMoveCapture={handlePointerMove}
          onPointerUpCapture={handlePointerEnd}
          onPointerCancelCapture={handlePointerEnd}
          onClickCapture={handleClickCapture}
        >
          {children}
        </span>
        {mounted && panel ? createPortal(panel, document.body) : null}
      </>
    )
  }

  return (
    <>
      <span
        className={cn('inline-block select-none [-webkit-touch-callout:none]', className)}
        onContextMenu={handleContextMenu}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onClickCapture={handleClickCapture}
      >
        {children}
      </span>
      {mounted && panel ? createPortal(panel, document.body) : null}
    </>
  )
}
