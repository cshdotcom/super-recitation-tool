'use client'

// 专注（重做版）—— 不再锁死浏览器。
//
//   入口两步：① 选择计时方式（⬆ 正计时 / ⬇ 倒计时 两张大卡片）
//            ② 选择专注内容（可选：/api/focus 预设卡片 + 「不选，直接开始」可跳过，
//               顶部时钟按钮弹自定义时长 Dialog：时:分选择）
//   进行中：  全屏大号时间 + 暂停/继续/结束并保存 + 最小化（全局浮时钟，后台继续，
//             可回主页/背书等任何页面）；计时状态放在 ./focus-bus
//   统计：    今日专注 X 分钟 / 累计 N 次（/api/focus 聚合）+ 今日会话记录（本设备）
//   管理：    专注内容的新建/编辑/排序/删除（含背景图，供全屏计时使用）
//   学霸模式（网页版无法实现，按需求删除）。

import * as React from 'react'
import {
  ArrowDown,
  ArrowUp,
  Bell,
  BellOff,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock3,
  Loader2,
  Minus,
  Music,
  Pause,
  Play,
  Plus,
  Settings2,
  SquarePen,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
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
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { FocusContentData } from '@/lib/types'
import {
  FOCUS_BUILTIN_SOUNDS,
  FOCUS_BUS_EVENTS,
  consumeOpenFocusRequest,
  describeBellChoice,
  fmtClock,
  fmtDurHuman,
  getDisplaySec,
  getElapsedSec,
  getFocusSoundPrefs,
  getFocusState,
  fetchTodayFocusLogs,
  deleteFocusLog,
  pauseFocus,
  previewSessionBell,
  readAudioFileAsDataUrl,
  resumeFocus,
  setImmersiveOpen,
  setSessionBell,
  startFocus,
  stopBellPreview,
  stopFocus,
  syncFocusProgressFromServer,
  useFocusState,
  validateBellFile,
  type FocusHistoryEntry,
  type FocusMode,
  type FocusSoundPrefs,
  type SessionBellOverride,
} from './focus-bus'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

const DURATIONS = [5, 10, 15, 20, 25, 30, 45, 60]

/** 本次铃声选项 chip（min-h-11 = 44px 最小触摸区） */
const BELL_CHIP =
  'flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border bg-white px-4 text-sm transition-colors hover:bg-zinc-50'
const BELL_CHIP_ON = 'border-zinc-900 bg-zinc-50 font-semibold'

const BG_PRESETS: { key: string; src: string }[] = [
  { key: 'bg-silk', src: '/focus/bg-silk.png' },
  { key: 'bg-sea', src: '/focus/bg-sea.png' },
  { key: 'bg-grass', src: '/focus/bg-grass.png' },
  { key: 'bg-mountain', src: '/focus/bg-mountain.png' },
  { key: 'bg-beach', src: '/focus/bg-beach.png' },
  { key: 'bg-hill', src: '/focus/bg-hill.png' },
]

/** 会话时长上下限（分钟），与自定义时长 Dialog 的 时:分 范围一致 */
const MIN_MINUTES = 1
const MAX_MINUTES = 23 * 60 + 59

type Step = 'mode' | 'content'
type ManageView = 'list' | 'form'

/** preset key 或 dataURL → 直接可用的 URL；''/未知 → null（银灰渐变兜底） */
function resolveBgUrl(bg: string): string | null {
  if (!bg) return null
  if (bg.startsWith('data:')) return bg
  const preset = BG_PRESETS.find((p) => p.key === bg)
  return preset ? preset.src : null
}

function fmtDurationMin(min: number): string {
  if (min < 60) return `${min} 分钟`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`
}

function timeStr(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function dateStr(at: number): string {
  return new Date(at).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })
}

/** 记录详情用：日期文案（跨天会话显示起止两天） */
function recordDateLabel(e: FocusHistoryEntry): string {
  const startAt = e.at - e.seconds * 1000
  return dateStr(startAt) === dateStr(e.at) ? dateStr(e.at) : `${dateStr(startAt)} → ${dateStr(e.at)}`
}

/** 记录详情用：开始 → 结束 时间段（跨天时结束侧补日期） */
function recordTimeRange(e: FocusHistoryEntry): string {
  const startAt = e.at - e.seconds * 1000
  const endLabel =
    dateStr(startAt) === dateStr(e.at) ? timeStr(e.at) : `${dateStr(e.at)} ${timeStr(e.at)}`
  return `${timeStr(startAt)} → ${endLabel}`
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

/** 数字步进器（自定义时长 Dialog 的 时/分 用）——函数式更新，连点不丢帧 */
function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (update: (v: number) => number) => void
}) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-xl border p-2">
      <button
        type="button"
        aria-label={`增加${label}`}
        disabled={value >= max}
        onClick={() => onChange((v) => Math.min(max, v + 1))}
        className="grid size-8 place-items-center rounded-full transition-colors hover:bg-zinc-100 disabled:opacity-30"
      >
        <Plus className="size-4 text-zinc-700" strokeWidth={1.75} />
      </button>
      <span className="text-2xl font-bold tabular-nums">{value}</span>
      <button
        type="button"
        aria-label={`减少${label}`}
        disabled={value <= min}
        onClick={() => onChange((v) => Math.max(min, v - 1))}
        className="grid size-8 place-items-center rounded-full transition-colors hover:bg-zinc-100 disabled:opacity-30"
      >
        <Minus className="size-4 text-zinc-700" strokeWidth={1.75} />
      </button>
      <span className="text-xs text-zinc-400">{label}</span>
    </div>
  )
}

interface FocusAppProps {
  onBack: () => void
}

export function FocusApp({ onBack }: FocusAppProps) {
  // ---------- 专注总线（全局计时状态） ----------
  const st = useFocusState()
  const running = st.running

  // ---------- 数据 ----------
  const [items, setItems] = React.useState<FocusContentData[]>([])
  const [loading, setLoading] = React.useState(true)
  const [history, setHistory] = React.useState<FocusHistoryEntry[]>([])
  // 今日记录详情 Dialog（服务端记录，可单条删除）
  const [entryDetail, setEntryDetail] = React.useState<FocusHistoryEntry | null>(null)
  const [deletingLog, setDeletingLog] = React.useState(false)
  /** 全局统计（含自由专注），来自 /api/focus totals */
  const [totals, setTotals] = React.useState<{
    todaySeconds: number
    totalSeconds: number
    focusCount: number
  } | null>(null)

  // ---------- 入口两步 ----------
  const [step, setStep] = React.useState<Step>('mode')
  const [mode, setMode] = React.useState<FocusMode>('countdown')
  const [selected, setSelected] = React.useState<FocusContentData | null>(null)
  const [durationMin, setDurationMin] = React.useState(25)
  const [goalOn, setGoalOn] = React.useState(true)
  const [overlay, setOverlay] = React.useState(false)

  // ---------- 自定义时长 Dialog ----------
  const [customOpen, setCustomOpen] = React.useState(false)
  const [customH, setCustomH] = React.useState(0)
  const [customM, setCustomM] = React.useState(25)
  const [unlimited, setUnlimited] = React.useState(false)

  // ---------- 管理预设 Dialog ----------
  const [manageOpen, setManageOpen] = React.useState(false)
  const [manageView, setManageView] = React.useState<ManageView>('list')
  const [editing, setEditing] = React.useState<FocusContentData | null>(null)
  const [name, setName] = React.useState('')
  const [mMinutes, setMMinutes] = React.useState(25)
  const [bg, setBg] = React.useState('')
  const [localBg, setLocalBg] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  // ---------- 本次结束铃声（会话级覆盖；null = 跟随默认） ----------
  const [bellSel, setBellSel] = React.useState<SessionBellOverride | null>(null)
  /** 默认铃声（浮时钟详情 / 「时间到了」弹窗里可改，SOUND 事件同步刷新） */
  const [soundPrefs, setSoundPrefs] = React.useState<FocusSoundPrefs | null>(null)
  /** 最近可用的自定义铃声 dataURL（本次上传 / 默认为自定义时），供「自定义铃声」选项使用 */
  const [customBellUrl, setCustomBellUrl] = React.useState('')

  const fetchList = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/focus?tzOffset=${new Date().getTimezoneOffset()}`)
      if (!res.ok) throw new Error('加载专注内容失败')
      const data = (await res.json()) as {
        contents?: FocusContentData[]
        totals?: { todaySeconds: number; totalSeconds: number; focusCount: number } | null
      }
      setItems(data.contents ?? [])
      setTotals(data.totals ?? null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载专注内容失败')
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshLocal = React.useCallback(() => {
    void fetchTodayFocusLogs().then(setHistory)
  }, [])

  React.useEffect(() => {
    void fetchList()
    refreshLocal()
    // 进入专注视图：拉取云端进度（focus:progress）—— 本地无进行中会话时恢复，
    // 与本地冲突时以 updatedAt 较新者为准
    void syncFocusProgressFromServer()
  }, [fetchList, refreshLocal])

  // 默认铃声（挂载时读取；浮时钟里修改后经 SOUND 事件刷新）+ 离开时停掉试听
  React.useEffect(() => {
    const loadPrefs = () => {
      const p = getFocusSoundPrefs()
      setSoundPrefs(p)
      setCustomBellUrl((u) => u || p.dataUrl)
    }
    loadPrefs()
    window.addEventListener(FOCUS_BUS_EVENTS.SOUND, loadPrefs)
    return () => {
      window.removeEventListener(FOCUS_BUS_EVENTS.SOUND, loadPrefs)
      stopBellPreview()
    }
  }, [])

  // 全屏遮罩 ↔ 浮时钟协调（遮罩打开时隐藏右下角圆钮）
  React.useEffect(() => {
    setImmersiveOpen(overlay)
    return () => {
      setImmersiveOpen(false)
    }
  }, [overlay])

  // 会话结束（含到点自动结束 / 其他标签页结束）→ 收起遮罩 + 刷新统计与今日记录
  const prevRunning = React.useRef(running)
  React.useEffect(() => {
    if (prevRunning.current && !running) {
      setOverlay(false)
      void fetchList()
      refreshLocal()
    }
    prevRunning.current = running
  }, [running, fetchList, refreshLocal])

  // 日志写入服务器后再刷新一次统计（上面的刷新可能早于 /api/focus/log 完成）
  React.useEffect(() => {
    const onLogged = () => void fetchList()
    window.addEventListener(FOCUS_BUS_EVENTS.LOGGED, onLogged)
    return () => window.removeEventListener(FOCUS_BUS_EVENTS.LOGGED, onLogged)
  }, [fetchList])

  // 浮时钟详情「全屏计时」→ 页面切到本视图后打开全屏遮罩；
  // 若事件先于本组件挂载派发（用户在其他视图点击），用 consumeOpenFocusRequest 补收。
  // ⚠️ 挂载着的监听器也必须 consume 掉时间戳：否则「pill 点击打开遮罩→X 最小化→
  // 5 秒内离开再回到专注视图」时，挂载补收会吃到陈旧请求把遮罩自动弹回（X「退不出去」）。
  React.useEffect(() => {
    const onOpenFocus = () => {
      consumeOpenFocusRequest()
      if (getFocusState().running) setOverlay(true)
    }
    window.addEventListener('sb-open-focus', onOpenFocus)
    if (consumeOpenFocusRequest()) onOpenFocus()
    return () => window.removeEventListener('sb-open-focus', onOpenFocus)
  }, [])

  // 全屏计时锁定背景滚动（仅本页遮罩期间）
  React.useEffect(() => {
    if (!overlay) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [overlay])

  // ---------- 统计（/api/focus 聚合；totals 含自由专注） ----------
  const todayMin = React.useMemo(() => {
    if (totals) return Math.round(totals.todaySeconds / 60)
    return Math.round(items.reduce((a, c) => a + (c.todaySeconds || 0), 0) / 60)
  }, [items, totals])
  const totalCount = React.useMemo(() => {
    if (totals) return totals.focusCount
    return items.reduce((a, c) => a + (c.focusCount || 0), 0)
  }, [items, totals])

  // 正在进行的会话对应的内容（回到本页后也能找回背景图）
  const activeContent = React.useMemo(
    () => items.find((c) => c.id === st.contentId) ?? selected,
    [items, st.contentId, selected],
  )

  // ---------- 开始 / 结束 ----------
  const targetSec =
    mode === 'countdown' || goalOn ? Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, durationMin)) * 60 : undefined

  const startSession = () => {
    startFocus({
      mode,
      targetSec,
      contentName: selected?.name ?? '自由专注',
      contentId: selected?.id,
    })
    // 本次结束铃声 → 会话级覆盖（不写入默认设置；null = 跟随默认）
    setSessionBell(bellSel)
    setBellSel(null) // 消费后复位：下次开始默认跟随
    stopBellPreview() // 停掉试听残留，避免与到点铃声叠加
    setOverlay(true)
  }

  const minimize = () => {
    // 显式同步浮时钟协调标记：先派发 IMMERSIVE=false，让右下角浮时钟 pill 立刻可见，
    // 再收起全屏遮罩。避免仅靠 useEffect 异步触发导致「点了没反应 / 看不到 pill」的体验。
    setImmersiveOpen(false)
    setOverlay(false)
    // X = 最小化并离开专注设置页（回到之前所在页面），只留右下角浮时钟；
    // 之前收起遮罩后仍停留在专注设置页，用户感觉「点了 X 又回到专注页面、退不出去」。
    onBack()
    toast('专注已最小化，右下角浮时钟可随时查看', {
      description: '点击浮时钟即可回到全屏计时',
    })
  }

  // ---------- 自定义时长 ----------
  const openCustom = () => {
    const d = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, durationMin))
    setCustomH(Math.floor(d / 60))
    setCustomM(d % 60)
    setUnlimited(mode === 'countup' && !goalOn)
    setCustomOpen(true)
  }

  const confirmCustom = () => {
    const total = customH * 60 + customM
    if (total < MIN_MINUTES) {
      toast.error('时长至少 1 分钟')
      return
    }
    setDurationMin(Math.min(MAX_MINUTES, total))
    if (mode === 'countup') setGoalOn(!unlimited)
    setCustomOpen(false)
  }

  // ---------- 预设管理 ----------
  const openManage = () => {
    setManageView('list')
    setManageOpen(true)
  }

  const openForm = (c: FocusContentData | null) => {
    setEditing(c)
    setName(c?.name ?? '')
    setMMinutes(c?.minutes ?? 25)
    setBg(c?.bg ?? '')
    setLocalBg(c && c.bg.startsWith('data:') ? c.bg : null)
    setManageView('form')
  }

  const savePreset = async () => {
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    try {
      const payload = { name: trimmed.slice(0, 30), minutes: mMinutes, bg }
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
      setManageView('list')
      void fetchList()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const movePreset = async (index: number, dir: -1 | 1) => {
    const j = index + dir
    if (j < 0 || j >= items.length) return
    const next = [...items]
    const tmp = next[index]
    next[index] = next[j]
    next[j] = tmp
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
      if (selected?.id === c.id) setSelected(null)
      toast.success('已删除')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
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

  /** 上传本次铃声（仅会话级，不改动默认铃声；上传成功即试听） */
  const onPickBellFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const err = validateBellFile(file)
    if (err) {
      toast.error(err)
      return
    }
    try {
      const dataUrl = await readAudioFileAsDataUrl(file)
      setCustomBellUrl(dataUrl)
      const next: SessionBellOverride = { kind: 'custom', dataUrl }
      setBellSel(next)
      previewSessionBell(next) // 上传成功即试听
      toast.success('已设为本次结束铃声', {
        description: '如需长期使用，可在专注时的浮时钟里设为默认铃声',
      })
    } catch (err2) {
      toast.error(err2 instanceof Error ? err2.message : '上传音频失败')
    }
  }

  // ---------- 展示用 ----------
  const displaySec = getDisplaySec(st)
  const elapsedSec = getElapsedSec(st)
  const modeLabel = mode === 'countdown' ? '倒计时' : '正计时'
  const overlayBgUrl = resolveBgUrl(activeContent?.bg ?? '')
  const goalActive = mode === 'countdown' || goalOn

  // 「跟随默认」提示用的当前默认铃声名（soundPrefs 为 null 时避免 SSR 首帧读写 localStorage）
  const defaultBellName = soundPrefs
    ? soundPrefs.enabled
      ? soundPrefs.dataUrl
        ? '自定义铃声'
        : (FOCUS_BUILTIN_SOUNDS.find((s) => s.key === soundPrefs.builtin)?.label ?? '琶音')
      : '已关闭'
    : ''

  // ============================================================
  // 渲染
  // ============================================================

  return (
    <>
      {/* ---------- 顶栏 ---------- */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="relative mx-auto flex h-14 w-full max-w-2xl items-center px-4">
          <button
            type="button"
            aria-label="返回"
            onClick={
              step === 'mode'
                ? onBack
                : () => {
                    stopBellPreview() // 返回上一步时停掉试听
                    setStep('mode')
                  }
            }
            className="shrink-0 rounded-full p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="size-6 text-foreground" strokeWidth={1.75} />
          </button>
          <h1 className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-lg font-bold">
            {step === 'mode' ? '专注' : '选择专注内容'}
          </h1>
        </div>
      </header>

      {/* ---------- 主体 ---------- */}
      <main className="min-w-0 flex-1 bg-muted/40">
        <div className="mx-auto w-full max-w-2xl px-4 py-5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-24 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
              <span className="text-sm">加载中…</span>
            </div>
          ) : (
            <>
              {running ? (
                /* ===== 专注进行中：横幅（可最小化状态） ===== */
                <div className="rounded-3xl bg-zinc-900 p-5 text-white shadow-sm">
                  <div className="flex items-center gap-2">
                    {!st.paused && (
                      <span className="relative flex size-2">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                        <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                      </span>
                    )}
                    <span className="text-sm text-white/70">正在专注</span>
                    <span className="ml-auto text-xs text-white/50">
                      {st.mode === 'countdown' ? '倒计时' : '正计时'}
                      {st.paused ? ' · 已暂停' : ''}
                    </span>
                  </div>
                  <div className="mt-2 flex items-end justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-lg font-bold">{st.contentName || '自由专注'}</p>
                      <p className="text-xs text-white/50">计时在后台继续，可以去背书等任何页面</p>
                    </div>
                    <p className="shrink-0 text-4xl font-bold leading-none tabular-nums">{fmtClock(displaySec)}</p>
                  </div>
                  <div className="mt-4 flex gap-2">
                    <button
                      type="button"
                      onClick={() => setOverlay(true)}
                      className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-white text-sm font-semibold text-zinc-900 transition-colors hover:bg-white/90"
                    >
                      <Play className="size-4" strokeWidth={1.75} />
                      回到计时
                    </button>
                    <button
                      type="button"
                      onClick={() => void stopFocus(true)}
                      className="h-11 flex-1 rounded-full bg-white/10 text-sm font-medium text-white transition-colors hover:bg-white/20"
                    >
                      结束并保存
                    </button>
                  </div>
                </div>
              ) : step === 'mode' ? (
                /* ===== 第一步：选择计时方式 ===== */
                <div>
                  <p className="text-sm text-muted-foreground">第一步 · 选择计时方式</p>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setMode('countup')
                        setStep('content')
                      }}
                      className="flex h-44 flex-col justify-between rounded-3xl border border-transparent bg-white p-5 text-left shadow-sm transition-all hover:border-zinc-900 active:scale-[0.98]"
                    >
                      <span className="grid size-12 place-items-center rounded-2xl bg-zinc-900 text-white">
                        <ArrowUp className="size-6" strokeWidth={1.75} />
                      </span>
                      <span>
                        <span className="block text-2xl font-bold">正计时</span>
                        <span className="mt-1 block text-sm text-zinc-500">从 0 开始向上累计</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMode('countdown')
                        setStep('content')
                      }}
                      className="flex h-44 flex-col justify-between rounded-3xl border border-transparent bg-white p-5 text-left shadow-sm transition-all hover:border-zinc-900 active:scale-[0.98]"
                    >
                      <span className="grid size-12 place-items-center rounded-2xl bg-zinc-900 text-white">
                        <ArrowDown className="size-6" strokeWidth={1.75} />
                      </span>
                      <span>
                        <span className="block text-2xl font-bold">倒计时</span>
                        <span className="mt-1 block text-sm text-zinc-500">设定时长，倒数到 0</span>
                      </span>
                    </button>
                  </div>
                  <p className="mt-3 text-xs text-zinc-400">选好后第二步可选专注内容（可跳过）</p>
                </div>
              ) : (
                /* ===== 第二步：选择专注内容（可选） ===== */
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-muted-foreground">
                    第二步 · 选择专注内容<span className="text-zinc-400">（可选，不选也能开始）</span>
                  </p>

                  {/* 顶部：自定义时长 + 管理预设 */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={openCustom}
                      className="flex h-10 items-center gap-2 rounded-full border bg-white px-4 text-sm font-medium transition-colors hover:bg-zinc-50"
                    >
                      <Clock3 className="size-4 text-zinc-500" strokeWidth={1.75} />
                      自定义时长
                    </button>
                    <button
                      type="button"
                      onClick={openManage}
                      className="ml-auto flex h-10 items-center gap-1.5 rounded-full border bg-white px-4 text-sm font-medium transition-colors hover:bg-zinc-50"
                    >
                      <Settings2 className="size-4 text-zinc-500" strokeWidth={1.75} />
                      管理预设
                    </button>
                  </div>

                  {/* 不选，直接开始 */}
                  <button
                    type="button"
                    aria-pressed={selected === null}
                    onClick={() => setSelected(null)}
                    className={cn(
                      'flex items-center gap-3 rounded-2xl border-2 border-dashed p-4 text-left transition-colors',
                      selected === null ? 'border-zinc-900 bg-zinc-50' : 'border-zinc-300 bg-white',
                    )}
                  >
                    <span className="grid size-10 shrink-0 place-items-center rounded-full bg-zinc-900 text-white">
                      <Play className="size-4" strokeWidth={1.75} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-bold">不选，直接开始</span>
                      <span className="block text-xs text-zinc-500">跳过内容选择，随时开始专注</span>
                    </span>
                    {selected === null && <Check className="size-5 shrink-0 text-zinc-900" strokeWidth={2} />}
                  </button>

                  {/* 预设卡片 */}
                  {items.map((c) => {
                    const active = selected?.id === c.id
                    return (
                      <button
                        key={c.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => {
                          setSelected(c)
                          setDurationMin(Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, c.minutes)))
                        }}
                        className={cn(
                          'flex items-center gap-3 rounded-2xl border-2 bg-white p-4 text-left transition-all',
                          active ? 'border-zinc-900 ring-2 ring-zinc-900/10' : 'border-transparent shadow-sm',
                        )}
                      >
                        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-zinc-100 text-sm font-bold text-zinc-700">
                          {c.minutes}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-bold">{c.name}</span>
                          <span className="block text-xs text-zinc-500">
                            默认 {fmtDurationMin(c.minutes)} · 今日 {Math.round((c.todaySeconds || 0) / 60)} 分钟
                          </span>
                        </span>
                        {active && <Check className="size-5 shrink-0 text-zinc-900" strokeWidth={2} />}
                      </button>
                    )
                  })}

                  {items.length === 0 && (
                    <div className="rounded-2xl border-2 border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500">
                      还没有专注内容，点右上角「管理预设」新建，或直接「不选，直接开始」
                    </div>
                  )}

                  {/* 本次时长（正计时 = 目标时长） */}
                  <div className="rounded-2xl border bg-white p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm text-muted-foreground">
                        {mode === 'countdown'
                          ? '本次倒数时长'
                          : goalOn
                            ? '目标时长（到点提醒）'
                            : '正计时不限时'}
                      </span>
                      <button
                        type="button"
                        onClick={openCustom}
                        className="text-sm font-medium text-zinc-500 underline-offset-2 transition-colors hover:text-zinc-900 hover:underline"
                      >
                        自定义
                      </button>
                    </div>
                    <div className="mt-2 flex items-center justify-center gap-4">
                      <button
                        type="button"
                        aria-label="减少一分钟"
                        disabled={!goalActive || durationMin <= MIN_MINUTES}
                        onClick={() => {
                          setDurationMin((m) => Math.max(MIN_MINUTES, m - 1))
                          if (mode === 'countup') setGoalOn(true)
                        }}
                        className="grid size-9 place-items-center rounded-full border transition-colors hover:bg-zinc-50 disabled:opacity-30"
                      >
                        <Minus className="size-4 text-zinc-700" strokeWidth={1.75} />
                      </button>
                      <span className="min-w-24 text-center text-2xl font-bold tabular-nums">
                        {goalActive ? fmtDurationMin(durationMin) : '不限时'}
                      </span>
                      <button
                        type="button"
                        aria-label="增加一分钟"
                        disabled={!goalActive || durationMin >= MAX_MINUTES}
                        onClick={() => {
                          setDurationMin((m) => Math.min(MAX_MINUTES, m + 1))
                          if (mode === 'countup') setGoalOn(true)
                        }}
                        className="grid size-9 place-items-center rounded-full border transition-colors hover:bg-zinc-50 disabled:opacity-30"
                      >
                        <Plus className="size-4 text-zinc-700" strokeWidth={1.75} />
                      </button>
                    </div>
                    {mode === 'countup' && (
                      <div className="mt-3 flex items-center justify-center gap-2">
                        <Switch
                          checked={goalOn}
                          onCheckedChange={(v: boolean) => setGoalOn(v)}
                          aria-label="到点提醒开关"
                        />
                        <span className="text-xs text-zinc-500">到点提醒（达到目标时长自动结束）</span>
                      </div>
                    )}
                  </div>

                  {/* 本次结束铃声（会话级覆盖，点选即试听，不写入默认设置） */}
                  <div className="rounded-2xl border bg-white p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <Bell className="size-4 text-zinc-500" strokeWidth={1.75} />
                        本次结束铃声
                      </span>
                      <span className="text-xs text-zinc-400">
                        {bellSel
                          ? describeBellChoice(bellSel)
                          : defaultBellName
                            ? `跟随默认 · ${defaultBellName}`
                            : '跟随默认'}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        aria-pressed={bellSel === null}
                        onClick={() => {
                          setBellSel(null)
                          previewSessionBell(null)
                        }}
                        className={cn(BELL_CHIP, bellSel === null && BELL_CHIP_ON)}
                      >
                        跟随默认
                      </button>
                      {FOCUS_BUILTIN_SOUNDS.map((b) => {
                        const active = bellSel?.kind === 'builtin' && bellSel.key === b.key
                        return (
                          <button
                            key={b.key}
                            type="button"
                            aria-pressed={active}
                            onClick={() => {
                              const next: SessionBellOverride = { kind: 'builtin', key: b.key }
                              setBellSel(next)
                              previewSessionBell(next)
                            }}
                            className={cn(BELL_CHIP, active && BELL_CHIP_ON)}
                          >
                            {b.label}
                          </button>
                        )
                      })}
                      {(customBellUrl || soundPrefs?.dataUrl) && (
                        <button
                          type="button"
                          aria-pressed={bellSel?.kind === 'custom'}
                          onClick={() => {
                            const url = customBellUrl || soundPrefs?.dataUrl
                            if (!url) return
                            const next: SessionBellOverride = { kind: 'custom', dataUrl: url }
                            setBellSel(next)
                            previewSessionBell(next)
                          }}
                          className={cn(BELL_CHIP, bellSel?.kind === 'custom' && BELL_CHIP_ON)}
                        >
                          <Music className="size-4 text-zinc-500" strokeWidth={1.75} />
                          自定义铃声
                        </button>
                      )}
                      <button
                        type="button"
                        aria-pressed={bellSel?.kind === 'silent'}
                        onClick={() => {
                          const next: SessionBellOverride = { kind: 'silent' }
                          setBellSel(next)
                          previewSessionBell(next)
                        }}
                        className={cn(BELL_CHIP, bellSel?.kind === 'silent' && BELL_CHIP_ON)}
                      >
                        <BellOff className="size-4 text-zinc-500" strokeWidth={1.75} />
                        静音
                      </button>
                      <label className={cn(BELL_CHIP, 'cursor-pointer border-dashed')}>
                        <Upload className="size-4 text-zinc-500" strokeWidth={1.75} />
                        上传
                        <input
                          type="file"
                          accept="audio/*"
                          className="hidden"
                          aria-label="上传本次铃声"
                          onChange={(e) => void onPickBellFile(e)}
                        />
                      </label>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-zinc-400">
                      {bellSel === null
                        ? '不选则跟随默认铃声，点选即试听'
                        : '仅本次专注生效，不改动默认铃声，点选即试听'}
                      ；默认铃声可在专注时的右下角浮时钟里修改
                    </p>
                  </div>

                  {/* 开始按钮：黑色大胶囊 */}
                  <button
                    type="button"
                    onClick={startSession}
                    className="mt-1 h-14 w-full rounded-full bg-zinc-900 text-lg font-medium text-white shadow-sm transition-transform active:scale-[0.98]"
                  >
                    开始专注
                  </button>
                </div>
              )}

              {/* ===== 统计（首页/横幅页展示） ===== */}
              {step === 'mode' && (
                <section className="mt-8">
                  <h2 className="mb-3 text-sm font-semibold text-zinc-500">专注统计</h2>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-2xl bg-white p-4 shadow-sm">
                      <p className="text-xs text-zinc-500">今日专注</p>
                      <p className="mt-1 text-2xl font-bold tabular-nums">
                        {todayMin}
                        <span className="ml-1 text-sm font-medium text-zinc-500">分钟</span>
                      </p>
                    </div>
                    <div className="rounded-2xl bg-white p-4 shadow-sm">
                      <p className="text-xs text-zinc-500">累计专注</p>
                      <p className="mt-1 text-2xl font-bold tabular-nums">
                        {totalCount}
                        <span className="ml-1 text-sm font-medium text-zinc-500">次</span>
                      </p>
                    </div>
                  </div>

                  <h2 className="mb-3 mt-6 text-sm font-semibold text-zinc-500">今日记录</h2>
                  <div className="overflow-hidden rounded-2xl bg-white shadow-sm">
                    {history.length === 0 ? (
                      <p className="p-5 text-center text-sm text-zinc-400">今天还没有专注记录</p>
                    ) : (
                      history
                        .slice()
                        .reverse()
                        .map((e, i) => (
                          <button
                            key={`${e.at}-${i}`}
                            type="button"
                            aria-label={`查看「${e.name}」的专注详情`}
                            onClick={() => setEntryDetail(e)}
                            className={cn(
                              'flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left transition-colors hover:bg-accent/50',
                              i > 0 && 'border-t',
                            )}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">{e.name}</span>
                              <span className="block text-xs text-zinc-400">{timeStr(e.at)} 结束</span>
                            </span>
                            <span className="shrink-0 text-sm font-semibold tabular-nums">
                              {fmtDurHuman(e.seconds)}
                            </span>
                            <ChevronRight className="size-4 shrink-0 text-zinc-300" strokeWidth={1.75} />
                          </button>
                        ))
                    )}
                  </div>
                  <p className="mt-2 text-center text-[11px] text-zinc-400">
                    点击记录可查看详情 · 专注记录云端同步，多设备可见
                  </p>
                </section>
              )}
            </>
          )}
        </div>
      </main>

      {/* ---------- 全屏计时遮罩（不锁死：可最小化） ---------- */}
      {overlay && running && (
        <div
          className="fixed inset-0 z-50 overflow-hidden bg-zinc-900"
          role="timer"
          aria-label="专注计时中"
        >
          {overlayBgUrl && (
            <img
              src={overlayBgUrl}
              alt=""
              onError={hideImgOnError}
              className="absolute inset-0 h-full w-full object-cover"
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/40 to-black/60" />

          {/* 关闭遮罩（X 按钮：收起全屏遮罩，计时后台继续）
              ⚠️ 层叠修复：此按钮必须高于中央内容层（同 z-index 时 DOM 靠后者拦截点击），
              且中央内容层需 pointer-events-none，否则 X 可见但点不到 */}
          <button
            type="button"
            onClick={minimize}
            aria-label="关闭全屏计时（后台继续计时）"
            className="absolute left-4 top-4 z-30 flex size-12 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20"
          >
            <X className="size-5" strokeWidth={2} />
          </button>

          <div className="pointer-events-none relative z-10 flex h-full flex-col items-center justify-center px-6 pb-28">
            <p className="max-w-full truncate text-base font-medium text-white/70">
              {st.contentName || '自由专注'}
            </p>
            <div className="mt-4 text-6xl font-bold tabular-nums text-white sm:text-7xl">
              {fmtClock(displaySec)}
            </div>
            <p className="mt-3 text-sm text-white/60">
              {st.mode === 'countdown'
                ? `倒计时 · 已专注 ${fmtClock(elapsedSec)}`
                : st.targetSec
                  ? `正计时 · 目标 ${fmtClock(st.targetSec)}`
                  : '正计时不限时'}
              {st.paused ? ' · 已暂停' : ''}
            </p>
          </div>

          {/* 暂停 / 结束 */}
          <div className="absolute inset-x-0 bottom-12 z-20 flex justify-center gap-3 px-6">
            <button
              type="button"
              onClick={st.paused ? resumeFocus : pauseFocus}
              className="h-12 w-32 rounded-full bg-white/10 text-base font-medium text-white backdrop-blur transition-colors hover:bg-white/20"
            >
              {st.paused ? '继续' : '暂停'}
            </button>
            <button
              type="button"
              onClick={() => void stopFocus(true)}
              className="h-12 w-32 rounded-full bg-white text-base font-semibold text-zinc-900 transition-colors hover:bg-white/90"
            >
              结束并保存
            </button>
          </div>
          <p className="pointer-events-none absolute inset-x-0 bottom-3 z-20 text-center text-xs text-white/70 drop-shadow">
            点左上角 ✕ 收起（计时后台继续），右下角浮时钟可随时返回
          </p>
        </div>
      )}

      {/* ---------- 自定义时长 Dialog ---------- */}
      <Dialog open={customOpen} onOpenChange={setCustomOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto rounded-2xl sm:max-w-xs">
          <DialogHeader className="pr-10">
            <DialogTitle>自定义时长</DialogTitle>
            <DialogDescription>
              {mode === 'countdown' ? '本次倒计时的倒数时长' : '正计时的目标时长，到点自动结束'}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <Stepper label="时" value={customH} min={0} max={23} onChange={setCustomH} />
            <Stepper label="分" value={customM} min={0} max={59} onChange={setCustomM} />
          </div>
          <p className="text-center text-sm text-zinc-500">共 {customH * 60 + customM} 分钟</p>

          <div className="flex flex-wrap justify-center gap-2">
            {[15, 25, 45, 60, 90].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => {
                  setCustomH(Math.floor(d / 60))
                  setCustomM(d % 60)
                }}
                className={cn(
                  'shrink-0 rounded-full border px-3 py-1.5 text-sm transition-colors hover:bg-zinc-50',
                  customH * 60 + customM === d && 'border-zinc-900 font-semibold',
                )}
              >
                {d} 分钟
              </button>
            ))}
          </div>

          {mode === 'countup' && (
            <label className="flex items-center justify-between rounded-xl border p-3">
              <span className="text-sm">不限时（不设目标）</span>
              <Switch checked={unlimited} onCheckedChange={(v: boolean) => setUnlimited(v)} />
            </label>
          )}

          <button
            type="button"
            onClick={confirmCustom}
            disabled={customH * 60 + customM < MIN_MINUTES}
            className="h-12 w-full rounded-full bg-zinc-900 font-medium text-white transition-transform active:scale-[0.98] disabled:opacity-40"
          >
            确定
          </button>
        </DialogContent>
      </Dialog>

      {/* ---------- 管理预设 Dialog ---------- */}
      <Dialog
        open={manageOpen}
        onOpenChange={(o) => {
          setManageOpen(o)
          if (!o) setManageView('list')
        }}
      >
        {/* grid-rows 三段式：标题 / 可滚动内容 / 底部操作 —— 内容超高时底部按钮始终可见 */}
        <DialogContent className="grid max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-2xl sm:max-w-md">
          {manageView === 'list' ? (
            <>
              <DialogHeader className="pr-10">
                <DialogTitle>管理专注内容</DialogTitle>
                <DialogDescription>新建、编辑、排序或删除专注内容预设</DialogDescription>
              </DialogHeader>
              <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
                {items.map((c, i) => (
                  <div key={c.id} className="flex items-center gap-1.5 rounded-xl border p-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{c.name}</p>
                      <p className="text-xs text-zinc-500">默认 {fmtDurationMin(c.minutes)}</p>
                    </div>
                    <button
                      type="button"
                      aria-label={`上移 ${c.name}`}
                      disabled={i === 0}
                      onClick={() => void movePreset(i, -1)}
                      className="grid size-8 shrink-0 place-items-center rounded-full transition-colors hover:bg-zinc-100 disabled:opacity-30"
                    >
                      <ChevronUp className="size-4 text-zinc-600" strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      aria-label={`下移 ${c.name}`}
                      disabled={i === items.length - 1}
                      onClick={() => void movePreset(i, 1)}
                      className="grid size-8 shrink-0 place-items-center rounded-full transition-colors hover:bg-zinc-100 disabled:opacity-30"
                    >
                      <ChevronDown className="size-4 text-zinc-600" strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      aria-label={`编辑 ${c.name}`}
                      onClick={() => openForm(c)}
                      className="grid size-8 shrink-0 place-items-center rounded-full transition-colors hover:bg-zinc-100"
                    >
                      <SquarePen className="size-4 text-zinc-600" strokeWidth={1.75} />
                    </button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <button
                          type="button"
                          aria-label={`删除 ${c.name}`}
                          className="grid size-8 shrink-0 place-items-center rounded-full transition-colors hover:bg-zinc-100"
                        >
                          <Trash2 className="size-4 text-zinc-600" strokeWidth={1.75} />
                        </button>
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
                ))}
                {items.length === 0 && (
                  <p className="py-6 text-center text-sm text-zinc-400">还没有专注内容</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => openForm(null)}
                className="h-11 w-full rounded-full bg-zinc-900 text-sm font-medium text-white transition-transform active:scale-[0.98]"
              >
                ＋ 新建专注内容
              </button>
            </>
          ) : (
            <>
              <DialogHeader className="pr-10">
                <DialogTitle>{editing ? '编辑专注内容' : '新建专注内容'}</DialogTitle>
              </DialogHeader>

              <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
                <input
                  value={name}
                  maxLength={30}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="专注内容名称，如：背第一章"
                  aria-label="专注内容名称"
                  className="h-11 w-full shrink-0 rounded-xl border bg-background px-3 text-base outline-none placeholder:text-zinc-400 focus-visible:ring-2 focus-visible:ring-ring"
                />

                <div>
                  <p className="mb-2 text-sm text-muted-foreground">默认专注时长</p>
                  <div className="flex flex-wrap gap-2">
                    {DURATIONS.map((d) => (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={mMinutes === d}
                        onClick={() => setMMinutes(d)}
                        className={cn(
                          'flex h-10 shrink-0 items-center rounded-xl border bg-white px-4 text-sm transition-colors',
                          mMinutes === d
                            ? 'border-zinc-900 font-semibold ring-2 ring-zinc-900/10'
                            : 'border-zinc-200 text-foreground',
                        )}
                      >
                        {d}min
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="mb-2 text-sm text-muted-foreground">选择背景（全屏计时展示）</p>
                  <div className="grid grid-cols-3 gap-3">
                    <label
                      className={cn(
                        'relative flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 overflow-hidden rounded-xl border-2 text-zinc-500 transition',
                        localBg && bg === localBg
                          ? 'border-zinc-900'
                          : 'border-dashed border-zinc-300 hover:border-zinc-400',
                      )}
                    >
                      {localBg ? (
                        <img
                          src={localBg}
                          alt="自定义背景"
                          onError={hideImgOnError}
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      ) : (
                        <>
                          <Plus className="size-5" strokeWidth={1.75} />
                          <span className="text-xs">本地图</span>
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
                    {BG_PRESETS.map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        aria-label={`背景 ${p.key}`}
                        aria-pressed={bg === p.key}
                        onClick={() => setBg(p.key)}
                        className={cn(
                          'relative aspect-square overflow-hidden rounded-xl border-2 transition',
                          bg === p.key ? 'border-zinc-900' : 'border-transparent',
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
                    <button
                      type="button"
                      aria-label="无背景"
                      aria-pressed={bg === ''}
                      onClick={() => setBg('')}
                      className={cn(
                        'flex aspect-square items-center justify-center overflow-hidden rounded-xl border-2 bg-gradient-to-br from-zinc-100 to-zinc-200 text-xs text-zinc-500 transition',
                        bg === '' ? 'border-zinc-900' : 'border-transparent',
                      )}
                    >
                      无背景
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => setManageView('list')}
                  className="h-11 flex-1 rounded-full border text-sm font-medium transition-colors hover:bg-zinc-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void savePreset()}
                  disabled={!name.trim() || saving}
                  className="h-11 flex-1 rounded-full bg-zinc-900 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-40"
                >
                  {saving ? <Loader2 className="mx-auto size-4 animate-spin" /> : '保存'}
                </button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ---------- 今日记录详情 Dialog ---------- */}
      {/* 说明：记录已服务端持久化，支持单条删除 */}
      <Dialog
        open={entryDetail !== null}
        onOpenChange={(o) => {
          if (!o) setEntryDetail(null)
        }}
      >
        <DialogContent className="rounded-2xl sm:max-w-sm">
          {entryDetail && (
            <>
              <DialogHeader className="pr-10">
                <DialogTitle>专注记录详情</DialogTitle>
                <DialogDescription>本次专注会话的详细信息</DialogDescription>
              </DialogHeader>
              <div className="rounded-2xl bg-zinc-900 p-4 text-white">
                <p className="truncate text-base font-bold">{entryDetail.name || '自由专注'}</p>
                <p className="mt-1 text-3xl font-bold tabular-nums">{fmtDurHuman(entryDetail.seconds)}</p>
              </div>
              <dl className="flex flex-col gap-2.5 rounded-2xl border p-4 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground">日期</dt>
                  <dd className="text-right font-medium">{recordDateLabel(entryDetail)}</dd>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground">时间</dt>
                  <dd className="text-right font-medium tabular-nums">{recordTimeRange(entryDetail)}</dd>
                </div>
                <div className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground">时长</dt>
                  <dd className="text-right font-semibold tabular-nums">{fmtDurHuman(entryDetail.seconds)}</dd>
                </div>
              </dl>
              <div className="flex items-center justify-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 flex-1 rounded-full text-red-600 hover:bg-red-50 hover:text-red-700"
                  disabled={!entryDetail.id || deletingLog}
                  onClick={() => {
                    if (!entryDetail.id) return
                    void (async () => {
                      setDeletingLog(true)
                      const ok = await deleteFocusLog(entryDetail.id as string)
                      setDeletingLog(false)
                      if (ok) {
                        toast.success('已删除记录')
                        setEntryDetail(null)
                        refreshLocal()
                        void fetchList()
                      }
                    })()
                  }}
                >
                  {deletingLog ? <Loader2 className="size-4 animate-spin" /> : '删除记录'}
                </Button>
              </div>
              <p className="text-center text-[11px] text-zinc-400">专注记录云端同步，多设备可见</p>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
