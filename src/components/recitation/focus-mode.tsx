'use client'

import * as React from 'react'
import { Eye, EyeOff, Pause, Play, Timer, X } from 'lucide-react'
import { toast } from 'sonner'

import type { CardData } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface FocusModeProps {
  card: CardData
  onExit: () => void
}

const PRESETS = [15, 25, 45, 60]

function fmtMMSS(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const RING_SIZE = 264
const RING_RADIUS = 120
const RING_C = 2 * Math.PI * RING_RADIUS

/**
 * 专注模式 — fullscreen distraction-free countdown overlay.
 * Phases: setup (time selection) -> running (dark immersive ring) -> exit.
 */
export function FocusMode({ card, onExit }: FocusModeProps) {
  const [phase, setPhase] = React.useState<'setup' | 'running'>('setup')
  const [preset, setPreset] = React.useState<number>(25)
  const [customMin, setCustomMin] = React.useState('')
  const [total, setTotal] = React.useState(0) // seconds
  const [left, setLeft] = React.useState(0) // seconds remaining
  const [paused, setPaused] = React.useState(false)
  const [confirmEnd, setConfirmEnd] = React.useState(false)
  const [showText, setShowText] = React.useState(false)

  // Ticking persists across re-renders via refs (endTime based, drift-free).
  const ivRef = React.useRef<ReturnType<typeof setInterval> | null>(null)
  const endAtRef = React.useRef(0)
  const leftRef = React.useRef(0)
  const hideTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearIv = React.useCallback(() => {
    if (ivRef.current) {
      clearInterval(ivRef.current)
      ivRef.current = null
    }
  }, [])

  React.useEffect(() => {
    return () => {
      clearIv()
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    }
  }, [clearIv])

  const tick = React.useCallback(() => {
    const remaining = Math.max(0, Math.round((endAtRef.current - Date.now()) / 1000))
    leftRef.current = remaining
    setLeft(remaining)
    if (remaining <= 0) {
      clearIv()
      toast.success('专注完成！')
      onExit()
    }
  }, [clearIv, onExit])

  const start = React.useCallback(
    (minutes: number) => {
      const secs = Math.max(60, Math.round(minutes * 60))
      setTotal(secs)
      setLeft(secs)
      leftRef.current = secs
      endAtRef.current = Date.now() + secs * 1000
      setPaused(false)
      setConfirmEnd(false)
      setShowText(false)
      setPhase('running')
      clearIv()
      ivRef.current = setInterval(tick, 1000)
    },
    [clearIv, tick],
  )

  const beginFromSetup = () => {
    const raw = customMin.trim()
    if (raw) {
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 1 || n > 180) {
        toast.error('请输入 1 - 180 之间的分钟数')
        return
      }
      start(Math.round(n))
      return
    }
    start(preset)
  }

  const togglePause = () => {
    if (paused) {
      // resume: recompute the end time from the remaining seconds
      endAtRef.current = Date.now() + leftRef.current * 1000
      clearIv()
      ivRef.current = setInterval(tick, 1000)
      setPaused(false)
    } else {
      leftRef.current = Math.max(0, Math.round((endAtRef.current - Date.now()) / 1000))
      setLeft(leftRef.current)
      clearIv()
      setPaused(true)
    }
  }

  // 看原文：点按显示 5 秒后自动隐藏
  const toggleReveal = () => {
    if (showText) {
      setShowText(false)
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
      return
    }
    setShowText(true)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => setShowText(false), 5000)
  }

  // ---------------- setup screen ----------------
  if (phase === 'setup') {
    return (
      <div
        role="dialog"
        aria-label="专注模式"
        className="fixed inset-0 z-[60] flex flex-col bg-background"
      >
        <div className="flex h-14 shrink-0 items-center justify-between px-3">
          <Button
            variant="ghost"
            size="icon"
            aria-label="关闭"
            onClick={onExit}
            className="text-foreground/70"
          >
            <X className="size-5" strokeWidth={1.75} />
          </Button>
          <span className="text-sm font-bold">专注模式</span>
          <span className="size-10" aria-hidden />
        </div>

        <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6 pb-10">
          <div className="text-center">
            <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-emerald-500/10">
              <Timer className="size-8 text-emerald-600" strokeWidth={1.5} />
            </div>
            <h2 className="mt-4 text-xl font-bold">选择专注时长</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              《{card.title}》 · 沉浸式背书，中途不看手机
            </p>
          </div>

          <div className="grid w-full max-w-sm grid-cols-2 gap-3" role="radiogroup" aria-label="专注时长">
            {PRESETS.map((m) => {
              const active = !customMin.trim() && preset === m
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    setPreset(m)
                    setCustomMin('')
                  }}
                  className={cn(
                    'flex flex-col items-center rounded-3xl border py-5 transition-all',
                    active
                      ? 'border-emerald-600 bg-emerald-500/10 shadow-md shadow-emerald-600/10'
                      : 'border-border bg-card hover:bg-accent/50',
                  )}
                >
                  <span
                    className={cn(
                      'text-4xl font-bold tabular-nums',
                      active ? 'text-emerald-600' : 'text-foreground',
                    )}
                  >
                    {m}
                  </span>
                  <span className="mt-1 text-xs text-muted-foreground">分钟</span>
                </button>
              )
            })}
          </div>

          <div className="w-full max-w-sm">
            <div className="flex items-center gap-2">
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={180}
                value={customMin}
                onChange={(e) => setCustomMin(e.target.value)}
                placeholder="自定义分钟数（1-180）"
                aria-label="自定义分钟数"
                className="h-12 flex-1 rounded-full text-center"
              />
            </div>
            <Button
              onClick={beginFromSetup}
              className="mt-4 h-12 w-full rounded-full bg-primary text-base font-semibold hover:bg-primary/90"
            >
              开始专注
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // ---------------- running screen ----------------
  const elapsed = Math.max(0, total - left)
  const pct = total > 0 ? Math.min(1, left / total) : 0

  return (
    <div
      role="dialog"
      aria-label="专注进行中"
      className="fixed inset-0 z-[60] flex flex-col bg-zinc-950 text-zinc-50"
    >
      {/* top */}
      <div className="flex h-14 shrink-0 items-center justify-center px-6">
        <p className="truncate text-sm text-zinc-400">
          专注中 · 《{card.title}》
        </p>
      </div>

      {/* ring */}
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6">
        <div className="relative" style={{ width: RING_SIZE, height: RING_SIZE }}>
          <svg
            width={RING_SIZE}
            height={RING_SIZE}
            viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
            className="-rotate-90"
            aria-hidden
          >
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              className="text-zinc-800"
              strokeWidth={10}
            />
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              className={cn('transition-[stroke-dashoffset] duration-1000 ease-linear', paused ? 'text-zinc-500' : 'text-emerald-500')}
              strokeWidth={10}
              strokeLinecap="round"
              strokeDasharray={RING_C}
              strokeDashoffset={RING_C * (1 - pct)}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-5xl font-bold tabular-nums tracking-wider">
              {fmtMMSS(left)}
            </span>
            <span className="mt-2 text-xs text-zinc-400">
              {paused ? '已暂停' : '保持专注'}
            </span>
          </div>
        </div>

        {/* hidden / blurred content preview */}
        <div className="w-full max-w-sm">
          <div className="relative max-h-28 overflow-hidden rounded-2xl bg-white/5 px-4 py-3">
            <p
              className={cn(
                'text-sm leading-relaxed text-zinc-300 transition-all',
                !showText && 'blur-md select-none',
              )}
              aria-hidden={!showText}
            >
              {card.content}
            </p>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-white/5 to-transparent" />
          </div>
          <button
            type="button"
            onClick={toggleReveal}
            className="mx-auto mt-2.5 flex items-center gap-1.5 rounded-full bg-white/10 px-3.5 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-white/15"
            aria-pressed={showText}
          >
            {showText ? (
              <>
                <EyeOff className="size-3.5" /> 隐藏原文
              </>
            ) : (
              <>
                <Eye className="size-3.5" /> 看原文（显示 5 秒）
              </>
            )}
          </button>
        </div>
      </div>

      {/* controls */}
      <div className="shrink-0 px-6 pb-10">
        {confirmEnd ? (
          <div className="mx-auto flex w-full max-w-sm flex-col gap-2 rounded-3xl bg-white/5 p-4">
            <p className="text-center text-sm font-semibold">
              确定要结束专注吗？
            </p>
            <p className="text-center text-xs text-zinc-400">
              已专注 {fmtMMSS(elapsed)}，坚持就是胜利
            </p>
            <div className="mt-1 flex gap-2">
              <Button
                variant="outline"
                className="h-11 flex-1 rounded-full border-white/20 bg-transparent text-zinc-100 hover:bg-white/10 hover:text-white"
                onClick={() => setConfirmEnd(false)}
              >
                继续专注
              </Button>
              <Button
                className="h-11 flex-1 rounded-full bg-red-500 text-white hover:bg-red-500/90"
                onClick={onExit}
              >
                结束退出
              </Button>
            </div>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-sm gap-3">
            <Button
              variant="outline"
              className="h-12 flex-1 rounded-full border-white/20 bg-transparent text-zinc-100 hover:bg-white/10 hover:text-white"
              onClick={togglePause}
            >
              {paused ? (
                <>
                  <Play className="size-4" /> 继续
                </>
              ) : (
                <>
                  <Pause className="size-4" /> 暂停
                </>
              )}
            </Button>
            <Button
              variant="outline"
              className="h-12 flex-1 rounded-full border-red-500/40 bg-transparent text-red-400 hover:bg-red-500/10 hover:text-red-300"
              onClick={() => setConfirmEnd(true)}
            >
              结束
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
