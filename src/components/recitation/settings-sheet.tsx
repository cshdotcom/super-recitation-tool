'use client'

import * as React from 'react'
import { toast } from 'sonner'

import type { SettingsData, ToolToggles, ClozeStyle } from '@/lib/types'
import { DEFAULT_TOOLS } from '@/lib/types'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'

interface SettingsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: SettingsData | null
  onSave: (settings: SettingsData) => void
}

const TOOL_LABELS: { key: keyof ToolToggles; label: string }[] = [
  { key: 'tts', label: '朗读文本' },
  { key: 'asr', label: '录音背书' },
  { key: 'quiz', label: 'AI 出题' },
  { key: 'supervise', label: 'AI 督背' },
  { key: 'ask', label: 'AI 问问' },
  { key: 'mindmap', label: '思维导图' },
]

export function SettingsSheet({
  open,
  onOpenChange,
  settings,
  onSave,
}: SettingsSheetProps) {
  const [draft, setDraft] = React.useState<SettingsData | null>(settings)

  React.useEffect(() => {
    setDraft(settings)
  }, [settings])

  if (!draft) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle>设置</SheetTitle>
            <SheetDescription>正在加载设置…</SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>
    )
  }

  const update = <K extends keyof SettingsData>(
    key: K,
    value: SettingsData[K],
  ) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  const updateTool = (key: keyof ToolToggles, value: boolean) => {
    setDraft((prev) =>
      prev
        ? { ...prev, tools: { ...prev.tools, [key]: value } }
        : prev,
    )
  }

  const handleSave = () => {
    onSave(draft)
  }

  const handleReset = () => {
    setDraft({
      ...draft,
      clozeStyle: 'underline',
      showAnswers: false,
      tools: { ...DEFAULT_TOOLS },
      aiProvider: 'zai',
      aiBaseURL: '',
      aiApiKey: '',
      aiModel: '',
    })
    toast.info('已恢复默认设置（未保存）')
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col gap-0 sm:max-w-md">
        <SheetHeader className="border-b p-4">
          <SheetTitle>设置</SheetTitle>
          <SheetDescription>
            调整挖空样式、工具开关与 AI 模型
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-4">
          {/* 显示设置 */}
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">显示设置</h3>
            <div className="flex flex-col gap-2">
              <Label className="text-xs text-muted-foreground">挖空风格</Label>
              <RadioGroup
                value={draft.clozeStyle}
                onValueChange={(v) => update('clozeStyle', v as ClozeStyle)}
                className="grid grid-cols-2 gap-2"
              >
                <label
                  htmlFor="style-underline"
                  className="flex cursor-pointer items-center gap-2 rounded-md border p-3 text-sm has-[[data-state=checked]]:border-emerald-500/50 has-[[data-state=checked]]:bg-emerald-500/10"
                >
                  <RadioGroupItem id="style-underline" value="underline" />
                  <span className="border-b-2 border-dashed border-foreground/40 px-1">
                    下划线
                  </span>
                </label>
                <label
                  htmlFor="style-highlight"
                  className="flex cursor-pointer items-center gap-2 rounded-md border p-3 text-sm has-[[data-state=checked]]:border-emerald-500/50 has-[[data-state=checked]]:bg-emerald-500/10"
                >
                  <RadioGroupItem id="style-highlight" value="highlight" />
                  <span className="rounded-full bg-emerald-500/15 px-2 text-emerald-700 dark:text-emerald-300">
                    高亮
                  </span>
                </label>
              </RadioGroup>
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="flex flex-col">
                <Label className="text-sm">默认显示答案</Label>
                <span className="text-xs text-muted-foreground">
                  打开后所有挖空默认揭示
                </span>
              </div>
              <Switch
                checked={draft.showAnswers}
                onCheckedChange={(v) => update('showAnswers', v)}
              />
            </div>
          </section>

          <Separator className="my-4" />

          {/* 背书工具 */}
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">背书工具</h3>
            <div className="flex flex-col gap-1">
              {TOOL_LABELS.map((t) => (
                <div
                  key={t.key}
                  className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-accent"
                >
                  <Label className="text-sm">{t.label}</Label>
                  <Switch
                    checked={draft.tools[t.key]}
                    onCheckedChange={(v) => updateTool(t.key, v)}
                  />
                </div>
              ))}
            </div>
          </section>

          <Separator className="my-4" />

          {/* AI 模型 */}
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">AI 模型</h3>
            <RadioGroup
              value={draft.aiProvider}
              onValueChange={(v) =>
                update('aiProvider', v as SettingsData['aiProvider'])
              }
              className="grid gap-2"
            >
              <label
                htmlFor="provider-zai"
                className="flex cursor-pointer items-start gap-2 rounded-md border p-3 has-[[data-state=checked]]:border-emerald-500/50 has-[[data-state=checked]]:bg-emerald-500/10"
              >
                <RadioGroupItem
                  id="provider-zai"
                  value="zai"
                  className="mt-0.5"
                />
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">z-ai SDK 默认</span>
                  <span className="text-xs text-muted-foreground">
                    使用内置 z-ai 模型，无需配置
                  </span>
                </div>
              </label>
              <label
                htmlFor="provider-custom"
                className="flex cursor-pointer items-start gap-2 rounded-md border p-3 has-[[data-state=checked]]:border-emerald-500/50 has-[[data-state=checked]]:bg-emerald-500/10"
              >
                <RadioGroupItem
                  id="provider-custom"
                  value="custom"
                  className="mt-0.5"
                />
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">
                    第三方 OpenAI 兼容 API
                  </span>
                  <span className="text-xs text-muted-foreground">
                    适用于文本类 AI（挖空/出题/督背/思维导图）
                  </span>
                </div>
              </label>
            </RadioGroup>

            {draft.aiProvider === 'custom' && (
              <div className="flex flex-col gap-3 rounded-md border bg-muted/20 p-3">
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">
                    Base URL
                  </Label>
                  <Input
                    value={draft.aiBaseURL}
                    onChange={(e) => update('aiBaseURL', e.target.value)}
                    placeholder="https://api.openai.com/v1"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">
                    API Key
                  </Label>
                  <Input
                    type="password"
                    value={draft.aiApiKey}
                    onChange={(e) => update('aiApiKey', e.target.value)}
                    placeholder="sk-..."
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">模型</Label>
                  <Input
                    value={draft.aiModel}
                    onChange={(e) => update('aiModel', e.target.value)}
                    placeholder="gpt-4o-mini"
                  />
                </div>
              </div>
            )}

            <p className="text-xs leading-relaxed text-muted-foreground">
              z-ai SDK 用于图片识别 / 语音朗读 / 语音识别；文本类
              AI（挖空、出题、督背、思维导图）可切换为第三方模型。
            </p>
          </section>
        </div>

        <SheetFooter className="flex-row justify-between gap-2 border-t p-4">
          <Button variant="ghost" size="sm" onClick={handleReset}>
            重置默认
          </Button>
          <Button size="sm" onClick={handleSave} className="rounded-full px-5">
            保存
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
