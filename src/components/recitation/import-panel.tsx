'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  ClipboardPaste,
  ImageUp,
  FileUp,
  FilePlus2,
  Sparkles,
  Loader2,
  ArrowRight,
  BookOpenText,
} from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export interface ImportPayload {
  title: string
  content: string
  keywords: string[]
}

interface ImportPanelProps {
  initialDraft?: { title: string; content: string } | null
  welcome?: boolean
  onImport: (data: ImportPayload) => void
  onCancel: () => void
}

const METHODS = [
  { key: 'paste', label: '粘贴/输入文本', icon: ClipboardPaste },
  { key: 'image', label: '上传图片识别', icon: ImageUp },
  { key: 'txt', label: '上传 .txt 文件', icon: FileUp },
  { key: 'blank', label: '新建空白', icon: FilePlus2 },
] as const

export function ImportPanel({
  initialDraft,
  welcome,
  onImport,
  onCancel,
}: ImportPanelProps) {
  const [title, setTitle] = React.useState(initialDraft?.title ?? '')
  const [content, setContent] = React.useState(initialDraft?.content ?? '')
  const [activeMethod, setActiveMethod] =
    React.useState<(typeof METHODS)[number]['key']>('paste')
  const [ocrLoading, setOcrLoading] = React.useState(false)
  const [titleLoading, setTitleLoading] = React.useState(false)

  const imageInputRef = React.useRef<HTMLInputElement>(null)
  const txtInputRef = React.useRef<HTMLInputElement>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)

  React.useEffect(() => {
    if (initialDraft) {
      setTitle(initialDraft.title)
      setContent(initialDraft.content)
    }
  }, [initialDraft])

  const pickImage = () => {
    setActiveMethod('image')
    imageInputRef.current?.click()
  }

  const pickTxt = () => {
    setActiveMethod('txt')
    txtInputRef.current?.click()
  }

  const focusPaste = () => {
    setActiveMethod('paste')
    setTimeout(() => textareaRef.current?.focus(), 0)
  }

  const startBlank = () => {
    setActiveMethod('blank')
    setContent('')
    setTitle('')
    setTimeout(() => textareaRef.current?.focus(), 0)
  }

  const handleImageChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.error('请选择图片文件')
      e.target.value = ''
      return
    }
    setOcrLoading(true)
    const tid = toast.loading('正在识别图片内容…')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/ocr', { method: 'POST', body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '识别失败')
      }
      const data = (await res.json()) as { text: string }
      const text = (data.text || '').trim()
      if (!text) {
        toast.warning('未识别到文字内容', { id: tid })
      } else {
        setContent((prev) => (prev ? prev + '\n' + text : text))
        toast.success(`识别完成，共 ${text.length} 字`, { id: tid })
      }
    } catch (err) {
      toast.error(
        '图片识别失败：' + (err instanceof Error ? err.message : '未知错误'),
        { id: tid },
      )
    } finally {
      setOcrLoading(false)
      e.target.value = ''
    }
  }

  const handleTxtChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      setContent((prev) => (prev ? prev + '\n' + text : text))
      toast.success(`已读取 ${text.length} 字`)
    } catch (err) {
      toast.error(
        '读取文件失败：' + (err instanceof Error ? err.message : '未知错误'),
      )
    } finally {
      e.target.value = ''
    }
  }

  const generateTitle = async () => {
    if (!content.trim()) {
      toast.error('请先输入或导入内容')
      return
    }
    setTitleLoading(true)
    try {
      const res = await fetch('/api/title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '生成失败')
      }
      const data = (await res.json()) as { title: string }
      const t = (data.title || '').trim()
      if (t) {
        setTitle(t)
        toast.success('已生成标题')
      } else {
        toast.warning('AI 未返回标题，请手动填写')
      }
    } catch (err) {
      toast.error(
        '生成标题失败：' + (err instanceof Error ? err.message : '未知错误'),
      )
    } finally {
      setTitleLoading(false)
    }
  }

  const canStart = content.trim().length > 0 && !ocrLoading

  const handleStart = () => {
    if (!canStart) {
      toast.error('请先输入或导入内容')
      return
    }
    onImport({
      title: title.trim() || '未命名卡片',
      content: content.trim(),
      keywords: [],
    })
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
    >
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BookOpenText className="size-4 text-emerald-600" />
            {welcome ? '开始你的第一次背诵' : '导入内容'}
          </CardTitle>
          {welcome && (
            <p className="text-sm text-muted-foreground">
              粘贴课文、上传图片识别或导入 .txt
              文件，AI 将帮你挖空、出题、督背、生成思维导图。
            </p>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* Method chips */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {METHODS.map((m) => {
              const Icon = m.icon
              const isActive = activeMethod === m.key
              return (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => {
                    if (m.key === 'paste') focusPaste()
                    else if (m.key === 'image') pickImage()
                    else if (m.key === 'txt') pickTxt()
                    else if (m.key === 'blank') startBlank()
                  }}
                  className={cn(
                    'flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-xs font-medium transition-colors',
                    isActive
                      ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                      : 'hover:bg-accent',
                  )}
                >
                  <Icon className="size-4" />
                  {m.label}
                </button>
              )
            })}
          </div>

          {/* Hidden file inputs */}
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleImageChange}
          />
          <input
            ref={txtInputRef}
            type="file"
            accept=".txt,text/plain"
            className="hidden"
            onChange={handleTxtChange}
          />

          {/* Content textarea */}
          <div className="flex flex-col gap-2">
            <Textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="在此粘贴或输入要背诵的课文内容…"
              className="min-h-[240px] resize-y text-base leading-relaxed"
              disabled={ocrLoading}
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{content.length} 字</span>
              {ocrLoading && (
                <span className="flex items-center gap-1 text-emerald-600">
                  <Loader2 className="size-3 animate-spin" /> 识别中…
                </span>
              )}
            </div>
          </div>

          {/* Title row */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="标题（可选）"
              className="flex-1"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={generateTitle}
              disabled={titleLoading || !content.trim()}
              className="shrink-0 text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-700"
            >
              {titleLoading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              AI 生成标题
            </Button>
          </div>

          {/* Footer actions */}
          <div className="flex items-center justify-between gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              取消
            </Button>
            <Button
              onClick={handleStart}
              disabled={!canStart}
              className="rounded-full px-5"
            >
              开始背诵
              <ArrowRight className="size-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}
