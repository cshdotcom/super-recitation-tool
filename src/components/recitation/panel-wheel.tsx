'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import { Check, Loader2, RotateCw, Square, Volume2 } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { splitSentences } from '@/lib/sentences'
import { useSettingsLite } from '@/lib/voice-prefs'
import { useQuickTts, VoiceSpeedBar } from '@/components/recitation/tts-player'
import { Button } from '@/components/ui/button'

interface WheelPanelProps {
  content: string
}

// 轮盘抽背：随机抽一句来背
export function WheelPanel({ content }: WheelPanelProps) {
  const settings = useSettingsLite()
  const tts = useQuickTts('wheel', settings)
  const sentences = React.useMemo(() => splitSentences(content), [content])
  const segments = React.useMemo(
    () => sentences.slice(0, 8).map((s, i) => ({ text: s, label: `第${i + 1}句` })),
    [sentences],
  )

  const [rotation, setRotation] = React.useState(0)
  const [spinning, setSpinning] = React.useState(false)
  const [picked, setPicked] = React.useState<number | null>(null)
  const [mastered, setMastered] = React.useState<Set<number>>(new Set())

  React.useEffect(() => {
    setPicked(null)
    setMastered(new Set())
    setRotation(0)
  }, [content])

  if (segments.length === 0) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">内容为空，无法轮盘抽背</div>
    )
  }

  const segAngle = 360 / segments.length

  const gradient = `conic-gradient(${segments
    .map((_, i) => {
      const from = i * segAngle
      const to = (i + 1) * segAngle
      const color = i % 2 === 0 ? '#059669' : '#3f3f46' // emerald-600 / zinc-700
      return `${color} ${from}deg ${to}deg`
    })
    .join(', ')})`

  const spin = () => {
    if (spinning) return
    setSpinning(true)
    setPicked(null)
    const target = Math.floor(Math.random() * segments.length)
    const center = target * segAngle + segAngle / 2
    const final = rotation + 360 * 4 + (360 - center) - (rotation % 360)
    setRotation(final)
    window.setTimeout(() => {
      setPicked(target)
      setSpinning(false)
      toast.info(`抽中了 ${segments[target].label}，来背一背吧！`)
    }, 2700)
  }

  const handleSpeak = () => {
    if (picked === null) return
    if (tts.speaking) {
      tts.stop()
      return
    }
    tts.speak(segments[picked].text)
  }

  const handleMastered = () => {
    if (picked === null) return
    setMastered((prev) => new Set(prev).add(picked))
    toast.success(`已背过 ${segments[picked].label}！`)
  }

  return (
    <div className="flex flex-col items-center gap-5">
      <p className="text-xs text-muted-foreground">
        共 {sentences.length} 句 · 已背过 {mastered.size} 句
      </p>

      {/* wheel */}
      <div className="relative mx-auto size-64">
        {/* pointer */}
        <div
          aria-hidden
          className="absolute -top-1 left-1/2 z-10 size-0 -translate-x-1/2 border-x-[10px] border-x-transparent border-t-[18px] border-t-zinc-800"
        />
        <motion.div
          className="absolute inset-0 rounded-full border-4 border-background shadow-lg"
          style={{ background: gradient }}
          animate={{ rotate: rotation }}
          transition={{ duration: 2.6, ease: [0.16, 0.9, 0.24, 1] }}
        >
          {segments.map((seg, i) => (
            <span
              key={i}
              aria-hidden
              className="absolute left-1/2 top-1/2 text-[11px] font-semibold text-white/95"
              style={{
                transform: `translate(-50%, -50%) rotate(${i * segAngle + segAngle / 2}deg) translateY(-96px) rotate(${-(i * segAngle + segAngle / 2)}deg)`,
              }}
            >
              {seg.label}
            </span>
          ))}
        </motion.div>
        {/* hub */}
        <div className="absolute left-1/2 top-1/2 flex size-16 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full border-4 border-background bg-white text-center shadow">
          <span className="text-[10px] font-bold text-zinc-700">轮盘</span>
          <span className="text-[10px] font-bold text-zinc-700">抽背</span>
        </div>
      </div>

      <Button
        className="h-11 w-full rounded-full bg-primary font-semibold"
        onClick={spin}
        disabled={spinning}
      >
        {spinning ? (
          <>
            <Loader2 className="size-4 animate-spin" /> 转动中…
          </>
        ) : (
          <>
            <RotateCw className="size-4" strokeWidth={1.75} /> 开始抽背
          </>
        )}
      </Button>

      {/* picked sentence */}
      {picked !== null && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full rounded-2xl border border-border bg-card p-4 shadow-sm"
        >
          <div className="flex items-center justify-between">
            <span className="rounded-full bg-emerald-600/10 px-2.5 py-1 text-xs font-semibold text-emerald-600">
              {segments[picked].label}
            </span>
            {mastered.has(picked) && (
              <span className="flex items-center gap-1 text-xs text-emerald-600">
                <Check className="size-3.5" /> 已背过
              </span>
            )}
          </div>
          <p className="mt-3 text-lg font-medium leading-loose">{segments[picked].text}</p>

          {/* 音色/倍速选择（可设为默认） */}
          <div className="mt-3 flex">
            <VoiceSpeedBar context="wheel" pref={tts.pref} onChange={tts.setPref} />
          </div>

          <div className="mt-3 flex gap-2">
            <Button
              variant="outline"
              className="h-10 flex-1 rounded-full"
              onClick={handleSpeak}
            >
              {tts.speaking ? (
                <Square className="size-4" />
              ) : (
                <Volume2 className="size-4" strokeWidth={1.75} />
              )}
              {tts.speaking ? '停止' : '朗读'}
            </Button>
            <Button
              className={cn(
                'h-10 flex-1 rounded-full',
                mastered.has(picked)
                  ? 'bg-muted text-muted-foreground'
                  : 'bg-emerald-600 text-white hover:bg-emerald-700',
              )}
              onClick={handleMastered}
              disabled={mastered.has(picked)}
            >
              <Check className="size-4" strokeWidth={1.75} /> 我背过了
            </Button>
          </div>
        </motion.div>
      )}
    </div>
  )
}
