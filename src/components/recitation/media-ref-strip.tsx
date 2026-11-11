'use client'

// MediaRefStrip — 块顶富媒体引用条（替代原 BlockImageStrip）。
// 每个内容块（front/back 文本）顶部展示其中全部富媒体引用：
//   图片 → 缩略图；表格/思维导图/SVG/公式/代码 → 类型卡片
// 每个引用项：
//   • 点击 → 详情（MediaDetailDialog：放大/缩小/下载/复制引用）
//   • 右上角 ⋮ 更多按钮 / 长按（500ms）→ 菜单：
//       定位引用（跳到文本框对应位置）/ 复制引用 / 放大查看 / 可视化编辑 /
//       替换图片 / 二次裁剪 / 删除引用
//   • 左上角 +/- 快速缩放（3 档尺寸循环）
// 同一机制覆盖全部富媒体类型 — 与阅读视图 RichContent 同一渲染内核。

import * as React from 'react'
import {
  Braces,
  Code2,
  Crosshair,
  Copy,
  Crop,
  FileAudio,
  FileVideo,
  Maximize2,
  Network,
  PencilRuler,
  Plus,
  Table2,
  Trash2,
  Minus,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  MEDIA_KIND_LABEL,
  extractMediaRefs,
  type MediaRef,
  type MediaRefKind,
} from '@/components/recitation/media-refs'

export type MediaAction =
  | 'detail'
  | 'locate'
  | 'copy'
  | 'remove'
  | 'replace'
  | 'crop'
  | 'edit'
  | 'zoomIn'
  | 'zoomOut'

const KIND_ICON: Record<MediaRefKind, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  image: Plus,
  table: Table2,
  mermaid: Network,
  svg: PencilRuler,
  code: Code2,
  formula: Braces,
  audio: FileAudio,
  video: FileVideo,
}

const THUMB_SIZES = ['h-16 w-16', 'h-24 w-24', 'h-32 w-32'] as const

export function MediaRefStrip({
  content,
  onAction,
  className,
}: {
  content: string
  /** 动作回调（宿主绑定块 index/field 实现具体行为） */
  onAction: (action: MediaAction, ref: MediaRef) => void
  className?: string
}) {
  const refs = React.useMemo(() => extractMediaRefs(content), [content])
  const [sizeIdx, setSizeIdx] = React.useState(0)
  const [menuFor, setMenuFor] = React.useState<string | null>(null)
  const longPressTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 长按已触发菜单 → 抑制随后的 click（避免同时打开详情弹窗） */
  const suppressClickRef = React.useRef(false)

  // 卸载时清理长按计时器（防止组件卸载后 setState）
  React.useEffect(() => {
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current)
    }
  }, [])

  // Esc 关闭菜单
  React.useEffect(() => {
    if (!menuFor) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuFor(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuFor])

  if (refs.length === 0) return null

  const openMenu = (key: string) => {
    suppressClickRef.current = true
    setMenuFor(key)
    // 抑制标记在下一个宏任务里复位，仅吞掉本次手势的 click
    setTimeout(() => {
      suppressClickRef.current = false
    }, 350)
  }
  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }

  return (
    <div
      className={cn('flex flex-wrap items-start gap-2 rounded-xl bg-muted/40 p-2', className)}
      role="group"
      aria-label="块内富媒体引用"
    >
      {refs.map((ref, idx) => {
        const key = `${ref.kind}-${idx}-${ref.start}`
        const menuOpen = menuFor === key
        const Icon = KIND_ICON[ref.kind]
        return (
          <div
            key={key}
            className="relative"
            onPointerDown={(e) => {
              // 长按（触屏 500ms）→ 打开更多菜单；
              // ⚠️ 菜单已打开时不重启计时器（否则点遮罩关闭后 500ms 又自动弹出）
              if (e.pointerType === 'touch' && !menuOpen) {
                clearLongPress()
                longPressTimer.current = setTimeout(() => openMenu(key), 500)
              }
            }}
            onPointerUp={clearLongPress}
            onPointerCancel={clearLongPress}
            onPointerLeave={clearLongPress}
          >
            {/* 引用项本体：图片缩略图 / 类型卡片 */}
            <button
              type="button"
              aria-label={`${MEDIA_KIND_LABEL[ref.kind]}引用 ${idx + 1}，点击查看详情`}
              onClick={() => {
                if (suppressClickRef.current) return
                onAction('detail', ref)
              }}
              className={cn(
                'group relative overflow-hidden rounded-lg border border-border bg-background transition-transform active:scale-95',
                ref.kind === 'image' ? THUMB_SIZES[sizeIdx] : 'h-16 w-20',
              )}
            >
              {ref.kind === 'image' ? (
                <img
                  src={ref.src}
                  alt={ref.alt || '图片'}
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
                  <Icon className="size-5" strokeWidth={1.5} />
                  <span className="text-[10px] leading-none">{MEDIA_KIND_LABEL[ref.kind]}</span>
                </span>
              )}
            </button>

            {/* 左上：快速缩放（图片三档 / 富媒体两档切换尺寸） */}
            <button
              type="button"
              aria-label="放大尺寸"
              title="放大尺寸"
              onClick={(e) => {
                e.stopPropagation()
                setSizeIdx((i) => (i + 1) % THUMB_SIZES.length)
              }}
              className="absolute -left-1 -top-1 z-10 flex size-5 items-center justify-center rounded-full bg-zinc-900/80 text-white shadow transition-transform hover:scale-110"
            >
              <Maximize2 className="size-3" />
            </button>

            {/* 右上：更多按钮 */}
            <button
              type="button"
              aria-label={`${MEDIA_KIND_LABEL[ref.kind]}更多操作`}
              aria-expanded={menuOpen}
              onClick={(e) => {
                e.stopPropagation()
                // 函数式切换：菜单开着再点 ⋮ → 收起（此前被遮罩盖住导致无法收起）
                setMenuFor((v) => (v === key ? null : key))
              }}
              className={cn(
                'absolute -right-1 -top-1 z-50 flex size-5 items-center justify-center rounded-full bg-zinc-900/80 text-white shadow transition-transform hover:scale-110',
              )}
            >
              <span className="text-[10px] font-bold leading-none">⋮</span>
            </button>

            {/* 菜单 */}
            {menuOpen && (
              <>
                {/* 全屏点击遮罩：⚠️ 必须阻断冒泡 —— 否则 pointerdown 冒泡到条目容器
                    会重启 500ms 长按计时器，菜单「关闭后自动复活」*/}
                <div
                  className="fixed inset-0 z-40"
                  onClick={(e) => {
                    e.stopPropagation()
                    setMenuFor(null)
                  }}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    clearLongPress()
                    setMenuFor(null)
                  }}
                  aria-hidden
                />
                <div
                  role="menu"
                  aria-label={`${MEDIA_KIND_LABEL[ref.kind]}操作`}
                  className="absolute left-0 top-full z-50 mt-1 flex w-36 flex-col rounded-xl border border-border bg-popover p-1 shadow-xl"
                >
                  {(
                    [
                      { key: 'detail' as MediaAction, label: '放大查看', icon: Maximize2 },
                      { key: 'locate' as MediaAction, label: '定位引用', icon: Crosshair },
                      { key: 'copy' as MediaAction, label: '复制引用', icon: Copy },
                      { key: 'edit' as MediaAction, label: '可视化编辑', icon: PencilRuler, hide: ref.kind === 'image' },
                      { key: 'replace' as MediaAction, label: '替换图片', icon: Plus, hide: ref.kind !== 'image' },
                      { key: 'crop' as MediaAction, label: '二次裁剪', icon: Crop, hide: ref.kind !== 'image' },
                      { key: 'remove' as MediaAction, label: '删除引用', icon: Trash2 },
                    ] as const
                  )
                    .filter((it) => !('hide' in it && it.hide))
                    .map((it) => {
                      const MIcon = it.icon
                      return (
                        <button
                          key={it.key}
                          type="button"
                          role="menuitem"
                          onClick={(e) => {
                            e.stopPropagation()
                            setMenuFor(null)
                            onAction(it.key, ref)
                          }}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent',
                            it.key === 'remove' && 'text-destructive hover:bg-destructive/10',
                          )}
                        >
                          <MIcon className="size-4 shrink-0" strokeWidth={1.75} />
                          {it.label}
                        </button>
                      )
                    })}
                </div>
              </>
            )}
          </div>
        )
      })}
      {/* 快速缩小说明：点缩略图左上角循环放大 */}
      <span className="sr-only">
        共 {refs.length} 个富媒体引用；点击引用查看详情，右上角更多按钮或长按可操作
      </span>
    </div>
  )
}
