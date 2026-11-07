'use client'

import * as React from 'react'
import { formatDistanceToNow } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import {
  ArchiveRestore,
  BarChart3,
  BookOpenText,
  BookX,
  CalendarClock,
  ClipboardList,
  LogOut,
  Plus,
  Settings as SettingsIcon,
  Star,
  Timer,
  Trash2,
} from 'lucide-react'

import type { AccountData, CardData } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
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
import { Skeleton } from '@/components/ui/skeleton'
import { ThemeToggle } from '@/components/theme-toggle'

interface HomeViewProps {
  cards: CardData[]
  loading: boolean
  account: AccountData
  onOpenCard: (card: CardData) => void
  onDelete: (id: string) => void
  onNew: () => void
  onOpenSettings: () => void
  onOpenAccount: () => void
  onLogout: () => void
  /** 学习工具入口（可选，默认空函数） */
  onOpenWrong?: () => void
  onOpenReport?: () => void
  onOpenFavorites?: () => void
  onOpenReviewStats?: () => void
  onOpenFocus?: () => void
  onOpenTrash?: () => void
  onOpenPlans?: () => void
}

export function HomeView({
  cards,
  loading,
  account,
  onOpenCard,
  onDelete,
  onNew,
  onOpenSettings,
  onOpenAccount,
  onLogout,
  onOpenWrong = () => {},
  onOpenReport = () => {},
  onOpenFavorites = () => {},
  onOpenReviewStats = () => {},
  onOpenFocus = () => {},
  onOpenTrash = () => {},
  onOpenPlans = () => {},
}: HomeViewProps) {
  return (
    <>
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-2 px-4">
          <div className="flex items-center gap-2 text-lg font-bold">
            <BookOpenText className="size-5 text-emerald-600" strokeWidth={1.75} />
            背书吧
          </div>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              aria-label="账号"
              onClick={onOpenAccount}
              className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <Avatar className="size-9 ring-1 ring-border transition hover:ring-emerald-600/50">
                {account.avatar ? (
                  <AvatarImage src={account.avatar} alt={account.username} />
                ) : null}
                <AvatarFallback className="bg-emerald-600 text-xs font-bold text-white">
                  {account.username.slice(0, 1) || '账'}
                </AvatarFallback>
              </Avatar>
            </button>
            <ThemeToggle />
            <Button
              variant="ghost"
              size="icon"
              aria-label="退出登录"
              className="text-muted-foreground"
              onClick={onLogout}
            >
              <LogOut className="size-5" strokeWidth={1.75} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="设置"
              className="text-muted-foreground"
              onClick={onOpenSettings}
            >
              <SettingsIcon className="size-5" strokeWidth={1.75} />
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pb-28 pt-5">
        {loading ? (
          <div className="grid grid-cols-2 gap-3">
            <Skeleton className="h-36 rounded-2xl" />
            <Skeleton className="h-36 rounded-2xl" />
            <Skeleton className="h-36 rounded-2xl" />
            <Skeleton className="h-36 rounded-2xl" />
          </div>
        ) : cards.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-3xl border border-dashed border-border py-20 text-center">
            <BookOpenText className="size-12 text-muted-foreground/30" strokeWidth={1.25} />
            <p className="text-base font-medium text-muted-foreground">还没有背书卡</p>
            <p className="text-sm text-muted-foreground/70">
              点击下方「新建背书卡」导入你的背诵内容
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {cards.map((card) => (
              <CardTile
                key={card.id}
                card={card}
                onOpen={() => onOpenCard(card)}
                onDelete={() => onDelete(card.id)}
              />
            ))}
          </div>
        )}

        {/* 学习工具入口 */}
        <section className="mt-6">
          <h2 className="text-sm text-muted-foreground">学习工具</h2>
          <div className="mt-2 grid grid-cols-4 gap-2">
            {(
              [
                { label: '专注', icon: Timer, onClick: onOpenFocus },
                { label: '复习计划', icon: CalendarClock, onClick: onOpenPlans },
                { label: '回收站', icon: ArchiveRestore, onClick: onOpenTrash },
                { label: '错题本', icon: BookX, onClick: onOpenWrong },
                { label: '答题报告', icon: ClipboardList, onClick: onOpenReport },
                { label: '收藏题目', icon: Star, onClick: onOpenFavorites },
                { label: '复习统计', icon: BarChart3, onClick: onOpenReviewStats },
              ] as const
            ).map((tool) => (
              <button
                key={tool.label}
                type="button"
                onClick={tool.onClick}
                className="flex flex-col items-center gap-1.5 rounded-xl border border-border bg-card py-3 text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <tool.icon className="size-5" strokeWidth={1.75} aria-hidden />
                <span className="text-[11px]">{tool.label}</span>
              </button>
            ))}
          </div>
        </section>
      </main>

      {/* Fixed bottom-center black pill button */}
      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center">
        <button
          type="button"
          onClick={onNew}
          className="pointer-events-auto flex h-12 items-center gap-2 rounded-full bg-primary px-6 text-sm font-semibold text-primary-foreground shadow-lg shadow-black/20 transition-transform hover:scale-[1.02] active:scale-95"
        >
          <Plus className="size-4.5" strokeWidth={2} aria-hidden />
          新建背书卡
        </button>
      </div>
    </>
  )
}

function CardTile({
  card,
  onOpen,
  onDelete,
}: {
  card: CardData
  onOpen: () => void
  onDelete: () => void
}) {
  const blankCount = card.keywords.length
  return (
    <div
      className={cn(
        'group relative flex min-h-36 cursor-pointer flex-col rounded-2xl border border-border bg-card p-4 shadow-sm transition-all',
        'hover:-translate-y-0.5 hover:shadow-md',
      )}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      aria-label={`打开背书卡：${card.title}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <div className="flex items-start gap-1">
        <h3 className="line-clamp-2 flex-1 text-sm font-bold leading-snug">{card.title}</h3>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button
              type="button"
              aria-label="删除背书卡"
              className="shrink-0 rounded-md p-1 text-muted-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive"
              onClick={(e) => e.stopPropagation()}
            >
              <Trash2 className="size-3.5" strokeWidth={1.75} />
            </button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除背书卡？</AlertDialogTitle>
              <AlertDialogDescription>
                将永久删除「{card.title}」，此操作不可撤销。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete()
                }}
              >
                删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <p className="mt-2 line-clamp-2 flex-1 text-xs leading-relaxed text-muted-foreground">
        {card.content.slice(0, 60) || '（空内容）'}
      </p>

      <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground/80">
        <span>{card.content.length} 字</span>
        <span aria-hidden>·</span>
        <span>{blankCount} 挖空</span>
        <span aria-hidden>·</span>
        <span>
          {formatDistanceToNow(new Date(card.updatedAt), { addSuffix: true, locale: zhCN })}
        </span>
      </div>

      {/* hover actions */}
      <div className="pointer-events-none absolute inset-x-4 bottom-11 flex justify-end opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
        <button
          type="button"
          className="flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground shadow"
          onClick={(e) => {
            e.stopPropagation()
            onOpen()
          }}
        >
          打开
        </button>
      </div>
    </div>
  )
}
