'use client'

import * as React from 'react'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'

// Shared bottom-sheet shell replicating the reference app:
// rounded-t-3xl white panel, drag handle bar, optional centered bold title + X.
interface BottomSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  /** Hide the built-in radix close button (we render our own X). */
  hideBuiltInClose?: boolean
  /** Show a custom X button in the top-right corner. */
  showClose?: boolean
  onTitleEdit?: () => void
  rightAction?: React.ReactNode
  children: React.ReactNode
  className?: string
}

export function BottomSheet({
  open,
  onOpenChange,
  title,
  hideBuiltInClose = true,
  showClose = true,
  rightAction,
  children,
  className,
}: BottomSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className={cn(
          'mx-auto h-[85vh] max-w-2xl rounded-t-3xl border-border px-4 pb-8 sm:rounded-t-3xl',
          hideBuiltInClose && '[&>button]:hidden',
          className,
        )}
      >
        <div
          aria-hidden
          className="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-muted-foreground/20"
        />
        {title && (
          <div className="relative mt-3 flex items-center justify-center">
            <SheetTitle className="text-center text-base font-bold">
              {title}
            </SheetTitle>
            <div className="absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-1">
              {rightAction}
              {showClose && (
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  aria-label="关闭"
                  className="flex size-7 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:text-foreground"
                >
                  <X className="size-4" strokeWidth={1.75} />
                </button>
              )}
            </div>
          </div>
        )}
        {children}
      </SheetContent>
    </Sheet>
  )
}
