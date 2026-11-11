'use client'

import * as React from 'react'

import type { ReviewAction } from '@/lib/types'
import { SCHEME_SCORE_ACTIONS, type ReviewScheme } from '@/lib/card'
import { cn } from '@/lib/utils'

interface ReviewScoreBarProps {
  onScore: (action: ReviewAction) => void
  disabled?: boolean
  /** 复习方案（评分档位与之匹配）：sm2=熟悉/模糊/忘记（默认） fixed=记得/模糊/忘记 simple=会/不会 */
  scheme?: ReviewScheme
}

const ACTION_BG: Record<ReviewAction, string> = {
  familiar: 'bg-[#5b5bf0]',
  fuzzy: 'bg-[#f59e0b]',
  forget: 'bg-[#ef4444]',
}

// 背诵页/复习会话底部评分条：档位随复习方案变化
// （SM-2 艾宾浩斯=熟悉/模糊/忘记；固定间隔=记得/模糊/忘记；简单模式=会/不会），
// 点击后短暂显示选中态。
export function ReviewScoreBar({ onScore, disabled, scheme = 'sm2' }: ReviewScoreBarProps) {
  const [picked, setPicked] = React.useState<ReviewAction | null>(null)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const handlePick = (action: ReviewAction) => {
    setPicked(action)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setPicked(null), 260)
    onScore(action)
  }

  return (
    <div className="flex gap-3">
      {SCHEME_SCORE_ACTIONS[scheme].map((a) => (
        <button
          key={a.value}
          type="button"
          disabled={disabled}
          aria-label={a.label}
          onClick={() => handlePick(a.value)}
          className={cn(
            'h-14 flex-1 rounded-xl text-base font-semibold text-white transition-all',
            'active:scale-95 disabled:pointer-events-none disabled:opacity-50',
            ACTION_BG[a.value],
            picked === a.value && 'scale-95 brightness-90',
          )}
        >
          {a.label}
        </button>
      ))}
    </div>
  )
}
