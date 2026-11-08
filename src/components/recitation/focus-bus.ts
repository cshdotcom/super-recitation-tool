'use client'

// 专注总线 (focus bus) — 跨组件 / 跨页面的专注会话状态存储 + 全局浮时钟。
//
// 设计目标（对应旧版「专注功能一搞反而什么都做不了」的批评）：
//   - 计时状态不放在 focus-app 内部，而是放在本模块（localStorage + CustomEvent 同步），
//     用户最小化后可以回主页 / 背书等任何页面，专注在后台继续。
//   - 主线程只需 `import { FocusFloatingClock } from '@/components/recitation/focus-bus'`
//     并全局挂载一次，即可获得右下角浮时钟（含详情 / 结束 / 到点铃声设置）。
//
// 本文件是 .ts（不能用 JSX），因此 FocusFloatingClock 用 React.createElement 构建；
// 若后续改成 .tsx 可原样换写法，导出面不变。
//
// 导出一览：
//   状态与操作  startFocus / pauseFocus / resumeFocus / stopFocus / getFocusState
//              getElapsedSec / getDisplaySec / useFocusState / focusBus
//   UI 协调    setImmersiveOpen / isImmersiveOpen（focus-app 全屏计时时隐藏浮时钟圆钮）
//   铃声       getFocusSoundPrefs / saveFocusSoundPrefs / playFocusBell / playBuiltin
//             FOCUS_BUILTIN_SOUNDS（内置铃声清单）
//   历史       今日会话记录已全部服务端持久化（/api/focus/log GET/POST/DELETE，
//             多设备可见）；本机仅保留运行中会话状态（跨标签页同步需要）
//   UI 跳转    requestOpenFocusView / consumeOpenFocusRequest（浮时钟「全屏计时」→
//             window 派发 CustomEvent('sb-open-focus')，页面据此切到专注视图）
//   组件       FocusFloatingClock（全局挂载一次；圆钮可拖动，位置持久化 ui:focusClockPos）

import * as React from 'react'
import { Clock3, Maximize2, Pause, Play, Upload, Volume2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { putState } from '@/lib/server-state'

// ---------- 类型 ----------

export type FocusMode = 'countdown' | 'countup'

/** 专注会话状态（持久化到 localStorage，跨标签页 storage 事件同步） */
export interface FocusBusState {
  running: boolean
  mode: FocusMode
  /** 会话开始的 epoch 毫秒 */
  startedAt: number
  /** 倒计时：倒数总长（秒）；正计时：目标时长（秒，可选，到点自动结束） */
  targetSec?: number
  /** 专注内容名（未选内容时建议传「自由专注」） */
  contentName: string
  /** 专注内容 id（未选内容时缺省 —— 无 id 的会话无法上报 /api/focus/log，仅本机记录） */
  contentId?: string
  paused: boolean
  /** 已累计的专注毫秒数（暂停时冻结，恢复后继续累加） */
  pausedAccum: number
  /** 当前连续计时的起点 epoch 毫秒（暂停时为 0） */
  activeSince: number
}

/** 到点 / 结束事件的 detail */
export interface FocusStopInfo {
  seconds: number
  name: string
  contentId?: string
  /** STOP 事件：用户是否选择「结束并保存」 */
  save?: boolean
  /** COMPLETE 事件：是否已实际记录（有 contentId 且时长 ≥1s） */
  saved?: boolean
  /** 最近一次到点的 epoch 毫秒（内部用） */
  at?: number
}

export const FOCUS_BUS_STATE_KEY = 'focus-bus-state-v1'
export const FOCUS_BUS_SOUND_KEY = 'focus-bus-sound-v1'

export const FOCUS_BUS_EVENTS = {
  /** 状态变化（start/pause/resume/stop） */
  CHANGE: 'focusbus-change',
  /** 运行中每 500ms 的 tick（仅 running && !paused 时派发） */
  TICK: 'focusbus-tick',
  /** 到点自动结束（倒计时倒数完 / 正计时达到目标） */
  COMPLETE: 'focusbus-complete',
  /** 手动结束（stopFocus） */
  STOP: 'focusbus-stop',
  /** 会话记录写入 /api/focus/log 后派发（页面统计据此重新拉取，避免早于日志写入的竞态） */
  LOGGED: 'focusbus-logged',
  /** focus-app 全屏计时遮罩开关（浮时钟据此隐藏圆钮） */
  IMMERSIVE: 'focusbus-immersive',
} as const

const IDLE: FocusBusState = {
  running: false,
  mode: 'countdown',
  startedAt: 0,
  contentName: '',
  paused: false,
  pausedAccum: 0,
  activeSince: 0,
}

// ---------- 内部存储 ----------

let state: FocusBusState = loadState()
let timerId: number | null = null
let titlePrev: string | null = null
let immersiveOpen = false

export interface FocusSnapshot {
  state: FocusBusState
  /** 每次 change / tick 递增，驱动 useSyncExternalStore 重渲染 */
  version: number
}

let snap: FocusSnapshot = { state, version: 0 }

const SERVER_SNAPSHOT: FocusSnapshot = { state: IDLE, version: 0 }

function loadState(): FocusBusState {
  if (typeof window === 'undefined') return { ...IDLE }
  try {
    const raw = window.localStorage.getItem(FOCUS_BUS_STATE_KEY)
    if (!raw) return { ...IDLE }
    const p = JSON.parse(raw) as Partial<FocusBusState>
    if (!p || typeof p !== 'object' || p.running !== true) return { ...IDLE }
    const targetSec = Number(p.targetSec)
    const paused = p.paused === true
    const activeSince = Number(p.activeSince) || 0
    return {
      running: true,
      mode: p.mode === 'countup' ? 'countup' : 'countdown',
      startedAt: Number(p.startedAt) || Date.now(),
      targetSec: Number.isFinite(targetSec) && targetSec > 0 ? Math.round(targetSec) : undefined,
      contentName: typeof p.contentName === 'string' ? p.contentName : '',
      contentId: typeof p.contentId === 'string' && p.contentId ? p.contentId : undefined,
      paused,
      pausedAccum: Number(p.pausedAccum) || 0,
      // 兜底：运行中却丢了 activeSince（脏数据），从当前时刻重新起算，避免时长爆炸
      activeSince: !paused && activeSince <= 0 ? Date.now() : activeSince,
    }
  } catch {
    return { ...IDLE }
  }
}

function persistState(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(FOCUS_BUS_STATE_KEY, JSON.stringify(state))
  } catch {
    // localStorage 不可用时忽略（会话仅在内存中）
  }
  // 实时同步服务端（AppState 表为真源，localStorage 仅离线镜像）
  void putState(FOCUS_BUS_STATE_KEY, JSON.stringify(state))
}

function dispatchEv(type: string, detail: unknown): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(type, { detail }))
}

/** 状态变更：更新快照 + 持久化 + 广播 change（persist=false 用于跨标签页同步，不回写） */
function publish(persist = true): void {
  snap = { state, version: snap.version + 1 }
  if (persist) persistState()
  dispatchEv(FOCUS_BUS_EVENTS.CHANGE, state)
}

/** tick：只推进版本号触发重渲染（时间从时间戳计算，drift-free） */
function bump(): void {
  snap = { ...snap, version: snap.version + 1 }
}

function onEvent(type: string, fn: (e: Event) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(type, fn)
  return () => window.removeEventListener(type, fn)
}

// ---------- 时间计算 ----------

function getElapsedMs(s?: FocusBusState): number {
  const st = s ?? state
  const ms = st.paused ? st.pausedAccum : st.pausedAccum + Math.max(0, Date.now() - st.activeSince)
  return ms
}

/** 已专注秒数（暂停时冻结；上限 86400 = 24h） */
export function getElapsedSec(s?: FocusBusState): number {
  return Math.min(86400, Math.max(0, Math.floor(getElapsedMs(s) / 1000)))
}

/** 展示用秒数：倒计时返回剩余，正计时返回已专注 */
export function getDisplaySec(s?: FocusBusState): number {
  const st = s ?? state
  const elapsed = getElapsedSec(st)
  if (st.mode === 'countdown' && st.targetSec) return Math.max(0, st.targetSec - elapsed)
  return elapsed
}

// ---------- 会话操作 ----------

/** 开始一次专注会话 */
export function startFocus(opts: {
  mode: FocusMode
  /** 秒；倒计时的倒数时长 / 正计时的目标时长（可选 = 不限时） */
  targetSec?: number
  contentName?: string
  contentId?: string
}): void {
  const now = Date.now()
  state = {
    running: true,
    mode: opts.mode,
    startedAt: now,
    targetSec: opts.targetSec && opts.targetSec > 0 ? Math.round(opts.targetSec) : undefined,
    contentName: opts.contentName ?? '',
    contentId: opts.contentId,
    paused: false,
    pausedAccum: 0,
    activeSince: now,
  }
  publish()
  ensureTicker()
}

export function pauseFocus(): void {
  if (!state.running || state.paused) return
  state = { ...state, paused: true, pausedAccum: getElapsedMs(state), activeSince: 0 }
  publish()
  ensureTicker()
}

export function resumeFocus(): void {
  if (!state.running || !state.paused) return
  state = { ...state, paused: false, activeSince: Date.now() }
  publish()
  ensureTicker()
}

/** 结束会话。save=true 时上报 /api/focus/log（自由专注也记录，仅名字）。 */
export async function stopFocus(save: boolean): Promise<void> {
  if (!state.running) return
  const seconds = getElapsedSec(state)
  const name = state.contentName || '自由专注'
  const contentId = state.contentId
  setIdle()
  dispatchEv(FOCUS_BUS_EVENTS.STOP, { seconds, name, contentId, save } satisfies FocusStopInfo)
  if (!save || seconds < 1) return
  await logToServer(contentId ?? null, seconds, false, name)
}

/** 当前会话状态（只读，勿直接修改） */
export function getFocusState(): FocusBusState {
  return state
}

function setIdle(): void {
  state = { ...IDLE }
  publish()
  ensureTicker()
}

/** 最近一次到点记录（模块内暂存：COMPLETE 事件可能在浮时钟订阅前派发，如页面刷新后补发） */
let lastComplete: FocusStopInfo | null = null

/** 取走最近 5 分钟内的到点记录（浮时钟挂载时调用，避免错过「时间到了」弹窗） */
export function consumeRecentComplete(): FocusStopInfo | null {
  const c = lastComplete
  lastComplete = null
  if (c && c.at && Date.now() - c.at < 5 * 60 * 1000) return c
  return null
}

async function logToServer(
  contentId: string | null,
  seconds: number,
  natural: boolean,
  name: string,
): Promise<boolean> {
  try {
    const res = await fetch('/api/focus/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentId: contentId ?? undefined, name, seconds }),
    })
    if (!res.ok) throw new Error('记录专注时长失败')
    toast.success(`${natural ? '专注完成' : '已结束'} · 已记录 ${fmtDurHuman(seconds)}`)
    return true
  } catch (err) {
    toast.error(err instanceof Error ? err.message : '记录专注时长失败')
    return false
  } finally {
    // 无论成败都广播一次：running→false 时页面的统计刷新可能早于本请求完成，
    // 这里保证日志落库后统计会再刷新一次
    dispatchEv(FOCUS_BUS_EVENTS.LOGGED, { contentId, seconds })
  }
}

/** 到点自动结束（倒计时倒数完 / 正计时达到目标） */
async function completeNatural(): Promise<void> {
  if (!state.running) return
  // 多标签页兜底：另一标签页可能已结束本次会话 —— 以 localStorage 中的会话为准，
  // 校验与置 idle 之间是同步代码，两个标签页不会同时通过校验。
  if (typeof window !== 'undefined') {
    try {
      const raw = window.localStorage.getItem(FOCUS_BUS_STATE_KEY)
      const p = raw ? (JSON.parse(raw) as Partial<FocusBusState>) : null
      if (!p || p.running !== true || Number(p.startedAt) !== state.startedAt) {
        state = loadState()
        publish(false)
        ensureTicker()
        return
      }
    } catch {
      // 校验失败则按本标签页状态继续
    }
  }
  const seconds =
    state.mode === 'countdown' && state.targetSec ? state.targetSec : getElapsedSec(state)
  const name = state.contentName || '自由专注'
  const contentId = state.contentId
  setIdle()
  lastComplete = { seconds, name, contentId, saved: true, at: Date.now() }
  dispatchEv(FOCUS_BUS_EVENTS.COMPLETE, lastComplete satisfies FocusStopInfo)
  if (seconds >= 1) {
    await logToServer(contentId ?? null, seconds, true, name)
  }
  if (getFocusSoundPrefs().enabled) playFocusBell()
}

// ---------- 全局 ticker + 标签页标题 ----------

function ensureTicker(): void {
  if (typeof window === 'undefined') return
  const active = state.running && !state.paused
  if (active && timerId === null) {
    timerId = window.setInterval(tick, 500)
  } else if (!active && timerId !== null) {
    window.clearInterval(timerId)
    timerId = null
  }
  updateTitle()
}

function tick(): void {
  if (!(state.running && !state.paused)) {
    ensureTicker()
    return
  }
  bump()
  dispatchEv(FOCUS_BUS_EVENTS.TICK, state)
  if (state.targetSec && getElapsedSec(state) >= state.targetSec) {
    void completeNatural()
  }
  updateTitle()
}

function updateTitle(): void {
  if (typeof document === 'undefined') return
  if (state.running) {
    if (titlePrev === null) titlePrev = document.title
    document.title = `专注中 ${fmtClock(getDisplaySec(state))}${state.paused ? ' · 已暂停' : ''}`
  } else if (titlePrev !== null) {
    document.title = titlePrev
    titlePrev = null
  }
}

// 跨标签页同步 + 回到标签页时立刻补一次 tick（后台定时器被节流，靠时间戳纠偏）
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key !== FOCUS_BUS_STATE_KEY) return
    state = loadState()
    publish(false) // 状态来自其他标签页的写入，不回写 localStorage（避免回声循环）
    ensureTicker()
  })
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.running && !state.paused) tick()
  })
  // 刷新页面后恢复运行中的会话：ticker 不会自动启动，这里补上
  // （含「倒计时早已到点」的情况 —— 首个 tick 会立即触发 completeNatural）
  ensureTicker()
}

// ---------- 订阅 / Hook ----------

function subscribe(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onChange = () => listener()
  const onStorage = (e: StorageEvent) => {
    if (e.key === FOCUS_BUS_STATE_KEY) listener()
  }
  window.addEventListener(FOCUS_BUS_EVENTS.CHANGE, onChange)
  window.addEventListener(FOCUS_BUS_EVENTS.TICK, onChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(FOCUS_BUS_EVENTS.CHANGE, onChange)
    window.removeEventListener(FOCUS_BUS_EVENTS.TICK, onChange)
    window.removeEventListener('storage', onStorage)
  }
}

export function getFocusSnapshot(): FocusSnapshot {
  return snap
}

/** 订阅专注状态（change + 500ms tick + 跨标签页 storage），运行中每 500ms 重渲染 */
export function useFocusState(): FocusBusState {
  return React.useSyncExternalStore(subscribe, getFocusSnapshot, () => SERVER_SNAPSHOT).state
}

/** 门面对象：focusBus.start(...) / focusBus.stop(true) / focusBus.subscribe(fn) ... */
export const focusBus = {
  start: startFocus,
  pause: pauseFocus,
  resume: resumeFocus,
  stop: stopFocus,
  getState: getFocusState,
  getElapsedSec,
  getDisplaySec,
  subscribe,
  events: FOCUS_BUS_EVENTS,
}

// ---------- 全屏计时遮罩标记（focus-app ↔ 浮时钟协调） ----------

/** focus-app 打开全屏计时遮罩时置 true，浮时钟圆钮自动隐藏（Dialog 不受影响） */
export function setImmersiveOpen(v: boolean): void {
  if (immersiveOpen === v) return
  immersiveOpen = v
  dispatchEv(FOCUS_BUS_EVENTS.IMMERSIVE, v)
}

export function isImmersiveOpen(): boolean {
  return immersiveOpen
}

// ---------- 「全屏计时」跨视图请求（浮时钟详情 → 页面切到专注视图） ----------

let lastOpenFocusAt = 0

/** 派发 'sb-open-focus' 事件（页面监听后导航到专注视图），并记录时间戳供晚挂载的 FocusApp 补收 */
export function requestOpenFocusView(): void {
  lastOpenFocusAt = Date.now()
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('sb-open-focus'))
  }
}

/** 取走最近 5 秒内的全屏计时请求（FocusApp 挂载晚于事件派发时补收，避免丢事件） */
export function consumeOpenFocusRequest(): boolean {
  if (lastOpenFocusAt && Date.now() - lastOpenFocusAt < 5 * 1000) {
    lastOpenFocusAt = 0
    return true
  }
  return false
}

// ---------- 今日会话记录（服务端持久化 /api/focus/log，多设备可见） ----------

export interface FocusHistoryEntry {
  /** 服务端记录 id（删除单条用） */
  id?: string
  /** 内容名（未选内容 = 自由专注） */
  name: string
  seconds: number
  /** 结束时间 epoch 毫秒 */
  at: number
}

/** 拉取今天的专注会话记录（服务端） */
export async function fetchTodayFocusLogs(): Promise<FocusHistoryEntry[]> {
  try {
    const res = await fetch(
      `/api/focus/log?tzOffset=${new Date().getTimezoneOffset()}`,
    )
    if (!res.ok) throw new Error('加载专注记录失败')
    const data = (await res.json()) as { logs?: FocusHistoryEntry[] }
    return Array.isArray(data.logs) ? data.logs : []
  } catch {
    return []
  }
}

/** 删除单条专注记录（服务端） */
export async function deleteFocusLog(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/focus/log?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
    if (!res.ok) throw new Error('删除专注记录失败')
    return true
  } catch (err) {
    toast.error(err instanceof Error ? err.message : '删除专注记录失败')
    return false
  }
}

// ---------- 结束铃声（内置 WebAudio 多款 + 自定义音频 dataURL） ----------

export type FocusBuiltinSound = 'chime' | 'ding' | 'beep'

/** 内置铃声清单（dataUrl 为空时生效；选择后立即试听） */
export const FOCUS_BUILTIN_SOUNDS: { key: FocusBuiltinSound; label: string }[] = [
  { key: 'chime', label: '琶音' },
  { key: 'ding', label: '叮咚' },
  { key: 'beep', label: '闹铃' },
]

export interface FocusSoundPrefs {
  /** 到点是否尝试自动响铃（浏览器策略限制，后台标签页可能静默失败；详情里可手动播放） */
  enabled: boolean
  /** 内置铃声（dataUrl 为空时生效） */
  builtin: FocusBuiltinSound
  /** 自定义铃声 dataURL（'' = 使用内置铃声） */
  dataUrl: string
}

const SOUND_DEFAULT: FocusSoundPrefs = { enabled: true, builtin: 'chime', dataUrl: '' }

export function getFocusSoundPrefs(): FocusSoundPrefs {
  if (typeof window === 'undefined') return { ...SOUND_DEFAULT }
  try {
    const raw = window.localStorage.getItem(FOCUS_BUS_SOUND_KEY)
    if (!raw) return { ...SOUND_DEFAULT }
    const p = JSON.parse(raw) as Partial<FocusSoundPrefs>
    return {
      enabled: p.enabled !== false,
      builtin:
        p.builtin === 'ding' || p.builtin === 'beep' ? p.builtin : ('chime' as FocusBuiltinSound),
      dataUrl: typeof p.dataUrl === 'string' ? p.dataUrl : '',
    }
  } catch {
    return { ...SOUND_DEFAULT }
  }
}

export function saveFocusSoundPrefs(patch: Partial<FocusSoundPrefs>): FocusSoundPrefs {
  const next = { ...getFocusSoundPrefs(), ...patch }
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(FOCUS_BUS_SOUND_KEY, JSON.stringify(next))
    } catch {
      toast.error('铃声设置保存失败（浏览器存储空间不足）')
    }
    // 实时同步服务端
    void putState(FOCUS_BUS_SOUND_KEY, JSON.stringify(next))
  }
  return next
}

/** 播放结束铃声：自定义音频优先，否则播放选中的内置铃声 */
export function playFocusBell(): void {
  if (typeof window === 'undefined') return
  const prefs = getFocusSoundPrefs()
  if (prefs.dataUrl) {
    try {
      const audio = new Audio(prefs.dataUrl)
      void audio.play().catch(() => playBuiltin(prefs.builtin))
      return
    } catch {
      // fall through to builtin
    }
  }
  playBuiltin(prefs.builtin)
}

/** 播放指定内置铃声（选择铃声时即时试听用） */
export function playBuiltin(sound: FocusBuiltinSound): void {
  if (sound === 'ding') {
    playTones([
      { freq: 659.26, at: 0, dur: 0.55 },
      { freq: 880, at: 0.35, dur: 0.9 },
    ])
  } else if (sound === 'beep') {
    playTones([
      { freq: 880, at: 0, dur: 0.12, type: 'triangle' },
      { freq: 880, at: 0.3, dur: 0.12, type: 'triangle' },
      { freq: 880, at: 0.6, dur: 0.12, type: 'triangle' },
      { freq: 880, at: 0.9, dur: 0.22, type: 'triangle' },
    ])
  } else {
    // chime：C5 E5 G5 上行琶音
    playTones([
      { freq: 523.25, at: 0, dur: 1.0 },
      { freq: 659.26, at: 0.22, dur: 1.0 },
      { freq: 783.99, at: 0.44, dur: 1.2 },
    ])
  }
}

function playTones(notes: { freq: number; at: number; dur: number; type?: OscillatorType }[]): void {
  try {
    const w = window as unknown as {
      AudioContext?: typeof AudioContext
      webkitAudioContext?: typeof AudioContext
    }
    const Ctor = w.AudioContext ?? w.webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    const t0 = ctx.currentTime
    let last = 0
    for (const n of notes) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = n.type ?? 'sine'
      osc.frequency.value = n.freq
      const start = t0 + n.at
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + n.dur)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(start)
      osc.stop(start + n.dur + 0.1)
      last = Math.max(last, n.at + n.dur)
    }
    window.setTimeout(() => {
      void ctx.close().catch(() => {})
    }, Math.ceil(last * 1000) + 500)
  } catch {
    // ignore
  }
}

// ---------- 时间格式化 ----------

/** mm:ss（≥1h 时 h:mm:ss） */
export function fmtClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec))
  if (s >= 3600) {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const r = s % 60
    return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
  }
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

/** 人话时长：45 秒 / 25 分钟 / 1 小时 30 分 */
export function fmtDurHuman(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec))
  if (s < 60) return `${s} 秒`
  if (s < 3600) return `${Math.round(s / 60)} 分钟`
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`
}

// ---------- 浮时钟位置（可拖动；百分比定位抗窗口尺寸变化，持久化到 /api/state） ----------

/** 服务端 AppState KV key（GET /api/state?key=… → { values: { [key]: string|null } }） */
const FOCUS_CLOCK_POS_KEY = 'ui:focusClockPos'
/** 拖拽释放后距视口边缘的最小像素 */
const POS_EDGE_MARGIN = 8
/** 圆钮直径（size-16 = 64px） */
const PILL_SIZE = 64
/** 指针移动超过该像素视为拖拽（否则仍当作点击打开详情） */
const DRAG_THRESHOLD = 6

/** 圆钮中心位置（视口宽高的百分比 0-100） */
export interface FocusClockPos {
  x: number
  y: number
}

function clampPosPx(left: number, top: number): { left: number; top: number } {
  const vw = window.innerWidth || 1
  const vh = window.innerHeight || 1
  const half = PILL_SIZE / 2
  return {
    left: Math.min(vw - half - POS_EDGE_MARGIN, Math.max(half + POS_EDGE_MARGIN, left)),
    top: Math.min(vh - half - POS_EDGE_MARGIN, Math.max(half + POS_EDGE_MARGIN, top)),
  }
}

function posToPercent(left: number, top: number): FocusClockPos {
  const vw = window.innerWidth || 1
  const vh = window.innerHeight || 1
  return { x: (left / vw) * 100, y: (top / vh) * 100 }
}

function clampPosPercent(p: FocusClockPos): FocusClockPos {
  const vw = window.innerWidth || 1
  const vh = window.innerHeight || 1
  const c = clampPosPx((p.x / 100) * vw, (p.y / 100) * vh)
  return posToPercent(c.left, c.top)
}

/** 默认位置：右下角 bottom-4 right-4（16px 边距 + 半径 32px → 中心距角 48px） */
function defaultPosPx(): { left: number; top: number } {
  const vw = window.innerWidth || 1
  const vh = window.innerHeight || 1
  return { left: vw - 48, top: vh - 48 }
}

async function loadClockPos(): Promise<FocusClockPos | null> {
  try {
    const res = await fetch(`/api/state?key=${encodeURIComponent(FOCUS_CLOCK_POS_KEY)}`)
    if (!res.ok) return null
    const data = (await res.json()) as { values?: Record<string, string | null> }
    const raw = data.values?.[FOCUS_CLOCK_POS_KEY]
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<FocusClockPos>
    const x = Number(p?.x)
    const y = Number(p?.y)
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) {
      return null
    }
    return clampPosPercent({ x, y })
  } catch {
    return null
  }
}

function saveClockPos(p: FocusClockPos): void {
  const value = JSON.stringify({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 })
  void fetch('/api/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: FOCUS_CLOCK_POS_KEY, value }),
  }).catch(() => {
    // 位置保存失败不影响计时
  })
}

// ============================================================
// FocusFloatingClock — 全局浮时钟（主线程挂载一次即可）
//   运行中：可拖动小圆钮（mm:ss，长按拖拽换位置并持久化），点击弹详情 Dialog
//   详情：当前会话（内容名 / 已专注 / 全屏计时 / 暂停继续 / 结束）+ 今日&累计统计 + 结束铃声设置
//   到点：自动弹「时间到了」Dialog（可手动播放铃声）
// ============================================================

const h = React.createElement

export function FocusFloatingClock() {
  const st = useFocusState()
  const [detailOpen, setDetailOpen] = React.useState(false)
  const [timeUp, setTimeUp] = React.useState<FocusStopInfo | null>(null)
  const [immersive, setImmersive] = React.useState(false)
  const [sound, setSound] = React.useState<FocusSoundPrefs>(SOUND_DEFAULT)
  const [stats, setStats] = React.useState<{ todayMin: number; totalCount: number } | null>(null)
  const [statsErr, setStatsErr] = React.useState(false)

  // ---------- 圆钮位置（可拖动，持久化 ui:focusClockPos，百分比定位抗窗口尺寸变化） ----------
  const [pos, setPos] = React.useState<FocusClockPos | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const posRef = React.useRef<FocusClockPos | null>(null)
  const dragRef = React.useRef<{
    pointerId: number
    startX: number
    startY: number
    baseLeft: number
    baseTop: number
    moved: boolean
  } | null>(null)
  const suppressClickRef = React.useRef(false)

  // 挂载时读取上次拖放的位置（无记录 / 失败 → 默认右下角）
  React.useEffect(() => {
    let alive = true
    void loadClockPos().then((p) => {
      if (alive && p) setPos(p)
    })
    return () => {
      alive = false
    }
  }, [])

  // 窗口尺寸变化时按百分比重新夹取，保证圆钮不出视口
  React.useEffect(() => {
    const onResize = () => setPos((p) => (p ? clampPosPercent(p) : p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  React.useEffect(() => {
    posRef.current = pos
  }, [pos])

  const onPillPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    suppressClickRef.current = false // 兑现/清掉上次残留的拖拽吞噬标记
    const p = posRef.current
    const base = p
      ? {
          left: (p.x / 100) * (window.innerWidth || 1),
          top: (p.y / 100) * (window.innerHeight || 1),
        }
      : defaultPosPx()
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseLeft: base.left,
      baseTop: base.top,
      moved: false,
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // 个别浏览器对非主指针不支持 capture，忽略（仍可拖拽，只是移出按钮后丢跟踪）
    }
  }

  const onPillPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved) {
      if (Math.hypot(dx, dy) <= DRAG_THRESHOLD) return
      d.moved = true
      setDragging(true)
    }
    const c = clampPosPx(d.baseLeft + dx, d.baseTop + dy)
    setPos(posToPercent(c.left, c.top))
  }

  const endPillDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current
    dragRef.current = null
    setDragging(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // ignore
    }
    if (!d || d.pointerId !== e.pointerId || !d.moved) return // 未拖动 → 交给 onClick 打开详情
    suppressClickRef.current = true // 本次是拖拽，吞掉 pointerup 后紧随的 click
    const p = posRef.current
    if (p) saveClockPos(p)
  }

  React.useEffect(() => {
    setSound(getFocusSoundPrefs())
    setImmersive(isImmersiveOpen())
    // 页面刷新后模块初始化时触发的到点，可能早于本组件订阅 —— 这里补收
    const recent = consumeRecentComplete()
    if (recent) setTimeUp(recent)
    const offImm = onEvent(FOCUS_BUS_EVENTS.IMMERSIVE, () => setImmersive(isImmersiveOpen()))
    const offDone = onEvent(FOCUS_BUS_EVENTS.COMPLETE, (e) => {
      const d = (e as CustomEvent<FocusStopInfo>).detail
      setSound(getFocusSoundPrefs())
      setTimeUp({ seconds: d.seconds, name: d.name, contentId: d.contentId, saved: d.saved })
    })
    return () => {
      offImm()
      offDone()
    }
  }, [])

  // 打开详情时拉取 /api/focus 统计（今日分钟 / 累计次数）；期间有会话落库（LOGGED）也刷新
  React.useEffect(() => {
    if (!detailOpen) return
    let alive = true
    const load = async () => {
      try {
        const res = await fetch(`/api/focus?tzOffset=${new Date().getTimezoneOffset()}`)
        if (!res.ok) throw new Error('加载统计失败')
        const data = (await res.json()) as {
          contents?: { todaySeconds: number; focusCount: number }[]
        }
        const list = data.contents ?? []
        if (!alive) return
        setStats({
          todayMin: Math.round(list.reduce((a, c) => a + (c.todaySeconds || 0), 0) / 60),
          totalCount: list.reduce((a, c) => a + (c.focusCount || 0), 0),
        })
        setStatsErr(false)
      } catch {
        if (alive) {
          setStats(null)
          setStatsErr(true)
        }
      }
    }
    void load()
    window.addEventListener(FOCUS_BUS_EVENTS.LOGGED, load)
    return () => {
      alive = false
      window.removeEventListener(FOCUS_BUS_EVENTS.LOGGED, load)
    }
  }, [detailOpen])

  const onSoundFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      toast.error('铃声文件需小于 2MB')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      setSound(saveFocusSoundPrefs({ dataUrl: String(reader.result) }))
      toast.success('铃声已更新')
    }
    reader.onerror = () => toast.error('读取铃声文件失败')
    reader.readAsDataURL(file)
  }

  /** 铃声设置区（详情 / 时间到了 两个弹窗共用）：开关 + 内置铃声选择 + 上传自定义 */
  const soundSection = (key: string) =>
    h(
      'div',
      { key, className: 'flex flex-col gap-3 rounded-2xl border p-3' },
      h(
        'div',
        { className: 'flex items-center justify-between' },
        h(
          'div',
          { className: 'flex items-center gap-2' },
          h(Volume2, { className: 'size-4 text-zinc-500' }),
          h('span', { className: 'text-sm font-medium' }, '结束铃声'),
          h('span', { className: 'text-xs text-zinc-400' }, sound.dataUrl ? '自定义' : '内置铃声'),
        ),
        h(Switch, {
          checked: sound.enabled,
          onCheckedChange: (v: boolean) => {
            setSound(saveFocusSoundPrefs({ enabled: v }))
          },
        }),
      ),
      h(
        'div',
        { className: 'flex flex-wrap items-center gap-2' },
        FOCUS_BUILTIN_SOUNDS.map((b) => {
          const active = !sound.dataUrl && sound.builtin === b.key
          return h(
            'button',
            {
              key: b.key,
              type: 'button',
              'aria-pressed': active,
              onClick: () => {
                setSound(saveFocusSoundPrefs({ builtin: b.key, dataUrl: '' }))
                playBuiltin(b.key) // 选择即试听
              },
              className: cn(
                'shrink-0 rounded-full border px-3 py-1.5 text-xs transition-colors hover:bg-zinc-50',
                active && 'border-zinc-900 font-semibold',
              ),
            },
            b.label,
          )
        }),
        h(
          'label',
          {
            className: cn(
              'flex h-8 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors hover:bg-zinc-50',
              sound.dataUrl && 'border-zinc-900 font-semibold',
            ),
          },
          h(Upload, { className: 'size-3.5 text-zinc-500' }),
          sound.dataUrl ? '自定义铃声' : '上传铃声',
          h('input', {
            type: 'file',
            accept: 'audio/*',
            className: 'hidden',
            onChange: onSoundFile,
          }),
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: () => playFocusBell(),
            className:
              'flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors hover:bg-zinc-50',
          },
          '试听',
        ),
        sound.dataUrl &&
          h(
            'button',
            {
              type: 'button',
              onClick: () => {
                setSound(saveFocusSoundPrefs({ dataUrl: '' }))
                toast.success('已恢复内置铃声')
              },
              className:
                'flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors hover:bg-zinc-50',
            },
            '恢复默认',
          ),
      ),
    )

  // 空闲且无弹窗时完全不渲染（服务端首帧也返回 null，避免 hydration 不匹配）
  if (!st.running && !detailOpen && !timeUp) return null

  const display = getDisplaySec(st)
  const elapsed = getElapsedSec(st)

  const pill =
    st.running && !immersive
      ? h(
          'button',
          {
            key: 'pill',
            type: 'button',
            'aria-label': '专注浮时钟（可拖动）',
            onClick: () => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false
                return // 刚完成一次拖拽，不要误开详情
              }
              setDetailOpen(true)
            },
            onPointerDown: onPillPointerDown,
            onPointerMove: onPillPointerMove,
            onPointerUp: endPillDrag,
            onPointerCancel: endPillDrag,
            className: cn(
              'fixed z-40 flex size-16 touch-none select-none flex-col items-center justify-center rounded-full bg-zinc-900 text-white shadow-xl outline-none transition-transform',
              pos ? '' : 'bottom-4 right-4',
              dragging ? 'scale-105 cursor-grabbing shadow-2xl' : 'cursor-grab active:scale-95',
            ),
            style: pos
              ? {
                  left: `${pos.x}%`,
                  top: `${pos.y}%`,
                  transform: 'translate(-50%, -50%)',
                }
              : undefined,
          },
          h('span', { key: 't', className: 'text-sm font-bold leading-none tabular-nums' }, fmtClock(display)),
          h('span', { key: 's', className: 'mt-1 text-[10px] leading-none text-white/60' }, st.paused ? '已暂停' : '专注中'),
          !st.paused && h('span', { key: 'd', className: 'absolute right-1 top-1 size-2 animate-pulse rounded-full bg-emerald-400' }),
        )
      : null

  const detailDialog = h(
    Dialog,
    { key: 'detail', open: detailOpen, onOpenChange: (o: boolean) => setDetailOpen(o) },
    h(
      DialogContent,
      { className: 'max-w-sm rounded-2xl' },
      h(
        DialogHeader,
        null,
        h(DialogTitle, null, '专注'),
        h(
          DialogDescription,
          null,
          st.running ? '专注在后台继续计时，可以随时去别的页面背书' : '当前没有进行中的专注',
        ),
      ),
      st.running
        ? h(
            'div',
            { key: 'session', className: 'flex flex-col gap-3' },
            h(
              'div',
              { className: 'rounded-2xl bg-zinc-900 p-4 text-white' },
              h(
                'div',
                { className: 'flex items-center gap-2' },
                h(Clock3, { className: 'size-4 shrink-0 text-white/60' }),
                h('span', { className: 'min-w-0 flex-1 truncate text-sm font-medium' }, st.contentName || '自由专注'),
                h('span', { className: 'shrink-0 text-xs text-white/50' }, st.mode === 'countdown' ? '倒计时' : '正计时'),
              ),
              h(
                'div',
                { className: 'mt-2 flex items-end justify-between gap-3' },
                h('span', { className: 'text-5xl font-bold leading-none tabular-nums' }, fmtClock(display)),
                h(
                  'span',
                  { className: 'pb-0.5 text-xs text-white/60' },
                  st.mode === 'countdown'
                    ? `已专注 ${fmtClock(elapsed)}`
                    : st.targetSec
                      ? `目标 ${fmtClock(st.targetSec)}`
                      : '不限时',
                ),
              ),
              st.paused &&
                h('span', { className: 'mt-2 inline-block rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white/80' }, '已暂停'),
            ),
            h(
              'button',
              {
                key: 'fullscreen',
                type: 'button',
                onClick: () => {
                  setDetailOpen(false)
                  // 页面监听 'sb-open-focus' 后切到专注视图；FocusApp 自己也会补收（挂载晚时）
                  requestOpenFocusView()
                },
                className:
                  'flex h-11 w-full items-center justify-center gap-1.5 rounded-full border text-sm font-semibold transition-colors hover:bg-zinc-50',
              },
              h(Maximize2, { key: 'ic', className: 'size-4' }),
              '全屏计时',
            ),
            h(
              'div',
              { className: 'flex gap-2' },
              h(
                'button',
                {
                  type: 'button',
                  onClick: st.paused ? resumeFocus : pauseFocus,
                  className:
                    'flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-zinc-900 text-sm font-medium text-white transition-colors hover:bg-zinc-800',
                },
                st.paused ? h(Play, { key: 'ic', className: 'size-4' }) : h(Pause, { key: 'ic', className: 'size-4' }),
                st.paused ? '继续' : '暂停',
              ),
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => {
                    setDetailOpen(false)
                    void stopFocus(true)
                  },
                  className: 'h-11 flex-1 rounded-full border text-sm font-semibold transition-colors hover:bg-zinc-50',
                },
                '结束并保存',
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  setDetailOpen(false)
                  void stopFocus(false)
                },
                className:
                  'mx-auto text-xs text-zinc-400 underline-offset-2 transition-colors hover:text-zinc-900 hover:underline',
              },
              '放弃并退出（不保存）',
            ),
          )
        : null,
      h(
        'div',
        { key: 'stats', className: 'rounded-2xl border p-3 text-sm text-muted-foreground' },
        statsErr
          ? '统计暂不可用，稍后再试'
          : stats
            ? `今日专注 ${stats.todayMin} 分钟 · 累计 ${stats.totalCount} 次`
            : '统计加载中…',
      ),
      soundSection('dsound'),
    ),
  )

  const timeUpDialog = h(
    Dialog,
    {
      key: 'timeup',
      open: timeUp !== null,
      onOpenChange: (o: boolean) => {
        if (!o) setTimeUp(null)
      },
    },
    h(
      DialogContent,
      { className: 'max-w-sm rounded-2xl' },
      h(
        DialogHeader,
        { className: 'items-center text-center' },
        h(DialogTitle, null, '时间到了'),
        h(
          DialogDescription,
          null,
          timeUp
            ? `「${timeUp.name}」已专注 ${fmtDurHuman(timeUp.seconds)}${timeUp.saved ? '，本次记录已保存' : ''}`
            : '',
        ),
      ),
      soundSection('tsound'),
      h(
        'div',
        { className: 'flex flex-col gap-2' },
        h(
          'button',
          {
            type: 'button',
            onClick: () => playFocusBell(),
            className:
              'flex h-11 items-center justify-center gap-2 rounded-full bg-zinc-900 text-sm font-medium text-white transition-colors hover:bg-zinc-800',
          },
          h(Volume2, { className: 'size-4' }),
          '播放铃声',
        ),
        h(
          'button',
          { type: 'button', onClick: () => setTimeUp(null), className: 'h-10 rounded-full text-sm text-zinc-500 transition-colors hover:text-zinc-900' },
          '好的',
        ),
      ),
    ),
  )

  return h(React.Fragment, null, pill, detailDialog, timeUpDialog)
}
