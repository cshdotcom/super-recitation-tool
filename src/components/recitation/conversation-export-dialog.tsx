'use client'

// ConversationExportDialog — 消息导出选项对话框（ChatTool 多选导出 / 侧边栏
// 单条与批量导出 / 分享页多选导出 共用）。
//   • 格式选择（图标网格）：Markdown / HTML / TXT / PDF / 图片 / 剪贴板 / JSON
//   • 富媒体总开关：图片 / 音频 / 视频引用（关闭后 ![](url)/[[audio|video:..]] → 文字占位）
//   • 富文本标记开关：**加粗** / ==高亮== / %%u|..%% / {{挖空}} 等（关闭后只留纯文字）
//   • 元数据开关：导出时间 / 对话标题 / 消息计数（关闭后仅导消息正文）
//   • 只导用户消息：过滤掉 AI 消息（用于导出 prompt 集等）
//   • MD 格式时选择「源码形式 / HTML 形式」（富媒体块是否包成内联 HTML）
//   • 勾选要导出的消息列表（默认全选）
// 选项持久化到 localStorage（key=bb-export-conv-opts），下次打开沿用。
import * as React from 'react'
import {
  Braces,
  ClipboardCopy,
  FileCode2,
  FileDown,
  FileText,
  FileType2,
  Image as ImageIcon,
  Loader2,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  exportMessages,
  type ExportFormat,
  type ExportMessage,
  type ExportSection,
} from '@/lib/conversation-export'

const FORMAT_OPTIONS: {
  value: ExportFormat
  label: string
  icon: React.ReactNode
  desc: string
}[] = [
  { value: 'md', label: 'Markdown', icon: <FileText className="size-5" />, desc: '通用标记格式' },
  { value: 'html', label: 'HTML', icon: <FileCode2 className="size-5" />, desc: '网页文档' },
  { value: 'txt', label: 'TXT', icon: <FileType2 className="size-5" />, desc: '纯文本' },
  { value: 'pdf', label: 'PDF', icon: <FileDown className="size-5" />, desc: '打印保存' },
  { value: 'image', label: '图片', icon: <ImageIcon className="size-5" />, desc: 'PNG 长图' },
  { value: 'clipboard', label: '剪贴板', icon: <ClipboardCopy className="size-5" />, desc: '复制文本' },
  { value: 'json', label: 'JSON', icon: <Braces className="size-5" />, desc: '结构化数据' },
]

const CONV_OPTS_KEY = 'bb-export-conv-opts'

interface ConvExportOptsState {
  format: ExportFormat
  includeMedia: boolean
  includeMarks: boolean
  includeMeta: boolean
  onlyUser: boolean
  mdMode: 'source' | 'html'
}

const DEFAULT_OPTS: ConvExportOptsState = {
  format: 'md',
  includeMedia: true,
  includeMarks: true,
  includeMeta: true,
  onlyUser: false,
  mdMode: 'source',
}

function loadOpts(): ConvExportOptsState {
  if (typeof window === 'undefined') return DEFAULT_OPTS
  try {
    const raw = window.localStorage.getItem(CONV_OPTS_KEY)
    if (!raw) return DEFAULT_OPTS
    const p = JSON.parse(raw) as Partial<ConvExportOptsState>
    const format: ExportFormat =
      p.format && (FORMAT_OPTIONS.some((o) => o.value === p.format))
        ? (p.format as ExportFormat)
        : DEFAULT_OPTS.format
    return {
      format,
      includeMedia: typeof p.includeMedia === 'boolean' ? p.includeMedia : true,
      includeMarks: typeof p.includeMarks === 'boolean' ? p.includeMarks : true,
      includeMeta: typeof p.includeMeta === 'boolean' ? p.includeMeta : true,
      onlyUser: typeof p.onlyUser === 'boolean' ? p.onlyUser : false,
      mdMode: p.mdMode === 'html' ? 'html' : 'source',
    }
  } catch {
    return DEFAULT_OPTS
  }
}

function snippet(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 60 ? t.slice(0, 60) + '…' : t || '（无文字内容）'
}

function OptionRow({
  label,
  hint,
  checked,
  onChange,
  id,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
  id: string
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5">
      <Label htmlFor={id} className="cursor-pointer text-sm font-normal">
        {label}
        {hint && <span className="ml-1 text-[11px] text-muted-foreground">{hint}</span>}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

export function ConversationExportDialog({
  open,
  onOpenChange,
  sections,
  title,
  allowImage = true,
  contentClassName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 候选消息分节（单对话=1 节；批量导出=多节）。 */
  sections: ExportSection[]
  /** 导出文档/文件名标题；默认取第一节标题或「AI 对话」。 */
  title?: string
  /** 是否提供「图片」格式（多对话合并时长图过大，可关）。 */
  allowImage?: boolean
  /** DialogContent 附加 className（如全屏对话层内抬高 z）。 */
  contentClassName?: string
}) {
  const [opts, setOpts] = React.useState<ConvExportOptsState>(DEFAULT_OPTS)
  const [checked, setChecked] = React.useState<Set<string>>(new Set())
  const [busy, setBusy] = React.useState(false)

  const allMessages = React.useMemo(
    () => sections.flatMap((s) => s.messages),
    [sections],
  )
  // 候选列表引用（打开时读取最新值；避免 sections 每次渲染新数组导致重置勾选）
  const allMessagesRef = React.useRef(allMessages)
  allMessagesRef.current = allMessages

  // 打开时：从 localStorage 读取上次选项；勾选默认全选
  React.useEffect(() => {
    if (open) {
      setOpts(loadOpts())
      setChecked(new Set(allMessagesRef.current.map((m) => m.id)))
    }
  }, [open])

  // 选项变化 → 持久化（仅在打开时写入，避免初始 DEFAULT_OPTS 覆盖存量）
  React.useEffect(() => {
    if (!open) return
    try {
      window.localStorage.setItem(CONV_OPTS_KEY, JSON.stringify(opts))
    } catch {
      /* 隐私模式忽略 */
    }
  }, [open, opts])

  const patchOpts = (patch: Partial<ConvExportOptsState>) =>
    setOpts((prev) => ({ ...prev, ...patch }))

  const toggleChecked = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allChecked = allMessages.length > 0 && checked.size === allMessages.length
  const toggleAll = () => {
    setChecked(allChecked ? new Set() : new Set(allMessages.map((m) => m.id)))
  }

  const handleExport = async () => {
    if (checked.size === 0) return
    setBusy(true)
    try {
      const picked: ExportSection[] = sections
        .map((s) => ({ ...s, messages: s.messages.filter((m) => checked.has(m.id)) }))
        .filter((s) => s.messages.length > 0)
      const baseName =
        title || (sections.length === 1 ? sections[0].title : '') || 'AI对话导出'
      // 富媒体总开关同时驱动 includeImages（图片内嵌）与 includeMedia（音视频引用）
      await exportMessages(
        picked,
        {
          format: opts.format,
          includeImages: opts.includeMedia,
          includeMedia: opts.includeMedia,
          includeMarks: opts.includeMarks,
          includeMeta: opts.includeMeta,
          onlyUserMessages: opts.onlyUser,
          mdMode: opts.mdMode,
        },
        baseName,
      )
      if (opts.format !== 'pdf') onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  const options = allowImage
    ? FORMAT_OPTIONS
    : FORMAT_OPTIONS.filter((o) => o.value !== 'image')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'max-h-[88dvh] overflow-y-auto rounded-2xl sm:max-w-lg',
          contentClassName,
        )}
      >
        <DialogHeader>
          <DialogTitle>导出对话</DialogTitle>
          <DialogDescription>
            {sections.length > 1
              ? `将导出 ${sections.length} 个对话中勾选的消息`
              : '选择格式与要导出的消息'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* 格式网格 */}
          <div>
            <p className="mb-2 text-sm font-medium">格式</p>
            <div className="grid grid-cols-4 gap-2">
              {options.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => patchOpts({ format: opt.value })}
                  aria-pressed={opts.format === opt.value}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-xl border px-1.5 py-2.5 text-center transition-colors',
                    opts.format === opt.value
                      ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                      : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  {opt.icon}
                  <span className="text-[11px] font-medium leading-none">{opt.label}</span>
                  <span className="text-[9px] leading-none opacity-70">{opt.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 选项开关 */}
          <div className="flex flex-col gap-2.5">
            <OptionRow
              id="conv-export-media"
              label="包含富媒体"
              hint="（图片 / 音频 / 视频）"
              checked={opts.includeMedia}
              onChange={(v) => patchOpts({ includeMedia: v })}
            />
            <OptionRow
              id="conv-export-marks"
              label="包含富文本标记"
              hint="（加粗 / 高亮 / 挖空）"
              checked={opts.includeMarks}
              onChange={(v) => patchOpts({ includeMarks: v })}
            />
            <OptionRow
              id="conv-export-meta"
              label="包含元数据"
              hint="（时间 / 标题 / 计数）"
              checked={opts.includeMeta}
              onChange={(v) => patchOpts({ includeMeta: v })}
            />
            <OptionRow
              id="conv-export-only-user"
              label="只导用户消息"
              hint="（过滤 AI 回复）"
              checked={opts.onlyUser}
              onChange={(v) => patchOpts({ onlyUser: v })}
            />
            {opts.format === 'md' && (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5">
                <span className="text-sm">Markdown 形式</span>
                <div className="flex items-center gap-1 rounded-full border border-border p-0.5">
                  {(
                    [
                      { v: 'source', l: '源码' },
                      { v: 'html', l: 'HTML' },
                    ] as const
                  ).map((o) => (
                    <button
                      key={o.v}
                      type="button"
                      onClick={() => patchOpts({ mdMode: o.v })}
                      aria-pressed={opts.mdMode === o.v}
                      className={cn(
                        'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                        opts.mdMode === o.v
                          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {o.l}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 消息勾选列表 */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium">
                消息
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  已选 {checked.size} / {allMessages.length}
                </span>
              </p>
              <button
                type="button"
                onClick={toggleAll}
                className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {allChecked ? '取消全选' : '全选'}
              </button>
            </div>
            <div className="max-h-52 space-y-1 overflow-y-auto rounded-xl border border-border bg-muted/20 p-1.5 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border">
              {allMessages.length === 0 && (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  没有可导出的消息
                </p>
              )}
              {sections.map((sec, si) => (
                <div key={`sec-${si}`} className="space-y-1">
                  {sections.length > 1 && (
                    <p className="px-1.5 pb-0.5 pt-1.5 text-[11px] font-medium text-muted-foreground">
                      {sec.title || '未命名对话'}
                    </p>
                  )}
                  {sec.messages.map((m: ExportMessage) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => toggleChecked(m.id)}
                      className={cn(
                        'flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
                        checked.has(m.id) ? 'bg-emerald-500/10' : 'hover:bg-accent',
                      )}
                    >
                      <Checkbox
                        checked={checked.has(m.id)}
                        tabIndex={-1}
                        aria-hidden
                        className="mt-0.5 pointer-events-none"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <span
                            className={cn(
                              'rounded-full px-1.5 py-px font-medium',
                              m.role === 'user'
                                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                : 'bg-muted text-muted-foreground',
                            )}
                          >
                            {m.role === 'user' ? '我' : 'AI'}
                          </span>
                          {m.images && m.images.length > 0 && (
                            <span className="text-sky-600 dark:text-sky-400">
                              🖼 {m.images.length}
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate text-xs leading-relaxed">
                          {snippet(m.content)}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" className="rounded-full" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            className="rounded-full"
            disabled={busy || checked.size === 0}
            onClick={() => void handleExport()}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            导出 {checked.size > 0 ? `${checked.size} 条` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
