'use client'

import * as React from 'react'
import {
  Camera,
  Images,
  Loader2,
  RefreshCcw,
  ScanText,
  SwitchCamera,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface CameraCaptureProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with recognized text after a successful OCR. */
  onText: (text: string) => void
}

export function CameraCapture({ open, onOpenChange, onText }: CameraCaptureProps) {
  const videoRef = React.useRef<HTMLVideoElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const streamRef = React.useRef<MediaStream | null>(null)

  const [facing, setFacing] = React.useState<'environment' | 'user'>('environment')
  const [permissionError, setPermissionError] = React.useState(false)
  const [photos, setPhotos] = React.useState<string[]>([])
  const [current, setCurrent] = React.useState<string | null>(null)
  const [ocrLoading, setOcrLoading] = React.useState(false)

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
          video: { facingMode: mode },
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
      setCurrent(null)
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
    void startStream(next)
  }

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
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
    setCurrent(dataUrl)
    setPhotos((prev) => [...prev, dataUrl])
  }

  const handleRecognize = async (dataUrl: string) => {
    setOcrLoading(true)
    const tid = toast.loading('正在识别图片文字…')
    try {
      const blob = await (await fetch(dataUrl)).blob()
      const fd = new FormData()
      fd.append('file', blob, 'photo.jpg')
      const res = await fetch('/api/ocr', { method: 'POST', body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '识别失败')
      }
      const data = (await res.json()) as { text?: string }
      const text = (data.text || '').trim()
      if (!text) {
        toast.warning('未识别到文字，请换一张更清晰的照片', { id: tid })
        return
      }
      toast.success(`识别到 ${text.length} 字`, { id: tid })
      onOpenChange(false)
      onText(text)
    } catch (err) {
      toast.error(
        '识别失败：' + (err instanceof Error ? err.message : '未知错误'),
        { id: tid },
      )
    } finally {
      setOcrLoading(false)
    }
  }

  const handlePickFile = async (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result)
      setCurrent(dataUrl)
      setPhotos((prev) => [...prev, dataUrl])
    }
    reader.readAsDataURL(file)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[92vh] overflow-y-auto border-none bg-black p-0 text-white sm:max-w-md [&>button]:hidden"
        aria-describedby={undefined}
      >
        <div className="flex min-h-[520px] flex-col">
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

          {/* preview area */}
          <div className="relative flex flex-1 items-center justify-center overflow-hidden rounded-2xl bg-zinc-900 mx-4">
            {current ? (
               
              <img
                src={current}
                alt="已拍摄的照片"
                className="max-h-[46vh] w-full object-contain"
              />
            ) : (
              <video
                ref={videoRef}
                playsInline
                muted
                className={cn('h-[46vh] w-full object-cover', permissionError && 'hidden')}
              />
            )}
            {permissionError && !current && (
              <div className="flex flex-col items-center gap-3 px-6 py-12 text-center text-sm text-zinc-400">
                <Camera className="size-10 text-zinc-600" strokeWidth={1.25} />
                相机不可用，请从相册选择图片识别
              </div>
            )}
          </div>

          {/* controls */}
          <div className="flex items-center justify-between px-6 py-5">
            {/* gallery picker */}
            <label
              className={cn(
                'flex size-11 cursor-pointer items-center justify-center rounded-full bg-white/10 transition-colors hover:bg-white/20',
                current && 'pointer-events-none opacity-30',
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
                  if (f) void handlePickFile(f)
                  e.target.value = ''
                }}
              />
            </label>

            {current ? (
              <div className="flex items-center gap-3">
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-full bg-white/10 text-white hover:bg-white/20 hover:text-white"
                  onClick={() => setCurrent(null)}
                  disabled={ocrLoading}
                >
                  <RefreshCcw className="size-4" strokeWidth={1.75} />
                  重拍
                </Button>
                <Button
                  size="sm"
                  className="h-11 rounded-full bg-emerald-600 px-5 text-white hover:bg-emerald-700"
                  onClick={() => void handleRecognize(current)}
                  disabled={ocrLoading}
                >
                  {ocrLoading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ScanText className="size-4" strokeWidth={1.75} />
                  )}
                  识别文字
                </Button>
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
              disabled={!!current || permissionError}
              className={cn(
                'flex size-11 items-center justify-center rounded-full bg-white/10 transition-colors hover:bg-white/20',
                (current || permissionError) && 'opacity-30',
              )}
            >
              <SwitchCamera className="size-5" strokeWidth={1.75} />
            </button>
          </div>
        </div>

        <canvas ref={canvasRef} className="hidden" aria-hidden />
        <DialogTitle className="sr-only">浏览器相机</DialogTitle>
      </DialogContent>
    </Dialog>
  )
}
