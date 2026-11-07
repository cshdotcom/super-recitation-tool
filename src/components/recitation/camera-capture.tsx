'use client'

// 浏览器相机 — 完整版拍照识别:
//   • 连拍多页 (已拍 N 徽标 + 缩略图条，跨页按顺序合并识别)
//   • 拍照放大缩小 (数字变焦 1x-3x，预览与成片同步裁心)
//   • 每张照片可裁剪 (自由拉升裁剪框 / 预设比例) 后再识别
//   • 相册导入 · 前后摄像头翻转 · 重拍 · 识别文字 / 识别全部并合并
//
// Backend contract: POST /api/ocr (multipart file | JSON {image, crop?}).

import * as React from 'react'
import Cropper, { type Area } from 'react-easy-crop'
import {
  Camera,
  Crop as CropIcon,
  Images,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  RefreshCcw,
  ScanText,
  SquareStack,
  SwitchCamera,
  Trash2,
  X,
  ZoomIn,
} from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'

interface CameraCaptureProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with recognized text after a successful OCR (merged when multi-page). */
  onText: (text: string) => void
}

interface CropBox {
  x: number
  y: number
  width: number
  height: number
}

interface PhotoItem {
  id: string
  dataUrl: string
  // Digital zoom used when this photo was shot (already baked into dataUrl).
  zoom: number
  // Cropper state (live editing).
  crop: { x: number; y: number }
  zoomCrop: number
  cropPixels: CropBox | null
}

type ViewMode = 'camera' | 'crop'

const ASPECT_PRESETS = [
  { label: '自由', value: undefined as number | undefined },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '16:9', value: 16 / 9 },
] as const

const MAX_ZOOM = 3
let _idCounter = 0
const nextId = () => `ph-${Date.now().toString(36)}-${(_idCounter++).toString(36)}`

export function CameraCapture({ open, onOpenChange, onText }: CameraCaptureProps) {
  const videoRef = React.useRef<HTMLVideoElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const streamRef = React.useRef<MediaStream | null>(null)

  const [facing, setFacing] = React.useState<'environment' | 'user'>('environment')
  const [permissionError, setPermissionError] = React.useState(false)
  const [photos, setPhotos] = React.useState<PhotoItem[]>([])
  const [currentId, setCurrentId] = React.useState<string | null>(null)
  const [ocrLoading, setOcrLoading] = React.useState(false)
  const [ocrTotal, setOcrTotal] = React.useState(0)

  // camera digital zoom (preview + capture)
  const [zoom, setZoom] = React.useState(1)
  // crop mode / aspect for the crop editor
  const [viewMode, setViewMode] = React.useState<ViewMode>('camera')
  const [aspect, setAspect] = React.useState<number | undefined>(undefined)

  const current = photos.find((p) => p.id === currentId) ?? null

  const updatePhoto = (id: string, patch: Partial<PhotoItem>) => {
    setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  const stopStream = React.useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [])

  const startStream = React.useCallback(
    async (mode: 'environment' | 'user') => {
      stopStream()
      setPermissionError(false)
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: mode, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        })
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          void videoRef.current.play().catch(() => {})
        }
      } catch (err) {
        if (
          err instanceof DOMException &&
          (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
        ) {
          toast.error('未授予相机权限，可从相册选择图片识别')
        } else {
          toast.error('无法访问相机，可从相册选择图片识别')
        }
        setPermissionError(true)
      }
    },
    [stopStream],
  )

  React.useEffect(() => {
    if (open) {
      setPhotos([])
      setCurrentId(null)
      setZoom(1)
      setViewMode('camera')
      setAspect(undefined)
      void startStream(facing)
    } else {
      stopStream()
    }
    return () => {
      stopStream()
    }
  }, [open])

  const toggleCamera = () => {
    const next = facing === 'environment' ? 'user' : 'environment'
    setFacing(next)
    setZoom(1)
    void startStream(next)
  }

  // Capture the current frame; apply digital zoom by cropping the center
  // region (1/zoom of each dimension) so the saved photo matches the preview.
  const handleShutter = () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas || video.readyState < 2) return
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0, w, h)
    const full = canvas.toDataURL('image/jpeg', 0.92)

    const z = Math.max(1, zoom)
    let dataUrl = full
    if (z > 1.01) {
      const cw = Math.round(w / z)
      const ch = Math.round(h / z)
      const cx = Math.round((w - cw) / 2)
      const cy = Math.round((h - ch) / 2)
      const zoomCanvas = document.createElement('canvas')
      zoomCanvas.width = cw
      zoomCanvas.height = ch
      const zctx = zoomCanvas.getContext('2d')
      if (zctx) {
        zctx.drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch)
        dataUrl = zoomCanvas.toDataURL('image/jpeg', 0.92)
      }
    }

    const item: PhotoItem = {
      id: nextId(),
      dataUrl,
      zoom: z,
      crop: { x: 0, y: 0 },
      zoomCrop: 1,
      cropPixels: null,
    }
    setPhotos((prev) => [...prev, item])
    setCurrentId(item.id)
    setViewMode('camera')
  }

  const handlePickFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      const item: PhotoItem = {
        id: nextId(),
        dataUrl: String(reader.result),
        zoom: 1,
        crop: { x: 0, y: 0 },
        zoomCrop: 1,
        cropPixels: null,
      }
      setPhotos((prev) => [...prev, item])
      setCurrentId(item.id)
      setViewMode('camera')
    }
    reader.readAsDataURL(file)
  }

  const removePhoto = (id: string) => {
    setPhotos((prev) => {
      const next = prev.filter((p) => p.id !== id)
      if (currentId === id) {
        const fallback = next[next.length - 1] ?? null
        setCurrentId(fallback ? fallback.id : null)
      }
      return next
    })
  }

  const retake = () => {
    if (current) {
      removePhoto(current.id)
    }
    setViewMode('camera')
  }

  // ---------- OCR ----------
  const recognizeOne = async (photo: PhotoItem): Promise<string> => {
    const body: { image: string; crop?: CropBox } = { image: photo.dataUrl }
    if (viewMode === 'camera' && photo.cropPixels) body.crop = photo.cropPixels
    const res = await fetch('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || '识别失败')
    }
    const data = (await res.json()) as { text?: string }
    return (data.text || '').trim()
  }

  const handleRecognizeCurrent = async () => {
    if (!current) return
    setOcrLoading(true)
    setOcrTotal(1)
    const tid = toast.loading('正在识别图片文字…')
    try {
      const text = await recognizeOne(current)
      if (!text) {
        toast.warning('未识别到文字，请换一张更清晰的照片或调整裁剪', { id: tid })
        return
      }
      toast.success(`识别到 ${text.length} 字`, { id: tid })
      onOpenChange(false)
      onText(text)
    } catch (err) {
      toast.error('识别失败：' + (err instanceof Error ? err.message : '未知错误'), { id: tid })
    } finally {
      setOcrLoading(false)
      setOcrTotal(0)
    }
  }

  const handleRecognizeAll = async () => {
    if (photos.length === 0) return
    setOcrLoading(true)
    setOcrTotal(photos.length)
    const tid = toast.loading(`正在识别 0/${photos.length} 页…`)
    const parts: string[] = []
    try {
      for (let i = 0; i < photos.length; i++) {
        toast.loading(`正在识别 ${i + 1}/${photos.length} 页…`, { id: tid })
        try {
          const text = await recognizeOne(photos[i])
          if (text) parts.push(text)
        } catch (err) {
          toast.error(
            `第 ${i + 1} 页识别失败：${err instanceof Error ? err.message : '未知错误'}`,
            { id: tid },
          )
        }
      }
      const merged = parts.join('\n\n').trim()
      if (!merged) {
        toast.warning('未识别到文字，请调整照片或裁剪后重试', { id: tid })
        return
      }
      toast.success(`已合并 ${parts.length} 页，共 ${merged.length} 字`, { id: tid })
      onOpenChange(false)
      onText(merged)
    } finally {
      setOcrLoading(false)
      setOcrTotal(0)
    }
  }

  const inCropMode = viewMode === 'crop' && !!current

  return (
    <Dialog open={open} onOpenChange={(o) => !ocrLoading && onOpenChange(o)}>
      <DialogContent
        className="max-h-[94vh] overflow-y-auto border-none bg-black p-0 text-white sm:max-w-md [&>button]:hidden"
        aria-describedby={undefined}
      >
        <div className="flex min-h-[540px] flex-col">
          {/* header */}
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Camera className="size-4" strokeWidth={1.75} />
              浏览器相机
            </div>
            <div className="flex items-center gap-2">
              {photos.length > 0 && (
                <span className="rounded-full bg-emerald-600 px-2.5 py-0.5 text-xs font-semibold">
                  已拍 {photos.length}
                </span>
              )}
              <button
                type="button"
                aria-label="关闭相机"
                onClick={() => onOpenChange(false)}
                className="flex size-7 items-center justify-center rounded-full bg-white/10 transition-colors hover:bg-white/20"
              >
                <X className="size-4" strokeWidth={1.75} />
              </button>
            </div>
          </div>

          {/* preview / crop area */}
          <div className="relative mx-4 flex h-[46vh] min-h-[300px] flex-1 items-center justify-center overflow-hidden rounded-2xl bg-zinc-900">
            {inCropMode && current ? (
              <>
                <Cropper
                  image={current.dataUrl}
                  crop={current.crop}
                  zoom={current.zoomCrop}
                  aspect={aspect}
                  restrictPosition={false}
                  showGrid
                  onCropChange={(c) => updatePhoto(current.id, { crop: c })}
                  onZoomChange={(z) => updatePhoto(current.id, { zoomCrop: z })}
                  onCropComplete={(_a, px) =>
                    updatePhoto(current.id, {
                      cropPixels: px
                        ? { x: px.x, y: px.y, width: px.width, height: px.height }
                        : null,
                    })
                  }
                />
                {/* aspect presets overlay */}
                <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-1 bg-gradient-to-b from-black/60 to-transparent px-3 py-2">
                  {ASPECT_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => setAspect(p.value)}
                      className={cn(
                        'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                        aspect === p.value
                          ? 'bg-emerald-600 text-white'
                          : 'bg-white/10 text-zinc-200 hover:bg-white/20',
                      )}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <div className="absolute inset-x-0 bottom-0 z-10 flex items-center gap-2 bg-gradient-to-t from-black/60 to-transparent px-4 py-2">
                  <ZoomIn className="size-4 shrink-0 text-zinc-300" strokeWidth={1.75} />
                  <Slider
                    min={1}
                    max={3}
                    step={0.05}
                    value={[current.zoomCrop]}
                    onValueChange={(v) => updatePhoto(current.id, { zoomCrop: v[0] ?? 1 })}
                    className="flex-1"
                  />
                  <span className="w-9 text-right text-xs tabular-nums text-zinc-300">
                    {current.zoomCrop.toFixed(1)}x
                  </span>
                </div>
              </>
            ) : current ? (
              <img
                src={current.dataUrl}
                alt="已拍摄的照片"
                className="max-h-full w-full object-contain"
              />
            ) : (
              <video
                ref={videoRef}
                playsInline
                muted
                style={{ transform: `scale(${zoom})`, transition: 'transform 150ms ease' }}
                className={cn('h-full w-full object-cover', permissionError && 'hidden')}
              />
            )}

            {permissionError && !current && (
              <div className="flex flex-col items-center gap-3 px-6 py-12 text-center text-sm text-zinc-400">
                <Camera className="size-10 text-zinc-600" strokeWidth={1.25} />
                相机不可用，请从相册选择图片识别
              </div>
            )}

            {/* camera zoom controls */}
            {!current && !inCropMode && !permissionError && (
              <div className="absolute right-3 top-3 z-10 flex flex-col items-center gap-1.5">
                <button
                  type="button"
                  aria-label="放大"
                  onClick={() => setZoom((z) => Math.min(MAX_ZOOM, Math.round((z + 0.5) * 2) / 2))}
                  className="flex size-9 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur transition-colors hover:bg-black/70 disabled:opacity-30"
                  disabled={zoom >= MAX_ZOOM}
                >
                  <Plus className="size-4" strokeWidth={2} />
                </button>
                <span className="rounded-full bg-black/50 px-2 py-0.5 text-[11px] font-semibold tabular-nums backdrop-blur">
                  {zoom.toFixed(1)}x
                </span>
                <button
                  type="button"
                  aria-label="缩小"
                  onClick={() => setZoom((z) => Math.max(1, Math.round((z - 0.5) * 2) / 2))}
                  className="flex size-9 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur transition-colors hover:bg-black/70 disabled:opacity-30"
                  disabled={zoom <= 1}
                >
                  <Minus className="size-4" strokeWidth={2} />
                </button>
              </div>
            )}

            {/* crop confirm bar over photo */}
            {inCropMode && current && (
              <div className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-between bg-gradient-to-t from-black/70 to-transparent px-4 pb-3 pt-8">
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-full bg-white/10 text-white hover:bg-white/20 hover:text-white"
                  onClick={() => {
                    updatePhoto(current.id, { cropPixels: null, crop: { x: 0, y: 0 }, zoomCrop: 1 })
                    setViewMode('camera')
                  }}
                >
                  取消
                </Button>
                <span className="text-xs text-zinc-300">
                  {current.cropPixels
                    ? `已选 ${Math.round(current.cropPixels.width)}×${Math.round(current.cropPixels.height)}`
                    : '拖动/拉伸选框选择识别区域'}
                </span>
                <Button
                  size="sm"
                  className="h-9 rounded-full bg-emerald-600 px-4 text-white hover:bg-emerald-700"
                  onClick={() => setViewMode('camera')}
                >
                  <CropIcon className="size-3.5" strokeWidth={1.75} />
                  完成裁剪
                </Button>
              </div>
            )}
          </div>

          {/* thumbnail strip (多页跨页) */}
          {photos.length > 0 && (
            <div className="flex items-center gap-2 overflow-x-auto px-4 py-2">
              {photos.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setCurrentId(p.id)
                    setViewMode('camera')
                  }}
                  className={cn(
                    'relative size-14 shrink-0 overflow-hidden rounded-xl border-2 transition-colors',
                    p.id === currentId ? 'border-emerald-500' : 'border-white/10 hover:border-white/30',
                  )}
                  aria-label={`第 ${i + 1} 页`}
                >
                  <img src={p.dataUrl} alt={`第 ${i + 1} 页`} className="size-full object-cover" />
                  <span className="absolute left-0.5 top-0.5 flex size-4 items-center justify-center rounded-full bg-black/70 text-[10px] font-bold">
                    {i + 1}
                  </span>
                  {p.cropPixels && (
                    <span className="absolute bottom-0.5 right-0.5 flex size-3.5 items-center justify-center rounded-full bg-emerald-600">
                      <CropIcon className="size-2.5" strokeWidth={2.5} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* controls */}
          <div className="flex items-center justify-between px-6 py-4">
            {/* gallery picker */}
            <label
              className={cn(
                'flex size-11 cursor-pointer items-center justify-center rounded-full bg-white/10 transition-colors hover:bg-white/20',
                inCropMode && 'pointer-events-none opacity-30',
              )}
              aria-label="从相册选择"
            >
              <Images className="size-5" strokeWidth={1.75} />
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) handlePickFile(f)
                  e.target.value = ''
                }}
              />
            </label>

            {inCropMode ? (
              <span className="text-xs text-zinc-400">裁剪模式</span>
            ) : current ? (
              <div className="flex flex-col items-center gap-2">
                <div className="flex items-center gap-2">
                  {photos.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="rounded-full bg-white/10 text-white hover:bg-white/20 hover:text-white"
                      onClick={() => void handleRecognizeAll()}
                      disabled={ocrLoading}
                    >
                      {ocrLoading && ocrTotal > 1 ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <SquareStack className="size-4" strokeWidth={1.75} />
                      )}
                      识别全部
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="rounded-full bg-white/10 text-white hover:bg-white/20 hover:text-white"
                    onClick={retake}
                    disabled={ocrLoading}
                  >
                    <RefreshCcw className="size-4" strokeWidth={1.75} />
                    重拍
                  </Button>
                  <Button
                    size="sm"
                    className="h-11 rounded-full bg-emerald-600 px-5 text-white hover:bg-emerald-700"
                    onClick={() => void handleRecognizeCurrent()}
                    disabled={ocrLoading}
                  >
                    {ocrLoading && ocrTotal <= 1 ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ScanText className="size-4" strokeWidth={1.75} />
                    )}
                    识别文字
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label="裁剪此照片"
                    onClick={() => {
                      setViewMode('crop')
                      setAspect(current.cropPixels ? aspect : undefined)
                    }}
                    className="flex items-center gap-1 rounded-full bg-white/10 px-3 py-1 text-[11px] text-zinc-200 transition-colors hover:bg-white/20"
                  >
                    <CropIcon className="size-3" strokeWidth={1.75} />
                    裁剪
                  </button>
                  {current.cropPixels && (
                    <span className="text-[11px] text-emerald-400">已裁剪 · 识别时生效</span>
                  )}
                  <button
                    type="button"
                    aria-label="删除此照片"
                    onClick={() => removePhoto(current.id)}
                    className="flex size-6 items-center justify-center rounded-full bg-white/10 text-zinc-300 transition-colors hover:bg-red-500/20 hover:text-red-400"
                  >
                    <Trash2 className="size-3" strokeWidth={1.75} />
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                aria-label="拍照"
                onClick={handleShutter}
                disabled={permissionError}
                className={cn(
                  'flex size-16 items-center justify-center rounded-full border-4 border-white bg-white/90 transition-transform active:scale-90',
                  permissionError && 'opacity-30',
                )}
              >
                <span className="size-11 rounded-full bg-white" />
              </button>
            )}

            {/* flip camera */}
            <button
              type="button"
              aria-label="切换前后摄像头"
              onClick={toggleCamera}
              disabled={inCropMode || (!!current && viewMode === 'camera') || permissionError}
              className={cn(
                'flex size-11 items-center justify-center rounded-full bg-white/10 transition-colors hover:bg-white/20',
                (inCropMode || (!!current && viewMode === 'camera') || permissionError) && 'opacity-30',
              )}
            >
              <SwitchCamera className="size-5" strokeWidth={1.75} />
            </button>
          </div>

          <div className="px-4 pb-3 text-center text-[11px] text-zinc-500">
            {current
              ? '可裁剪、缩放、重拍；多页将按顺序合并识别'
              : '拍照后可裁剪/缩放；支持多页跨页连续拍摄'}
          </div>
        </div>

        <canvas ref={canvasRef} className="hidden" aria-hidden />
        <DialogTitle className="sr-only">浏览器相机</DialogTitle>
      </DialogContent>
    </Dialog>
  )
}
