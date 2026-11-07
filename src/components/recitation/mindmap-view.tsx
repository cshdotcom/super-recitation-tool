'use client'

import * as React from 'react'
import {
  Loader2,
  Network,
  ChevronRight,
  ChevronDown,
  Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import type { MindNode } from '@/lib/types'
import { Button } from '@/components/ui/button'

interface MindmapViewProps {
  content: string
}

export function MindmapView({ content }: MindmapViewProps) {
  const [root, setRoot] = React.useState<MindNode | null>(null)
  const [loading, setLoading] = React.useState(false)

  const handleGenerate = async () => {
    if (!content.trim()) {
      toast.error('内容为空，无法生成思维导图')
      return
    }
    setLoading(true)
    const tid = toast.loading('AI 正在梳理知识结构…')
    try {
      const res = await fetch('/api/mindmap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '生成失败')
      }
      const data = (await res.json()) as { mindmap: MindNode }
      if (!data.mindmap) {
        toast.warning('AI 未返回思维导图', { id: tid })
        return
      }
      setRoot(data.mindmap)
      toast.success('思维导图已生成', { id: tid })
    } catch (err) {
      toast.error(
        '生成思维导图失败：' + (err instanceof Error ? err.message : '未知错误'),
        { id: tid },
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          {root
            ? '已生成 · 点击节点可折叠/展开'
            : '点击下方按钮，AI 将自动梳理课文知识结构'}
        </div>
        <Button
          size="sm"
          onClick={handleGenerate}
          disabled={loading || !content.trim()}
          className="bg-emerald-600 text-white hover:bg-emerald-700"
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
          {root ? '重新生成' : '生成思维导图'}
        </Button>
      </div>

      {!root ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
          <Network className="size-8 text-muted-foreground/40" />
          生成后将以树状结构展示知识点
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-muted/20 p-4">
          <div className="min-w-fit">
            {/* Root node */}
            <div className="mb-4 flex justify-center">
              <div className="rounded-full bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white shadow-sm">
                {root.title}
              </div>
            </div>
            {root.children && root.children.length > 0 && (
              <ul className="flex flex-col gap-2">
                {root.children.map((child, idx) => (
                  <MindmapNode key={idx} node={child} depth={0} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function MindmapNode({
  node,
  depth,
}: {
  node: MindNode
  depth: number
}) {
  const [collapsed, setCollapsed] = React.useState(false)
  const hasChildren = !!node.children && node.children.length > 0

  return (
    <li className="relative">
      <div
        className={cn(
          'flex items-center gap-1.5 rounded-lg border bg-background px-3 py-2 text-sm',
          'hover:bg-accent transition-colors',
          hasChildren && 'cursor-pointer',
        )}
        onClick={() => hasChildren && setCollapsed((c) => !c)}
        role={hasChildren ? 'button' : undefined}
        tabIndex={hasChildren ? 0 : undefined}
        onKeyDown={(e) => {
          if (hasChildren && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            setCollapsed((c) => !c)
          }
        }}
        style={{ marginLeft: depth * 0 }}
      >
        {hasChildren ? (
          collapsed ? (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="size-1.5 shrink-0 rounded-full bg-emerald-500/60" />
        )}
        <span className="font-medium">{node.title}</span>
      </div>

      {hasChildren && !collapsed && (
        <ul className="ml-3 mt-2 flex flex-col gap-2 border-l-2 border-emerald-500/30 pl-3">
          {node.children!.map((child, idx) => (
            <MindmapNode key={idx} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}
