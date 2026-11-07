'use client'

import * as React from 'react'
import { toast } from 'sonner'

import type { SettingsData, ToolToggles } from '@/lib/types'
import { cn } from '@/lib/utils'
import { BottomSheet } from '@/components/recitation/bottom-sheet'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'

interface ToolTogglesSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: SettingsData
  onChangeSettings: (patch: Partial<SettingsData>) => void
}

const TOOL_ITEMS: { key: keyof ToolToggles; label: string; desc: string }[] = [
  { key: 'tts', label: '朗读文本', desc: 'TTS 朗读全文或选中段落' },
  { key: 'quiz', label: 'AI出题', desc: '根据课文生成填空、选择、简答题' },
  { key: 'supervise', label: 'AI督背', desc: 'AI 老师逐句引导背诵' },
  { key: 'asr', label: '录音背书', desc: '录音并打分，检测背诵准确率' },
  { key: 'mindmap', label: '思维导图', desc: 'AI 梳理课文知识结构' },
  { key: 'ask', label: 'AI问问', desc: '对课文内容自由提问' },
  { key: 'earback', label: '耳返背书', desc: '逐句朗读 + 跟读对比' },
  { key: 'copywrite', label: '摹写', desc: '默写句子并逐字检查' },
  { key: 'wheel', label: '轮盘抽背', desc: '随机抽取一句来背诵' },
]

// 背书工具开关（自定义编辑，Screenshot E style rows + emerald switches）
export function ToolTogglesSheet({
  open,
  onOpenChange,
  settings,
  onChangeSettings,
}: ToolTogglesSheetProps) {
  const [draft, setDraft] = React.useState<ToolToggles>(settings.tools)

  React.useEffect(() => {
    if (open) setDraft(settings.tools)
  }, [open, settings.tools])

  const dirty = TOOL_ITEMS.some((t) => draft[t.key] !== settings.tools[t.key])

  const handleSave = () => {
    // Send the FULL tools object so quick-edit keys stay unchanged.
    onChangeSettings({ tools: draft })
    toast.success('背书工具已更新')
    onOpenChange(false)
  }

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="自定义编辑">
      <div className="mt-4 flex-1 space-y-2.5 overflow-y-auto pb-2">
        {TOOL_ITEMS.map((t) => (
          <div
            key={t.key}
            className={cn(
              'flex items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3.5 transition-colors',
              draft[t.key] && 'border-emerald-600/30',
            )}
          >
            <div className="min-w-0">
              <p className="text-sm font-bold">{t.label}</p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{t.desc}</p>
            </div>
            <Switch
              checked={draft[t.key]}
              onCheckedChange={(v) => setDraft((prev) => ({ ...prev, [t.key]: v }))}
              aria-label={`开关：${t.label}`}
              className="data-[state=checked]:bg-emerald-600"
            />
          </div>
        ))}
      </div>

      <div className="sticky bottom-0 mt-3 bg-background pb-2 pt-2">
        <Button
          className="h-11 w-full rounded-full bg-primary font-semibold"
          onClick={handleSave}
          disabled={!dirty}
        >
          保存
        </Button>
        <p className="mt-1.5 text-center text-[11px] text-muted-foreground/70">
          开启的工具将出现在背书工具栏与工具面板中
        </p>
      </div>
    </BottomSheet>
  )
}
