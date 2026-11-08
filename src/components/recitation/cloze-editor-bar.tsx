'use client'

import { LayoutTemplate, ListOrdered, Paintbrush, Sparkles } from 'lucide-react'

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

// 挖空编辑模式底部工具条: a row of 4 tool buttons + a status row with the
// current blank count and a 清空全部 button.
export function ClozeEditorBar({
  count,
  brushActive,
  onAi,
  onBrush,
  onRule,
  onTemplate,
  onClearAll,
}: ClozeEditorBarProps) {
  const tools = [
    { key: 'ai', label: 'AI挖空', icon: Sparkles, active: false, onClick: onAi },
    { key: 'brush', label: '挖空刷', icon: Paintbrush, active: brushActive, onClick: onBrush },
    { key: 'rule', label: '规则挖空', icon: ListOrdered, active: false, onClick: onRule },
    { key: 'template', label: '模版挖空', icon: LayoutTemplate, active: false, onClick: onTemplate },
  ]

  return (
    <div className="w-full">
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
  )
}
