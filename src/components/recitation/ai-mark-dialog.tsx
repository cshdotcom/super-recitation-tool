'use client'

// AiMarkDialog — 「是否开启 AI 自动标记？」询问弹窗。
// 导入链路（上传文件/粘贴文本/拍照/图片识别 → 创建前询问）与编辑器工具栏共用。
// 四个能力开关（挖空 / 重点标注 / 智能图表富媒体 / 智能排版）→ onConfirm(options)。
// 用户点「跳过」→ onSkip()。

import * as React from 'react'
import { Braces, Highlighter, LayoutList, Loader2, PenLine, Sparkles } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'

export interface AiMarkOptions {
  cloze: boolean
  highlight: boolean
  media: boolean
  /** 智能排版：AI 整理混乱的段落/标题层级/列表（原文逐字保留） */
  format?: boolean
}

export const AI_MARK_DEFAULTS: AiMarkOptions = { cloze: true, highlight: true, media: true, format: false }

export function AiMarkDialog({
  open,
  onOpenChange,
  onConfirm,
  onSkip,
  defaultOptions,
  defaultFormat = false,
  loading = false,
  context = 'import',
  contentPreview,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 确认：按当前开关执行 AI 自动标记 */
  onConfirm: (options: AiMarkOptions) => void
  /** 跳过：不标记直接继续 */
  onSkip: () => void
  defaultOptions?: AiMarkOptions
  /** 智能排版开关默认值（导入链路来自设置 aiAutoFormat，默认关） */
  defaultFormat?: boolean
  loading?: boolean
  /** import=导入创建时询问；editor=编辑器内手动触发 */
  context?: 'import' | 'editor'
  /** 内容预览（导入场景展示将标记的内容开头） */
  contentPreview?: string
}) {
  const [cloze, setCloze] = React.useState(defaultOptions?.cloze ?? true)
  const [highlight, setHighlight] = React.useState(defaultOptions?.highlight ?? true)
  const [media, setMedia] = React.useState(defaultOptions?.media ?? true)
  const [format, setFormat] = React.useState(defaultFormat)

  // 每次打开重置为默认
  React.useEffect(() => {
    if (open) {
      setCloze(defaultOptions?.cloze ?? true)
      setHighlight(defaultOptions?.highlight ?? true)
      setMedia(defaultOptions?.media ?? true)
      setFormat(defaultFormat)
    }
  }, [open, defaultOptions?.cloze, defaultOptions?.highlight, defaultOptions?.media, defaultFormat])

  const anyOn = cloze || highlight || media || format

  const items: {
    key: keyof AiMarkOptions
    icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
    label: string
    desc: string
    value: boolean
    set: (v: boolean) => void
  }[] = [
    {
      key: 'cloze',
      icon: Braces,
      label: '自动挖空',
      desc: 'AI 挑选关键片段标记 {{挖空}}，生成背诵填空',
      value: cloze,
      set: setCloze,
    },
    {
      key: 'highlight',
      icon: Highlighter,
      label: '重点标注',
      desc: '荧光重点 / 下划线 / 红色强调 / 加粗，标注核心论点',
      value: highlight,
      set: setHighlight,
    },
    {
      key: 'media',
      icon: PenLine,
      label: '智能图表（AI 绘制）',
      desc: 'AI 用富媒体绘制：思维导图梳理结构 / 对比表格 / 数理公式',
      value: media,
      set: setMedia,
    },
    {
      key: 'format',
      icon: LayoutList,
      label: '智能排版',
      desc: 'AI 整理混乱的段落、标题层级与列表（原文逐字保留）',
      value: format,
      set: setFormat,
    },
  ]

  return (
    <Dialog open={open} onOpenChange={(o) => !loading && onOpenChange(o)}>
      <DialogContent className="max-w-sm rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Sparkles className="size-4 text-emerald-600" aria-hidden />
            {context === 'import' ? '要开启 AI 自动标记吗？' : 'AI 自动标记'}
          </DialogTitle>
          <DialogDescription>
            {context === 'import'
              ? '创建时让 AI 自动完成编辑器标记，之后仍可手动调整'
              : '对当前内容执行 AI 标记（可撤销）'}
          </DialogDescription>
        </DialogHeader>

        {contentPreview && context === 'import' && (
          <p className="max-h-16 overflow-hidden rounded-xl bg-muted/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            {contentPreview.slice(0, 80)}
            {contentPreview.length > 80 ? '…' : ''}
          </p>
        )}

        <div className="flex flex-col gap-2">
          {items.map((it) => {
            const Icon = it.icon
            return (
              <label
                key={it.key}
                className="flex items-center gap-3 rounded-xl border border-border p-3 transition-colors has-[button[data-state=checked]]:border-emerald-500/50"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                  <Icon className="size-4 text-foreground/80" strokeWidth={1.75} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{it.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                    {it.desc}
                  </span>
                </span>
                <Switch checked={it.value} onCheckedChange={it.set} disabled={loading} />
              </label>
            )
          })}
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            className="flex-1 rounded-full text-muted-foreground"
            disabled={loading}
            onClick={onSkip}
          >
            {context === 'import' ? '跳过，直接导入' : '取消'}
          </Button>
          <Button
            className="flex-[1.4] rounded-full bg-emerald-600 font-semibold text-white hover:bg-emerald-700"
            disabled={loading || !anyOn}
            onClick={() => onConfirm({ cloze, highlight, media, format })}
          >
            {loading ? (
              <>
                <Loader2 className="size-4 animate-spin" /> AI 正在标记…
              </>
            ) : (
              <>
                <Sparkles className="size-4" /> 开始 AI 标记
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
