'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import type { AccountData, CardData, Mastery, MaterialBlock, ProjectData, SettingsData } from '@/lib/types'
import { extractClozeMarks } from '@/lib/editor-cloze'
import { HomeView } from '@/components/recitation/home-view'
import { ReaderView } from '@/components/recitation/reader-view'
import { ImportSheet, type ImportPayload } from '@/components/recitation/import-sheet'
import { SettingsSheet } from '@/components/recitation/settings-sheet'
import { AccountSheet } from '@/components/recitation/account-sheet'
import { ShareManagerView } from '@/components/recitation/share-manager-view'
import { ShareDialog } from '@/components/recitation/share-dialog'
import { FocusFloatingClock } from '@/components/recitation/focus-bus'
import NextDynamic from 'next/dynamic'

// 全部视图懒加载：拆小编译图，避免 dev 编译内存峰值触发 OOM。
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

  // 待复习数量：复习周期内（最近一次评估非 none）的卡片数
  React.useEffect(() => {
    if (!authed) return
    fetch(`/api/review?perCard=1&tzOffset=${new Date().getTimezoneOffset()}`)
      .then((r) => r.json())
      .then((res: { statuses?: Record<string, string> }) => {
        const st = res?.statuses ?? {}
        setDueCount(
          cards.filter((c) => {
            const a = st[c.id]
            return a === 'familiar' || a === 'fuzzy' || a === 'forget'
          }).length,
        )
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
        // 编辑已有卡：保留仍存在于正文中的旧挖空 + 新的 {{}} 标记
        const kept = currentCard.keywords.filter((k) => content.includes(k))
        const keywords = Array.from(new Set([...kept, ...marks]))
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
        // 导入偏好：AI 自动挖空
        if (settings?.aiAutoCloze && marks.length === 0 && content.length >= 20) {
          toast.loading('AI 正在自动挖空…', { id: 'auto-cloze' })
          try {
            const r2 = await fetch('/api/cloze', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content }),
            })
            if (r2.ok) {
              const d2 = (await r2.json()) as { keywords?: string[] }
              const kws = (d2.keywords || []).filter(Boolean)
              if (kws.length > 0) {
                const r3 = await fetch(`/api/cards/${encodeURIComponent(created.id)}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ keywords: kws }),
                })
                if (r3.ok) {
                  created = { ...created, keywords: kws }
                  setCards((prev) => prev.map((c) => (c.id === created.id ? created : c)))
                  setCurrentCard((cur) => (cur && cur.id === created.id ? created : cur))
                  toast.success(`AI 已自动挖空 ${kws.length} 处`, { id: 'auto-cloze' })
                }
              }
            }
          } catch {
            toast.error('AI 自动挖空失败，可稍后手动挖空', { id: 'auto-cloze' })
          }
        }
        setCurrentCard(created)
      } catch (err) {
        toast.error('创建失败：' + (err instanceof Error ? err.message : '未知错误'), { id: tid })
      }
    },
    [editorDraft, editorTitle, editorMode, currentCard, settings, activeCategoryId],
  )

  // ---------- 兼容旧 ImportSheet onImport（文件/图片/粘贴导入 → 全部进入超级编辑器） ----------
  const handleImport = React.useCallback(
    (payload: ImportPayload) => {
      setImportOpen(false)
      setEditorMode('create')
      setEditorTitle(payload.title || '')
      setEditorDraft({
        title: payload.title || '',
        content: payload.content,
        blocks: [],
      })
      setView('material-editor')
      toast.info('内容已导入编辑器，可继续编辑后保存')
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
    async (card: CardData) => {
      const tid = toast.loading('正在创建副本…')
      try {
        const res = await fetch('/api/cards', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: `${card.title} 副本`,
            content: card.content,
            keywords: card.keywords,
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

  // ---------- gated rendering ----------
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
          onDuplicateCard={(c) => void handleDuplicateCard(c)}
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
        />
      ) : view === 'wrong' ? (
        <WrongQuestionsView onBack={() => setView('home')} />
      ) : view === 'report' ? (
        <QuizReportView onBack={() => setView('home')} />
      ) : view === 'favorites' ? (
        <FavoritesView onBack={() => setView('home')} />
      ) : view === 'review-stats' ? (
        <ReviewStatsView onBack={() => setView('home')} />
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

      <SettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        cards={cards}
        onChangeSettings={handleChangeSettings}
        onClearAll={handleClearAll}
      />

      <AccountSheet
        open={accountOpen && !!account}
        onOpenChange={setAccountOpen}
        account={account!}
        onAccountChange={setAccount}
        onLogout={handleLogout}
      />

      {/* 全局浮时钟（专注进行中右下角可见，点击查看详情） */}
      <FocusFloatingClock />
    </div>
  )
}
