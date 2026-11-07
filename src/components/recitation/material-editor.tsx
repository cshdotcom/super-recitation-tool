'use client'

// 文字编辑工具 — 全屏材料编辑器（背书吧）
// 顶栏：返回 / 样式色板 / 撤销重做 / 批量 / 完成
// 内容：块列表（核心论点·正面 + 完整内容·背面），支持插入/上下移动/拆分/合并/隐藏/删除
// 底部工具栏：分割分块 / 样式 / 格式 / 图片 / 公式 / 表格 / 键盘
//
// API：
//   POST /api/chat  { mode:'ask', content, messages } -> { reply }   （AI生成核心论点）
//   POST /api/chunk { content } -> { chunks: string[] }               （AI 语义分割分块）

import * as React from 'react'
import {
  ALargeSmall,
  Bold,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Code,
  Columns3,
  Eye,
  EyeOff,
  Highlighter,
  Image as ImageIcon,
  Italic,
  Keyboard,
  Loader2,
  Pencil,
  Plus,
  Redo2,
  Sigma,
  Sparkles,
  Strikethrough,
  Table as TableIcon,
  TextQuote,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'

import type { CardData, MaterialBlock } from '@/lib/types'
import { cn } from '@/lib/utils'
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
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'

// ---------- props 契约 ----------
export interface MaterialEditorProps {
  card: CardData
  onBack: () => void
  /** 完成：交出最新块列表（父组件负责持久化并关闭本视图） */
  onSave: (blocks: MaterialBlock[]) => void
}

// ---------- 常量 ----------
const MAX_HISTORY = 50 // 撤销/重做栈上限
const COALESCE_MS = 1000 // 连续文本输入合并为一条撤销记录的时间窗

const LINE_OPTIONS = [
  { label: '紧凑', value: 1.4 },
  { label: '标准', value: 1.7 },
  { label: '宽松', value: 2 },
] as const

const TABLE_TEMPLATE = [
  '| 表头 1 | 表头 2 | 表头 3 |',
  '| --- | --- | --- |',
  '| 单元格 | 单元格 | 单元格 |',
  '| 单元格 | 单元格 | 单元格 |',
].join('\n')

type FormatKind = 'bold' | 'italic' | 'strike' | 'code' | 'highlight' | 'quote'

const FORMAT_MAP: Record<FormatKind, { before: string; after: string; ph: string }> = {
  bold: { before: '**', after: '**', ph: '文字' },
  italic: { before: '*', after: '*', ph: '文字' },
  strike: { before: '~~', after: '~~', ph: '文字' },
  code: { before: '`', after: '`', ph: '文字' },
  highlight: { before: '==', after: '==', ph: '文字' },
  quote: { before: '> ', after: '', ph: '文字' },
}

const FORMAT_ITEMS: { kind: FormatKind; label: string; icon: LucideIcon }[] = [
  { kind: 'bold', label: '加粗', icon: Bold },
  { kind: 'italic', label: '斜体', icon: Italic },
  { kind: 'strike', label: '删除线', icon: Strikethrough },
  { kind: 'code', label: '行内代码', icon: Code },
  { kind: 'highlight', label: '高亮', icon: Highlighter },
  { kind: 'quote', label: '引用', icon: TextQuote },
]

// ---------- 共用样式 ----------
const ICON_BTN =
  'flex size-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40'

const TEXT_BTN =
  'h-9 shrink-0 whitespace-nowrap rounded-lg border border-border px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40'

const HEADER_ICON_BTN =
  'flex size-9 shrink-0 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30'

const TOOLBAR_BTN =
  'flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg py-2.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'

const CHECK_BTN =
  'flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors hover:border-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

// ---------- 工具函数 ----------

/** 在句子边界（。！？!?.与换行）附近把文本大致对半拆开 */
function splitBackText(text: string): [string, string] {
  const t = text.trim()
  if (!t) return ['', '']
  const bounds: number[] = []
  const re = /[。！？!?.\n]/g
  let m = re.exec(t)
  while (m !== null) {
    bounds.push(m.index + m[0].length)
    m = re.exec(t)
  }
  const mid = t.length / 2
  let cut = -1
  for (const p of bounds) {
    if (p <= 0 || p >= t.length) continue
    if (cut === -1 || Math.abs(p - mid) < Math.abs(cut - mid)) cut = p
  }
  if (cut === -1) cut = Math.round(mid)
  if (cut <= 0) cut = 1
  const a = t.slice(0, cut).trim()
  const b = t.slice(cut).trim()
  if (!b) return [t, '']
  return [a, b]
}

/** 压缩图片：最长边 ≤720px，JPEG 质量 0.8，返回 dataURL */
function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('图片解码失败'))
      img.onload = () => {
        const scale = Math.min(1, 720 / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('画布不可用'))
          return
        }
        ctx.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.8))
      }
      img.src = String(reader.result)
    }
    reader.readAsDataURL(file)
  })
}

// ---------- 自适应高度输入框 ----------
type AutoTextareaProps = Omit<React.ComponentProps<'textarea'>, 'ref' | 'value'> & {
  value: string
  register: (el: HTMLTextAreaElement | null) => void
  /** 变化时触发重新量高（如全局字号/行距变化） */
  resizeKey?: string
}

function AutoTextarea({ value, register, resizeKey, ...rest }: AutoTextareaProps) {
  const elRef = React.useRef<HTMLTextAreaElement | null>(null)
  React.useEffect(() => {
    const el = elRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value, resizeKey])
  return (
    <Textarea
      {...rest}
      value={value}
      ref={(el: HTMLTextAreaElement | null) => {
        elRef.current = el
        register(el)
      }}
    />
  )
}

// ---------- 主组件 ----------
type FocusField = 'front' | 'back'
interface FocusTarget {
  index: number
  field: FocusField
}

export function MaterialEditor(props: MaterialEditorProps): React.JSX.Element {
  const { card, onBack, onSave } = props

  // ---- 块数据 + 撤销/重做 ----
  const [blocks, setBlocks] = React.useState<MaterialBlock[]>(() => {
    const saved = card.blocks
    if (Array.isArray(saved) && saved.length > 0) {
      return saved.map((b) => ({
        front: b.front ?? '',
        back: b.back ?? '',
        hidden: b.hidden === true,
      }))
    }
    // 空块列表 → 用课文内容初始化一个块
    return [{ front: '', back: card.content ?? '' }]
  })
  const [history, setHistory] = React.useState<MaterialBlock[][]>([])
  const [future, setFuture] = React.useState<MaterialBlock[][]>([])
  const lastEditRef = React.useRef<{ key: string; time: number } | null>(null)

  // ---- UI 状态 ----
  const [title, setTitle] = React.useState('新材料')
  const [renameOpen, setRenameOpen] = React.useState(false)
  const [renameValue, setRenameValue] = React.useState('')
  const [batch, setBatch] = React.useState(false)
  const [selected, setSelected] = React.useState<ReadonlySet<number>>(new Set())
  const [aiIdx, setAiIdx] = React.useState<number | null>(null)
  const [chunkLoading, setChunkLoading] = React.useState(false)
  const [chunkResult, setChunkResult] = React.useState<string[] | null>(null)
  const [kbUp, setKbUp] = React.useState(false)
  const [fontSize, setFontSize] = React.useState(16)
  const [lineSpacing, setLineSpacing] = React.useState<number>(1.7)

  // ---- refs ----
  const taRefs = React.useRef(new Map<string, HTMLTextAreaElement>())
  const lastFocusRef = React.useRef<FocusTarget | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  // ---- 变更 + 历史（快照上限 50；文本输入在时间窗内合并为一条） ----
  const mutate = (next: MaterialBlock[], editKey?: string) => {
    const now = Date.now()
    const last = lastEditRef.current
    const coalesce =
      !!editKey && !!last && last.key === editKey && now - last.time < COALESCE_MS
    if (coalesce) {
      lastEditRef.current = { key: editKey, time: now }
    } else {
      setHistory((h) => [...h, blocks].slice(-MAX_HISTORY))
      setFuture([])
      lastEditRef.current = editKey ? { key: editKey, time: now } : null
    }
    setBlocks(next)
  }

  const undo = () => {
    if (history.length === 0) return
    const prev = history[history.length - 1]
    setHistory(history.slice(0, -1))
    setFuture([blocks, ...future].slice(0, MAX_HISTORY))
    setBlocks(prev)
    setSelected(new Set())
    lastFocusRef.current = null
    lastEditRef.current = null
  }

  const redo = () => {
    if (future.length === 0) return
    const next = future[0]
    setFuture(future.slice(1))
    setHistory([...history, blocks].slice(-MAX_HISTORY))
    setBlocks(next)
    setSelected(new Set())
    lastFocusRef.current = null
    lastEditRef.current = null
  }

  // ---- 文本编辑 ----
  const updateField = (index: number, field: FocusField, value: string) => {
    mutate(
      blocks.map((b, i) => {
        if (i !== index) return b
        return field === 'front' ? { ...b, front: value } : { ...b, back: value }
      }),
      `${index}:${field}`,
    )
  }

  const registerTA = (index: number, field: FocusField, el: HTMLTextAreaElement | null) => {
    const key = `${index}-${field}`
    if (el) taRefs.current.set(key, el)
    else taRefs.current.delete(key)
  }

  const handleTAFocus = (index: number, field: FocusField) => {
    lastFocusRef.current = { index, field }
    setKbUp(true)
  }

  // ---- 块操作 ----
  const addBlockAfter = (index: number) => {
    const next = [...blocks]
    next.splice(index + 1, 0, { front: '', back: '' })
    mutate(next)
    lastFocusRef.current = null
  }

  const moveBlock = (index: number, dir: -1 | 1) => {
    const j = index + dir
    if (j < 0 || j >= blocks.length) return
    const next = [...blocks]
    const [b] = next.splice(index, 1)
    next.splice(j, 0, b)
    mutate(next)
    lastFocusRef.current = null
  }

  const splitBlock = (index: number) => {
    const block = blocks[index]
    if (!block) return
    const [a, b] = splitBackText(block.back)
    if (!b) {
      toast.warning('内容太短，无法拆分')
      return
    }
    const next = [...blocks]
    next[index] = { ...block, back: a }
    next.splice(index + 1, 0, { front: '', back: b })
    mutate(next)
    lastFocusRef.current = null
    toast.success('已拆分为两块')
  }

  const mergeWithNext = (index: number) => {
    if (index >= blocks.length - 1) return
    const a = blocks[index]
    const b = blocks[index + 1]
    if (!a || !b) return
    const merged: MaterialBlock = {
      front: [a.front, b.front].filter(Boolean).join('；'),
      back: [a.back, b.back].filter(Boolean).join('\n'),
      hidden: a.hidden,
    }
    const next = blocks.filter((_, i) => i !== index + 1)
    next[index] = merged
    mutate(next)
    lastFocusRef.current = null
    toast.success('已与下一块合并')
  }

  const toggleHidden = (index: number) => {
    mutate(blocks.map((b, i) => (i === index ? { ...b, hidden: !b.hidden } : b)))
    lastFocusRef.current = null
  }

  const removeBlock = (index: number) => {
    mutate(blocks.filter((_, i) => i !== index))
    lastFocusRef.current = null
  }

  // ---- 批量模式 ----
  const enterBatch = () => {
    setBatch(true)
    setSelected(new Set())
  }

  const exitBatch = () => {
    setBatch(false)
    setSelected(new Set())
  }

  const toggleSelect = (i: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (blocks.length > 0 && selected.size === blocks.length) setSelected(new Set())
    else setSelected(new Set(blocks.map((_, i) => i)))
  }

  const mergeSelected = () => {
    const idxs = [...selected]
      .filter((i) => i >= 0 && i < blocks.length)
      .sort((a, b) => a - b)
    if (idxs.length < 2) return
    const first = idxs[0]
    const merged: MaterialBlock = {
      front: idxs.map((i) => blocks[i]?.front ?? '').filter(Boolean).join('；'),
      back: idxs.map((i) => blocks[i]?.back ?? '').filter(Boolean).join('\n'),
      hidden: blocks[first]?.hidden,
    }
    const next: MaterialBlock[] = []
    blocks.forEach((b, i) => {
      if (i === first) next.push(merged)
      else if (!selected.has(i)) next.push(b)
    })
    mutate(next)
    setSelected(new Set())
    lastFocusRef.current = null
    toast.success(`已合并 ${idxs.length} 块`)
  }

  const hideSelected = () => {
    if (selected.size === 0) return
    const n = selected.size
    mutate(blocks.map((b, i) => (selected.has(i) ? { ...b, hidden: true } : b)))
    setSelected(new Set())
    lastFocusRef.current = null
    toast.success(`已隐藏 ${n} 块`)
  }

  const deleteSelected = () => {
    if (selected.size === 0) return
    const n = selected.size
    mutate(blocks.filter((_, i) => !selected.has(i)))
    setSelected(new Set())
    lastFocusRef.current = null
    toast.success(`已删除 ${n} 块`)
  }

  // ---- AI生成核心论点（POST /api/chat）----
  const generateFront = async (index: number) => {
    const back = (blocks[index]?.back ?? '').trim()
    if (!back) {
      toast.warning('请先填写「完整内容（背面）」')
      return
    }
    setAiIdx(index)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'ask',
          content: back.slice(0, 2000),
          messages: [
            {
              role: 'user',
              content: '请为下面这段内容提炼一句20字以内的核心论点，只返回论点本身：',
            },
          ],
        }),
      })
      if (!res.ok) {
        const errRes = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(errRes.error || '生成失败')
      }
      const data = (await res.json()) as { reply?: string }
      const reply = (data.reply ?? '')
        .replace(/\s+/g, ' ')
        .replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, '')
        .trim()
      if (!reply) {
        toast.warning('AI 未返回结果，请手动填写')
        return
      }
      mutate(blocks.map((b, bi) => (bi === index ? { ...b, front: reply } : b)))
      toast.success('已生成核心论点')
    } catch (err) {
      toast.error('AI生成失败：' + (err instanceof Error ? err.message : '未知错误'))
    } finally {
      setAiIdx(null)
    }
  }

  // ---- 分割分块（POST /api/chunk → 确认 → 替换全部块）----
  const runChunk = async () => {
    const content = blocks.map((b) => b.back).filter(Boolean).join('\n').trim()
    if (!content) {
      toast.warning('内容为空，无法分割')
      return
    }
    setChunkLoading(true)
    const tid = toast.loading('AI 正在按语义分割…')
    try {
      const res = await fetch('/api/chunk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      if (!res.ok) {
        const errRes = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(errRes.error || '分割失败')
      }
      const data = (await res.json()) as { chunks?: unknown }
      const chunks = Array.isArray(data.chunks)
        ? data.chunks
            .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
            .map((c) => c.trim())
        : []
      if (chunks.length === 0) {
        toast.warning('未获得分块结果，请稍后重试', { id: tid })
        return
      }
      toast.dismiss(tid)
      setChunkResult(chunks)
    } catch (err) {
      toast.error('分块失败：' + (err instanceof Error ? err.message : '未知错误'), { id: tid })
    } finally {
      setChunkLoading(false)
    }
  }

  const applyChunks = () => {
    if (!chunkResult) return
    const n = chunkResult.length
    mutate(chunkResult.map((c) => ({ front: '', back: c })))
    lastFocusRef.current = null
    setChunkResult(null)
    toast.success(`已分割为 ${n} 块`)
  }

  // ---- 光标插入（格式 / 公式 / 表格 / 图片）----
  const insertMarkdown = (before: string, after: string, ph: string, multiline = false) => {
    const target = lastFocusRef.current
    const el = target ? taRefs.current.get(`${target.index}-${target.field}`) : undefined
    if (!target || !el || target.index >= blocks.length) {
      toast.info('请先点击要编辑的文本框')
      return
    }
    const value = el.value
    const start = el.selectionStart ?? value.length
    const end = el.selectionEnd ?? start
    const sel = value.slice(start, end)
    const needsBreak = multiline && start > 0 && value[start - 1] !== '\n'
    const body = sel || ph
    const inserted = (needsBreak ? '\n' : '') + before + body + after
    const nextValue = value.slice(0, start) + inserted + value.slice(end)
    const idx = target.index
    const field = target.field
    mutate(
      blocks.map((b, bi) => {
        if (bi !== idx) return b
        return field === 'front' ? { ...b, front: nextValue } : { ...b, back: nextValue }
      }),
    )
    const bodyStart = start + (needsBreak ? 1 : 0) + before.length
    const bodyEnd = bodyStart + body.length
    requestAnimationFrame(() => {
      el.focus()
      if (sel) {
        const caret = bodyEnd + after.length
        el.setSelectionRange(caret, caret)
      } else {
        // 无选区：选中新插入的占位文字，输入即替换
        el.setSelectionRange(bodyStart, bodyEnd)
      }
    })
  }

  const applyFormat = (kind: FormatKind) => {
    const op = FORMAT_MAP[kind]
    insertMarkdown(op.before, op.after, op.ph)
  }

  // ---- 插入图片 ----
  const handleImageFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许重复选择同一文件
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.error('请选择图片文件')
      return
    }
    try {
      const dataUrl = await compressImage(file)
      insertMarkdown(`![图片](${dataUrl})`, '', '')
      toast.success('图片已插入')
    } catch (err) {
      toast.error('图片处理失败：' + (err instanceof Error ? err.message : '未知错误'))
    }
  }

  // ---- 键盘弹出/收起 ----
  const toggleKeyboard = () => {
    const active = document.activeElement
    if (kbUp || active instanceof HTMLTextAreaElement) {
      if (active instanceof HTMLTextAreaElement) active.blur()
      setKbUp(false)
      return
    }
    const target = lastFocusRef.current
    const el = target ? taRefs.current.get(`${target.index}-${target.field}`) : undefined
    if (!el) {
      toast.info('请先点击要编辑的文本框')
      return
    }
    el.focus()
    const pos = el.value.length
    el.setSelectionRange(pos, pos)
    setKbUp(true)
  }

  // ---- 重命名 ----
  const openRename = () => {
    setRenameValue(title)
    setRenameOpen(true)
  }

  const confirmRename = () => {
    const t = renameValue.trim()
    if (!t) {
      toast.error('标题不能为空')
      return
    }
    setTitle(t)
    setRenameOpen(false)
    toast.success('标题已更新')
  }

  // ---- 完成 ----
  const handleDone = () => {
    onSave(blocks)
    toast.success('已保存')
  }

  // ================= 渲染 =================
  return (
    <>
      {/* 顶栏 */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-2xl items-center gap-2 px-4">
          {batch ? (
            <>
              <button
                type="button"
                onClick={exitBatch}
                aria-label="取消批量操作"
                className="shrink-0 whitespace-nowrap rounded-full px-2 py-1.5 text-[15px] font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                取消
              </button>
              <div className="ml-auto flex items-center gap-0.5">
                <span className="mr-1 whitespace-nowrap text-sm font-semibold tabular-nums">
                  已选 {selected.size} 块
                </span>
                {(
                  [
                    { label: '全选', onClick: toggleSelectAll, disabled: blocks.length === 0 },
                    { label: '合并', onClick: () => mergeSelected(), disabled: selected.size < 2 },
                    { label: '隐藏', onClick: () => hideSelected(), disabled: selected.size === 0 },
                    { label: '删除', onClick: () => deleteSelected(), disabled: selected.size === 0 },
                  ] as const
                ).map((b) => (
                  <button
                    key={b.label}
                    type="button"
                    onClick={b.onClick}
                    disabled={b.disabled}
                    className="shrink-0 whitespace-nowrap rounded-full px-2 py-1.5 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onBack}
                aria-label="返回"
                className="flex size-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronLeft className="size-6" strokeWidth={1.75} aria-hidden />
              </button>
              {/* 样式色板（装饰） */}
              <div className="ml-1 flex items-center gap-1.5" aria-hidden>
                <span className="block size-5 rounded-[7px] bg-orange-400 ring-2 ring-orange-200" />
                <span className="flex items-center gap-[3px] rounded-md border border-border bg-background px-1.5 py-1 shadow-sm">
                  <span className="block size-3 rounded-[3px] bg-zinc-900" />
                  <span className="block size-3 rounded-[3px] bg-zinc-500" />
                </span>
              </div>
              <div className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  aria-label="撤销"
                  disabled={history.length === 0}
                  onClick={undo}
                  className={HEADER_ICON_BTN}
                >
                  <Undo2 className="size-5" strokeWidth={1.75} aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label="重做"
                  disabled={future.length === 0}
                  onClick={redo}
                  className={HEADER_ICON_BTN}
                >
                  <Redo2 className="size-5" strokeWidth={1.75} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={enterBatch}
                  className="shrink-0 whitespace-nowrap rounded-full px-2.5 py-1.5 text-[15px] font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  批量
                </button>
                <button
                  type="button"
                  onClick={handleDone}
                  className="shrink-0 whitespace-nowrap rounded-full px-2.5 py-1.5 text-[15px] font-bold transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  完成
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      {/* 主体 */}
      <main className="min-w-0 flex-1 bg-muted/40 pb-28">
        <div className="mx-auto w-full max-w-2xl px-4 pt-5">
          {/* 标题 */}
          <div className="flex items-center gap-1.5">
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            <button
              type="button"
              aria-label="重命名材料"
              onClick={openRename}
              className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Pencil className="size-4" strokeWidth={1.75} aria-hidden />
            </button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground/80">
            点击文本可直接编辑，点击按钮调整顺序
          </p>

          {/* 块列表 */}
          <div className="mt-4 space-y-4">
            {blocks.length === 0 ? (
              <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border bg-card py-16">
                <p className="text-sm text-muted-foreground">暂无内容块</p>
                <Button variant="outline" size="sm" onClick={() => mutate([{ front: '', back: '' }])}>
                  <Plus className="size-4" strokeWidth={1.75} aria-hidden />
                  添加内容块
                </Button>
              </div>
            ) : (
              blocks.map((block, i) => {
                const isSel = selected.has(i)
                const isHidden = block.hidden === true

                // 已隐藏的块 → 折叠为细条
                if (block.hidden) {
                  return (
                    <div
                      key={i}
                      className={cn(
                        'flex items-center gap-2.5 rounded-2xl border border-dashed border-border bg-card/70 px-4 py-3 shadow-sm',
                        batch && isSel && 'ring-2 ring-primary/50',
                      )}
                    >
                      {batch ? (
                        <button
                          type="button"
                          aria-label={isSel ? `取消选择第${i + 1}块` : `选择第${i + 1}块`}
                          aria-pressed={isSel}
                          onClick={() => toggleSelect(i)}
                          className={cn(
                            CHECK_BTN,
                            isSel
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-muted-foreground/35 text-transparent',
                          )}
                        >
                          <Check className="size-3" strokeWidth={3} aria-hidden />
                        </button>
                      ) : null}
                      <EyeOff
                        className="size-4 shrink-0 text-muted-foreground/70"
                        strokeWidth={1.75}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                        已隐藏 · 第{i + 1}块
                      </span>
                      <button
                        type="button"
                        aria-label={`显示第${i + 1}块`}
                        onClick={() => toggleHidden(i)}
                        className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Eye className="size-4" strokeWidth={1.75} aria-hidden />
                      </button>
                    </div>
                  )
                }

                const fields = (
                  <>
                    {/* 核心论点（正面） */}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm text-muted-foreground">核心论点（正面）：</span>
                      <button
                        type="button"
                        onClick={() => void generateFront(i)}
                        disabled={aiIdx !== null}
                        aria-label="AI 生成核心论点"
                        className="flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium text-indigo-500 transition-colors hover:bg-indigo-50 hover:text-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                      >
                        {aiIdx === i ? (
                          <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} aria-hidden />
                        ) : (
                          <Sparkles className="size-3.5" strokeWidth={1.75} aria-hidden />
                        )}
                        AI生成
                      </button>
                    </div>
                    <AutoTextarea
                      value={block.front}
                      register={(el) => registerTA(i, 'front', el)}
                      onChange={(e) => updateField(i, 'front', e.target.value)}
                      onFocus={() => handleTAFocus(i, 'front')}
                      onBlur={() => setKbUp(false)}
                      placeholder="点击编辑核心论点"
                      aria-label={`第${i + 1}块核心论点（正面）`}
                      className="min-h-11 resize-none rounded-xl border-0 bg-muted px-3 py-2.5 shadow-none focus-visible:ring-1"
                    />

                    {/* 完整内容（背面） */}
                    <span className="block text-sm text-muted-foreground">完整内容（背面）：</span>
                    <AutoTextarea
                      value={block.back}
                      register={(el) => registerTA(i, 'back', el)}
                      onChange={(e) => updateField(i, 'back', e.target.value)}
                      onFocus={() => handleTAFocus(i, 'back')}
                      onBlur={() => setKbUp(false)}
                      placeholder="新段落内容..."
                      aria-label={`第${i + 1}块完整内容（背面）`}
                      resizeKey={`${fontSize}-${lineSpacing}`}
                      style={{ fontSize, lineHeight: lineSpacing }}
                      className="min-h-28 resize-none rounded-xl border-0 bg-muted px-3 py-3 shadow-none focus-visible:ring-1"
                    />
                  </>
                )

                return (
                  <article
                    key={i}
                    className={cn(
                      'space-y-3 rounded-2xl bg-card p-4 shadow-sm',
                      batch && isSel && 'ring-2 ring-primary/50',
                    )}
                  >
                    {batch ? (
                      <div className="flex items-start gap-2.5">
                        <button
                          type="button"
                          aria-label={isSel ? `取消选择第${i + 1}块` : `选择第${i + 1}块`}
                          aria-pressed={isSel}
                          onClick={() => toggleSelect(i)}
                          className={cn(
                            CHECK_BTN,
                            'mt-1',
                            isSel
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-muted-foreground/35 text-transparent',
                          )}
                        >
                          <Check className="size-3" strokeWidth={3} aria-hidden />
                        </button>
                        <div className="min-w-0 flex-1 space-y-3">{fields}</div>
                      </div>
                    ) : (
                      <div className="space-y-3">{fields}</div>
                    )}

                    {/* 操作行 */}
                    {!batch && (
                      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
                        <button
                          type="button"
                          aria-label={`在第${i + 1}块后插入新块`}
                          onClick={() => addBlockAfter(i)}
                          className={ICON_BTN}
                        >
                          <Plus className="size-4" strokeWidth={1.75} aria-hidden />
                        </button>
                        <div className="flex h-9 shrink-0 overflow-hidden rounded-lg border border-border">
                          <button
                            type="button"
                            aria-label={`上移第${i + 1}块`}
                            disabled={i === 0}
                            onClick={() => moveBlock(i, -1)}
                            className="flex w-9 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-40"
                          >
                            <ChevronUp className="size-4" strokeWidth={1.75} aria-hidden />
                          </button>
                          <span aria-hidden className="w-px bg-border" />
                          <button
                            type="button"
                            aria-label={`下移第${i + 1}块`}
                            disabled={i === blocks.length - 1}
                            onClick={() => moveBlock(i, 1)}
                            className="flex w-9 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-40"
                          >
                            <ChevronDown className="size-4" strokeWidth={1.75} aria-hidden />
                          </button>
                        </div>
                        <button
                          type="button"
                          aria-label={`拆分第${i + 1}块`}
                          onClick={() => splitBlock(i)}
                          className={TEXT_BTN}
                        >
                          拆分
                        </button>
                        <button
                          type="button"
                          aria-label={`合并第${i + 1}块与下一块`}
                          disabled={i === blocks.length - 1}
                          onClick={() => mergeWithNext(i)}
                          className={TEXT_BTN}
                        >
                          合并
                        </button>
                        <button
                          type="button"
                          aria-label={`隐藏第${i + 1}块`}
                          aria-pressed={isHidden}
                          onClick={() => toggleHidden(i)}
                          className={cn(
                            ICON_BTN,
                            isHidden && 'border-indigo-200 bg-indigo-50 text-indigo-500',
                          )}
                        >
                          <EyeOff className="size-4" strokeWidth={1.75} aria-hidden />
                        </button>
                        <button
                          type="button"
                          aria-label={`删除第${i + 1}块`}
                          onClick={() => removeBlock(i)}
                          className={cn(
                            ICON_BTN,
                            'hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive',
                          )}
                        >
                          <Trash2 className="size-4" strokeWidth={1.75} aria-hidden />
                        </button>
                      </div>
                    )}
                  </article>
                )
              })
            )}
          </div>
        </div>
      </main>

      {/* 底部工具栏 */}
      <nav
        aria-label="编辑工具栏"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background pb-[env(safe-area-inset-bottom)]"
      >
        <div className="mx-auto flex w-full max-w-2xl items-stretch px-1">
          {/* 分割分块 */}
          <button
            type="button"
            aria-label="AI 分割分块"
            disabled={chunkLoading}
            onClick={() => void runChunk()}
            onMouseDown={(e) => e.preventDefault()}
            className={TOOLBAR_BTN}
          >
            <Columns3 className="size-5" strokeWidth={1.75} aria-hidden />
            <span className="text-[11px] leading-none">分割分块</span>
          </button>

          {/* 样式 */}
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="样式"
                onMouseDown={(e) => e.preventDefault()}
                className={TOOLBAR_BTN}
              >
                <Type className="size-5" strokeWidth={1.75} aria-hidden />
                <span className="text-[11px] leading-none">样式</span>
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-64 rounded-2xl p-4">
              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">全局正文字号</span>
                    <span className="text-xs tabular-nums text-muted-foreground">{fontSize}px</span>
                  </div>
                  <Slider
                    className="mt-3"
                    min={12}
                    max={24}
                    step={1}
                    value={[fontSize]}
                    onValueChange={(v) => setFontSize(v[0] ?? 16)}
                    aria-label="全局正文字号"
                  />
                </div>
                <div>
                  <span className="text-sm font-medium">行距</span>
                  <div className="mt-2 grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
                    {LINE_OPTIONS.map((o) => (
                      <button
                        key={o.label}
                        type="button"
                        onClick={() => setLineSpacing(o.value)}
                        aria-pressed={lineSpacing === o.value}
                        className={cn(
                          'h-8 rounded-md text-xs font-medium transition-colors',
                          lineSpacing === o.value
                            ? 'bg-background shadow-sm'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </PopoverContent>
          </Popover>

          {/* 格式 */}
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="格式"
                onMouseDown={(e) => e.preventDefault()}
                className={TOOLBAR_BTN}
              >
                <ALargeSmall className="size-5" strokeWidth={1.75} aria-hidden />
                <span className="text-[11px] leading-none">格式</span>
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-64 rounded-2xl">
              <div className="grid grid-cols-3 gap-1.5">
                {FORMAT_ITEMS.map((f) => (
                  <button
                    key={f.kind}
                    type="button"
                    onClick={() => applyFormat(f.kind)}
                    className="flex h-16 flex-col items-center justify-center gap-1 rounded-lg border border-border text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <f.icon className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden />
                    {f.label}
                  </button>
                ))}
              </div>
              <p className="mt-3 text-center text-[11px] text-muted-foreground">
                插入到最近点击的文本框
              </p>
            </PopoverContent>
          </Popover>

          {/* 图片 */}
          <button
            type="button"
            aria-label="插入图片"
            onClick={() => fileInputRef.current?.click()}
            onMouseDown={(e) => e.preventDefault()}
            className={TOOLBAR_BTN}
          >
            <ImageIcon className="size-5" strokeWidth={1.75} aria-hidden />
            <span className="text-[11px] leading-none">图片</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            aria-hidden
            tabIndex={-1}
            onChange={(e) => void handleImageFile(e)}
          />

          {/* 公式 */}
          <button
            type="button"
            aria-label="插入公式"
            onClick={() => insertMarkdown('$', '$', 'LaTeX公式')}
            onMouseDown={(e) => e.preventDefault()}
            className={TOOLBAR_BTN}
          >
            <Sigma className="size-5" strokeWidth={1.75} aria-hidden />
            <span className="text-[11px] leading-none">公式</span>
          </button>

          {/* 表格 */}
          <button
            type="button"
            aria-label="插入表格"
            onClick={() => insertMarkdown(TABLE_TEMPLATE, '', '', true)}
            onMouseDown={(e) => e.preventDefault()}
            className={TOOLBAR_BTN}
          >
            <TableIcon className="size-5" strokeWidth={1.75} aria-hidden />
            <span className="text-[11px] leading-none">表格</span>
          </button>

          {/* 键盘 */}
          <button
            type="button"
            aria-label={kbUp ? '收起键盘' : '弹出键盘'}
            aria-pressed={kbUp}
            onClick={toggleKeyboard}
            onMouseDown={(e) => e.preventDefault()}
            className={cn(TOOLBAR_BTN, kbUp && 'bg-muted text-foreground')}
          >
            <Keyboard className="size-5" strokeWidth={1.75} aria-hidden />
            <span className="text-[11px] leading-none">键盘</span>
          </button>
        </div>
      </nav>

      {/* 重命名弹窗 */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="rounded-2xl sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>重命名材料</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="输入材料标题"
            aria-label="材料标题"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                confirmRename()
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setRenameOpen(false)}>
              取消
            </Button>
            <Button size="sm" onClick={confirmRename}>
              确定
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 分割分块确认 */}
      <AlertDialog
        open={chunkResult !== null}
        onOpenChange={(open) => {
          if (!open) setChunkResult(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>分割分块</AlertDialogTitle>
            <AlertDialogDescription>
              将把完整内容按语义分割成 {chunkResult?.length ?? 0} 块，替换现有内容？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={applyChunks}>确定</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
