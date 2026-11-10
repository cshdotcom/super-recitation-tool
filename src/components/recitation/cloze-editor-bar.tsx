'use client'

import * as React from 'react'
import { ChevronsDown, GripVertical, LayoutTemplate, ListOrdered, Paintbrush, Sparkles } from 'lucide-react'

import { cn } from '@/lib/utils'

interface ClozeEditorBarProps {
  count: number
  brushActive: boolean
  onAi: () => void
  onBrush: () => void
  onRule: () => void
  onTemplate: () => void
  onClearAll: () => void
}

/** 工具栏上移量记忆 key（localStorage，跨会话记忆）。 */
const BAR_LIFT_KEY = 'sb:cloze-editor-bar-lift'
/** 最大上移距离（px），避免拖出屏幕。 */
const BAR_LIFT_MAX = 360

// 挖空编辑模式底部工具条: 4 个工具按钮 + 已挖空计数/清空全部。
//
// Bug2（工具栏挡住文字选择手柄）修复：
//  1) 根元素带 data-cloze-ui——挖空刷采样命中本栏时自动跳过，不打断涂刷；
//  2) 新增拖动把手：按住 ⠿ 可把整条工具栏上移（避开屏幕底部的选择手柄/
//     选区拖块），上移量 localStorage 记忆，⌄ 按钮一键复位；
//  3) 上移后工具栏变为悬浮卡片（z-40 + 阴影），不遮挡下方正文内容。
export function ClozeEditorBar({
  count,
  brushActive,
  onAi,
  onBrush,
  onRule,
  onTemplate,
  onClearAll,
}: ClozeEditorBarProps) {
  const [lift, setLift] = React.useState(0)
  const liftDragRef = React.useRef<{ startY: number; startLift: number } | null>(null)

  React.useEffect(() => {
    try {
      const v = Number(window.localStorage.getItem(BAR_LIFT_KEY))
      if (Number.isFinite(v) && v > 0) setLift(Math.min(v, BAR_LIFT_MAX))
    } catch {
      /* noop */
    }
  }, [])

  const persistLift = (v: number) => {
    try {
      window.localStorage.setItem(BAR_LIFT_KEY, String(v))
    } catch {
      /* noop */
    }
  }

  const beginLiftDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* noop */
    }
    liftDragRef.current = { startY: e.clientY, startLift: lift }
  }

  const moveLiftDrag = (e: React.PointerEvent) => {
    const d = liftDragRef.current
    if (!d) return
    e.preventDefault()
    // 手指向上拖 = 工具栏上移（露出被挡住的文字/选择手柄）
    setLift(Math.max(0, Math.min(d.startLift - (e.clientY - d.startY), BAR_LIFT_MAX)))
  }

  const endLiftDrag = (e: React.PointerEvent) => {
    const d = liftDragRef.current
    if (!d) return
    liftDragRef.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* noop */
    }
    // 用松手坐标重算最终值，避免闭包里的旧 state
    const final = Math.max(0, Math.min(d.startLift - (e.clientY - d.startY), BAR_LIFT_MAX))
    persistLift(final)
  }

  const resetLift = () => {
    setLift(0)
    persistLift(0)
  }

  const tools = [
    { key: 'ai', label: 'AI挖空', icon: Sparkles, active: false, onClick: onAi },
    { key: 'brush', label: '挖空刷', icon: Paintbrush, active: brushActive, onClick: onBrush },
    { key: 'rule', label: '规则挖空', icon: ListOrdered, active: false, onClick: onRule },
    { key: 'template', label: '模版挖空', icon: LayoutTemplate, active: false, onClick: onTemplate },
  ]

  return (
    <div data-cloze-ui="1" className="w-full">
      <div
        className={cn(
          'relative',
          lift > 0 &&
            'z-40 -mx-1 rounded-2xl border border-border bg-background px-1 pb-1 shadow-xl',
        )}
        style={lift > 0 ? { transform: `translateY(-${lift}px)` } : undefined}
      >
        {/* 拖动把手：按住上移整条工具栏（避开选择手柄），位置记忆 */}
        <div className="relative flex items-center justify-center">
          <button
            type="button"
            aria-label="按住拖动可上移工具栏，避开选择手柄"
            onPointerDown={beginLiftDrag}
            onPointerMove={moveLiftDrag}
            onPointerUp={endLiftDrag}
            onPointerCancel={endLiftDrag}
            className="flex h-11 w-32 cursor-grab touch-none items-center justify-center rounded-full text-muted-foreground/50 transition-colors hover:text-muted-foreground active:cursor-grabbing"
          >
            <GripVertical className="size-4" strokeWidth={1.75} />
          </button>
          {lift > 8 && (
            <button
              type="button"
              aria-label="工具栏复位"
              onClick={resetLift}
              className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <ChevronsDown className="size-4" strokeWidth={1.75} />
            </button>
          )}
        </div>

        <div className="grid grid-cols-4 gap-2">
          {tools.map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.key}
                type="button"
                aria-pressed={t.active}
                onClick={t.onClick}
                className={cn(
                  'flex h-11 items-center justify-center gap-1.5 rounded-xl border px-1 transition-colors',
                  t.active
                    ? 'border-emerald-600 bg-emerald-600/10 text-emerald-600'
                    : 'border-border bg-background text-foreground hover:bg-accent/60',
                )}
              >
                <Icon className="size-4 shrink-0" strokeWidth={1.75} />
                <span className="text-xs font-medium whitespace-nowrap">{t.label}</span>
              </button>
            )
          })}
        </div>
        <div className="flex items-center justify-between pt-2">
          <p className="text-sm">
            已挖空 <span className="font-semibold text-red-500">{count}</span> 处
          </p>
          <button
            type="button"
            onClick={onClearAll}
            className="h-10 rounded-lg border border-red-500 bg-background px-4 text-sm font-medium text-red-500 transition-colors hover:bg-red-500/10"
          >
            清空全部
          </button>
        </div>
      </div>
    </div>
  )
}
