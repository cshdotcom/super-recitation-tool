'use client'

// TextSelectionMenu — 跨模块通用的「划词浮动菜单」。
//
// 在任意内容视图（错题本 / 试卷夹 / 出题练习等）挂载一次，用户在
// containerRef 容器内拖选或长按选词后，在选区附近弹出与 AI 对话
// SelectionToolbar 同风格的深色圆角浮动条（z-[92]，portal 到 body）：
//   • 朗读/停止 — useQuickTts(ttsContext, settings)，朗读前剥离
//     Markdown / 代码块 / 数学定界符噪音（保留公式内文），截断 600 字
//   • 复制 — Clipboard API 优先，不可用时回退 execCommand + 临时 textarea
//   • 搜索 — 派发 app:openSearch（detail.query 预填统一检索浮层）
//   • extraActions — 调用方追加的自定义动作
//
// 行为参照 chat-tool.tsx 的 SelectionToolbar：selectionchange 防抖确认
// 选区（桌面 ~150ms / 触摸 ~300ms，等待系统选词手柄稳定）；滚动（捕获）/ 
// resize / Esc / 浮条外 pointerdown / 选区收起自动隐藏；全部监听挂在
// document/window 并按 containerRef 过滤，多实例互不干扰；浮条无遮罩、
// 不吞容器点击（仅在按钮 onMouseDown preventDefault 保住选区）。
// 浮条根节点带 data-toolbar-root="selmenu"，与 chat-tool 的
// [data-toolbar-root] 外点豁免约定一致。
import * as React from 'react'
import { createPortal } from 'react-dom'
import { Copy, Pause, Search, Volume2 } from 'lucide-react'
import { toast } from 'sonner'

import type { SettingsData } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useQuickTts } from '@/components/recitation/tts-player'

export interface TextSelectionMenuAction {
  label: string
  icon: React.ReactNode
  onClick: (text: string) => void
}

export interface TextSelectionMenuProps {
  /** 监听选区的容器（一般传视图根 div 的 ref） */
  containerRef: React.RefObject<HTMLElement | null>
  /** TTS 上下文 key（音色偏好），默认 'reader' */
  ttsContext?: string
  /** 传给 useQuickTts 的 settings（无则传 null，hook 容忍 null 用默认音色） */
  settings?: SettingsData | null
  /** 额外自定义动作（追加在默认动作后） */
  extraActions?: TextSelectionMenuAction[]
  className?: string
}

/** 浮动条估高（h-8 按钮 + 上下内边距，定位估算用）。 */
const BAR_H = 40
/** 浮条与选区的间距。 */
const BAR_GAP = 8
/** 视口钳制内边距。 */
const VIEWPORT_INSET = 8
/** 浮条宽度估算上限（实际宽度渲染后二次校正）。 */
const BAR_EST_W = 300

/** 朗读前清理噪音：去掉代码块 / Markdown 符号 / 数学定界符（保留公式内文），
 *  压平空白并截断到 600 字（与 chat-tool 消息朗读的清理策略一致）。 */
function stripForTts(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>|]/g, ' ')
    .replace(/\${1,2}([^$]*)\${1,2}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600)
}

/** 复制文本：优先 Clipboard API，不可用（非安全上下文等）时回退
 *  execCommand('copy') + 离屏 textarea。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 落到 execCommand 兜底 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/** 浮动条状态（fixed 视口坐标 + 选中文本快照）。 */
interface SelectionBarState {
  text: string
  top: number
  left: number
}

export function TextSelectionMenu({
  containerRef,
  ttsContext = 'reader',
  settings = null,
  extraActions,
  className,
}: TextSelectionMenuProps) {
  const tts = useQuickTts(ttsContext, settings ?? null)
  const [sel, setSel] = React.useState<SelectionBarState | null>(null)
  const [mounted, setMounted] = React.useState(false)
  const barRef = React.useRef<HTMLDivElement | null>(null)
  const timerRef = React.useRef<number | null>(null)
  const coarseRef = React.useRef(false)
  /** 事件闭包里读取的最新浮层状态（渲染期镜像，避免渲染期写 ref）。 */
  const selRef = React.useRef<SelectionBarState | null>(null)

  React.useEffect(() => {
    setMounted(true)
    return () => setMounted(false)
  }, [])

  React.useEffect(() => {
    selRef.current = sel
  })

  /** 读取位于容器内、且与容器相交的非空选区（文字 + 选区矩形）。 */
  const readSelection = React.useCallback((): { text: string; rect: DOMRect } | null => {
    const container = containerRef.current
    if (!container) return null
    const s = window.getSelection()
    if (!s || s.isCollapsed || s.rangeCount === 0) return null
    const text = s.toString().trim()
    if (!text) return null
    const range = s.getRangeAt(0)
    const node = range.commonAncestorContainer
    const el = node instanceof Element ? node : node.parentElement
    if (!el || !container.contains(el)) return null
    // 表单控件内选词（搜索框等）不弹菜单：部分浏览器 input 选区会走 document selection
    if (el.closest('input, textarea, select, [contenteditable="true"]')) return null
    const rect = range.getBoundingClientRect()
    if (rect.width <= 0 && rect.height <= 0) return null
    return { text, rect }
  }, [containerRef])

  // ---------- 全局监听（document / window 级；容器外事件自动忽略） ----------
  React.useEffect(() => {
    try {
      coarseRef.current = window.matchMedia('(pointer: coarse)').matches
    } catch {
      coarseRef.current = false
    }
    const clearCheck = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
    const hide = () => {
      clearCheck()
      setSel(null)
    }
    /** 选区附近定位（fixed）：桌面优先选区上方，触摸端避开系统选词菜单放下方。 */
    const positionBar = (rect: DOMRect): { top: number; left: number } => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      const estW = Math.min(vw - VIEWPORT_INSET * 2, BAR_EST_W)
      const left = Math.max(VIEWPORT_INSET, Math.min(rect.left, vw - estW - VIEWPORT_INSET))
      const topAbove = rect.top - BAR_H - BAR_GAP
      const topBelow = rect.bottom + BAR_GAP
      // 兜底位置：钳制到视口可见区（避免选区跨整屏时浮条出现在视口外）
      const clampTop = (t: number) =>
        Math.max(VIEWPORT_INSET, Math.min(t, vh - BAR_H - VIEWPORT_INSET))
      const fitsAbove = topAbove >= VIEWPORT_INSET
      const fitsBelow = topBelow + BAR_H <= vh - VIEWPORT_INSET
      let top: number
      if (coarseRef.current) {
        top = fitsBelow ? topBelow : fitsAbove ? topAbove : clampTop(topBelow)
      } else {
        top = fitsAbove ? topAbove : fitsBelow ? topBelow : clampTop(topAbove)
      }
      return { top, left }
    }
    /** 防抖确认选区：有选区 → 显示/更新浮动条；无 → 收起。 */
    const scheduleCheck = (delay: number) => {
      clearCheck()
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        const r = readSelection()
        if (r) setSel({ text: r.text, ...positionBar(r.rect) })
        else setSel(null)
      }, delay)
    }
    // ---- 选区变化：触摸端延迟（等系统选词/拖动手柄稳定），桌面 ~150ms ----
    const onSelectionChange = () => {
      const s = window.getSelection()
      if (s && !s.isCollapsed && s.rangeCount > 0) {
        scheduleCheck(coarseRef.current ? 300 : 150)
        return
      }
      // 选区收起：稍候再收起浮动条（点菜单按钮时选区可能被瞬时清空）
      if (selRef.current) scheduleCheck(220)
    }
    // ---- 桌面拖选结束 / 触摸抬手：尽快确认 ----
    const onMouseUp = (e: MouseEvent) => {
      if (coarseRef.current || e.button !== 0) return
      scheduleCheck(40)
    }
    const onTouchEnd = () => {
      if (coarseRef.current) scheduleCheck(300)
    }
    // ---- 滚动 / 缩放：收起浮层（浮层无遮罩，本身不阻挡滚动） ----
    const onScrollOrResize = () => {
      if (selRef.current) hide()
    }
    // ---- Esc：收起浮层（捕获 + 阻断，避免同时关闭上层 Dialog/Sheet） ----
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !selRef.current) return
      e.preventDefault()
      e.stopPropagation()
      hide()
      try {
        window.getSelection()?.removeAllRanges()
      } catch {
        /* 忽略 */
      }
    }
    // ---- 浮条外任意 pointerdown：收起（命中任意 [data-toolbar-root] 浮层则豁免，
    //      与 chat-tool 的选区条/消息菜单约定一致）；不吞容器点击 ----
    const onPointerDown = (e: PointerEvent) => {
      if (!selRef.current) return
      const t = e.target
      if (t instanceof Element && t.closest('[data-toolbar-root]')) return
      hide()
    }
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('touchend', onTouchEnd, { passive: true })
    window.addEventListener('scroll', onScrollOrResize, true)
    document.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      clearCheck()
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('scroll', onScrollOrResize, true)
      document.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [readSelection])

  // 浮动条实际宽度超出视口时左移收回（宽度随内容自适应，估算值可能偏小）
  React.useEffect(() => {
    if (!sel) return
    const bar = barRef.current
    if (!bar) return
    const w = bar.getBoundingClientRect().width
    const maxLeft = window.innerWidth - w - VIEWPORT_INSET
    if (sel.left > maxLeft) {
      setSel((prev) => (prev ? { ...prev, left: Math.max(VIEWPORT_INSET, maxLeft) } : prev))
    }
  }, [sel])

  /** 收起浮条并清除系统选区。 */
  const close = () => {
    setSel(null)
    try {
      window.getSelection()?.removeAllRanges()
    } catch {
      /* 忽略 */
    }
  }

  /** 朗读选中文字（复用 useQuickTts：音色/倍速随设置；先 stop 复位再播）。 */
  const speakSelection = (text: string) => {
    const clean = stripForTts(text)
    if (!clean) {
      toast.error('没有可朗读的内容')
      return
    }
    tts.stop()
    tts.speak(clean)
  }

  /** 复制选中文字（Clipboard API 优先，失败回退 execCommand）。 */
  const copySelection = async (text: string) => {
    const ok = await copyText(text)
    if (ok) toast.success('已复制')
    else toast.error('复制失败')
    close()
  }

  /** 用选中文字预填打开统一检索浮层（选区随之收起，浮条自然隐藏）。 */
  const searchSelection = (text: string) => {
    window.dispatchEvent(
      new CustomEvent('app:openSearch', { detail: { query: text.slice(0, 80) } }),
    )
    close()
  }

  if (!mounted) return null

  const actions: Array<{ key: string; label: string; icon: React.ReactNode; onClick: () => void }> =
    [
      {
        key: 'speak',
        label: tts.speaking ? '停止' : '朗读',
        icon: tts.speaking ? (
          <Pause className="size-3.5" strokeWidth={2} />
        ) : (
          <Volume2 className="size-3.5" strokeWidth={1.75} />
        ),
        onClick: () => (tts.speaking ? tts.stop() : speakSelection(sel?.text ?? '')),
      },
      {
        key: 'copy',
        label: '复制',
        icon: <Copy className="size-3.5" strokeWidth={1.75} />,
        onClick: () => {
          if (sel) void copySelection(sel.text)
        },
      },
      {
        key: 'search',
        label: '搜索',
        icon: <Search className="size-3.5" strokeWidth={1.75} />,
        onClick: () => {
          if (sel) searchSelection(sel.text)
        },
      },
      ...(extraActions ?? []).map((a, i) => ({
        key: `extra-${i}`,
        label: a.label,
        icon: a.icon,
        onClick: () => {
          if (!sel) return
          a.onClick(sel.text)
          close()
        },
      })),
    ]

  return createPortal(
    sel ? (
      <div
        ref={barRef}
        data-toolbar-root="selmenu"
        role="toolbar"
        aria-label="选中文字操作"
        className={cn(
          'fixed z-[92] max-w-[calc(100vw-1rem)] animate-in fade-in slide-in-from-bottom-1 duration-150',
          className,
        )}
        style={{ top: sel.top, left: sel.left }}
      >
        <div className="flex items-center gap-0.5 overflow-x-auto rounded-full bg-zinc-900 p-1 text-white shadow-lg [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={a.onClick}
              onMouseDown={(e) => e.preventDefault()}
              className={cn(
                'flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-zinc-100 transition-colors hover:bg-white/15',
                a.key === 'speak' &&
                  tts.speaking &&
                  'bg-emerald-500/25 text-emerald-200 hover:bg-emerald-500/30',
              )}
            >
              <span className="flex size-3.5 shrink-0 items-center justify-center">{a.icon}</span>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    ) : null,
    document.body,
  )
}
