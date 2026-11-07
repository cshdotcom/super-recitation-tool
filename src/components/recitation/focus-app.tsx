'use client'

// 专注 (focus timer) — three screens:
//   1. 选择专注内容   list of focus content cards (bg image, stats, reorder, delete)
//   2. 新建/编辑     name + duration chips + background picker (presets / local image / none)
//   3. 计时          countdown / count-up segmented control + immersive running overlay

import * as React from 'react'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Loader2,
  Plus,
  SquarePen,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { AnimatePresence, motion } from 'framer-motion'
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
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { FocusContentData } from '@/lib/types'

const LAST_USED_KEY = 'focus-last'

const BG_PRESETS: { key: string; src: string }[] = [
  { key: 'bg-silk', src: '/focus/bg-silk.png' },
  { key: 'bg-sea', src: '/focus/bg-sea.png' },
  { key: 'bg-grass', src: '/focus/bg-grass.png' },
  { key: 'bg-mountain', src: '/focus/bg-mountain.png' },
  { key: 'bg-beach', src: '/focus/bg-beach.png' },
  { key: 'bg-hill', src: '/focus/bg-hill.png' },
]

const DURATIONS = [5, 10, 15, 20, 25, 30, 45, 60]

const JSON_HEADERS = { 'Content-Type': 'application/json' }

type Screen = 'list' | 'edit' | 'timer'
type TimerMode = 'down' | 'up'

/** preset key 或 dataURL → 直接可用的 URL；''/未知 → null（银灰渐变兜底） */
function resolveBgUrl(bg: string): string | null {
  if (!bg) return null
  if (bg.startsWith('data:')) return bg
  const preset = BG_PRESETS.find((p) => p.key === bg)
  return preset ? preset.src : null
}

/** mm:ss (mm 可超过 60) */
function fmt(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

function hideImgOnError(e: React.SyntheticEvent<HTMLImageElement>): void {
  e.currentTarget.style.display = 'none'
}

/** 本地图片 → canvas 压缩 (最长边按宽度 480px, jpeg 0.75) → dataURL */
async function compressImage(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('图片加载失败'))
    el.src = dataUrl
  })
  const scale = Math.min(1, 480 / Math.max(1, img.width))
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return dataUrl
  ctx.drawImage(img, 0, 0, w, h)
  return canvas.toDataURL('image/jpeg', 0.75)
}

// ---------- 小组件 ----------

/** 卡片底部的小进度环 (今日 seconds / minutes*60) */
function ProgressRing({ seconds, total }: { seconds: number; total: number }) {
  const pct = total > 0 ? Math.min(1, Math.max(0, seconds / total)) : 0
  const R = 26
  const C = 2 * Math.PI * R
  return (
    <div className="relative size-14 shrink-0">
      <svg viewBox="0 0 56 56" className="size-14 -rotate-90" aria-hidden>
        <circle cx="28" cy="28" r={R} fill="none" stroke="#d4d4d8" strokeWidth="3" />
        {pct > 0 && (
          <circle
            cx="28"
            cy="28"
            r={R}
            fill="none"
            stroke="#18181b"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${(C * pct).toFixed(2)} ${C.toFixed(2)}`}
          />
        )}
      </svg>
      <span className="absolute inset-0 grid place-items-center text-[10px] font-medium text-zinc-600">
        {Math.round(pct * 100)}%
      </span>
    </div>
  )
}

/** 卡片左上角圆形图标按钮 */
function CircleIcon({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-9 place-items-center rounded-full bg-white/70 backdrop-blur transition-colors hover:bg-white/90 disabled:opacity-40 disabled:hover:bg-white/70"
    >
      {children}
    </button>
  )
}

interface FocusAppProps {
  onBack: () => void
}

export function FocusApp({ onBack }: FocusAppProps) {
  // ---------- 数据 ----------
  const [items, setItems] = React.useState<FocusContentData[]>([])
  const [loading, setLoading] = React.useState(true)
  const [lastUsedId, setLastUsedId] = React.useState<string | null>(null)

  // ---------- 屏幕状态机 ----------
  const [screen, setScreen] = React.useState<Screen>('list')

  // ---------- 新建/编辑 ----------
  const [editing, setEditing] = React.useState<FocusContentData | null>(null)
  const [name, setName] = React.useState('')
  const [minutes, setMinutes] = React.useState(25)
  const [bg, setBg] = React.useState('')
  const [localBg, setLocalBg] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  // ---------- 计时 ----------
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const [mode, setMode] = React.useState<TimerMode>('down')
  const [durationMin, setDurationMin] = React.useState(25)
  const [running, setRunning] = React.useState(false)
  const [paused, setPaused] = React.useState(false)
  const [remainingSec, setRemainingSec] = React.useState(0)
  const [elapsedSec, setElapsedSec] = React.useState(0)
  const [scholarMode, setScholarMode] = React.useState(false)
  const [whitelistOpen, setWhitelistOpen] = React.useState(false)
  const [giveUpOpen, setGiveUpOpen] = React.useState(false)

  const content = React.useMemo(
    () => items.find((i) => i.id === activeId) ?? null,
    [items, activeId],
  )

  // refs（计时用，避免 stale closure）
  const modeRef = React.useRef<TimerMode>(mode)
  modeRef.current = mode
  const durRef = React.useRef(durationMin)
  durRef.current = durationMin
  const pausedRef = React.useRef(paused)
  pausedRef.current = paused
  const contentRef = React.useRef<FocusContentData | null>(content)
  contentRef.current = content
  const sessionActiveRef = React.useRef(false)
  const endAtRef = React.useRef<number | null>(null)
  const baseRef = React.useRef<number | null>(null)
  const frozenRef = React.useRef<number>(0)

  const fetchList = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/focus?tzOffset=${new Date().getTimezoneOffset()}`)
      if (!res.ok) throw new Error('加载专注内容失败')
      const data = (await res.json()) as { contents?: FocusContentData[] }
      setItems(data.contents ?? [])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载专注内容失败')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void fetchList()
    try {
      setLastUsedId(localStorage.getItem(LAST_USED_KEY))
    } catch {
      // localStorage 不可用时忽略
    }
  }, [fetchList])

  // 计时中的内容被删除时退回列表
  React.useEffect(() => {
    if (screen === 'timer' && !items.some((i) => i.id === activeId)) setScreen('list')
  }, [screen, items, activeId])

  // ---------- 结束会话（自然完成 / 放弃） ----------
  const finish = React.useCallback(
    async (natural: boolean) => {
      if (!sessionActiveRef.current) return
      sessionActiveRef.current = false
      const c = contentRef.current
      const now = Date.now()

      let seconds: number
      if (modeRef.current === 'down') {
        const total = durRef.current * 60
        if (pausedRef.current) {
          seconds = total - frozenRef.current
        } else {
          seconds = total - Math.max(0, Math.round(((endAtRef.current ?? now) - now) / 1000))
        }
      } else {
        seconds = pausedRef.current
          ? frozenRef.current
          : Math.floor((now - (baseRef.current ?? now)) / 1000)
      }
      seconds = Math.max(0, Math.min(86400, Math.round(seconds)))

      setRunning(false)
      setPaused(false)
      setGiveUpOpen(false)

      // 标记最近使用
      if (c) {
        try {
          localStorage.setItem(LAST_USED_KEY, c.id)
        } catch {
          // ignore
        }
        setLastUsedId(c.id)
      }

      const shouldLog = natural ? seconds > 0 : seconds >= 60
      if (shouldLog && c) {
        try {
          const res = await fetch('/api/focus/log', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ contentId: c.id, seconds }),
          })
          if (!res.ok) throw new Error('记录专注时长失败')
        } catch (err) {
          toast.error(err instanceof Error ? err.message : '记录专注时长失败')
        }
      }

      toast.success(
        natural ? '专注完成！' : shouldLog ? `已专注 ${Math.floor(seconds / 60)} 分钟` : '已退出专注',
      )
      setScreen('list')
      void fetchList()
    },
    [fetchList],
  )
  const finishRef = React.useRef(finish)
  finishRef.current = finish

  // ---------- 运行中的 1s tick（drift-free） ----------
  React.useEffect(() => {
    if (!running || paused) return
    const id = window.setInterval(() => {
      const now = Date.now()
      if (modeRef.current === 'down') {
        const rem = Math.max(0, Math.round(((endAtRef.current ?? now) - now) / 1000))
        setRemainingSec(rem)
        if (rem <= 0) finishRef.current(true)
      } else {
        setElapsedSec(Math.floor((now - (baseRef.current ?? now)) / 1000))
      }
    }, 500)
    return () => window.clearInterval(id)
  }, [running, paused])

  // ---------- document.title ----------
  React.useEffect(() => {
    if (!running) return
    const prev = document.title
    return () => {
      document.title = prev
    }
  }, [running])
  React.useEffect(() => {
    if (running) {
      document.title = `专注中 ${fmt(mode === 'down' ? remainingSec : elapsedSec)}`
    }
  }, [running, mode, remainingSec, elapsedSec])

  // ---------- 运行中锁定背景滚动 ----------
  React.useEffect(() => {
    if (!running) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [running])

  // ---------- 列表操作 ----------
  const openEdit = (c: FocusContentData | null) => {
    setEditing(c)
    setName(c?.name ?? '')
    setMinutes(c?.minutes ?? 25)
    setBg(c?.bg ?? '')
    setLocalBg(c && c.bg.startsWith('data:') ? c.bg : null)
    setScreen('edit')
  }

  const openTimer = (c: FocusContentData) => {
    setActiveId(c.id)
    setDurationMin(c.minutes)
    setMode('down')
    setRemainingSec(c.minutes * 60)
    setElapsedSec(0)
    setPaused(false)
    setRunning(false)
    setScreen('timer')
  }

  const move = async (index: number, dir: -1 | 1) => {
    const j = index + dir
    if (j < 0 || j >= items.length) return
    const next = [...items]
    const tmp = next[index]
    next[index] = next[j]
    next[j] = tmp
    // 本地立即重排 + 顺序号（index+1），只 PATCH 顺序变化的行
    setItems(next.map((c, idx) => ({ ...c, ord: idx + 1 })))
    try {
      const changed = next
        .map((c, idx) => ({ id: c.id, ord: idx + 1, oldOrd: c.ord }))
        .filter((x) => x.oldOrd !== x.ord)
      const results = await Promise.all(
        changed.map((x) =>
          fetch('/api/focus', {
            method: 'PATCH',
            headers: JSON_HEADERS,
            body: JSON.stringify({ id: x.id, ord: x.ord }),
          }),
        ),
      )
      if (results.some((r) => !r.ok)) throw new Error('排序失败')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '排序失败')
      void fetchList()
    }
  }

  const doDelete = async (c: FocusContentData) => {
    try {
      const res = await fetch('/api/focus', {
        method: 'DELETE',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: c.id }),
      })
      if (!res.ok) throw new Error('删除失败')
      setItems((list) => list.filter((x) => x.id !== c.id))
      if (lastUsedId === c.id) {
        try {
          localStorage.removeItem(LAST_USED_KEY)
        } catch {
          // ignore
        }
        setLastUsedId(null)
      }
      toast.success('已删除')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  // ---------- 新建/编辑保存 ----------
  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    try {
      const payload = { name: trimmed.slice(0, 30), minutes, bg }
      const res = editing
        ? await fetch('/api/focus', {
            method: 'PATCH',
            headers: JSON_HEADERS,
            body: JSON.stringify({ id: editing.id, ...payload }),
          })
        : await fetch('/api/focus', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify(payload),
          })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error || '保存失败')
      }
      toast.success('已保存')
      setScreen('list')
      void fetchList()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const dataUrl = await compressImage(file)
      setLocalBg(dataUrl)
      setBg(dataUrl)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '图片处理失败')
    }
  }

  // ---------- 计时操作 ----------
  const startSession = () => {
    const now = Date.now()
    if (mode === 'down') {
      endAtRef.current = now + durationMin * 60 * 1000
      frozenRef.current = 0
      setRemainingSec(durationMin * 60)
    } else {
      baseRef.current = now
      frozenRef.current = 0
      setElapsedSec(0)
    }
    sessionActiveRef.current = true
    setPaused(false)
    setRunning(true)
  }

  const togglePause = () => {
    const now = Date.now()
    if (paused) {
      // 继续
      if (mode === 'down') {
        endAtRef.current = now + frozenRef.current * 1000
      } else {
        baseRef.current = now - frozenRef.current * 1000
      }
      setPaused(false)
    } else {
      // 暂停
      if (mode === 'down') {
        frozenRef.current = Math.max(0, Math.round(((endAtRef.current ?? now) - now) / 1000))
      } else {
        frozenRef.current = Math.floor((now - (baseRef.current ?? now)) / 1000)
      }
      setPaused(true)
    }
  }

  const displaySec = mode === 'down' ? remainingSec : elapsedSec

  // ============================================================
  // 渲染
  // ============================================================

  const headerRight =
    screen === 'list' ? (
      <button
        type="button"
        onClick={() => openEdit(null)}
        className="z-10 shrink-0 rounded-full px-2 py-1 text-base font-bold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        新建
      </button>
    ) : screen === 'edit' ? (
      <button
        type="button"
        onClick={save}
        disabled={!name.trim() || saving}
        className="z-10 shrink-0 rounded-full px-2 py-1 text-base font-bold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
      >
        {saving ? <Loader2 className="size-4 animate-spin" /> : '完成'}
      </button>
    ) : null

  return (
    <>
      {/* ---------- 顶栏 ---------- */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="relative mx-auto flex h-14 w-full max-w-2xl items-center px-4">
          <button
            type="button"
            aria-label="返回"
            onClick={screen === 'list' ? onBack : () => setScreen('list')}
            className="shrink-0 rounded-full p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="size-6 text-foreground" strokeWidth={1.75} />
          </button>

          {screen === 'timer' ? (
            // 计时页：居中分段控件（倒计时/正计时）
            <div
              role="tablist"
              aria-label="计时模式"
              className="absolute left-1/2 z-10 flex w-56 -translate-x-1/2 rounded-full bg-zinc-200/70 p-1"
            >
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'down'}
                onClick={() => setMode('down')}
                className={cn(
                  'flex-1 rounded-full py-1.5 text-sm transition-colors',
                  mode === 'down'
                    ? 'bg-white font-semibold shadow-sm text-foreground'
                    : 'text-zinc-500',
                )}
              >
                倒计时
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'up'}
                onClick={() => setMode('up')}
                className={cn(
                  'flex-1 rounded-full py-1.5 text-sm transition-colors',
                  mode === 'up'
                    ? 'bg-white font-semibold shadow-sm text-foreground'
                    : 'text-zinc-500',
                )}
              >
                正计时
              </button>
            </div>
          ) : (
            <h1 className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-lg font-bold">
              {screen === 'list' ? '选择专注内容' : editing ? '编辑专注内容' : '新建专注内容'}
            </h1>
          )}

          {headerRight}
        </div>
      </header>

      {/* ---------- 主体 ---------- */}
      {screen === 'list' && (
        <main className="min-w-0 flex-1 bg-muted/40">
          <div className="mx-auto w-full max-w-2xl px-4 py-5">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-24 text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
                <span className="text-sm">加载中…</span>
              </div>
            ) : items.length === 0 ? (
              <div className="flex justify-center pt-16">
                <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-zinc-300 px-10 py-14 text-center">
                  <p className="text-sm text-zinc-500">还没有专注内容，点击右上角「新建」创建</p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {items.map((c, i) => {
                  const bgUrl = resolveBgUrl(c.bg)
                  return (
                    <div
                      key={c.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`开始专注：${c.name}`}
                      onClick={() => openTimer(c)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          openTimer(c)
                        }
                      }}
                      className="relative min-h-44 cursor-pointer overflow-hidden rounded-2xl text-zinc-900 shadow-sm outline-none transition-transform focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99]"
                    >
                      {/* 背景层：渐变兜底 + 图片 */}
                      <div className="absolute inset-0 bg-gradient-to-br from-white via-slate-100 to-slate-200" />
                      {bgUrl && (
                        <img
                          src={bgUrl}
                          alt=""
                          onError={hideImgOnError}
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      )}
                      {/* 提升文字可读性的浅色遮罩 */}
                      <div className="absolute inset-0 bg-gradient-to-b from-white/35 via-white/15 to-white/45" />

                      <div className="relative z-10 flex min-h-44 flex-col p-4">
                        {/* 顶部：图标行 + 最近使用标记 */}
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex gap-2">
                            <CircleIcon label="编辑" onClick={(e) => { e.stopPropagation(); openEdit(c) }}>
                              <SquarePen className="size-4 text-zinc-700" strokeWidth={1.75} />
                            </CircleIcon>
                            <CircleIcon
                              label="上移"
                              disabled={i === 0}
                              onClick={(e) => { e.stopPropagation(); void move(i, -1) }}
                            >
                              <ChevronUp className="size-4 text-zinc-700" strokeWidth={1.75} />
                            </CircleIcon>
                            <CircleIcon
                              label="下移"
                              disabled={i === items.length - 1}
                              onClick={(e) => { e.stopPropagation(); void move(i, 1) }}
                            >
                              <ChevronDown className="size-4 text-zinc-700" strokeWidth={1.75} />
                            </CircleIcon>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <CircleIcon
                                  label="删除"
                                  onClick={(e) => { e.stopPropagation() }}
                                >
                                  <Trash2 className="size-4 text-zinc-700" strokeWidth={1.75} />
                                </CircleIcon>
                              </AlertDialogTrigger>
                              <AlertDialogContent className="max-w-xs rounded-2xl">
                                <AlertDialogHeader>
                                  <AlertDialogTitle>删除专注内容？</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    将删除「{c.name}」及其全部专注记录，此操作不可恢复。
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>取消</AlertDialogCancel>
                                  <AlertDialogAction
                                    className="bg-red-500 text-white hover:bg-red-500/90"
                                    onClick={() => void doDelete(c)}
                                  >
                                    删除
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                          {lastUsedId === c.id && (
                            <span
                              aria-label="最近使用"
                              className="grid size-7 shrink-0 place-items-center rounded-full bg-zinc-900"
                            >
                              <Check className="size-4 text-white" strokeWidth={2} />
                            </span>
                          )}
                        </div>

                        {/* 中部：名称 */}
                        <div className="flex flex-1 items-center py-2">
                          <h2 className="break-words text-2xl font-bold leading-snug">{c.name}</h2>
                        </div>

                        {/* 底部：时长/次数 + 进度环 + 今日 */}
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-base font-bold">{c.minutes}分钟</p>
                            <p className="mt-0.5 text-xs text-zinc-500">已专注 {c.focusCount} 次</p>
                          </div>
                          <ProgressRing seconds={c.todaySeconds} total={c.minutes * 60} />
                          <p className="shrink-0 text-sm font-medium">
                            今日 {Math.round(c.todaySeconds / 60)} 分钟
                          </p>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </main>
      )}

      {screen === 'edit' && (
        <main className="min-w-0 flex-1 bg-muted/40">
          <div className="mx-auto w-full max-w-2xl px-4 py-6">
            <p className="mb-2 text-base text-muted-foreground">专注内容名称</p>
            <input
              value={name}
              maxLength={30}
              onChange={(e) => setName(e.target.value)}
              placeholder="请输入专注内容,如:奴才这就去读书"
              aria-label="专注内容名称"
              className="h-14 w-full rounded-2xl border-0 bg-white px-4 text-base shadow-sm outline-none placeholder:text-zinc-400 focus-visible:ring-2 focus-visible:ring-ring"
            />

            <p className="mb-3 mt-6 text-base text-muted-foreground">设置默认专注时长</p>
            <div className="no-scrollbar flex gap-3 overflow-x-auto pb-1">
              {DURATIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={minutes === d}
                  onClick={() => setMinutes(d)}
                  className={cn(
                    'flex h-14 min-w-fit shrink-0 items-center rounded-xl border bg-white px-6 text-lg shadow-sm transition-colors',
                    minutes === d
                      ? 'border-blue-500 ring-2 ring-blue-500'
                      : 'border-transparent text-foreground',
                  )}
                >
                  {d}min
                </button>
              ))}
            </div>

            <p className="mb-3 mt-6 text-base text-muted-foreground">选择背景</p>
            <div className="grid grid-cols-3 gap-3">
              {/* 本地图片 */}
              <label
                className={cn(
                  'relative flex aspect-[9/16] cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border-2 bg-white text-zinc-500 transition',
                  localBg && bg === localBg
                    ? 'border-blue-500 ring-2 ring-blue-500/40'
                    : 'border-dashed border-zinc-300 hover:border-zinc-400',
                )}
              >
                {localBg ? (
                  <>
                    <img
                      src={localBg}
                      alt="自定义背景"
                      onError={hideImgOnError}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                    <span className="relative z-10 rounded-full bg-white/70 px-2 py-0.5 text-xs text-zinc-600 backdrop-blur">
                      自定义
                    </span>
                  </>
                ) : (
                  <>
                    <Plus className="size-6" strokeWidth={1.75} />
                    <span className="text-sm">添加本地图片</span>
                  </>
                )}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  aria-label="添加本地图片"
                  onChange={(e) => void onPickImage(e)}
                />
              </label>

              {/* 预设背景 */}
              {BG_PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  aria-pressed={bg === p.key}
                  aria-label={`背景 ${p.key}`}
                  onClick={() => setBg(p.key)}
                  className={cn(
                    'relative aspect-[9/16] overflow-hidden rounded-2xl border-2 bg-gradient-to-br from-white via-slate-100 to-slate-200 transition',
                    bg === p.key
                      ? 'border-blue-500 ring-2 ring-blue-500/40'
                      : 'border-transparent',
                  )}
                >
                  <img
                    src={p.src}
                    alt=""
                    onError={hideImgOnError}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                </button>
              ))}

              {/* 无背景 */}
              <button
                type="button"
                aria-pressed={bg === ''}
                aria-label="无背景"
                onClick={() => setBg('')}
                className={cn(
                  'relative flex aspect-[9/16] items-center justify-center overflow-hidden rounded-2xl border-2 bg-gradient-to-br from-white via-slate-100 to-slate-200 transition',
                  bg === '' ? 'border-blue-500 ring-2 ring-blue-500/40' : 'border-transparent',
                )}
              >
                <span className="text-sm text-zinc-500">无背景</span>
              </button>
            </div>
          </div>
        </main>
      )}

      {screen === 'timer' && content && (
        <main className="min-w-0 flex-1 bg-muted/40">
          <div className="mx-auto flex w-full max-w-2xl flex-col items-center px-4 pb-10 pt-4">
            <div className="flex w-full flex-1 flex-col items-center justify-center gap-6">
              {/* 内容名称（点击返回列表切换） */}
              <button
                type="button"
                aria-label="切换专注内容"
                onClick={() => setScreen('list')}
                className="flex items-center gap-1 rounded-full px-3 py-1 outline-none transition-colors hover:bg-white focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="max-w-[16rem] truncate text-2xl font-bold text-zinc-900">
                  {content.name}
                </span>
                <ChevronRight className="size-5 shrink-0 text-zinc-400" strokeWidth={1.75} />
              </button>

              {/* 大圆盘 */}
              {mode === 'down' ? (
                <div className="relative flex size-80 flex-col items-center justify-center rounded-full border-[3px] border-zinc-200 bg-white/60">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      aria-label="减少一分钟"
                      onClick={() => setDurationMin((m) => Math.max(1, m - 1))}
                      className="grid size-8 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="block h-0 w-0 border-y-[9px] border-y-transparent border-r-[14px] border-r-blue-600" />
                    </button>
                    <span className="text-6xl font-bold tabular-nums text-zinc-900">
                      {fmt(durationMin * 60)}
                    </span>
                    <button
                      type="button"
                      aria-label="增加一分钟"
                      onClick={() => setDurationMin((m) => Math.min(180, m + 1))}
                      className="grid size-8 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="block h-0 w-0 border-y-[9px] border-y-transparent border-l-[14px] border-l-blue-600" />
                    </button>
                  </div>
                  <p className="mt-2 text-base text-muted-foreground">专注时长</p>
                </div>
              ) : (
                <div className="relative flex size-80 items-center justify-center">
                  <svg
                    viewBox="0 0 320 320"
                    className="absolute inset-0 size-80 -rotate-90"
                    aria-hidden
                  >
                    <circle
                      cx="160"
                      cy="160"
                      r="156"
                      fill="none"
                      stroke="#e4e4e7"
                      strokeWidth="4"
                      strokeLinecap="round"
                      strokeDasharray="2.2 14.14"
                    />
                  </svg>
                  <span className="text-6xl font-bold tabular-nums text-zinc-900">00:00</span>
                </div>
              )}
            </div>

            {/* 开始按钮 */}
            <button
              type="button"
              onClick={startSession}
              className="h-14 w-full max-w-sm rounded-full bg-zinc-900 text-lg font-medium text-white shadow-sm transition-transform active:scale-[0.98]"
            >
              开始专注
            </button>

            {/* 学霸模式 */}
            <div className="mt-5 flex items-center justify-center gap-3 rounded-2xl bg-white px-6 py-3 shadow-sm">
              <button
                type="button"
                role="switch"
                aria-checked={scholarMode}
                aria-label="学霸模式开关"
                onClick={() => setScholarMode((v) => !v)}
                className={cn(
                  'grid size-5 shrink-0 place-items-center rounded-full border-2 transition-colors',
                  scholarMode ? 'border-zinc-900' : 'border-zinc-300',
                )}
              >
                {scholarMode && <span className="size-2.5 rounded-full bg-zinc-900" />}
              </button>
              <span className="text-base font-medium text-zinc-900">学霸模式</span>
              <button
                type="button"
                onClick={() => setWhitelistOpen(true)}
                className="text-base font-medium text-blue-600 underline-offset-2 hover:underline"
              >
                白名单
              </button>
            </div>

            <p className="mt-4 px-8 text-center text-xs leading-relaxed text-zinc-500">
              学霸模式：打开学霸模式并开始计时后，会阻止其他app打开，以达到专注的效果
            </p>
          </div>
        </main>
      )}

      {/* ---------- 白名单说明弹窗 ---------- */}
      <Dialog open={whitelistOpen} onOpenChange={setWhitelistOpen}>
        <DialogContent className="max-w-xs rounded-2xl">
          <DialogHeader>
            <DialogTitle>白名单</DialogTitle>
            <DialogDescription className="text-sm leading-relaxed">
              白名单功能仅限APP，网页版可在专注时保持本标签页
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>

      {/* ---------- 沉浸式计时全屏遮罩 ---------- */}
      <AnimatePresence>
        {running && content && (
          <motion.div
            key="focus-running"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="fixed inset-0 z-50 overflow-hidden bg-zinc-900"
            role="timer"
            aria-label="专注计时中"
          >
            {/* 背景图 + 暗色渐变 */}
            {(() => {
              const bgUrl = resolveBgUrl(content.bg)
              return (
                <>
                  {bgUrl && (
                    <img
                      src={bgUrl}
                      alt=""
                      onError={hideImgOnError}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/40 to-black/60" />
                </>
              )
            })()}

            <div className="relative z-10 flex h-full flex-col items-center justify-center px-6">
              <p className="max-w-full truncate text-base font-medium text-white/70">
                {content.name}
              </p>
              <div className="mt-4 text-7xl font-bold tabular-nums text-white">{fmt(displaySec)}</div>
              <p className="mt-3 text-sm text-white/60">
                {mode === 'down' ? (paused ? '已暂停' : '倒计时') : paused ? '已暂停' : '正计时'}
              </p>

              <div className="mt-14 flex items-center gap-4">
                <button
                  type="button"
                  onClick={togglePause}
                  className="h-12 rounded-full bg-white/10 px-8 text-base font-medium text-white backdrop-blur transition-colors hover:bg-white/20"
                >
                  {paused ? '继续' : '暂停'}
                </button>
                <AlertDialog
                  open={giveUpOpen}
                  onOpenChange={(open) => {
                    setGiveUpOpen(open)
                  }}
                >
                  <AlertDialogTrigger asChild>
                    <button
                      type="button"
                      className="h-12 rounded-full bg-red-500 px-8 text-base font-medium text-white transition-colors hover:bg-red-500/90"
                    >
                      放弃
                    </button>
                  </AlertDialogTrigger>
                  <AlertDialogContent className="max-w-xs rounded-2xl bg-zinc-900 text-white">
                    <AlertDialogHeader>
                      <AlertDialogTitle className="text-white">放弃专注？</AlertDialogTitle>
                      <AlertDialogDescription className="text-white/70">
                        已专注 {Math.floor(displaySec / 60)} 分钟，超过 1 分钟的时长仍会被记录。
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel className="bg-transparent text-white hover:bg-white/10 hover:text-white">
                        继续专注
                      </AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-red-500 text-white hover:bg-red-500/90"
                        onClick={() => void finishRef.current(false)}
                      >
                        放弃
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
