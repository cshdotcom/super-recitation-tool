'use client'

import * as React from 'react'
import {
  ArrowLeft,
  Baseline,
  Brush,
  Columns2,
  Eye,
  EyeOff,
  FileQuestion,
  Highlighter,
  LayoutGrid,
  ListTree,
  Loader2,
  Mic,
  MoreHorizontal,
  Network,
  Pencil,
  Settings2,
  Share2,
  Sparkles,
  SquareSlash,
  Volume2,
} from 'lucide-react'
import { toast } from 'sonner'

import type { CardData, SettingsData } from '@/lib/types'
import { cn } from '@/lib/utils'
import { ruleCloze, splitParagraphs } from '@/lib/cloze'
import { todayKey, useLocalStorage } from '@/lib/use-local-storage'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ClozeText } from '@/components/recitation/cloze-text'
import { DoodleCanvas } from '@/components/recitation/doodle-canvas'
import { MoreSheet, type ClozeTemplate } from '@/components/recitation/more-sheet'
import { PlanDialog } from '@/components/recitation/plan-dialog'
import { ShareDialog } from '@/components/recitation/share-dialog'
import { ToolsSheet } from '@/components/recitation/tools-sheet'

type ReaderMode = null | 'chunk' | 'doodle' | 'brush' | 'manual'

interface ReaderViewProps {
  card: CardData
  settings: SettingsData
  onUpdateCard: (next: CardData) => void
  onChangeSettings: (patch: Partial<SettingsData>) => void
  onBack: () => void
  onEditContent: () => void
}

// Split paragraphs into paged-mode pages (~3 paragraphs or ~600 chars each).
function splitPages(paragraphs: string[]): string[] {
  const pages: string[] = []
  let buf: string[] = []
  let len = 0
  for (const p of paragraphs) {
    buf.push(p)
    len += p.length
    if (buf.length >= 3 || len >= 600) {
      pages.push(buf.join('\n'))
      buf = []
      len = 0
    }
  }
  if (buf.length > 0) pages.push(buf.join('\n'))
  return pages.length > 0 ? pages : ['']
}

const QUICK_CHIPS = [
  { key: 'aiChunk', label: 'AI快速分块', icon: Columns2 },
  { key: 'aiCloze', label: 'AI快速挖空', icon: Sparkles },
  { key: 'doodle', label: '涂鸦', icon: Brush },
  { key: 'brush', label: '挖空刷', icon: Highlighter },
  { key: 'manualCloze', label: '手动挖空', icon: Baseline },
  { key: 'ruleCloze', label: '规则挖空', icon: SquareSlash },
] as const

const TOOL_BUTTONS = [
  { key: 'asr', label: '录音背书', icon: Mic },
  { key: 'quiz', label: 'AI出题', icon: FileQuestion },
  { key: 'mindmap', label: '思维导图', icon: Network },
  { key: 'tts', label: '朗读文本', icon: Volume2 },
] as const

export function ReaderView({
  card,
  settings,
  onUpdateCard,
  onChangeSettings,
  onBack,
  onEditContent,
}: ReaderViewProps) {
  // reading state
  const [revealed, setRevealed] = React.useState<Set<number>>(new Set())
  const [mode, setMode] = React.useState<ReaderMode>(null)
  const [chunks, setChunks] = React.useState<string[] | null>(null)
  const [chunksLoading, setChunksLoading] = React.useState(false)
  const [originalOpen, setOriginalOpen] = React.useState(false)
  const [aiTitle, setAiTitle] = React.useState<string | null>(null)
  const [aiTitleLoading, setAiTitleLoading] = React.useState(false)
  const [titleEditOpen, setTitleEditOpen] = React.useState(false)
  const [titleDraft, setTitleDraft] = React.useState('')
  const [ruleOpen, setRuleOpen] = React.useState(false)
  const [ruleStep, setRuleStep] = React.useState('2')

  // sheets / dialogs
  const [moreOpen, setMoreOpen] = React.useState(false)
  const [toolsOpen, setToolsOpen] = React.useState(false)
  const [activeTool, setActiveTool] = React.useState<string | null>(null)
  const [planOpen, setPlanOpen] = React.useState(false)
  const [shareOpen, setShareOpen] = React.useState(false)

  // paged mode indicator
  const [page, setPage] = React.useState(0)

  // daily plan progress (localStorage per card per day)
  const [progress, setProgress] = useLocalStorage<number>(todayKey(card.id), 0)
  // bottom bar visibility (client-side preference)
  const [showQuickBar] = useLocalStorage<boolean>('showQuickBar', true)
  const [showToolBar] = useLocalStorage<boolean>('showToolBar', true)

  const goal = card.plan?.goal ?? 10
  const paragraphs = React.useMemo(() => splitParagraphs(card.content), [card.content])
  const pages = React.useMemo(
    () => (settings.pageMode === 'paged' ? splitPages(paragraphs) : null),
    [settings.pageMode, paragraphs],
  )

  const bumpProgress = React.useCallback(() => {
    setProgress((p) => p + 1)
  }, [setProgress])

  React.useEffect(() => {
    setRevealed(new Set())
    setMode(null)
    setChunks(null)
    setOriginalOpen(false)
    setAiTitle(null)
    setPage(0)
  }, [card.id])

  // ---------- blank interactions ----------
  const handleReveal = React.useCallback(
    (idx: number) => {
      setRevealed((prev) => {
        if (prev.has(idx)) return prev
        const next = new Set(prev)
        next.add(idx)
        return next
      })
      bumpProgress()
    },
    [bumpProgress],
  )

  const handleToggleKeyword = React.useCallback(
    (word: string) => {
      const has = card.keywords.includes(word)
      const nextKeywords = has
        ? card.keywords.filter((k) => k !== word)
        : [...card.keywords, word]
      onUpdateCard({ ...card, keywords: nextKeywords })
      if (!has) bumpProgress()
    },
    [card, onUpdateCard, bumpProgress],
  )

  // ---------- quick edit actions ----------
  const handleAiCloze = React.useCallback(async () => {
    if (!card.content.trim()) {
      toast.error('内容为空，无法挖空')
      return
    }
    const tid = toast.loading('AI 正在分析关键点…')
    try {
      const res = await fetch('/api/cloze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: card.content }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '挖空失败')
      }
      const data = (await res.json()) as { keywords?: string[] }
      const kws = (data.keywords || []).filter(Boolean)
      if (kws.length === 0) {
        toast.warning('AI 未找到合适的挖空点', { id: tid })
        return
      }
      onUpdateCard({ ...card, keywords: kws })
      setMode(null)
      toast.success(`AI 已挖空 ${kws.length} 处关键词`, { id: tid })
    } catch (err) {
      toast.error('AI挖空失败：' + (err instanceof Error ? err.message : '未知错误'), { id: tid })
    }
  }, [card, onUpdateCard])

  const handleToggleChunk = React.useCallback(async () => {
    if (mode === 'chunk') {
      setMode(null)
      return
    }
    setMode('chunk')
    if (!chunks) {
      setChunksLoading(true)
      try {
        const res = await fetch('/api/chunk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: card.content }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || '分块失败')
        }
        const data = (await res.json()) as { chunks?: string[] }
        const list = (data.chunks || []).filter((c) => c.trim())
        if (list.length === 0) {
          toast.warning('AI 未返回分块结果')
          setMode(null)
          return
        }
        setChunks(list)
        toast.success(`已分块为 ${list.length} 段`)
      } catch (err) {
        setMode(null)
        toast.error('分块失败：' + (err instanceof Error ? err.message : '未知错误'))
      } finally {
        setChunksLoading(false)
      }
    }
  }, [mode, chunks, card.content])

  const applyRuleCloze = React.useCallback(
    (step: number) => {
      const kws = ruleCloze(card.content, step)
      if (kws.length === 0) {
        toast.warning('未找到可挖空的词语')
        return
      }
      onUpdateCard({ ...card, keywords: kws })
      setMode(null)
      toast.success(`规则挖空完成：每隔 ${step} 词，共 ${kws.length} 处`)
    },
    [card, onUpdateCard],
  )

  const applyTemplateCloze = React.useCallback(
    (template: ClozeTemplate) => {
      let kws: string[] = []
      if (template === 'sentence-start') {
        // First word token of every sentence.
        const tokenRe = /[\u4e00-\u9fff\u3400-\u4dbf]+|[a-zA-Z0-9]+/g
        const sentences = card.content.split(/(?<=[。！？；!?;\n])/)
        const set = new Set<string>()
        for (const s of sentences) {
          const m = s.trim().match(tokenRe)
          if (m && m[0]) set.add(m[0])
        }
        kws = Array.from(set)
      } else if (template === 'numbers') {
        const nums = card.content.match(/\d+(?:\.\d+)?%?/g) || []
        kws = Array.from(new Set(nums))
      } else {
        kws = ruleCloze(card.content, 3)
      }
      if (kws.length === 0) {
        toast.warning('该模版未找到可挖空的内容')
        return
      }
      onUpdateCard({ ...card, keywords: kws })
      setMode(null)
      toast.success(`模版挖空完成，共 ${kws.length} 处`)
    },
    [card, onUpdateCard],
  )

  // ---------- AI title ----------
  const handleAiTitle = React.useCallback(async () => {
    if (!card.content.trim()) return
    setAiTitleLoading(true)
    try {
      const res = await fetch('/api/title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: card.content }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '生成失败')
      }
      const data = (await res.json()) as { title?: string }
      if (data.title) {
        setAiTitle(data.title)
        toast.success('已生成标题：' + data.title)
      } else {
        toast.warning('AI 未返回标题')
      }
    } catch (err) {
      toast.error('生成标题失败：' + (err instanceof Error ? err.message : '未知错误'))
    } finally {
      setAiTitleLoading(false)
    }
  }, [card.content])

  const openTitleEdit = (initial: string) => {
    setTitleDraft(initial)
    setTitleEditOpen(true)
  }

  const handleSaveTitle = () => {
    const t = titleDraft.trim()
    if (!t) {
      toast.error('标题不能为空')
      return
    }
    onUpdateCard({ ...card, title: t })
    setTitleEditOpen(false)
    toast.success('标题已更新')
  }

  const openTool = (tool: string | null) => {
    setActiveTool(tool)
    setToolsOpen(true)
  }

  const progressPct = Math.min(100, Math.round((Math.min(progress, goal) / goal) * 100))

  // ---------- chips ----------
  const chipActive = (key: (typeof QUICK_CHIPS)[number]['key']): boolean => {
    if (key === 'aiChunk') return mode === 'chunk'
    if (key === 'doodle') return mode === 'doodle'
    if (key === 'brush') return mode === 'brush'
    if (key === 'manualCloze') return mode === 'manual'
    return false
  }

  const handleChip = (key: (typeof QUICK_CHIPS)[number]['key']) => {
    if (key === 'aiCloze') {
      void handleAiCloze()
      return
    }
    if (key === 'ruleCloze') return // opens popover (trigger)
    if (key === 'aiChunk') {
      void handleToggleChunk()
      return
    }
    const nextMode: ReaderMode =
      key === 'doodle' ? 'doodle' : key === 'brush' ? 'brush' : 'manual'
    setMode((cur) => (cur === nextMode ? null : nextMode))
    if (nextMode === 'doodle' && mode !== 'doodle') {
      toast.info('涂鸦模式：在正文上绘制笔迹，笔迹会自动保存')
    }
    if (nextMode === 'brush' && mode !== 'brush') {
      toast.info('挖空刷：按住并滑过词语即可挖空')
    }
    if (nextMode === 'manual' && mode !== 'manual') {
      toast.info('手动挖空：双击词语挖空，再次双击取消')
    }
  }

  return (
    <>
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4">
        {/* ---------- Top app bar ---------- */}
        <div className="sticky top-0 z-30 -mx-4 border-b border-border bg-background/85 px-4 backdrop-blur">
          <div className="flex h-14 items-center justify-between">
            <div className="flex items-center">
              <Button
                variant="ghost"
                size="icon"
                aria-label="返回"
                className="text-foreground/80"
                onClick={onBack}
              >
                <ArrowLeft className="size-5" strokeWidth={1.75} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="卡片列表"
                className="text-foreground/80"
                onClick={onBack}
              >
                <ListTree className="size-5" strokeWidth={1.75} />
              </Button>
            </div>
            <div className="flex items-center">
              <Button
                variant="ghost"
                size="icon"
                aria-label="编辑内容"
                className="text-foreground/80"
                onClick={onEditContent}
              >
                <Pencil className="size-5" strokeWidth={1.75} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="共享背书卡"
                className="text-foreground/80"
                onClick={() => setShareOpen(true)}
              >
                <Share2 className="size-5" strokeWidth={1.75} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="更多"
                className="text-foreground/80"
                onClick={() => setMoreOpen(true)}
              >
                <MoreHorizontal className="size-5" strokeWidth={1.75} />
              </Button>
            </div>
          </div>
        </div>

        {/* ---------- Title card ---------- */}
        <section className="mt-4 rounded-2xl bg-muted/60 p-4" aria-label="标题">
          <div className="flex items-center justify-center gap-2">
            <h1 className="truncate text-center text-xl font-bold">{card.title}</h1>
            <button
              type="button"
              aria-label="编辑标题"
              onClick={() => openTitleEdit(card.title)}
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            >
              <Pencil className="size-3.5" strokeWidth={1.75} />
            </button>
          </div>
          <button
            type="button"
            onClick={() => setOriginalOpen((v) => !v)}
            className="mt-1 block w-full text-center text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {originalOpen ? '点击收起原文' : '点击查看原文'}
          </button>
          {originalOpen && (
            <div className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-xl bg-background/70 p-3 text-sm leading-relaxed text-muted-foreground">
              {card.content}
            </div>
          )}
        </section>

        {/* ---------- Content ---------- */}
        {/* pb reserves space for the doodle toolbar overlay while 涂鸦 mode is on */}
        <section
          className={cn('relative mt-4 min-h-[260px]', mode === 'doodle' && 'pb-36')}
          aria-label="正文"
        >
          <DoodleCanvas
            strokes={card.strokes}
            onStrokesChange={(strokes) => onUpdateCard({ ...card, strokes })}
            active={mode === 'doodle'}
          />

          {chunksLoading && mode === 'chunk' ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> AI 正在分块…
            </div>
          ) : (
            <ClozeText
              content={card.content}
              keywords={card.keywords}
              style={settings.clozeStyle}
              showAnswers={settings.showAnswers}
              fontSize={settings.fontSize}
              brushMode={mode === 'brush'}
              manualMode={mode === 'manual'}
              chunks={mode === 'chunk' ? chunks : null}
              pages={mode === 'chunk' ? null : pages}
              onPageChange={(p, total) => setPage(p)}
              revealed={revealed}
              onReveal={handleReveal}
              onToggleKeyword={handleToggleKeyword}
            />
          )}

          {mode === 'brush' && (
            <div className="pointer-events-none absolute left-1/2 top-0 z-10 -translate-x-1/2 rounded-full bg-emerald-600 px-3 py-1 text-xs text-white shadow-lg">
              挖空刷：按住滑过词语挖空
            </div>
          )}
        </section>

        {/* Floating eye FAB — sticky so it hovers above the bottom toolbar like the reference app */}
        <div className="pointer-events-none sticky bottom-36 z-30 -mt-16 flex justify-end pr-2">
          <button
            type="button"
            aria-label={settings.showAnswers ? '隐藏答案' : '显示答案'}
            onClick={() => onChangeSettings({ showAnswers: !settings.showAnswers })}
            className="pointer-events-auto flex size-14 items-center justify-center rounded-full bg-zinc-700 text-white shadow-xl transition-transform hover:scale-105 active:scale-95"
          >
            {settings.showAnswers ? (
              <Eye className="size-6" strokeWidth={1.75} />
            ) : (
              <EyeOff className="size-6" strokeWidth={1.75} />
            )}
          </button>
        </div>

        {/* ---------- AI title card ---------- */}
        <section className="mt-4 rounded-2xl border border-border bg-card p-4" aria-label="AI 标题">
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 rounded-full border border-emerald-600/40 px-3 text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-700"
              onClick={() => void handleAiTitle()}
              disabled={aiTitleLoading}
            >
              {aiTitleLoading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" strokeWidth={1.75} />
              )}
              AI生成标题
            </Button>
            <button
              type="button"
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => toast.info('感谢反馈！我们会继续改进')}
            >
              反馈
            </button>
          </div>
          {aiTitle && (
            <div className="mt-2 flex items-center justify-center gap-2">
              <span className="text-base font-bold">{aiTitle}</span>
              <button
                type="button"
                aria-label="采用此标题"
                onClick={() => openTitleEdit(aiTitle)}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                <Pencil className="size-3.5" strokeWidth={1.75} />
              </button>
            </div>
          )}
        </section>

        {/* ---------- Sticky bottom area ---------- */}
        <div className="sticky bottom-0 z-20 -mx-4 mt-4 border-t border-border bg-background/95 px-4 pb-2 pt-3 backdrop-blur">
          {showQuickBar && (
            <div className="no-scrollbar flex gap-2 overflow-x-auto" role="toolbar" aria-label="快捷编辑栏">
              {QUICK_CHIPS.filter((c) => settings.tools[c.key]).map((chip) => {
                const Icon = chip.icon
                const active = chipActive(chip.key)
                if (chip.key === 'ruleCloze') {
                  return (
                    <Popover key={chip.key} open={ruleOpen} onOpenChange={setRuleOpen}>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className={cn(
                            'flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors',
                            ruleOpen
                              ? 'border-emerald-600/50 bg-emerald-500/10 text-emerald-600'
                              : 'border-border bg-card text-muted-foreground hover:text-foreground',
                          )}
                        >
                          <Icon className="size-3.5" strokeWidth={1.75} />
                          {chip.label}
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="w-56 rounded-2xl p-4" side="top">
                        <p className="mb-2 text-sm font-semibold">规则挖空</p>
                        <p className="mb-3 text-xs text-muted-foreground">每隔 N 个词自动挖空一处</p>
                        <Select value={ruleStep} onValueChange={setRuleStep}>
                          <SelectTrigger className="h-9 w-full rounded-xl">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {[2, 3, 4, 5].map((n) => (
                              <SelectItem key={n} value={String(n)}>
                                每隔 {n} 词
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          className="mt-3 w-full rounded-full bg-primary"
                          onClick={() => {
                            setRuleOpen(false)
                            applyRuleCloze(Number(ruleStep))
                          }}
                        >
                          应用
                        </Button>
                      </PopoverContent>
                    </Popover>
                  )
                }
                return (
                  <button
                    key={chip.key}
                    type="button"
                    aria-pressed={active}
                    className={cn(
                      'flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors',
                      active
                        ? 'border-emerald-600/50 bg-emerald-500/10 text-emerald-600'
                        : 'border-border bg-card text-muted-foreground hover:text-foreground',
                    )}
                    onClick={() => handleChip(chip.key)}
                  >
                    <Icon className="size-3.5" strokeWidth={1.75} />
                    {chip.label}
                  </button>
                )
              })}
            </div>
          )}

          {showToolBar && (
            <div className="no-scrollbar mt-2 flex gap-1 overflow-x-auto" role="toolbar" aria-label="背书工具栏">
              {TOOL_BUTTONS.filter((t) => settings.tools[t.key]).map((t) => {
                const Icon = t.icon
                return (
                  <button
                    key={t.key}
                    type="button"
                    className="flex w-16 shrink-0 flex-col items-center gap-1 rounded-xl py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={() => openTool(t.key)}
                  >
                    <Icon className="size-5" strokeWidth={1.75} />
                    <span className="text-[11px]">{t.label}</span>
                  </button>
                )
              })}
              <button
                type="button"
                className="flex w-16 shrink-0 flex-col items-center gap-1 rounded-xl py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => openTool(null)}
              >
                <LayoutGrid className="size-5" strokeWidth={1.75} />
                <span className="text-[11px]">背书工具</span>
              </button>
              <button
                type="button"
                aria-label="更多设置"
                className="flex w-12 shrink-0 flex-col items-center justify-center rounded-xl py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => setMoreOpen(true)}
              >
                <Settings2 className="size-5" strokeWidth={1.75} />
              </button>
            </div>
          )}

          {/* 今日计划 card */}
          <div className="mt-3 rounded-2xl border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold">今日计划</span>
              <button
                type="button"
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setPlanOpen(true)}
              >
                查看计划 ›
              </button>
            </div>
            <div className="mt-2.5 flex items-center gap-3">
              <span className="shrink-0 text-xs text-muted-foreground">
                今日已背 {Math.min(progress, goal)} / {goal} 词
              </span>
              <Progress value={progressPct} className="h-1.5 flex-1" aria-label="今日背诵进度" />
            </div>
            <Button
              className="mt-3 h-10 w-full rounded-full bg-primary text-sm font-semibold hover:bg-primary/90"
              onClick={() => setPlanOpen(true)}
            >
              制定背书计划
            </Button>
          </div>

          <div className="mt-1.5 text-left text-[11px] text-muted-foreground/70">
            {settings.pageMode === 'paged' ? `${page + 1}/${pages?.length ?? 1}` : '1/1'}
          </div>
        </div>
      </div>

      {/* ---------- Title edit dialog ---------- */}
      <Dialog open={titleEditOpen} onOpenChange={setTitleEditOpen}>
        <DialogContent className="rounded-2xl sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>编辑标题</DialogTitle>
            <DialogDescription>为这张背书卡取一个好记的名字</DialogDescription>
          </DialogHeader>
          <Input
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            placeholder="标题"
            className="h-11 rounded-xl"
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTitleEditOpen(false)}>
              取消
            </Button>
            <Button className="rounded-full bg-primary" onClick={handleSaveTitle}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- Sheets ---------- */}
      <MoreSheet
        open={moreOpen}
        onOpenChange={setMoreOpen}
        card={card}
        settings={settings}
        onChangeSettings={onChangeSettings}
        onRuleCloze={(step) => {
          setMoreOpen(false)
          applyRuleCloze(step)
        }}
        onTemplateCloze={(t) => {
          setMoreOpen(false)
          applyTemplateCloze(t)
        }}
        onAiCloze={() => {
          setMoreOpen(false)
          void handleAiCloze()
        }}
        onManualMode={() => {
          setMoreOpen(false)
          setMode((cur) => (cur === 'manual' ? null : 'manual'))
          toast.info('手动挖空：双击词语挖空，再次双击取消')
        }}
        onBrushMode={() => {
          setMoreOpen(false)
          setMode((cur) => (cur === 'brush' ? null : 'brush'))
          toast.info('挖空刷：按住并滑过词语即可挖空')
        }}
      />

      <ToolsSheet
        open={toolsOpen}
        onOpenChange={setToolsOpen}
        tool={activeTool}
        onToolChange={setActiveTool}
        card={card}
        settings={settings}
        onChangeSettings={onChangeSettings}
      />

      <PlanDialog
        open={planOpen}
        onOpenChange={setPlanOpen}
        card={card}
        progress={progress}
        onSavePlan={(g) => {
          onUpdateCard({ ...card, plan: { goal: g } })
          toast.success(`背书计划已保存：每日 ${g} 词`)
          setPlanOpen(false)
        }}
      />

      <ShareDialog card={card} open={shareOpen} onOpenChange={setShareOpen} />
    </>
  )
}
