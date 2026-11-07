'use client'

import * as React from 'react'
import {
  Braces,
  ChevronRight,
  Cpu,
  Database,
  Globe,
  KeyRound,
  Loader2,
  Mic,
  Palette,
  Trash2,
  Volume2,
} from 'lucide-react'
import { toast } from 'sonner'

import type {
  CardData,
  SettingsData,
  ToolToggles,
  VoicePref,
  VoiceProvider,
} from '@/lib/types'
import { TTS_VOICES, VOICE_CONTEXTS } from '@/lib/types'
import { cn } from '@/lib/utils'
import { clampSpeed, saveVoicePref } from '@/lib/voice-prefs'
import { BottomSheet } from '@/components/recitation/bottom-sheet'
import { ThemePicker } from '@/components/recitation/more-sheet'
import { VoiceSpeedBar, type QuickTtsPref } from '@/components/recitation/tts-player'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

interface SettingsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: SettingsData | null
  cards: CardData[]
  onChangeSettings: (patch: Partial<SettingsData>) => void
  onClearAll: () => Promise<void> | void
}

const QUICK_TOGGLES: { key: keyof ToolToggles; label: string; desc: string }[] = [
  { key: 'aiChunk', label: 'AI快速分块', desc: 'AI 将正文智能分段记忆' },
  { key: 'aiCloze', label: 'AI快速挖空', desc: 'AI 智能分析关键点挖空' },
  { key: 'doodle', label: '涂鸦', desc: '在正文上自由绘制笔迹' },
  { key: 'brush', label: '挖空刷', desc: '快速滑选词语挖空' },
  { key: 'manualCloze', label: '手动挖空', desc: '双击文本快捷挖空' },
  { key: 'ruleCloze', label: '规则挖空', desc: '按照一定规则批量挖空' },
]

const TOOL_TOGGLES: { key: keyof ToolToggles; label: string; desc: string }[] = [
  { key: 'tts', label: '朗读文本', desc: 'TTS 朗读全文' },
  { key: 'quiz', label: 'AI出题', desc: '生成填空 / 选择 / 简答题' },
  { key: 'supervise', label: 'AI督背', desc: 'AI 老师引导背诵' },
  { key: 'asr', label: '录音背书', desc: '录音识别并打分' },
  { key: 'mindmap', label: '思维导图', desc: 'AI 梳理知识结构' },
  { key: 'ask', label: 'AI问问', desc: '自由提问课文内容' },
  { key: 'earback', label: '耳返背书', desc: '逐句朗读 + 跟读对比' },
  { key: 'copywrite', label: '摹写', desc: '默写并逐字检查' },
  { key: 'wheel', label: '轮盘抽背', desc: '随机抽句背诵' },
]

// ---------- 各功能默认音色 ----------

const VOICE_CTX_LABELS: Record<string, string> = {
  reader: 'AI朗读',
  tts: '朗读文本',
  asr: '背诵识别',
  supervise: 'AI督背',
  quiz: '出题',
  ask: 'AI问问',
  earback: '磨耳朵',
  copywrite: '默写',
}

function seedTtsDraft(pref?: VoicePref): QuickTtsPref {
  const p = pref?.tts
  const provider = p?.provider ?? 'zai'
  return {
    provider,
    voice:
      provider === 'zai'
        ? p?.voice && TTS_VOICES.some((v) => v.value === p.voice)
          ? p.voice
          : 'tongtong'
        : p?.voice ?? '',
    speed: clampSpeed(p?.speed ?? 1),
    voiceURI: p?.voiceURI ?? '',
  }
}

function seedAsrDraft(pref?: VoicePref): { provider: VoiceProvider; lang: string } {
  return {
    provider: pref?.asr?.provider ?? 'zai',
    lang: pref?.asr?.lang ?? 'zh-CN',
  }
}

function prefSummary(pref?: VoicePref): string {
  if (!pref?.tts && !pref?.asr) return '未设置 · 跟随全局'
  if (pref.asr) {
    const p = pref.asr
    const engine =
      p.provider === 'browser' ? '浏览器' : p.provider === 'custom' ? '第三方' : 'AI云端'
    const lang =
      p.lang === 'en-US'
        ? ' · English'
        : p.lang === 'auto'
          ? ' · 中英混合'
          : p.lang && p.lang !== 'zh-CN'
            ? ` · ${p.lang}`
            : ''
    return `${engine}${lang}`
  }
  const p = pref.tts
  if (!p) return '未设置 · 跟随全局'
  const voice =
    p.provider === 'zai'
      ? TTS_VOICES.find((v) => v.value === p.voice)?.label.split('·')[0]?.trim() ??
        p.voice
      : p.provider === 'custom'
        ? p.voice || '第三方音色'
        : '浏览器语音'
  return `${voice} · ${p.speed}x`
}

/** One expandable row in 「各功能默认音色」. */
function VoiceDefaultRow({
  ctx,
  label,
  saved,
  onSaved,
}: {
  ctx: string
  label: string
  saved?: VoicePref
  onSaved: (ctx: string, pref: VoicePref) => void
}) {
  const isAsr = ctx === 'asr'
  const [open, setOpen] = React.useState(false)
  const [ttsDraft, setTtsDraft] = React.useState<QuickTtsPref>(() => seedTtsDraft(saved))
  const [asrDraft, setAsrDraft] = React.useState(() => seedAsrDraft(saved))
  const [asrSaving, setAsrSaving] = React.useState(false)

  // Re-seed drafts from the saved pref each time the row expands.
  React.useEffect(() => {
    if (!open) return
    setTtsDraft(seedTtsDraft(saved))
    setAsrDraft(seedAsrDraft(saved))
  }, [open, saved])

  const handleAsrSave = async () => {
    setAsrSaving(true)
    const ok = await saveVoicePref(ctx, {
      asr: {
        provider: asrDraft.provider,
        ...(asrDraft.provider === 'browser' ? { lang: asrDraft.lang } : {}),
      },
    })
    setAsrSaving(false)
    if (ok) {
      onSaved(ctx, {
        asr: {
          provider: asrDraft.provider,
          ...(asrDraft.provider === 'browser' ? { lang: asrDraft.lang } : {}),
        },
      })
    }
  }

  const handleTtsSaved = (p: QuickTtsPref) => {
    onSaved(ctx, {
      tts: {
        provider: p.provider,
        voice: p.provider === 'browser' ? '' : p.voice.trim(),
        speed: p.speed,
        ...(p.provider === 'browser' ? { voiceURI: p.voiceURI } : {}),
      },
    })
  }

  return (
    <div className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50"
      >
        <div className="min-w-0">
          <p className="text-sm font-bold">{label}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {prefSummary(saved)}
          </p>
        </div>
        <ChevronRight
          className={cn(
            'size-4 shrink-0 text-muted-foreground/60 transition-transform',
            open && 'rotate-90',
          )}
          strokeWidth={1.75}
        />
      </button>
      {open && (
        <div className="px-4 pb-4">
          {isAsr ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Label className="shrink-0 text-xs text-muted-foreground">引擎</Label>
                <Select
                  value={asrDraft.provider}
                  onValueChange={(v) =>
                    setAsrDraft((d) => ({ ...d, provider: v as VoiceProvider }))
                  }
                >
                  <SelectTrigger className="h-8 flex-1 rounded-lg text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="zai">AI云端（z-ai）</SelectItem>
                    <SelectItem value="browser">浏览器内置</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {asrDraft.provider === 'browser' && (
                <div className="flex items-center gap-2">
                  <Label className="shrink-0 text-xs text-muted-foreground">语言</Label>
                  <Select
                    value={asrDraft.lang}
                    onValueChange={(v) => setAsrDraft((d) => ({ ...d, lang: v }))}
                  >
                    <SelectTrigger className="h-8 flex-1 rounded-lg text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="zh-CN">中文普通话</SelectItem>
                      <SelectItem value="en-US">English (US)</SelectItem>
                      <SelectItem value="auto">中英混合（自动）</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={asrSaving}
                onClick={() => void handleAsrSave()}
                className="h-8 w-full rounded-full text-xs"
              >
                {asrSaving && <Loader2 className="size-3.5 animate-spin" />}
                保存为默认
              </Button>
            </div>
          ) : (
            <VoiceSpeedBar
              inline
              context={ctx}
              pref={ttsDraft}
              onChange={setTtsDraft}
              onSaved={handleTtsSaved}
              saveLabel="保存为默认"
            />
          )}
        </div>
      )}
    </div>
  )
}

// Reusable radio row for the voice provider pickers.
function VoiceProviderOptions({
  prefix,
  value,
  onChange,
  includeBrowser,
}: {
  prefix: string
  value: VoiceProvider
  onChange: (v: VoiceProvider) => void
  includeBrowser: boolean
}) {
  const options: { value: VoiceProvider; label: string }[] = [
    { value: 'zai', label: 'z-ai SDK（内置默认）' },
    { value: 'custom', label: '第三方 OpenAI 兼容 API' },
    ...(includeBrowser
      ? ([{ value: 'browser', label: '浏览器 Web Speech（免费，用系统语音）' }] as const)
      : []),
  ]
  return (
    <RadioGroup
      value={value}
      onValueChange={(v) => onChange(v as VoiceProvider)}
      className="gap-2.5"
    >
      {options.map((opt) => (
        <div key={opt.value} className="flex items-center gap-2.5">
          <RadioGroupItem value={opt.value} id={`${prefix}-${opt.value}`} />
          <Label
            htmlFor={`${prefix}-${opt.value}`}
            className="cursor-pointer text-sm font-medium"
          >
            {opt.label}
          </Label>
        </div>
      ))}
    </RadioGroup>
  )
}

function ToggleRow({
  label,
  desc,
  checked,
  onCheckedChange,
}: {
  label: string
  desc: string
  checked: boolean
  onCheckedChange: (v: boolean) => void
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3.5 transition-colors',
        checked && 'border-emerald-600/30',
      )}
    >
      <div className="min-w-0">
        <p className="text-sm font-bold">{label}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{desc}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={`开关：${label}`}
        className="data-[state=checked]:bg-emerald-600"
      />
    </div>
  )
}

export function SettingsSheet({
  open,
  onOpenChange,
  settings,
  cards,
  onChangeSettings,
  onClearAll,
}: SettingsSheetProps) {
  // AI model draft (saved via 保存 button)
  const [aiDraft, setAiDraft] = React.useState({
    aiProvider: 'zai' as 'zai' | 'custom',
    aiBaseURL: '',
    aiApiKey: '',
    aiModel: '',
  })
  // TTS / ASR voice drafts (saved via 保存语音设置 button)
  const [voiceDraft, setVoiceDraft] = React.useState({
    ttsProvider: 'zai' as VoiceProvider,
    ttsBaseURL: '',
    ttsApiKey: '',
    ttsModel: '',
    asrProvider: 'zai' as VoiceProvider,
    asrBaseURL: '',
    asrApiKey: '',
    asrModel: '',
  })
  const [saving, setSaving] = React.useState(false)
  const [savingVoice, setSavingVoice] = React.useState(false)
  // Locally-saved per-context voice defaults (refreshes the summaries right
  // away; the server PATCH happens inside saveVoicePref).
  const [savedVoicePrefs, setSavedVoicePrefs] = React.useState<Record<string, VoicePref>>({})

  React.useEffect(() => {
    if (open && settings) {
      setAiDraft({
        aiProvider: settings.aiProvider,
        aiBaseURL: settings.aiBaseURL,
        aiApiKey: settings.aiApiKey,
        aiModel: settings.aiModel,
      })
      setVoiceDraft({
        ttsProvider: settings.ttsProvider,
        ttsBaseURL: settings.ttsBaseURL,
        ttsApiKey: settings.ttsApiKey,
        ttsModel: settings.ttsModel,
        asrProvider: settings.asrProvider,
        asrBaseURL: settings.asrBaseURL,
        asrApiKey: settings.asrApiKey,
        asrModel: settings.asrModel,
      })
    }
  }, [open, settings])

  const totalChars = cards.reduce((sum, c) => sum + c.content.length, 0)

  const toggleTool = (key: keyof ToolToggles, v: boolean) => {
    if (!settings) return
    onChangeSettings({ tools: { ...settings.tools, [key]: v } })
  }

  const handleSaveAi = async () => {
    setSaving(true)
    try {
      onChangeSettings({ ...aiDraft })
      toast.success('AI 模型设置已保存')
    } finally {
      setSaving(false)
    }
  }

  const handleSaveVoice = async () => {
    setSavingVoice(true)
    try {
      onChangeSettings({ ...voiceDraft })
      toast.success('语音与识别设置已保存')
    } finally {
      setSavingVoice(false)
    }
  }

  const handleExportAll = () => {
    const blob = new Blob([JSON.stringify({ cards }, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '背书吧-全部数据.json'
    a.click()
    URL.revokeObjectURL(url)
    toast.success('已导出全部数据')
  }

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="设置" className="h-[85vh]">
      {!settings ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> 正在加载设置…
        </div>
      ) : (
        <div className="mt-4 flex-1 space-y-5 overflow-y-auto pb-6">
          {/* ---------- 界面主题 ---------- */}
          <section>
            <p className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
              <Palette className="size-3.5" strokeWidth={1.75} /> 界面主题
            </p>
            <div className="rounded-2xl border border-border bg-card px-4 py-4">
              <ThemePicker
                value={settings.theme}
                onChange={(t) => onChangeSettings({ theme: t })}
              />
              <p className="mt-2.5 px-1 text-[11px] text-muted-foreground/70">已自动保存</p>
            </div>
          </section>

          {/* ---------- 快捷编辑栏 ---------- */}
          <section>
            <p className="mb-2 px-1 text-xs font-medium text-muted-foreground">快捷编辑栏</p>
            <div className="space-y-2.5">
              {QUICK_TOGGLES.map((t) => (
                <ToggleRow
                  key={t.key}
                  label={t.label}
                  desc={t.desc}
                  checked={settings.tools[t.key]}
                  onCheckedChange={(v) => toggleTool(t.key, v)}
                />
              ))}
            </div>
            <p className="mt-1.5 px-1 text-[11px] text-muted-foreground/70">已自动保存</p>
          </section>

          {/* ---------- 背书工具 ---------- */}
          <section>
            <p className="mb-2 px-1 text-xs font-medium text-muted-foreground">背书工具</p>
            <div className="space-y-2.5">
              {TOOL_TOGGLES.map((t) => (
                <ToggleRow
                  key={t.key}
                  label={t.label}
                  desc={t.desc}
                  checked={settings.tools[t.key]}
                  onCheckedChange={(v) => toggleTool(t.key, v)}
                />
              ))}
            </div>
            <p className="mt-1.5 px-1 text-[11px] text-muted-foreground/70">已自动保存</p>
          </section>

          {/* ---------- 存储与数据 ---------- */}
          <section>
            <p className="mb-2 px-1 text-xs font-medium text-muted-foreground">存储与数据</p>
            <div className="rounded-2xl border border-border bg-card px-4 py-4">
              <div className="flex items-center gap-2 text-sm">
                <Database className="size-4 text-muted-foreground" strokeWidth={1.75} />
                <span className="font-medium">
                  SQLite 本地数据库 · 已存 {cards.length} 张卡片 · 共 {totalChars} 字
                </span>
              </div>
              <div className="mt-3 flex flex-col gap-2">
                <Button
                  variant="outline"
                  className="h-10 rounded-full"
                  onClick={handleExportAll}
                >
                  <Braces className="size-4" strokeWidth={1.75} />
                  导出全部数据（JSON 下载）
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      className="h-10 rounded-full border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="size-4" strokeWidth={1.75} />
                      清空全部数据
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent className="rounded-2xl">
                    <AlertDialogHeader>
                      <AlertDialogTitle>清空全部背书卡？</AlertDialogTitle>
                      <AlertDialogDescription>
                        将删除数据库中的全部 {cards.length} 张背书卡，此操作不可撤销。
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>取消</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-white hover:bg-destructive/90"
                        onClick={() => void onClearAll()}
                      >
                        确认清空
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </section>

          {/* ---------- 语音与识别 ---------- */}
          <section>
            <p className="mb-2 px-1 text-xs font-medium text-muted-foreground">语音与识别</p>
            <div className="space-y-3">
              {/* TTS 朗读 */}
              <div className="rounded-2xl border border-border bg-card px-4 py-4">
                <div className="flex items-center gap-2 text-sm font-bold">
                  <Volume2 className="size-4 text-muted-foreground" strokeWidth={1.75} />
                  TTS 朗读
                </div>
                <div className="mt-3">
                  <VoiceProviderOptions
                    prefix="tts-provider"
                    value={voiceDraft.ttsProvider}
                    onChange={(v) => setVoiceDraft((d) => ({ ...d, ttsProvider: v }))}
                    includeBrowser
                  />
                </div>

                {voiceDraft.ttsProvider === 'browser' && (
                  <p className="mt-3 rounded-xl bg-muted/60 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                    使用系统内置语音，无需配置
                  </p>
                )}

                {voiceDraft.ttsProvider === 'custom' && (
                  <div className="mt-4 space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="tts-baseurl" className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Globe className="size-3" /> API Base URL
                      </Label>
                      <Input
                        id="tts-baseurl"
                        value={voiceDraft.ttsBaseURL}
                        onChange={(e) => setVoiceDraft((d) => ({ ...d, ttsBaseURL: e.target.value }))}
                        placeholder="https://api.example.com/v1"
                        className="h-10 rounded-xl"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="tts-apikey" className="flex items-center gap-1 text-xs text-muted-foreground">
                        <KeyRound className="size-3" /> API Key
                      </Label>
                      <Input
                        id="tts-apikey"
                        type="password"
                        value={voiceDraft.ttsApiKey}
                        onChange={(e) => setVoiceDraft((d) => ({ ...d, ttsApiKey: e.target.value }))}
                        placeholder="sk-…"
                        className="h-10 rounded-xl"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="tts-model" className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Cpu className="size-3" /> 模型名称
                      </Label>
                      <Input
                        id="tts-model"
                        value={voiceDraft.ttsModel}
                        onChange={(e) => setVoiceDraft((d) => ({ ...d, ttsModel: e.target.value }))}
                        placeholder="tts-1 / cosyvoice 等"
                        className="h-10 rounded-xl"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* ASR 识别 */}
              <div className="rounded-2xl border border-border bg-card px-4 py-4">
                <div className="flex items-center gap-2 text-sm font-bold">
                  <Mic className="size-4 text-muted-foreground" strokeWidth={1.75} />
                  ASR 识别
                </div>
                <div className="mt-3">
                  <VoiceProviderOptions
                    prefix="asr-provider"
                    value={voiceDraft.asrProvider}
                    onChange={(v) => setVoiceDraft((d) => ({ ...d, asrProvider: v }))}
                    includeBrowser
                  />
                </div>

                {voiceDraft.asrProvider === 'browser' && (
                  <p className="mt-3 rounded-xl bg-muted/60 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                    使用 Chrome/Edge 内置语音识别，需联网
                  </p>
                )}

                {voiceDraft.asrProvider === 'custom' && (
                  <div className="mt-4 space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="asr-baseurl" className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Globe className="size-3" /> API Base URL
                      </Label>
                      <Input
                        id="asr-baseurl"
                        value={voiceDraft.asrBaseURL}
                        onChange={(e) => setVoiceDraft((d) => ({ ...d, asrBaseURL: e.target.value }))}
                        placeholder="https://api.example.com/v1"
                        className="h-10 rounded-xl"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="asr-apikey" className="flex items-center gap-1 text-xs text-muted-foreground">
                        <KeyRound className="size-3" /> API Key
                      </Label>
                      <Input
                        id="asr-apikey"
                        type="password"
                        value={voiceDraft.asrApiKey}
                        onChange={(e) => setVoiceDraft((d) => ({ ...d, asrApiKey: e.target.value }))}
                        placeholder="sk-…"
                        className="h-10 rounded-xl"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="asr-model" className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Cpu className="size-3" /> 模型名称
                      </Label>
                      <Input
                        id="asr-model"
                        value={voiceDraft.asrModel}
                        onChange={(e) => setVoiceDraft((d) => ({ ...d, asrModel: e.target.value }))}
                        placeholder="whisper-1 / paraformer 等"
                        className="h-10 rounded-xl"
                      />
                    </div>
                  </div>
                )}
              </div>

              <Button
                onClick={() => void handleSaveVoice()}
                disabled={savingVoice}
                className="h-10 w-full rounded-full bg-primary font-semibold"
              >
                {savingVoice && <Loader2 className="size-4 animate-spin" />}
                保存语音设置
              </Button>
            </div>
          </section>

          {/* ---------- 各功能默认音色 ---------- */}
          <section>
            <p className="mb-1 px-1 text-xs font-medium text-muted-foreground">各功能默认音色</p>
            <p className="mb-2 px-1 text-[11px] text-muted-foreground/70">
              为每个功能单独设置音色/引擎/倍速，未设置时跟随全局
            </p>
            <div className="rounded-2xl border border-border bg-card">
              {VOICE_CONTEXTS.map((ctx) => (
                <VoiceDefaultRow
                  key={ctx}
                  ctx={ctx}
                  label={VOICE_CTX_LABELS[ctx] ?? ctx}
                  saved={savedVoicePrefs[ctx] ?? settings.voicePrefs?.[ctx]}
                  onSaved={(c, pref) =>
                    setSavedVoicePrefs((prev) => ({ ...prev, [c]: pref }))
                  }
                />
              ))}
            </div>
          </section>

          {/* ---------- AI 模型 ---------- */}
          <section>
            <p className="mb-2 px-1 text-xs font-medium text-muted-foreground">AI 模型</p>
            <div className="rounded-2xl border border-border bg-card px-4 py-4">
              <RadioGroup
                value={aiDraft.aiProvider}
                onValueChange={(v) => setAiDraft((d) => ({ ...d, aiProvider: v as 'zai' | 'custom' }))}
                className="gap-2.5"
              >
                <div className="flex items-center gap-2.5">
                  <RadioGroupItem value="zai" id="provider-zai" />
                  <Label htmlFor="provider-zai" className="cursor-pointer text-sm font-medium">
                    z-ai SDK（内置默认）
                  </Label>
                </div>
                <div className="flex items-center gap-2.5">
                  <RadioGroupItem value="custom" id="provider-custom" />
                  <Label htmlFor="provider-custom" className="cursor-pointer text-sm font-medium">
                    第三方 OpenAI 兼容 API
                  </Label>
                </div>
              </RadioGroup>

              {aiDraft.aiProvider === 'custom' && (
                <div className="mt-4 space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="ai-baseurl" className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Globe className="size-3" /> API Base URL
                    </Label>
                    <Input
                      id="ai-baseurl"
                      value={aiDraft.aiBaseURL}
                      onChange={(e) => setAiDraft((d) => ({ ...d, aiBaseURL: e.target.value }))}
                      placeholder="https://api.example.com/v1"
                      className="h-10 rounded-xl"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ai-apikey" className="flex items-center gap-1 text-xs text-muted-foreground">
                      <KeyRound className="size-3" /> API Key
                    </Label>
                    <Input
                      id="ai-apikey"
                      type="password"
                      value={aiDraft.aiApiKey}
                      onChange={(e) => setAiDraft((d) => ({ ...d, aiApiKey: e.target.value }))}
                      placeholder="sk-…"
                      className="h-10 rounded-xl"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ai-model" className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Cpu className="size-3" /> 模型名称
                    </Label>
                    <Input
                      id="ai-model"
                      value={aiDraft.aiModel}
                      onChange={(e) => setAiDraft((d) => ({ ...d, aiModel: e.target.value }))}
                      placeholder="gpt-4o-mini / deepseek-chat 等"
                      className="h-10 rounded-xl"
                    />
                  </div>
                </div>
              )}

              <Button
                onClick={() => void handleSaveAi()}
                disabled={saving}
                className="mt-4 h-10 w-full rounded-full bg-primary font-semibold"
              >
                {saving && <Loader2 className="size-4 animate-spin" />}
                保存 AI 模型设置
              </Button>
            </div>
          </section>
        </div>
      )}
    </BottomSheet>
  )
}
