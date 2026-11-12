'use client'

import * as React from 'react'
import {
  ArrowLeft,
  Baseline,
  Brush,
  Check,
  ChevronDown,
  ChevronUp,
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
  Brain,
  Redo2,
  Repeat2,
  Settings2,
  Share2,
  Sparkles,
  SquareSlash,
  Undo2,
  Volume2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import type { CardData, ClozeStyle, ReviewAction, SettingsData } from '@/lib/types'
import { REVIEW_ACTIONS, TTS_VOICES } from '@/lib/types'
import { cn } from '@/lib/utils'
import { ruleCloze, splitParagraphs, toggleOccurrence, removeOccurrence } from '@/lib/cloze'
import type { KwEntry } from '@/lib/types'
import { todayKey, useLocalStorage } from '@/lib/use-local-storage'
import { useServerState } from '@/lib/use-server-state'
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
import { MoreSheet, type ClozeTemplate } from '@/components/recitation/more-sheet'
import { PlanDialog } from '@/components/recitation/plan-dialog'
import { ProgressSheet } from '@/components/recitation/progress-sheet'
import { ReviewScoreBar } from '@/components/recitation/review-score-bar'
import { AlgorithmConfigDialog } from '@/components/recitation/algorithm-config-dialog'
import { ShareDialog } from '@/components/recitation/share-dialog'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import NextDynamic from 'next/dynamic'

// 重组件懒加载：拆小首页/阅读页的编译图，避免 dev 编译内存峰值过高。
const DoodleCanvas = NextDynamic(
  () => import('@/components/recitation/doodle-canvas').then((m) => m.DoodleCanvas),
  { ssr: false, loading: () => null },
)
const TtsPlayer = NextDynamic(
  () => import('@/components/recitation/tts-player').then((m) => m.TtsPlayer),
  { ssr: false, loading: () => <div className="h-64 animate-pulse rounded-xl bg-muted" /> },
)
/** 选区朗读临时播放器：主朗读 Sheet 关闭时也能响应 sb-read-selection 事件 */
const SelectionReadPlayer = NextDynamic(
  () => import('@/components/recitation/tts-player').then((m) => m.SelectionReadPlayer),
  { ssr: false, loading: () => null },
)
const ClozeEditorBar = NextDynamic(
  () => import('@/components/recitation/cloze-editor-bar').then((m) => m.ClozeEditorBar),
  { ssr: false, loading: () => null },
)
const ClozeStyleSheet = NextDynamic(
  () => import('@/components/recitation/cloze-style-sheet').then((m) => m.ClozeStyleSheet),
  { ssr: false, loading: () => null },
)
const ToolsSheet = NextDynamic(
  () => import('@/components/recitation/tools-sheet').then((m) => m.ToolsSheet),
  { ssr: false, loading: () => null },
)
const TocSheet = NextDynamic(
  () => import('@/components/recitation/toc-sheet').then((m) => m.TocSheet),
  { ssr: false, loading: () => null },
)
// 字级挖空渲染 + 自定义选择菜单（核心阅读组件，静态导入保证首屏无闪烁）
import { ClozeText } from '@/components/recitation/cloze-text'

type ReaderMode = null | 'chunk' | 'doodle' | 'brush' | 'manual' | 'editor'

interface ReaderViewProps {
  card: CardData
  settings: SettingsData
  onUpdateCard: (next: CardData) => void
  onChangeSettings: (patch: Partial<SettingsData>) => void
  onBack: () => void
  onEditContent: () => void
  /** 打开文字编辑工具（新材料 Q&A 块编辑器） */
  onOpenMaterialEditor?: () => void
  /** 打开复习总览（本书进度弹窗入口） */
  onOpenOverview?: () => void
  /** 打开制作背书计划（本书进度弹窗 → 计划管理） */
  onOpenPlanEditor?: () => void
  /** 打开复习计划管理（艾宾浩斯模板） */
  onOpenReviewPlans?: () => void
  /** 全局朗读：由父级（page.tsx）挂载 TtsPlayer，跨视图持续播放。
   *  提供时本组件不再渲染本地播放器 Sheet，朗读按钮改为调用此回调。 */
  onStartTts?: (card: CardData) => void
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
  { key: 'reviewMode', label: '复习模式', icon: Repeat2 },
] as const

const TOOL_BUTTONS = [
  { key: 'asr', label: '录音背书', icon: Mic },
  { key: 'quiz', label: 'AI出题', icon: FileQuestion },
  { key: 'mindmap', label: '思维导图', icon: Network },
  { key: 'tts', label: '朗读文本', icon: Volume2 },
] as const

// 挖空显示样式按钮上的短标签（编辑模式顶栏）
const CLOZE_STYLE_LABEL: Record<ClozeStyle, string> = {
  circle: '圈圈',
  underline: '下划线',
  blur: '模糊',
  star: '星号',
  blank: '空白',
  highlight: '高亮',
}

// 临时播放器（选中文本朗读）事件 detail 契约 — 由 tts-player 侧监听播放。
interface SbReadSelectionDetail {
  text: string
}

// 临时播放器回报的朗读进度（detail 契约）。
interface SbReadProgressDetail {
  index: number
  total: number
  text: string
  done: boolean
  cancelled?: boolean
}

// ---------------------------------------------------------------------------
// 朗读引擎说明：点「AI朗读 / 朗读文本」时 toast 提示本次走哪个引擎。
// 解析顺序与 tts-player 的 seedQuickPref 一致：voicePrefs[context].tts 优先
// （reader 场景，回退 tts 工具场景），再回退到全局 settings.ttsProvider/ttsVoice。
// ---------------------------------------------------------------------------
function ttsEngineLabel(settings: SettingsData): string {
  const pref = settings?.voicePrefs?.['reader']?.tts ?? settings?.voicePrefs?.['tts']?.tts
  // 全局为 browser（系统静音）时回退到 z-ai，与 tts-player 默认初始化一致
  const provider =
    pref?.provider ??
    (settings?.ttsProvider === 'custom'
      ? 'custom'
      : settings?.ttsProvider === 'browser'
        ? 'zai'
        : settings?.ttsProvider ?? 'zai')
  if (provider === 'custom') return '自定义 TTS 服务'
  if (provider === 'browser') return '系统语音'
  const voice = pref?.voice ?? settings?.ttsVoice
  const match = voice ? TTS_VOICES.find((v) => v.value === voice) : undefined
  const name = match?.label.split('·')[0]?.trim()
  return name ? `AI 音色 · ${name}` : 'AI 音色（童童等）'
}

export function ReaderView({
  card,
  settings,
  onUpdateCard,
  onChangeSettings,
  onBack,
  onEditContent,
  onOpenMaterialEditor,
  onOpenOverview,
  onOpenPlanEditor,
  onOpenReviewPlans,
  onStartTts,
}: ReaderViewProps) {
  // reading state
  const [revealed, setRevealed] = React.useState<Set<number>>(new Set())
  const [mode, setMode] = React.useState<ReaderMode>(null)
  const [chunks, setChunks] = React.useState<string[] | null>(null)
  const [chunksLoading, setChunksLoading] = React.useState(false)
  // 目录/搜本书
  const [tocOpen, setTocOpen] = React.useState(false)
  const [originalOpen, setOriginalOpen] = React.useState(false)
  const [aiTitle, setAiTitle] = React.useState<string | null>(null)
  const [aiTitleLoading, setAiTitleLoading] = React.useState(false)
  const [titleEditOpen, setTitleEditOpen] = React.useState(false)
  const [titleDraft, setTitleDraft] = React.useState('')
  // 单书复习算法配置面板（本书覆盖全局默认）
  const [bookAlgOpen, setBookAlgOpen] = React.useState(false)
  const [ruleOpen, setRuleOpen] = React.useState(false)
  const [ruleStep, setRuleStep] = React.useState('2')

  // sheets / dialogs
  const [moreOpen, setMoreOpen] = React.useState(false)
  const [toolsOpen, setToolsOpen] = React.useState(false)
  const [activeTool, setActiveTool] = React.useState<string | null>(null)
  const [planOpen, setPlanOpen] = React.useState(false)
  const [shareOpen, setShareOpen] = React.useState(false)

  // 挖空编辑模式（截图4）：顶栏样式/撤销/重做/完成 + 提示条 + 底部工具条
  const [hintVisible, setHintVisible] = React.useState(true)
  const [styleOpen, setStyleOpen] = React.useState(false)
  const [ruleDialogOpen, setRuleDialogOpen] = React.useState(false)
  const [templateDialogOpen, setTemplateDialogOpen] = React.useState(false)
  const [progressOpen, setProgressOpen] = React.useState(false)
  const kwPastRef = React.useRef<KwEntry[][]>([])
  const kwFutureRef = React.useRef<KwEntry[][]>([])
  // 编辑模式内的挖空刷开关（不改变 mode，避免退出编辑器）
  const [editorBrush, setEditorBrush] = React.useState(false)
  // 复习模式：熟悉/模糊/忘记 评分条只在复习时出现
  const [reviewMode, setReviewMode] = React.useState(false)
  // TTS 全屏播放器 Sheet
  const [ttsOpen, setTtsOpen] = React.useState(false)
  // 播放器收起态：与 Sheet 开合联动（收起时 Sheet 关闭、forceMount 保活音频）
  const [playerCollapsed, setPlayerCollapsed] = React.useState(false)
  // 今日计划卡片折叠状态（默认折叠成一条细行；localStorage 持久化，key 随卡片）
  const [planCollapsed, setPlanCollapsed] = useLocalStorage<boolean>(
    `bb-plan-collapsed:${card.id}`,
    true,
  )
  // 临时播放器（选中文本朗读）进度回报 — 播放中显示轻提示
  const [selReadProgress, setSelReadProgress] = React.useState<SbReadProgressDetail | null>(null)
  React.useEffect(() => {
    const onProgress = (e: Event) => {
      const detail = (e as CustomEvent<SbReadProgressDetail>).detail
      if (!detail) return
      setSelReadProgress(detail.done || detail.cancelled ? null : detail)
    }
    window.addEventListener('sb-read-selection-progress', onProgress)
    return () => window.removeEventListener('sb-read-selection-progress', onProgress)
  }, [])
  // 眼睛悬浮球位置（可拖动；服务端持久化 + localStorage 即时水合）
  const [eyePos, setEyePos] = useServerState<{ x: number; y: number } | null>(
    'eyeFabPos',
    null,
  )
  const eyeDragRef = React.useRef<{ startX: number; startY: number; moved: boolean } | null>(null)
  // 进入卡片时间（评分时长上报用）
  const enterTimeRef = React.useRef<number>(Date.now())

  // 涂鸦工具栏悬浮偏移：测量吸底菜单实时高度，注入 --doodle-bottom，
  // 让涂鸦工具栏（fixed）始终悬浮在吸底菜单上方，不遮挡也不被遮挡。
  const stickyBarRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const el = stickyBarRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const apply = () => {
      const h = el.getBoundingClientRect().height
      document.documentElement.style.setProperty('--doodle-bottom', `${Math.round(h + 10)}px`)
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => {
      ro.disconnect()
      document.documentElement.style.removeProperty('--doodle-bottom')
    }
  }, [])

  // paged mode indicator
  const [page, setPage] = React.useState(0)

  // daily plan progress（服务端持久化：plan-{cardId}-{yyyymmdd}）
  const [progress, setProgress] = useServerState<number>(todayKey(card.id), 0)
  // bottom bar visibility（同样存服务端，换设备不丢）
  const [showQuickBar] = useServerState<boolean>('showQuickBar', true)
  const [showToolBar] = useServerState<boolean>('showToolBar', true)

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
    setHintVisible(true)
    kwPastRef.current = []
    kwFutureRef.current = []
    enterTimeRef.current = Date.now()
  }, [card.id])

  // ---------- keyword history (undo/redo) ----------
  const pushKwHistory = React.useCallback(
    (prevKw: KwEntry[]) => {
      kwPastRef.current.push(prevKw)
      kwFutureRef.current = []
      // cap the history at 50 entries
      if (kwPastRef.current.length > 50) kwPastRef.current.shift()
    },
    [],
  )

  const handleUndo = React.useCallback(() => {
    const prev = kwPastRef.current.pop()
    if (!prev) {
      toast.info('没有可撤销的操作')
      return
    }
    kwFutureRef.current.push(card.keywords)
    onUpdateCard({ ...card, keywords: prev })
  }, [card, onUpdateCard])

  const handleRedo = React.useCallback(() => {
    const next = kwFutureRef.current.pop()
    if (!next) {
      toast.info('没有可重做的操作')
      return
    }
    kwPastRef.current.push(card.keywords)
    onUpdateCard({ ...card, keywords: next })
  }, [card, onUpdateCard])

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
    (word: string, occ: number) => {
      const nextKeywords = toggleOccurrence(card.keywords, word, occ, card.content)
      pushKwHistory(card.keywords)
      onUpdateCard({ ...card, keywords: nextKeywords })
      if (!toggleOccurrence([], word, occ, card.content).some((e) =>
        typeof e === 'string' ? e === word : e.t === word && (e.occ === occ || e.occ === -1),
      )) {
        // removed → no progress bump
      } else {
        bumpProgress()
      }
    },
    [card, onUpdateCard, bumpProgress, pushKwHistory],
  )

  // 长按选择文字 → 挖空选中（编辑模式）
  const handleSelectCloze = React.useCallback(
    (text: string, occ: number) => {
      const t = text.trim()
      if (!t) return
      pushKwHistory(card.keywords)
      onUpdateCard({
        ...card,
        keywords: toggleOccurrence(card.keywords, t, occ, card.content),
      })
      bumpProgress()
      toast.success(`已挖空「${t.slice(0, 12)}${t.length > 12 ? '…' : ''}」`)
    },
    [card, onUpdateCard, pushKwHistory, bumpProgress],
  )

  // 自定义选择菜单（长按/右键）→ 挖空选中（阅读模式，字级）
  const handleSelectionCloze = React.useCallback(
    (text: string, occ: number) => {
      const t = text.trim()
      if (!t) return
      // 必须是原文连续子串（含标点），否则无法渲染成挖空
      if (!card.content.includes(t)) {
        toast.error('选择包含不连续内容，请重新选择连续的文字')
        return
      }
      // 只挖选中的这一次出现（occ 定位），其他句子的同字词不受影响
      pushKwHistory(card.keywords)
      onUpdateCard({
        ...card,
        keywords: toggleOccurrence(card.keywords, t, occ, card.content),
      })
      bumpProgress()
    },
    [card, onUpdateCard, pushKwHistory, bumpProgress],
  )

  const handleSelectionUncloze = React.useCallback(
    (text: string, occ: number) => {
      const t = text.trim()
      if (!t) return
      pushKwHistory(card.keywords)
      onUpdateCard({
        ...card,
        keywords: removeOccurrence(card.keywords, t, occ, card.content),
      })
    },
    [card, onUpdateCard, pushKwHistory],
  )

  // 空白长按菜单：取消挖空（只取消这一次出现）
  const handleRemoveKeyword = React.useCallback(
    (word: string, occ: number) => {
      pushKwHistory(card.keywords)
      onUpdateCard({
        ...card,
        keywords: removeOccurrence(card.keywords, word, occ, card.content),
      })
    },
    [card, onUpdateCard, pushKwHistory],
  )

  // 选择菜单朗读：分发给临时播放器（tts-player 监听 sb-read-selection 事件播放），
  // 引擎沿用用户默认配置；点击时先 toast 说明本次使用的引擎，选中态由 ClozeText 自行清除。
  const handleSpeakSelection = React.useCallback(
    (text: string) => {
      const t = (text || '').trim()
      if (!t) return
      toast.info(`朗读将使用：${ttsEngineLabel(settings)}`)
      window.dispatchEvent(
        new CustomEvent<SbReadSelectionDetail>('sb-read-selection', { detail: { text: t } }),
      )
    },
    [settings],
  )

  // ---------- review scoring (熟悉/模糊/忘记) ----------
  const handleScore = React.useCallback(
    async (action: ReviewAction) => {
      const label = REVIEW_ACTIONS.find((a) => a.value === action)?.label ?? action
      try {
        const res = await fetch('/api/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cardId: card.id,
            cardTitle: card.title,
            action,
            durationSec: Math.min(
              3600,
              Math.max(1, Math.round((Date.now() - enterTimeRef.current) / 1000)),
            ),
          }),
        })
        if (!res.ok) throw new Error('记录失败')
        toast.success(`已标记「${label}」，继续加油！`)
        bumpProgress()
      } catch (err) {
        toast.error('记录失败：' + (err instanceof Error ? err.message : '未知错误'))
      }
    },
    [card.id, card.title, bumpProgress],
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
      pushKwHistory(card.keywords)
      onUpdateCard({ ...card, keywords: kws })
      setMode(null)
      toast.success(`AI 已挖空 ${kws.length} 处关键词`, { id: tid })
    } catch (err) {
      toast.error('AI挖空失败：' + (err instanceof Error ? err.message : '未知错误'), { id: tid })
    }
  }, [card, onUpdateCard, pushKwHistory])

  // 超级编辑器的 blocks（分块）作为分块视图的首选数据源 — 编辑后立即生效
  const blockChunks = React.useMemo(
    () =>
      card.blocks && card.blocks.length > 0
        ? card.blocks
            .map((b) => [b.front, b.back].filter((x) => x && x.trim()).join('\n'))
            .filter((x) => x.trim())
        : null,
    [card.blocks],
  )

  const handleToggleChunk = React.useCallback(async () => {
    if (mode === 'chunk') {
      setMode(null)
      return
    }
    setMode('chunk')
    if (blockChunks) {
      // 已有编辑器分块：直接使用，不再调用 AI
      toast.success(`已按编辑器分块显示，共 ${blockChunks.length} 块`)
      return
    }
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
        toast.warning('未找到可挖空的字')
        return
      }
      pushKwHistory(card.keywords)
      onUpdateCard({ ...card, keywords: kws })
      setMode(null)
      toast.success(`规则挖空完成：每隔 ${step} 字，共 ${kws.length} 处`)
    },
    [card, onUpdateCard, pushKwHistory],
  )

  const applyTemplateCloze = React.useCallback(
    (template: ClozeTemplate) => {
      let kws: KwEntry[] = []
      if (template === 'sentence-start') {
        // 首字挖空：每句第一个「字」——按出现位置挖空，同名首字不误伤其他句子。
        const tokenRe = /[\u4e00-\u9fff\u3400-\u4dbf]|[a-zA-Z0-9]+/g
        const sentences = card.content.split(/(?<=[。！？；!?;\n])/)
        const counters = new Map<string, number>()
        const seen = new Set<string>()
        const out: KwEntry[] = []
        let scanned = 0
        for (const s of sentences) {
          const trimmed = s.trim()
          const lead = s.length - (s.startsWith(trimmed) ? 0 : s.slice(0, s.indexOf(trimmed)).length)
          void lead
          const m = trimmed.match(tokenRe)
          if (m && m[0]) {
            // 该首字在全文中的出现序号：数它之前的出现次数（粗略：按扫描偏移）
            const before = card.content.slice(0, scanned + s.indexOf(m[0]))
            const occ = before.split(m[0]).length - 1
            const key = `${m[0]}\u0000${occ}`
            if (!seen.has(key)) {
              seen.add(key)
              counters.set(m[0], occ)
              out.push({ t: m[0], occ })
            }
          }
          scanned += s.length
        }
        kws = out
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
      pushKwHistory(card.keywords)
      onUpdateCard({ ...card, keywords: kws })
      setMode(null)
      toast.success(`模版挖空完成，共 ${kws.length} 处`)
    },
    [card, onUpdateCard, pushKwHistory],
  )

  // 清空全部挖空（编辑模式）
  const handleClearAllKeywords = React.useCallback(() => {
    if (card.keywords.length === 0) {
      toast.info('当前没有挖空')
      return
    }
    pushKwHistory(card.keywords)
    onUpdateCard({ ...card, keywords: [] })
    toast.success('已清空全部挖空')
  }, [card, onUpdateCard, pushKwHistory])

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
    if (key === 'manualCloze') return mode === 'editor' || mode === 'manual'
    if (key === 'reviewMode') return reviewMode
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
    if (key === 'reviewMode') {
      setReviewMode((v) => {
        toast.info(v ? '已退出复习模式' : '复习模式：背完后用「熟悉/模糊/忘记」评估本卡')
        return !v
      })
      return
    }
    const nextMode: ReaderMode =
      key === 'doodle' ? 'doodle' : key === 'brush' ? 'brush' : 'editor'
    setMode((cur) => (cur === nextMode ? null : nextMode))
    if (nextMode === 'doodle' && mode !== 'doodle') {
      toast.info('涂鸦模式：在正文上绘制笔迹，笔迹会自动保存')
    }
    if (nextMode === 'brush' && mode !== 'brush') {
      toast.info('挖空刷：按住滑过一段文字，松手即挖成一个空')
    }
    if (nextMode === 'editor' && mode !== 'editor') {
      toast.info('挖空编辑：长按选择文字挖空，点击已挖空的词取消')
    }
  }

  return (
    <>
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4">
        {/* ---------- Top app bar ---------- */}
        <div className="sticky top-0 z-30 -mx-4 border-b border-border bg-background/85 px-4 backdrop-blur">
          {mode === 'editor' ? (
            <div className="flex h-14 items-center justify-between">
              <Button
                variant="ghost"
                size="icon"
                aria-label="退出编辑"
                className="text-foreground/80"
                onClick={() => setMode(null)}
              >
                <ArrowLeft className="size-5" strokeWidth={1.75} />
              </Button>
              <div className="flex items-center gap-1">
                {/* 挖空显示样式按钮（当前样式名） */}
                <button
                  type="button"
                  aria-label="挖空显示样式"
                  onClick={() => setStyleOpen(true)}
                  className="flex h-9 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-sm text-foreground/85 transition-colors hover:text-foreground"
                >
                  <span
                    className={cn(
                      'inline-block h-4 w-7 rounded-[50%] border-2',
                      settings.clozeStyle === 'circle' && 'border-emerald-600',
                      settings.clozeStyle !== 'circle' && 'border-foreground/60',
                    )}
                  />
                  {CLOZE_STYLE_LABEL[settings.clozeStyle]}
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="撤销"
                  className="text-foreground/80"
                  onClick={handleUndo}
                >
                  <Undo2 className="size-5" strokeWidth={1.75} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="重做"
                  className="text-foreground/80"
                  onClick={handleRedo}
                >
                  <Redo2 className="size-5" strokeWidth={1.75} />
                </Button>
                <Button
                  size="sm"
                  aria-label="完成编辑"
                  className="h-9 rounded-full bg-primary px-5 font-semibold"
                  onClick={() => setMode(null)}
                >
                  完成
                </Button>
              </div>
            </div>
          ) : (
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
                  aria-label="目录/搜本书"
                  className="text-foreground/80"
                  onClick={() => setTocOpen(true)}
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
                {/* 本书复习算法配置（覆盖全局默认） */}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="本书复习算法"
                  title="本书复习算法配置"
                  className="text-foreground/80"
                  onClick={() => setBookAlgOpen(true)}
                >
                  <Brain className="size-5" strokeWidth={1.75} />
                </Button>
                {/* AI 朗读（全屏音乐播放器，可收起为迷你悬浮条）—
                    点击先提示播放引擎；播放器打开时按钮呈绿色高亮 + 按压缩放反馈 */}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="AI朗读"
                  aria-pressed={ttsOpen}
                  className={cn(
                    'text-foreground/80 transition-all duration-200 active:scale-90',
                    ttsOpen && 'bg-emerald-500/10 text-emerald-600',
                  )}
                  onClick={() => {
                    toast.info(`朗读将使用：${ttsEngineLabel(settings)}`)
                    if (onStartTts) onStartTts(card)
                    else { setPlayerCollapsed(false); setTtsOpen(true) }
                  }}
                >
                  <Volume2 className="size-5" strokeWidth={1.75} />
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
          )}
        </div>

        {/* ---------- 标题卡 ---------- */}
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
            <button
              type="button"
              aria-label="本书进度"
              onClick={() => setProgressOpen(true)}
              className="shrink-0 text-emerald-600 transition-colors hover:text-emerald-700"
            >
              <Repeat2 className="size-4" strokeWidth={1.75} />
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

        {/* ---------- 挖空编辑提示条（截图4橙色提示） ---------- */}
        {mode === 'editor' && hintVisible && (
          <div className="mt-3 flex items-start gap-3 rounded-xl bg-amber-50 px-4 py-3 dark:bg-amber-950/30">
            <p className="flex-1 text-sm leading-relaxed text-amber-900 dark:text-amber-200">
              长按选择文字，点击
              <span className="font-semibold text-amber-600 dark:text-amber-400">“挖空选中”</span>
              ，只挖选中的这一处；
              <span className="font-semibold text-amber-600 dark:text-amber-400">
                点击已挖空的词可取消
              </span>
            </p>
            <button
              type="button"
              aria-label="关闭提示"
              onClick={() => setHintVisible(false)}
              className="mt-0.5 shrink-0 text-amber-700/60 transition-colors hover:text-amber-700 dark:text-amber-200/60"
            >
              <X className="size-4" strokeWidth={1.75} />
            </button>
          </div>
        )}

        {/* ---------- Content ---------- */}
        {/* 涂鸦工具栏已改为 fixed 悬浮在吸底菜单上方（--doodle-bottom 由下方测量注入），
            内容区不再需要 pb-36 占位，画布也永远不会盖住吸底菜单 */}
        <section className="relative mt-4 min-h-[260px]" aria-label="正文">
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
              brushMode={mode === 'brush' || (mode === 'editor' && editorBrush)}
              manualMode={mode === 'manual' || mode === 'editor'}
              selectionMode={mode === 'editor'}
              onSelectCloze={handleSelectCloze}
              selectMenuEnabled
              onSelectionCloze={handleSelectionCloze}
              onSelectionUncloze={handleSelectionUncloze}
              chunks={mode === 'chunk' ? chunks ?? blockChunks : null}
              pages={mode === 'chunk' ? null : pages}
              onPageChange={(p, total) => setPage(p)}
              revealed={revealed}
              onReveal={handleReveal}
              onToggleKeyword={handleToggleKeyword}
              onRemoveKeyword={handleRemoveKeyword}
              speakText={handleSpeakSelection}
            />
          )}

          {mode === 'brush' && (
            <div className="pointer-events-none absolute left-1/2 top-0 z-10 -translate-x-1/2 rounded-full bg-emerald-600 px-3 py-1 text-xs text-white shadow-lg">
              挖空刷：按住滑过一段文字，松手挖成一个空
            </div>
          )}
        </section>

        {/* Floating eye FAB — 可拖动悬浮球，不遮挡文本；点按切换显示答案 */}
        {mode !== 'editor' && (
          <button
            type="button"
            aria-label={settings.showAnswers ? '隐藏答案' : '显示答案'}
            onPointerDown={(e) => {
              try {
                ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
              } catch {
                /* 合成事件/无效 pointerId 时忽略 */
              }
              eyeDragRef.current = { startX: e.clientX, startY: e.clientY, moved: false }
            }}
            onPointerMove={(e) => {
              const d = eyeDragRef.current
              if (!d) return
              if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 8) return
              d.moved = true
              setEyePos({
                x: Math.min(Math.max(e.clientX, 36), window.innerWidth - 36),
                y: Math.min(Math.max(e.clientY, 60), window.innerHeight - 80),
              })
            }}
            onPointerUp={() => {
              const d = eyeDragRef.current
              eyeDragRef.current = null
              if (d && !d.moved) onChangeSettings({ showAnswers: !settings.showAnswers })
            }}
            onPointerCancel={() => {
              eyeDragRef.current = null
            }}
            style={
              eyePos
                ? {
                    position: 'fixed',
                    left: eyePos.x,
                    top: eyePos.y,
                    transform: 'translate(-50%, -50%)',
                    touchAction: 'none',
                  }
                : undefined
            }
            className={cn(
              'z-30 flex touch-none items-center justify-center rounded-full bg-zinc-700 text-white shadow-xl transition-transform hover:scale-105 active:scale-95',
              eyePos ? 'fixed' : 'sticky bottom-36 -mt-16 mr-2 self-end',
            )}
          >
            {settings.showAnswers ? (
              <Eye className="size-6" strokeWidth={1.75} />
            ) : (
              <EyeOff className="size-6" strokeWidth={1.75} />
            )}
          </button>
        )}

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
        <div
          ref={stickyBarRef}
          className={cn(
            'sticky bottom-0 z-20 -mx-4 mt-4 border-t border-border bg-background/95 px-4 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur',
            mode === 'doodle' && 'z-30',
          )}
        >
          {mode === 'editor' ? (
            <>
              <ClozeEditorBar
                count={card.keywords.length}
                brushActive={editorBrush}
                onAi={() => void handleAiCloze()}
                onBrush={() => {
                  setEditorBrush((v) => {
                    toast.info(v ? '已退出挖空刷' : '挖空刷：按住并滑过词语即可挖空')
                    return !v
                  })
                }}
                onRule={() => setRuleDialogOpen(true)}
                onTemplate={() => setTemplateDialogOpen(true)}
                onClearAll={handleClearAllKeywords}
              />
              <div className="mt-1.5 text-left text-[11px] text-muted-foreground/70">
                {settings.pageMode === 'paged' ? `${page + 1}/${pages?.length ?? 1}` : '1/1'}
              </div>
            </>
          ) : (
            <>
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
                            'flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs transition-colors',
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
                      'flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs transition-colors',
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
                    className="flex w-16 shrink-0 flex-col items-center gap-1 rounded-xl py-2 text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground active:scale-95"
                    onClick={() => {
                      // 朗读文本：打开工具面板前先说明本次播放使用的引擎
                      if (t.key === 'tts') {
                        toast.info(`朗读将使用：${ttsEngineLabel(settings)}`)
                      }
                      openTool(t.key)
                    }}
                  >
                    <Icon className="size-5" strokeWidth={1.75} />
                    <span className="text-[11px]">{t.label}</span>
                  </button>
                )
              })}
              <button
                type="button"
                className="flex w-16 shrink-0 flex-col items-center gap-1 rounded-xl py-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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

          {/* 熟悉/模糊/忘记 评分条 — 只在复习模式出现 */}
          {reviewMode && (
            <div className="mt-3">
              <ReviewScoreBar onScore={(a) => void handleScore(a)} />
            </div>
          )}

          {/* 今日计划 card — 默认折叠成一条细行，点击原位展开/收起（localStorage 持久化） */}
          <div className="mt-3 overflow-hidden rounded-2xl border border-border bg-card">
            <button
              type="button"
              aria-expanded={!planCollapsed}
              aria-controls="reader-plan-panel"
              onClick={() => setPlanCollapsed((v) => !v)}
              className="flex min-h-9 w-full items-center justify-between gap-2 px-4 py-1.5 text-left transition-colors hover:bg-accent/50"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-xs">
                <span className="shrink-0 font-bold">今日计划</span>
                <span className="shrink-0 text-muted-foreground/60">·</span>
                <span className="truncate text-muted-foreground">
                  已背 {Math.min(progress, goal)}/{goal} 词
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <span className="text-[11px] font-semibold text-emerald-600">{progressPct}%</span>
                {planCollapsed ? (
                  <ChevronDown className="size-4 text-muted-foreground" strokeWidth={1.75} />
                ) : (
                  <ChevronUp className="size-4 text-muted-foreground" strokeWidth={1.75} />
                )}
              </span>
            </button>
            {!planCollapsed && (
              <div id="reader-plan-panel" className="px-4 pb-4">
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
            )}
          </div>

          <div className="mt-1.5 text-left text-[11px] text-muted-foreground/70">
            {settings.pageMode === 'paged' ? `${page + 1}/${pages?.length ?? 1}` : '1/1'}
          </div>
            </>
          )}
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
          setMode((cur) => (cur === 'editor' ? null : 'editor'))
          toast.info('挖空编辑：长按选择文字挖空，点击已挖空的字取消')
        }}
        onBrushMode={() => {
          setMoreOpen(false)
          setMode((cur) => (cur === 'brush' ? null : 'brush'))
          toast.info('挖空刷：按住滑过一段文字，松手挖成一个空')
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

      {/* 本书复习算法配置（单卡覆盖全局默认） */}
      <AlgorithmConfigDialog
        open={bookAlgOpen}
        onOpenChange={setBookAlgOpen}
        scope="card"
        cardId={card.id}
        cardTitle={card.title}
      />

      {/* 目录/搜本书（顶部栏目录按钮） */}
      <TocSheet
        open={tocOpen}
        onOpenChange={setTocOpen}
        card={card}
        chunks={mode === 'chunk' && chunks && chunks.length > 0 ? chunks : null}
        onJump={(idx) => {
          const root = document
            .querySelector('section[aria-label="正文"]')
          if (!root) return
          if (mode === 'chunk') {
            const el = root.querySelector(`[data-toc-chunk="${idx}"]`)
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          } else {
            const els = root.querySelectorAll('[data-toc-para]')
            els[idx]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }
        }}
      />

      {/* 挖空显示样式（编辑模式顶栏入口） */}
      <ClozeStyleSheet
        open={styleOpen}
        onOpenChange={setStyleOpen}
        value={settings.clozeStyle}
        onChange={(s) => onChangeSettings({ clozeStyle: s })}
      />

      {/* 本书进度弹窗（截图9） */}
      <ProgressSheet
        open={progressOpen}
        onOpenChange={setProgressOpen}
        dueChapters={1}
        onOverview={() => onOpenOverview?.()}
        onPlan={() => onOpenPlanEditor?.()}
        onOpenReviewPlans={onOpenReviewPlans ? () => onOpenReviewPlans?.() : undefined}
      />

      {/* 规则挖空（编辑模式底部工具） */}
      <Dialog open={ruleDialogOpen} onOpenChange={setRuleDialogOpen}>
        <DialogContent className="rounded-2xl sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>规则挖空</DialogTitle>
            <DialogDescription>每隔 N 个词自动挖空一处</DialogDescription>
          </DialogHeader>
          <Select value={ruleStep} onValueChange={setRuleStep}>
            <SelectTrigger className="h-11 w-full rounded-xl">
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
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRuleDialogOpen(false)}>
              取消
            </Button>
            <Button
              className="rounded-full bg-primary"
              onClick={() => {
                setRuleDialogOpen(false)
                applyRuleCloze(Number(ruleStep))
              }}
            >
              应用
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 模版挖空（编辑模式底部工具） */}
      <Dialog open={templateDialogOpen} onOpenChange={setTemplateDialogOpen}>
        <DialogContent className="rounded-2xl sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>模版挖空</DialogTitle>
            <DialogDescription>按预设规则批量挖空关键词</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            {(
              [
                { key: 'sentence-start', label: '句首挖空', desc: '挖空每句开头的词' },
                { key: 'numbers', label: '数字挖空', desc: '挖空全部数字与百分比' },
                { key: 'rule3', label: '密集挖空', desc: '每隔 3 词挖空（适合古诗/密集记忆）' },
              ] as const
            ).map((tpl) => (
              <button
                key={tpl.key}
                type="button"
                className="flex flex-col items-start rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-accent"
                onClick={() => {
                  setTemplateDialogOpen(false)
                  applyTemplateCloze(tpl.key)
                }}
              >
                <span className="text-sm font-semibold">{tpl.label}</span>
                <span className="text-xs text-muted-foreground">{tpl.desc}</span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* 临时播放器朗读进度轻提示（选中文本朗读中，不拦截点击） */}
      {selReadProgress && (
        <div className="pointer-events-none fixed inset-x-0 bottom-24 z-30 flex justify-center px-4">
          <div className="max-w-full truncate rounded-full bg-emerald-600/95 px-3 py-1 text-xs text-white shadow-lg">
            正在朗读：{selReadProgress.text.slice(0, 12)}
            {selReadProgress.text.length > 12 ? '…' : ''}
          </div>
        </div>
      )}

      {/* 选区朗读临时播放器（主播放器未打开时也生效，取消即消失） */}
      <SelectionReadPlayer settings={settings} context="reader" />

      {/* AI 朗读 — 本地播放器（仅当未启用全局播放器时渲染；全局播放器由 page.tsx 挂载）。
          收起时 Sheet 关闭（forceMount 保活），迷你条 portal 到 body。 */}
      {!onStartTts && (
        <Sheet open={ttsOpen && !playerCollapsed} onOpenChange={(o) => { setTtsOpen(o); if (!o) setPlayerCollapsed(false) }}>
          <SheetContent
            side="bottom"
            forceMount
            className="flex h-[94dvh] flex-col rounded-t-3xl bg-background p-0"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>AI朗读</SheetTitle>
            </SheetHeader>
            <TtsPlayer
              text={card.content}
              settings={settings}
              context="reader"
              cardTitle={card.title}
              cardId={card.id}
              favoritesKey={card.id}
              collapsed={playerCollapsed}
              onCollapsedChange={setPlayerCollapsed}
              onClose={() => { setTtsOpen(false); setPlayerCollapsed(false) }}
            />
          </SheetContent>
        </Sheet>
      )}
    </>
  )
}
