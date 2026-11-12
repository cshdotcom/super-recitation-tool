'use client'

// 复习评分条（v2.8.0+）— FSRS 4 档 Again/Hard/Good/Easy，带间隔预览；
// sm2/fixed 三档（忘记/困难/熟悉）；simple 两档（不会/会）。
// 按钮下方实时显示「点击后 X 天后复习」预览（来自 /api/algorithms/preview）。
import * as React from 'react'

import type { AlgorithmType, Grade, GradePreview } from '@/lib/spaced-repetition'
import { GRADES } from '@/lib/spaced-repetition'
import { cn } from '@/lib/utils'

interface ReviewScoreBarProps {
  onScore: (grade: Grade) => void
  disabled?: boolean
  /** 算法类型，决定按钮档位 */
  algorithm?: AlgorithmType
  /** 4 档间隔预览（可选，来自 /api/algorithms/preview） */
  previews?: GradePreview[] | null
}

const GRADE_BG: Record<Grade, string> = {
  again: 'bg-[#ef4444]',
  hard: 'bg-[#f59e0b]',
  good: 'bg-[#10b981]',
  easy: 'bg-[#3b82f6]',
}

/** 各算法对应的评分档位 */
function gradesFor(algorithm: AlgorithmType): Grade[] {
  if (algorithm === 'simple') return ['forget' as Grade, 'familiar' as Grade] as unknown as Grade[]
  // fsrs / custom / sm2 / fixed 全部用 4 档（sm2/fixed 的 easy 仍映射为 familiar）
  return ['again', 'hard', 'good', 'easy']
}

/** simple 模式只显示 会/不会 两档 */
function gradesForAlg(algorithm: AlgorithmType): { grade: Grade; label: string }[] {
  if (algorithm === 'simple') {
    return [
      { grade: 'again', label: '不会' },
      { grade: 'good', label: '会' },
    ]
  }
  return GRADES.map((g) => ({ grade: g.value, label: g.label }))
}

function fmtInterval(days: number): string {
  if (days < 1) return `${Math.round(days * 1440)}分`
  if (days < 30) return `${days.toFixed(1)}天`
  if (days < 365) return `${Math.round(days / 30)}月`
  return `${(days / 365).toFixed(1)}年`
}

export function ReviewScoreBar({ onScore, disabled, algorithm = 'fsrs', previews }: ReviewScoreBarProps) {
  const [picked, setPicked] = React.useState<Grade | null>(null)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const handlePick = (grade: Grade) => {
    setPicked(grade)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setPicked(null), 260)
    onScore(grade)
  }

  const items = gradesForAlg(algorithm)
  const previewMap = new Map<Grade, GradePreview>(previews?.map((p) => [p.grade, p]) ?? [])

  return (
    <div className={cn('flex gap-2', items.length === 2 ? 'gap-3' : 'gap-2')}>
      {items.map(({ grade, label }) => {
        const prev = previewMap.get(grade)
        return (
          <button
            key={grade}
            type="button"
            disabled={disabled}
            aria-label={label}
            onClick={() => handlePick(grade)}
            className={cn(
              'flex h-16 flex-1 flex-col items-center justify-center rounded-xl text-white transition-all',
              'active:scale-95 disabled:pointer-events-none disabled:opacity-50',
              GRADE_BG[grade],
              picked === grade && 'scale-95 brightness-90',
              items.length === 2 && 'h-14',
            )}
          >
            <span className="text-base font-semibold">{label}</span>
            {prev && (
              <span className="mt-0.5 text-[10px] font-medium opacity-90">{fmtInterval(prev.interval)}后</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// 抑制未用导入
void gradesFor
