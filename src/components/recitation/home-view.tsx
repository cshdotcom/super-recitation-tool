'use client'

// 主页（1:1 复刻参考 App 布局）：
// - 顶栏：汉堡菜单(侧边栏) / 标题 / 搜索 / 更多(⋯)
// - 标题行：当前项目名 + 待复习胶囊(蓝点) + 日历按钮
// - 卡片列表：文件行（图标 + 标题 + 日期 + ⋯ 菜单），搜索结果高亮标注
// - 底部 Dock：首页 | 黑色大 + | 资料（学习工具面板）
// - 侧边栏（截图5）：账号头 + 常用功能 + 项目(全部/未分类/最近/自定义项目, 可折叠/搜索/编辑)
// - 批量选择模式：全选 + 批量删除/移动

import * as React from 'react'
import { formatDistanceToNow } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import {
  AlignLeft,
  ArrowUpDown,
  BarChart3,
  BookX,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Copy,
  FileText,
  Folder,
  FolderOpen,
  LayoutGrid,
  Layers,
  Menu,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings as SettingsIcon,
  Share2,
  SquareCheckBig,
  Star,
  Timer,
  Trash2,
  User,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import type { AccountData, CardData, ProjectData } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

type SortMode = 'custom' | 'time' | 'alpha'

interface HomeViewProps {
  cards: CardData[]
  projects: ProjectData[]
  loading: boolean
  account: AccountData
  /** 待复习数量（复习周期内的卡片数） */
  dueCount: number
  activeCategoryId: string // '' = 全部, 'uncategorized' = 未分类, 'recent' = 最近
  onActiveCategoryChange: (id: string) => void
  onOpenCard: (card: CardData) => void
  onNew: () => void
  onOpenSettings: () => void
  onOpenAccount: () => void
  onLogout: () => void
  onShareCard: (card: CardData) => void
  onRenameCard: (card: CardData, title: string) => void
  onTogglePin: (card: CardData) => void
  onMoveCard: (card: CardData, categoryId: string) => void
  onDuplicateCard: (card: CardData) => void
  onDeleteCard: (id: string) => void
  onBatchDelete: (ids: string[]) => void
  onBatchMove: (ids: string[], categoryId: string) => void
  onReorderCards: (ids: string[]) => void
  onCreateProject: (name: string) => void
  onRenameProject: (id: string, name: string) => void
  onDeleteProject: (id: string) => void
  onMoveProject: (id: string, dir: -1 | 1) => void
  onOpenWrong: () => void
  onOpenReport: () => void
  onOpenFavorites: () => void
  onOpenReviewStats: () => void
  onOpenFocus: () => void
  onOpenTrash: () => void
  onOpenPlans: () => void
  onOpenShareManager: () => void
}

const COMMON_TOOLS = [
  { key: 'wrong', label: '错题本', icon: BookX },
  { key: 'report', label: '答题报告', icon: ClipboardList },
  { key: 'favorites', label: '收藏题目', icon: Star },
  { key: 'review-stats', label: '复习统计', icon: BarChart3 },
  { key: 'plans', label: '复习计划', icon: CalendarClock },
  { key: 'share-manager', label: '分享管理', icon: Share2 },
  { key: 'focus', label: '专注模式', icon: Timer },
  { key: 'trash', label: '回收站', icon: Trash2 },
] as const

export function HomeView({
  cards,
  projects,
  loading,
  account,
  dueCount,
  activeCategoryId,
  onActiveCategoryChange,
  onOpenCard,
  onNew,
  onOpenSettings,
  onOpenAccount,
  onLogout,
  onShareCard,
  onRenameCard,
  onTogglePin,
  onMoveCard,
  onDuplicateCard,
  onDeleteCard,
  onBatchDelete,
  onBatchMove,
  onReorderCards,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onMoveProject,
  onOpenWrong,
  onOpenReport,
  onOpenFavorites,
  onOpenReviewStats,
  onOpenFocus,
  onOpenTrash,
  onOpenPlans,
  onOpenShareManager,
}: HomeViewProps) {
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [sortMode, setSortMode] = React.useState<SortMode>('time')
  const [batchMode, setBatchMode] = React.useState(false)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [projCollapsed, setProjCollapsed] = React.useState(false)
  const [projQuery, setProjQuery] = React.useState('')
  const [projEdit, setProjEdit] = React.useState(false)
  const [newProjOpen, setNewProjOpen] = React.useState(false)
  const [newProjName, setNewProjName] = React.useState('')
  const [renameProj, setRenameProj] = React.useState<{ id: string; name: string } | null>(null)
  const [deleteProj, setDeleteProj] = React.useState<ProjectData | null>(null)
  const [moveToProj, setMoveToProj] = React.useState<{ ids: string[] } | null>(null)
  const [renameCard, setRenameCard] = React.useState<{ id: string; title: string } | null>(null)
  const [deleteCard, setDeleteCard] = React.useState<CardData | null>(null)
  const [toolsOpen, setToolsOpen] = React.useState(false)
  const [sortOpen, setSortOpen] = React.useState(false)
  const [batchMoveOpen, setBatchMoveOpen] = React.useState(false)
  const [moveTarget, setMoveTarget] = React.useState('__uncat__')

  const searchInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  // 项目卡片计数
  const countByCategory = React.useMemo(() => {
    const map: Record<string, number> = {}
    for (const c of cards) map[c.categoryId] = (map[c.categoryId] ?? 0) + 1
    return map
  }, [cards])

  // ---------- 排序 + 过滤 ----------
  const visibleCards = React.useMemo(() => {
    let list = [...cards]
    if (activeCategoryId === 'uncategorized') {
      list = list.filter((c) => !c.categoryId || !projects.some((p) => p.id === c.categoryId))
    } else if (activeCategoryId !== '' && activeCategoryId !== 'recent') {
      list = list.filter((c) => c.categoryId === activeCategoryId)
    }
    if (activeCategoryId === 'recent') {
      list = list.slice(0, 10)
    }
    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.content.toLowerCase().includes(q),
      )
    }
    if (sortMode === 'alpha') {
      list.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
    } else if (sortMode === 'custom') {
      list.sort((a, b) => a.ord - b.ord || (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1))
    } else {
      list.sort(
        (a, b) =>
          (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1) ||
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )
    }
    return list
  }, [cards, projects, activeCategoryId, query, sortMode])

  const titleText =
    activeCategoryId === ''
      ? '全部'
      : activeCategoryId === 'uncategorized'
        ? '无分类'
        : activeCategoryId === 'recent'
          ? '最近'
          : projects.find((p) => p.id === activeCategoryId)?.name ?? '全部'

  // 搜索结果内容片段 + 高亮标注
  const excerptOf = (card: CardData): { before: string; hit: string; after: string } | null => {
    const q = query.trim()
    if (!q) return null
    const idx = card.content.toLowerCase().indexOf(q.toLowerCase())
    if (idx < 0) return null
    const start = Math.max(0, idx - 12)
    const before = (start > 0 ? '…' : '') + card.content.slice(start, idx)
    const hit = card.content.slice(idx, idx + q.length)
    const after = card.content.slice(idx + q.length, idx + q.length + 24) + (idx + q.length + 24 < card.content.length ? '…' : '')
    return { before, hit, after }
  }

  // ---------- batch ----------
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }
  const allSelected = visibleCards.length > 0 && visibleCards.every((c) => selected.has(c.id))

  // ---------- sidebar ----------
  const handleToolClick = (key: string) => {
    setDrawerOpen(false)
    switch (key) {
      case 'wrong': return onOpenWrong()
      case 'report': return onOpenReport()
      case 'favorites': return onOpenFavorites()
      case 'review-stats': return onOpenReviewStats()
      case 'plans': return onOpenPlans()
      case 'share-manager': return onOpenShareManager()
      case 'focus': return onOpenFocus()
      case 'trash': return onOpenTrash()
    }
  }

  const filteredProjects = projects.filter((p) =>
    p.name.toLowerCase().includes(projQuery.trim().toLowerCase()),
  )

  return (
    <>
      {/* ================= 顶栏 ================= */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-1 px-3">
          {batchMode ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="退出批量选择"
                onClick={() => {
                  setBatchMode(false)
                  setSelected(new Set())
                }}
              >
                <X className="size-5" strokeWidth={1.75} />
              </Button>
              <span className="text-sm font-semibold">已选 {selected.size} 项</span>
              <div className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="sm" className="rounded-full text-sm" onClick={() => setSelected(allSelected ? new Set() : new Set(visibleCards.map((c) => c.id)))}>
                  {allSelected ? '取消全选' : '全选'}
                </Button>
                <Button
                  size="sm"
                  className="rounded-full bg-destructive text-white hover:bg-destructive/90"
                  disabled={selected.size === 0}
                  onClick={() => {
                    onBatchDelete(Array.from(selected))
                    setBatchMode(false)
                    setSelected(new Set())
                  }}
                >
                  删除
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-full"
                  disabled={selected.size === 0}
                  onClick={() => setBatchMoveOpen(true)}
                >
                  移动
                </Button>
              </div>
            </>
          ) : (
            <>
              <Button variant="ghost" size="icon" aria-label="打开菜单" onClick={() => setDrawerOpen(true)}>
                <Menu className="size-6" strokeWidth={1.75} />
              </Button>
              <div className="flex items-center gap-1.5 text-base font-bold">
                <LayoutGrid className="size-4 text-emerald-600" strokeWidth={2} aria-hidden />
                背书吧
              </div>
              <div className="ml-auto flex items-center">
                {searchOpen ? (
                  <div className="flex items-center gap-1 rounded-full border border-border bg-card px-3 py-1">
                    <Search className="size-4 text-muted-foreground" strokeWidth={1.75} />
                    <input
                      ref={searchInputRef}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="搜索标题与内容…"
                      aria-label="搜索"
                      className="w-36 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60 sm:w-56"
                    />
                    <button
                      type="button"
                      aria-label="关闭搜索"
                      onClick={() => {
                        setSearchOpen(false)
                        setQuery('')
                      }}
                      className="text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <X className="size-4" strokeWidth={1.75} />
                    </button>
                  </div>
                ) : (
                  <Button variant="ghost" size="icon" aria-label="搜索" onClick={() => setSearchOpen(true)}>
                    <Search className="size-5" strokeWidth={1.75} />
                  </Button>
                )}
                <Popover open={sortOpen} onOpenChange={setSortOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="排序">
                      <ArrowUpDown className="size-5" strokeWidth={1.75} />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-44 rounded-2xl p-1.5">
                    {(
                      [
                        { key: 'time', label: '时间排序' },
                        { key: 'alpha', label: '字母排序' },
                        { key: 'custom', label: '自定义排序' },
                      ] as const
                    ).map((s) => (
                      <button
                        key={s.key}
                        type="button"
                        className={cn(
                          'flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-accent',
                          sortMode === s.key && 'font-semibold text-emerald-600',
                        )}
                        onClick={() => {
                          setSortMode(s.key)
                          setSortOpen(false)
                          if (s.key === 'custom') toast.info('自定义排序：用每张卡片 ⋯ 菜单里的「上移/下移」调整顺序')
                        }}
                      >
                        {s.label}
                        {sortMode === s.key && <SquareCheckBig className="size-4 text-emerald-600" strokeWidth={1.75} />}
                      </button>
                    ))}
                  </PopoverContent>
                </Popover>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="更多">
                      <AlignLeft className="size-5" strokeWidth={1.75} />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-48 rounded-2xl p-1.5">
                    <button
                      type="button"
                      className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                      onClick={() => {
                        setBatchMode(true)
                        setSelected(new Set())
                      }}
                    >
                      <SquareCheckBig className="size-4 text-muted-foreground" strokeWidth={1.75} /> 批量选择
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                      onClick={() => {
                        setDrawerOpen(true)
                        setTimeout(() => setProjEdit(true), 150)
                      }}
                    >
                      <FolderOpen className="size-4 text-muted-foreground" strokeWidth={1.75} /> 项目管理
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                      onClick={() => {
                        onOpenShareManager()
                      }}
                    >
                      <Share2 className="size-4 text-muted-foreground" strokeWidth={1.75} /> 分享管理
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                      onClick={onNew}
                    >
                      <Plus className="size-4 text-muted-foreground" strokeWidth={1.75} /> 新建背书卡
                    </button>
                  </PopoverContent>
                </Popover>
              </div>
            </>
          )}
        </div>
      </header>

      {/* ================= 主内容 ================= */}
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pb-32 pt-5">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-extrabold tracking-tight">{titleText}</h1>
          <button
            type="button"
            aria-label={`待复习 ${dueCount} 张`}
            onClick={onOpenReviewStats}
            className="flex items-center gap-2 rounded-full border border-border bg-card px-3.5 py-2 text-sm transition-colors hover:bg-accent"
          >
            待复习
            {dueCount > 0 && (
              <span className="relative flex size-5 items-center justify-center rounded-full bg-foreground text-[10px] font-bold text-background">
                {dueCount > 99 ? '99+' : dueCount}
                <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-emerald-500 ring-2 ring-background" />
              </span>
            )}
            <CalendarClock className="size-4 text-muted-foreground" strokeWidth={1.75} />
          </button>
        </div>

        {loading ? (
          <div className="mt-6 space-y-3">
            <Skeleton className="h-20 rounded-2xl" />
            <Skeleton className="h-20 rounded-2xl" />
            <Skeleton className="h-20 rounded-2xl" />
          </div>
        ) : visibleCards.length === 0 ? (
          <div className="mt-6 flex flex-col items-center justify-center gap-3 rounded-3xl border border-dashed border-border py-16 text-center">
            <FileText className="size-12 text-muted-foreground/30" strokeWidth={1.25} />
            <p className="text-base font-medium text-muted-foreground">
              {query ? '没有匹配的结果' : '这里还没有背书卡'}
            </p>
            <p className="text-sm text-muted-foreground/70">
              {query ? '换个关键词试试，或点击 ⋯ 新建卡片' : '点击下方黑色 + 按钮创建'}
            </p>
          </div>
        ) : (
          <ul className="mt-5 space-y-3" role="list" aria-label="背书卡列表">
            {visibleCards.map((card) => (
              <CardRow
                key={card.id}
                card={card}
                projectName={projects.find((p) => p.id === card.categoryId)?.name}
                query={query}
                excerpt={excerptOf(card)}
                batchMode={batchMode}
                checked={selected.has(card.id)}
                onToggle={() => toggleSelect(card.id)}
                onOpen={() => onOpenCard(card)}
                onShare={() => onShareCard(card)}
                onRename={() => setRenameCard({ id: card.id, title: card.title })}
                onTogglePin={() => onTogglePin(card)}
                onMove={() => setMoveToProj({ ids: [card.id] })}
                onDuplicate={() => onDuplicateCard(card)}
                onDelete={() => setDeleteCard(card)}
                onReorder={(dir) => {
                  const ids = visibleCards.map((c) => c.id)
                  const i = ids.indexOf(card.id)
                  const j = i + dir
                  if (j < 0 || j >= ids.length) return
                  ;[ids[i], ids[j]] = [ids[j], ids[i]]
                  onReorderCards(ids)
                }}
              />
            ))}
          </ul>
        )}
      </main>

      {/* ================= 底部 Dock ================= */}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
        <div className="pointer-events-auto flex w-full max-w-md items-center justify-between rounded-full border border-border bg-background/95 px-6 py-2.5 shadow-xl backdrop-blur">
          <button
            type="button"
            aria-label="首页"
            className="flex flex-col items-center gap-0.5 text-foreground"
          >
            <LayoutGrid className="size-5" strokeWidth={2} aria-hidden />
            <span className="text-[10px] font-medium">首页</span>
          </button>
          <button
            type="button"
            aria-label="新建背书卡"
            onClick={onNew}
            className="flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-black/25 transition-transform hover:scale-105 active:scale-95"
          >
            <Plus className="size-6" strokeWidth={2.25} aria-hidden />
          </button>
          <button
            type="button"
            aria-label="资料与学习工具"
            onClick={() => setToolsOpen(true)}
            className="flex flex-col items-center gap-0.5 text-foreground"
          >
            <Layers className="size-5" strokeWidth={2} aria-hidden />
            <span className="text-[10px] font-medium">资料</span>
          </button>
        </div>
      </div>

      {/* ================= 侧边栏（截图5） ================= */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/45"
          onClick={() => {
            setDrawerOpen(false)
            setProjEdit(false)
          }}
          role="presentation"
        >
          <aside
            role="dialog"
            aria-label="侧边栏"
            className="fixed inset-y-0 left-0 flex w-[85vw] max-w-[340px] flex-col bg-background shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 用户头 */}
            <div className="flex items-center gap-3 px-5 pb-4 pt-6">
              <button type="button" aria-label="个人中心" onClick={() => { setDrawerOpen(false); onOpenAccount() }}>
                <Avatar className="size-12 ring-1 ring-border">
                  {account.avatar ? <AvatarImage src={account.avatar} alt={account.username} /> : null}
                  <AvatarFallback className="bg-emerald-600 text-base font-bold text-white">
                    {account.username.slice(0, 1) || '账'}
                  </AvatarFallback>
                </Avatar>
              </button>
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-bold">{account.username}</p>
                <p className="truncate text-xs text-muted-foreground">ID：{account.id.slice(0, 14)}</p>
              </div>
              <Button variant="ghost" size="icon" aria-label="个人中心" onClick={() => { setDrawerOpen(false); onOpenAccount() }}>
                <User className="size-5 text-muted-foreground" strokeWidth={1.75} />
              </Button>
              <Button variant="ghost" size="icon" aria-label="设置" onClick={() => { setDrawerOpen(false); onOpenSettings() }}>
                <SettingsIcon className="size-5 text-muted-foreground" strokeWidth={1.75} />
              </Button>
            </div>

            {/* 常用功能 */}
            <div className="px-4">
              <p className="mb-2 text-xs text-muted-foreground">常用功能</p>
              <div className="grid grid-cols-4 gap-1 rounded-2xl border border-border bg-card p-3">
                {COMMON_TOOLS.map((tool) => (
                  <button
                    key={tool.key}
                    type="button"
                    onClick={() => handleToolClick(tool.key)}
                    className="flex flex-col items-center gap-1.5 rounded-xl py-2 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <tool.icon className="size-5" strokeWidth={1.75} aria-hidden />
                    <span className="text-[10px] leading-none">{tool.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* 项目 */}
            <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              <button
                type="button"
                className="flex w-full items-center gap-1 text-sm text-muted-foreground"
                onClick={() => setProjCollapsed((v) => !v)}
                aria-expanded={!projCollapsed}
              >
                项目（分类）
                {projCollapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
              </button>
              {!projCollapsed && (
                <div className="mt-2 rounded-2xl border border-border bg-card p-2">
                  <ProjRow
                    icon={<LayoutGrid className="size-4" strokeWidth={1.75} />}
                    label="全部"
                    count={cards.length}
                    active={activeCategoryId === ''}
                    onClick={() => {
                      onActiveCategoryChange('')
                      setDrawerOpen(false)
                    }}
                  />
                  <ProjRow
                    icon={<FileText className="size-4" strokeWidth={1.75} />}
                    label="无分类"
                    count={cards.filter((c) => !c.categoryId || !projects.some((p) => p.id === c.categoryId)).length}
                    active={activeCategoryId === 'uncategorized'}
                    onClick={() => {
                      onActiveCategoryChange('uncategorized')
                      setDrawerOpen(false)
                    }}
                  />
                  <ProjRow
                    icon={<CalendarClock className="size-4" strokeWidth={1.75} />}
                    label="最近"
                    count={Math.min(10, cards.length)}
                    active={activeCategoryId === 'recent'}
                    onClick={() => {
                      onActiveCategoryChange('recent')
                      setDrawerOpen(false)
                    }}
                  />
                  {projects.length > 6 && (
                    <div className="px-3 pb-1 pt-2">
                      <input
                        value={projQuery}
                        onChange={(e) => setProjQuery(e.target.value)}
                        placeholder="搜索项目…"
                        aria-label="搜索项目"
                        className="w-full rounded-lg bg-muted px-2.5 py-1.5 text-xs outline-none"
                      />
                    </div>
                  )}
                  {filteredProjects.map((p) =>
                    projEdit ? (
                      <div key={p.id} className="flex items-center gap-1 rounded-xl px-2.5 py-2">
                        <Folder className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                        <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
                        <button
                          type="button"
                          aria-label={`上移项目 ${p.name}`}
                          className="rounded-md p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                          disabled={p.id === projects[0]?.id}
                          onClick={() => onMoveProject(p.id, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={`下移项目 ${p.name}`}
                          className="rounded-md p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                          disabled={p.id === projects[projects.length - 1]?.id}
                          onClick={() => onMoveProject(p.id, 1)}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          aria-label={`重命名项目 ${p.name}`}
                          className="rounded-md p-1 text-muted-foreground hover:text-foreground"
                          onClick={() => setRenameProj({ id: p.id, name: p.name })}
                        >
                          <Pencil className="size-3.5" strokeWidth={1.75} />
                        </button>
                        <button
                          type="button"
                          aria-label={`删除项目 ${p.name}`}
                          className="rounded-md p-1 text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleteProj(p)}
                        >
                          <Trash2 className="size-3.5" strokeWidth={1.75} />
                        </button>
                      </div>
                    ) : (
                      <ProjRow
                        key={p.id}
                        icon={<Folder className="size-4" strokeWidth={1.75} />}
                        label={p.name}
                        count={countByCategory[p.id] ?? 0}
                        active={activeCategoryId === p.id}
                        onClick={() => {
                          onActiveCategoryChange(p.id)
                          setDrawerOpen(false)
                        }}
                      />
                    ),
                  )}
                  {filteredProjects.length === 0 && projQuery.trim() && (
                    <p className="px-3 py-3 text-center text-xs text-muted-foreground">没有匹配的项目</p>
                  )}
                </div>
              )}
            </div>

            {/* 底部操作 */}
            <div className="flex items-center justify-between border-t border-border px-6 py-4">
              <button
                type="button"
                className="flex items-center gap-2 text-sm font-medium transition-colors hover:text-emerald-600"
                onClick={() => {
                  setNewProjName('')
                  setNewProjOpen(true)
                }}
              >
                <Plus className="size-4" strokeWidth={1.75} /> 添加项目
              </button>
              <button
                type="button"
                className={cn(
                  'flex items-center gap-2 text-sm font-medium transition-colors hover:text-emerald-600',
                  projEdit && 'text-emerald-600',
                )}
                onClick={() => setProjEdit((v) => !v)}
              >
                <Pencil className="size-4" strokeWidth={1.75} /> {projEdit ? '完成' : '编辑'}
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* ================= 资料面板（学习工具） ================= */}
      {toolsOpen && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/45" onClick={() => setToolsOpen(false)} role="presentation">
          <div
            role="dialog"
            aria-label="学习工具"
            className="mx-auto w-full max-w-2xl rounded-t-3xl bg-background p-5 pb-10 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-muted" />
            <p className="mb-3 text-base font-bold">学习工具</p>
            <div className="grid grid-cols-4 gap-3">
              {COMMON_TOOLS.map((tool) => (
                <button
                  key={tool.key}
                  type="button"
                  onClick={() => {
                    setToolsOpen(false)
                    handleToolClick(tool.key)
                  }}
                  className="flex flex-col items-center gap-2 rounded-2xl border border-border bg-card py-4 transition-colors hover:bg-accent"
                >
                  <tool.icon className="size-6 text-foreground/80" strokeWidth={1.75} aria-hidden />
                  <span className="text-xs">{tool.label}</span>
                </button>
              ))}
            </div>
            <Button
              variant="outline"
              className="mt-5 w-full rounded-full"
              onClick={() => {
                setToolsOpen(false)
                onLogout()
              }}
            >
              退出登录
            </Button>
          </div>
        </div>
      )}

      {/* ================= 弹窗集合 ================= */}
      {/* 新建项目 */}
      <Dialog open={newProjOpen} onOpenChange={setNewProjOpen}>
        <DialogContent className="rounded-2xl sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>新建项目</DialogTitle>
          </DialogHeader>
          <Input
            value={newProjName}
            onChange={(e) => setNewProjName(e.target.value)}
            placeholder="项目名称"
            aria-label="项目名称"
            maxLength={30}
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNewProjOpen(false)}>取消</Button>
            <Button
              className="rounded-full bg-primary"
              disabled={!newProjName.trim()}
              onClick={() => {
                onCreateProject(newProjName.trim())
                setNewProjOpen(false)
              }}
            >
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重命名项目 */}
      <Dialog open={!!renameProj} onOpenChange={(v) => !v && setRenameProj(null)}>
        <DialogContent className="rounded-2xl sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>重命名项目</DialogTitle>
          </DialogHeader>
          <Input
            value={renameProj?.name ?? ''}
            onChange={(e) => setRenameProj((p) => (p ? { ...p, name: e.target.value } : p))}
            aria-label="项目名称"
            maxLength={30}
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameProj(null)}>取消</Button>
            <Button
              className="rounded-full bg-primary"
              disabled={!renameProj?.name.trim()}
              onClick={() => {
                if (renameProj) onRenameProject(renameProj.id, renameProj.name.trim())
                setRenameProj(null)
              }}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除项目（二次确认 + 卡片去向） */}
      <AlertDialog open={!!deleteProj} onOpenChange={(v) => !v && setDeleteProj(null)}>
        <AlertDialogContent className="rounded-2xl sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>删除项目「{deleteProj?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              项目里的 {countByCategory[deleteProj?.id ?? ''] ?? 0} 张卡片不会删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="text-sm">
            <p className="mb-1.5 font-medium">卡片移到哪里？</p>
            <Select
              value={moveTarget}
              onValueChange={setMoveTarget}
            >
              <SelectTrigger className="h-10 w-full rounded-xl"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__uncat__">未分类</SelectItem>
                {projects
                  .filter((p) => p.id !== deleteProj?.id)
                  .map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deleteProj) {
                  onDeleteProject(deleteProj.id)
                  if (activeCategoryId === deleteProj.id) onActiveCategoryChange('')
                }
                setDeleteProj(null)
              }}
            >
              删除项目
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 移动卡片到项目 */}
      <Dialog open={!!moveToProj} onOpenChange={(v) => !v && setMoveToProj(null)}>
        <DialogContent className="rounded-2xl sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>移动 {moveToProj?.ids.length ?? 0} 张卡片到…</DialogTitle>
          </DialogHeader>
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            <button
              type="button"
              className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent"
              onClick={() => {
                if (moveToProj) onBatchMove(moveToProj.ids, '')
                setMoveToProj(null)
              }}
            >
              <FileText className="size-4 text-muted-foreground" strokeWidth={1.75} /> 未分类
            </button>
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent"
                onClick={() => {
                  if (moveToProj) onBatchMove(moveToProj.ids, p.id)
                  setMoveToProj(null)
                }}
              >
                <Folder className="size-4 text-muted-foreground" strokeWidth={1.75} /> {p.name}
              </button>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMoveToProj(null)}>取消</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重命名卡片 */}
      <Dialog open={!!renameCard} onOpenChange={(v) => !v && setRenameCard(null)}>
        <DialogContent className="rounded-2xl sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>重命名卡片</DialogTitle>
          </DialogHeader>
          <Input
            value={renameCard?.title ?? ''}
            onChange={(e) => setRenameCard((p) => (p ? { ...p, title: e.target.value } : p))}
            aria-label="卡片标题"
            maxLength={60}
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameCard(null)}>取消</Button>
            <Button
              className="rounded-full bg-primary"
              disabled={!renameCard?.title.trim()}
              onClick={() => {
                if (renameCard) {
                  const card = cards.find((c) => c.id === renameCard.id)
                  if (card) onRenameCard(card, renameCard.title.trim())
                }
                setRenameCard(null)
              }}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量移动 */}
      <Dialog open={batchMoveOpen} onOpenChange={setBatchMoveOpen}>
        <DialogContent className="rounded-2xl sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>移动 {selected.size} 张卡片到…</DialogTitle>
          </DialogHeader>
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            <button
              type="button"
              className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent"
              onClick={() => {
                onBatchMove(Array.from(selected), '')
                setBatchMoveOpen(false)
                setBatchMode(false)
                setSelected(new Set())
              }}
            >
              <FileText className="size-4 text-muted-foreground" strokeWidth={1.75} /> 未分类
            </button>
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent"
                onClick={() => {
                  onBatchMove(Array.from(selected), p.id)
                  setBatchMoveOpen(false)
                  setBatchMode(false)
                  setSelected(new Set())
                }}
              >
                <Folder className="size-4 text-muted-foreground" strokeWidth={1.75} /> {p.name}
              </button>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBatchMoveOpen(false)}>取消</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除卡片（二次确认） */}
      <AlertDialog open={!!deleteCard} onOpenChange={(v) => !v && setDeleteCard(null)}>
        <AlertDialogContent className="rounded-2xl sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{deleteCard?.title}」？</AlertDialogTitle>
            <AlertDialogDescription>卡片将移入回收站，30 天后自动彻底删除。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deleteCard) onDeleteCard(deleteCard.id)
                setDeleteCard(null)
              }}
            >
              移入回收站
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// 侧边栏项目行
function ProjRow({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-accent',
        active && 'bg-accent font-semibold',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      {count > 0 && <span className="text-xs text-muted-foreground">{count}</span>}
    </button>
  )
}

// 卡片行（截图6）：文件图标 + 标题 + 日期 + ⋯ 菜单
function CardRow({
  card,
  projectName,
  query,
  excerpt,
  batchMode,
  checked,
  onToggle,
  onOpen,
  onShare,
  onRename,
  onTogglePin,
  onMove,
  onDuplicate,
  onDelete,
  onReorder,
}: {
  card: CardData
  projectName?: string
  query: string
  excerpt: { before: string; hit: string; after: string } | null
  batchMode: boolean
  checked: boolean
  onToggle: () => void
  onOpen: () => void
  onShare: () => void
  onRename: () => void
  onTogglePin: () => void
  onMove: () => void
  onDuplicate: () => void
  onDelete: () => void
  onReorder: (dir: -1 | 1) => void
}) {
  const [menuOpen, setMenuOpen] = React.useState(false)

  const titleWithHighlight = (text: string) => {
    const q = query.trim()
    if (!q) return text
    const idx = text.toLowerCase().indexOf(q.toLowerCase())
    if (idx < 0) return text
    return (
      <>
        {text.slice(0, idx)}
        <mark className="rounded bg-amber-200 px-0.5 text-foreground dark:bg-amber-500/40">
          {text.slice(idx, idx + q.length)}
        </mark>
        {text.slice(idx + q.length)}
      </>
    )
  }

  return (
    <li
      className={cn(
        'group relative flex cursor-pointer items-center gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm transition-all hover:shadow-md',
        checked && 'border-emerald-600/60 ring-1 ring-emerald-600/40',
      )}
      onClick={() => (batchMode ? onToggle() : onOpen())}
      role="button"
      tabIndex={0}
      aria-label={`打开背书卡：${card.title}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (batchMode) onToggle()
          else onOpen()
        }
      }}
    >
      {batchMode && (
        <span
          aria-hidden
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
            checked ? 'border-foreground bg-foreground text-background' : 'border-muted-foreground/40',
          )}
        >
          {checked && <SquareCheckBig className="size-3.5" strokeWidth={2.5} />}
        </span>
      )}
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <FileText className="size-5" strokeWidth={1.5} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {card.pinned && <Pin className="size-3 shrink-0 text-amber-500" strokeWidth={2} aria-label="已置顶" />}
          <h3 className="min-w-0 flex-1 truncate text-[15px] font-bold leading-snug">
            {titleWithHighlight(card.title)}
          </h3>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {excerpt ? (
            <>
              {excerpt.before}
              <mark className="rounded bg-amber-200 px-0.5 text-foreground dark:bg-amber-500/40">{excerpt.hit}</mark>
              {excerpt.after}
            </>
          ) : (
            <>
              {projectName ? `${projectName} · ` : ''}
              {formatDistanceToNow(new Date(card.updatedAt), { addSuffix: true, locale: zhCN })} ·{' '}
              {card.content.length} 字 · {card.keywords.length} 挖空
            </>
          )}
        </p>
      </div>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`更多操作：${card.title}`}
            className="shrink-0 rounded-full p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={(e) => e.stopPropagation()}
          >
            <AlignLeft className="size-5 rotate-90" strokeWidth={1.75} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-44 rounded-2xl p-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          {(
            [
              { label: card.pinned ? '取消置顶' : '置顶', icon: card.pinned ? PinOff : Pin, fn: onTogglePin },
              { label: '重命名', icon: Pencil, fn: onRename },
              { label: '分享', icon: Share2, fn: onShare },
              { label: '移动到项目', icon: FolderOpen, fn: onMove },
              { label: '创建副本', icon: Copy, fn: onDuplicate },
            ] as const
          ).map((item) => (
            <button
              key={item.label}
              type="button"
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(false)
                item.fn()
              }}
            >
              <item.icon className="size-4 text-muted-foreground" strokeWidth={1.75} />
              {item.label}
            </button>
          ))}
          {sortModeAlwaysShow && (
            <>
              <div className="my-1 border-t border-border" />
              <div className="flex items-center justify-between px-3 py-1">
                <span className="text-[11px] text-muted-foreground">排序</span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    aria-label="上移"
                    className="rounded-lg px-2 py-1 text-xs hover:bg-accent"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuOpen(false)
                      onReorder(-1)
                    }}
                  >
                    ↑ 上移
                  </button>
                  <button
                    type="button"
                    aria-label="下移"
                    className="rounded-lg px-2 py-1 text-xs hover:bg-accent"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuOpen(false)
                      onReorder(1)
                    }}
                  >
                    ↓ 下移
                  </button>
                </div>
              </div>
            </>
          )}
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen(false)
              onDelete()
            }}
          >
            <Trash2 className="size-4" strokeWidth={1.75} />
            删除
          </button>
        </PopoverContent>
      </Popover>
    </li>
  )
}

const sortModeAlwaysShow = true
