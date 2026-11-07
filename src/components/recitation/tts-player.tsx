'use client'

import * as React from 'react'
import { Loader2, Play, RotateCcw, Volume2 } from 'lucide-react'
import { toast } from 'sonner'

import { TTS_VOICES } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface TtsPlayerProps {
  text: string
}

export function TtsPlayer({ text }: TtsPlayerProps) {
  const [voice, setVoice] = React.useState<string>('tongtong')
  const [speed, setSpeed] = React.useState<number>(1.0)
  const [loading, setLoading] = React.useState(false)
  const [audioUrl, setAudioUrl] = React.useState<string | null>(null)
  const audioRef = React.useRef<HTMLAudioElement>(null)

  const handlePlay = async () => {
    if (!text.trim()) {
      toast.error('没有可朗读的内容')
      return
    }
    setLoading(true)
    const tid = toast.loading('正在生成语音…')
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, speed }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '生成语音失败')
      }
      const blob = await res.blob()
      if (audioUrl) URL.revokeObjectURL(audioUrl)
      const url = URL.createObjectURL(blob)
      setAudioUrl(url)
      toast.success('语音已生成', { id: tid })
      // auto-play after state updates
      setTimeout(() => {
        audioRef.current?.play().catch(() => {
          /* autoplay blocked; user uses controls */
        })
      }, 80)
    } catch (err) {
      toast.error(
        '语音生成失败：' + (err instanceof Error ? err.message : '未知错误'),
        { id: tid },
      )
    } finally {
      setLoading(false)
    }
  }

  React.useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl)
    }
  }, [audioUrl])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label className="text-sm">语音</Label>
        <Select value={voice} onValueChange={setVoice}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TTS_VOICES.map((v) => (
              <SelectItem key={v.value} value={v.value}>
                {v.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label className="text-sm">语速</Label>
          <span className="text-xs text-muted-foreground">
            {speed.toFixed(1)}x
          </span>
        </div>
        <Slider
          value={[speed]}
          onValueChange={(vals) => setSpeed(vals[0] ?? 1)}
          min={0.5}
          max={2}
          step={0.1}
        />
      </div>

      <Button
        onClick={handlePlay}
        disabled={loading || !text.trim()}
        className="bg-emerald-600 text-white hover:bg-emerald-700"
      >
        {loading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Play className="size-4" />
        )}
        朗读全文
      </Button>

      {audioUrl && (
        <div className="flex flex-col gap-2">
          <audio
            ref={audioRef}
            src={audioUrl}
            controls
            className="w-full"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={handlePlay}
            disabled={loading}
            className="text-muted-foreground"
          >
            <RotateCcw className="size-3.5" /> 重新生成
          </Button>
        </div>
      )}

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Volume2 className="size-3.5" />
        共 {text.length} 字 · 语音由 z-ai SDK 合成
      </div>
    </div>
  )
}
