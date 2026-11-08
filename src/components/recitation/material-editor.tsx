'use client'

// 文字编辑工具 — 全屏材料编辑器（背书吧）
//
// 顶栏（两行，吸顶）：
//   第 1 行：返回 / ⚡AI快速分块（emerald 胶囊）/ 撤销 / 重做 / 完成（黑字胶囊）
//   第 2 行：横向可滚动工具条（icon+小字标签）：
//     样式(Aa) / 格式 / 挖空 / 批量操作 / 图片 / 公式 / 表格 / 新建分块 / 分割分块 / 操作 / 键盘
//     「操作」= 更多操作菜单：新建分块 / 合并到下一块 / 隐藏 / 删除 / 全部展开（编辑）/ 全部收起（预览）
//
// 内容：块列表（核心论点·正面 + 完整内容·背面）。
//   • 每块左上 ✥ 移动手柄（点开上移/下移菜单），右上「拆分」按钮 + 预览切换（Markdown 渲染）。
//   • 隐藏块折叠为细条，保存时原样保留（不丢弃）。
//
// 保存链路（修复「编辑后不生效」）：
//   • 所有编辑都经过 commit() 同步写入 blocksRef（始终最新），「完成」从 blocksRef 读取，
//     杜绝任何 stale closure 丢编辑；隐藏块、顺序原样交出。
//   • AI生成核心论点改为函数式更新，请求返回时不再用旧快照覆盖用户在等待期间的输入。
//
// API：
//   POST /api/chat  { mode:'ask', content, messages } -> { reply }   （AI生成核心论点）
//   POST /api/chunk { content } -> { chunks: string[] }               （AI 语义分割分块）

import * as React from 'react'
import {
  ALargeSmall,
  Bold,
  Braces,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Code,
  Columns3,
  Eye,
  EyeOff,
  FoldVertical,
  GripVertical,
  Highlighter,
  ImagePlus,
  Italic,
  Keyboard,
  Link as LinkIcon,
  ListChecks,
  Loader2,
  Merge,
  MoreHorizontal,
  PenLine,
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
  UnfoldVertical,
  Zap,
  Camera,
  Crop,
  Paintbrush,
  ScanLine,
  SquareSigma,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { FreeCropBox, type CropBox, type CropOffset } from '@/components/recitation/free-crop-box'

import type { CardData, MaterialBlock } from '@/lib/types'
import { extractClozeMarks, wrapClozeMark } from '@/lib/editor-cloze'
import { cn } from '@/lib/utils'
import { VoiceInput } from '@/components/recitation/voice-input'
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'
import { RichContent } from '@/components/recitation/rich-content'

// ---------- props 契约 ----------
export interface MaterialEditorProps {
  card: CardData
  onBack: () => void
  /** 完成：交出最新块列表（父组件负责持久化并关闭本视图）。包含隐藏块，顺序不变。 */
  onSave: (blocks: MaterialBlock[]) => void
  /** 可选：卡片标题变更回调（父组件负责持久化；不传则标题仅编辑器内生效） */
  onTitleChange?: (title: string) => void
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

// 字色调色板（%%color|文字%% 语法，阅读视图与预览均渲染）
const TEXT_COLORS: { value: string; label: string }[] = [
  { value: 'default', label: '默认' },
  { value: '#dc2626', label: '红色' },
  { value: '#ea580c', label: '橙色' },
  { value: '#16a34a', label: '绿色' },
  { value: '#0d9488', label: '青色' },
  { value: '#7c3aed', label: '紫色' },
  { value: '#db2777', label: '粉色' },
  { value: '#64748b', label: '灰色' },
]

const FORMAT_ITEMS: { kind: FormatKind; label: string; icon: LucideIcon }[] = [
  { kind: 'bold', label: '加粗', icon: Bold },
  { kind: 'italic', label: '斜体', icon: Italic },
  { kind: 'strike', label: '删除线', icon: Strikethrough },
  { kind: 'code', label: '行内代码', icon: Code },
  { kind: 'highlight', label: '高亮', icon: Highlighter },
  { kind: 'quote', label: '引用', icon: TextQuote },
]

// ---------- 共用样式 ----------
const HEADER_ICON_BTN =
  'flex size-9 shrink-0 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40'

/** 顶部工具条图标按钮（icon + 小字标签，横向滚动行内等宽） */
const TOOLBAR_BTN =
  'flex w-14 shrink-0 flex-col items-center justify-center gap-1 rounded-lg py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40'

const TEXT_BTN =
  'h-8 shrink-0 whitespace-nowrap rounded-lg border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40'

const SMALL_ICON_BTN =
  'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40'

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

/** 压缩图片：宽 ≤800px，JPEG 质量 0.8，返回 dataURL（避免 base64 过大拖慢保存） */
function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('图片解码失败'))
      img.onload = () => {
        const scale = Math.min(1, 800 / Math.max(1, img.width))
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

/** 裁剪：按自然像素框裁出 dataURL（宽 ≤800px） */
function cropDataUrl(
  src: string,
  box: { x: number; y: number; width: number; height: number },
  maxW = 800,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const bw = Math.max(1, box.width)
      const bh = Math.max(1, box.height)
      const w = Math.max(1, Math.min(maxW, Math.round(bw)))
      const h = Math.max(1, Math.round((bh / bw) * w))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('画布不可用'))
        return
      }
      ctx.drawImage(img, box.x, box.y, bw, bh, 0, 0, w, h)
      resolve(canvas.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = src
  })
}

/** 可视化表格模板：rows×cols */
function buildTableTemplate(rows: number, cols: number): string {
  const head = `| ${Array.from({ length: cols }, (_, i) => `表头 ${i + 1}`).join(' | ')} |`
  const sep = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`
  const body = Array.from({ length: Math.max(rows - 1, 1) }, () =>
    `| ${Array.from({ length: cols }, () => '单元格').join(' | ')} |`,
  )
  // 末尾补一个换行：插入点在句子中间时，避免后续文字粘在最后一行表格上导致 Markdown 表格解析失败
  return [head, sep, ...body].join('\n') + '\n'
}

/** 预览用：把 {{挖空}} 显示为加粗（关键词提取用 extractClozeMarks） */
function toPreviewMarkdown(text: string): string {
  return String(text ?? '')
    .replace(/\{\{([^{}]*)\}\}/g, (_m, inner: string) => {
      const kw = inner.trim()
      return kw ? `**${kw}**` : inner
    })
    // 荧光笔 ==x== → <mark>
    .replace(/==([^=\n]+)==/g, '<mark>$1</mark>')
    // 字色 %%color|文字%% → <span style>
    .replace(/%%([^|\n]+)\|([^%\n]*)%%/g, '<span style="color:$1">$2</span>')
}

// ---------- 自适应高度输入框 ----------
type AutoTextareaProps = Omit<React.ComponentProps<'textarea'>, 'ref' | 'value'> & {
  value: string
  register: (el: HTMLTextAreaElement | null) => void
  /** 变化时触发重新量高（如全局字号/行距变化） */
  resizeKey?: string
  /** 语音识别文本追加回调 — 提供时在右下角显示麦克风按钮 */
  onVoiceText?: (text: string) => void
  /** 语音输入上下文（音色偏好） */
  voiceContext?: string
}

function AutoTextarea({ value, register, resizeKey, onVoiceText, voiceContext, ...rest }: AutoTextareaProps) {
  const elRef = React.useRef<HTMLTextAreaElement | null>(null)
  React.useEffect(() => {
    const el = elRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value, resizeKey])
  return (
    <div className="relative">
      <Textarea
        {...rest}
        value={value}
        ref={(el: HTMLTextAreaElement | null) => {
          elRef.current = el
          register(el)
        }}
      />
      {onVoiceText && (
        <div className="absolute bottom-1.5 right-1.5 z-10">
          <VoiceInput
            size="sm"
            context={voiceContext || 'editor'}
            disabled={rest.disabled}
            onText={onVoiceText}
          />
        </div>
      )}
    </div>
  )
}

// ---------- 主组件 ----------
type FocusField = 'front' | 'back'
interface FocusTarget {
  index: number
  field: FocusField
}

export function MaterialEditor(props: MaterialEditorProps): React.JSX.Element {
  const { card, onBack, onSave, onTitleChange } = props

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

  // blocks/history/future 的镜像 ref：同步更新，保证异步回调与「完成」读到的永远是最新值
  const blocksRef = React.useRef<MaterialBlock[]>(blocks)
  const historyRef = React.useRef<MaterialBlock[][]>(history)
  const futureRef = React.useRef<MaterialBlock[][]>(future)

  // ---- UI 状态 ----
  const [title, setTitle] = React.useState(() => card.title?.trim() || '新材料')
  // ---- 未保存保护：初始快照 + dirty 判定（需求图：是否保存文章弹窗） ----
  const initialSnapRef = React.useRef<{ title: string; blocks: string } | null>(null)
  if (initialSnapRef.current === null) {
    initialSnapRef.current = {
      title: card.title?.trim() || '',
      blocks: JSON.stringify(
        blocksRef.current.map((b) => [b.front ?? '', b.back ?? '', b.hidden === true]),
      ),
    }
  }
  const dirty =
    JSON.stringify(blocksRef.current.map((b) => [b.front ?? '', b.back ?? '', b.hidden === true])) !==
      initialSnapRef.current.blocks ||
    (title.trim() !== '' &&
      title.trim() !== '新材料' &&
      title.trim() !== initialSnapRef.current.title)
  const [confirmBack, setConfirmBack] = React.useState(false)
  const [batch, setBatch] = React.useState(false)
  const [selected, setSelected] = React.useState<ReadonlySet<number>>(new Set())
  const [aiIdx, setAiIdx] = React.useState<number | null>(null)
  const [chunkLoading, setChunkLoading] = React.useState(false)
  const [chunkResult, setChunkResult] = React.useState<string[] | null>(null)
  const [kbUp, setKbUp] = React.useState(false)
  const [fontSize, setFontSize] = React.useState(16)
  const [lineSpacing, setLineSpacing] = React.useState<number>(1.7)
  /** 处于 Markdown 预览态的块（下标集合） */
  const [previewIdx, setPreviewIdx] = React.useState<ReadonlySet<number>>(new Set())

  // ---- refs ----
  const taRefs = React.useRef(new Map<string, HTMLTextAreaElement>())
  const lastFocusRef = React.useRef<FocusTarget | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  // ---- 图片裁剪 / AI 扫描 ----
  const cameraInputRef = React.useRef<HTMLInputElement | null>(null)
  const scanInputRef = React.useRef<HTMLInputElement | null>(null)
  const [imgEdit, setImgEdit] = React.useState<string | null>(null) // 待裁剪图片 dataURL
  const [imgZoom, setImgZoom] = React.useState(1)
  const [imgOffset, setImgOffset] = React.useState<CropOffset>({ x: 0, y: 0 })
  const [imgCrop, setImgCrop] = React.useState<CropBox | null>(null)
  const imgCropNaturalRef = React.useRef<CropBox | null>(null)
  const [tableOpen, setTableOpen] = React.useState(false)
  const [tableRows, setTableRows] = React.useState(3)
  const [tableCols, setTableCols] = React.useState(3)

  // ---- state + ref 同步写入 ----
  const applyBlocks = (next: MaterialBlock[]) => {
    blocksRef.current = next
    setBlocks(next)
  }
  const applyHistory = (next: MaterialBlock[][]) => {
    historyRef.current = next
    setHistory(next)
  }
  const applyFuture = (next: MaterialBlock[][]) => {
    futureRef.current = next
    setFuture(next)
  }

  // ---- 变更 + 历史（快照上限 50；文本输入在时间窗内合并为一条） ----
  // 所有编辑统一走 commit(updater)：updater 基于最新 blocksRef 计算，杜绝并发覆盖。
  const commit = (updater: (prev: MaterialBlock[]) => MaterialBlock[], editKey?: string) => {
    const prev = blocksRef.current
    const next = updater(prev)
    if (next === prev) return
    applyBlocks(next)
    const now = Date.now()
    const last = lastEditRef.current
    const coalesce =
      !!editKey && !!last && last.key === editKey && now - last.time < COALESCE_MS
    if (coalesce) {
      lastEditRef.current = { key: editKey as string, time: now }
    } else {
      applyHistory([...historyRef.current, prev].slice(-MAX_HISTORY))
      applyFuture([])
      lastEditRef.current = editKey ? { key: editKey, time: now } : null
    }
  }

  const undo = () => {
    const h = historyRef.current
    if (h.length === 0) return
    const prev = h[h.length - 1]
    applyHistory(h.slice(0, -1))
    applyFuture([blocksRef.current, ...futureRef.current].slice(0, MAX_HISTORY))
    applyBlocks(prev)
    setSelected(new Set())
    lastFocusRef.current = null
    lastEditRef.current = null
  }

  const redo = () => {
    const f = futureRef.current
    if (f.length === 0) return
    const next = f[0]
    applyFuture(f.slice(1))
    applyHistory([...historyRef.current, blocksRef.current].slice(-MAX_HISTORY))
    applyBlocks(next)
    setSelected(new Set())
    lastFocusRef.current = null
    lastEditRef.current = null
  }

  // ---- 文本编辑 ----
  const updateField = (index: number, field: FocusField, value: string) => {
    commit(
      (prev) =>
        prev.map((b, i) => {
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

  /** 取「最近点击的文本框」目标，不存在则 toast 提示 */
  const requireFocusTarget = (): FocusTarget | null => {
    const t = lastFocusRef.current
    if (!t || t.index >= blocksRef.current.length) {
      toast.info('请先点击要编辑的文本框')
      return null
    }
    return t
  }

  // ---- 块操作 ----
  const addBlockAfter = (index: number) => {
    commit((prev) => {
      const next = [...prev]
      next.splice(index + 1, 0, { front: '', back: '' })
      return next
    })
    lastFocusRef.current = null
  }

  /** 新建分块：插到最近编辑的块后面；没有焦点则追加到末尾 */
  const addBlockSmart = () => {
    const t = lastFocusRef.current
    const base =
      t && t.index < blocksRef.current.length ? t.index : blocksRef.current.length - 1
    addBlockAfter(base)
  }

  const moveBlock = (index: number, dir: -1 | 1) => {
    const j = index + dir
    if (j < 0 || j >= blocksRef.current.length) return
    commit((prev) => {
      const next = [...prev]
      const [b] = next.splice(index, 1)
      next.splice(j, 0, b)
      return next
    })
    lastFocusRef.current = null
  }

  const splitBlock = (index: number) => {
    const block = blocksRef.current[index]
    if (!block) return
    const [a, b] = splitBackText(block.back)
    if (!b) {
      toast.warning('内容太短，无法拆分')
      return
    }
    commit((prev) => {
      const next = [...prev]
      const cur = next[index]
      if (!cur) return prev
      next[index] = { ...cur, back: a }
      next.splice(index + 1, 0, { front: '', back: b })
      return next
    })
    lastFocusRef.current = null
    toast.success('已拆分为两块')
  }

  const mergeWithNext = (index: number) => {
    const list = blocksRef.current
    if (index >= list.length - 1) {
      toast.warning('已是最后一块，无法合并')
      return
    }
    const a = list[index]
    const b = list[index + 1]
    if (!a || !b) return
    commit((prev) => {
      if (index >= prev.length - 1) return prev
      const merged: MaterialBlock = {
        front: [prev[index]?.front, prev[index + 1]?.front].filter(Boolean).join('；'),
        back: [prev[index]?.back, prev[index + 1]?.back].filter(Boolean).join('\n'),
        hidden: prev[index]?.hidden,
      }
      const next = prev.filter((_, i) => i !== index + 1)
      next[index] = merged
      return next
    })
    lastFocusRef.current = null
    toast.success('已与下一块合并')
  }

  const toggleHidden = (index: number) => {
    commit((prev) =>
      prev.map((b, i) => (i === index ? { ...b, hidden: !b.hidden } : b)),
    )
    lastFocusRef.current = null
  }

  const removeBlock = (index: number) => {
    commit((prev) => prev.filter((_, i) => i !== index))
    lastFocusRef.current = null
  }

  // ---- 预览态 ----
  const togglePreview = (i: number) => {
    setPreviewIdx((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const expandAll = () => setPreviewIdx(new Set())
  const collapseAll = () => setPreviewIdx(new Set(blocksRef.current.map((_, i) => i)))

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
      .filter((i) => i >= 0 && i < blocksRef.current.length)
      .sort((a, b) => a - b)
    if (idxs.length < 2) return
    const first = idxs[0]
    commit((prev) => {
      const merged: MaterialBlock = {
        front: idxs.map((i) => prev[i]?.front ?? '').filter(Boolean).join('；'),
        back: idxs.map((i) => prev[i]?.back ?? '').filter(Boolean).join('\n'),
        hidden: prev[first]?.hidden,
      }
      const next: MaterialBlock[] = []
      prev.forEach((b, i) => {
        if (i === first) next.push(merged)
        else if (!selected.has(i)) next.push(b)
      })
      return next
    })
    setSelected(new Set())
    lastFocusRef.current = null
    toast.success(`已合并 ${idxs.length} 块`)
  }

  const hideSelected = () => {
    if (selected.size === 0) return
    const n = selected.size
    commit((prev) =>
      prev.map((b, i) => (selected.has(i) ? { ...b, hidden: true } : b)),
    )
    setSelected(new Set())
    lastFocusRef.current = null
    toast.success(`已隐藏 ${n} 块`)
  }

  const deleteSelected = () => {
    if (selected.size === 0) return
    const n = selected.size
    commit((prev) => prev.filter((_, i) => !selected.has(i)))
    setSelected(new Set())
    lastFocusRef.current = null
    toast.success(`已删除 ${n} 块`)
  }

  // ---- AI生成核心论点（POST /api/chat）----
  // 修复：旧实现请求返回后用「调用时的 blocks 快照」整表覆写，会吞掉等待期间
  // 用户继续输入的内容（编辑丢失/不生效）。改为 commit 函数式更新。
  const generateFront = async (index: number) => {
    const back = (blocksRef.current[index]?.back ?? '').trim()
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
      commit((prev) => prev.map((b, bi) => (bi === index ? { ...b, front: reply } : b)))
      toast.success('已生成核心论点')
    } catch (err) {
      toast.error('AI生成失败：' + (err instanceof Error ? err.message : '未知错误'))
    } finally {
      setAiIdx(null)
    }
  }

  // ---- 分割分块（POST /api/chunk → 确认 → 替换全部块）----
  const runChunk = async () => {
    const content = blocksRef.current
      .map((b) => b.back)
      .filter(Boolean)
      .join('\n')
      .trim()
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
    commit(() => chunkResult.map((c) => ({ front: '', back: c })))
    lastFocusRef.current = null
    setPreviewIdx(new Set())
    setChunkResult(null)
    toast.success(`已分割为 ${n} 块`)
  }

  // ---- 光标插入（格式 / 公式 / 表格 / 图片 / 挖空）----
  const insertMarkdown = (before: string, after: string, ph: string, multiline = false) => {
    const target = lastFocusRef.current
    const el = target ? taRefs.current.get(`${target.index}-${target.field}`) : undefined
    if (!target || !el || target.index >= blocksRef.current.length) {
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
    commit((prev) =>
      prev.map((b, bi) => {
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

  /** 挖空：把最近聚焦文本框的选区文字包上 {{ }}（src/lib/editor-cloze.ts） */
  const applyCloze = () => {
    const target = lastFocusRef.current
    const el = target ? taRefs.current.get(`${target.index}-${target.field}`) : undefined
    if (!target || !el || target.index >= blocksRef.current.length) {
      toast.info('请先点击要编辑的文本框')
      return
    }
    const value = el.value
    const start = el.selectionStart ?? value.length
    const end = el.selectionEnd ?? start
    const sel = value.slice(start, end)
    if (!sel.trim()) {
      toast.warning('请先选中文字')
      return
    }
    const idx = target.index
    const field = target.field
    const nextValue = value.slice(0, start) + wrapClozeMark(sel) + value.slice(end)
    commit((prev) =>
      prev.map((b, bi) => {
        if (bi !== idx) return b
        return field === 'front' ? { ...b, front: nextValue } : { ...b, back: nextValue }
      }),
    )
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + 2, start + 2 + sel.length)
    })
  }

  // ---- 插入图片（先压缩，再进入裁剪编辑器）----
  const prepareImage = async (file: File | undefined, direct = false) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.error('请选择图片文件')
      return
    }
    try {
      const dataUrl = await compressImage(file)
      if (direct) {
        insertMarkdown(`![图片](${dataUrl})`, '', '')
        toast.success('图片已插入')
      } else {
        setImgZoom(1)
        setImgOffset({ x: 0, y: 0 })
        setImgCrop(null)
        imgCropNaturalRef.current = null
        setImgEdit(dataUrl)
      }
    } catch (err) {
      toast.error('图片处理失败：' + (err instanceof Error ? err.message : '未知错误'))
    }
  }

  const handleImageFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    await prepareImage(file)
  }

  const handleCameraFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    await prepareImage(file)
  }

  // AI 扫描：图片 → OCR 文字 → 插入正文
  const handleScanFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.error('请选择图片文件')
      return
    }
    const tid = toast.loading('AI 正在识别图片文字…')
    try {
      const dataUrl = await compressImage(file)
      const res = await fetch('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '识别失败')
      }
      const data = (await res.json()) as { text?: string }
      const text = (data.text || '').trim()
      if (!text) {
        toast.warning('未识别到文字', { id: tid })
        return
      }
      insertMarkdown(text, '', '')
      toast.success(`已插入识别文字（${text.length} 字）`, { id: tid })
    } catch (err) {
      toast.error('AI 扫描失败：' + (err instanceof Error ? err.message : '未知错误'), { id: tid })
    }
  }

  // 裁剪后插入
  const insertCropped = async (boxOverride?: CropBox | null) => {
    if (!imgEdit) return
    try {
      const box = boxOverride ?? imgCropNaturalRef.current ?? imgCrop
      const out = box ? await cropDataUrl(imgEdit, box) : imgEdit
      insertMarkdown(`![图片](${out})`, '', '')
      toast.success('图片已插入')
      setImgEdit(null)
    } catch (err) {
      toast.error('裁剪失败：' + (err instanceof Error ? err.message : '未知错误'))
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

  // ---- 完成：从 blocksRef 读取最新块列表，保证包含全部编辑（含隐藏块） ----
  const handleDone = () => {
    const finalBlocks: MaterialBlock[] = blocksRef.current.map((b) => ({
      front: b.front ?? '',
      back: b.back ?? '',
      ...(b.hidden === true ? { hidden: true } : {}),
    }))
    const t = title.trim()
    if (onTitleChange && t && t !== (card.title ?? '')) onTitleChange(t)
    onSave(finalBlocks)
    toast.success('已保存')
  }

  // ================= 渲染 =================
  return (
    <>
      {/* 顶栏：第 1 行主操作 + 第 2 行工具条（吸顶） */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto w-full max-w-2xl">
          <div className="flex h-14 items-center gap-2 px-3">
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
                  onClick={() => (dirty ? setConfirmBack(true) : onBack())}
                  aria-label="返回"
                  className={HEADER_ICON_BTN}
                >
                  <ChevronLeft className="size-6" strokeWidth={1.75} aria-hidden />
                </button>
                {/* ⚡ AI快速分块（AI 色 emerald 胶囊） */}
                <button
                  type="button"
                  aria-label="AI 快速分块"
                  disabled={chunkLoading}
                  onClick={() => void runChunk()}
                  className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 text-[13px] font-semibold text-emerald-600 transition-colors hover:bg-emerald-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60 dark:text-emerald-400"
                >
                  {chunkLoading ? (
                    <Loader2 className="size-4 animate-spin" strokeWidth={2} aria-hidden />
                  ) : (
                    <Zap className="size-4" strokeWidth={2} aria-hidden />
                  )}
                  AI快速分块
                </button>
                <div className="ml-auto flex items-center gap-0.5">
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
                    onClick={handleDone}
                    className="shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-[15px] font-bold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    完成
                  </button>
                </div>
              </>
            )}
          </div>

          {/* 第 2 行：横向可滚动工具条 */}
          {!batch && (
            <div
              role="toolbar"
              aria-label="编辑工具"
              className="flex items-stretch gap-0.5 overflow-x-auto px-2 pb-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {/* 样式（Aa） */}
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="样式"
                    onMouseDown={(e) => e.preventDefault()}
                    className={TOOLBAR_BTN}
                  >
                    <ALargeSmall className="size-5" strokeWidth={1.75} aria-hidden />
                    <span className="text-[11px] leading-none">样式</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="bottom"
                  align="start"
                  onOpenAutoFocus={(e) => e.preventDefault()}
                  className="w-64 rounded-2xl p-4"
                >
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

              {/* 格式（Markdown 语法） */}
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="格式"
                    onMouseDown={(e) => e.preventDefault()}
                    className={TOOLBAR_BTN}
                  >
                    <Type className="size-5" strokeWidth={1.75} aria-hidden />
                    <span className="text-[11px] leading-none">格式</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="bottom"
                  align="start"
                  onOpenAutoFocus={(e) => e.preventDefault()}
                  className="w-64 rounded-2xl"
                >
                  <div className="grid grid-cols-3 gap-1.5">
                    {FORMAT_ITEMS.map((f) => (
                      <button
                        key={f.kind}
                        type="button"
                        onClick={() => applyFormat(f.kind)}
                        onMouseDown={(e) => e.preventDefault()}
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

              {/* 字色 */}
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="文字颜色"
                    onMouseDown={(e) => e.preventDefault()}
                    className={TOOLBAR_BTN}
                  >
                    <Paintbrush className="size-5" strokeWidth={1.75} aria-hidden />
                    <span className="text-[11px] leading-none">字色</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="bottom"
                  align="start"
                  onOpenAutoFocus={(e) => e.preventDefault()}
                  className="w-48 rounded-2xl p-3"
                >
                  <p className="text-sm font-semibold">文字颜色</p>
                  <div className="mt-2 grid grid-cols-6 gap-1.5">
                    {TEXT_COLORS.map((c) => (
                      <button
                        key={c.value}
                        type="button"
                        aria-label={c.label}
                        title={c.label}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => insertMarkdown(`%%${c.value}|`, '%%', '文字')}
                        className="flex size-8 items-center justify-center rounded-full ring-1 ring-border transition-transform hover:scale-110"
                      >
                        <span
                          className="size-5 rounded-full"
                          style={{ background: c.value === 'default' ? 'linear-gradient(45deg,#ddd,#fff)' : c.value }}
                        />
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">选中文字后点色球可给选区上色</p>
                </PopoverContent>
              </Popover>

              {/* 挖空：选中文字包上 {{ }} */}
              <button
                type="button"
                aria-label="挖空选中文字"
                onClick={applyCloze}
                onMouseDown={(e) => e.preventDefault()}
                className={TOOLBAR_BTN}
              >
                <Braces className="size-5" strokeWidth={1.75} aria-hidden />
                <span className="text-[11px] leading-none">挖空</span>
              </button>

              {/* 批量操作 */}
              <button
                type="button"
                aria-label={batch ? '退出批量操作' : '批量操作'}
                aria-pressed={batch}
                onClick={batch ? exitBatch : enterBatch}
                className={cn(TOOLBAR_BTN, batch && 'bg-muted text-foreground')}
              >
                <ListChecks className="size-5" strokeWidth={1.75} aria-hidden />
                <span className="text-[11px] leading-none">批量操作</span>
              </button>

              {/* 图片：本地上传（压缩≤800px 转 dataURL）/ 插入图片链接 */}
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="插入图片"
                    onMouseDown={(e) => e.preventDefault()}
                    className={TOOLBAR_BTN}
                  >
                    <ImagePlus className="size-5" strokeWidth={1.75} aria-hidden />
                    <span className="text-[11px] leading-none">图片</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="bottom"
                  align="start"
                  onOpenAutoFocus={(e) => e.preventDefault()}
                  className="w-48 rounded-2xl p-1.5"
                >
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Crop className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden />
                    上传图片（可裁剪）
                  </button>
                  <button
                    type="button"
                    onClick={() => cameraInputRef.current?.click()}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Camera className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden />
                    拍照插入
                  </button>
                  <button
                    type="button"
                    onClick={() => scanInputRef.current?.click()}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ScanLine className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden />
                    AI 扫描（识别文字）
                  </button>
                  <button
                    type="button"
                    onClick={() => insertMarkdown('![](', ')', 'url')}
                    onMouseDown={(e) => e.preventDefault()}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <LinkIcon className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden />
                    插入图片链接
                  </button>
                  <p className="px-2.5 pb-1.5 pt-1 text-[11px] text-muted-foreground">
                    图片压缩到 800px 宽后内嵌；AI 扫描把图中文字插入正文
                  </p>
                </PopoverContent>
              </Popover>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                aria-hidden
                tabIndex={-1}
                onChange={(e) => void handleImageFile(e)}
              />
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                aria-hidden
                tabIndex={-1}
                onChange={(e) => void handleCameraFile(e)}
              />
              <input
                ref={scanInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                aria-hidden
                tabIndex={-1}
                onChange={(e) => void handleScanFile(e)}
              />

              {/* 公式：行内 $..$ / 独立 $$..$$ */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="插入公式" className={TOOLBAR_BTN}>
                    <SquareSigma className="size-5" strokeWidth={1.75} aria-hidden />
                    <span className="text-[11px] leading-none">公式</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="start" className="w-44 rounded-xl">
                  <DropdownMenuItem
                    onClick={() => {
                      insertMarkdown('$', '$', 'E=mc^2')
                    }}
                  >
                    行内公式 $x^2$
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      insertMarkdown('$$', '$$', 'E=mc^2')
                    }}
                  >
                    独立公式 $$…$$
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* 表格：可视化行列选择 */}
              <Popover open={tableOpen} onOpenChange={setTableOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="插入表格"
                    onMouseDown={(e) => e.preventDefault()}
                    className={TOOLBAR_BTN}
                  >
                    <TableIcon className="size-5" strokeWidth={1.75} aria-hidden />
                    <span className="text-[11px] leading-none">表格</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent side="bottom" align="start" className="w-56 rounded-2xl p-3">
                  <p className="text-sm font-semibold">插入表格</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">选择行数 × 列数</p>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">行</span>
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-7 rounded-full"
                      aria-label="减少行"
                      onClick={() => setTableRows((r) => Math.max(1, r - 1))}
                    >
                      −
                    </Button>
                    <span className="w-6 text-center text-sm font-medium tabular-nums">{tableRows}</span>
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-7 rounded-full"
                      aria-label="增加行"
                      onClick={() => setTableRows((r) => Math.min(20, r + 1))}
                    >
                      +
                    </Button>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">列</span>
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-7 rounded-full"
                      aria-label="减少列"
                      onClick={() => setTableCols((c) => Math.max(1, c - 1))}
                    >
                      −
                    </Button>
                    <span className="w-6 text-center text-sm font-medium tabular-nums">{tableCols}</span>
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-7 rounded-full"
                      aria-label="增加列"
                      onClick={() => setTableCols((c) => Math.min(10, c + 1))}
                    >
                      +
                    </Button>
                  </div>
                  <Button
                    size="sm"
                    className="mt-2.5 h-8 w-full rounded-full text-xs"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      insertMarkdown(buildTableTemplate(tableRows, tableCols), '', '', true)
                      setTableOpen(false)
                    }}
                  >
                    插入 {tableRows}×{tableCols} 表格
                  </Button>
                </PopoverContent>
              </Popover>

              {/* 新建分块 */}
              <button
                type="button"
                aria-label="新建分块"
                onClick={addBlockSmart}
                onMouseDown={(e) => e.preventDefault()}
                className={TOOLBAR_BTN}
              >
                <Plus className="size-5" strokeWidth={1.75} aria-hidden />
                <span className="text-[11px] leading-none">新建分块</span>
              </button>

              {/* 分割分块（AI） */}
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

              {/* 操作：更多块操作菜单 */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="更多操作" className={TOOLBAR_BTN}>
                    <MoreHorizontal className="size-5" strokeWidth={1.75} aria-hidden />
                    <span className="text-[11px] leading-none">操作</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="end" className="w-56 rounded-xl">
                  <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
                    作用于最近点击的块
                  </p>
                  <DropdownMenuItem
                    onClick={() => {
                      const t = requireFocusTarget()
                      if (t) addBlockAfter(t.index)
                    }}
                  >
                    <Plus className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden />
                    在此块后新建
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      const t = requireFocusTarget()
                      if (t) mergeWithNext(t.index)
                    }}
                  >
                    <Merge className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden />
                    合并到下一块
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      const t = requireFocusTarget()
                      if (t) toggleHidden(t.index)
                    }}
                  >
                    <EyeOff className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden />
                    隐藏此块
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      const t = requireFocusTarget()
                      if (t) removeBlock(t.index)
                    }}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="size-4" strokeWidth={1.75} aria-hidden />
                    删除此块
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={expandAll}>
                    <UnfoldVertical className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden />
                    全部展开（编辑）
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={collapseAll}>
                    <FoldVertical className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden />
                    全部收起（预览）
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

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
          )}
        </div>
      </header>

      {/* 主体 */}
      <main className="min-w-0 flex-1 bg-muted/40 pb-16">
        <div className="mx-auto w-full max-w-2xl px-4 pt-4">
          {/* 标题（第一行：卡标题输入） */}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              const t = title.trim()
              if (onTitleChange && t && t !== (card.title ?? '')) onTitleChange(t)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
            placeholder="输入材料标题"
            aria-label="材料标题"
            className="w-full bg-transparent text-2xl font-bold tracking-tight outline-none placeholder:text-muted-foreground/40 focus-visible:outline-none"
          />
          <p className="mt-1 text-xs text-muted-foreground/80">
            点击文本直接编辑；选中文字后点「挖空」生成挖空标记
          </p>

          {/* 块列表 */}
          <div className="mt-4 space-y-4">
            {blocks.length === 0 ? (
              <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border bg-card py-16">
                <p className="text-sm text-muted-foreground">暂无内容块</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => commit(() => [{ front: '', back: '' }])}
                >
                  <Plus className="size-4" strokeWidth={1.75} aria-hidden />
                  添加内容块
                </Button>
              </div>
            ) : (
              blocks.map((block, i) => {
                const isSel = selected.has(i)
                const isHidden = block.hidden === true
                const isPreview = !isHidden && previewIdx.has(i)
                const previewData = isPreview ? extractClozeMarks(block.back) : null

                // 已隐藏的块 → 折叠为细条
                if (isHidden) {
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

                return (
                  <article
                    key={i}
                    className={cn(
                      'space-y-3 rounded-2xl bg-card p-4 shadow-sm',
                      batch && isSel && 'ring-2 ring-primary/50',
                    )}
                  >
                    {/* 块头：移动手柄 / 批量选择 + 序号 + 预览切换 + 拆分 */}
                    <div className="flex items-center gap-1.5">
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
                      ) : (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              aria-label={`移动第${i + 1}块`}
                              className={SMALL_ICON_BTN}
                            >
                              <GripVertical className="size-4" strokeWidth={1.75} aria-hidden />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start" className="w-36 rounded-xl">
                            <DropdownMenuItem disabled={i === 0} onClick={() => moveBlock(i, -1)}>
                              <ChevronUp className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden />
                              上移
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={i === blocks.length - 1}
                              onClick={() => moveBlock(i, 1)}
                            >
                              <ChevronDown className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden />
                              下移
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                      <span className="text-xs font-medium text-muted-foreground">第{i + 1}块</span>

                      <div className="ml-auto flex items-center gap-1">
                        {!batch && (
                          <button
                            type="button"
                            aria-label={isPreview ? `编辑第${i + 1}块` : `预览第${i + 1}块`}
                            aria-pressed={isPreview}
                            onClick={() => togglePreview(i)}
                            className={SMALL_ICON_BTN}
                          >
                            {isPreview ? (
                              <PenLine className="size-4" strokeWidth={1.75} aria-hidden />
                            ) : (
                              <Eye className="size-4" strokeWidth={1.75} aria-hidden />
                            )}
                          </button>
                        )}
                        {!batch && (
                          <button
                            type="button"
                            aria-label={`拆分第${i + 1}块`}
                            onClick={() => splitBlock(i)}
                            className={TEXT_BTN}
                          >
                            拆分
                          </button>
                        )}
                      </div>
                    </div>

                    {/* 核心论点（正面） */}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm text-muted-foreground">核心论点（正面）：</span>
                      <button
                        type="button"
                        onClick={() => void generateFront(i)}
                        disabled={aiIdx !== null}
                        aria-label="AI 生成核心论点"
                        className="flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium text-emerald-600 transition-colors hover:bg-emerald-500/10 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 dark:text-emerald-400"
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
                      placeholder="点击编辑核心论点（可语音输入）"
                      aria-label={`第${i + 1}块核心论点（正面）`}
                      className="min-h-11 resize-none rounded-xl border-0 bg-muted px-3 py-2.5 pr-10 shadow-none focus-visible:ring-1"
                      onVoiceText={(t) => updateField(i, 'front', block.front + t)}
                      voiceContext="editor"
                    />

                    {/* 完整内容（背面）：编辑 / Markdown 预览 */}
                    <span className="block text-sm text-muted-foreground">完整内容（背面）：</span>
                    {isPreview ? (
                      <div
                        className="min-h-28 overflow-hidden rounded-xl bg-muted px-3 py-3"
                        style={{ fontSize, lineHeight: lineSpacing }}
                      >
                        <RichContent
                          content={toPreviewMarkdown(block.back)}
                          className="text-[length:inherit] leading-[inherit]"
                        />
                        {previewData && previewData.keywords.length > 0 && (
                          <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-border/60 pt-2">
                            <span className="text-[11px] text-muted-foreground">挖空词：</span>
                            {previewData.keywords.map((k) => (
                              <span
                                key={typeof k === 'string' ? k : `${k.t}@${k.occ}`}
                                className="rounded-md bg-background px-1.5 py-0.5 text-[11px] text-foreground ring-1 ring-border"
                              >
                                {typeof k === 'string' ? k : k.t}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <AutoTextarea
                        value={block.back}
                        register={(el) => registerTA(i, 'back', el)}
                        onChange={(e) => updateField(i, 'back', e.target.value)}
                        onFocus={() => handleTAFocus(i, 'back')}
                        onBlur={() => setKbUp(false)}
                        placeholder="新段落内容...（可语音输入）"
                        aria-label={`第${i + 1}块完整内容（背面）`}
                        resizeKey={`${fontSize}-${lineSpacing}`}
                        style={{ fontSize, lineHeight: lineSpacing }}
                        onVoiceText={(t) => updateField(i, 'back', block.back + t)}
                        voiceContext="editor"
                        className="min-h-28 resize-none rounded-xl border-0 bg-muted px-3 py-3 shadow-none focus-visible:ring-1"
                      />
                    )}
                  </article>
                )
              })
            )}
          </div>
        </div>
      </main>

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
      {/* 图片裁剪弹窗（上传/拍照后可选裁剪再插入） */}
      <CropDialog
        src={imgEdit ?? ''}
        open={!!imgEdit}
        onOpenChange={(v) => {
          if (!v) setImgEdit(null)
        }}
        onConfirm={(box) => void insertCropped(box)}
      />
      {/* 未保存返回确认 */}
      <ConfirmBackDialog
        open={confirmBack}
        onOpenChange={setConfirmBack}
        onDiscard={() => {
          setConfirmBack(false)
          onBack()
        }}
        onSave={() => {
          setConfirmBack(false)
          handleDone()
        }}
      />
    </>
  )
}

// ============================================================
// CropDialog — 图片裁剪编辑弹窗（自由拉升裁剪框）
// ============================================================
function CropDialog({
  src,
  open,
  onOpenChange,
  onConfirm,
}: {
  src: string
  open: boolean
  onOpenChange: (v: boolean) => void
  onConfirm: (box: CropBox | null) => void
}) {
  const [zoom, setZoom] = React.useState(1)
  const [offset, setOffset] = React.useState<CropOffset>({ x: 0, y: 0 })
  const [crop, setCrop] = React.useState<CropBox | null>(null)
  const naturalRef = React.useRef<CropBox | null>(null)

  React.useEffect(() => {
    if (open) {
      setZoom(1)
      setOffset({ x: 0, y: 0 })
      setCrop(null)
      naturalRef.current = null
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto rounded-2xl sm:max-w-md">
        <DialogHeader className="pr-10">
          <DialogTitle>裁剪图片</DialogTitle>
          <DialogDescription>拖动边角手柄自由调整裁剪范围，缩放后可直接插入</DialogDescription>
        </DialogHeader>
        <div className="rounded-xl border border-border bg-muted/40 p-2">
          <FreeCropBox
            src={src}
            zoom={zoom}
            onZoomChange={setZoom}
            offset={offset}
            onOffsetChange={setOffset}
            crop={crop}
            onCropChange={setCrop}
            onCropNatural={(c) => {
              naturalRef.current = c
            }}
            grid
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">缩放</span>
          <Slider
            value={[zoom]}
            min={1}
            max={4}
            step={0.1}
            onValueChange={(v) => setZoom(v[0] ?? 1)}
            className="flex-1"
          />
          <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
            {zoom.toFixed(1)}x
          </span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1 rounded-full" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button className="flex-1 rounded-full" onClick={() => onConfirm(naturalRef.current ?? crop)}>
            插入图片
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------- 未保存返回确认（需求图：是否保存文章） ----------
function ConfirmBackDialog(props: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onDiscard: () => void
  onSave: () => void
}): React.JSX.Element {
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent className="max-w-[88vw] rounded-3xl">
        <AlertDialogHeader className="items-center text-center">
          <AlertDialogTitle>是否保存文章</AlertDialogTitle>
          <AlertDialogDescription>
            检测到有编辑未保存的文章，退出后将丢失这些更改。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-row items-center justify-center gap-2 sm:justify-center">
          <AlertDialogCancel className="mt-0 flex-1 rounded-full">取消</AlertDialogCancel>
          <AlertDialogAction
            className="flex-1 rounded-full border border-border bg-transparent text-foreground hover:bg-muted"
            onClick={props.onDiscard}
          >
            不保存
          </AlertDialogAction>
          <AlertDialogAction
            className="flex-1 rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={props.onSave}
          >
            保存并退出
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}