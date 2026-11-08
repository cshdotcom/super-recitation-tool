'use client'

import * as React from 'react'
import {
  Camera,
  ClipboardPaste,
  FileText,
  ImagePlus,
  Loader2,
  Sparkles,
  SquarePen,
} from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { BottomSheet } from '@/components/recitation/bottom-sheet'
import { CameraCapture } from '@/components/recitation/camera-capture'
import { ImageOcrEditor } from '@/components/recitation/image-ocr-editor'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

export interface ImportPayload {
  title: string
  content: string
  keywords: string[]
}

interface ImportSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Prefill when editing an existing card. */
  initialDraft?: { title: string; content: string } | null
  editing?: boolean
  onImport: (payload: ImportPayload) => void
  onCancel?: () => void
  /** 「直接输入内容」：直接打开超级编辑器（不经过本面板的旧文本框） */
  onDirectEdit?: () => void
}

const IMPORT_ENTRIES = [
  { key: 'file', icon: FileText, label: '文件导入' },
  { key: 'paste', icon: ClipboardPaste, label: '粘贴文本' },
  { key: 'camera', icon: Camera, label: '拍照识别导入' },
  { key: 'image', icon: ImagePlus, label: '图片识别导入' },
] as const

type EntryKey = (typeof IMPORT_ENTRIES)[number]['key']

export function ImportSheet({
  open,
  onOpenChange,
  initialDraft,
  editing = false,
  onImport,
  onCancel,
  onDirectEdit,
}: ImportSheetProps) {
  const [mode, setMode] = React.useState<'choose' | 'input'>('choose')
  const [text, setText] = React.useState('')
  const [title, setTitle] = React.useState('')
  const [aiLoading, setAiLoading] = React.useState(false)
  const [ocrLoading, setOcrLoading] = React.useState<EntryKey | null>(null)
  const [cameraOpen, setCameraOpen] = React.useState(false)
  const [imageEditorOpen, setImageEditorOpen] = React.useState(false)

  // Reset / prefill when opened.
  React.useEffect(() => {
    if (open) {
      setMode(initialDraft ? 'input' : 'choose')
      setText(initialDraft?.content ?? '')
      setTitle(initialDraft?.title ?? '')
    }
  }, [open, initialDraft])

  const startInput = (kind: EntryKey, content = '') => {
    setMode('input')
    if (content) setText(content)
    if (kind === 'paste' && !content) {
      void navigator.clipboard
        .readText()
        .then((clip) => {
          if (clip.trim()) setText((prev) => (prev ? prev : clip))
          else toast.info('剪贴板为空，请手动粘贴文本')
        })
        .catch(() => toast.info('请在此输入或粘贴背诵文本'))
    }
  }

  const handleTextFile = async (file: File) => {
    if (file.size > 15 * 1024 * 1024) {
      toast.error('文件过大，最大支持 15MB')
      return
    }
    setOcrLoading('file')
    const toastId = toast.loading(`正在解析「${file.name}」…`)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/parse', { method: 'POST', body: fd })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(
          res.status === 401
            ? '登录状态已过期，请重新登录后再上传文件'
            : data.error || '文件解析失败',
        )
      }
      const payload = data as { title?: string; content?: string }
      if (!payload.content?.trim()) {
        throw new Error('未能从文件中提取到文字')
      }
      toast.success('文件解析完成', { id: toastId })
      // 文件解析成功：直接进入超级编辑器（不再经过旧文本框二次确认）
      onImport({
        title: payload.title?.trim() || '未命名背诵',
        content: payload.content,
        keywords: [],
      })
      onOpenChange(false)
    } catch (err) {
      // 区分网络中断与服务器报错，提示更人性化
      const networkDown =
        err instanceof TypeError ||
        (err instanceof Error && /fetch|network|failed to fetch/i.test(err.message))
      toast.error(
        networkDown
          ? '网络连接失败，请检查网络后重试'
          : err instanceof Error
            ? err.message
            : '文件解析失败，请重试',
        { id: toastId },
      )
    } finally {
      setOcrLoading(null)
    }
  }

  const handleEntry = (key: EntryKey) => {
    if (key === 'camera') {
      setCameraOpen(true)
      return
    }
    if (key === 'image') {
      setImageEditorOpen(true)
      return
    }
    if (key === 'paste') {
      startInput('paste')
      return
    }
    // file is handled by hidden input below
    const el = document.getElementById('import-file-input') as HTMLInputElement | null
    el?.click()
  }

  const handleAiTitle = async () => {
    if (!text.trim()) {
      toast.error('请先输入内容')
      return
    }
    setAiLoading(true)
    try {
      const res = await fetch('/api/title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '生成失败')
      }
      const data = (await res.json()) as { title?: string }
      if (data.title) {
        setTitle(data.title)
        toast.success('已生成标题：' + data.title)
      } else {
        toast.warning('AI 未返回标题')
      }
    } catch (err) {
      toast.error('生成标题失败：' + (err instanceof Error ? err.message : '未知错误'))
    } finally {
      setAiLoading(false)
    }
  }

  const handleConfirm = () => {
    if (!text.trim()) {
      toast.error('内容不能为空')
      return
    }
    onImport({
      title: title.trim() || '未命名背诵',
      content: text.trim(),
      keywords: [],
    })
  }

  const handleClose = () => {
    onOpenChange(false)
    onCancel?.()
  }

  return (
    <>
      <BottomSheet open={open} onOpenChange={onOpenChange} title={editing ? '编辑内容' : '导入内容'}>
        {mode === 'choose' ? (
          <div className="flex flex-col gap-6 px-2 pb-2 pt-6">
            {/* 4 circle entries */}
            <div className="grid grid-cols-4 gap-2">
              {IMPORT_ENTRIES.map((entry) => {
                const Icon = entry.icon
                const busy = ocrLoading === entry.key
                return (
                  <button
                    key={entry.key}
                    type="button"
                    onClick={() => handleEntry(entry.key)}
                    disabled={!!ocrLoading}
                    className="flex flex-col items-center gap-2 rounded-2xl py-1 transition-colors hover:bg-accent/60"
                  >
                    <span className="flex size-16 items-center justify-center rounded-full bg-muted/70 transition-colors hover:bg-muted">
                      {busy ? (
                        <Loader2 className="size-6 animate-spin text-muted-foreground" strokeWidth={1.5} />
                      ) : (
                        <Icon className="size-6 text-foreground/80" strokeWidth={1.5} />
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">{entry.label}</span>
                  </button>
                )
              })}
            </div>

            {/* hidden inputs */}
            <input
              id="import-file-input"
              type="file"
              accept=".pdf,.docx,.txt,.md,.markdown,text/*,application/pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void handleTextFile(f)
                e.target.value = ''
              }}
            />

            {/* black pill button */}
            <Button
              onClick={() => {
                // 直接输入 → 超级编辑器；未提供回调时回退到本面板输入
                if (onDirectEdit) {
                  onOpenChange(false)
                  onDirectEdit()
                  return
                }
                startInput('paste')
              }}
              className="mt-2 h-12 w-full rounded-full bg-primary text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              <SquarePen className="size-4" strokeWidth={1.75} />
              {editing ? '编辑背诵内容' : '直接输入内容'}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4 px-1 pb-2 pt-5">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="输入或粘贴你要背诵的内容…"
              // 大段粘贴也可在框内滚动（max-h + overflow），不会撑爆面板
              className="max-h-[46vh] min-h-[180px] resize-none overflow-y-auto rounded-2xl border-border bg-muted/30 text-base leading-relaxed focus-visible:ring-1"
              autoFocus
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{text.length} 字</span>
              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-full border-emerald-600/40 text-xs text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-700"
                onClick={() => void handleAiTitle()}
                disabled={aiLoading || !text.trim()}
              >
                {aiLoading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Sparkles className="size-3.5" strokeWidth={1.75} />
                )}
                AI生成标题
              </Button>
            </div>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="标题（可留空自动命名为 未命名背诵）"
              className="h-11 rounded-full border-border bg-muted/30 px-4"
            />
            <div className="mt-1 flex items-center gap-2">
              <Button
                variant="ghost"
                className={cn(
                  'h-12 flex-1 rounded-full text-muted-foreground hover:bg-muted',
                  !editing && 'hidden',
                )}
                onClick={handleClose}
              >
                取消
              </Button>
              <Button
                onClick={handleConfirm}
                className={cn(
                  'h-12 rounded-full bg-primary text-sm font-semibold text-primary-foreground hover:bg-primary/90',
                  editing ? 'flex-[2]' : 'w-full',
                )}
              >
                {editing ? '保存修改' : '开始背诵'}
              </Button>
            </div>
          </div>
        )}
      </BottomSheet>

      <CameraCapture
        open={cameraOpen}
        onOpenChange={setCameraOpen}
        onText={(text) => startInput('camera', text)}
      />

      <ImageOcrEditor
        open={imageEditorOpen}
        onOpenChange={setImageEditorOpen}
        onText={(merged) => startInput('image', merged)}
      />
    </>
  )
}
