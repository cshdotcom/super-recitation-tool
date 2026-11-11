'use client'

import * as React from 'react'
import { ChevronLeft, Plus } from 'lucide-react'

import type { CardData, Mastery } from '@/lib/types'
import { cn } from '@/lib/utils'
import { BoxOpenIll, FilesStackIll } from '@/components/recitation/illustrations'

interface ReviewOverviewViewProps {
  cards: CardData[]
  /** 每张卡的复习状态（来自最新 ReviewLog） */
  statuses: Record<string, { mastery: Mastery; chapters: number }>
  onBack: () => void
  onOpenCard: (card: CardData) => void
  onNew: () => void
}

function statusInfo(
  mastery: Mastery | undefined,
  chapters: number,
): { text: string; cls: string } {
  switch (mastery) {
    case 'familiar':
      return { text: '已掌握', cls: 'text-emerald-600' }
    case 'fuzzy':
    case 'forget':
      return { text: `复习中(${chapters}章)`, cls: 'text-emerald-600' }
    default:
      return { text: '未复习', cls: 'text-muted-foreground' }
  }
}

// 复习总览页：全部背书卡的复习状态网格 + 右下角新建按钮。
// 进入时自取「待复习」列表，到期卡片标「待复习」徽标，点击直达背书页。
export function ReviewOverviewView({
  cards,
  statuses,
  onBack,
  onOpenCard,
  onNew,
}: ReviewOverviewViewProps) {
  // 到期待复习的卡片 id（SM-2 到期；null = 尚未加载完成，不显示徽标）
  const [dueIds, setDueIds] = React.useState<Set<string> | null>(null)

  React.useEffect(() => {
    let alive = true
    fetch('/api/review/due')
      .then((r) => (r.ok ? r.json() : { cards: [] }))
      .then((res: { cards?: { id: string }[] }) => {
        if (alive) setDueIds(new Set((res.cards ?? []).map((c) => c.id)))
      })
      .catch(() => {
        if (alive) setDueIds(new Set())
      })
    return () => {
      alive = false
    }
  }, [])
  return (
    <div className="flex min-h-screen flex-col bg-muted/40">
      {/* 顶栏 */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="relative mx-auto flex h-14 max-w-2xl items-center px-4">
          <button
            type="button"
            onClick={onBack}
            aria-label="返回"
            className="z-10 flex size-9 items-center justify-center rounded-full transition-colors hover:bg-muted"
          >
            <ChevronLeft className="size-6" strokeWidth={2} />
          </button>
          <h1 className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-lg font-bold">
            复习总览
          </h1>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pb-24 pt-5">
        {cards.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-3xl border border-dashed border-border py-16 text-center">
            <BoxOpenIll className="w-28" />
            <p className="text-base font-medium text-muted-foreground">还没有背书卡</p>
            <p className="text-sm text-muted-foreground/70">点击右下角「+」新建一张</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {cards.map((card) => {
              const st = statuses[card.id]
              const info = statusInfo(st?.mastery, st?.chapters ?? 0)
              return (
                <button
                  key={card.id}
                  type="button"
                  onClick={() => onOpenCard(card)}
                  className={cn(
                    'flex min-w-[160px] flex-col items-center rounded-2xl bg-card p-5 text-center shadow-sm',
                    'transition-transform hover:-translate-y-0.5',
                    'outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  )}
                >
                  <FilesStackIll className="mx-auto w-16" />
                  <div className="mt-3 flex w-full items-center justify-center gap-1.5">
                    <p className="min-w-0 truncate text-sm font-semibold">{card.title}</p>
                    {dueIds?.has(card.id) && (
                      <span className="shrink-0 rounded-full border border-amber-600/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">
                        待复习
                      </span>
                    )}
                  </div>
                  <p className={cn('mt-1 text-sm', info.cls)}>{info.text}</p>
                </button>
              )
            })}
          </div>
        )}
      </main>

      {/* 右下角新建 */}
      <button
        type="button"
        onClick={onNew}
        aria-label="新建背书卡"
        className="fixed bottom-8 right-6 z-40 flex size-14 items-center justify-center rounded-full bg-zinc-900 text-white shadow-lg shadow-black/20 transition-transform hover:scale-105 active:scale-95"
      >
        <Plus className="size-6" strokeWidth={2} />
      </button>
    </div>
  )
}
