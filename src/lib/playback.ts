// 全局播放状态中心（pub/sub 内存 store + /api/state 云端同步）。
// —— 由 MiniPlayerFab（根部挂载）负责轮询/恢复；TtsPlayer 通过 reportProgress
//    上报进度；reader 朗读按钮通过 playbackStart 接入（换书冲突 → fab 弹窗）。
// 云端 KV：key = "playback:current"，value = 状态 JSON（去掉 content —— 内容
// 太大不存云端，恢复时按 cardId 拉 /api/cards 补全）。
// 所有 window/localStorage 访问均做了 SSR 守卫，可在服务端安全 import。

import type { CardData } from '@/lib/types'

/** 云端 KV key：当前播放状态（不含 content）。 */
export const PLAYBACK_STATE_KEY = 'playback:current'

/** 本机设备 id 存储 key（localStorage）。 */
const DEVICE_ID_KEY = 'bsb_device_id'

/** 云端推送节流：最多 1 次/秒（trailing）。 */
const PUSH_MIN_INTERVAL_MS = 1000

/** 云端轮询间隔。 */
const POLL_INTERVAL_MS = 3000

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 播放片段（书的一部分）：按 startText/endText 在正文中定位。 */
export interface PlaybackFragment {
  /** 片段名（如「第3-5段」，整本播放时为空） */
  label?: string
  /** 起始段前 60 字（用于 indexOf 定位） */
  startText?: string
  /** 结束段后 60 字 */
  endText?: string
}

/** 全局播放状态（内存 store 的真源；云端副本不含 content）。 */
export interface PlaybackState {
  cardId: string
  cardTitle: string
  /** 本地有效朗读文本（片段已截取）；云端不存，恢复时按 cardId 拉取补全 */
  content?: string
  /** 片段名；整本播放为空 */
  label?: string
  startText?: string
  endText?: string
  /** 当前分段（句子）下标 */
  segIndex: number
  /** 分段总数（进度条用；播放器上报） */
  segTotal?: number
  playing: boolean
  speed: number
  voice: string
  updatedAt: number
  deviceId: string
}

/** playbackStart 的返回：'conflict' = 有别的书在播，已挂起冲突等 fab 弹窗裁决。 */
export type PlaybackStartResult = 'started' | 'conflict'

/** 换书冲突信息（fab 弹窗渲染用）。 */
export interface PlaybackConflict {
  current: PlaybackState
  next: {
    card: { id: string; title: string; content: string }
    fragment?: PlaybackFragment
  }
}

/** 'app:openTtsPlayer' 事件 detail —— fab/播放列表 → page.tsx 打开全局播放器。 */
export interface OpenTtsPlayerDetail {
  cardId: string
  title: string
  /** 有效朗读文本（片段已截取） */
  text: string
  /** true/缺省 = 展开完整播放器；false = 仅换内容，保持当前收起/展开状态 */
  expand?: boolean
}

// ---------------------------------------------------------------------------
// 设备 id
// ---------------------------------------------------------------------------

let cachedDeviceId = ''

/** 本机设备 id（localStorage 'bsb_device_id'，无则 crypto.randomUUID 生成）。 */
export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId
  if (typeof window === 'undefined') return 'ssr'
  try {
    let id = window.localStorage.getItem(DEVICE_ID_KEY)
    if (!id) {
      id =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      window.localStorage.setItem(DEVICE_ID_KEY, id)
    }
    cachedDeviceId = id
    return id
  } catch {
    return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// 内存 store（pub/sub）
// ---------------------------------------------------------------------------

let store: PlaybackState | null = null
const listeners = new Set<(s: PlaybackState | null) => void>()

function notify(): void {
  for (const fn of listeners) {
    try {
      fn(store)
    } catch {
      /* 单个订阅者异常不影响其他 */
    }
  }
}

/** 订阅播放状态变化（React useSyncExternalStore 友好）。 */
export function subscribePlayback(fn: (s: PlaybackState | null) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** 读取当前播放状态（null = 无播放）。 */
export function getPlayback(): PlaybackState | null {
  return store
}

/**
 * 写入播放状态并通知订阅者；默认安排云端推送（节流）。
 * opts.silent = 仅本地采纳远端镜像，不回推云端（避免回声）。
 */
export function setPlayback(
  s: PlaybackState | null,
  opts?: { silent?: boolean },
): void {
  store = s
  notify()
  if (s && !opts?.silent) schedulePush()
}

/** 增量更新当前状态（无会话时返回 null 不动作）。 */
export function updatePlayback(patch: Partial<PlaybackState>): PlaybackState | null {
  if (!store) return null
  store = {
    ...store,
    ...patch,
    deviceId: patch.deviceId ?? getDeviceId(),
    updatedAt: Date.now(),
  }
  notify()
  schedulePush()
  return store
}

// ---------------------------------------------------------------------------
// 全局迷你悬浮按钮（fab）在场标记 —— TtsPlayer 收起时据此隐藏自己的迷你条，
// 交由 MiniPlayerFab 接管，避免双悬浮条/白块残留。
// ---------------------------------------------------------------------------

let miniFabActive = false

export function setMiniFabActive(v: boolean): void {
  miniFabActive = v
}

/** 全局 fab 是否已挂载（true = TtsPlayer 收起时不渲染内置迷你条）。 */
export function hasMiniFab(): boolean {
  return miniFabActive
}

// ---------------------------------------------------------------------------
// 云端同步（HTTP 轮询 /api/state）
// ---------------------------------------------------------------------------

function serializeForCloud(s: PlaybackState): string {
  // content 不上云（体积大，恢复时按 cardId 拉）
  const { content, ...rest } = s
  void content
  return JSON.stringify(rest)
}

/** 防御式解析云端状态 JSON。 */
function parsePlaybackState(raw: unknown): PlaybackState | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const cardId = typeof r.cardId === 'string' ? r.cardId : ''
  const cardTitle = typeof r.cardTitle === 'string' ? r.cardTitle : ''
  return {
    cardId,
    cardTitle,
    content: undefined,
    label: typeof r.label === 'string' ? r.label : undefined,
    startText: typeof r.startText === 'string' ? r.startText : undefined,
    endText: typeof r.endText === 'string' ? r.endText : undefined,
    segIndex: typeof r.segIndex === 'number' && r.segIndex >= 0 ? Math.floor(r.segIndex) : 0,
    segTotal: typeof r.segTotal === 'number' ? Math.floor(r.segTotal) : undefined,
    playing: r.playing === true,
    speed: typeof r.speed === 'number' ? r.speed : 1,
    voice: typeof r.voice === 'string' ? r.voice : '',
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
    deviceId: typeof r.deviceId === 'string' ? r.deviceId : '',
  }
}

let lastPushAt = 0
let pushTimer: ReturnType<typeof setTimeout> | null = null
let pushPending = false

/** 节流推送：最多 1 次/秒，溢出安排 trailing 一次。 */
function schedulePush(): void {
  if (typeof window === 'undefined') return
  pushPending = true
  if (pushTimer) return
  const wait = Math.max(0, PUSH_MIN_INTERVAL_MS - (Date.now() - lastPushAt))
  pushTimer = setTimeout(() => {
    pushTimer = null
    if (!pushPending) return
    pushPending = false
    lastPushAt = Date.now()
    void pushNow()
  }, wait)
}

async function pushNow(): Promise<void> {
  const s = store
  if (!s) return
  try {
    await fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: PLAYBACK_STATE_KEY, value: serializeForCloud(s) }),
    })
  } catch {
    /* 离线等场景静默失败，下轮状态变化再推 */
  }
}

/** 按 id 拉取卡片（/api/cards → { cards: CardData[] }）。 */
export async function fetchCardById(cardId: string): Promise<CardData | null> {
  try {
    const res = await fetch('/api/cards')
    if (!res.ok) return null
    const data = (await res.json()) as { cards?: unknown }
    if (!data || !Array.isArray(data.cards)) return null
    const hit = data.cards.find(
      (c) => !!c && typeof c === 'object' && (c as { id?: unknown }).id === cardId,
    )
    return (hit as CardData) ?? null
  } catch {
    return null
  }
}

/** 轮询远端：远端更新且非本机 → 采纳（换卡时拉内容补全 content）。 */
async function pollRemotePlayback(): Promise<void> {
  if (typeof window === 'undefined') return
  try {
    const res = await fetch(`/api/state?key=${encodeURIComponent(PLAYBACK_STATE_KEY)}`)
    if (!res.ok) return
    const data = (await res.json()) as { values?: Record<string, string | null> }
    const raw = data.values?.[PLAYBACK_STATE_KEY]
    if (typeof raw !== 'string' || !raw) return
    const remote = parsePlaybackState(JSON.parse(raw) as unknown)
    if (!remote) return

    const myId = getDeviceId()
    const local = store

    // 停止标记（其他设备点了 X）：比本地新 → 清空本地镜像（不回推）
    if (!remote.cardId && !remote.playing) {
      if (local && remote.updatedAt > local.updatedAt) {
        store = null
        notify()
      }
      return
    }
    if (!remote.cardId) return
    // 自己的回声
    if (remote.deviceId === myId) return
    // 本机正在播放的会话优先，不被远端覆盖
    if (local && local.playing && local.deviceId === myId) return
    // 远端不比本地新
    if (remote.updatedAt <= (local?.updatedAt ?? 0)) return

    // 采纳远端：同卡保留本地 content，换卡拉卡片内容
    let content = local && local.cardId === remote.cardId ? local.content : undefined
    if (content == null) {
      const card = await fetchCardById(remote.cardId)
      if (!card) return // 卡片可能已删除
      content = extractFragment(card.content, remote.startText, remote.endText)
    }
    setPlayback({ ...remote, content }, { silent: true })
  } catch {
    /* 网络异常下轮静默跳过 */
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null
let syncRefCount = 0

/** 启动云端轮询（引用计数，MiniPlayerFab 挂载时调用一次）。 */
export function startPlaybackSync(): void {
  if (typeof window === 'undefined') return
  syncRefCount += 1
  if (pollTimer) return
  pollTimer = setInterval(() => {
    void pollRemotePlayback()
  }, POLL_INTERVAL_MS)
}

/** 停止云端轮询（与 startPlaybackSync 配对）。 */
export function stopPlaybackSync(): void {
  syncRefCount = Math.max(0, syncRefCount - 1)
  if (syncRefCount === 0 && pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/**
 * 刷新/新设备恢复：拉云端状态，若存在且 playing === true → 采纳为本地镜像
 * （拉卡片内容补全 content），fab 显示「远端恢复态」。
 */
export async function restorePlaybackFromCloud(): Promise<PlaybackState | null> {
  if (typeof window === 'undefined') return null
  if (store) return store // 本地已有会话优先
  try {
    const res = await fetch(`/api/state?key=${encodeURIComponent(PLAYBACK_STATE_KEY)}`)
    if (!res.ok) return null
    const data = (await res.json()) as { values?: Record<string, string | null> }
    const raw = data.values?.[PLAYBACK_STATE_KEY]
    if (typeof raw !== 'string' || !raw) return null
    const remote = parsePlaybackState(JSON.parse(raw) as unknown)
    if (!remote || !remote.cardId || remote.playing !== true) return null
    const card = await fetchCardById(remote.cardId)
    const content = card
      ? extractFragment(card.content, remote.startText, remote.endText)
      : ''
    const restored: PlaybackState = { ...remote, content }
    setPlayback(restored, { silent: true })
    return restored
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 播放控制
// ---------------------------------------------------------------------------

/**
 * 片段提取：正文 indexOf(startText) 起，到 endText 结束（含 endText）。
 * 定位失败回退整篇。
 */
export function extractFragment(
  content: string,
  startText?: string,
  endText?: string,
): string {
  const full = content ?? ''
  const s = (startText ?? '').trim()
  if (!s) return full
  const si = full.indexOf(s)
  if (si === -1) return full
  let e = full.length
  const en = (endText ?? '').trim()
  if (en) {
    const ei = full.indexOf(en, si + s.length)
    if (ei !== -1) e = ei + en.length
  }
  return full.slice(si, e)
}

function beginPlayback(
  card: { id: string; title: string; content: string },
  fragment: PlaybackFragment | undefined,
  opts?: { speed?: number; voice?: string },
): void {
  const text = fragment
    ? extractFragment(card.content, fragment.startText, fragment.endText)
    : card.content
  setPlayback({
    cardId: card.id,
    cardTitle: card.title,
    content: text,
    label: fragment?.label,
    startText: fragment?.startText,
    endText: fragment?.endText,
    segIndex: 0,
    segTotal: undefined,
    playing: true,
    speed: opts?.speed ?? 1,
    voice: opts?.voice ?? '',
    updatedAt: Date.now(),
    deviceId: getDeviceId(),
  })
}

/**
 * 开始播放一本书（可带片段）。
 * 若已有「别的书」正在播放 → 挂起冲突（返回 'conflict'，由 MiniPlayerFab
 * 弹窗让用户选择：替换 / 加入待播放列表 / 取消）。
 * opts.force = 跳过冲突检查直接替换（自动连播、播放列表点播用）。
 */
export function playbackStart(
  card: { id: string; title: string; content: string },
  fragment?: PlaybackFragment,
  opts?: { speed?: number; voice?: string; force?: boolean },
): PlaybackStartResult {
  const cur = store
  if (!opts?.force && cur && cur.playing && cur.cardId && cur.cardId !== card.id) {
    pendingConflict = { current: cur, next: { card, fragment } }
    notifyConflicts()
    return 'conflict'
  }
  // 同一本书 + 同一片段再次点「朗读」：保持进度续播，不重置到开头。
  // 暂停中 → 置为播放并通知挂载中的 TtsPlayer 续播（未挂载的由打开事件 + 恢复效应接管）。
  const sameFragment =
    cur &&
    cur.cardId === card.id &&
    (cur.startText ?? '') === (fragment?.startText ?? '') &&
    (cur.endText ?? '') === (fragment?.endText ?? '')
  if (sameFragment && cur) {
    if (!cur.playing) {
      updatePlayback({ playing: true, cardTitle: card.title })
      try {
        window.dispatchEvent(new CustomEvent('app:ttsToggle'))
      } catch {
        /* ignore */
      }
    }
    return 'started'
  }
  beginPlayback(card, fragment, opts)
  return 'started'
}

/** 完全停止：清 store + 云端写停止标记（其他设备轮询到后一并消失）。 */
export function playbackStop(): void {
  const prev = store
  store = null
  notify()
  if (typeof window === 'undefined') return
  const marker: PlaybackState = {
    cardId: '',
    cardTitle: '',
    content: undefined,
    segIndex: 0,
    segTotal: undefined,
    playing: false,
    speed: prev?.speed ?? 1,
    voice: prev?.voice ?? '',
    updatedAt: Date.now(),
    deviceId: getDeviceId(),
  }
  void fetch('/api/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: PLAYBACK_STATE_KEY, value: JSON.stringify(marker) }),
  }).catch(() => {
    /* ignore */
  })
}

// ---------------------------------------------------------------------------
// 进度上报（TtsPlayer → store；云端推送由本模块节流处理）
// ---------------------------------------------------------------------------

export interface PlaybackProgressPatch {
  cardId: string
  cardTitle?: string
  content?: string
  segIndex?: number
  segTotal?: number
  playing?: boolean
  speed?: number
  voice?: string
}

/**
 * TtsPlayer 播放/暂停/切段时上报。
 * - store 无会话且 playing=true（本地独立播放器起步）→ 创建会话；
 * - cardId 不匹配当前会话 → 忽略（选区朗读等互不干扰）；
 * - 本机上报即接管会话（deviceId 归本机）。
 */
export function reportProgress(patch: PlaybackProgressPatch): void {
  if (!patch.cardId) return
  const cur = store
  if (!cur) {
    if (patch.playing !== true) return
    setPlayback({
      cardId: patch.cardId,
      cardTitle: patch.cardTitle ?? '',
      content: patch.content,
      segIndex: patch.segIndex ?? 0,
      segTotal: patch.segTotal,
      playing: true,
      speed: patch.speed ?? 1,
      voice: patch.voice ?? '',
      updatedAt: Date.now(),
      deviceId: getDeviceId(),
    })
    return
  }
  if (cur.cardId !== patch.cardId) return
  setPlayback({
    ...cur,
    cardTitle: patch.cardTitle ?? cur.cardTitle,
    content: patch.content ?? cur.content,
    segIndex: patch.segIndex ?? cur.segIndex,
    segTotal: patch.segTotal ?? cur.segTotal,
    playing: patch.playing ?? cur.playing,
    speed: patch.speed ?? cur.speed,
    voice: patch.voice ?? cur.voice,
    updatedAt: Date.now(),
    deviceId: getDeviceId(),
  })
}

// ---------------------------------------------------------------------------
// 换书冲突（fab 弹窗消费）
// ---------------------------------------------------------------------------

let pendingConflict: PlaybackConflict | null = null
const conflictListeners = new Set<(c: PlaybackConflict | null) => void>()

function notifyConflicts(): void {
  for (const fn of conflictListeners) {
    try {
      fn(pendingConflict)
    } catch {
      /* ignore */
    }
  }
}

export function getConflict(): PlaybackConflict | null {
  return pendingConflict
}

export function subscribeConflicts(
  fn: (c: PlaybackConflict | null) => void,
): () => void {
  conflictListeners.add(fn)
  return () => {
    conflictListeners.delete(fn)
  }
}

/** 放弃冲突（用户点取消 / 关闭弹窗）。 */
export function clearConflict(): void {
  if (!pendingConflict) return
  pendingConflict = null
  notifyConflicts()
}

/** 冲突裁决：替换当前播放（并广播打开完整播放器）。 */
export function resolveConflictReplace(): void {
  const c = pendingConflict
  pendingConflict = null
  notifyConflicts()
  if (!c) return
  beginPlayback(c.next.card, c.next.fragment)
  dispatchOpenTtsPlayer({
    cardId: c.next.card.id,
    title: c.next.card.title,
    text: getPlayback()?.content ?? c.next.card.content,
    expand: true,
  })
}

/** 冲突裁决：新书加入待播放列表（POST /api/playlist，标题由后端自取）。 */
export async function resolveConflictEnqueue(): Promise<boolean> {
  const c = pendingConflict
  pendingConflict = null
  notifyConflicts()
  if (!c) return false
  return addToPlaylist([
    {
      cardId: c.next.card.id,
      label: c.next.fragment?.label,
      startText: c.next.fragment?.startText,
      endText: c.next.fragment?.endText,
    },
  ])
}

// ---------------------------------------------------------------------------
// 待播放列表（/api/playlist）
// ---------------------------------------------------------------------------

export interface PlayItem {
  id: string
  cardId: string
  cardTitle: string
  label: string
  startText: string
  endText: string
  ord: number
  createdAt: string
}

function parsePlayItems(raw: unknown): PlayItem[] {
  if (!Array.isArray(raw)) return []
  const out: PlayItem[] = []
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue
    const r = it as Record<string, unknown>
    if (typeof r.id !== 'string' || typeof r.cardId !== 'string') continue
    out.push({
      id: r.id,
      cardId: r.cardId,
      cardTitle: typeof r.cardTitle === 'string' ? r.cardTitle : '',
      label: typeof r.label === 'string' ? r.label : '',
      startText: typeof r.startText === 'string' ? r.startText : '',
      endText: typeof r.endText === 'string' ? r.endText : '',
      ord: typeof r.ord === 'number' ? r.ord : 0,
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
    })
  }
  return out
}

/** 拉取待播放列表（按 ord 升序）。 */
export async function fetchPlaylist(): Promise<PlayItem[]> {
  try {
    const res = await fetch('/api/playlist')
    if (!res.ok) return []
    const data = (await res.json()) as { items?: unknown }
    return parsePlayItems(data.items)
  } catch {
    return []
  }
}

/** 添加到待播放列表（可批量）。 */
export async function addToPlaylist(
  entries: {
    cardId: string
    label?: string
    startText?: string
    endText?: string
  }[],
): Promise<boolean> {
  const list = entries.filter((e) => e.cardId)
  if (list.length === 0) return false
  try {
    const res = await fetch('/api/playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(list.length === 1 ? list[0] : { items: list }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** 删除待播放列表项（id 列表）。 */
export async function removePlaylistItems(ids: string[]): Promise<boolean> {
  const q = ids.filter(Boolean).join(',')
  if (!q) return true
  try {
    const res = await fetch(`/api/playlist?ids=${encodeURIComponent(q)}`, {
      method: 'DELETE',
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * 自动连播 / 下一曲：取 ord 最小的待播项 → 播放它（force 替换当前会话）
 * → 从列表删除。返回新会话（列表空 / 失败返回 null）。
 */
export async function playNextFromPlaylist(opts?: {
  speed?: number
  voice?: string
}): Promise<PlaybackState | null> {
  const items = await fetchPlaylist()
  if (items.length === 0) return null
  const next = items[0]
  const card = await fetchCardById(next.cardId)
  if (!card) {
    // 卡片已删除：清掉这一项，避免死循环占位
    await removePlaylistItems([next.id]).catch(() => false as const)
    return null
  }
  const fragment: PlaybackFragment | undefined =
    next.label || next.startText || next.endText
      ? {
          label: next.label || undefined,
          startText: next.startText || undefined,
          endText: next.endText || undefined,
        }
      : undefined
  beginPlayback(
    { id: card.id, title: card.title, content: card.content },
    fragment,
    { speed: opts?.speed, voice: opts?.voice },
  )
  await removePlaylistItems([next.id]).catch(() => false as const)
  return getPlayback()
}

// ---------------------------------------------------------------------------
// window 事件桥（fab / 播放列表 → page.tsx 打开全局播放器）
// ---------------------------------------------------------------------------

/** 广播打开全局播放器（page.tsx 监听 'app:openTtsPlayer' 接线）。 */
export function dispatchOpenTtsPlayer(detail: OpenTtsPlayerDetail): void {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent<OpenTtsPlayerDetail>('app:openTtsPlayer', { detail }))
  } catch {
    /* ignore */
  }
}
