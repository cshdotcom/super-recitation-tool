'use client'

// ChatSidebar — AI 对话侧边栏（内容组件，不自带 Sheet；由 page.tsx 用
// Sheet side="left" 或全屏覆盖挂载，open/onOpenChange 控制显隐与数据加载）。
//
// 功能：
//   • 对话列表：置顶分组 + 更新时间倒序；每行含类型徽章 / 标题 / 最后消息
//     摘要 / 时间 / 消息数；活动对话高亮。
//   • 每行更多菜单：置顶、重命名、AI 智能重命名（PATCH autoRename）、分享
//     （先选有效期 → POST /api/shares → 复制链接）、导出（TXT/MD/JSON）、删除（确认）。
//   • 顶部新建对话（类型：自由对话/题目解析/收藏解析/追问）。
//   • 一级全局搜索：GET /api/conversations?q= →「标题命中」对话列表 +
//     「内容命中」消息列表（关键词高亮，点击跳转该对话）。
//   • 批量管理：复选框模式，全选 / 批量删除（确认）/ 批量导出合并 MD /
//     批量分享（先选有效期，逐个创建并列出链接）。
//
// 本文件同时导出对话相关的共享工具（类型 / 导出 / 分享），ChatTool 复用。
import * as React from 'react'
import {
  CheckSquare,
  Download,
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

import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'

// ---------- 共享类型 / 工具（ChatTool 也使用） ----------

export interface ConversationSummary {
  id: string
  title: string
  type: string
  pinned: boolean
  cardId: string
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

export type ExportFormat = 'txt' | 'md' | 'json'

/** 对话 → 文本内容（TXT / MD / JSON；JSON 不含 dataURL 图片本体，仅记录张数）。 */
export function conversationToText(
  conv: ConversationSummary,
  messages: ConversationMessage[],
  format: ExportFormat,
): string {
  const ts = (iso: string) =>
    new Date(iso).toLocaleString('zh-CN', { hour12: false })
  if (format === 'json') {
    return JSON.stringify(
      {
        title: conv.title,
        type: conv.type,
        cardId: conv.cardId,
        createdAt: conv.createdAt,
        exportedAt: new Date().toISOString(),
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.images && m.images.length > 0
            ? { imageCount: m.images.length }
            : {}),
          createdAt: m.createdAt,
        })),
      },
      null,
      2,
    )
  }
  if (format === 'md') {
    const lines: string[] = [
      `# ${conv.title}`,
      '',
      `- 类型：${convTypeMeta(conv.type).label}`,
      `- 创建时间：${ts(conv.createdAt)}`,
      '',
      '---',
      '',
    ]
    for (const m of messages) {
      lines.push(`**${m.role === 'user' ? '🧑 我' : '🤖 AI'}**（${ts(m.createdAt)}）`)
      lines.push('')
      lines.push(m.content)
      lines.push('')
    }
    return lines.join('\n')
  }
  const lines: string[] = [
    conv.title,
    `类型：${convTypeMeta(conv.type).label} · 导出时间：${ts(new Date().toISOString())}`,
    '',
  ]
  for (const m of messages) {
    lines.push(`【${m.role === 'user' ? '我' : 'AI'}】`)
    lines.push(m.content)
    lines.push('')
  }
  return lines.join('\n')
}

/** 文件名安全化（去非法字符，限长）。 */
export function safeFileName(t: string): string {
  const s = (t || '对话').replace(/[\\/:*?"<>|\n\r\t]/g, '_').trim()
  return s.slice(0, 50) || '对话'
}

/** 触发浏览器下载文本文件。 */
export function downloadTextFile(
  filename: string,
  text: string,
  mime = 'text/plain',
): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** 导出单个对话（拉取最新详情后按格式下载）。 */
export async function exportConversation(
  conv: ConversationSummary,
  format: ExportFormat,
): Promise<void> {
  const detail = await fetchConversation(conv.id)
  if (!detail) {
    toast.error('导出失败：对话加载失败')
    return
  }
  const ext = format === 'md' ? 'md' : format
  downloadTextFile(
    `${safeFileName(conv.title)}.${ext}`,
    conversationToText(detail.conversation, detail.messages, format),
    format === 'json' ? 'application/json' : 'text/plain',
  )
  toast.success(`已导出 ${format.toUpperCase()}`)
}

/** 创建对话分享并复制链接（与卡片分享一致的 /share/<token> 格式）。 */
export async function shareConversationLink(
  id: string,
  days = 0,
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

// ---------- 对话分享对话框（单条 / 批量共用：先选有效期再创建） ----------

type ShareExpiry = 'inf' | '1' | '7' | '30' | 'custom'

const SHARE_EXPIRY_OPTIONS: { value: ShareExpiry; label: string }[] = [
  { value: 'inf', label: '永久有效' },
  { value: '1', label: '1 天' },
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: 'custom', label: '自定义' },
]

/**
 * 分享对话前的有效期选择对话框（与卡片/书籍分享一致）。
 * - mode 'single'：分享单个对话（title 如「分享对话「xxx」」）。
 * - mode 'batch'：批量分享（title 如「批量分享 N 个对话」）。
 * 确认后回调 onConfirm(days)：0 = 永久，N = N 天有效；由调用方执行
 * shareConversationLink(id, days)。自定义天数需为 1-3650 的整数。
 */
function ConversationShareDialog({
  open,
  onOpenChange,
  title,
  mode,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  mode: 'single' | 'batch'
  onConfirm: (days: number) => void
}) {
  const [expiry, setExpiry] = React.useState<ShareExpiry>('7')
  const [customDays, setCustomDays] = React.useState('7')

  // 每次打开重置（默认 7 天，与卡片分享默认一致）
  React.useEffect(() => {
    if (open) {
      setExpiry('7')
      setCustomDays('7')
    }
  }, [open])

  const handleConfirm = () => {
    if (expiry === 'inf') {
      onConfirm(0)
      return
    }
    if (expiry === 'custom') {
      const v = customDays.trim()
      const n = Number(v)
      if (!/^\d+$/.test(v) || !Number.isInteger(n) || n < 1 || n > 3650) {
        toast.error('自定义有效期需为 1-3650 的整数（天）')
        return
      }
      onConfirm(n)
      return
    }
    onConfirm(Number(expiry))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {mode === 'batch'
              ? '将为所选对话分别创建只读分享链接，并逐个复制到剪贴板；到期后链接自动失效。'
              : '将创建只读分享链接并复制到剪贴板；到期后链接自动失效。'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm font-medium">有效期</p>
          <RadioGroup
            value={expiry}
            onValueChange={(v) => setExpiry(v as ShareExpiry)}
            className="gap-2.5"
          >
            {SHARE_EXPIRY_OPTIONS.map((opt) => (
              <div
                key={opt.value}
                className={cn(
                  'flex items-center gap-2.5 rounded-xl border px-3 py-2.5 transition-colors',
                  expiry === opt.value
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-border',
                )}
              >
                <RadioGroupItem value={opt.value} id={`conv-share-expiry-${opt.value}`} />
                <Label
                  htmlFor={`conv-share-expiry-${opt.value}`}
                  className="flex-1 cursor-pointer text-sm font-medium"
                >
                  {opt.label}
                </Label>
              </div>
            ))}
          </RadioGroup>

          {expiry === 'custom' && (
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={3650}
                value={customDays}
                onChange={(e) => setCustomDays(e.target.value)}
                placeholder="1-3650"
                aria-label="自定义天数"
                className="h-10 w-28 rounded-xl"
              />
              <span className="text-sm text-muted-foreground">天（1-3650）</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" className="rounded-full" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button className="rounded-full" onClick={handleConfirm}>
            <Share2 className="size-4" />
            确认分享
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  // ---- 批量分享结果 ----
  const [shareLinks, setShareLinks] = React.useState<
    { title: string; link: string }[] | null
  >(null)
  // ---- 分享有效期对话框（单条 shareTarget / 批量 batchShareOpen） ----
  const [shareTarget, setShareTarget] = React.useState<ConversationSummary | null>(null)
  const [batchShareOpen, setBatchShareOpen] = React.useState(false)

  const loadConversations = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/conversations')
      if (!res.ok) return
      const data = (await res.json()) as { conversations?: ConversationSummary[] }
      setConvs(data.conversations ?? [])
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

  const pinned = React.useMemo(() => convs.filter((c) => c.pinned), [convs])
  const others = React.useMemo(() => convs.filter((c) => !c.pinned), [convs])

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
      setConvs((prev) => {
        const next = prev.map((c) => (c.id === id ? updated : c))
        // 置顶优先 + 更新时间倒序（与服务端排序一致，置顶后立即归位）
        next.sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
          return b.updatedAt.localeCompare(a.updatedAt)
        })
        return next
      })
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
      if (!res.ok) throw new Error('删除失败')
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

  const handleBatchDelete = async () => {
    if (selectedConvs.length === 0) return
    setBatchBusy(true)
    let ok = 0
    for (const c of selectedConvs) {
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
    setConvs((prev) => prev.filter((c) => !selected.has(c.id)))
    setSelected(new Set())
    toast.success(`已删除 ${ok} 个对话`)
  }

  const handleBatchExport = async () => {
    if (selectedConvs.length === 0) return
    setBatchBusy(true)
    const tid = toast.loading('正在导出所选对话…')
    try {
      const parts: string[] = [`# AI 对话导出（${selectedConvs.length} 个）`, '']
      for (const c of selectedConvs) {
        const detail = await fetchConversation(c.id)
        if (!detail) continue
        parts.push(conversationToText(detail.conversation, detail.messages, 'md'))
        parts.push('\n---\n')
      }
      downloadTextFile(
        `AI对话导出-${new Date().toISOString().slice(0, 10)}.md`,
        parts.join('\n'),
        'text/markdown',
      )
      toast.success('已导出所选对话', { id: tid })
    } catch {
      toast.error('导出失败', { id: tid })
    } finally {
      setBatchBusy(false)
    }
  }

  const handleBatchShare = async (days: number) => {
    if (selectedConvs.length === 0) return
    setBatchBusy(true)
    const tid = toast.loading('正在创建分享…')
    const links: { title: string; link: string }[] = []
    for (const c of selectedConvs) {
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

  const renderRow = (c: ConversationSummary) => {
    const meta = convTypeMeta(c.type)
    const active = activeConversationId === c.id
    const checked = selected.has(c.id)
    return (
      <div
        key={c.id}
        className={cn(
          'flex items-center gap-1.5 rounded-xl border border-transparent px-2 py-2 transition-colors',
          active ? 'border-emerald-500/30 bg-emerald-500/10' : 'hover:bg-accent/60',
          checked && 'bg-primary/5',
        )}
      >
        {manageMode && (
          <Checkbox
            checked={checked}
            onCheckedChange={() => toggleSelect(c.id)}
            aria-label={`选择 ${c.title}`}
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
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Download className="size-4" />
                  导出
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem onClick={() => void exportConversation(c, 'txt')}>
                    导出 TXT
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void exportConversation(c, 'md')}>
                    导出 Markdown
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void exportConversation(c, 'json')}>
                    导出 JSON
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
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
  }

  // ---------- 渲染 ----------

  if (!open) return null

  const q = searchQ.trim()

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-1.5 px-3 pt-1">
        <p className="min-w-0 flex-1 truncate text-sm font-bold">AI 对话</p>
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
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="关闭对话列表"
          className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
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
            disabled={batchBusy || selected.size === 0}
            onClick={() => void handleBatchExport()}
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
                  将删除所选 {selected.size} 个对话及其全部消息，此操作无法恢复。
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
        {q || searchResult ? (
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
          /* ---- 普通列表（置顶分组 + 更新倒序） ---- */
          <div className="flex flex-col gap-1">
            {pinned.length > 0 && (
              <>
                <p className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">
                  置顶 · {pinned.length}
                </p>
                {pinned.map(renderRow)}
                {others.length > 0 && (
                  <p className="px-2 pb-1 pt-2.5 text-[11px] font-medium text-muted-foreground">
                    全部 · {others.length}
                  </p>
                )}
              </>
            )}
            {others.map(renderRow)}
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
    </div>
  )
}
