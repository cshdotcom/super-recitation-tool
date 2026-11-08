'use client'

import * as React from 'react'
import { ChevronLeft, Loader2, Star } from 'lucide-react'
import { toast } from 'sonner'

import type { QuizItemData, QuizType } from '@/lib/types'

interface FavoritesViewProps {
  onBack: () => void
}

const TYPE_LABEL: Record<QuizType, string> = {
  fill: '填空',
  short: '简答',
  choice: '选择',
}

// 空状态简笔画：打开的纸箱（浅紫箱体 + 黑描边 + 白标签 + 上方放射短线）
function EmptyFavoritesIllustration() {
  return (
    <svg viewBox="0 0 140 120" className="h-28 w-32" fill="none" aria-hidden role="img">
      {/* 放射短线 */}
      <path
        d="M70 22 V10 M50 26 l-6 -9 M90 26 l6 -9 M34 38 l-10 -5 M106 38 l10 -5"
        stroke="#171717"
        strokeWidth="2"
        strokeLinecap="round"
      />
      {/* 打开的纸箱：后箱壁 */}
      <path
        d="M36 58 L70 44 L104 58 L104 92 L70 106 L36 92 Z"
        fill="#c7c9f5"
        stroke="#171717"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* 翻开的两片盖子 */}
      <path
        d="M36 58 L14 48 L46 36 L70 44 Z"
        fill="#dcdcfb"
        stroke="#171717"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M104 58 L126 48 L94 36 L70 44 Z"
        fill="#dcdcfb"
        stroke="#171717"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* 前箱壁 */}
      <path
        d="M36 58 L70 72 L104 58 L104 92 L70 106 L36 92 Z"
        fill="#c7c9f5"
        stroke="#171717"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* 白色标签 */}
      <rect x="56" y="76" width="28" height="18" rx="3" fill="#ffffff" stroke="#171717" strokeWidth="1.6" />
      <path d="M61 82 h18 M61 87 h12" stroke="#171717" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

// 收藏题目：列表 + 取消收藏（全屏视图）
export function FavoritesView({ onBack }: FavoritesViewProps) {
  const [items, setItems] = React.useState<QuizItemData[]>([])
  const [loading, setLoading] = React.useState(true)
  const [removingId, setRemovingId] = React.useState<string | null>(null)

  React.useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await fetch('/api/quiz-items?favorite=1')
        if (!res.ok) throw new Error('加载收藏失败')
        const data = (await res.json()) as { items: QuizItemData[] }
        if (alive) setItems(data.items ?? [])
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '加载收藏失败')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const unfavorite = async (id: string) => {
    setRemovingId(id)
    try {
      const res = await fetch('/api/quiz-items', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, favorite: false }),
      })
      if (!res.ok) throw new Error('取消收藏失败')
      setItems((list) => list.filter((i) => i.id !== id))
      toast.success('已取消收藏')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '取消收藏失败')
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <div className="min-h-dvh bg-muted/40">
      {/* 顶栏 */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="relative mx-auto flex h-14 max-w-2xl items-center px-4">
          <button
            type="button"
            aria-label="返回"
            onClick={onBack}
            className="shrink-0 rounded-full p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="size-6 text-foreground" strokeWidth={2} />
          </button>
          <h1 className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-lg font-bold">
            收藏题目
          </h1>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 pb-16 pt-4">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-24 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            <span className="text-sm">加载中…</span>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-4 pt-16 text-center">
            <EmptyFavoritesIllustration />
            <p className="text-sm text-muted-foreground">暂无收藏题目，快去添加吧</p>
          </div>
        ) : (
          <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto">
            {items.map((item) => (
              <div key={item.id} className="rounded-2xl bg-card p-4">
                <div className="flex items-start gap-2">
                  <span className="shrink-0 rounded-lg bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {TYPE_LABEL[item.type] ?? '题目'}
                  </span>
                  <p className="text-[15px] font-medium leading-relaxed">{item.question}</p>
                </div>
                <div className="mt-3 rounded-lg bg-muted px-3 py-2">
                  <p className="text-xs text-muted-foreground">答案</p>
                  <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed">
                    {item.answer || '（无标准答案）'}
                  </p>
                </div>
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    disabled={removingId === item.id}
                    onClick={() => unfavorite(item.id)}
                    className="flex h-9 items-center gap-1.5 rounded-full border border-border px-4 text-sm text-muted-foreground transition-colors hover:border-red-500/40 hover:text-red-500 disabled:opacity-50"
                  >
                    {removingId === item.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Star className="size-3.5" strokeWidth={2} />
                    )}
                    取消收藏
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
