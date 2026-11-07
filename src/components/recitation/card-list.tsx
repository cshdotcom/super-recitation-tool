'use client'

import * as React from 'react'
import { formatDistanceToNow } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import { Plus, Trash2, BookOpenText, FileText } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import type { CardData } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
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

interface CardListProps {
  cards: CardData[]
  currentId?: string
  onSelect: (card: CardData) => void
  onDelete: (id: string) => void
  onNew: () => void
}

export function CardList({
  cards,
  currentId,
  onSelect,
  onDelete,
  onNew,
}: CardListProps) {
  return (
    <Card className="gap-0 p-3 md:sticky md:top-20">
      <div className="flex items-center justify-between px-1 pb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">我的背书卡</h2>
          <Badge variant="secondary" className="px-2 py-0 text-xs">
            {cards.length}
          </Badge>
        </div>
      </div>

      <Button
        variant="default"
        size="sm"
        className="mb-3 h-9 w-full rounded-lg"
        onClick={onNew}
      >
        <Plus className="size-4" /> 新建背书卡
      </Button>

      {cards.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-2 py-10 text-center">
          <BookOpenText className="size-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            还没有背书卡
            <br />
            点击上方新建
          </p>
        </div>
      ) : (
        <ScrollArea className="max-h-[60vh] pr-2">
          <ul className="flex flex-col gap-1">
            {cards.map((card) => {
              const isActive = card.id === currentId
              const updated = new Date(card.updatedAt)
              return (
                <li key={card.id} className="group/item relative">
                  <button
                    type="button"
                    onClick={() => onSelect(card)}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-lg p-3 text-left transition-colors',
                      'hover:bg-accent',
                      isActive && 'bg-emerald-500/10 hover:bg-emerald-500/15',
                    )}
                  >
                    <FileText
                      className={cn(
                        'mt-0.5 size-4 shrink-0',
                        isActive ? 'text-emerald-600' : 'text-muted-foreground',
                      )}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="line-clamp-1 text-sm font-medium leading-snug">
                        {card.title || '未命名卡片'}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        挖空 {card.keywords.length} ·{' '}
                        {formatDistanceToNow(updated, {
                          addSuffix: true,
                          locale: zhCN,
                        })}
                      </span>
                    </span>
                  </button>

                  <div className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover/item:opacity-100 focus-within:opacity-100">
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          aria-label="删除该卡"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>删除该背书卡？</AlertDialogTitle>
                          <AlertDialogDescription>
                            「{card.title || '未命名卡片'}」将被永久删除，且无法恢复。
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>取消</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive text-white hover:bg-destructive/90"
                            onClick={() => {
                              onDelete(card.id)
                              toast.success('已删除背书卡')
                            }}
                          >
                            删除
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </li>
              )
            })}
          </ul>
        </ScrollArea>
      )}
    </Card>
  )
}
