'use client'

import * as React from 'react'
import { BookOpenText, Settings as SettingsIcon } from 'lucide-react'
import { toast } from 'sonner'

import type { CardData, ClozeStyle, SettingsData } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { ThemeToggle } from '@/components/theme-toggle'
import { CardList } from '@/components/recitation/card-list'
import { ImportPanel, type ImportPayload } from '@/components/recitation/import-panel'
import { StudyView } from '@/components/recitation/study-view'
import { ToolsSheet } from '@/components/recitation/tools-sheet'
import { SettingsSheet } from '@/components/recitation/settings-sheet'

export default function Home() {
  const [cards, setCards] = React.useState<CardData[]>([])
  const [currentCard, setCurrentCard] = React.useState<CardData | null>(null)
  const [settings, setSettings] = React.useState<SettingsData | null>(null)
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState<{
    title: string
    content: string
  } | null>(null)

  const [toolsSheetOpen, setToolsSheetOpen] = React.useState(false)
  const [toolsSheetTool, setToolsSheetTool] = React.useState<string | null>(
    null,
  )
  const [settingsOpen, setSettingsOpen] = React.useState(false)

  const [loading, setLoading] = React.useState(true)

  // Debounced-save timer for keyword updates
  const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // Initial load
  React.useEffect(() => {
    let alive = true
    void Promise.all([
      fetch('/api/cards').then((r) => r.json()),
      fetch('/api/settings').then((r) => r.json()),
    ])
      .then(([cardsRes, settingsRes]) => {
        if (!alive) return
        const c = (cardsRes && (cardsRes.cards as CardData[])) || []
        setCards(c)
        const s = settingsRes as SettingsData | null
        setSettings(s ?? null)
      })
      .catch((err) => {
        if (!alive) return
        toast.error('加载数据失败：' + (err instanceof Error ? err.message : String(err)))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const refreshCard = React.useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/cards/${encodeURIComponent(id)}`)
      if (!res.ok) return
      const data = (await res.json()) as CardData
      setCurrentCard(data)
      setCards((prev) =>
        prev.map((c) => (c.id === id ? data : c)),
      )
    } catch {
      /* ignore */
    }
  }, [])

  const handleNew = React.useCallback(() => {
    setCurrentCard(null)
    setDraft({ title: '', content: '' })
    setEditing(true)
  }, [])

  const handleSelect = React.useCallback(
    (card: CardData) => {
      setCurrentCard(card)
      setEditing(false)
      void refreshCard(card.id)
    },
    [refreshCard],
  )

  const handleImport = React.useCallback(
    async (data: ImportPayload) => {
      const tid = toast.loading('正在创建背书卡…')
      try {
        const res = await fetch('/api/cards', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: data.title,
            content: data.content,
            keywords: data.keywords,
          }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || '创建失败')
        }
        const created = (await res.json()) as CardData
        setCards((prev) => [created, ...prev])
        setCurrentCard(created)
        setEditing(false)
        toast.success('已创建背书卡', { id: tid })
      } catch (err) {
        toast.error(
          '创建失败：' + (err instanceof Error ? err.message : '未知错误'),
          { id: tid },
        )
      }
    },
    [],
  )

  const handleCancelEdit = React.useCallback(() => {
    setEditing(false)
    setDraft(null)
  }, [])

  const handleDelete = React.useCallback(
    async (id: string) => {
      const tid = toast.loading('正在删除…')
      try {
        const res = await fetch(`/api/cards/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || '删除失败')
        }
        setCards((prev) => prev.filter((c) => c.id !== id))
        setCurrentCard((cur) => (cur && cur.id === id ? null : cur))
        toast.success('已删除', { id: tid })
      } catch (err) {
        toast.error(
          '删除失败：' + (err instanceof Error ? err.message : '未知错误'),
          { id: tid },
        )
      }
    },
    [],
  )

  const handleUpdateCard = React.useCallback(
    (next: CardData) => {
      // Optimistic update of local state
      setCurrentCard(next)
      setCards((prev) =>
        prev.map((c) => (c.id === next.id ? next : c)),
      )
      // Debounced PATCH
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(async () => {
        try {
          const res = await fetch(
            `/api/cards/${encodeURIComponent(next.id)}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                title: next.title,
                content: next.content,
                keywords: next.keywords,
              }),
            },
          )
          if (!res.ok) {
            const err = await res.json().catch(() => ({}))
            throw new Error(err.error || '保存失败')
          }
          const saved = (await res.json()) as CardData
          setCards((prev) =>
            prev.map((c) => (c.id === saved.id ? saved : c)),
          )
          setCurrentCard((cur) => (cur && cur.id === saved.id ? saved : cur))
        } catch (err) {
          toast.error(
            '保存失败：' + (err instanceof Error ? err.message : '未知错误'),
          )
        }
      }, 700)
    },
    [],
  )

  const handleOpenTool = React.useCallback((key: string) => {
    setToolsSheetTool(key)
    setToolsSheetOpen(true)
  }, [])

  const handleChangeStyle = React.useCallback(
    async (style: ClozeStyle) => {
      if (!settings) return
      const next = { ...settings, clozeStyle: style }
      setSettings(next)
      try {
        await fetch('/api/settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clozeStyle: style }),
        })
      } catch {
        /* non-critical */
      }
    },
    [settings],
  )

  const handleToggleShowAnswers = React.useCallback(
    async (show: boolean) => {
      if (!settings) return
      const next = { ...settings, showAnswers: show }
      setSettings(next)
      try {
        await fetch('/api/settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ showAnswers: show }),
        })
      } catch {
        /* non-critical */
      }
    },
    [settings],
  )

  const handleSaveSettings = React.useCallback(
    async (next: SettingsData) => {
      const tid = toast.loading('正在保存设置…')
      try {
        const res = await fetch('/api/settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || '保存失败')
        }
        const saved = (await res.json()) as SettingsData
        setSettings(saved)
        setSettingsOpen(false)
        toast.success('设置已保存', { id: tid })
      } catch (err) {
        toast.error(
          '保存设置失败：' + (err instanceof Error ? err.message : '未知错误'),
          { id: tid },
        )
      }
    },
    [],
  )

  const handleEditContent = React.useCallback(() => {
    if (!currentCard) return
    setDraft({ title: currentCard.title, content: currentCard.content })
    setEditing(true)
  }, [currentCard])

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <div className="flex items-center gap-2 font-semibold">
            <BookOpenText className="size-5 text-emerald-600" />
            超级背书
          </div>
          <Badge
            variant="secondary"
            className="hidden bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 sm:inline-flex"
          >
            AI 记忆背诵
          </Badge>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSettingsOpen(true)}
            >
              <SettingsIcon className="size-4" /> 设置
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {loading ? (
          <div className="grid gap-6 md:grid-cols-[260px_1fr]">
            <Skeleton className="h-[60vh] w-full rounded-2xl" />
            <Skeleton className="h-[60vh] w-full rounded-2xl" />
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-[260px_1fr]">
            <CardList
              cards={cards}
              currentId={currentCard?.id}
              onSelect={handleSelect}
              onDelete={handleDelete}
              onNew={handleNew}
            />
            <div className="min-w-0">
              {editing ? (
                <ImportPanel
                  initialDraft={draft}
                  onImport={handleImport}
                  onCancel={handleCancelEdit}
                />
              ) : currentCard && settings ? (
                <StudyView
                  key={currentCard.id}
                  card={currentCard}
                  settings={settings}
                  onUpdate={handleUpdateCard}
                  onEdit={handleEditContent}
                  onOpenTool={handleOpenTool}
                  onChangeStyle={handleChangeStyle}
                  onToggleShowAnswers={handleToggleShowAnswers}
                />
              ) : (
                <ImportPanel
                  welcome
                  onImport={handleImport}
                  onCancel={handleCancelEdit}
                />
              )}
            </div>
          </div>
        )}
      </main>

      <footer className="mt-auto border-t bg-background">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-1 px-4 py-4 text-xs text-muted-foreground sm:flex-row">
          <span>超级背书工具 · 由 AI 驱动（z-ai SDK / 第三方模型）</span>
          <span className="text-center sm:text-right">
            支持图片识别 · 语音输入 · TTS 朗读 · AI 挖空出题
          </span>
        </div>
      </footer>

      <ToolsSheet
        open={toolsSheetOpen}
        onOpenChange={setToolsSheetOpen}
        tool={toolsSheetTool}
        onToolChange={setToolsSheetTool}
        card={currentCard}
        settings={settings}
      />
      <SettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onSave={handleSaveSettings}
      />
    </div>
  )
}
