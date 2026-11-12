'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import type { AccountData, CardData, KwEntry, Mastery, MaterialBlock, ProjectData, SettingsData } from '@/lib/types'
import { kwText, normKeywordEntries } from '@/lib/cloze'
import { extractClozeMarks } from '@/lib/editor-cloze'
import { playbackStart } from '@/lib/playback'
import type { ImportPayload } from '@/components/recitation/import-sheet'
import type { AiMarkOptions as AiMarkOptionsT } from '@/components/recitation/ai-mark-dialog'
import NextDynamic from 'next/dynamic'
import {
  Sheet as SheetGlobal,
  SheetContent as SheetContentGlobal,
  SheetHeader as SheetHeaderGlobal,
  SheetTitle as SheetTitleGlobal,
} from '@/components/ui/sheet'

// 全部视图与重型组件懒加载：拆小编译图，避免 dev 编译内存峰值触发 OOM。
const HomeView = NextDynamic(
  () => import('@/components/recitation/home-view').then((m) => m.HomeView),
  { ssr: false, loading: () => <PageSkeleton /> },
)
const ReaderView = NextDynamic(
  () => import('@/components/recitation/reader-view').then((m) => m.ReaderView),
  { ssr: false, loading: () => <PageSkeleton /> },
)
const ImportSheet = NextDynamic(
  () => import('@/components/recitation/import-sheet').then((m) => m.ImportSheet),
  { ssr: false },
)
const SettingsSheet = NextDynamic(
  () => import('@/components/recitation/settings-sheet').then((m) => m.SettingsSheet),
  { ssr: false },
)
const AccountSheet = NextDynamic(
  () => import('@/components/recitation/account-sheet').then((m) => m.AccountSheet),
  { ssr: false },
)
const ShareManagerView = NextDynamic(
  () => import('@/components/recitation/share-manager-view').then((m) => m.ShareManagerView),
  { ssr: false, loading: () => <PageSkeleton /> },
)
const ShareDialog = NextDynamic(
  () => import('@/components/recitation/share-dialog').then((m) => m.ShareDialog),
  { ssr: false },
)
const FocusFloatingClock = NextDynamic(
  () => import('@/components/recitation/focus-bus').then((m) => m.FocusFloatingClock),
  { ssr: false },
)
const WrongQuestionsView = NextDynamic(
  () => import('@/components/recitation/wrong-questions-view').then((m) => m.WrongQuestionsView),
  { ssr: false, loading: () => <PageSkeleton /> },
)
const QuizReportView = NextDynamic(
  () => import('@/components/recitation/quiz-report-view').then((m) => m.QuizReportView),
  { ssr: false, loading: () => <PageSkeleton /> },
)
const FavoritesView = NextDynamic(
  () => import('@/components/recitation/favorites-view').then((m) => m.FavoritesView),
  { ssr: false, loading: () => <PageSkeleton /> },
)
const ReviewStatsView = NextDynamic(
  () => import('@/components/recitation/review-stats-view').then((m) => m.ReviewStatsView),
  { ssr: false, loading: () => <PageSkeleton /> },
)
const AlgorithmStatsView = NextDynamic(
  () => import('@/components/recitation/algorithm-stats-view').then((m) => m.AlgorithmStatsView),
  { ssr: false, loading: () => <PageSkeleton /> },
)
const PlanEditorView = NextDynamic(
  () => import('@/components/recitation/plan-editor-view').then((m) => m.PlanEditorView),
  { ssr: false, loading: () => <PageSkeleton /> },
)
const PlanManagerView = NextDynamic(
  () => import('@/components/recitation/plan-manager-view').then((m) => m.PlanManagerView),
  { ssr: false, loading: () => <PageSkeleton /> },
)
const ReviewOverviewView = NextDynamic(
  () => import('@/components/recitation/review-overview-view').then((m) => m.ReviewOverviewView),
  { ssr: false, loading: () => <PageSkeleton /> },
)
const MaterialEditor = NextDynamic(
  () => import('@/components/recitation/material-editor').then((m) => m.MaterialEditor),
  { ssr: false, loading: () => <PageSkeleton /> },
)
const FocusApp = NextDynamic(
  () => import('@/components/recitation/focus-app').then((m) => m.FocusApp),
  { ssr: false, loading: () => <PageSkeleton /> },
)
const RecycleBinView = NextDynamic(
  () => import('@/components/recitation/recycle-bin-view').then((m) => m.RecycleBinView),
  { ssr: false, loading: () => <PageSkeleton /> },
)
const ReviewDueView = NextDynamic(
  () => import('@/components/recitation/review-due-view').then((m) => m.ReviewDueView),
  { ssr: false, loading: () => <PageSkeleton /> },
)
const CameraCapture = NextDynamic(
  () => import('@/components/recitation/camera-capture').then((m) => m.CameraCapture),
  { ssr: false, loading: () => null },
)
// 全局朗读播放器：挂载在 app 根，跨视图持续播放，收起后迷你条在任何界面都显示
const TtsPlayerGlobal = NextDynamic(
  () => import('@/components/recitation/tts-player').then((m) => m.TtsPlayer),
  { ssr: false, loading: () => null },
)
// 根级 AI 对话面板（主页底部 Dock「对话」按钮）：复用 ChatTool（AI问问 ask 模式）
const ChatToolGlobal = NextDynamic(
  () => import('@/components/recitation/chat-tool').then((m) => m.ChatTool),
  { ssr: false, loading: () => <div className="h-[60vh] animate-pulse rounded-xl bg-muted" /> },
)
// 全局迷你播放按钮（可拖拽、播放动画、所有页面常驻；待播放列表/冲突弹窗/跨设备同步）
const MiniPlayerFab = NextDynamic(
  () => import('@/components/recitation/mini-player-fab').then((m) => m.MiniPlayerFab),
  { ssr: false, loading: () => null },
)
// AI 对话侧边栏（对话列表/搜索/批量管理）
const ChatSidebar = NextDynamic(
  () => import('@/components/recitation/chat-sidebar').then((m) => m.ChatSidebar),
  { ssr: false },
)
// 全局追问弹层（选中文本 → AI 追问，新建独立对话或当前对话接续）
const FollowupPopover = NextDynamic(
  () => import('@/components/recitation/followup-popover').then((m) => m.FollowupPopover),
  { ssr: false, loading: () => null },
)
// 统一检索浮层（书本/文章/对话混合搜索 + 语音搜索）
const SearchOverlay = NextDynamic(
  () => import('@/components/recitation/search-overlay').then((m) => m.SearchOverlay),
  { ssr: false },
)
// AI 自动标记询问弹窗（导入创建前询问 / 新卡创建后询问）
const AiMarkDialog = NextDynamic(
  () => import('@/components/recitation/ai-mark-dialog').then((m) => m.AiMarkDialog),
  { ssr: false, loading: () => null },
)

function PageSkeleton() {
  return (
    <div className="mx-auto w-full max-w-2xl flex-1 px-4 pt-10">
      <div className="h-10 w-40 animate-pulse rounded-xl bg-muted" />
      <div className="mt-6 h-40 animate-pulse rounded-2xl bg-muted" />
    </div>
  )
}

type View =
  | 'home'
  | 'reader'
  | 'wrong'
  | 'report'
  | 'favorites'
  | 'review-stats'
  | 'review-due'
  | 'plan-editor'
  | 'review-overview'
  | 'plan-manager'
  | 'material-editor'
  | 'focus'
  | 'trash'
  | 'share-manager'

// blocks → 纯文本正文（front/back 拼接，块间空行），供挖空渲染与搜索使用
function blocksToContent(blocks: MaterialBlock[]): string {
  return blocks
    .map((b) => [b.front, b.back].filter((x) => x && x.trim()).join('\n'))
    .filter((x) => x.trim())
    .join('\n\n')
}

export default function Page() {
  const router = useRouter()
  const { setTheme } = useTheme()

  // 独立相机页：新标签页 /?cam=1 —— 预览面板/内嵌 iframe 拦截相机权限时的降级方案。
  // 拍摄裁剪完成后由 CameraCapture（standalone）postMessage 回传 opener 并自动关闭本页。
  const [standaloneCamera] = React.useState(
    () =>
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('cam') === '1',
  )

  const [view, setView] = React.useState<View>('home')
  const [cards, setCards] = React.useState<CardData[]>([])
  const [projects, setProjects] = React.useState<ProjectData[]>([])
  const [currentCard, setCurrentCard] = React.useState<CardData | null>(null)
  const [settings, setSettings] = React.useState<SettingsData | null>(null)
  const [loading, setLoading] = React.useState(true)
  // 复习总览：每张卡的掌握状态（进入视图时拉取）
  const [overviewStatuses, setOverviewStatuses] = React.useState<
    Record<string, { mastery: Mastery; chapters: number }>
  >({})
  // 待复习数量（侧边/主页胶囊）
  const [dueCount, setDueCount] = React.useState(0)
  // 主页当前项目过滤
  const [activeCategoryId, setActiveCategoryId] = React.useState('')

  // ---------- auth ----------
  const [authed, setAuthed] = React.useState(false)
  const [authLoading, setAuthLoading] = React.useState(true)
  const [account, setAccount] = React.useState<AccountData | null>(null)
  const [accountOpen, setAccountOpen] = React.useState(false)
  const dataLoadedRef = React.useRef(false)

  const [importOpen, setImportOpen] = React.useState(false)
  // 超级编辑器统一流程：create（新卡/导入内容）| edit（已有卡）
  const [editorMode, setEditorMode] = React.useState<'create' | 'edit' | null>(null)
  const [editorDraft, setEditorDraft] = React.useState<{
    title: string
    content: string
    blocks: MaterialBlock[]
  } | null>(null)
  const [editorTitle, setEditorTitle] = React.useState('')
  const [shareCard, setShareCard] = React.useState<CardData | null>(null)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  // 全局朗读播放器：ttsCard 非空即挂载；收起后 ttsCollapsed=true，迷你条跨视图常驻
  const [ttsCard, setTtsCard] = React.useState<CardData | null>(null)
  const [ttsCollapsed, setTtsCollapsed] = React.useState(false)
  // 根级 AI 对话 Sheet（主页底部 Dock「对话」按钮 onOpenChat）
  const [chatRootOpen, setChatRootOpen] = React.useState(false)
  // 统一检索浮层（主页搜索 pill / 'app:openSearch'）
  const [searchOpen, setSearchOpen] = React.useState(false)
  // AI 对话侧边栏 + 当前活动对话（对话模式 ChatTool 绑定）
  const [chatSidebarOpen, setChatSidebarOpen] = React.useState(false)
  const [activeConvId, setActiveConvId] = React.useState<string | null>(null)
  // FSRS 算法统计仪表盘全屏覆盖（从复习统计页 / 待复习页进入）
  const [algStatsOpen, setAlgStatsOpen] = React.useState(false)

  // 主对话「AI问问」：登录后 ensure-main（不存在则创建，isMain/pinned/ord=-1000000），
  // activeConvId 为空时默认绑定主对话 —— 用户未选其他对话时，主页 AI问问 发出的
  // 消息进入主对话（仅可清空消息，不可删除/改名/整对话分享）。
  const mainConvEnsuredRef = React.useRef(false)
  React.useEffect(() => {
    if (!authed || mainConvEnsuredRef.current) return
    mainConvEnsuredRef.current = true
    void (async () => {
      try {
        const res = await fetch('/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'ensure-main' }),
        })
        if (!res.ok) return
        const data = (await res.json()) as { conversation?: { id?: string } }
        const id = data.conversation?.id
        if (id) setActiveConvId((prev) => prev ?? id)
      } catch {
        /* 静默：主对话创建失败不影响其他功能 */
      }
    })()
  }, [authed])

  // 分享页「追问」跳转：/?conv=<id> → 打开该对话（地址栏参数消费后清除）
  React.useEffect(() => {
    try {
      const u = new URL(window.location.href)
      const convId = u.searchParams.get('conv')
      if (convId) {
        setActiveConvId(convId)
        setChatSidebarOpen(false)
        setChatRootOpen(true)
        u.searchParams.delete('conv')
        const qs = u.searchParams.toString()
        window.history.replaceState(null, '', u.pathname + (qs ? `?${qs}` : ''))
      }
    } catch {
      /* ignore */
    }
  }, [])

  const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // ---------- initial data load (cards + settings + projects) ----------
  const loadInitialData = React.useCallback(async () => {
    setLoading(true)
    try {
      const [cardsRes, settingsRes, projectsRes] = await Promise.all([
        fetch('/api/cards').then((r) => r.json()),
        fetch('/api/settings').then((r) => r.json()),
        fetch('/api/projects').then((r) => r.json()).catch(() => ({ projects: [] })),
      ])
      setCards(((cardsRes && cardsRes.cards) as CardData[]) || [])
      const s = settingsRes as SettingsData | null
      setSettings(s || null)
      if (s?.theme) setTheme(s.theme)
      setProjects(((projectsRes && projectsRes.projects) as ProjectData[]) || [])
    } catch (err) {
      toast.error('加载数据失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setLoading(false)
    }
  }, [setTheme])

  // 待复习数量：/api/review/due（有复习记录且未被忽略/延后提醒的卡片数）
  React.useEffect(() => {
    if (!authed) return
    fetch('/api/review/due')
      .then((r) => (r.ok ? r.json() : { cards: [] }))
      .then((res: { cards?: { id: string }[] }) => {
        setDueCount(res?.cards?.length ?? 0)
      })
      .catch(() => {})
  }, [authed, cards])

  // ---------- auth bootstrap ----------
  React.useEffect(() => {
    let alive = true
    // Legacy ?share= links redirect to the standalone /share/[token] route.
    const shareParam = new URLSearchParams(window.location.search).get('share')
    if (shareParam) {
      router.replace(`/share/${encodeURIComponent(shareParam)}`)
      return
    }

    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((res) => {
        if (!alive) return
        if (res?.account) {
          setAccount(res.account as AccountData)
          setAuthed(true)
        } else {
          router.replace('/login')
        }
      })
      .catch(() => {
        if (alive) router.replace('/login')
      })
      .finally(() => {
        if (alive) setAuthLoading(false)
      })

    return () => {
      alive = false
    }
  }, [router])

  // Load cards/settings once authed.
  React.useEffect(() => {
    if (!authed || dataLoadedRef.current) return
    dataLoadedRef.current = true
    void loadInitialData()
  }, [authed, loadInitialData])

  // Cleanup the debounced card-save timer on unmount.
  React.useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  // ---------- logout ----------
  const handleLogout = React.useCallback(() => {
    void fetch('/api/auth/logout', { method: 'POST' })
      .catch(() => {})
      .finally(() => {
        dataLoadedRef.current = false
        setAccount(null)
        setAuthed(false)
        setCards([])
        setProjects([])
        setCurrentCard(null)
        setView('home')
        setSettingsOpen(false)
        setAccountOpen(false)
        try {
          window.localStorage.removeItem('focus-bus-state-v1')
        } catch {
          /* ignore */
        }
        router.replace('/login')
      })
  }, [router])

  // ---------- 超级编辑器：blocks 保存（新建 / 编辑统一入口） ----------
  const persistEditorSave = React.useCallback(
    async (blocks: MaterialBlock[]) => {
      const rawContent = blocksToContent(blocks)
      const fallbackContent = editorDraft?.content ?? ''
      const { content: cleanContent, keywords: marks } = extractClozeMarks(
        rawContent || fallbackContent,
      )
      const content = cleanContent.trim() || fallbackContent.trim()
      if (!content) {
        toast.error('内容为空，无法保存')
        return
      }
      const title = (editorTitle || editorDraft?.title || '').trim() || '未命名卡片'

      if (editorMode === 'edit' && currentCard) {
        // 编辑已有卡：保留仍存在于正文中的旧挖空 + 新的 {{}} 标记（按 位置+词 去重）
        const seen = new Set<string>()
        const merged: KwEntry[] = []
        for (const e of [...normKeywordEntries(currentCard.keywords), ...normKeywordEntries(marks)]) {
          if (!content.includes(kwText(e))) continue
          const key = typeof e === 'string' ? e : `${e.t}\u0000${e.occ}`
          if (seen.has(key)) continue
          seen.add(key)
          merged.push(e)
        }
        const keywords = merged
        const tid = toast.loading('正在保存修改…')
        try {
          const res = await fetch(`/api/cards/${encodeURIComponent(currentCard.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, content, keywords, blocks }),
          })
          if (!res.ok) {
            const err = await res.json().catch(() => ({}))
            throw new Error(err.error || '保存失败')
          }
          const saved = (await res.json()) as CardData
          setCards((prev) => prev.map((c) => (c.id === saved.id ? saved : c)))
          setCurrentCard(saved)
          setView('reader')
          toast.success('已保存修改', { id: tid })
        } catch (err) {
          toast.error('保存失败：' + (err instanceof Error ? err.message : '未知错误'), { id: tid })
        }
        return
      }

      // 新建卡片
      const tid = toast.loading('正在创建背书卡…')
      try {
        const res = await fetch('/api/cards', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            content,
            keywords: marks,
            blocks,
            categoryId:
              activeCategoryId && activeCategoryId !== 'recent' && activeCategoryId !== 'uncategorized'
                ? activeCategoryId
                : undefined,
          }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || '创建失败')
        }
        let created = (await res.json()) as CardData
        setCards((prev) => [created, ...prev])
        setEditorMode(null)
        setEditorDraft(null)
        setView('reader')
        toast.success('已创建背书卡，开始背诵吧！', { id: tid })
        // 创建后询问：是否 AI 自动标记（直接输入内容等未经导入询问的路径；导入路径已问过不再重复）
        if (!importMarkAskedRef.current && marks.length === 0 && content.length >= 20) {
          setAiMarkPayload(null)
          setAiMarkCard(created)
          setAiMarkOpen(true)
        }
        importMarkAskedRef.current = false
        setCurrentCard(created)
      } catch (err) {
        toast.error('创建失败：' + (err instanceof Error ? err.message : '未知错误'), { id: tid })
      }
    },
    [editorDraft, editorTitle, editorMode, currentCard, settings, activeCategoryId],
  )

  // ---------- 导入时询问：是否 AI 自动标记（上传文件/粘贴文本/拍照/图片识别全部路径） ----------
  const [aiMarkOpen, setAiMarkOpen] = React.useState(false)
  const [aiMarkLoading, setAiMarkLoading] = React.useState(false)
  /** 导入链路待标记的 payload；创建后链路为 null（用 aiMarkCard） */
  const [aiMarkPayload, setAiMarkPayload] = React.useState<ImportPayload | null>(null)
  /** 创建后询问的目标卡（直接输入内容路径） */
  const [aiMarkCard, setAiMarkCard] = React.useState<CardData | null>(null)
  /** 本次导入是否已问过（编辑器保存后不再重复问） */
  const importMarkAskedRef = React.useRef(false)

  const aiMarkDefaults = React.useMemo(
    () => ({
      cloze: settings?.aiAutoCloze ?? true,
      highlight: settings?.aiAutoHighlight ?? true,
      media: settings?.aiAutoMedia ?? true,
    }),
    [settings?.aiAutoCloze, settings?.aiAutoHighlight, settings?.aiAutoMedia],
  )

  /** 导入路径确认：先（可选）AI 智能排版，再 AI 标记，带标记内容+分块进入编辑器 */
  const handleAiMarkConfirm = React.useCallback(
    async (options: AiMarkOptionsT) => {
      const payload = aiMarkPayload
      if (!payload) return
      setAiMarkLoading(true)
      // 阶段 1（可选）：AI 智能排版 — 整理段落/标题层级/列表（原文逐字保留）；失败不中断，用原文继续
      let workingContent = payload.content
      if (options.format) {
        const fid = toast.loading('AI 智能排版中…')
        try {
          const res = await fetch('/api/autoformat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: payload.content }),
          })
          const data = (await res.json().catch(() => ({}))) as { content?: string; error?: string }
          if (!res.ok || !data.content) throw new Error(data.error || 'AI 排版失败')
          workingContent = data.content
          toast.success('AI 排版完成', { id: fid })
        } catch (err) {
          toast.error((err instanceof Error ? err.message : 'AI 排版失败') + '，将继续使用原文', {
            id: fid,
          })
        }
      }
      // 阶段 2：AI 自动标记（标记 + 语义分块）
      const tid = toast.loading('AI 正在标记导入内容…')
      try {
        const res = await fetch('/api/automark', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: workingContent,
            title: payload.title,
            options,
          }),
        })
        const data = (await res.json().catch(() => ({}))) as {
          content?: string
          blocks?: { front: string; back: string }[]
          error?: string
          truncated?: boolean
        }
        if (!res.ok || (!data.content && !(data.blocks && data.blocks.length > 0))) throw new Error(data.error || 'AI 标记失败')
        setAiMarkOpen(false)
        setImportOpen(false)
        setEditorMode('create')
        setEditorTitle(payload.title || '')
        setEditorDraft({
          title: payload.title || '',
          content: data.content || (data.blocks ?? []).map((b) => b.back).join('\n\n'),
          blocks: (data.blocks ?? []).map((b) => ({
            front: b.front ?? '',
            back: b.back ?? '',
          })),
        })
        setView('material-editor')
        toast.success(
          data.truncated
            ? '内容较长，AI 已标记前 6000 字，可在编辑器继续手动标记'
            : 'AI 标记完成，可在编辑器继续调整',
          { id: tid },
        )
      } catch (err) {
        toast.error(
          (err instanceof Error ? err.message : 'AI 标记失败') + '；已改为直接导入',
          { id: tid },
        )
        // 失败回退：不标记直接进编辑器（排版成功时保留排版结果）
        setAiMarkOpen(false)
        setImportOpen(false)
        setEditorMode('create')
        setEditorTitle(payload.title || '')
        setEditorDraft({ title: payload.title || '', content: workingContent, blocks: [] })
        setView('material-editor')
      } finally {
        setAiMarkLoading(false)
        setAiMarkPayload(null)
      }
    },
    [aiMarkPayload],
  )

  /** 跳过：不标记直接进编辑器（原导入行为） */
  const handleAiMarkSkip = React.useCallback(() => {
    setAiMarkOpen(false)
    const payload = aiMarkPayload
    setAiMarkPayload(null)
    if (!payload) return
    setImportOpen(false)
    setEditorMode('create')
    setEditorTitle(payload.title || '')
    setEditorDraft({ title: payload.title || '', content: payload.content, blocks: [] })
    setView('material-editor')
  }, [aiMarkPayload])

  /** 创建后路径确认：对已建卡执行 AI 标记并回写（直接输入内容等未经导入询问的路径） */
  const handleAiMarkCardConfirm = React.useCallback(
    async (options: AiMarkOptionsT) => {
      const card = aiMarkCard
      if (!card) return
      setAiMarkLoading(true)
      const tid = toast.loading(`AI 正在标记「${card.title}」…`)
      try {
        const res = await fetch('/api/automark', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: card.content, title: card.title, options }),
        })
        const data = (await res.json().catch(() => ({}))) as {
          content?: string
          blocks?: { front: string; back: string }[]
          error?: string
        }
        if (!res.ok || (!data.content && !(data.blocks && data.blocks.length > 0))) throw new Error(data.error || 'AI 标记失败')
        const { content, keywords } = extractClozeMarks(data.content)
        const blocks: MaterialBlock[] =
          data.blocks && data.blocks.length > 0
            ? data.blocks.map((b) => ({ front: b.front ?? '', back: b.back ?? '' }))
            : (card.blocks ?? [])
        const res2 = await fetch(`/api/cards/${encodeURIComponent(card.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: content.trim() || card.content,
            keywords,
            blocks,
          }),
        })
        if (!res2.ok) {
          const err = await res2.json().catch(() => ({}))
          throw new Error((err as { error?: string }).error || '保存失败')
        }
        const saved = (await res2.json()) as CardData
        setCards((prev) => prev.map((c) => (c.id === saved.id ? saved : c)))
        setCurrentCard((cur) => (cur && cur.id === saved.id ? saved : cur))
        setAiMarkOpen(false)
        toast.success('AI 标记完成，开始背诵吧！', { id: tid })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'AI 标记失败', { id: tid })
      } finally {
        setAiMarkLoading(false)
        setAiMarkCard(null)
      }
    },
    [aiMarkCard],
  )

  // ---------- 兼容旧 ImportSheet onImport（文件/图片/粘贴导入 → 询问 AI 标记 → 超级编辑器） ----------
  const handleImport = React.useCallback(
    (payload: ImportPayload) => {
      setImportOpen(false)
      importMarkAskedRef.current = true
      // 内容足够长才询问（超短内容标记意义不大，直接进编辑器）
      if (payload.content.trim().length >= 20) {
        setAiMarkCard(null)
        setAiMarkPayload(payload)
        setAiMarkOpen(true)
        return
      }
      setEditorMode('create')
      setEditorTitle(payload.title || '')
      setEditorDraft({
        title: payload.title || '',
        content: payload.content,
        blocks: [],
      })
      setView('material-editor')
    },
    [],
  )

  const handleUpdateCard = React.useCallback((next: CardData) => {
    // Optimistic local update, then debounced PATCH (700ms) persisting
    // title/content/keywords/strokes/plan/mindmaps/blocks/categoryId/pinned.
    setCurrentCard((cur) => (cur && cur.id === next.id ? next : cur))
    setCards((prev) => prev.map((c) => (c.id === next.id ? next : c)))
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/cards/${encodeURIComponent(next.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: next.title,
            content: next.content,
            keywords: next.keywords,
            strokes: next.strokes,
            plan: next.plan,
            mindmaps: next.mindmaps,
            blocks: next.blocks,
            categoryId: next.categoryId,
            pinned: next.pinned,
            ord: next.ord,
          }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || '保存失败')
        }
        const saved = (await res.json()) as CardData
        setCurrentCard((cur) => (cur && cur.id === saved.id ? saved : cur))
        setCards((prev) => prev.map((c) => (c.id === saved.id ? saved : c)))
      } catch (err) {
        toast.error('自动保存失败：' + (err instanceof Error ? err.message : '未知错误'))
      }
    }, 700)
  }, [])

  const handleDelete = React.useCallback(async (id: string) => {
    const tid = toast.loading('正在删除…')
    try {
      const res = await fetch(`/api/cards/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '删除失败')
      }
      setCards((prev) => prev.filter((c) => c.id !== id))
      setCurrentCard((cur) => (cur && cur.id === id ? null : cur))
      toast.success('已移入回收站', { id: tid })
    } catch (err) {
      toast.error('删除失败：' + (err instanceof Error ? err.message : '未知错误'), { id: tid })
    }
  }, [])

  const handleBatchDelete = React.useCallback(async (ids: string[]) => {
    const tid = toast.loading(`正在删除 ${ids.length} 张…`)
    try {
      await Promise.all(
        ids.map((id) =>
          fetch(`/api/cards/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) => {
            if (!r.ok) throw new Error('删除失败')
          }),
        ),
      )
      setCards((prev) => prev.filter((c) => !ids.includes(c.id)))
      toast.success(`已把 ${ids.length} 张卡片移入回收站`, { id: tid })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败', { id: tid })
    }
  }, [])

  const handleBatchMove = React.useCallback(
    (ids: string[], categoryId: string) => {
      const targets = cards.filter((c) => ids.includes(c.id))
      targets.forEach((c) => handleUpdateCard({ ...c, categoryId }))
      toast.success(`已移动 ${ids.length} 张卡片`)
    },
    [cards, handleUpdateCard],
  )

  const handleDuplicateCard = React.useCallback(
    async (card: CardData, categoryId?: string) => {
      const tid = toast.loading('正在创建副本…')
      try {
        const res = await fetch('/api/cards', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: `${card.title} 副本`,
            content: card.content,
            keywords: card.keywords,
            blocks: card.blocks,
            ...(typeof categoryId === 'string' ? { categoryId } : {}),
          }),
        })
        if (!res.ok) throw new Error('创建失败')
        const created = (await res.json()) as CardData
        setCards((prev) => [created, ...prev])
        toast.success('已创建副本', { id: tid })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '创建失败', { id: tid })
      }
    },
    [],
  )

  const handleReorderCards = React.useCallback(
    (ids: string[]) => {
      // 本地先应用 ord，再逐卡 PATCH
      const ordMap = new Map(ids.map((id, i) => [id, i + 1]))
      setCards((prev) =>
        prev.map((c) => (ordMap.has(c.id) ? { ...c, ord: ordMap.get(c.id)! } : c)),
      )
      Promise.all(
        ids.map((id, i) =>
          fetch(`/api/cards/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ord: i + 1 }),
          }),
        ),
      ).catch(() => toast.error('排序保存失败'))
    },
    [],
  )

  // ---------- projects CRUD ----------
  const handleCreateProject = React.useCallback(async (name: string) => {
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '创建失败')
      }
      const project = (await res.json()) as ProjectData
      setProjects((prev) => [...prev, project])
      toast.success(`项目「${name}」已创建`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败')
    }
  }, [])

  const handleRenameProject = React.useCallback(async (id: string, name: string) => {
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p)))
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error('重命名失败')
      toast.success('项目已重命名')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重命名失败')
    }
  }, [])

  const handleDeleteProject = React.useCallback(
    async (id: string) => {
      try {
        const moveTo = moveTargetRef.current === '__uncat__' ? '' : moveTargetRef.current
        const res = await fetch(
          `/api/projects/${encodeURIComponent(id)}?moveTo=${encodeURIComponent(moveTo)}`,
          { method: 'DELETE' },
        )
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || '删除失败')
        }
        setProjects((prev) => prev.filter((p) => p.id !== id))
        setCards((prev) =>
          prev.map((c) => (c.categoryId === id ? { ...c, categoryId: moveTo } : c)),
        )
        toast.success('项目已删除，卡片已移动')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '删除失败')
      }
    },
    [],
  )
  const moveTargetRef = React.useRef('__uncat__')

  const handleMoveProject = React.useCallback(async (id: string, dir: -1 | 1) => {
    setProjects((prev) => {
      const i = prev.findIndex((p) => p.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      void fetch('/api/projects', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: next.map((p) => p.id) }),
      }).catch(() => {})
      return next
    })
  }, [])

  // ---------- 清空全部数据（设置页） ----------
  const handleClearAll = React.useCallback(async () => {
    const tid = toast.loading('正在清空全部数据…')
    try {
      const res = await fetch('/api/cards', { method: 'DELETE' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '清空失败')
      }
      setCards([])
      setCurrentCard(null)
      setView('home')
      toast.success('已清空全部背书卡', { id: tid })
    } catch (err) {
      toast.error('清空失败：' + (err instanceof Error ? err.message : '未知错误'), { id: tid })
    }
  }, [])

  // ---------- settings ----------
  const handleChangeSettings = React.useCallback(
    (patch: Partial<SettingsData>) => {
      setSettings((prev) => (prev ? { ...prev, ...patch } : prev))
      if (patch.theme) setTheme(patch.theme)
      void fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).catch(() => {
        toast.error('设置保存失败，请重试')
      })
    },
    [setTheme],
  )

  // ---------- navigation ----------
  const handleOpenCard = React.useCallback((card: CardData) => {
    setCurrentCard(card)
    setView('reader')
  }, [])

  const handleBack = React.useCallback(() => {
    setView('home')
    setCurrentCard(null)
  }, [])

  // 计划管理（本书进度弹窗 → 制作背书计划）
  const handleOpenPlanEditor = React.useCallback(() => {
    if (currentCard) setView('plan-editor')
  }, [currentCard])

  // 背书页「编辑内容」→ 超级编辑器
  const handleEditContent = React.useCallback(() => {
    if (!currentCard) return
    setEditorMode('edit')
    setEditorTitle(currentCard.title)
    setEditorDraft({
      title: currentCard.title,
      content: currentCard.content,
      blocks: currentCard.blocks ?? [],
    })
    setView('material-editor')
  }, [currentCard])

  const handleNewCard = React.useCallback(() => {
    setEditorMode('create')
    setEditorTitle('')
    setEditorDraft({ title: '', content: '', blocks: [] })
    setView('material-editor')
  }, [])

  // 复习总览：拉取每卡掌握状态
  React.useEffect(() => {
    if (view !== 'review-overview') return
    const ctrl = new AbortController()
    fetch(`/api/review?perCard=1&tzOffset=${new Date().getTimezoneOffset()}`, {
      signal: ctrl.signal,
    })
      .then((r) => r.json())
      .then((res: { statuses?: Record<string, string> }) => {
        const map: Record<string, { mastery: Mastery; chapters: number }> = {}
        for (const c of cards) {
          const a = res?.statuses?.[c.id]
          map[c.id] = {
            mastery:
              a === 'familiar' || a === 'fuzzy' || a === 'forget' ? a : 'none',
            chapters: 1,
          }
        }
        setOverviewStatuses(map)
      })
      .catch(() => {})
    return () => ctrl.abort()
  }, [view, cards])

  const handleCancelImport = React.useCallback(() => {
    setImportOpen(false)
  }, [])

  // 浮时钟「全屏计时」事件 → 进入专注视图
  React.useEffect(() => {
    const onOpenFocus = () => setView('focus')
    window.addEventListener('sb-open-focus', onOpenFocus)
    return () => window.removeEventListener('sb-open-focus', onOpenFocus)
  }, [])

  // 语音偏好变更事件（聊天工具等派发）→ 同步本地 settings 状态
  React.useEffect(() => {
    const onVoicePrefs = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { context: string; tts?: unknown; asr?: unknown }
        | undefined
      if (!detail?.context) return
      setSettings((prev) => {
        if (!prev) return prev
        const prefs = { ...(prev.voicePrefs || {}) }
        const cur = { ...(prefs[detail.context] || {}) }
        if (detail.tts) cur.tts = detail.tts as never
        if (detail.asr) cur.asr = detail.asr as never
        prefs[detail.context] = cur
        return { ...prev, voicePrefs: prefs }
      })
    }
    window.addEventListener('sb-voice-prefs-changed', onVoicePrefs)
    return () => window.removeEventListener('sb-voice-prefs-changed', onVoicePrefs)
  }, [])

  // ---------- 全局事件接线（新模块） ----------
  // cards 稳定引用：事件回调里找卡不重新绑监听
  const cardsRef = React.useRef(cards)
  React.useEffect(() => {
    cardsRef.current = cards
  }, [cards])

  // 主页搜索 pill → 打开统一检索浮层；ChatTool 侧边栏按钮 → 切换侧边栏
  React.useEffect(() => {
    const onOpenSearch = () => setSearchOpen(true)
    const onToggleSidebar = () => setChatSidebarOpen((v) => !v)
    window.addEventListener('app:openSearch', onOpenSearch)
    window.addEventListener('app:toggleChatSidebar', onToggleSidebar)
    return () => {
      window.removeEventListener('app:openSearch', onOpenSearch)
      window.removeEventListener('app:toggleChatSidebar', onToggleSidebar)
    }
  }, [])

  // 检索/追问跳转：打开某本书（reader=阅读视图 / blocks=超级编辑器）；打开某对话
  React.useEffect(() => {
    const onOpenCardEvt = (e: Event) => {
      const d = (e as CustomEvent<{ cardId: string; target?: 'reader' | 'blocks' }>).detail
      if (!d?.cardId) return
      const card = cardsRef.current.find((c) => c.id === d.cardId)
      if (!card) {
        toast.error('书本不存在或已删除')
        return
      }
      if (d.target === 'blocks') {
        setEditorMode('edit')
        setEditorTitle(card.title)
        setEditorDraft({ title: card.title, content: card.content, blocks: card.blocks ?? [] })
        setView('material-editor')
      } else {
        setCurrentCard(card)
        setView('reader')
      }
      setSearchOpen(false)
    }
    const onOpenConv = (e: Event) => {
      const d = (e as CustomEvent<{ id: string }>).detail
      if (!d?.id) return
      setActiveConvId(d.id)
      setChatSidebarOpen(false)
      setSearchOpen(false)
      setChatRootOpen(true)
    }
    window.addEventListener('app:openCard', onOpenCardEvt)
    window.addEventListener('app:openConversation', onOpenConv)
    return () => {
      window.removeEventListener('app:openCard', onOpenCardEvt)
      window.removeEventListener('app:openConversation', onOpenConv)
    }
  }, [])

  // 迷你播放器/播放列表/冲突替换/自动连播 → 打开完整播放器
  React.useEffect(() => {
    const onOpenTts = (e: Event) => {
      const d = (e as CustomEvent<{ cardId: string; title: string; text: string; expand?: boolean }>).detail
      if (!d?.cardId) return
      const card = cardsRef.current.find((c) => c.id === d.cardId)
      if (!card) return
      setTtsCard(d.text && d.text !== card.content ? { ...card, content: d.text } : card)
      if (d.expand !== false) setTtsCollapsed(false)
    }
    window.addEventListener('app:openTtsPlayer', onOpenTts)
    return () => window.removeEventListener('app:openTtsPlayer', onOpenTts)
  }, [])

  // 当前活动对话变化 → 通知追问弹层（source=chat 时在当前对话接续）
  React.useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('app:currentConversation', { detail: { id: activeConvId } }),
    )
  }, [activeConvId])

  // ---------- gated rendering ----------
  // 独立相机页：跳过登录门控（新标签页共享同源会话），全屏相机 + 拍完自动回传关闭
  if (standaloneCamera) {
    return (
      <div className="fixed inset-0 z-50 bg-black" aria-label="独立相机页">
        <CameraCapture
          open
          standalone
          mode="photo"
          onOpenChange={() => {
            try {
              window.close()
            } catch {
              /* 某些环境不允许脚本关闭，忽略 */
            }
          }}
          onText={() => {}}
          onPhoto={() => {
            /* standalone 模式内部已 postMessage 给 opener 并 window.close() */
          }}
        />
      </div>
    )
  }

  if (authLoading || !authed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
      </div>
    )
  }

  // 超级编辑器的草稿卡（新建时没有真实 CardData）
  const draftCard: CardData = {
    id: editorMode === 'edit' && currentCard ? currentCard.id : '__draft__',
    title: editorDraft?.title ?? '',
    content: editorDraft?.content ?? '',
    keywords: [],
    strokes: [],
    plan: null,
    mindmaps: [],
    blocks: editorDraft?.blocks ?? [],
    categoryId: '',
    pinned: false,
    ord: 0,
    deletedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  // 根级 AI 对话的上下文卡：优先当前卡；返回主页时 handleBack 会清空 currentCard，
  // 此时回退到列表第一张有内容的卡（/api/chat 要求课文非空，空内容无法发送）。
  const chatRootCard: CardData | null =
    currentCard && currentCard.content.trim()
      ? currentCard
      : cards.find((c) => c.content.trim()) ?? null

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {view === 'home' && account ? (
        <HomeView
          cards={cards}
          projects={projects}
          loading={loading}
          account={account}
          dueCount={dueCount}
          activeCategoryId={activeCategoryId}
          onActiveCategoryChange={setActiveCategoryId}
          onOpenCard={handleOpenCard}
          onNew={handleNewCard}
          onOpenImport={() => setImportOpen(true)}
          onOpenReviewDue={() => setView('review-due')}
          onOpenCalendar={() => setView('review-stats')}
          onOpenChat={() => setChatRootOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenAccount={() => setAccountOpen(true)}
          onLogout={handleLogout}
          onShareCard={(c) => setShareCard(c)}
          onRenameCard={(c, title) => {
            handleUpdateCard({ ...c, title })
            toast.success('已重命名')
          }}
          onTogglePin={(c) => {
            handleUpdateCard({ ...c, pinned: !c.pinned })
            toast.success(c.pinned ? '已取消置顶' : '已置顶')
          }}
          onMoveCard={(c, categoryId) => handleUpdateCard({ ...c, categoryId })}
          onDuplicateCard={(c, categoryId) => void handleDuplicateCard(c, categoryId)}
          onDeleteCard={(id) => void handleDelete(id)}
          onBatchDelete={(ids) => void handleBatchDelete(ids)}
          onBatchMove={handleBatchMove}
          onReorderCards={handleReorderCards}
          onCreateProject={(name) => void handleCreateProject(name)}
          onRenameProject={(id, name) => void handleRenameProject(id, name)}
          onDeleteProject={(id) => void handleDeleteProject(id)}
          onMoveProject={handleMoveProject}
          onOpenWrong={() => setView('wrong')}
          onOpenReport={() => setView('report')}
          onOpenFavorites={() => setView('favorites')}
          onOpenReviewStats={() => setView('review-stats')}
          onOpenFocus={() => setView('focus')}
          onOpenTrash={() => setView('trash')}
          onOpenPlans={() => setView('plan-manager')}
          onOpenShareManager={() => setView('share-manager')}
        />
      ) : view === 'reader' && currentCard && settings ? (
        <ReaderView
          key={currentCard.id}
          card={currentCard}
          settings={settings}
          onUpdateCard={handleUpdateCard}
          onChangeSettings={handleChangeSettings}
          onBack={handleBack}
          onEditContent={handleEditContent}
          onOpenMaterialEditor={handleEditContent}
          onOpenOverview={() => setView('review-overview')}
          onOpenPlanEditor={handleOpenPlanEditor}
          onOpenReviewPlans={() => setView('plan-manager')}
          onStartTts={(c) => {
            // 换书播放冲突：播放中点另一本 → 迷你播放器弹窗（替换/加入待播放列表/取消）
            const res = playbackStart(c)
            if (res === 'started') {
              setTtsCard(c)
              setTtsCollapsed(false)
            }
          }}
        />
      ) : view === 'wrong' ? (
        <WrongQuestionsView onBack={() => setView('home')} />
      ) : view === 'report' ? (
        <QuizReportView onBack={() => setView('home')} />
      ) : view === 'favorites' ? (
        <FavoritesView onBack={() => setView('home')} />
      ) : view === 'review-stats' ? (
        <ReviewStatsView
          onBack={() => setView('home')}
          onOpenPlanManager={() => setView('plan-manager')}
          onOpenAlgorithmStats={() => setAlgStatsOpen(true)}
        />
      ) : view === 'review-due' ? (
        <ReviewDueView
          onBack={() => setView('home')}
          onOpenCard={(id) => {
            const c = cards.find((x) => x.id === id)
            if (c) handleOpenCard(c)
          }}
        />
      ) : view === 'plan-editor' && currentCard ? (
        <PlanEditorView
          card={currentCard}
          mastered={0}
          learned={0}
          onBack={() => setView('reader')}
          onConfirm={(plan) => {
            if (currentCard) {
              handleUpdateCard({ ...currentCard, plan })
              toast.success(
                `计划已保存：新学 ${plan.dailyNew} 章/日 · 复习 ${plan.reviewTimes} 遍`,
              )
            }
            setView('reader')
          }}
        />
      ) : view === 'plan-manager' ? (
        <PlanManagerView onBack={() => setView('home')} />
      ) : view === 'material-editor' && editorMode ? (
        <MaterialEditor
          key={draftCard.id}
          card={draftCard}
          onBack={() => {
            setEditorMode(null)
            setEditorDraft(null)
            setView('home')
          }}
          onTitleChange={setEditorTitle}
          onSave={(blocks: MaterialBlock[]) => {
            void persistEditorSave(blocks)
          }}
        />
      ) : view === 'focus' ? (
        <FocusApp onBack={() => setView('home')} />
      ) : view === 'trash' ? (
        <RecycleBinView onBack={() => setView('home')} />
      ) : view === 'share-manager' ? (
        <ShareManagerView onBack={() => setView('home')} />
      ) : view === 'review-overview' ? (
        <ReviewOverviewView
          cards={cards}
          statuses={overviewStatuses}
          onBack={() => setView(currentCard ? 'reader' : 'home')}
          onOpenCard={(c) => {
            setCurrentCard(c)
            setView('reader')
          }}
          onNew={handleNewCard}
        />
      ) : null}

      {/* FSRS 算法统计仪表盘全屏覆盖（从复习统计页头部 / 待复习页进入） */}
      {algStatsOpen && (
        <AlgorithmStatsView
          onBack={() => setAlgStatsOpen(false)}
          onOpenCard={(id) => {
            const c = cards.find((x) => x.id === id)
            if (c) {
              setAlgStatsOpen(false)
              handleOpenCard(c)
            }
          }}
        />
      )}

      {importOpen && (
        <ImportSheet
          open={importOpen}
          onOpenChange={(open) => {
            if (!open) handleCancelImport()
            else setImportOpen(true)
          }}
          initialDraft={null}
          editing={false}
          onImport={handleImport}
          onCancel={handleCancelImport}
          onDirectEdit={handleNewCard}
        />
      )}

      {/* AI 自动标记询问（导入创建前 / 新卡创建后，两种模式共用） */}
      <AiMarkDialog
        open={aiMarkOpen}
        onOpenChange={(o) => {
          if (!o && !aiMarkLoading) {
            if (aiMarkPayload) handleAiMarkSkip()
            else {
              setAiMarkOpen(false)
              setAiMarkCard(null)
            }
          }
        }}
        defaultOptions={aiMarkDefaults}
        defaultFormat={settings?.aiAutoFormat ?? false}
        loading={aiMarkLoading}
        context="import"
        contentPreview={aiMarkPayload?.content ?? aiMarkCard?.content ?? undefined}
        onConfirm={(o) => {
          if (aiMarkPayload) void handleAiMarkConfirm(o)
          else void handleAiMarkCardConfirm(o)
        }}
        onSkip={() => {
          if (aiMarkPayload) handleAiMarkSkip()
          else {
            setAiMarkOpen(false)
            setAiMarkCard(null)
          }
        }}
      />

      {/* 卡片 ⋯ 菜单里的分享弹窗 */}
      {shareCard && settings && (
        <ShareDialog
          open={!!shareCard}
          onOpenChange={(open) => {
            if (!open) setShareCard(null)
          }}
          card={shareCard}
        />
      )}

      {settingsOpen && (
        <SettingsSheet
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          settings={settings}
          cards={cards}
          onChangeSettings={handleChangeSettings}
          onClearAll={handleClearAll}
          onOpenPlans={() => setView('plan-manager')}
        />
      )}

      {accountOpen && account && (
        <AccountSheet
          open={accountOpen && !!account}
          onOpenChange={setAccountOpen}
          account={account}
          onAccountChange={setAccount}
          onLogout={handleLogout}
        />
      )}

      {/* 全局浮时钟（专注进行中右下角可见，点击查看详情） */}
      <FocusFloatingClock />

      {/* 全局朗读播放器：跨视图持续播放，收起后迷你条在任何界面都显示直到关闭。
          Sheet open 联动 !ttsCollapsed；forceMount 保持 TtsPlayer 挂载，音频不中断。
          收起时 Sheet 滑出屏幕（无空白），迷你条 portal 到 body 在所有界面显示。 */}
      {ttsCard && settings && (
        <SheetGlobal
          open={!ttsCollapsed}
          onOpenChange={(o) => { if (!o) setTtsCollapsed(true) }}
        >
          <SheetContentGlobal
            side="bottom"
            forceMount
            aria-describedby={undefined}
            className="flex h-[94dvh] flex-col rounded-t-3xl bg-background p-0"
          >
            <SheetHeaderGlobal className="sr-only">
              <SheetTitleGlobal>AI朗读</SheetTitleGlobal>
            </SheetHeaderGlobal>
            <TtsPlayerGlobal
              text={ttsCard.content}
              settings={settings}
              context="reader"
              cardTitle={ttsCard.title}
              cardId={ttsCard.id}
              favoritesKey={ttsCard.id}
              collapsed={ttsCollapsed}
              onCollapsedChange={setTtsCollapsed}
              onClose={() => { setTtsCard(null); setTtsCollapsed(false) }}
            />
          </SheetContentGlobal>
        </SheetGlobal>
      )}

      {/* 根级 AI 对话（主页 Dock「对话」按钮）：ask 模式复用 ChatTool，
          上下文卡见 chatRootCard（当前卡 → 第一张有内容的卡）。 */}
      {chatRootOpen && (
        <SheetGlobal
          open={chatRootOpen}
          onOpenChange={(o) => { if (!o) setChatRootOpen(false) }}
        >
          <SheetContentGlobal
            side="bottom"
            aria-describedby={undefined}
            className="mx-auto max-w-2xl gap-0 rounded-t-3xl px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
          >
            <SheetHeaderGlobal className="border-b py-3 pr-12">
              <SheetTitleGlobal className="text-base">
                AI 对话
                {chatRootCard ? (
                  <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                    · {chatRootCard.title}
                  </span>
                ) : null}
              </SheetTitleGlobal>
            </SheetHeaderGlobal>
            {chatRootCard || activeConvId ? (
              <ChatToolGlobal
                mode="ask"
                content={chatRootCard?.content ?? ''}
                allowImages
                cardId={chatRootCard?.id}
                settings={settings ?? undefined}
                conversationId={activeConvId ?? undefined}
                onOpenSidebar={() => setChatSidebarOpen(true)}
                onConversationChange={(id) => setActiveConvId(id)}
              />
            ) : (
              <div className="flex min-h-[40vh] items-center justify-center px-6 py-10 text-center text-sm text-muted-foreground">
                还没有可对话的背书卡，先创建一张带内容的卡吧
              </div>
            )}
          </SheetContentGlobal>
        </SheetGlobal>
      )}

      {/* AI 对话侧边栏（ChatTool PanelLeft / app:toggleChatSidebar）：
          对话列表/全局搜索/批量管理，选中后载入根级对话 Sheet。 */}
      <SheetGlobal
        open={chatSidebarOpen}
        onOpenChange={setChatSidebarOpen}
      >
        <SheetContentGlobal
          side="left"
          aria-describedby={undefined}
          className="w-[86vw] max-w-sm gap-0 p-0"
        >
          <SheetHeaderGlobal className="sr-only">
            <SheetTitleGlobal>AI 对话列表</SheetTitleGlobal>
          </SheetHeaderGlobal>
          <ChatSidebar
            open={chatSidebarOpen}
            onOpenChange={setChatSidebarOpen}
            activeConversationId={activeConvId ?? undefined}
            onSelect={(id) => {
              setActiveConvId(id)
              setChatSidebarOpen(false)
              setChatRootOpen(true)
            }}
            cardId={chatRootCard?.id}
            cardTitle={chatRootCard?.title}
          />
        </SheetContentGlobal>
      </SheetGlobal>

      {/* 统一检索浮层：书本/文章/对话混合检索 + 语音搜索（主页搜索 pill 触发） */}
      <SearchOverlay mode="home" open={searchOpen} onOpenChange={setSearchOpen} />

      {/* 全局迷你播放按钮：可拖拽、播放动画、所有页面常驻（含待播放列表/冲突弹窗/跨设备同步） */}
      {settings && <MiniPlayerFab settings={settings} />}

      {/* 全局追问弹层：选中文本 → AI 追问（解析场景新建对话 / 对话内接续） */}
      <FollowupPopover getActiveConversationId={() => activeConvId ?? undefined} />
    </div>
  )
}
