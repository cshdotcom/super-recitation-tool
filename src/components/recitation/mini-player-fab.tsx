'use client'

// 全局迷你悬浮播放按钮（MiniPlayerFab）—— 挂载在 page.tsx 根部一次：
// - 无播放状态时完全不渲染；有播放（本地起步 / 云端恢复）时显示 56px 可拖拽圆钮
// - 播放中：均衡器动画（4 根绿色跳动竖条）+ 呼吸光晕；暂停：静态 Pause 图标
// - 点击（位移 <8px）展开迷你条：书名+片段名、进度、播放/暂停、下一曲、X 完全停止
// - 换书冲突弹窗（playbackStart 返回 'conflict' 时）：替换 / 加入待播放列表 / 取消
// - 自动连播：监听 'app:ttsEnded'（TtsPlayer 顺序模式播完整本时广播）
//   → 播放 /api/playlist 中 ord 最小项并删除之
// - 跨设备同步：mount 时恢复云端播放态（远端恢复态），每 3s 轮询（playback.ts 内实现）
// - 位置持久化：/api/state key 'ui:miniPlayerPos'（默认右下角，避开底部 Tab 栏 ≥88px）

import * as React from 'react'
import { createPortal } from 'react-dom'
import { Cloud, ListMusic, Loader2, Pause, Play, SkipForward, X } from 'lucide-react'
import { toast } from 'sonner'

import type { SettingsData } from '@/lib/types'
import { clampSpeed } from '@/lib/voice-prefs'
import { useServerState } from '@/lib/use-server-state'
import {
  clearConflict,
  dispatchOpenTtsPlayer,
  getConflict,
  getDeviceId,
  getPlayback,
  playbackStop,
  playNextFromPlaylist,
  resolveConflictEnqueue,
  resolveConflictReplace,
  restorePlaybackFromCloud,
  setMiniFabActive,
  startPlaybackSync,
  stopPlaybackSync,
  subscribeConflicts,
  subscribePlayback,
  updatePlayback,
  type PlaybackState,
} from '@/lib/playback'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PlaylistSheet } from '@/components/recitation/playlist-sheet'

const FAB_SIZE = 56
const DRAG_SLOP = 8

export function MiniPlayerFab({
  settings,
  onExpand,
}: {
  settings: SettingsData
  /** 展开完整播放器时的本地回调（优先于 'app:openTtsPlayer' 事件） */
  onExpand?: (state: PlaybackState) => void
}) {
  const playback = React.useSyncExternalStore(subscribePlayback, getPlayback, () => null)
  const conflict = React.useSyncExternalStore(subscribeConflicts, getConflict, () => null)

  const [mounted, setMounted] = React.useState(false)
  const [expanded, setExpanded] = React.useState(false)
  const [playlistOpen, setPlaylistOpen] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)
  const [nextLoading, setNextLoading] = React.useState(false)
  const [viewportTick, setViewportTick] = React.useState(0)
  const [deviceId] = React.useState(() => (typeof window === 'undefined' ? '' : getDeviceId()))

  // 圆钮位置（服务端持久化 + localStorage 即时水合；null = 默认右下角）
  const [pos, setPos] = useServerState<{ x: number; y: number } | null>(
    'ui:miniPlayerPos',
    null,
  )

  // ---- 生命周期：fab 在场标记 / 云同步轮询 / 云端恢复 ----
  React.useEffect(() => {
    setMounted(true)
    setMiniFabActive(true)
    startPlaybackSync()
    void restorePlaybackFromCloud()
    return () => {
      setMiniFabActive(false)
      stopPlaybackSync()
    }
  }, [])

  // 播放会话消失（停止）时收起迷你条
  React.useEffect(() => {
    if (!playback) {
      setExpanded(false)
    }
  }, [playback])

  // ---- 音色/倍速默认值（连播/接管时给 store 一个合理初值，播放器随后覆盖） ----
  const defPrefRef = React.useRef({ speed: 1, voice: 'tongtong' })
  React.useEffect(() => {
    const p = settings?.voicePrefs?.['reader']?.tts ?? settings?.voicePrefs?.['tts']?.tts
    defPrefRef.current = {
      speed: clampSpeed(p?.speed ?? settings?.ttsSpeed ?? 1),
      voice: p?.voice ?? settings?.ttsVoice ?? 'tongtong',
    }
  }, [settings])

  // ---- 自动连播：TtsPlayer 播完整本（顺序模式）广播 'app:ttsEnded' ----
  React.useEffect(() => {
    const onEnded = () => {
      void (async () => {
        const st = await playNextFromPlaylist(defPrefRef.current)
        if (st) {
          dispatchOpenTtsPlayer({
            cardId: st.cardId,
            title: st.cardTitle,
            text: st.content ?? '',
            expand: false,
          })
        }
      })()
    }
    window.addEventListener('app:ttsEnded', onEnded)
    return () => window.removeEventListener('app:ttsEnded', onEnded)
  }, [])

  // ---- 位置：视口变化时夹回屏幕内 ----
  React.useEffect(() => {
    const onResize = () => setViewportTick((t) => t + 1)
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])

  const clampPos = (x: number, y: number): { x: number; y: number } => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    return {
      x: Math.min(Math.max(x, 8), Math.max(8, vw - FAB_SIZE - 8)),
      y: Math.min(Math.max(y, 8), Math.max(8, vh - FAB_SIZE - 8)),
    }
  }

  /** 默认位置：右下角，避开底部 Tab 栏（bottom ≥ 88px）。 */
  const defaultPos = (): { x: number; y: number } => ({
    x: window.innerWidth - FAB_SIZE - 16,
    y: window.innerHeight - FAB_SIZE - 88,
  })

  const effectivePos = React.useMemo(() => {
    void viewportTick
    if (!pos) return defaultPos()
    return clampPos(pos.x, pos.y)
  }, [pos, viewportTick])

  // ---- 拖拽（pointer events；位移 <8px 判定点击） ----
  const dragRef = React.useRef<{
    startX: number
    startY: number
    baseX: number
    baseY: number
    moved: boolean
  } | null>(null)

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: effectivePos.x,
      baseY: effectivePos.y,
      moved: false,
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return
    d.moved = true
    if (!dragging) setDragging(true)
    setPos(clampPos(d.baseX + dx, d.baseY + dy))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current
    dragRef.current = null
    setDragging(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    if (!d) return
    if (!d.moved) {
      // 点击：展开/收起迷你条
      setExpanded((v) => !v)
    }
    // 拖动结束：位置已由 useServerState 持久化（防抖 500ms PUT /api/state）
  }

  // ---- 播放控制 ----

  const openFullPlayer = () => {
    const st = getPlayback()
    if (!st) return
    if (onExpand) {
      onExpand(st)
      return
    }
    dispatchOpenTtsPlayer({
      cardId: st.cardId,
      title: st.cardTitle,
      text: st.content ?? '',
      expand: true,
    })
  }

  const handleTogglePlay = () => {
    const st = getPlayback()
    if (!st) return
    if (st.deviceId !== deviceId) {
      // 远端会话（云端恢复态）
      if (st.playing) {
        updatePlayback({ playing: false }) // 本机镜像暂停
      } else {
        // 本机接管：从 segIndex 续播
        updatePlayback({ deviceId, playing: true })
        dispatchOpenTtsPlayer({
          cardId: st.cardId,
          title: st.cardTitle,
          text: st.content ?? '',
          expand: true,
        })
      }
      return
    }
    if (st.playing) {
      window.dispatchEvent(new CustomEvent('app:ttsToggle'))
      return
    }
    // 续播：挂载中的 TtsPlayer 由 toggle 续播；未挂载的由打开事件 + 恢复效应从 segIndex 续播
    updatePlayback({ playing: true })
    window.dispatchEvent(new CustomEvent('app:ttsToggle'))
    dispatchOpenTtsPlayer({
      cardId: st.cardId,
      title: st.cardTitle,
      text: st.content ?? '',
      expand: false,
    })
  }

  const handleNext = async () => {
    if (nextLoading) return
    setNextLoading(true)
    try {
      const st = await playNextFromPlaylist(defPrefRef.current)
      if (!st) {
        toast.info('待播放列表是空的，去添加几本吧')
        setPlaylistOpen(true)
        return
      }
      toast.success(`连播：《${st.cardTitle}》${st.label ? ` · ${st.label}` : ''}`)
      dispatchOpenTtsPlayer({
        cardId: st.cardId,
        title: st.cardTitle,
        text: st.content ?? '',
        expand: false,
      })
    } finally {
      setNextLoading(false)
    }
  }

  /** X = 完全停止：不再显示播放按钮，也不再播放。 */
  const handleStop = () => {
    playbackStop()
    window.dispatchEvent(new CustomEvent('app:ttsStop'))
    setExpanded(false)
  }

  // ---- 渲染 ----

  if (!mounted || !playback) return null

  const isRemote = playback.deviceId !== deviceId
  const playing = playback.playing
  const segIndex = playback.segIndex
  const segTotal = playback.segTotal ?? 0
  const pct = segTotal > 0 ? Math.round(((segIndex + 1) / segTotal) * 100) : 0

  // 迷你条位置：圆钮在下半屏时向上弹出，否则向下
  const vw = window.innerWidth
  const vh = window.innerHeight
  const above = effectivePos.y > vh / 2
  const CARD_W = 288
  const cardRight = Math.min(
    Math.max(vw - (effectivePos.x + FAB_SIZE), 8),
    Math.max(8, vw - CARD_W - 8),
  )

  return createPortal(
    <>
      <style>{`
@keyframes bsb-eq { 0%, 100% { transform: scaleY(0.3); } 50% { transform: scaleY(1); } }
@keyframes bsb-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(16,185,129,.4), 0 8px 24px rgba(0,0,0,.28); }
  50% { box-shadow: 0 0 0 12px rgba(16,185,129,0), 0 8px 24px rgba(0,0,0,.28); }
}
`}</style>

      {/* 悬浮圆钮 */}
      <button
        type="button"
        aria-label={
          playing
            ? `正在朗读《${playback.cardTitle}》，点击展开迷你条，可拖动`
            : `朗读已暂停《${playback.cardTitle}》，点击展开迷你条，可拖动`
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setExpanded((v) => !v)
          }
        }}
        className={cn(
          'fixed z-[90] flex size-14 touch-none select-none items-center justify-center rounded-full border border-border bg-background/95 shadow-xl backdrop-blur transition-transform',
          dragging ? 'scale-105' : 'active:scale-95',
        )}
        style={{
          left: effectivePos.x,
          top: effectivePos.y,
          ...(playing ? { animation: 'bsb-glow 2.2s ease-in-out infinite' } : {}),
        }}
      >
        {playing ? (
          <span className="flex h-5 items-end gap-[3px]" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className="w-[3px] rounded-full bg-emerald-500"
                style={{
                  height: '100%',
                  transformOrigin: 'bottom',
                  animation: `bsb-eq ${0.9 + i * 0.14}s ease-in-out ${i * 0.12}s infinite`,
                }}
              />
            ))}
          </span>
        ) : (
          <Pause className="size-6 fill-current text-muted-foreground" aria-hidden />
        )}
        {/* 远端恢复态角标 */}
        {isRemote && (
          <span
            className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-sky-500 text-white shadow"
            aria-label="来自其他设备的播放进度"
          >
            <Cloud className="size-3" />
          </span>
        )}
      </button>

      {/* 展开的迷你条 */}
      {expanded && (
        <div
          className="fixed z-[91] w-72 rounded-3xl border border-border bg-background/95 p-3 shadow-2xl backdrop-blur"
          style={
            above
              ? { right: cardRight, bottom: vh - effectivePos.y + 12 }
              : { right: cardRight, top: effectivePos.y + FAB_SIZE + 12 }
          }
          role="dialog"
          aria-label="迷你播放条"
        >
          {/* 书名 + 片段名：点开完整播放器 */}
          <button type="button" className="w-full text-left" onClick={openFullPlayer}>
            <p className="truncate text-sm font-semibold">
              {playback.cardTitle || '未命名'}
            </p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {playback.label ? `片段 · ${playback.label}` : '整本'}
              {segTotal > 0 ? ` · 第 ${segIndex + 1}/${segTotal} 句` : ''}
              {isRemote ? ' · 其他设备播放中' : ''}
            </p>
          </button>

          {/* 进度条 */}
          <div
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <div
              className="h-full rounded-full bg-emerald-500 transition-[width] duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>

          {/* 控制行：播放列表 / 播放暂停 / 下一曲 / 关闭 */}
          <div className="mt-2.5 flex items-center justify-between">
            <button
              type="button"
              aria-label="打开待播放列表"
              onClick={() => setPlaylistOpen(true)}
              className="flex size-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ListMusic className="size-5" />
            </button>
            <button
              type="button"
              aria-label={playing ? '暂停' : '播放'}
              onClick={handleTogglePlay}
              className="flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md transition-transform active:scale-95"
            >
              {playing ? (
                <Pause className="size-5.5 fill-current" />
              ) : (
                <Play className="size-5.5 translate-x-px fill-current" />
              )}
            </button>
            <button
              type="button"
              aria-label="下一曲（播放列表）"
              onClick={() => void handleNext()}
              disabled={nextLoading}
              className="flex size-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {nextLoading ? (
                <Loader2 className="size-5 animate-spin" />
              ) : (
                <SkipForward className="size-5 fill-current" />
              )}
            </button>
            <button
              type="button"
              aria-label="停止并关闭播放"
              onClick={handleStop}
              className="flex size-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>
      )}

      {/* 换书冲突弹窗 */}
      <Dialog open={!!conflict} onOpenChange={(o) => (!o ? clearConflict() : undefined)}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>切换朗读内容？</DialogTitle>
            <DialogDescription>
              正在播放《{conflict?.current.cardTitle ?? ''}》，要播放
              《{conflict?.next.card.title ?? ''}》吗？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col gap-2">
            <Button className="h-11 w-full rounded-full" onClick={() => resolveConflictReplace()}>
              <Play className="size-4 fill-current" />
              替换当前播放
            </Button>
            <Button
              variant="outline"
              className="h-11 w-full rounded-full"
              onClick={() => {
                void resolveConflictEnqueue().then((ok) => {
                  toast[ok ? 'success' : 'error'](
                    ok ? '已加入待播放列表，当前播完后连播' : '添加失败，请重试',
                  )
                })
              }}
            >
              添加到待播放列表
            </Button>
            <Button
              variant="ghost"
              className="h-11 w-full rounded-full text-muted-foreground"
              onClick={() => clearConflict()}
            >
              取消
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 待播放列表 */}
      <PlaylistSheet open={playlistOpen} onOpenChange={setPlaylistOpen} />
    </>,
    document.body,
  )
}
