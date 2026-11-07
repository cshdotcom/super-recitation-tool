'use client'

import * as React from 'react'
import { useTheme } from 'next-themes'
import {
  ALargeSmall,
  BookText,
  Braces,
  Check,
  ChevronRight,
  Circle,
  Copy,
  Download,
  FileOutput,
  FileText,
  Moon,
  Sparkles,
  Sun,
} from 'lucide-react'
import { toast } from 'sonner'

import type { CardData, ClozeStyle, PageMode, SettingsData } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useLocalStorage } from '@/lib/use-local-storage'
import { BottomSheet } from '@/components/recitation/bottom-sheet'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'

export type ClozeTemplate = 'sentence-start' | 'numbers' | 'rule3'

interface MoreSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  card: CardData
  settings: SettingsData
  onChangeSettings: (patch: Partial<SettingsData>) => void
  onRuleCloze: (step: number) => void
  onTemplateCloze: (template: ClozeTemplate) => void
  onAiCloze: () => void
  onManualMode: () => void
  onBrushMode: () => void
}

type Tab = 'cloze' | 'read' | 'font' | 'export'

const TABS: {
  key: Tab
  label: string
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
}[] = [
  { key: 'cloze', label: '挖空操作', icon: Sparkles },
  { key: 'read', label: '阅读设置', icon: BookText },
  { key: 'font', label: '字体设置', icon: ALargeSmall },
  { key: 'export', label: '导出', icon: FileOutput },
]

// ---------- tiny segmented control ----------
function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string; icon?: React.ComponentType<{ className?: string; strokeWidth?: number }> }[]
  value: T
  onChange: (v: T) => void
  ariaLabel?: string
}) {
  return (
    <div className="flex rounded-xl bg-muted p-1" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => {
        const Icon = o.icon
        const active = value === o.value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs transition-colors',
              active
                ? 'bg-background font-medium text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {Icon && <Icon className="size-3.5" strokeWidth={1.75} />}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// ---------- expandable row ----------
function ActionRow({
  title,
  subtitle,
  expanded,
  onToggle,
  children,
}: {
  title: string
  subtitle: string
  expanded: boolean
  onToggle: () => void
  children?: React.ReactNode
}) {
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left transition-colors hover:bg-accent/50"
      >
        <div className="min-w-0">
          <p className="text-sm font-bold">{title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <ChevronRight
          className={cn(
            'size-4 shrink-0 text-muted-foreground/60 transition-transform',
            expanded && 'rotate-90',
          )}
          strokeWidth={1.75}
        />
      </button>
      {expanded && children && <div className="px-4 pb-3.5">{children}</div>}
    </div>
  )
}

export function MoreSheet({
  open,
  onOpenChange,
  card,
  settings,
  onChangeSettings,
  onRuleCloze,
  onTemplateCloze,
  onAiCloze,
  onManualMode,
  onBrushMode,
}: MoreSheetProps) {
  const { theme, setTheme } = useTheme()
  const [tab, setTab] = React.useState<Tab>('cloze')
  const [ruleExpanded, setRuleExpanded] = React.useState(false)
  const [templateExpanded, setTemplateExpanded] = React.useState(false)
  const [fontSizeDraft, setFontSizeDraft] = React.useState(settings.fontSize)
  const [showQuickBar, setShowQuickBar] = useLocalStorage<boolean>('showQuickBar', true)
  const [showToolBar, setShowToolBar] = useLocalStorage<boolean>('showToolBar', true)

  React.useEffect(() => {
    if (open) {
      setTab('cloze')
      setRuleExpanded(false)
      setTemplateExpanded(false)
      setFontSizeDraft(settings.fontSize)
    }
  }, [open, settings.fontSize])

  // Debounced font size persistence.
  React.useEffect(() => {
    if (!open) return
    if (fontSizeDraft === settings.fontSize) return
    const t = setTimeout(() => {
      onChangeSettings({ fontSize: fontSizeDraft })
    }, 400)
    return () => clearTimeout(t)
     
  }, [fontSizeDraft, open])

  const downloadFile = (name: string, content: string, type: string) => {
    const blob = new Blob([content], { type })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(card.content)
      toast.success('全文已复制到剪贴板')
    } catch {
      toast.error('复制失败，请手动选择文本复制')
    }
  }

  const handleExportTxt = () => {
    downloadFile(`${card.title || '背书卡'}.txt`, card.content, 'text/plain;charset=utf-8')
    toast.success('已导出 TXT 文件')
  }

  const handleExportJson = async () => {
    try {
      const res = await fetch('/api/cards')
      if (!res.ok) throw new Error('获取数据失败')
      const data = await res.json()
      downloadFile(
        `超级背书-全部数据.json`,
        JSON.stringify(data, null, 2),
        'application/json',
      )
      toast.success('已导出 JSON 数据')
    } catch (err) {
      toast.error('导出失败：' + (err instanceof Error ? err.message : '未知错误'))
    }
  }

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="更多" className="h-[80vh]">
      {/* tab selector: 4 icon cards */}
      <div className="mt-4 grid grid-cols-4 gap-2">
        {TABS.map((t) => {
          const Icon = t.icon
          const active = tab === t.key
          return (
            <button
              key={t.key}
              type="button"
              aria-pressed={active}
              onClick={() => setTab(t.key)}
              className={cn(
                'flex flex-col items-center gap-1.5 rounded-2xl border py-3 text-xs transition-colors',
                active
                  ? 'border-emerald-600/40 bg-emerald-500/10 font-semibold text-emerald-600'
                  : 'border-border bg-card text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="size-5" strokeWidth={1.5} />
              {t.label}
            </button>
          )
        })}
      </div>

      <div className="mt-4 flex-1 overflow-y-auto pb-6">
        {/* ---------------- 挖空操作 ---------------- */}
        {tab === 'cloze' && (
          <div className="space-y-4">
            <p className="px-1 text-xs font-medium text-muted-foreground">批量挖空</p>
            <div className="rounded-2xl border border-border bg-card">
              <ActionRow
                title="规则挖空"
                subtitle="按照一定规则批量挖空"
                expanded={ruleExpanded}
                onToggle={() => setRuleExpanded((v) => !v)}
              >
                <div className="grid grid-cols-4 gap-2">
                  {[2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => {
                        setRuleExpanded(false)
                        onRuleCloze(n)
                      }}
                      className="rounded-xl border border-border bg-background py-2 text-xs text-muted-foreground transition-colors hover:border-emerald-600/40 hover:text-emerald-600"
                    >
                      隔{n}词
                    </button>
                  ))}
                </div>
              </ActionRow>
              <ActionRow
                title="模版挖空"
                subtitle="按照模版挖空"
                expanded={templateExpanded}
                onToggle={() => setTemplateExpanded((v) => !v)}
              >
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setTemplateExpanded(false)
                      onTemplateCloze('sentence-start')
                    }}
                    className="rounded-xl border border-border bg-background py-2 text-xs text-muted-foreground transition-colors hover:border-emerald-600/40 hover:text-emerald-600"
                  >
                    句首挖空
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTemplateExpanded(false)
                      onTemplateCloze('numbers')
                    }}
                    className="rounded-xl border border-border bg-background py-2 text-xs text-muted-foreground transition-colors hover:border-emerald-600/40 hover:text-emerald-600"
                  >
                    数字挖空
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTemplateExpanded(false)
                      onTemplateCloze('rule3')
                    }}
                    className="rounded-xl border border-border bg-background py-2 text-xs text-muted-foreground transition-colors hover:border-emerald-600/40 hover:text-emerald-600"
                  >
                    每隔3词
                  </button>
                </div>
              </ActionRow>
              <button
                type="button"
                onClick={onAiCloze}
                className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left transition-colors hover:bg-accent/50"
              >
                <div>
                  <p className="text-sm font-bold">AI快速挖空</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">AI智能分析关键点挖空</p>
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" strokeWidth={1.75} />
              </button>
            </div>

            <p className="px-1 text-xs font-medium text-muted-foreground">手动挖空</p>
            <div className="rounded-2xl border border-border bg-card">
              <button
                type="button"
                onClick={onManualMode}
                className="flex w-full items-center justify-between gap-3 border-b border-border/60 px-4 py-3.5 text-left transition-colors last:border-b-0 hover:bg-accent/50"
              >
                <div>
                  <p className="text-sm font-bold">手动挖空</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">双击文本快捷挖空</p>
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" strokeWidth={1.75} />
              </button>
              <button
                type="button"
                onClick={onBrushMode}
                className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left transition-colors hover:bg-accent/50"
              >
                <div>
                  <p className="text-sm font-bold">挖空刷</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">快速滑选挖空</p>
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" strokeWidth={1.75} />
              </button>
            </div>

            <p className="px-1 text-xs font-medium text-muted-foreground">挖空设置</p>
            <div className="rounded-2xl border border-border bg-card">
              <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3.5">
                <div>
                  <p className="text-sm font-bold">展示挖空</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">默认显示所有挖空答案</p>
                </div>
                <Switch
                  checked={settings.showAnswers}
                  onCheckedChange={(v) => onChangeSettings({ showAnswers: v })}
                  aria-label="展示挖空"
                  className="data-[state=checked]:bg-emerald-600"
                />
              </div>
              <div className="px-4 py-3.5">
                <p className="text-sm font-bold">挖空样式</p>
                <div className="mt-2.5">
                  <Segmented<ClozeStyle>
                    ariaLabel="挖空样式"
                    value={settings.clozeStyle}
                    onChange={(v) => onChangeSettings({ clozeStyle: v })}
                    options={[
                      { value: 'circle', label: '圈圈' },
                      { value: 'underline', label: '下划线' },
                    ]}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ---------------- 阅读设置 ---------------- */}
        {tab === 'read' && (
          <div className="space-y-4">
            <div className="rounded-2xl border border-border bg-card">
              <div className="border-b border-border/60 px-4 py-3.5">
                <p className="text-sm font-bold">阅读模式</p>
                <div className="mt-2.5">
                  <Segmented<'system' | 'light' | 'dark'>
                    ariaLabel="阅读模式"
                    value={(theme as 'system' | 'light' | 'dark') ?? 'system'}
                    onChange={setTheme}
                    options={[
                      { value: 'system', label: '跟随', icon: Circle },
                      { value: 'light', label: '日间', icon: Sun },
                      { value: 'dark', label: '夜间', icon: Moon },
                    ]}
                  />
                </div>
              </div>
              <div className="px-4 py-3.5">
                <p className="text-sm font-bold">翻页方式</p>
                <div className="mt-2.5">
                  <Segmented<PageMode>
                    ariaLabel="翻页方式"
                    value={settings.pageMode}
                    onChange={(v) => onChangeSettings({ pageMode: v })}
                    options={[
                      { value: 'scroll', label: '上下滑动' },
                      { value: 'paged', label: '左右滑动' },
                    ]}
                  />
                </div>
              </div>
            </div>

            <p className="px-1 text-xs font-medium text-muted-foreground">阅读页底部功能栏</p>
            <div className="rounded-2xl border border-border bg-card">
              <div className="border-b border-border/60 px-4 py-3.5">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-bold">显示快捷编辑栏</p>
                  <Switch
                    checked={showQuickBar}
                    onCheckedChange={setShowQuickBar}
                    aria-label="显示快捷编辑栏"
                    className="data-[state=checked]:bg-emerald-600"
                  />
                </div>
                {showQuickBar && (
                  <div className="no-scrollbar mt-3 flex gap-2 overflow-hidden opacity-60">
                    {['AI快速分块', 'AI快速挖空', '涂鸦', '挖空刷', '手动挖空', '规则挖空'].map((l) => (
                      <span
                        key={l}
                        className="shrink-0 rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground"
                      >
                        {l}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="px-4 py-3.5">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-bold">显示背书工具栏</p>
                  <Switch
                    checked={showToolBar}
                    onCheckedChange={setShowToolBar}
                    aria-label="显示背书工具栏"
                    className="data-[state=checked]:bg-emerald-600"
                  />
                </div>
                {showToolBar && (
                  <div className="mt-3 flex items-center gap-4 opacity-60">
                    {['录音背书', 'AI出题', '思维导图', '朗读文本', '背书工具'].map((l) => (
                      <span key={l} className="flex flex-col items-center gap-1 text-[10px] text-muted-foreground">
                        <span className="flex size-8 items-center justify-center rounded-lg border border-border">
                          <Check className="size-3.5" strokeWidth={1.5} />
                        </span>
                        {l}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ---------------- 字体设置 ---------------- */}
        {tab === 'font' && (
          <div className="space-y-4">
            <div className="rounded-2xl border border-border bg-card px-4 py-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold">字号</p>
                <span className="text-xs text-muted-foreground">{fontSizeDraft} px</span>
              </div>
              <Slider
                value={[fontSizeDraft]}
                min={12}
                max={32}
                step={1}
                onValueChange={(vals) => setFontSizeDraft(vals[0] ?? settings.fontSize)}
                className="mt-4"
                aria-label="字号"
              />
              <div className="mt-4 rounded-xl bg-muted/50 px-4 py-3">
                <p
                  className="leading-relaxed text-zinc-800 dark:text-zinc-200"
                  style={{ fontSize: `${fontSizeDraft}px` }}
                >
                  Aa 这是正文字号预览，背诵内容将以此大小显示。
                </p>
              </div>
            </div>
            <p className="px-1 text-xs text-muted-foreground">设置会自动保存</p>
          </div>
        )}

        {/* ---------------- 导出 ---------------- */}
        {tab === 'export' && (
          <div className="space-y-2.5">
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="flex w-full items-center gap-3 rounded-2xl border border-border bg-card px-4 py-4 text-left transition-colors hover:bg-accent/50"
            >
              <span className="flex size-10 items-center justify-center rounded-xl bg-muted">
                <Copy className="size-5 text-foreground/70" strokeWidth={1.5} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold">复制全文</span>
                <span className="block text-xs text-muted-foreground">复制背书卡全文到剪贴板</span>
              </span>
              <ChevronRight className="size-4 text-muted-foreground/60" strokeWidth={1.75} />
            </button>

            <button
              type="button"
              onClick={handleExportTxt}
              className="flex w-full items-center gap-3 rounded-2xl border border-border bg-card px-4 py-4 text-left transition-colors hover:bg-accent/50"
            >
              <span className="flex size-10 items-center justify-center rounded-xl bg-muted">
                <FileText className="size-5 text-foreground/70" strokeWidth={1.5} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold">导出 TXT</span>
                <span className="block text-xs text-muted-foreground">下载当前背书卡的纯文本文件</span>
              </span>
              <ChevronRight className="size-4 text-muted-foreground/60" strokeWidth={1.75} />
            </button>

            <button
              type="button"
              onClick={() => void handleExportJson()}
              className="flex w-full items-center gap-3 rounded-2xl border border-border bg-card px-4 py-4 text-left transition-colors hover:bg-accent/50"
            >
              <span className="flex size-10 items-center justify-center rounded-xl bg-muted">
                <Braces className="size-5 text-foreground/70" strokeWidth={1.5} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold">导出 JSON 数据</span>
                <span className="block text-xs text-muted-foreground">下载全部背书卡的 JSON 备份</span>
              </span>
              <ChevronRight className="size-4 text-muted-foreground/60" strokeWidth={1.75} />
            </button>

            <div className="flex items-center gap-1.5 px-1 pt-2 text-[11px] text-muted-foreground">
              <Download className="size-3" /> 所有数据存储在本地 SQLite 数据库中
            </div>
          </div>
        )}
      </div>
    </BottomSheet>
  )
}
