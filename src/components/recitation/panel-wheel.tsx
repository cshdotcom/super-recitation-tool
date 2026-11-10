'use client'

// 转盘抽背 (WheelPanel) — 背书匠-style spin wheel recitation tool.
//
// Data model (persisted per card via /api/state KV):
//   `wheel:<cardId>`  (cardId '' -> `wheel:global`)
//     -> { wheels: [{ id, name, items: [{ id, text, enabled, star }] }], currentId }
//   `wheel:done:<cardId>:<wheelId>` -> { [YYYYMMDD]: string[] }
//     （done 标记按转盘隔离；旧整卡共享 key `wheel:done:<cardId>` 只读迁移）
//
// Views: main (wheel + spin + result), edit (名称/全选/item 列表/添加选项),
// manage (齿轮入口：全部转盘 + 搜索 + 使用/重命名/复制/删除 + 新建)。
// New wheels are created from a source picker: AI 智能分块 / 按段落 / 按空行 /
// 按标点 / 按知识块 / 手动空白菜单；每个来源各自创建独立 wheel，互不覆盖。

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  AlignLeft,
  ArrowLeft,
  Blocks,
  Check,
  ChevronDown,
  Copy,
  Info,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCw,
  Rows3,
  Search,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Type,
  Volume2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import type { CardData, SettingsData } from '@/lib/types'
import { cn } from '@/lib/utils'
import { splitSentences } from '@/lib/sentences'
import { useSettingsLite } from '@/lib/voice-prefs'
import { getState, putState } from '@/lib/server-state'
import { useQuickTts, VoiceSpeedBar } from '@/components/recitation/tts-player'
import { BottomSheet } from '@/components/recitation/bottom-sheet'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'

// ---------------------------------------------------------------------------
// Types & helpers
// ---------------------------------------------------------------------------

interface WheelItem {
  id: string
  text: string
  enabled: boolean
  star: boolean
}

interface WheelDoc {
  id: string
  name: string
  items: WheelItem[]
}

interface WheelState {
  wheels: WheelDoc[]
  currentId: string
}

/** Pastel wedge colors, alternating. */
const WHEEL_COLORS = ['#FFD8A8', '#FFE3E3', '#D4F0D4', '#CFE8FF', '#E6DFF7', '#FFF3B8']
/** Wheel shows at most 12 wedges (spec: between 2 and 12). */
const MAX_WEDGES = 12
/** Items per wheel cap (按句子 explicitly capped at 30; applied to all sources). */
const SOURCE_CAP = 30

/** 转盘文档 key（每个书/卡片一套独立 wheels，互不干扰）。 */
function wheelStateKey(cardId?: string | null): string {
  return `wheel:${cardId || 'global'}`
}

/** done 标记 key：按转盘隔离（wheel:done:<cardId>:<wheelId>）。
 *  不传 wheelId 时返回旧版整卡共享 key（仅用于只读迁移）。 */
function wheelDoneKey(cardId?: string | null, wheelId?: string | null): string {
  const c = cardId || 'global'
  return wheelId ? `wheel:done:${c}:${wheelId}` : `wheel:done:${c}`
}

function todayYmd(): string {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

function uid(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function makeWheel(name: string, texts: string[]): WheelDoc {
  const items = texts
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, SOURCE_CAP)
    .map<WheelItem>((t) => ({ id: uid(), text: t, enabled: true, star: false }))
  return { id: uid(), name, items }
}

/** Defensively parse persisted wheel state; null when missing/corrupt. */
function parseWheelState(raw: string | null | undefined): WheelState | null {
  if (!raw) return null
  let p: unknown
  try {
    p = JSON.parse(raw)
  } catch {
    return null
  }
  if (!p || typeof p !== 'object') return null
  const rawWheels = (p as { wheels?: unknown }).wheels
  if (!Array.isArray(rawWheels)) return null

  const wheels: WheelDoc[] = []
  for (const rw of rawWheels) {
    if (!rw || typeof rw !== 'object') continue
    const o = rw as Record<string, unknown>
    const rawItems = Array.isArray(o.items) ? o.items : []
    const items: WheelItem[] = []
    for (const ri of rawItems) {
      if (!ri || typeof ri !== 'object') continue
      const io = ri as Record<string, unknown>
      if (typeof io.text !== 'string' || !io.text.trim()) continue
      items.push({
        id: typeof io.id === 'string' && io.id ? io.id : uid(),
        text: io.text,
        enabled: io.enabled !== false,
        star: io.star === true,
      })
    }
    wheels.push({
      id: typeof o.id === 'string' && o.id ? o.id : uid(),
      name: typeof o.name === 'string' && o.name ? o.name : '未命名转盘',
      items,
    })
  }
  if (wheels.length === 0) return null
  const cid = (p as { currentId?: unknown }).currentId
  const currentId =
    typeof cid === 'string' && wheels.some((w) => w.id === cid) ? cid : wheels[0].id
  return { wheels, currentId }
}

function parseDoneMap(raw: string | null | undefined): Record<string, string[]> {
  if (!raw) return {}
  try {
    const p = JSON.parse(raw) as unknown
    if (!p || typeof p !== 'object' || Array.isArray(p)) return {}
    const out: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string')
    }
    return out
  } catch {
    return {}
  }
}

function deepCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface WheelPanelProps {
  content: string
  /** Optional explicit settings; falls back to useSettingsLite(). */
  settings?: SettingsData | null
  /** Current card id ('' -> global storage key). */
  cardId?: string
  /** Current card (enables the 按知识块 source). */
  card?: CardData | null
}

type WheelSource = 'ai' | 'para' | 'blank' | 'sent' | 'blocks'

export function WheelPanel({ content, settings, cardId, card }: WheelPanelProps) {
  const settingsLite = useSettingsLite()
  const ttsSettings = settings ?? settingsLite
  const tts = useQuickTts('wheel', ttsSettings)

  const cKey = wheelStateKey(cardId)
  // 旧版整卡共享 done key（只读迁移用）
  const legacyDoneKey = wheelDoneKey(cardId)

  const [state, setState] = React.useState<WheelState | null>(null)
  const [loaded, setLoaded] = React.useState(false)
  const [doneMap, setDoneMap] = React.useState<Record<string, string[]>>({})
  const [view, setView] = React.useState<'main' | 'edit'>('main')
  const [draft, setDraft] = React.useState<WheelDoc | null>(null)
  const [expandedId, setExpandedId] = React.useState<string | null>(null)

  const [rotation, setRotation] = React.useState(0)
  const [spinning, setSpinning] = React.useState(false)
  const [pickedId, setPickedId] = React.useState<string | null>(null)

  // 转盘管理弹窗：搜索 + 全部转盘 CRUD
  const [manageOpen, setManageOpen] = React.useState(false)
  const [manageQuery, setManageQuery] = React.useState('')
  const [newOpen, setNewOpen] = React.useState(false)
  const [manualName, setManualName] = React.useState('')
  const [aiLoading, setAiLoading] = React.useState(false)
  const [renamingId, setRenamingId] = React.useState<string | null>(null)
  const [renameText, setRenameText] = React.useState('')
  const [deletingId, setDeletingId] = React.useState<string | null>(null)

  const nameInputRef = React.useRef<HTMLInputElement>(null)
  const spinTimerRef = React.useRef<number | null>(null)
  const lastPickRef = React.useRef<string | null>(null)

  // Load persisted wheels on mount / card change（done 标记另按当前转盘加载）.
  React.useEffect(() => {
    let alive = true
    if (spinTimerRef.current) window.clearTimeout(spinTimerRef.current)
    setLoaded(false)
    setState(null)
    setDoneMap({})
    setView('main')
    setDraft(null)
    setPickedId(null)
    setRotation(0)
    getState([cKey]).then((vals) => {
      if (!alive) return
      const ws = parseWheelState(vals[cKey])
      if (ws) {
        setState(ws)
      } else {
        // Default wheel: 全文抽背 from sentences (cap 12).
        const wheel = makeWheel('全文抽背', splitSentences(content).slice(0, MAX_WEDGES))
        setState({ wheels: [wheel], currentId: wheel.id })
      }
      setLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [cKey, content])

  // Clear pending spin timer on unmount.
  React.useEffect(() => {
    return () => {
      if (spinTimerRef.current) window.clearTimeout(spinTimerRef.current)
    }
  }, [])

  const persist = React.useCallback(
    (next: WheelState) => {
      setState(next)
      void putState(cKey, JSON.stringify(next))
    },
    [cKey],
  )

  // ------------------------------ done marks（按转盘隔离） ------------------------------
  // key = wheel:done:<cardId>:<wheelId>——切转盘后 done 标记不串；
  // 旧整卡共享 key 只在当前转盘 key 为空时只读迁移（首次标记时写入新 key）。
  const curWheelId = state
    ? (state.wheels.find((w) => w.id === state.currentId)?.id ?? state.wheels[0]?.id ?? null)
    : null
  const curDoneKey = React.useMemo(
    () => (curWheelId ? wheelDoneKey(cardId, curWheelId) : null),
    [cardId, curWheelId],
  )

  React.useEffect(() => {
    let alive = true
    setDoneMap({})
    if (!curDoneKey) return
    getState([curDoneKey, legacyDoneKey]).then((vals) => {
      if (!alive) return
      const perWheel = parseDoneMap(vals[curDoneKey])
      setDoneMap(Object.keys(perWheel).length > 0 ? perWheel : parseDoneMap(vals[legacyDoneKey]))
    })
    return () => {
      alive = false
    }
  }, [curDoneKey, legacyDoneKey])

  const persistDone = React.useCallback(
    (next: Record<string, string[]>) => {
      setDoneMap(next)
      if (curDoneKey) void putState(curDoneKey, JSON.stringify(next))
    },
    [curDoneKey],
  )

  const wheel = state
    ? (state.wheels.find((w) => w.id === state.currentId) ?? state.wheels[0])
    : null
  // 转盘管理弹窗的搜索过滤（按名称或任意词条）
  const manageQueryTrim = manageQuery.trim().toLowerCase()
  const filteredWheels = state
    ? state.wheels.filter(
        (w) =>
          !manageQueryTrim ||
          w.name.toLowerCase().includes(manageQueryTrim) ||
          w.items.some((i) => i.text.toLowerCase().includes(manageQueryTrim)),
      )
    : []
  const enabledItems = React.useMemo(
    () => (wheel ? wheel.items.filter((i) => i.enabled) : []),
    [wheel],
  )
  const wedges = enabledItems.slice(0, MAX_WEDGES)
  const wedgeCount = wedges.length
  const segAngle = wedgeCount > 0 ? 360 / wedgeCount : 360

  const today = todayYmd()
  const doneToday = React.useMemo(() => new Set(doneMap[today] ?? []), [doneMap, today])
  const doneCount = wheel ? wheel.items.filter((i) => doneToday.has(i.id)).length : 0
  const pickedItem = wheel?.items.find((i) => i.id === pickedId) ?? null
  const pickedDone = pickedItem ? doneToday.has(pickedItem.id) : false

  const gradient = React.useMemo(() => {
    if (wedgeCount === 0) return 'conic-gradient(#e4e4e7 0deg 360deg)'
    const stops = wedges.map(
      (_, i) =>
        `${WHEEL_COLORS[i % WHEEL_COLORS.length]} ${i * segAngle}deg ${(i + 1) * segAngle}deg`,
    )
    return `conic-gradient(${stops.join(', ')})`
     
  }, [wedgeCount, segAngle, wheel?.id, wheel?.items.map((i) => i.id).join('|')])

  // ------------------------------ spin ------------------------------

  const spin = React.useCallback(() => {
    if (spinning || wedgeCount === 0) return
    if (tts.speaking) tts.stop()
    setSpinning(true)
    setPickedId(null)

    // Random enabled wedge (avoid repeating the last pick when possible).
    let t = Math.floor(Math.random() * wedgeCount)
    const lastIdx = wedges.findIndex((w) => w.id === lastPickRef.current)
    if (wedgeCount > 1 && t === lastIdx) t = (t + 1) % wedgeCount
    const target = wedges[t]
    lastPickRef.current = target.id

    // Land the target wedge center under the top pointer.
    const center = t * segAngle + segAngle / 2
    const currentMod = ((rotation % 360) + 360) % 360
    const targetMod = (360 - center) % 360
    const delta = (targetMod - currentMod + 360) % 360
    setRotation(rotation + 360 * 5 + delta)

    if (spinTimerRef.current) window.clearTimeout(spinTimerRef.current)
    spinTimerRef.current = window.setTimeout(() => {
      setPickedId(target.id)
      setSpinning(false)
    }, 2650)
  }, [spinning, wedgeCount, wedges, segAngle, rotation, tts])

  // ------------------------------ done marks ------------------------------

  const handleMastered = () => {
    if (!pickedItem || pickedDone) return
    const list = doneMap[today] ?? []
    if (!list.includes(pickedItem.id)) {
      persistDone({ ...doneMap, [today]: [...list, pickedItem.id] })
    }
    toast.success('已标记背过，今天继续加油！')
  }

  const toggleSpeak = () => {
    if (!pickedItem) return
    if (tts.speaking) {
      tts.stop()
      return
    }
    tts.speak(pickedItem.text)
  }

  // ------------------------------ wheels CRUD ------------------------------

  const switchTo = (id: string) => {
    if (!state) return
    persist({ ...state, currentId: id })
    setManageOpen(false)
    setPickedId(null)
    setView('main')
    toast.success(`已切换到「${state.wheels.find((w) => w.id === id)?.name ?? '转盘'}」`)
  }

  const saveRename = () => {
    if (!state || !renamingId) return
    const name = renameText.trim()
    if (!name) {
      toast.error('转盘名称不能为空')
      return
    }
    persist({ ...state, wheels: state.wheels.map((w) => (w.id === renamingId ? { ...w, name } : w)) })
    setRenamingId(null)
  }

  const duplicateWheel = (w: WheelDoc) => {
    if (!state) return
    const copy: WheelDoc = {
      id: uid(),
      name: `${w.name} 副本`,
      items: w.items.map((i) => ({ ...i, id: uid() })),
    }
    const idx = state.wheels.findIndex((x) => x.id === w.id)
    const wheels = [...state.wheels]
    wheels.splice(idx + 1, 0, copy)
    persist({ ...state, wheels })
    toast.success(`已复制为「${copy.name}」`)
  }

  const deleteWheel = (id: string) => {
    if (!state) return
    if (state.wheels.length <= 1) {
      toast.error('至少保留一个转盘')
      setDeletingId(null)
      return
    }
    const wheels = state.wheels.filter((w) => w.id !== id)
    persist({
      wheels,
      currentId: state.currentId === id ? wheels[0].id : state.currentId,
    })
    setDeletingId(null)
    toast.success('已删除转盘')
  }

  // ------------------------------ create from source ------------------------------

  /** 新 wheel 落地：追加（不覆盖任何已有转盘）→ 切为当前 → 打开编辑。 */
  const adoptNewWheel = (w: WheelDoc) => {
    const next: WheelState = state
      ? { wheels: [...state.wheels, w], currentId: w.id }
      : { wheels: [w], currentId: w.id }
    persist(next)
    setNewOpen(false)
    setManageOpen(false)
    setPickedId(null)
    setDraft(deepCopy(w))
    setExpandedId(null)
    setView('edit')
  }

  /** 手动空白菜单：建空白转盘后逐条添加。 */
  const createManualWheel = () => {
    const name = manualName.trim()
    if (!name) {
      toast.error('请填写转盘名称')
      return
    }
    adoptNewWheel(makeWheel(name, []))
    setManualName('')
    toast.success(`已创建「${name}」，请在下方添加选项`)
  }

  const createWheel = async (source: WheelSource) => {
    if (!content.trim()) {
      toast.error('内容为空，无法生成选项')
      return
    }
    let texts: string[] = []
    if (source === 'ai') {
      setAiLoading(true)
      try {
        const res = await fetch('/api/chunk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        })
        const data = (await res.json().catch(() => null)) as
          | { chunks?: unknown; error?: unknown }
          | null
        if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'AI 分块失败')
        const chunks = Array.isArray(data?.chunks) ? (data?.chunks as unknown[]) : []
        texts = chunks.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
        if (texts.length === 0) throw new Error('AI 未识别出内容块，请重试')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'AI 分块失败，请重试')
        setAiLoading(false)
        return
      }
      setAiLoading(false)
    } else if (source === 'para') {
      // 按段落：每一行（含缩进正文行）视为一段
      texts = content.split(/\n/).map((t) => t.trim()).filter(Boolean)
    } else if (source === 'blank') {
      // 按空行：空行（连续换行）之间的文字视为一块
      texts = content
        .split(/\n[ \t\u3000]*\n+/)
        .map((t) => t.replace(/\n/g, ' ').trim())
        .filter(Boolean)
    } else if (source === 'sent') {
      texts = splitSentences(content).slice(0, SOURCE_CAP)
    } else {
      texts = (card?.blocks ?? [])
        .map((b) => [b.front, b.back].map((s) => (s ?? '').trim()).filter(Boolean).join('\n'))
        .filter(Boolean)
    }
    texts = texts.map((t) => t.trim()).filter(Boolean).slice(0, SOURCE_CAP)
    if (texts.length === 0) {
      toast.error('没有可用的内容')
      return
    }
    const name = `转盘${(state?.wheels.length ?? 0) + 1}`
    const w = makeWheel(name, texts)
    adoptNewWheel(w)
    toast.success(`已创建「${name}」· 共 ${w.items.length} 项`)
  }

  // ------------------------------ edit view ------------------------------

  const openEdit = (w: WheelDoc) => {
    setPickedId(null)
    setDraft(deepCopy(w))
    setExpandedId(null)
    setView('edit')
  }

  const closeEdit = () => {
    setDraft(null)
    setExpandedId(null)
    setView('main')
  }

  const finishEdit = () => {
    if (!draft || !state) return
    const cleaned: WheelDoc = {
      ...draft,
      name: draft.name.trim() || '未命名转盘',
      items: draft.items.filter((i) => i.text.trim()),
    }
    const exists = state.wheels.some((w) => w.id === cleaned.id)
    const wheels = exists
      ? state.wheels.map((w) => (w.id === cleaned.id ? cleaned : w))
      : [...state.wheels, cleaned]
    const currentId = wheels.some((w) => w.id === state.currentId)
      ? state.currentId
      : cleaned.id
    persist({ wheels, currentId })
    closeEdit()
  }

  const draftAllOn = draft ? draft.items.length > 0 && draft.items.every((i) => i.enabled) : false
  const draftSomeOn = draft ? draft.items.some((i) => i.enabled) : false
  const draftEnabledCount = draft ? draft.items.filter((i) => i.enabled).length : 0

  const toggleAllDraft = (on: boolean) => {
    setDraft((d) => (d ? { ...d, items: d.items.map((i) => ({ ...i, enabled: on })) } : d))
  }

  const updateDraftItem = (id: string, patch: Partial<WheelItem>) => {
    setDraft((d) =>
      d ? { ...d, items: d.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) } : d,
    )
  }

  const removeDraftItem = (id: string) => {
    setDraft((d) => (d ? { ...d, items: d.items.filter((i) => i.id !== id) } : d))
    setExpandedId((e) => (e === id ? null : e))
  }

  /** 添加选项：追加空选项并展开编辑（手动空白菜单的核心入口）。 */
  const addDraftItem = () => {
    const item: WheelItem = { id: uid(), text: '', enabled: true, star: false }
    setDraft((d) => (d ? { ...d, items: [...d.items, item] } : d))
    setExpandedId(item.id)
  }

  // ------------------------------ render ------------------------------

  if (!content.trim()) {
    return <div className="py-16 text-center text-sm text-muted-foreground">内容为空，无法转盘抽背</div>
  }

  if (!loaded || !state || !wheel) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // ----- 编辑选项 view -----
  if (view === 'edit' && draft) {
    return (
      <div className="flex flex-col">
        {/* 名称行：返回 / 转盘名称 / 铅笔 */}
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-11 shrink-0 rounded-full"
            aria-label="返回"
            onClick={closeEdit}
          >
            <ArrowLeft className="size-5" strokeWidth={1.75} />
          </Button>
          <Input
            ref={nameInputRef}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') finishEdit()
            }}
            placeholder="转盘名称"
            maxLength={20}
            className="h-11 flex-1 rounded-xl text-center"
          />
          <Button
            variant="outline"
            size="icon"
            className="size-11 shrink-0 rounded-full"
            aria-label="编辑名称"
            onClick={() => {
              nameInputRef.current?.focus()
              nameInputRef.current?.select()
            }}
          >
            <Pencil className="size-4" strokeWidth={1.75} />
          </Button>
        </div>

        {/* 共 N 项 / 全选 */}
        <div className="mt-4 flex items-center justify-between px-1">
          <span className="text-sm text-muted-foreground">共 {draft.items.length} 项</span>
          <label className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground">
            全选
            <Checkbox
              checked={draftAllOn ? true : draftSomeOn ? 'indeterminate' : false}
              onCheckedChange={(v) => toggleAllDraft(v === true)}
              aria-label="全选"
            />
          </label>
        </div>

        {/* 选项列表 */}
        <div className="mt-2 flex flex-col gap-2">
          {draft.items.map((item, idx) => {
            const expanded = expandedId === item.id
            return (
              <div key={item.id} className="rounded-2xl border border-border bg-card">
                <div className="flex min-h-12 items-center gap-2 p-2">
                  <button
                    type="button"
                    aria-label={item.enabled ? '取消选中' : '选中该项'}
                    onClick={() => updateDraftItem(item.id, { enabled: !item.enabled })}
                    className={cn(
                      'flex size-9 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
                      item.enabled
                        ? 'border-emerald-600 bg-emerald-600 text-white'
                        : 'border-zinc-300 bg-transparent text-transparent hover:border-emerald-400',
                    )}
                  >
                    <Check className="size-4" strokeWidth={3} />
                  </button>
                  <p
                    className={cn(
                      'min-w-0 flex-1 cursor-default text-sm leading-relaxed line-clamp-2',
                      !item.enabled && 'text-muted-foreground',
                    )}
                  >
                    {item.text}
                  </p>
                  <button
                    type="button"
                    aria-pressed={item.star}
                    onClick={() => updateDraftItem(item.id, { star: !item.star })}
                    className={cn(
                      'min-h-8 shrink-0 rounded-full border px-2.5 text-xs font-medium transition-colors',
                      item.star
                        ? 'border-amber-300 bg-amber-100 text-amber-700'
                        : 'border-border bg-transparent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    重点
                  </button>
                  <button
                    type="button"
                    aria-label={expanded ? '收起编辑' : '展开编辑'}
                    aria-expanded={expanded}
                    onClick={() => setExpandedId(expanded ? null : item.id)}
                    className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ChevronDown
                      className={cn('size-4 transition-transform', expanded && 'rotate-180')}
                      strokeWidth={1.75}
                    />
                  </button>
                </div>
                {expanded && (
                  <div className="border-t border-border p-3">
                    <div className="mb-1 text-xs text-muted-foreground">第 {idx + 1} 项 · 编辑文字</div>
                    <Textarea
                      value={item.text}
                      onChange={(e) => updateDraftItem(item.id, { text: e.target.value })}
                      rows={3}
                      className="text-sm leading-relaxed"
                    />
                    <Button
                      variant="outline"
                      className="mt-2 h-10 rounded-full border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                      onClick={() => removeDraftItem(item.id)}
                    >
                      <Trash2 className="size-4" strokeWidth={1.75} /> 删除该项
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
          {/* 添加选项（手动空白菜单的核心入口） */}
          <button
            type="button"
            onClick={addDraftItem}
            className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-2xl border border-dashed border-border text-sm text-muted-foreground transition-colors hover:bg-muted/50"
          >
            <Plus className="size-4" strokeWidth={1.75} /> 添加选项
          </button>
          {draft.items.length === 0 && (
            <div className="rounded-2xl border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
              暂无选项，点击上方「添加选项」逐条录入
            </div>
          )}
        </div>

        {/* 底部吸底：已选 N 项 / 完成 */}
        <div className="sticky bottom-0 z-10 -mx-4 mt-4 flex items-center justify-between gap-3 border-t border-border bg-background/95 px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur">
          <span className="text-sm text-muted-foreground">已选 {draftEnabledCount} 项</span>
          <Button
            className="h-11 min-w-32 rounded-full bg-zinc-900 font-semibold text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
            onClick={finishEdit}
          >
            完成
          </Button>
        </div>
      </div>
    )
  }

  // ----- 主界面 -----
  return (
    <div className="flex flex-col items-center gap-4">
      {/* 顶部：当前转盘 pill + 规则说明 */}
      <div className="flex w-full items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => openEdit(wheel)}
          className="flex min-h-9 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50"
        >
          <span>
            当前转盘：<span className="font-medium text-foreground">{wheel.name}</span>
          </span>
          <span className="font-medium text-primary">编辑</span>
        </button>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-9 shrink-0 rounded-full text-muted-foreground"
              aria-label="规则说明"
            >
              <Info className="size-4.5" strokeWidth={1.75} />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-60 text-sm leading-relaxed">
            随机抽取选中项，可建多个转盘按场景切换。
          </PopoverContent>
        </Popover>
      </div>

      {/* 副标题 */}
      <div className="flex w-full items-center justify-between px-1 text-xs">
        <span className="text-muted-foreground">
          {wedgeCount === 0 ? (
            <span className="text-amber-600">还没有勾选任何项，请先编辑选项</span>
          ) : (
            <>抽背范围：{wheel.name} · {enabledItems.length} 项</>
          )}
        </span>
        <span className="text-emerald-600">已背 {doneCount} 项</span>
      </div>

      {/* 转盘 */}
      <div className="relative mx-auto size-64">
        {/* 指针（顶部） */}
        <div
          aria-hidden
          className="absolute -top-1 left-1/2 z-10 size-0 -translate-x-1/2 border-x-[10px] border-x-transparent border-t-[18px] border-t-zinc-800"
        />
        <motion.div
          className="absolute inset-0 rounded-full border-4 border-background shadow-lg"
          style={{ background: gradient }}
          animate={{ rotate: rotation }}
          transition={{ duration: 2.6, ease: [0.16, 0.9, 0.24, 1] }}
        >
          {wedges.map((_, i) => {
            const mid = i * segAngle + segAngle / 2
            return (
              <span
                key={wedges[i].id}
                aria-hidden
                className="absolute left-1/2 top-1/2 flex size-5 items-center justify-center text-[11px] font-bold text-zinc-700"
                style={{
                  transform: `translate(-50%, -50%) rotate(${mid}deg) translateY(-100px) rotate(${-mid}deg)`,
                }}
              >
                {i + 1}
              </span>
            )
          })}
        </motion.div>
        {/* GO 中心按钮 */}
        <button
          type="button"
          onClick={spin}
          disabled={spinning || wedgeCount === 0}
          aria-label="开始抽背"
          className="absolute left-1/2 top-1/2 z-10 flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-4 border-background bg-white text-lg font-black text-zinc-800 shadow-md transition-transform active:scale-95 disabled:opacity-70"
        >
          {spinning ? <Loader2 className="size-5 animate-spin text-zinc-500" /> : 'GO'}
        </button>
      </div>

      {/* 开始抽背 */}
      <Button
        variant="outline"
        className="h-12 w-full rounded-full border-2 font-semibold"
        onClick={spin}
        disabled={spinning || wedgeCount === 0}
      >
        {spinning ? (
          <>
            <Loader2 className="size-4 animate-spin" /> 转动中…
          </>
        ) : (
          <>
            <RotateCw className="size-4" strokeWidth={1.75} /> 开始抽背
          </>
        )}
      </Button>

      {/* 新建 / 管理 */}
      <div className="flex w-full gap-2">
        <Button
          variant="outline"
          className="h-11 flex-1 rounded-full"
          onClick={() => setNewOpen(true)}
        >
          <Plus className="size-4" strokeWidth={1.75} /> 新建转盘
        </Button>
        <Button
          variant="outline"
          className="h-11 flex-1 rounded-full"
          onClick={() => {
            setManageQuery('')
            setRenamingId(null)
            setDeletingId(null)
            setManageOpen(true)
          }}
        >
          <Settings className="size-4" strokeWidth={1.75} /> 管理转盘
        </Button>
      </div>

      {/* 抽中结果 */}
      {pickedItem && !spinning && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full rounded-2xl border border-border bg-card p-4 shadow-sm"
        >
          <div className="flex items-center justify-between">
            <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
              抽中项
            </span>
            {pickedDone && (
              <span className="flex items-center gap-1 text-xs text-emerald-600">
                <Check className="size-3.5" /> 已背过
              </span>
            )}
          </div>
          <div className="mt-3 max-h-44 overflow-y-auto text-lg font-medium leading-loose">
            {pickedItem.text}
          </div>
          <div className="mt-3 flex">
            <VoiceSpeedBar context="wheel" pref={tts.pref} onChange={tts.setPref} />
          </div>
          <div className="mt-3 flex gap-2">
            <Button
              variant="outline"
              className="h-10 flex-1 rounded-full px-1 text-[13px]"
              onClick={toggleSpeak}
            >
              {tts.speaking ? (
                <Square className="size-4" />
              ) : (
                <Volume2 className="size-4" strokeWidth={1.75} />
              )}
              {tts.speaking ? '停止' : '朗读'}
            </Button>
            <Button
              className={cn(
                'h-10 flex-1 rounded-full px-1 text-[13px]',
                pickedDone
                  ? 'bg-muted text-muted-foreground'
                  : 'bg-emerald-600 text-white hover:bg-emerald-700',
              )}
              onClick={handleMastered}
              disabled={pickedDone}
            >
              <Check className="size-4" strokeWidth={1.75} /> {pickedDone ? '已背过' : '我背过了'}
            </Button>
            <Button
              variant="outline"
              className="h-10 flex-1 rounded-full px-1 text-[13px]"
              onClick={spin}
              disabled={spinning}
            >
              <RotateCw className="size-4" strokeWidth={1.75} /> 再抽一次
            </Button>
          </div>
        </motion.div>
      )}

      {/* 转盘管理 sheet：搜索 + 全部转盘（使用/重命名/复制/删除） + 新建 */}
      <BottomSheet open={manageOpen} onOpenChange={setManageOpen} title="管理转盘">
        <div className="mt-4 flex flex-col gap-3 pb-4">
          {/* 搜索：按转盘名称 / 词条内容过滤 */}
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              strokeWidth={1.75}
            />
            <Input
              value={manageQuery}
              onChange={(e) => setManageQuery(e.target.value)}
              placeholder="搜索转盘名称或词条"
              inputMode="search"
              className="h-11 pl-9"
            />
          </div>
          <div className="flex flex-col gap-2">
            {filteredWheels.map((w) => {
              const isCurrent = w.id === wheel.id
              return (
                <div key={w.id} className="rounded-2xl border border-border bg-card">
                  {renamingId === w.id ? (
                    <div className="flex items-center gap-2 p-2">
                      <Input
                        autoFocus
                        value={renameText}
                        onChange={(e) => setRenameText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveRename()
                          if (e.key === 'Escape') setRenamingId(null)
                        }}
                        maxLength={20}
                        className="h-10 flex-1"
                        placeholder="转盘名称"
                      />
                      <Button size="icon" className="size-10 shrink-0 rounded-full" aria-label="保存名称" onClick={saveRename}>
                        <Check className="size-4" strokeWidth={2} />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-10 shrink-0 rounded-full"
                        aria-label="取消重命名"
                        onClick={() => setRenamingId(null)}
                      >
                        <X className="size-4" strokeWidth={1.75} />
                      </Button>
                    </div>
                  ) : deletingId === w.id ? (
                    <div className="flex min-h-12 items-center justify-between gap-2 p-3">
                      <span className="text-sm text-red-600">确认删除「{w.name}」？</span>
                      <div className="flex shrink-0 gap-2">
                        <Button size="sm" variant="ghost" className="h-9 rounded-full" onClick={() => setDeletingId(null)}>
                          取消
                        </Button>
                        <Button
                          size="sm"
                          className="h-9 rounded-full bg-red-600 text-white hover:bg-red-700"
                          onClick={() => deleteWheel(w.id)}
                        >
                          删除
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 p-1.5">
                      <button
                        type="button"
                        onClick={() => switchTo(w.id)}
                        className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2 text-left transition-colors hover:bg-muted/50"
                      >
                        <span
                          className={cn(
                            'flex size-5 shrink-0 items-center justify-center rounded-full border-2',
                            isCurrent ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-zinc-300 text-transparent',
                          )}
                        >
                          <Check className="size-3" strokeWidth={3} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium">{w.name}</span>
                            {isCurrent && (
                              <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                                使用中
                              </span>
                            )}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {w.items.filter((i) => i.enabled).length}/{w.items.length} 项
                          </span>
                        </span>
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-9 shrink-0 rounded-full text-muted-foreground"
                            aria-label={`${w.name} 更多操作`}
                          >
                            <MoreHorizontal className="size-4.5" strokeWidth={1.75} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => switchTo(w.id)}>
                            <Check className="size-4" strokeWidth={1.75} /> 使用
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => {
                              setRenamingId(w.id)
                              setRenameText(w.name)
                            }}
                          >
                            <Pencil className="size-4" strokeWidth={1.75} /> 重命名
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => duplicateWheel(w)}>
                            <Copy className="size-4" strokeWidth={1.75} /> 复制
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-red-600 focus:text-red-600"
                            onSelect={() => setDeletingId(w.id)}
                          >
                            <Trash2 className="size-4" strokeWidth={1.75} /> 删除
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )}
                </div>
              )
            })}
            {filteredWheels.length === 0 && (
              <div className="rounded-2xl border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
                {state.wheels.length === 0
                  ? '还没有转盘，点击下方新建'
                  : `没有匹配「${manageQuery.trim()}」的转盘`}
              </div>
            )}
          </div>
          <Button
            variant="outline"
            className="h-11 rounded-full"
            onClick={() => {
              setRenamingId(null)
              setDeletingId(null)
              setManageOpen(false)
              setNewOpen(true)
            }}
          >
            <Plus className="size-4" strokeWidth={1.75} /> 新建转盘
          </Button>
        </div>
      </BottomSheet>

      {/* 新建转盘 · 选择抽背范围 sheet */}
      <BottomSheet
        open={newOpen}
        onOpenChange={(o) => {
          if (!o && aiLoading) return
          setNewOpen(o)
        }}
        title="分块规则"
      >
        <div className="mt-4 flex flex-col gap-2 pb-4">
          <button
            type="button"
            disabled={aiLoading}
            onClick={() => createWheel('ai')}
            className="flex min-h-16 w-full items-center gap-3 rounded-2xl border border-border bg-card p-3 text-left transition-colors hover:bg-muted/50 disabled:opacity-60"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-600">
              <Sparkles className="size-5" strokeWidth={1.75} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{aiLoading ? 'AI 分块中…' : 'AI 智能分块'}</span>
              <span className="block truncate text-xs text-muted-foreground">
                AI 识别内容结构，总结分成知识块
              </span>
            </span>
            {aiLoading && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
          </button>

          <button
            type="button"
            disabled={aiLoading}
            onClick={() => createWheel('para')}
            className="flex min-h-16 w-full items-center gap-3 rounded-2xl border border-border bg-card p-3 text-left transition-colors hover:bg-muted/50 disabled:opacity-60"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sky-100 text-sky-600">
              <AlignLeft className="size-5" strokeWidth={1.75} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">按段落分块</span>
              <span className="block truncate text-xs text-muted-foreground">每一行视为一段，逐段抽背</span>
            </span>
          </button>

          <button
            type="button"
            disabled={aiLoading}
            onClick={() => createWheel('blank')}
            className="flex min-h-16 w-full items-center gap-3 rounded-2xl border border-border bg-card p-3 text-left transition-colors hover:bg-muted/50 disabled:opacity-60"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-teal-100 text-teal-600">
              <Rows3 className="size-5" strokeWidth={1.75} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">按空行分块</span>
              <span className="block truncate text-xs text-muted-foreground">
                空行之间的文字合为一块，适合长段落
              </span>
            </span>
          </button>

          <button
            type="button"
            disabled={aiLoading}
            onClick={() => createWheel('sent')}
            className="flex min-h-16 w-full items-center gap-3 rounded-2xl border border-border bg-card p-3 text-left transition-colors hover:bg-muted/50 disabled:opacity-60"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-600">
              <Type className="size-5" strokeWidth={1.75} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">按标点分块</span>
              <span className="block truncate text-xs text-muted-foreground">按标点自动分句，最多 30 句</span>
            </span>
          </button>

          {card?.blocks && card.blocks.length > 0 && (
            <button
              type="button"
              disabled={aiLoading}
              onClick={() => createWheel('blocks')}
              className="flex min-h-16 w-full items-center gap-3 rounded-2xl border border-border bg-card p-3 text-left transition-colors hover:bg-muted/50 disabled:opacity-60"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-violet-100 text-violet-600">
                <Blocks className="size-5" strokeWidth={1.75} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">按知识块</span>
                <span className="block truncate text-xs text-muted-foreground">
                  使用文字编辑工具中的知识块（{card.blocks.length} 块）
                </span>
              </span>
            </button>
          )}

          {/* 手动空白菜单：建空白转盘后逐条添加 */}
          <div className="rounded-2xl border border-dashed border-border p-3">
            <div className="flex items-center gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-zinc-100 text-zinc-600">
                <Pencil className="size-5" strokeWidth={1.75} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">手动空白菜单</div>
                <div className="truncate text-xs text-muted-foreground">
                  先建空白转盘，再逐条添加选项
                </div>
              </div>
            </div>
            <div className="mt-2.5 flex gap-2">
              <Input
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createManualWheel()
                }}
                placeholder="转盘名称（如：易错句）"
                maxLength={20}
                className="h-10 flex-1"
              />
              <Button
                className="h-10 shrink-0 rounded-full px-4"
                disabled={!manualName.trim() || aiLoading}
                onClick={createManualWheel}
              >
                <Plus className="size-4" strokeWidth={1.75} /> 创建
              </Button>
            </div>
          </div>
        </div>
      </BottomSheet>
    </div>
  )
}
