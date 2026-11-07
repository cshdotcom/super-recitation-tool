'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  Sparkles,
  Wand2,
  Eraser,
  Eye,
  EyeOff,
  Pencil,
  Check,
  Volume2,
  Mic,
  FileQuestion,
  GraduationCap,
  MessageCircleQuestion,
  Network,
  RotateCcw,
  Loader2,
} from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import type { CardData, ClozeStyle, SettingsData } from '@/lib/types'
import { ruleCloze } from '@/lib/cloze'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Card } from '@/components/ui/card'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ClozeRenderer } from './cloze-renderer'

interface StudyViewProps {
  card: CardData
  settings: SettingsData
  onUpdate: (card: CardData) => void
  onEdit: () => void
  onOpenTool: (toolKey: string) => void
  onChangeStyle: (style: ClozeStyle) => void
  onToggleShowAnswers: (show: boolean) => void
}

type ClozeMode = 'ai' | 'manual' | 'rule'

const TOOL_BUTTONS: {
  key: keyof SettingsData['tools']
  label: string
  icon: typeof Volume2
}[] = [
  { key: 'tts', label: '朗读文本', icon: Volume2 },
  { key: 'asr', label: '录音背书', icon: Mic },
  { key: 'quiz', label: 'AI出题', icon: FileQuestion },
  { key: 'supervise', label: 'AI督背', icon: GraduationCap },
  { key: 'ask', label: 'AI问问', icon: MessageCircleQuestion },
  { key: 'mindmap', label: '思维导图', icon: Network },
]

export function StudyView({
  card,
  settings,
  onUpdate,
  onEdit,
  onOpenTool,
  onChangeStyle,
  onToggleShowAnswers,
}: StudyViewProps) {
  const [title, setTitle] = React.useState(card.title)
  const [content] = React.useState(card.content)
  const [keywords, setKeywords] = React.useState<string[]>(card.keywords)
  const [clozeMode, setClozeMode] = React.useState<ClozeMode>('ai')
  const [revealed, setRevealed] = React.useState<Set<number>>(new Set())
  const [localStyle, setLocalStyle] = React.useState<ClozeStyle>(
    settings.clozeStyle,
  )
  const [showAnswers, setShowAnswers] = React.useState<boolean>(
    settings.showAnswers,
  )
  const [ruleStep, setRuleStep] = React.useState<string>('3')
  const [aiClozeLoading, setAiClozeLoading] = React.useState(false)
  const [titleLoading, setTitleLoading] = React.useState(false)
  const [editingTitle, setEditingTitle] = React.useState(false)

  // Sync when card identity changes
  React.useEffect(() => {
    setTitle(card.title)
    setKeywords(card.keywords)
    setRevealed(new Set())
  }, [card.id, card.title, card.keywords, card.content])

  // Sync settings -> local when settings change
  React.useEffect(() => {
    setLocalStyle(settings.clozeStyle)
    setShowAnswers(settings.showAnswers)
  }, [settings.clozeStyle, settings.showAnswers])

  // Persist keyword changes to parent (debounce handled by parent; we just call onUpdate)
  const persistCard = React.useCallback(
    (nextKeywords: string[], nextTitle?: string) => {
      onUpdate({
        ...card,
        title: nextTitle ?? title,
        keywords: nextKeywords,
      })
    },
    [card, onUpdate, title],
  )

  const handleToggleKeyword = (word: string) => {
    const w = word.trim()
    if (!w) return
    const exists = keywords.some(
      (k) => k.trim() === w,
    )
    const next = exists
      ? keywords.filter((k) => k.trim() !== w)
      : [...keywords, w]
    setKeywords(next)
    persistCard(next)
  }

  const handleReveal = (idx: number) => {
    setRevealed((prev) => {
      const next = new Set(prev)
      next.add(idx)
      return next
    })
  }

  const handleResetRevealed = () => {
    setRevealed(new Set())
    toast.success('已重置揭示状态')
  }

  const handleAiCloze = async () => {
    if (!content.trim()) {
      toast.error('内容为空，无法挖空')
      return
    }
    setAiClozeLoading(true)
    const tid = toast.loading('AI 正在分析重点词…')
    try {
      const res = await fetch('/api/cloze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '挖空失败')
      }
      const data = (await res.json()) as { keywords: string[] }
      const kws = (data.keywords || []).map((k) => k.trim()).filter(Boolean)
      const deduped = Array.from(new Set(kws))
      setKeywords(deduped)
      setRevealed(new Set())
      persistCard(deduped)
      toast.success(`已挖空 ${deduped.length} 个词`, { id: tid })
    } catch (err) {
      toast.error(
        'AI 挖空失败：' + (err instanceof Error ? err.message : '未知错误'),
        { id: tid },
      )
    } finally {
      setAiClozeLoading(false)
    }
  }

  const handleRuleCloze = () => {
    const step = Number(ruleStep)
    if (!step || step < 2) {
      toast.error('请选择有效的步长')
      return
    }
    const kws = ruleCloze(content, step)
    setKeywords(kws)
    setRevealed(new Set())
    persistCard(kws)
    toast.success(`已挖空 ${kws.length} 个词`)
  }

  const handleClearKeywords = () => {
    setKeywords([])
    setRevealed(new Set())
    persistCard([])
    toast.success('已清空挖空')
  }

  const handleAiTitle = async () => {
    if (!content.trim()) {
      toast.error('内容为空')
      return
    }
    setTitleLoading(true)
    try {
      const res = await fetch('/api/title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '生成失败')
      }
      const data = (await res.json()) as { title: string }
      const t = (data.title || '').trim()
      if (t) {
        setTitle(t)
        persistCard(keywords, t)
        toast.success('已生成标题')
      }
    } catch (err) {
      toast.error(
        '生成标题失败：' + (err instanceof Error ? err.message : '未知错误'),
      )
    } finally {
      setTitleLoading(false)
    }
  }

  const handleTitleSave = () => {
    setEditingTitle(false)
    const t = title.trim() || '未命名卡片'
    setTitle(t)
    onUpdate({ ...card, title: t })
  }

  const handleStyleChange = (val: ClozeStyle) => {
    setLocalStyle(val)
    onChangeStyle(val)
  }

  const handleShowAnswersChange = (val: boolean) => {
    setShowAnswers(val)
    onToggleShowAnswers(val)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
    >
      <Card className="gap-0">
        {/* Header */}
        <div className="flex flex-col gap-3 p-4 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              {editingTitle ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleTitleSave()
                      if (e.key === 'Escape') {
                        setTitle(card.title)
                        setEditingTitle(false)
                      }
                    }}
                    onBlur={handleTitleSave}
                    autoFocus
                    className="h-9 text-lg font-semibold"
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={handleTitleSave}
                    aria-label="保存标题"
                  >
                    <Check className="size-4 text-emerald-600" />
                  </Button>
                </div>
              ) : (
                <h2
                  className="cursor-text text-lg font-semibold leading-tight sm:text-xl"
                  onClick={() => setEditingTitle(true)}
                  title="点击编辑标题"
                >
                  {title || '未命名卡片'}
                </h2>
              )}
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary" className="font-normal">
                  {content.length} 字
                </Badge>
                <Badge
                  variant="secondary"
                  className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                >
                  挖空 {keywords.length}
                </Badge>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleAiTitle}
                disabled={titleLoading || !content.trim()}
                className="text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-700"
              >
                {titleLoading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                AI 标题
              </Button>
              <Button variant="ghost" size="sm" onClick={onEdit}>
                <Pencil className="size-4" /> 编辑内容
              </Button>
            </div>
          </div>
        </div>

        {/* Toolbar */}
        <div className="mx-4 mb-4 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-2 sm:mx-6">
          <ToggleGroup
            type="single"
            value={clozeMode}
            onValueChange={(v) => v && setClozeMode(v as ClozeMode)}
            variant="outline"
            size="sm"
          >
            <ToggleGroupItem value="ai" aria-label="AI 挖空">
              <Sparkles className="size-3.5" /> AI挖空
            </ToggleGroupItem>
            <ToggleGroupItem value="manual" aria-label="手动挖空">
              <Wand2 className="size-3.5" /> 手动挖空
            </ToggleGroupItem>
            <ToggleGroupItem value="rule" aria-label="规则挖空">
              <Eraser className="size-3.5" /> 规则挖空
            </ToggleGroupItem>
          </ToggleGroup>

          {clozeMode === 'ai' && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleAiCloze}
              disabled={aiClozeLoading}
              className="border-emerald-500/40 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300"
            >
              {aiClozeLoading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              AI 快速挖空
            </Button>
          )}

          {clozeMode === 'rule' && (
            <div className="flex items-center gap-2">
              <Select value={ruleStep} onValueChange={setRuleStep}>
                <SelectTrigger size="sm" className="h-8 w-[110px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="2">每 2 词</SelectItem>
                  <SelectItem value="3">每 3 词</SelectItem>
                  <SelectItem value="4">每 4 词</SelectItem>
                  <SelectItem value="5">每 5 词</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRuleCloze}
              >
                应用
              </Button>
            </div>
          )}

          {clozeMode === 'manual' && (
            <span className="text-xs text-muted-foreground">
              点击文中词语即可挖空 / 取消
            </span>
          )}

          <Separator orientation="vertical" className="mx-1 h-5" />

          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">显示答案</Label>
            <Switch
              checked={showAnswers}
              onCheckedChange={handleShowAnswersChange}
              aria-label="显示答案"
            />
            {showAnswers ? (
              <Eye className="size-3.5 text-muted-foreground" />
            ) : (
              <EyeOff className="size-3.5 text-muted-foreground" />
            )}
          </div>

          <Separator orientation="vertical" className="mx-1 h-5" />

          <ToggleGroup
            type="single"
            value={localStyle}
            onValueChange={(v) => v && handleStyleChange(v as ClozeStyle)}
            variant="outline"
            size="sm"
          >
            <ToggleGroupItem value="underline" aria-label="下划线风格">
              下划线
            </ToggleGroupItem>
            <ToggleGroupItem value="highlight" aria-label="高亮风格">
              高亮
            </ToggleGroupItem>
          </ToggleGroup>

          <Button
            variant="ghost"
            size="sm"
            onClick={handleClearKeywords}
            disabled={keywords.length === 0}
            className="text-muted-foreground"
          >
            <Eraser className="size-3.5" /> 清空挖空
          </Button>

          <Separator orientation="vertical" className="mx-1 h-5" />

          <div className="flex flex-wrap items-center gap-1">
            {TOOL_BUTTONS.filter((t) => settings.tools[t.key]).map((t) => {
              const Icon = t.icon
              return (
                <Button
                  key={t.key}
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenTool(t.key)}
                >
                  <Icon className="size-3.5" /> {t.label}
                </Button>
              )
            })}
          </div>
        </div>

        {/* Content */}
        <div className="px-4 pb-6 sm:px-6">
          <div className="rounded-xl bg-background p-4">
            <ClozeRenderer
              content={content}
              keywords={keywords}
              style={localStyle}
              showAnswers={showAnswers}
              manualMode={clozeMode === 'manual'}
              revealed={revealed}
              onToggleKeyword={handleToggleKeyword}
              onReveal={handleReveal}
            />
          </div>

          {revealed.size > 0 && !showAnswers && (
            <div className="mt-4 flex items-center justify-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleResetRevealed}
                className="text-muted-foreground"
              >
                <RotateCcw className="size-3.5" /> 重置已揭示 ({revealed.size})
              </Button>
            </div>
          )}
        </div>
      </Card>
    </motion.div>
  )
}
