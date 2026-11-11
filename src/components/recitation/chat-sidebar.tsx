'use client'

// ChatSidebar — AI 对话侧边栏（内容组件，不自带 Sheet；由 page.tsx 用
// Sheet side="left" 或全屏覆盖挂载，open/onOpenChange 控制显隐与数据加载）。
//
// 功能：
//   • 对话列表：主对话「AI问问」永远置顶第一位（Sparkles 图标 + 主对话徽标 +
//     置顶钉；长按/右键/⋮ 菜单仅「导出 / 清空消息」）+ 置顶分组 + 排序。
//   • 排序（头部控件，偏好存 localStorage）：
//     自定义拖动（@dnd-kit 触摸拖动，PATCH /api/conversations reorder 持久化）
//     / 最近更新 / 创建时间 / 标题 × 正序/倒序；主对话不参与排序。
//   • 每行更多菜单（⋮ 下拉 + 长按/右键同款菜单）：置顶、重命名、
//     AI 智能重命名（PATCH autoRename）、分享（先选有效期 → POST
//     /api/shares → 复制链接）、导出（格式选择弹窗）、删除（确认）。
//     主对话仅「导出 / 清空消息」；批量管理模式下长按菜单禁用。
//   • 顶部新建对话（类型：自由对话/题目解析/收藏解析/追问）。
//   • 一级全局搜索：GET /api/conversations?q= →「标题命中」对话列表 +
//     「内容命中」消息列表（关键词高亮，点击跳转该对话）。
//   • 批量管理：复选框模式，全选 / 批量删除（确认，主对话跳过）/
//     批量导出（conversation-export 引擎，格式选择弹窗）/ 批量分享
//     （先选有效期，逐个创建并列出链接；主对话跳过）。
//
// 本文件同时导出对话相关的共享工具（类型 / 分享），ChatTool 复用。
import * as React from 'react'
import {
  ArrowUpDown,
  Check,
  CheckSquare,
  Download,
  GripVertical,
  Loader2,
  MoreVertical,
  MessageSquarePlus,
  Pin,
  PinOff,
  Pencil,
  Search,
  Share2,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import type { ExportSection } from '@/lib/conversation-export'
import { ConversationShareDialog } from '@/components/recitation/conversation-share-dialog'
import { ConversationExportDialog } from '@/components/recitation/conversation-export-dialog'
import { LongPressMenu } from '@/components/recitation/long-press-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// ---------- 共享类型 / 工具（ChatTool 也使用） ----------

export interface ConversationSummary {
  id: string
  title: string
  type: string
  pinned: boolean
  cardId: string
  /** 自定义排序序号（主对话恒 -1000000）。 */
  ord?: number
  /** 主对话「AI问问」：不可删除/改名/整对话分享，仅可清空消息。 */
  isMain?: boolean
  messageCount: number
  lastMessage: string
  lastAt: string
  createdAt: string
  updatedAt: string
}

export interface ConversationMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  images?: string[]
  createdAt: string
}

export interface ConversationDetail {
  conversation: ConversationSummary
  messages: ConversationMessage[]
}

/** 对话类型徽章（chat/analysis/favorite/followup/supervise）。 */
export const CONV_TYPES: Record<string, { emoji: string; label: string }> = {
  chat: { emoji: '💬', label: '对话' },
  analysis: { emoji: '📝', label: '解析' },
  favorite: { emoji: '⭐', label: '收藏' },
  followup: { emoji: '🔍', label: '追问' },
  supervise: { emoji: '🧭', label: '督背' },
}

export function convTypeMeta(type: string): { emoji: string; label: string } {
  return CONV_TYPES[type] ?? { emoji: '💬', label: type || '对话' }
}

/** 列表时间：今天 → HH:mm；同年 → M月D日；跨年 → YYYY年M月D日。 */
export function formatConvTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  if (d.toDateString() === now.toDateString()) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年${md}`
}

/** 拉取单个对话详情（含全部消息）。失败返回 null。 */
export async function fetchConversation(
  id: string,
): Promise<ConversationDetail | null> {
  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`)
    if (!res.ok) return null
    const data = (await res.json()) as Partial<ConversationDetail>
    if (!data?.conversation || !Array.isArray(data.messages)) return null
    return { conversation: data.conversation, messages: data.messages }
  } catch {
    return null
  }
}

/**
 * 创建对话分享并复制链接（与卡片分享一致的 /share/<token> 格式）。
 * @param messageIds 可选：只分享勾选的消息（服务端复制为快照对话）。
 */
export async function shareConversationLink(
  id: string,
  days = 0,
  messageIds?: string[],
): Promise<string | null> {
  try {
    const res = await fetch('/api/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create',
        kind: 'conversation',
        conversationId: id,
        days,
        ...(messageIds && messageIds.length > 0 ? { messageIds } : {}),
      }),
    })
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(e.error || '创建分享失败')
    }
    const data = (await res.json()) as { share?: { token?: string } }
    const token = data.share?.token
    if (!token) throw new Error('创建分享失败')
    const link = `${window.location.origin}/share/${token}`
    try {
      await navigator.clipboard.writeText(link)
      toast.success('分享链接已复制')
    } catch {
      toast.info(`分享链接：${link}`)
    }
    return link
  } catch (err) {
    toast.error(err instanceof Error ? err.message : '分享失败')
    return null
  }
}

/** 确保主对话存在（POST /api/conversations ensure-main），返回主对话或 null。 */
export async function ensureMainConversation(): Promise<ConversationSummary | null> {
  try {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ensure-main' }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { conversation?: ConversationSummary }
    return data.conversation ?? null
  } catch {
    return null
  }
}

// ---------- 排序偏好 ----------

type SortKey = 'custom' | 'updated' | 'created' | 'title'
type SortDir = 'asc' | 'desc'

interface SortPref {
  key: SortKey
  dir: SortDir
}

const SORT_PREF_KEY = 'bs:conv-sort'
/** 默认：最近更新 + 倒序（与历史行为一致）。 */
const DEFAULT_SORT: SortPref = { key: 'updated', dir: 'desc' }

const SORT_KEY_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'custom', label: '自定义拖动' },
  { value: 'updated', label: '最近更新' },
  { value: 'created', label: '创建时间' },
  { value: 'title', label: '标题' },
]

function loadSortPref(): SortPref {
  try {
    const raw = window.localStorage.getItem(SORT_PREF_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<SortPref>
      if (
        (p.key === 'custom' || p.key === 'updated' || p.key === 'created' || p.key === 'title') &&
        (p.dir === 'asc' || p.dir === 'desc')
      ) {
        return { key: p.key, dir: p.dir }
      }
    }
  } catch {
    /* 损坏则用默认 */
  }
  return DEFAULT_SORT
}

/** 非主对话排序（custom=ord 顺序；其余按 key+dir，ord 相同回退更新时间倒序）。 */
function sortRestConvs(
  list: ConversationSummary[],
  pref: SortPref,
): ConversationSummary[] {
  const rest = [...list]
  switch (pref.key) {
    case 'custom':
      rest.sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0) || b.updatedAt.localeCompare(a.updatedAt))
      return pref.dir === 'desc' ? rest.reverse() : rest
    case 'created': {
      const cmp = (a: ConversationSummary, b: ConversationSummary) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
      rest.sort(cmp)
      return pref.dir === 'desc' ? rest.reverse() : rest
    }
    case 'title': {
      const cmp = (a: ConversationSummary, b: ConversationSummary) =>
        a.title.localeCompare(b.title, 'zh-Hans-CN') || a.id.localeCompare(b.id)
      rest.sort(cmp)
      return pref.dir === 'desc' ? rest.reverse() : rest
    }
    case 'updated':
    default: {
      const cmp = (a: ConversationSummary, b: ConversationSummary) =>
        a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id)
      rest.sort(cmp)
      return pref.dir === 'desc' ? rest.reverse() : rest
    }
  }
}

// ---------- 搜索结果类型 ----------

interface MessageHit {
  messageId: string
  conversationId: string
  role: string
  snippet: string
  createdAt: string
}

interface SearchResult {
  conversations: ConversationSummary[]
  titleHits: string[]
  messageHits: MessageHit[]
}

// ---------- 组件 ----------

interface ChatSidebarProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 当前活动对话 id（高亮）。 */
  activeConversationId?: string
  /** 选中对话（点击行 / 搜索命中）。 */
  onSelect: (id: string) => void
  /**
   * 新建对话回调（page.tsx 负责创建并打开）。未传时组件自建
   * （POST /api/conversations）并 dispatch 'app:openConversation'。
   */
  onNewConversation?: (type?: string) => void
  /** 新对话默认绑定的卡片（可选）。 */
  cardId?: string
  cardTitle?: string
}

const NEW_TYPE_OPTIONS: { type: string; emoji: string; label: string; desc: string }[] = [
  { type: 'chat', emoji: '💬', label: '自由对话', desc: '随便聊，问课文、问知识' },
  { type: 'analysis', emoji: '📝', label: '题目解析', desc: '针对错题/题目的深度解析' },
  { type: 'favorite', emoji: '⭐', label: '收藏解析', desc: '针对收藏内容的讲解' },
  { type: 'followup', emoji: '🔍', label: '追问', desc: '选中文本后的连续追问' },
]

/** 搜索片段关键词高亮（首个命中）。 */
function Highlight({ text, kw }: { text: string; kw: string }) {
  if (!kw) return <>{text}</>
  const idx = text.toLowerCase().indexOf(kw.toLowerCase())
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-amber-300/60 px-0.5 text-inherit dark:bg-amber-500/40">
        {text.slice(idx, idx + kw.length)}
      </mark>
      {text.slice(idx + kw.length)}
    </>
  )
}

const SCROLLBAR =
  '[scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:min-h-6 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent'

// ---------- 可排序行包装（自定义拖动模式） ----------

function SortableRow({
  id,
  disabled,
  children,
}: {
  id: string
  disabled?: boolean
  children: React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative', isDragging && 'z-20 opacity-90')}
    >
      {children}
      {!disabled && (
        <button
          type="button"
          aria-label="拖动排序"
          title="拖动排序"
          className="absolute left-0 top-1/2 z-10 flex size-8 -translate-y-1/2 touch-none items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:text-foreground"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
      )}
    </div>
  )
}

export function ChatSidebar({
  open,
  onOpenChange,
  activeConversationId,
  onSelect,
  onNewConversation,
  cardId,
}: ChatSidebarProps) {
  const [convs, setConvs] = React.useState<ConversationSummary[]>([])
  const [loading, setLoading] = React.useState(false)
  // ---- 排序偏好（localStorage 记忆） ----
  const [sortPref, setSortPref] = React.useState<SortPref>(DEFAULT_SORT)
  // ---- 搜索（一级全局搜索） ----
  const [searchQ, setSearchQ] = React.useState('')
  const [searching, setSearching] = React.useState(false)
  const [searchResult, setSearchResult] = React.useState<SearchResult | null>(null)
  // ---- 批量管理 ----
  const [manageMode, setManageMode] = React.useState(false)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [batchBusy, setBatchBusy] = React.useState(false)
  // ---- 单条操作 ----
  const [renameTarget, setRenameTarget] = React.useState<ConversationSummary | null>(null)
  const [renameValue, setRenameValue] = React.useState('')
  const [renaming, setRenaming] = React.useState(false)
  const [aiRenamingId, setAiRenamingId] = React.useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<ConversationSummary | null>(null)
  const [deleting, setDeleting] = React.useState(false)
  // ---- 主对话清空消息 ----
  const [clearMainTarget, setClearMainTarget] = React.useState<ConversationSummary | null>(null)
  const [clearingMain, setClearingMain] = React.useState(false)
  // ---- 批量分享结果 ----
  const [shareLinks, setShareLinks] = React.useState<
    { title: string; link: string }[] | null
  >(null)
  // ---- 分享有效期对话框（单条 shareTarget / 批量 batchShareOpen） ----
  const [shareTarget, setShareTarget] = React.useState<ConversationSummary | null>(null)
  const [batchShareOpen, setBatchShareOpen] = React.useState(false)
  // ---- 导出（单条 / 批量，走 conversation-export 引擎） ----
  const [exportOpen, setExportOpen] = React.useState(false)
  const [exportSections, setExportSections] = React.useState<ExportSection[]>([])
  const [exportAllowImage, setExportAllowImage] = React.useState(true)
  const [exportBusyTip, setExportBusyTip] = React.useState(false)

  // 排序偏好：挂载读取 localStorage，变化时写回
  React.useEffect(() => {
    setSortPref(loadSortPref())
  }, [])
  React.useEffect(() => {
    try {
      window.localStorage.setItem(SORT_PREF_KEY, JSON.stringify(sortPref))
    } catch {
      /* 隐私模式忽略 */
    }
  }, [sortPref])

  const loadConversations = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/conversations')
      if (!res.ok) return
      const data = (await res.json()) as { conversations?: ConversationSummary[] }
      const list = data.conversations ?? []
      // 兜底：主对话缺失（极端时序）→ ensure-main 后重拉一次
      if (!list.some((c) => c.isMain)) {
        const main = await ensureMainConversation()
        if (main) {
          const res2 = await fetch('/api/conversations')
          if (res2.ok) {
            const data2 = (await res2.json()) as { conversations?: ConversationSummary[] }
            setConvs(data2.conversations ?? [])
            return
          }
        }
      }
      setConvs(list)
    } catch {
      /* 静默失败，保留现有列表 */
    } finally {
      setLoading(false)
    }
  }, [])

  // 打开时加载列表；关闭时退出批量模式
  React.useEffect(() => {
    if (open) {
      void loadConversations()
    } else {
      setManageMode(false)
      setSelected(new Set())
      setSearchQ('')
      setSearchResult(null)
    }
  }, [open, loadConversations])

  // 搜索防抖（≥1 字才搜）
  React.useEffect(() => {
    const q = searchQ.trim()
    if (!q) {
      setSearchResult(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(
            `/api/conversations?q=${encodeURIComponent(q)}`,
          )
          if (!res.ok) return
          const data = (await res.json()) as Partial<SearchResult>
          setSearchResult({
            conversations: data.conversations ?? [],
            titleHits: data.titleHits ?? [],
            messageHits: data.messageHits ?? [],
          })
        } catch {
          /* 搜索失败保留空结果 */
        } finally {
          setSearching(false)
        }
      })()
    }, 350)
    return () => {
      window.clearTimeout(timer)
    }
  }, [searchQ])

  const convById = React.useMemo(() => {
    const m = new Map<string, ConversationSummary>()
    for (const c of convs) m.set(c.id, c)
    return m
  }, [convs])

  // 主对话永远第一；其余按排序偏好（custom 模式支持拖动）
  const mainConv = React.useMemo(() => convs.find((c) => c.isMain), [convs])
  const sortedRest = React.useMemo(
    () => sortRestConvs(convs.filter((c) => !c.isMain), sortPref),
    [convs, sortPref],
  )
  const pinnedRest = React.useMemo(
    () => sortedRest.filter((c) => c.pinned),
    [sortedRest],
  )
  const othersRest = React.useMemo(
    () => sortedRest.filter((c) => !c.pinned),
    [sortedRest],
  )
  const isCustomSort = sortPref.key === 'custom'

  // ---------- 拖动排序（自定义模式） ----------

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const oldIndex = sortedRest.findIndex((c) => c.id === active.id)
    const newIndex = sortedRest.findIndex((c) => c.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const next = arrayMove(sortedRest, oldIndex, newIndex)
    const orderedIds = next.map((c) => c.id)
    // 本地立即生效（主对话保持在最前）
    setConvs((prev) => {
      const main = prev.find((c) => c.isMain)
      const restNext = orderedIds
        .map((id) => prev.find((c) => c.id === id))
        .filter((c): c is ConversationSummary => !!c)
      const restIds = new Set(orderedIds)
      const leftover = prev.filter((c) => !c.isMain && !restIds.has(c.id))
      return main ? [main, ...restNext, ...leftover] : [...restNext, ...leftover]
    })
    // 持久化 ord（0,1,2…）
    void (async () => {
      try {
        const res = await fetch('/api/conversations', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'reorder', ids: orderedIds }),
        })
        if (!res.ok) throw new Error('保存失败')
        toast.success('排序已保存')
      } catch {
        toast.error('排序保存失败')
      }
    })()
  }

  // ---------- 操作 ----------

  const patchConversation = async (
    id: string,
    body: Record<string, unknown>,
  ): Promise<ConversationSummary | null> => {
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(e.error || '操作失败')
      }
      const data = (await res.json()) as { conversation?: ConversationSummary }
      if (!data.conversation) return null
      const updated = data.conversation
      // 仅替换条目；显示顺序由 sortedRest 排序逻辑自动接管
      setConvs((prev) => prev.map((c) => (c.id === id ? updated : c)))
      return data.conversation
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
      return null
    }
  }

  const handleTogglePin = (c: ConversationSummary) => {
    void patchConversation(c.id, { pinned: !c.pinned })
  }

  const handleRename = async () => {
    if (!renameTarget) return
    const title = renameValue.trim()
    if (!title) return
    setRenaming(true)
    const updated = await patchConversation(renameTarget.id, { title })
    setRenaming(false)
    if (updated) {
      toast.success('已重命名')
      setRenameTarget(null)
    }
  }

  const handleAiRename = async (c: ConversationSummary) => {
    if (aiRenamingId) return
    setAiRenamingId(c.id)
    const updated = await patchConversation(c.id, { autoRename: true })
    setAiRenamingId(null)
    if (updated) toast.success('AI 已生成标题')
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(deleteTarget.id)}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(e.error || '删除失败')
      }
      setConvs((prev) => prev.filter((c) => c.id !== deleteTarget.id))
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(deleteTarget.id)
        return next
      })
      toast.success('对话已删除')
      setDeleteTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setDeleting(false)
    }
  }

  /** 主对话清空消息（唯一允许的破坏性操作）。 */
  const handleClearMain = async () => {
    if (!clearMainTarget) return
    setClearingMain(true)
    try {
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(clearMainTarget.id)}/messages`,
        { method: 'DELETE' },
      )
      if (!res.ok) throw new Error('清空失败')
      setConvs((prev) =>
        prev.map((c) =>
          c.id === clearMainTarget.id
            ? { ...c, messageCount: 0, lastMessage: '', lastAt: new Date().toISOString() }
            : c,
        ),
      )
      toast.success('已清空 AI问问 的消息')
      setClearMainTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '清空失败')
    } finally {
      setClearingMain(false)
    }
  }

  const handleNew = async (type: string) => {
    if (onNewConversation) {
      onNewConversation(type)
      onOpenChange(false)
      return
    }
    // 兜底：自建对话并通知 page.tsx 打开
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, cardId: cardId ?? '' }),
      })
      if (!res.ok) throw new Error('新建对话失败')
      const data = (await res.json()) as { conversation?: { id?: string } }
      const id = data.conversation?.id
      if (!id) throw new Error('新建对话失败')
      window.dispatchEvent(
        new CustomEvent('app:openConversation', { detail: { id } }),
      )
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '新建对话失败')
    }
  }

  // ---------- 导出（单条 / 批量，conversation-export 引擎 + 格式弹窗） ----------

  const openExportDialog = async (targets: ConversationSummary[]) => {
    if (targets.length === 0) return
    setExportBusyTip(true)
    const tid = toast.loading('正在加载对话内容…')
    try {
      const sections: ExportSection[] = []
      for (const c of targets) {
        const detail = await fetchConversation(c.id)
        if (!detail) continue
        sections.push({
          title: detail.conversation.title,
          type: detail.conversation.type,
          messages: detail.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            ...(m.images && m.images.length > 0 ? { images: m.images } : {}),
            createdAt: m.createdAt,
          })),
        })
      }
      if (sections.length === 0) {
        toast.error('导出失败：对话加载失败', { id: tid })
        return
      }
      toast.dismiss(tid)
      setExportAllowImage(targets.length === 1)
      setExportSections(sections)
      setExportOpen(true)
    } finally {
      setExportBusyTip(false)
    }
  }

  // ---------- 批量操作 ----------

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected = convs.length > 0 && selected.size === convs.length

  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(convs.map((c) => c.id)))
  }

  const selectedConvs = React.useMemo(
    () => convs.filter((c) => selected.has(c.id)),
    [convs, selected],
  )
  /** 批量删除/分享跳过主对话（可勾选导出）。 */
  const selectedActionable = React.useMemo(
    () => selectedConvs.filter((c) => !c.isMain),
    [selectedConvs],
  )

  const handleBatchDelete = async () => {
    if (selectedActionable.length === 0) {
      toast.info('主对话不参与删除')
      return
    }
    setBatchBusy(true)
    let ok = 0
    for (const c of selectedActionable) {
      try {
        const res = await fetch(`/api/conversations/${encodeURIComponent(c.id)}`, {
          method: 'DELETE',
        })
        if (res.ok) ok += 1
      } catch {
        /* 单条失败继续 */
      }
    }
    setBatchBusy(false)
    const deletedIds = new Set(selectedActionable.map((c) => c.id))
    setConvs((prev) => prev.filter((c) => !deletedIds.has(c.id)))
    setSelected(new Set())
    toast.success(`已删除 ${ok} 个对话`)
  }

  const handleBatchShare = async (days: number) => {
    if (selectedActionable.length === 0) {
      toast.info('主对话不参与分享，请勾选消息后分享')
      return
    }
    setBatchBusy(true)
    const tid = toast.loading('正在创建分享…')
    const links: { title: string; link: string }[] = []
    for (const c of selectedActionable) {
      const link = await shareConversationLink(c.id, days)
      if (link) links.push({ title: c.title, link })
    }
    setBatchBusy(false)
    toast.dismiss(tid)
    if (links.length === 0) {
      toast.error('分享失败')
      return
    }
    setShareLinks(links)
  }

  const copyAllLinks = async () => {
    if (!shareLinks) return
    try {
      await navigator.clipboard.writeText(shareLinks.map((l) => l.link).join('\n'))
      toast.success('已复制全部链接')
    } catch {
      toast.error('复制失败')
    }
  }

  // ---------- 行渲染 ----------

  /** 主对话行：Sparkles 图标 + 主对话徽标 + 置顶钉；长按/右键仅「导出/清空消息」。 */
  const renderMainRow = (c: ConversationSummary) => {
    const active = activeConversationId === c.id
    const checked = selected.has(c.id)
    return (
      <LongPressMenu
        key={c.id}
        className="block w-full"
        actions={[
          { key: 'export', label: '导出', icon: <Download className="size-4" /> },
          { key: 'clear', label: '清空消息', icon: <Trash2 className="size-4" />, danger: true },
        ]}
        onAction={(key) => {
          if (key === 'export') void openExportDialog([c])
          else setClearMainTarget(c)
        }}
      >
        <div
          className={cn(
            'flex items-center gap-1.5 rounded-xl border px-2 py-2 transition-colors',
            active
              ? 'border-emerald-500/40 bg-gradient-to-r from-emerald-500/15 to-sky-500/10'
              : 'border-emerald-500/25 bg-emerald-500/5 hover:bg-emerald-500/10',
            checked && 'ring-1 ring-primary/30',
          )}
        >
          {manageMode && (
            <Checkbox
              checked={checked}
              onCheckedChange={() => toggleSelect(c.id)}
              aria-label={`选择 ${c.title}（仅导出）`}
              className="shrink-0"
            />
          )}
          <button
            type="button"
            onClick={() => {
              if (manageMode) {
                toggleSelect(c.id)
                return
              }
              onSelect(c.id)
              onOpenChange(false)
            }}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500 to-sky-500 text-white"
              aria-hidden
            >
              <Sparkles className="size-4" strokeWidth={2.25} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-sm font-semibold">{c.title}</span>
                <span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-px text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                  主对话
                </span>
                <Pin className="size-3 shrink-0 text-amber-500" strokeWidth={2.25} />
              </span>
              <span className="mt-0.5 flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {c.lastMessage || '（空对话）'}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
                  {formatConvTime(c.lastAt)} · {c.messageCount}条
                </span>
              </span>
            </span>
          </button>
          {!manageMode && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`更多操作：${c.title}`}
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <MoreVertical className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem onClick={() => void openExportDialog([c])}>
                  <Download className="size-4" />
                  导出
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setClearMainTarget(c)}
                >
                  <Trash2 className="size-4" />
                  清空消息
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </LongPressMenu>
    )
  }

  const renderRow = (c: ConversationSummary, dragHandle?: boolean) => {
    if (c.isMain) return renderMainRow(c)
    const meta = convTypeMeta(c.type)
    const active = activeConversationId === c.id
    const checked = selected.has(c.id)
    const sortable = isCustomSort && !manageMode && !searchQ.trim()
    const inner = (
      <div
        className={cn(
          'flex items-center gap-1.5 rounded-xl border border-transparent px-2 py-2 transition-colors',
          active ? 'border-emerald-500/30 bg-emerald-500/10' : 'hover:bg-accent/60',
          checked && 'bg-primary/5',
        )}
      >
        {manageMode ? (
          <Checkbox
            checked={checked}
            onCheckedChange={() => toggleSelect(c.id)}
            aria-label={`选择 ${c.title}`}
            className="shrink-0"
          />
        ) : dragHandle ? (
          /* 拖动把手占位（可拖图标由 SortableRow 的绝对定位把手渲染） */
          <span className="w-6 shrink-0 self-center" aria-hidden />
        ) : null}
        <button
          type="button"
          onClick={() => {
            if (manageMode) {
              toggleSelect(c.id)
              return
            }
            onSelect(c.id)
            onOpenChange(false)
          }}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm"
            aria-hidden
          >
            {meta.emoji}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium">{c.title}</span>
              {c.pinned && (
                <Pin className="size-3 shrink-0 text-amber-500" strokeWidth={2.25} />
              )}
            </span>
            <span className="mt-0.5 flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {c.lastMessage || '（空对话）'}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
                {formatConvTime(c.lastAt)} · {c.messageCount}条
              </span>
            </span>
          </span>
        </button>
        {!manageMode && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`更多操作：${c.title}`}
                className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <MoreVertical className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => handleTogglePin(c)}>
                {c.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                {c.pinned ? '取消置顶' : '置顶'}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setRenameTarget(c)
                  setRenameValue(c.title)
                }}
              >
                <Pencil className="size-4" />
                重命名
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={aiRenamingId === c.id}
                onClick={() => void handleAiRename(c)}
              >
                {aiRenamingId === c.id ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                AI 智能重命名
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShareTarget(c)}>
                <Share2 className="size-4" />
                分享
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void openExportDialog([c])}>
                <Download className="size-4" />
                导出
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setDeleteTarget(c)}
              >
                <Trash2 className="size-4" />
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    )
    // 长按/右键菜单（与 ⋮ 更多菜单同款操作；批量管理模式下禁用）
    const withMenu = manageMode ? (
      inner
    ) : (
      <LongPressMenu
        className="block w-full"
        actions={[
          {
            key: 'pin',
            label: c.pinned ? '取消置顶' : '置顶',
            icon: c.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />,
          },
          { key: 'rename', label: '重命名', icon: <Pencil className="size-4" /> },
          {
            key: 'aiRename',
            label: 'AI 智能重命名',
            icon:
              aiRenamingId === c.id ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              ),
          },
          { key: 'share', label: '分享', icon: <Share2 className="size-4" /> },
          { key: 'export', label: '导出', icon: <Download className="size-4" /> },
          { key: 'delete', label: '删除', icon: <Trash2 className="size-4" />, danger: true },
        ]}
        onAction={(key) => {
          switch (key) {
            case 'pin':
              handleTogglePin(c)
              break
            case 'rename':
              setRenameTarget(c)
              setRenameValue(c.title)
              break
            case 'aiRename':
              void handleAiRename(c)
              break
            case 'share':
              setShareTarget(c)
              break
            case 'export':
              void openExportDialog([c])
              break
            case 'delete':
              setDeleteTarget(c)
              break
          }
        }}
      >
        {inner}
      </LongPressMenu>
    )
    return sortable ? (
      <SortableRow key={c.id} id={c.id} disabled={manageMode}>
        {withMenu}
      </SortableRow>
    ) : (
      <React.Fragment key={c.id}>{withMenu}</React.Fragment>
    )
  }

  // ---------- 渲染 ----------

  if (!open) return null

  const q = searchQ.trim()
  const searchMode = !!q || !!searchResult

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-1.5 px-3 pt-1">
        <p className="min-w-0 flex-1 truncate text-sm font-bold">AI 对话</p>
        {/* 排序控件：自定义拖动 / 最近更新 / 创建时间 / 标题 × 正序/倒序 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="排序方式"
              title="排序方式"
              className={cn(
                'flex size-8 items-center justify-center rounded-full border transition-colors',
                isCustomSort
                  ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <ArrowUpDown className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {SORT_KEY_OPTIONS.map((opt) => (
              <DropdownMenuItem
                key={opt.value}
                onClick={() => setSortPref((p) => ({ ...p, key: opt.value }))}
              >
                <span className="flex size-4 items-center justify-center">
                  {sortPref.key === opt.value ? (
                    <Check className="size-4 text-emerald-600" />
                  ) : null}
                </span>
                {opt.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => setSortPref((p) => ({ ...p, dir: 'asc' }))}
            >
              <span className="flex size-4 items-center justify-center">
                {sortPref.dir === 'asc' ? (
                  <Check className="size-4 text-emerald-600" />
                ) : null}
              </span>
              正序
              <span className="ml-auto text-[10px] text-muted-foreground">
                {sortPref.key === 'title' ? 'A→Z' : sortPref.key === 'custom' ? '拖动↑' : '旧→新'}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => setSortPref((p) => ({ ...p, dir: 'desc' }))}
            >
              <span className="flex size-4 items-center justify-center">
                {sortPref.dir === 'desc' ? (
                  <Check className="size-4 text-emerald-600" />
                ) : null}
              </span>
              倒序
              <span className="ml-auto text-[10px] text-muted-foreground">
                {sortPref.key === 'title' ? 'Z→A' : sortPref.key === 'custom' ? '拖动↓' : '新→旧'}
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          onClick={() => setManageMode((v) => !v)}
          aria-pressed={manageMode}
          className={cn(
            'flex h-8 items-center gap-1 rounded-full border px-2.5 text-xs transition-colors',
            manageMode
              ? 'border-primary/40 bg-primary/10 text-foreground'
              : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          {manageMode ? <CheckSquare className="size-3.5" /> : <Square className="size-3.5" />}
          {manageMode ? '完成' : '管理'}
        </button>
        {/* 关闭：宿主 SheetContent 已自带右上角 X（shadcn 内置 Close）——
            这里再渲染一个 X 会与之叠在右上角（「叉叉重复叠在一起」），已移除 */}
      </div>

      {/* 新建对话（类型选择） */}
      {!manageMode && (
        <div className="px-3 pt-2.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="h-10 w-full rounded-xl bg-gradient-to-r from-emerald-500 to-sky-500 font-semibold text-white hover:from-emerald-600 hover:to-sky-600">
                <MessageSquarePlus className="size-4" />
                新建对话
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60">
              {NEW_TYPE_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.type}
                  onClick={() => void handleNew(opt.type)}
                  className="gap-2"
                >
                  <span aria-hidden>{opt.emoji}</span>
                  <span className="flex flex-col">
                    <span className="text-sm font-medium">{opt.label}</span>
                    <span className="text-[11px] text-muted-foreground">{opt.desc}</span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {/* 全局搜索框 */}
      {!manageMode && (
        <div className="flex items-center gap-1.5 px-3 py-2.5">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              placeholder="搜索全部对话内容…"
              aria-label="搜索对话"
              className="h-9 rounded-full pl-8 pr-8 text-sm"
            />
            {searchQ && (
              <button
                type="button"
                onClick={() => setSearchQ('')}
                aria-label="清空搜索"
                className="absolute right-2 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-accent"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* 批量管理操作条 */}
      {manageMode && (
        <div className="flex items-center gap-1.5 px-3 py-2.5">
          <button
            type="button"
            onClick={toggleSelectAll}
            className="flex h-8 items-center gap-1 rounded-full border border-border px-2.5 text-xs transition-colors hover:bg-accent"
          >
            {allSelected ? '取消全选' : '全选'}
          </button>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            已选 {selected.size} / {convs.length}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-full text-xs"
            disabled={batchBusy || exportBusyTip || selected.size === 0}
            onClick={() => void openExportDialog(selectedConvs)}
          >
            <Download className="size-3.5" />
            导出
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-full text-xs"
            disabled={batchBusy || selected.size === 0}
            onClick={() => setBatchShareOpen(true)}
          >
            <Share2 className="size-3.5" />
            分享
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={batchBusy || selected.size === 0}
                className="h-8 rounded-full border-destructive/40 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
                删除
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>批量删除对话</AlertDialogTitle>
                <AlertDialogDescription>
                  将删除所选 {selected.size} 个对话及其全部消息（主对话会自动跳过），此操作无法恢复。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-white hover:bg-destructive/90"
                  onClick={() => void handleBatchDelete()}
                >
                  删除
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}

      {/* 列表 / 搜索结果 */}
      <div className={cn('min-h-0 flex-1 overflow-y-auto px-2 pb-4', SCROLLBAR)}>
        {searchMode ? (
          /* ---- 搜索结果 ---- */
          <div className="flex flex-col gap-1">
            {searching && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> 搜索中…
              </div>
            )}
            {!searching && searchResult && searchResult.conversations.length === 0 && searchResult.messageHits.length === 0 && (
              <div className="py-10 text-center text-sm text-muted-foreground">
                没有找到「{q}」相关的对话
              </div>
            )}
            {!searching && searchResult && searchResult.conversations.length > 0 && (
              <>
                <p className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">
                  标题命中 · {searchResult.conversations.length}
                </p>
                {searchResult.conversations.map((c) => renderRow(c))}
              </>
            )}
            {!searching && searchResult && searchResult.messageHits.length > 0 && (
              <>
                <p className="px-2 pb-1 pt-2.5 text-[11px] font-medium text-muted-foreground">
                  内容命中 · {searchResult.messageHits.length}
                </p>
                {searchResult.messageHits.map((h) => {
                  const conv = convById.get(h.conversationId)
                  return (
                    <button
                      key={h.messageId}
                      type="button"
                      onClick={() => {
                        onSelect(h.conversationId)
                        onOpenChange(false)
                      }}
                      className="rounded-xl border border-border/70 bg-card px-3 py-2 text-left transition-colors hover:bg-accent/60"
                    >
                      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span aria-hidden>{convTypeMeta(conv?.type ?? '').emoji}</span>
                        <span className="min-w-0 flex-1 truncate">
                          {conv?.title ?? '对话'}
                        </span>
                        <span>{h.role === 'user' ? '我' : 'AI'}</span>
                        <span className="tabular-nums">{formatConvTime(h.createdAt)}</span>
                      </span>
                      <span className="mt-1 line-clamp-2 text-xs leading-relaxed">
                        <Highlight text={h.snippet} kw={q} />
                      </span>
                    </button>
                  )
                })}
              </>
            )}
          </div>
        ) : loading && convs.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> 加载中…
          </div>
        ) : convs.length === 0 ? (
          /* ---- 空状态 ---- */
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <span className="flex size-14 items-center justify-center rounded-2xl bg-muted text-2xl" aria-hidden>
              💬
            </span>
            <div>
              <p className="text-sm font-medium">还没有 AI 对话</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                点击「新建对话」开始，或在阅读、解析界面选中文本发起追问。
              </p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="rounded-full">
                  <MessageSquarePlus className="size-4" />
                  新建对话
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" className="w-56">
                {NEW_TYPE_OPTIONS.map((opt) => (
                  <DropdownMenuItem
                    key={opt.type}
                    onClick={() => void handleNew(opt.type)}
                    className="gap-2"
                  >
                    <span aria-hidden>{opt.emoji}</span> {opt.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : (
          /* ---- 普通列表：主对话置顶 → 拖动排序 或 置顶分组 ---- */
          <div className="flex flex-col gap-1">
            {mainConv && renderMainRow(mainConv)}
            {isCustomSort ? (
              <>
                <p className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">
                  自定义顺序 · {sortedRest.length}
                  <span className="ml-1 font-normal">（按 ≡ 拖动调整）</span>
                </p>
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={sortedRest.map((c) => c.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    {sortedRest.map((c) => renderRow(c, true))}
                  </SortableContext>
                </DndContext>
              </>
            ) : (
              <>
                {pinnedRest.length > 0 && (
                  <>
                    <p className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">
                      置顶 · {pinnedRest.length}
                    </p>
                    {pinnedRest.map((c) => renderRow(c))}
                    {othersRest.length > 0 && (
                      <p className="px-2 pb-1 pt-2.5 text-[11px] font-medium text-muted-foreground">
                        全部 · {othersRest.length}
                      </p>
                    )}
                  </>
                )}
                {othersRest.map((c) => renderRow(c))}
              </>
            )}
          </div>
        )}
      </div>

      {/* 重命名 Dialog */}
      <Dialog
        open={!!renameTarget}
        onOpenChange={(o) => {
          if (!o) setRenameTarget(null)
        }}
      >
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>重命名对话</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="输入新名称"
            aria-label="新名称"
            className="h-10 rounded-xl"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleRename()
            }}
          />
          <DialogFooter>
            <Button variant="outline" className="rounded-full" onClick={() => setRenameTarget(null)}>
              取消
            </Button>
            <Button
              className="rounded-full"
              disabled={renaming || !renameValue.trim()}
              onClick={() => void handleRename()}
            >
              {renaming && <Loader2 className="size-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => {
        if (!o) setDeleteTarget(null)
      }}>
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>删除对话</DialogTitle>
          </DialogHeader>
          <p className="text-sm leading-relaxed text-muted-foreground">
            确定删除「{deleteTarget?.title}」吗？对话的全部消息将一并删除，无法恢复。
          </p>
          <DialogFooter>
            <Button variant="outline" className="rounded-full" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button
              className="rounded-full bg-destructive text-white hover:bg-destructive/90"
              disabled={deleting}
              onClick={() => void handleDelete()}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 主对话清空消息确认 */}
      <AlertDialog open={!!clearMainTarget} onOpenChange={(o) => {
        if (!o) setClearMainTarget(null)
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清空 AI问问 的消息</AlertDialogTitle>
            <AlertDialogDescription>
              将清空主对话「{clearMainTarget?.title ?? 'AI问问'}」的全部消息（对话本身保留），此操作无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={clearingMain}
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={() => void handleClearMain()}
            >
              {clearingMain && <Loader2 className="size-4 animate-spin" />}
              清空
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 批量分享结果 */}
      <Dialog open={!!shareLinks} onOpenChange={(o) => {
        if (!o) setShareLinks(null)
      }}>
        <DialogContent className="rounded-2xl">
          <DialogHeader>
            <DialogTitle>分享链接（{shareLinks?.length ?? 0} 个）</DialogTitle>
          </DialogHeader>
          <div className={cn('max-h-56 space-y-2 overflow-y-auto', SCROLLBAR)}>
            {(shareLinks ?? []).map((l) => (
              <div key={l.link} className="rounded-xl border border-border bg-muted/40 px-3 py-2">
                <p className="truncate text-sm font-medium">{l.title}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{l.link}</p>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" className="rounded-full" onClick={() => setShareLinks(null)}>
              关闭
            </Button>
            <Button className="rounded-full" onClick={() => void copyAllLinks()}>
              <Share2 className="size-4" />
              复制全部链接
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 单条分享：先选有效期 */}
      <ConversationShareDialog
        open={!!shareTarget}
        onOpenChange={(o) => {
          if (!o) setShareTarget(null)
        }}
        title={`分享对话「${shareTarget?.title ?? ''}」`}
        mode="single"
        onConfirm={(days) => {
          const target = shareTarget
          setShareTarget(null)
          if (target) void shareConversationLink(target.id, days)
        }}
      />

      {/* 批量分享：先选有效期（再逐个创建 + 结果列表） */}
      <ConversationShareDialog
        open={batchShareOpen}
        onOpenChange={setBatchShareOpen}
        title={`批量分享 ${selected.size} 个对话`}
        mode="batch"
        onConfirm={(days) => {
          setBatchShareOpen(false)
          void handleBatchShare(days)
        }}
      />

      {/* 导出（单条 / 批量）：conversation-export 引擎 + 格式选择 */}
      <ConversationExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        sections={exportSections}
        allowImage={exportAllowImage}
      />
    </div>
  )
}
