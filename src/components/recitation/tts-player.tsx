'use client'

import * as React from 'react'
import { Loader2, Play, RotateCcw, Square, Volume2 } from 'lucide-react'
import { toast } from 'sonner'

import type { SettingsData } from '@/lib/types'
import { TTS_VOICES } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const CUSTOM_VOICE_KEY = 'tts-custom-voice'

/** Max chars per utterance — speechSynthesis silently drops long utterances. */
const MAX_CHUNK_LEN = 120

interface TtsPlayerProps {
  text: string
  settings: SettingsData
}

/**
 * Split text into <=120-char chunks, preferring cuts at sentence punctuation.
 */
function splitSpeechChunks(text: string, maxLen = MAX_CHUNK_LEN): string[] {
  const chunks: string[] = []
  let buf = ''
  const push = () => {
    const t = buf.trim()
    if (t) chunks.push(t)
    buf = ''
  }
  for (const ch of text) {
    buf += ch
    if (/[。！？；!?;\n]/.test(ch) || buf.length >= maxLen) push()
  }
  push()
  return chunks
}

/** zh voices first, then alphabetical — stable & readable list. */
function sortVoices(a: SpeechSynthesisVoice, b: SpeechSynthesisVoice): number {
  const az = a.lang.toLowerCase().startsWith('zh') ? 0 : 1
  const bz = b.lang.toLowerCase().startsWith('zh') ? 0 : 1
  if (az !== bz) return az - bz
  return a.name.localeCompare(b.name)
}

export function TtsPlayer({ text, settings }: TtsPlayerProps) {
  const provider = settings.ttsProvider

  // ---- shared ----
  const [speed, setSpeed] = React.useState<number>(1.0)
  const audioRef = React.useRef<HTMLAudioElement>(null)
  const audioUrlRef = React.useRef<string | null>(null)
  const audioTextRef = React.useRef<string | null>(null)
  const [audioUrl, setAudioUrl] = React.useState<string | null>(null)
  const [audioPlaying, setAudioPlaying] = React.useState(false)
  const [loading, setLoading] = React.useState(false)

  // ---- zai / custom ----
  const [voice, setVoice] = React.useState<string>('tongtong')
  const [customVoice, setCustomVoice] = React.useState('')

  // ---- browser ----
  const [voices, setVoices] = React.useState<SpeechSynthesisVoice[]>([])
  const [voiceURI, setVoiceURI] = React.useState<string>('')
  const [speaking, setSpeaking] = React.useState(false)
  const speechGenRef = React.useRef(0)

  // Restore persisted custom voice (SSR-safe).
  React.useEffect(() => {
    setCustomVoice(localStorage.getItem(CUSTOM_VOICE_KEY) || '')
  }, [])

  const persistCustomVoice = (v: string) => {
    setCustomVoice(v)
    try {
      localStorage.setItem(CUSTOM_VOICE_KEY, v)
    } catch {
      /* storage unavailable */
    }
  }

  // Load system voices (async in most browsers) + refresh on voiceschanged.
  React.useEffect(() => {
    if (provider !== 'browser') return
    const synth = window.speechSynthesis
    if (!synth) return
    const load = () => {
      const vs = synth.getVoices()
      if (vs.length > 0) setVoices([...vs].sort(sortVoices))
    }
    load()
    synth.addEventListener('voiceschanged', load)
    return () => {
      synth.removeEventListener('voiceschanged', load)
    }
  }, [provider])

  // Default to the first zh voice once the list arrives.
  React.useEffect(() => {
    if (provider !== 'browser') return
    if (voices.length === 0) return
    if (voiceURI && voices.some((v) => v.voiceURI === voiceURI)) return
    const zh = voices.find((v) => v.lang.toLowerCase().startsWith('zh'))
    setVoiceURI((zh ?? voices[0]).voiceURI)
  }, [voices, provider, voiceURI])

  // Cancel any browser speech on unmount / provider switch.
  React.useEffect(() => {
    return () => {
      speechGenRef.current += 1
      window.speechSynthesis?.cancel()
    }
  }, [provider])

  // Revoke the audio blob URL on unmount.
  React.useEffect(() => {
    return () => {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
    }
  }, [])

  // Keep audio playbackRate in sync with the slider (live 倍速播放调整).
  React.useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = speed
    }
  }, [speed, audioUrl])

  // ---- server synthesis (zai / custom) ----
  const generate = async () => {
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
        body: JSON.stringify({
          text,
          voice: provider === 'custom' ? customVoice.trim() || undefined : voice,
          speed,
          provider,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '生成语音失败')
      }
      const blob = await res.blob()
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
      const url = URL.createObjectURL(blob)
      audioUrlRef.current = url
      audioTextRef.current = text
      setAudioUrl(url)
      toast.success('语音已生成', { id: tid })
      // auto-play after state updates
      setTimeout(() => {
        if (audioRef.current) {
          audioRef.current.playbackRate = speed
          audioRef.current.play().catch(() => {
            /* autoplay blocked; user uses controls */
          })
        }
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

  // ---- browser synthesis (Web Speech API) ----
  const speakBrowser = () => {
    const synth = window.speechSynthesis
    if (!synth) {
      toast.error('当前浏览器不支持语音合成，请使用 Chrome / Edge')
      return
    }
    if (!text.trim()) {
      toast.error('没有可朗读的内容')
      return
    }
    const chunks = splitSpeechChunks(text)
    if (chunks.length === 0) {
      toast.error('没有可朗读的内容')
      return
    }
    synth.cancel()
    const gen = ++speechGenRef.current
    const selected = voices.find((v) => v.voiceURI === voiceURI) ?? null
    chunks.forEach((chunk, i) => {
      const u = new SpeechSynthesisUtterance(chunk)
      if (selected) {
        u.voice = selected
        u.lang = selected.lang
      } else {
        u.lang = 'zh-CN'
      }
      u.rate = speed
      u.pitch = 1
      if (i === chunks.length - 1) {
        u.onend = () => {
          if (speechGenRef.current === gen) setSpeaking(false)
        }
        u.onerror = () => {
          if (speechGenRef.current === gen) setSpeaking(false)
        }
      }
      synth.speak(u)
    })
    setSpeaking(true)
  }

  const stopBrowser = () => {
    speechGenRef.current += 1 // invalidate old onend handlers
    window.speechSynthesis?.cancel()
    setSpeaking(false)
  }

  // ---- main button: 朗读全文 / 停止 ----
  const handleMain = () => {
    if (provider === 'browser') {
      if (speaking) stopBrowser()
      else speakBrowser()
      return
    }
    if (audioPlaying) {
      audioRef.current?.pause()
      return
    }
    if (audioUrl && audioTextRef.current === text) {
      // replay the already generated audio for the same text
      audioRef.current?.play().catch(() => {
        /* ignore */
      })
      return
    }
    generate()
  }

  const isStop =
    provider === 'browser' ? speaking : audioPlaying && !loading

  const footerHint =
    provider === 'zai'
      ? '语音由 z-ai SDK 合成'
      : provider === 'custom'
        ? '语音由第三方 API 合成'
        : '浏览器系统语音合成'

  return (
    <div className="flex flex-col gap-4">
      {/* voice picker */}
      {provider === 'zai' && (
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
      )}

      {provider === 'custom' && (
        <div className="flex flex-col gap-2">
          <Label className="text-sm">音色</Label>
          <Input
            value={customVoice}
            onChange={(e) => persistCustomVoice(e.target.value)}
            placeholder="音色名，如 alloy / nova / 清心"
          />
        </div>
      )}

      {provider === 'browser' && (
        <div className="flex flex-col gap-2">
          <Label className="text-sm">系统语音</Label>
          {voices.length > 0 ? (
            <Select value={voiceURI} onValueChange={setVoiceURI}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择系统语音" />
              </SelectTrigger>
              <SelectContent>
                {voices.map((v) => (
                  <SelectItem key={v.voiceURI} value={v.voiceURI}>
                    {v.name} ({v.lang})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="text-xs text-muted-foreground">
              正在加载系统语音列表…
            </div>
          )}
          <div className="text-xs text-muted-foreground">
            浏览器合成 · 系统语音
          </div>
        </div>
      )}

      {/* speed */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label className="text-sm">倍速</Label>
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
        {provider === 'browser' && (
          <div className="text-xs text-muted-foreground">
            语速对下一段朗读生效
          </div>
        )}
      </div>

      {/* main button */}
      <Button
        onClick={handleMain}
        disabled={loading || !text.trim()}
        className="bg-emerald-600 text-white hover:bg-emerald-700"
      >
        {loading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : isStop ? (
          <Square className="size-4" />
        ) : (
          <Play className="size-4" />
        )}
        {isStop ? '停止' : '朗读全文'}
      </Button>

      {/* generated audio (server providers) */}
      {provider !== 'browser' && audioUrl && (
        <div className="flex flex-col gap-2">
          <audio
            ref={audioRef}
            src={audioUrl}
            controls
            className="w-full"
            onPlay={() => setAudioPlaying(true)}
            onPause={() => setAudioPlaying(false)}
            onEnded={() => setAudioPlaying(false)}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={generate}
            disabled={loading}
            className="text-muted-foreground"
          >
            <RotateCcw className="size-3.5" /> 重新生成
          </Button>
        </div>
      )}

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Volume2 className="size-3.5" />
        共 {text.length} 字 · {footerHint}
      </div>
    </div>
  )
}
