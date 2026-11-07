'use client'

// Multi-image OCR editor: add several photos (cross-page / 多张合并), zoom &
// crop each one (放大缩小 + 裁剪工具), then recognize them in order and merge
// the recognized text into a single draft.
//
// Backend contract:
//   POST /api/ocr  (application/json)
//   { image: dataURI, crop?: { x, y, width, height } }
// → { text: string }
// When `crop` is omitted the full image is recognized.

import * as React from 'react'
import Cropper, { type Area } from 'react-easy-crop'
import {
  Crop as CropIcon,
  ImagePlus,
  Loader2,
  Maximize2,
  ScanText,
  Trash2,
  X,
  ZoomIn,
} from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'

interface ImageOcrEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the merged text from all images (in order). */
  onText: (text: string) => void
}

interface CropBox {
  x: number
  y: number
  width: number
  height: number
}

interface ImageItem {
  id: string
  dataUrl: string
  name: string
  // react-easy-crop controlled state (pan position + zoom).
  crop: { x: number; y: number }
  zoom: number
  // Pixel crop region on the natural image, captured on cropComplete.
  cropPixels: CropBox | null
}

type CropMode = 'full' | 'crop'

const ASPECT_PRESETS = [
  { label: '自由', value: undefined as number | undefined },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '16:9', value: 16 / 9 },
] as const

let _idCounter = 0
const nextId = () => `img-${Date.now().toString(36)}-${(_idCounter++).toString(36)}`

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function ImageOcrEditor({ open, onOpenChange, onText }: ImageOcrEditorProps) {
  const [images, setImages] = React.useState<ImageItem[]>([])
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const [mode, setMode] = React.useState<CropMode>('crop')
  const [aspect, setAspect] = React.useState<number | undefined>(4 / 3)
  const [recognizing, setRecognizing] = React.useState(false)
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(null)

  const fileInputRef = React.useRef<HTMLInputElement>(null)

  // Reset everything when reopened.
  React.useEffect(() => {
    if (open) {
      setImages([])
      setActiveId(null)
      setMode('crop')
      setAspect(4 / 3)
      setRecognizing(false)
      setProgress(null)
    }
  }, [open])

  const activeIndex = images.findIndex((i) => i.id === activeId)
  const active = activeIndex >= 0 ? images[activeIndex] : null

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (!list.length) {
      toast.warning('请选择图片文件')
      return
    }
    const items: ImageItem[] = []
    for (const file of list) {
      try {
        const dataUrl = await readFileAsDataURL(file)
        items.push({
          id: nextId(),
          dataUrl,
          name: file.name || '图片',
          crop: { x: 0, y: 0 },
          zoom: 1,
          cropPixels: null,
        })
      } catch {
        toast.error(`读取 ${file.name} 失败`)
      }
    }
    if (!items.length) return
    setImages((prev) => {
      const next = [...prev, ...items]
      return next
    })
    if (!activeId) setActiveId(items[0].id)
    toast.success(`已添加 ${items.length} 张图片`)
  }

  const updateActive = (patch: Partial<ImageItem>) => {
    if (!activeId) return
    setImages((prev) =>
      prev.map((i) => (i.id === activeId ? { ...i, ...patch } : i)),
    )
  }

  const handleCropChange = (crop: { x: number; y: number }) => updateActive({ crop })
  const handleZoomChange = (zoom: number) => updateActive({ zoom })
  const handleCropComplete = (_area: Area, areaPixels: Area) => {
    updateActive({
      cropPixels: {
        x: areaPixels.x,
        y: areaPixels.y,
        width: areaPixels.width,
        height: areaPixels.height,
      },
    })
  }

  const removeActive = () => {
    if (!activeId) return
    setImages((prev) => {
      const idx = prev.findIndex((i) => i.id === activeId)
      if (idx < 0) return prev
      const next = prev.filter((i) => i.id !== activeId)
      const newActive = next[idx] ?? next[idx - 1] ?? next[0] ?? null
      setActiveId(newActive ? newActive.id : null)
      return next
    })
  }

  const moveActive = (dir: -1 | 1) => {
    if (!activeId) return
    setImages((prev) => {
      const idx = prev.findIndex((i) => i.id === activeId)
      const target = idx + dir
      if (idx < 0 || target < 0 || target >= prev.length) return prev
      const next = [...prev]
      ;[next[idx], next[target]] = [next[target], next[idx]]
      return next
    })
  }

  const resetCrop = () => updateActive({ crop: { x: 0, y: 0 }, zoom: 1, cropPixels: null })

  const recognizeAll = async () => {
    if (!images.length) {
      toast.error('请先添加图片')
      return
    }
    setRecognizing(true)
    const tid = toast.loading('正在识别图片文字…')
    const parts: string[] = []
    try {
      for (let i = 0; i < images.length; i++) {
        const img = images[i]
        setProgress({ done: i, total: images.length })
        toast.loading(`识别中 ${i + 1}/${images.length}…`, { id: tid })
        try {
          const body: { image: string; crop?: CropBox } = { image: img.dataUrl }
          if (mode === 'crop' && img.cropPixels) {
            body.crop = img.cropPixels
          }
          const res = await fetch('/api/ocr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          if (!res.ok) {
            const err = await res.json().catch(() => ({}))
            throw new Error(err.error || `第 ${i + 1} 张识别失败`)
          }
          const data = (await res.json()) as { text?: string }
          const text = (data.text || '').trim()
          if (text) parts.push(text)
        } catch (err) {
          toast.error(
            `第 ${i + 1} 张识别失败：${err instanceof Error ? err.message : '未知错误'}`,
            { id: tid },
          )
        }
      }
      const merged = parts.join('\n\n').trim()
      if (!merged) {
        toast.warning('未识别到文字，请调整裁剪区域后重试', { id: tid })
        return
      }
      toast.success(`已合并 ${parts.length} 张，共 ${merged.length} 字`, { id: tid })
      onOpenChange(false)
      onText(merged)
    } finally {
      setRecognizing(false)
      setProgress(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !recognizing && onOpenChange(o)}>
      <DialogContent
        className="flex max-h-[96vh] w-full max-w-2xl flex-col gap-0 overflow-hidden rounded-2xl border-border bg-background p-0 [&>button]:hidden"
        aria-describedby={undefined}
      >
        {/* header */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ImagePlus className="size-4" strokeWidth={1.75} />
            图片识别 · 多张合并
          </div>
          <div className="flex items-center gap-2">
            {images.length > 0 && (
              <span className="rounded-full bg-emerald-600/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                {images.length} 张
              </span>
            )}
            <button
              type="button"
              aria-label="关闭"
              onClick={() => onOpenChange(false)}
              disabled={recognizing}
              className="flex size-7 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            >
              <X className="size-4" strokeWidth={1.75} />
            </button>
          </div>
        </div>

        {images.length === 0 ? (
          /* ---------- empty state / dropzone ---------- */
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-12 text-center">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full max-w-sm flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-border bg-muted/30 px-6 py-10 transition-colors hover:border-emerald-500/50 hover:bg-emerald-500/5"
            >
              <span className="flex size-14 items-center justify-center rounded-full bg-background shadow-sm">
                <ImagePlus className="size-6 text-emerald-600" strokeWidth={1.75} />
              </span>
              <span className="text-sm font-semibold">添加图片</span>
              <span className="text-xs text-muted-foreground">
                支持多张同时选择 · 可放大缩小 · 可裁剪 · 跨页自动合并
              </span>
            </button>
          </div>
        ) : (
          <>
            {/* ---------- toolbar for active image ---------- */}
            <div className="flex items-center gap-1 border-b px-3 py-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 rounded-full px-3 text-xs"
                onClick={() => moveActive(-1)}
                disabled={recognizing || activeIndex <= 0}
              >
                上移
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 rounded-full px-3 text-xs"
                onClick={() => moveActive(1)}
                disabled={recognizing || activeIndex < 0 || activeIndex >= images.length - 1}
              >
                下移
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 rounded-full px-3 text-xs"
                onClick={resetCrop}
                disabled={recognizing || mode !== 'crop'}
              >
                重置裁剪
              </Button>
              <div className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-full px-3 text-xs text-red-600 hover:bg-red-500/10 hover:text-red-700"
                  onClick={removeActive}
                  disabled={recognizing}
                >
                  <Trash2 className="size-3.5" strokeWidth={1.75} />
                  删除
                </Button>
              </div>
            </div>

            {/* ---------- crop / preview area ---------- */}
            <div className="relative flex h-[44vh] min-h-[260px] items-center justify-center overflow-hidden bg-black">
              {active && mode === 'crop' ? (
                <Cropper
                  image={active.dataUrl}
                  crop={active.crop}
                  zoom={active.zoom}
                  aspect={aspect}
                  onCropChange={handleCropChange}
                  onZoomChange={handleZoomChange}
                  onCropComplete={handleCropComplete}
                  restrictPosition={false}
                  showGrid
                />
              ) : active ? (
                <img
                  src={active.dataUrl}
                  alt={active.name}
                  className="max-h-full max-w-full object-contain"
                />
              ) : null}
            </div>

            {/* ---------- mode + aspect + zoom controls ---------- */}
            <div className="flex flex-col gap-2 border-b px-4 py-3">
              {/* mode switch */}
              <div className="flex items-center gap-2">
                <div className="flex rounded-full bg-muted p-0.5">
                  <button
                    type="button"
                    onClick={() => setMode('crop')}
                    disabled={recognizing}
                    className={cn(
                      'flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition-colors',
                      mode === 'crop' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
                    )}
                  >
                    <CropIcon className="size-3.5" strokeWidth={1.75} />
                    裁剪
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('full')}
                    disabled={recognizing}
                    className={cn(
                      'flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition-colors',
                      mode === 'full' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
                    )}
                  >
                    <Maximize2 className="size-3.5" strokeWidth={1.75} />
                    整图
                  </button>
                </div>

                {mode === 'crop' && (
                  <div className="flex items-center gap-1">
                    {ASPECT_PRESETS.map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        onClick={() => setAspect(p.value)}
                        disabled={recognizing}
                        className={cn(
                          'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                          aspect === p.value
                            ? 'bg-emerald-600/10 text-emerald-700'
                            : 'text-muted-foreground hover:bg-muted',
                        )}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* zoom slider */}
              {mode === 'crop' && active && (
                <div className="flex items-center gap-2">
                  <ZoomIn className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <Slider
                    min={1}
                    max={3}
                    step={0.05}
                    value={[active.zoom]}
                    onValueChange={(v) => handleZoomChange(v[0] ?? 1)}
                    disabled={recognizing}
                    className="flex-1"
                  />
                  <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {active.zoom.toFixed(1)}x
                  </span>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">
                {mode === 'crop'
                  ? '拖动图片调整位置 · 滑块或双指缩放 · 框内即为裁剪识别区域'
                  : '整图模式：识别完整图片，不裁剪'}
              </p>
            </div>

            {/* ---------- thumbnail strip ---------- */}
            <div className="flex items-center gap-2 overflow-x-auto border-b px-3 py-2">
              {images.map((img, i) => (
                <button
                  key={img.id}
                  type="button"
                  onClick={() => setActiveId(img.id)}
                  disabled={recognizing}
                  className={cn(
                    'relative size-16 shrink-0 overflow-hidden rounded-xl border-2 transition-colors',
                    img.id === activeId
                      ? 'border-emerald-500'
                      : 'border-transparent hover:border-border',
                  )}
                >
                  <img
                    src={img.dataUrl}
                    alt={img.name}
                    className="size-full object-cover"
                  />
                  <span className="absolute left-1 top-1 flex size-4 items-center justify-center rounded-full bg-black/70 text-[10px] font-bold text-white">
                    {i + 1}
                  </span>
                  {mode === 'crop' && img.cropPixels && (
                    <span className="absolute bottom-1 right-1 flex size-3.5 items-center justify-center rounded-full bg-emerald-600">
                      <CropIcon className="size-2.5 text-white" strokeWidth={2.5} />
                    </span>
                  )}
                </button>
              ))}
              {/* add tile */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={recognizing}
                className="flex size-16 shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl border-2 border-dashed border-border text-muted-foreground transition-colors hover:border-emerald-500/50 hover:text-emerald-600"
              >
                <ImagePlus className="size-5" strokeWidth={1.75} />
                <span className="text-[10px]">添加</span>
              </button>
            </div>
          </>
        )}

        {/* ---------- footer ---------- */}
        <div className="flex items-center gap-2 px-4 py-3">
          <div className="flex-1 text-xs text-muted-foreground">
            {recognizing && progress
              ? `识别中 ${progress.done + 1}/${progress.total}…`
              : images.length > 0
                ? `共 ${images.length} 张 · 按顺序合并识别`
                : '添加图片后即可识别'}
          </div>
          <Button
            onClick={() => void recognizeAll()}
            disabled={recognizing || images.length === 0}
            className="h-11 rounded-full bg-primary px-6 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            {recognizing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ScanText className="size-4" strokeWidth={1.75} />
            )}
            识别全部并合并
          </Button>
        </div>
      </DialogContent>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) void addFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <DialogTitle className="sr-only">图片识别 多张合并</DialogTitle>
    </Dialog>
  )
}
