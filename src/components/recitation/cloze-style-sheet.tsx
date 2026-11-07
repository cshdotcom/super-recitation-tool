'use client'

import * as React from 'react'

import type { ClozeStyle } from '@/lib/types'
import { CLOZE_STYLE_OPTIONS } from '@/lib/types'
import { cn } from '@/lib/utils'
import { BottomSheet } from '@/components/recitation/bottom-sheet'

interface ClozeStyleSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  value: ClozeStyle
  onChange: (s: ClozeStyle) => void
}

// Preview icon for one style option. `active` drives the indigo-600 selected
// color via currentColor; inactive options render muted. Two icons keep their
// intrinsic color to match the reference design (highlight amber block, circle
// indigo ring).
function StyleIcon({ kind }: { kind: ClozeStyle }) {
  switch (kind) {
    case 'underline':
      return (
        <span className="border-b-2 border-dashed border-current pb-0.5 text-2xl font-semibold leading-none">
          A
        </span>
      )
    case 'blur':
      return (
        <span
          className="text-2xl font-semibold leading-none"
          style={{ filter: 'blur(3.5px)' }}
        >
          A
        </span>
      )
    case 'star':
      return <span className="text-3xl font-bold leading-none">*</span>
    case 'blank':
      return <span className="block size-6 rounded-md border-2 border-dashed border-current" />
    case 'highlight':
      return <span className="block size-6 rounded-md bg-amber-300" />
    case 'circle':
      return (
        <span className="flex h-7 w-10 items-center justify-center rounded-[50%] border-2 border-indigo-600 text-sm font-semibold">
          A
        </span>
      )
  }
}

// 底部弹窗「挖空显示样式」— 3×2 grid of white rounded option cards.
export function ClozeStyleSheet({ open, onOpenChange, value, onChange }: ClozeStyleSheetProps) {
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="挖空显示样式">
      <div
        role="radiogroup"
        aria-label="挖空显示样式"
        className="grid grid-cols-3 gap-3 px-1 pb-4 pt-5"
      >
        {CLOZE_STYLE_OPTIONS.map((opt) => {
          const active = opt.value === value
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(opt.value)}
              className={cn(
                'flex flex-col items-center gap-2 rounded-xl border border-border/60 bg-card p-4 text-center shadow-sm transition-colors',
                active ? 'text-indigo-600' : 'text-muted-foreground',
              )}
            >
              <span className="flex h-10 items-center justify-center">
                <StyleIcon kind={opt.value} />
              </span>
              <span className={cn('text-xs', active && 'font-medium')}>{opt.label}</span>
            </button>
          )
        })}
      </div>
    </BottomSheet>
  )
}
