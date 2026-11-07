'use client'

import * as React from 'react'
import {
  Braces,
  Cpu,
  Database,
  Globe,
  KeyRound,
  Loader2,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

import type { CardData, SettingsData, ToolToggles } from '@/lib/types'
import { cn } from '@/lib/utils'
import { BottomSheet } from '@/components/recitation/bottom-sheet'
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
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (open && settings) {
      setAiDraft({
        aiProvider: settings.aiProvider,
        aiBaseURL: settings.aiBaseURL,
        aiApiKey: settings.aiApiKey,
        aiModel: settings.aiModel,
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

  const handleExportAll = () => {
    const blob = new Blob([JSON.stringify({ cards }, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '超级背书-全部数据.json'
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
