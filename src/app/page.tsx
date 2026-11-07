'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import type { AccountData, CardData, Mastery, MaterialBlock, SettingsData } from '@/lib/types'
import { HomeView } from '@/components/recitation/home-view'
import { ReaderView } from '@/components/recitation/reader-view'
import { ImportSheet, type ImportPayload } from '@/components/recitation/import-sheet'
import { SettingsSheet } from '@/components/recitation/settings-sheet'
import { AccountSheet } from '@/components/recitation/account-sheet'
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

export default function Page() {
  const router = useRouter()
  const { setTheme } = useTheme()

  const [view, setView] = React.useState<View>('home')
  const [cards, setCards] = React.useState<CardData[]>([])
  const [currentCard, setCurrentCard] = React.useState<CardData | null>(null)
  const [settings, setSettings] = React.useState<SettingsData | null>(null)
  const [loading, setLoading] = React.useState(true)
  // 复习总览：每张卡的掌握状态（进入视图时拉取）
  const [overviewStatuses, setOverviewStatuses] = React.useState<
    Record<string, { mastery: Mastery; chapters: number }>
  >({})

  // ---------- auth ----------
  const [authed, setAuthed] = React.useState(false)
  const [authLoading, setAuthLoading] = React.useState(true)
  const [account, setAccount] = React.useState<AccountData | null>(null)
  const [accountOpen, setAccountOpen] = React.useState(false)
  const dataLoadedRef = React.useRef(false)

  const [importOpen, setImportOpen] = React.useState(false)
  const [importDraft, setImportDraft] = React.useState<{
    title: string
    content: string
  } | null>(null)
  const [editingCardId, setEditingCardId] = React.useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = React.useState(false)

  const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // ---------- initial data load (cards + settings) ----------
  const loadInitialData = React.useCallback(async () => {
    setLoading(true)
    try {
      const [cardsRes, settingsRes] = await Promise.all([
        fetch('/api/cards').then((r) => r.json()),
        fetch('/api/settings').then((r) => r.json()),
      ])
      setCards(((cardsRes && cardsRes.cards) as CardData[]) || [])
      const s = settingsRes as SettingsData | null
      setSettings(s || null)
      // Sync the app theme (白天/夜间/护眼/羊皮纸) from the server settings.
      if (s?.theme) setTheme(s.theme)
    } catch (err) {
      toast.error('加载数据失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setLoading(false)
    }
  }, [setTheme])

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
    void fetch('/api/auth/logout', { method: 'POST' }).finally(() => {
      dataLoadedRef.current = false
      setAccount(null)
      router.replace('/login')
    })
  }, [router])

  // ---------- card CRUD ----------
  const handleImport = React.useCallback(async (payload: ImportPayload) => {
    // Editing an existing card -> PATCH; otherwise create a new one.
    if (editingCardId) {
      const tid = toast.loading('正在保存修改…')
      try {
        const res = await fetch(`/api/cards/${encodeURIComponent(editingCardId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: payload.title,
            content: payload.content,
            keywords: [],
            strokes: [],
          }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || '保存失败')
        }
        const saved = (await res.json()) as CardData
        setCards((prev) => prev.map((c) => (c.id === saved.id ? saved : c)))
        setCurrentCard(saved)
        setImportOpen(false)
        setEditingCardId(null)
        setImportDraft(null)
        toast.success('已保存修改', { id: tid })
      } catch (err) {
        toast.error('保存失败：' + (err instanceof Error ? err.message : '未知错误'), { id: tid })
      }
      return
    }

    const tid = toast.loading('正在创建背书卡…')
    try {
      const res = await fetch('/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: payload.title,
          content: payload.content,
          keywords: payload.keywords,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '创建失败')
      }
      const created = (await res.json()) as CardData
      setCards((prev) => [created, ...prev])
      setCurrentCard(created)
      setImportOpen(false)
      setImportDraft(null)
      setView('reader')
      toast.success('已创建背书卡，开始背诵吧！', { id: tid })
    } catch (err) {
      toast.error('创建失败：' + (err instanceof Error ? err.message : '未知错误'), { id: tid })
    }
  }, [editingCardId])

  const handleUpdateCard = React.useCallback((next: CardData) => {
    // Optimistic local update, then debounced PATCH (700ms) persisting
    // title/content/keywords/strokes/plan/mindmaps.
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

  const handleEditContent = React.useCallback(() => {
    if (!currentCard) return
    setImportDraft({ title: currentCard.title, content: currentCard.content })
    setEditingCardId(currentCard.id)
    setImportOpen(true)
  }, [currentCard])

  const handleNewCard = React.useCallback(() => {
    setImportDraft(null)
    setEditingCardId(null)
    setImportOpen(true)
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
    setImportDraft(null)
    setEditingCardId(null)
  }, [])

  // ---------- gated rendering ----------
  if (authLoading || !authed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {view === 'home' && account ? (
        <HomeView
          cards={cards}
          loading={loading}
          account={account}
          onOpenCard={handleOpenCard}
          onDelete={handleDelete}
          onNew={handleNewCard}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenAccount={() => setAccountOpen(true)}
          onLogout={handleLogout}
          onOpenWrong={() => setView('wrong')}
          onOpenReport={() => setView('report')}
          onOpenFavorites={() => setView('favorites')}
          onOpenReviewStats={() => setView('review-stats')}
          onOpenFocus={() => setView('focus')}
          onOpenTrash={() => setView('trash')}
          onOpenPlans={() => setView('plan-manager')}
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
          onOpenMaterialEditor={() => setView('material-editor')}
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
      ) : view === 'material-editor' && currentCard ? (
        <MaterialEditor
          card={currentCard}
          onBack={() => setView('reader')}
          onSave={(blocks: MaterialBlock[]) => {
            if (currentCard) {
              handleUpdateCard({ ...currentCard, blocks })
              toast.success(`文字编辑已保存，共 ${blocks.length} 块`)
            }
            setView('reader')
          }}
        />
      ) : view === 'focus' ? (
        <FocusApp onBack={() => setView('home')} />
      ) : view === 'trash' ? (
        <RecycleBinView onBack={() => setView('home')} />
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

      <footer className="mt-auto border-t bg-background">
        <div className="mx-auto flex max-w-2xl items-center justify-center px-4 py-2.5 text-[11px] text-muted-foreground">
          背书吧 · AI 挖空 · AI 出题 · TTS 朗读 · 语音识别
        </div>
      </footer>

      <ImportSheet
        open={importOpen}
        onOpenChange={(open) => {
          if (!open) handleCancelImport()
          else setImportOpen(true)
        }}
        initialDraft={importDraft}
        editing={!!editingCardId}
        onImport={handleImport}
        onCancel={handleCancelImport}
      />

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
    </div>
  )
}
