'use client'

// 浏览器相机 — 完整版拍照识别:
//   • 连拍多页 (已拍 N 徽标 + 缩略图条，跨页按顺序合并识别)
//   • 拍照后自动进入裁剪模式：8 把手自由拉升裁剪框 (FreeCropBox)
//     + 九宫格参考线 + 预设比例 (自由/1:1/4:3/3:4/16:9)
//   • 拍照与裁剪均支持滑块 1x–4x 缩放 + 双指捏合
//   • 相册导入 · 前后摄像头翻转 · 重拍(删除当前重进) · 识别全部并合并
//
// Backend contract: POST /api/ocr (multipart file | JSON {image, crop?}).

import * as React from 'react'
import {
  Camera,
  Crop as CropIcon,
  FlipHorizontal,
  FlipVertical,
  Images,
  Loader2,
  RotateCcw,
  RotateCw,
  ScanText,
  Scissors,
  SwitchCamera,
  Trash2,
  X,
  ZoomIn,
} from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { transformImage } from '@/lib/image-transform'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import {
  FreeCropBox,
  MAX_CROP_ZOOM,
  type CropBox,
  type CropOffset,
} from '@/components/recitation/free-crop-box'

interface CameraCaptureProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with recognized text after a successful OCR (merged when multi-page). */
  onText: (text: string) => void
  /**
   * 'ocr'（默认）：识别文字后回调 onText；
   * 'photo'：裁剪后直接把照片 dataURL 回调 onPhoto（编辑器“拍照插入”用）。
   */
  mode?: 'ocr' | 'photo'
  onPhoto?: (dataUrl: string) => void
  /** photo 模式多张回传：连拍多页后一次性返回全部裁剪结果（编辑器批量插图） */
  onPhotos?: (dataUrls: string[]) => void
  /** 独立相机页（新标签页 /?cam=1）：拍完自动回传 opener 并关闭 */
  standalone?: boolean
}

interface PhotoItem {
  id: string
  dataUrl: string
  // Digital zoom used when this photo was shot (already baked into dataUrl).
  zoom: number
  // Crop editor state (FreeCropBox controlled).
  cropZoom: number
  cropOffset: CropOffset
  // Crop region: display coords (frame) + natural pixels (submitted to OCR).
  crop: CropBox | null
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

const MAX_ZOOM = 4
let _idCounter = 0
const nextId = () => `ph-${Date.now().toString(36)}-${(_idCounter++).toString(36)}`

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(1, z))

/** 按原图像素 box 裁出 dataURL（拍照插入用，保留较高质量） */
function cropToDataUrl(
  src: string,
  box: { x: number; y: number; width: number; height: number },
  maxW = 1600,
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
      resolve(canvas.toDataURL('image/jpeg', 0.9))
    }
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = src
  })
}

export function CameraCapture({ open, onOpenChange, onText, mode = 'ocr', onPhoto, onPhotos, standalone = false }: CameraCaptureProps) {
  const videoRef = React.useRef<HTMLVideoElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const streamRef = React.useRef<MediaStream | null>(null)

  const [facing, setFacing] = React.useState<'environment' | 'user'>('environment')
  const [permissionError, setPermissionError] = React.useState(false)
  const [photos, setPhotos] = React.useState<PhotoItem[]>([])
  const [currentId, setCurrentId] = React.useState<string | null>(null)
  const [ocrLoading, setOcrLoading] = React.useState(false)
  const [ocrTotal, setOcrTotal] = React.useState(0)

  // camera digital zoom (preview + capture), slider 1x–4x + 双指
  const [zoom, setZoom] = React.useState(1)
  // crop mode / aspect for the crop editor
  const [viewMode, setViewMode] = React.useState<ViewMode>('camera')
  const [aspect, setAspect] = React.useState<number | undefined>(undefined)
  // 旋转/翻转进行中（裁剪模式工具条按钮禁用 + 转圈）
  const [transforming, setTransforming] = React.useState(false)

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
    async (camFacing: 'environment' | 'user') => {
      stopStream()
      setPermissionError(false)
      // 浏览器/内嵌 iframe 不支持 getUserMedia：toast 提示 + 进入降级面板（预览区会出现"选择图片"降级按钮）
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        toast.error('无法访问摄像头，请检查权限')
        setPermissionError(true)
        return
      }
      try {
        // 真实在线相机：getUserMedia 取流 → <video> 实时取景器（主路径）
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: camFacing, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        })
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          void videoRef.current.play().catch(() => {})
        }
      } catch {
        // 拒绝授权 / 无摄像头 / 被拦截：统一提示，并在预览区提供"选择图片"降级按钮
        toast.error('无法访问摄像头，请检查权限')
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

  // 双指捏合：仅取景器（实时画面）中生效
  const camPointersRef = React.useRef(new Map<number, { x: number; y: number }>())
  const camPinchRef = React.useRef<null | { dist: number; zoom: number }>(null)

  const camPointerDown = (e: React.PointerEvent) => {
    if (viewMode !== 'camera' || current || permissionError) return
    const rect = e.currentTarget.getBoundingClientRect()
    camPointersRef.current.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top })
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // 指针可能已释放，忽略
    }
    if (camPointersRef.current.size === 2) {
      const [a, b] = [...camPointersRef.current.values()]
      camPinchRef.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom }
    }
  }

  const camPointerMove = (e: React.PointerEvent) => {
    if (!camPointersRef.current.has(e.pointerId)) return
    const rect = e.currentTarget.getBoundingClientRect()
    camPointersRef.current.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top })
    const pinch = camPinchRef.current
    if (pinch && camPointersRef.current.size >= 2) {
      const [a, b] = [...camPointersRef.current.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1
      setZoom(clampZoom(pinch.zoom * (dist / pinch.dist)))
    }
  }

  const camPointerEnd = (e: React.PointerEvent) => {
    camPointersRef.current.delete(e.pointerId)
    if (camPointersRef.current.size < 2) camPinchRef.current = null
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
      cropZoom: 1,
      cropOffset: { x: 0, y: 0 },
      crop: null,
      cropPixels: null,
    }
    setPhotos((prev) => [...prev, item])
    setCurrentId(item.id)
    // 拍照后进入裁剪模式
    setViewMode('crop')
  }

  const handlePickFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      const item: PhotoItem = {
        id: nextId(),
        dataUrl: String(reader.result),
        zoom: 1,
        cropZoom: 1,
        cropOffset: { x: 0, y: 0 },
        crop: null,
        cropPixels: null,
      }
      setPhotos((prev) => [...prev, item])
      setCurrentId(item.id)
      setViewMode('crop')
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

  // 完成裁剪：保存 cropPixels，回到取景器拍下一页。
  // ⚠️ 必须清空 currentId —— 否则渲染分支会落到 <img>（已拍照片）而非 <video>，
  // <video> 不挂载 → handleShutter 因 readyState<2 直接 return → 无法再拍照。
  // 清空 currentId 后 <video> 重新挂载，下方 effect 会把流重新绑回 video。
  const finishCrop = () => {
    setCurrentId(null)
    setViewMode('camera')
  }

  // <video> 在 currentId 清空后会重新挂载（渲染分支回到 video），此时 srcObject 已丢失，
  // 需要把仍在运行的 stream 重新绑回去，取景器才能恢复实时画面。
  React.useEffect(() => {
    if (!open || viewMode !== 'camera' || currentId) return
    const v = videoRef.current
    if (v && streamRef.current && v.srcObject !== streamRef.current) {
      v.srcObject = streamRef.current
      void v.play().catch(() => {})
    }
  }, [open, viewMode, currentId])

  // photo 模式：导出当前裁剪结果并回调 onPhoto（独立页时回传 opener 并关闭）
  const exportCurrentPhoto = async () => {
    if (!current) return
    try {
      const out = current.cropPixels
        ? await cropToDataUrl(current.dataUrl, current.cropPixels)
        : current.dataUrl
      if (standalone) {
        try {
          window.opener?.postMessage({ type: 'beishuba-camera-photo', dataUrl: out }, window.location.origin)
        } catch {
          /* opener 不可用时忽略 */
        }
        window.close()
        return
      }
      onPhoto?.(out)
      onOpenChange(false)
    } catch (err) {
      toast.error('导出照片失败：' + (err instanceof Error ? err.message : '未知错误'))
    }
  }

  // photo 模式多张：把已拍全部照片（按裁剪结果）批量导出，回调 onPhotos。
  // 用于编辑器"连拍多张一次插入"——每张照片若已裁剪则按裁剪框出图，否则原图。
  const exportAllPhotos = async () => {
    if (photos.length === 0) return
    const tid = toast.loading(`正在导出 ${photos.length} 张照片…`)
    try {
      const out: string[] = []
      for (let i = 0; i < photos.length; i++) {
        toast.loading(`正在导出 ${i + 1}/${photos.length} 张…`, { id: tid })
        const p = photos[i]
        const url = p.cropPixels ? await cropToDataUrl(p.dataUrl, p.cropPixels) : p.dataUrl
        out.push(url)
      }
      if (standalone) {
        for (const url of out) {
          try {
            window.opener?.postMessage({ type: 'beishuba-camera-photo', dataUrl: url }, window.location.origin)
          } catch {
            /* noop */
          }
        }
        window.close()
        return
      }
      onPhotos?.(out)
      toast.success(`已插入 ${out.length} 张照片`, { id: tid })
      onOpenChange(false)
    } catch (err) {
      toast.error('导出照片失败：' + (err instanceof Error ? err.message : '未知错误'), { id: tid })
    }
  }

  // 取消裁剪：丢弃当前照片的裁剪状态
  const cancelCrop = () => {
    if (current) {
      updatePhoto(current.id, {
        crop: null,
        cropPixels: null,
        cropZoom: 1,
        cropOffset: { x: 0, y: 0 },
      })
    }
    setViewMode('camera')
  }

  // 重拍：删除当前照片，回到取景器
  const retake = () => {
    if (current) removePhoto(current.id)
    setViewMode('camera')
  }

  // 旋转/翻转当前照片：重烘焙 dataURL 后重置裁剪框，让 FreeCropBox 按新图尺寸重新初始化
  const transformCurrent = async (opts: {
    rotate?: number
    flipH?: boolean
    flipV?: boolean
  }) => {
    if (!current || transforming) return
    setTransforming(true)
    try {
      const out = await transformImage(current.dataUrl, opts)
      updatePhoto(current.id, {
        dataUrl: out,
        crop: null,
        cropPixels: null,
        cropZoom: 1,
        cropOffset: { x: 0, y: 0 },
      })
    } catch (err) {
      toast.error('图片变换失败：' + (err instanceof Error ? err.message : '未知错误'))
    } finally {
      setTransforming(false)
    }
  }

  // ---------- OCR ----------
  const recognizeOne = async (photo: PhotoItem): Promise<string> => {
    const body: { image: string; crop?: CropBox } = { image: photo.dataUrl }
    if (photo.cropPixels) body.crop = photo.cropPixels
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
          <div
            className="relative mx-4 flex h-[46vh] min-h-[300px] flex-1 items-center justify-center overflow-hidden rounded-2xl bg-zinc-900"
            onPointerDown={camPointerDown}
            onPointerMove={camPointerMove}
            onPointerUp={camPointerEnd}
            onPointerCancel={camPointerEnd}
          >
            {inCropMode && current ? (
              <FreeCropBox
                key={current.id}
                src={current.dataUrl}
                zoom={current.cropZoom}
                onZoomChange={(z) => updatePhoto(current.id, { cropZoom: z })}
                offset={current.cropOffset}
                onOffsetChange={(o) => updatePhoto(current.id, { cropOffset: o })}
                crop={current.crop}
                onCropChange={(c) => updatePhoto(current.id, { crop: c })}
                onCropNatural={(px) => updatePhoto(current.id, { cropPixels: px })}
                aspect={aspect}
                grid
                className="absolute inset-0"
              />
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
                <p>无法访问摄像头，请检查权限</p>
                {/* 降级按钮：仅在相机不可用时出现，明确标注"选择图片"，不作为主操作 */}
                <label
                  className="mt-1 flex cursor-pointer items-center gap-1.5 rounded-full bg-white/10 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-white/20"
                  aria-label="选择图片（相机不可用降级）"
                >
                  <Images className="size-4" strokeWidth={1.75} />
                  选择图片
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
                {typeof window !== 'undefined' && window.self !== window.top && (
                  <>
                    <p className="mt-2 text-xs text-zinc-500">
                      预览面板可能拦截了相机权限，在新标签页打开即可正常唤起摄像头
                    </p>
                    <button
                      type="button"
                      onClick={() => window.open('/?cam=1', '_blank')}
                      className="rounded-full bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-emerald-700"
                    >
                      在新标签页打开相机
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {/* ---------- crop mode controls ---------- */}
          {inCropMode && current ? (
            <>
              {/* aspect chips + delete */}
              <div className="flex items-center gap-1 px-4 pt-3">
                <div className="flex flex-1 items-center gap-1 overflow-x-auto">
                  {ASPECT_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => setAspect(p.value)}
                      className={cn(
                        'shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                        aspect === p.value
                          ? 'bg-emerald-600 text-white'
                          : 'bg-white/10 text-zinc-200 hover:bg-white/20',
                      )}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  aria-label="删除此照片并重拍"
                  onClick={retake}
                  className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white/10 text-zinc-300 transition-colors hover:bg-red-500/20 hover:text-red-400"
                >
                  <Trash2 className="size-3.5" strokeWidth={1.75} />
                </button>
              </div>

              {/* crop zoom slider (1x–4x + 双指) */}
              <div className="flex items-center gap-2 px-4 pt-2">
                <ZoomIn className="size-4 shrink-0 text-zinc-300" strokeWidth={1.75} />
                <Slider
                  min={1}
                  max={MAX_CROP_ZOOM}
                  step={0.05}
                  value={[current.cropZoom]}
                  onValueChange={(v) => updatePhoto(current.id, { cropZoom: clampZoom(v[0] ?? 1) })}
                  className="flex-1"
                />
                <span className="w-10 shrink-0 text-right text-xs tabular-nums text-zinc-300">
                  {current.cropZoom.toFixed(1)}x
                </span>
              </div>

              {/* 旋转/翻转工具条：90° 步进旋转 + 水平/垂直翻转（变换后重置裁剪框） */}
              <div className="flex items-center gap-1.5 px-4 pt-2">
                <button
                  type="button"
                  aria-label="向左旋转 90 度"
                  disabled={transforming}
                  onClick={() => void transformCurrent({ rotate: -90 })}
                  className="flex size-9 flex-col items-center justify-center gap-0.5 rounded-lg bg-white/10 text-zinc-200 transition-colors hover:bg-white/20 disabled:pointer-events-none disabled:opacity-40"
                >
                  {transforming ? (
                    <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
                  ) : (
                    <RotateCcw className="size-4" strokeWidth={1.75} />
                  )}
                  <span className="text-[10px] leading-none">左转</span>
                </button>
                <button
                  type="button"
                  aria-label="向右旋转 90 度"
                  disabled={transforming}
                  onClick={() => void transformCurrent({ rotate: 90 })}
                  className="flex size-9 flex-col items-center justify-center gap-0.5 rounded-lg bg-white/10 text-zinc-200 transition-colors hover:bg-white/20 disabled:pointer-events-none disabled:opacity-40"
                >
                  {transforming ? (
                    <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
                  ) : (
                    <RotateCw className="size-4" strokeWidth={1.75} />
                  )}
                  <span className="text-[10px] leading-none">右转</span>
                </button>
                <button
                  type="button"
                  aria-label="水平翻转（左右镜像）"
                  disabled={transforming}
                  onClick={() => void transformCurrent({ flipH: true })}
                  className="flex size-9 flex-col items-center justify-center gap-0.5 rounded-lg bg-white/10 text-zinc-200 transition-colors hover:bg-white/20 disabled:pointer-events-none disabled:opacity-40"
                >
                  {transforming ? (
                    <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
                  ) : (
                    <FlipHorizontal className="size-4" strokeWidth={1.75} />
                  )}
                  <span className="text-[10px] leading-none">翻转</span>
                </button>
                <button
                  type="button"
                  aria-label="垂直翻转（上下镜像）"
                  disabled={transforming}
                  onClick={() => void transformCurrent({ flipV: true })}
                  className="flex size-9 flex-col items-center justify-center gap-0.5 rounded-lg bg-white/10 text-zinc-200 transition-colors hover:bg-white/20 disabled:pointer-events-none disabled:opacity-40"
                >
                  {transforming ? (
                    <Loader2 className="size-4 animate-spin" strokeWidth={1.75} />
                  ) : (
                    <FlipVertical className="size-4" strokeWidth={1.75} />
                  )}
                  <span className="text-[10px] leading-none">镜像</span>
                </button>
              </div>

              {/* 取消 | 已选 W×H | 完成裁剪（photo 模式也回到取景器拍下一张） */}
              <div className="flex items-center justify-between gap-2 px-4 pt-3">
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-full bg-white/10 text-white hover:bg-white/20 hover:text-white"
                  onClick={cancelCrop}
                >
                  取消
                </Button>
                <span className="text-xs text-zinc-300">
                  {current.cropPixels
                    ? `已选 ${Math.round(current.cropPixels.width)}×${Math.round(current.cropPixels.height)}`
                    : '拖动把手自由选择区域'}
                </span>
                <Button
                  size="sm"
                  className="h-9 rounded-full bg-emerald-600 px-4 text-white hover:bg-emerald-700"
                  onClick={finishCrop}
                >
                  <Scissors className="size-3.5" strokeWidth={1.75} />
                  {mode === 'photo' ? '完成·拍下一张' : '完成裁剪'}
                </Button>
              </div>
            </>
          ) : (
            /* ---------- camera mode controls ---------- */
            <>
              {/* camera zoom slider (1x–4x + 双指) */}
              {!permissionError && !current && (
                <div className="flex items-center gap-2 px-4 pt-3">
                  <ZoomIn className="size-4 shrink-0 text-zinc-300" strokeWidth={1.75} />
                  <Slider
                    min={1}
                    max={MAX_ZOOM}
                    step={0.05}
                    value={[zoom]}
                    onValueChange={(v) => setZoom(clampZoom(v[0] ?? 1))}
                    className="flex-1"
                  />
                  <span className="w-10 shrink-0 text-right text-xs tabular-nums text-zinc-300">
                    {zoom.toFixed(1)}x
                  </span>
                </div>
              )}

              {/* 识别全部并合并（ocr）/ 完成并插入全部（photo 多张） */}
              {photos.length > 0 && (
                <div className="px-4 pt-3">
                  {mode === 'photo' ? (
                    <Button
                      className="h-11 w-full rounded-full bg-emerald-600 text-sm font-semibold text-white hover:bg-emerald-700"
                      onClick={() => void exportAllPhotos()}
                    >
                      <Images className="size-4" strokeWidth={1.75} />
                      完成并插入全部（{photos.length} 张）
                    </Button>
                  ) : (
                    <Button
                      className="h-11 w-full rounded-full bg-emerald-600 text-sm font-semibold text-white hover:bg-emerald-700"
                      onClick={() => void handleRecognizeAll()}
                      disabled={ocrLoading}
                    >
                      {ocrLoading ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <ScanText className="size-4" strokeWidth={1.75} />
                      )}
                      识别全部并合并{ocrTotal > 0 ? `（${ocrTotal} 页）` : ''}
                    </Button>
                  )}
                </div>
              )}
            </>
          )}

          {/* thumbnail strip (多页跨页，点击重新进入裁剪) */}
          {photos.length > 0 && (
            <div className="flex items-center gap-2 overflow-x-auto px-4 py-2">
              {photos.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setCurrentId(p.id)
                    setViewMode('crop')
                  }}
                  className={cn(
                    'relative size-14 shrink-0 overflow-hidden rounded-xl border-2 transition-colors',
                    p.id === currentId ? 'border-emerald-500' : 'border-white/10 hover:border-white/30',
                  )}
                  aria-label={`第 ${i + 1} 页，点按重新裁剪`}
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

          {/* bottom action bar: [占位] | 快门/裁剪模式 | 翻转相机
              ⚠️ 不再在此处渲染 <input type="file">：原先常驻的相册 label 与快门按钮同级，
              会被用户误认为"相机按钮"从而打开文件选择器。getUserMedia 真实取景器为唯一主路径；
              相机不可用 (permissionError) 时，"选择图片"降级按钮出现在上方预览区的错误提示中。 */}
          <div className="flex items-center justify-between px-6 py-4">
            {/* 左槽位占位：保持 [快门] 居中、[翻转] 居右的三段式布局平衡，不渲染任何文件选择器 */}
            <span className="size-11" aria-hidden />

            {inCropMode ? (
              <span className="text-xs text-zinc-400">裁剪模式</span>
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

            <button
              type="button"
              aria-label="切换前后摄像头"
              onClick={toggleCamera}
              disabled={inCropMode || permissionError}
              className={cn(
                'flex size-11 items-center justify-center rounded-full bg-white/10 transition-colors hover:bg-white/20',
                (inCropMode || permissionError) && 'pointer-events-none opacity-30',
              )}
            >
              <SwitchCamera className="size-5" strokeWidth={1.75} />
            </button>
          </div>

          <div className="px-4 pb-3 text-center text-[11px] text-zinc-500">
            {inCropMode
              ? '拖动把手自由拉升裁剪框 · 滑块或双指缩放'
              : '可裁剪、缩放、重拍；多页将按顺序合并识别'}
          </div>
        </div>

        <canvas ref={canvasRef} className="hidden" aria-hidden />
        <DialogTitle className="sr-only">浏览器相机</DialogTitle>
      </DialogContent>
    </Dialog>
  )
}
