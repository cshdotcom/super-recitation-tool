'use client'

// MediaEditDialog — 富媒体二次编辑弹窗：可视化 ⇄ 源码 双模式。
//   table   → 表格网格编辑器（增删行列、单元格编辑）
//   formula → 公式编辑器（KaTeX 实时预览 + 常用符号面板 + LaTeX 输入）
//   mermaid mindmap → 思维导图树编辑器（加/改名/删/移动节点）
//   svg / code / 其他 mermaid → 实时预览 + 源码编辑
// 应用后 onApply(newSrc) 由宿主替换块文本中的原文（可撤销）。

import * as React from 'react'
import katex from 'katex'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Code2,
  Eye,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  MEDIA_KIND_LABEL,
  isMindmap,
  parseMindmap,
  parseTable,
  serializeMindmap,
  serializeTable,
  type MediaRef,
  type MindNode,
  type TableGrid,
} from '@/components/recitation/media-refs'

const RichContentLazy = React.lazy(() =>
  import('@/components/recitation/rich-content').then((m) => ({ default: m.RichContent })),
)

// ---------- 表格网格编辑器 ----------

function TableGridEditor({ grid, onChange }: { grid: TableGrid; onChange: (g: TableGrid) => void }) {
  const setCell = (ri: number, ci: number, v: string) => {
    onChange({
      head: grid.head,
      rows: grid.rows.map((r, i) => (i === ri ? r.map((c, j) => (j === ci ? v : c)) : r)),
    })
  }
  const setHead = (ci: number, v: string) => {
    onChange({ head: grid.head.map((c, i) => (i === ci ? v : c)), rows: grid.rows })
  }
  const addRow = () => onChange({ head: grid.head, rows: [...grid.rows, grid.head.map(() => '')] })
  const addCol = () =>
    onChange({ head: [...grid.head, '新列'], rows: grid.rows.map((r) => [...r, '']) })
  const delRow = (ri: number) =>
    onChange({ head: grid.head, rows: grid.rows.filter((_, i) => i !== ri) })
  const delCol = (ci: number) => {
    if (grid.head.length <= 1) {
      toast.warning('至少保留 1 列')
      return
    }
    onChange({
      head: grid.head.filter((_, i) => i !== ci),
      rows: grid.rows.map((r) => r.filter((_, i) => i !== ci)),
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-muted/60">
              {grid.head.map((h, ci) => (
                <th key={ci} className="min-w-24 border-b border-border p-1">
                  <div className="flex items-center gap-1">
                    <Input
                      value={h}
                      aria-label={`表头 ${ci + 1}`}
                      onChange={(e) => setHead(ci, e.target.value)}
                      className="h-8 border-0 bg-transparent px-1.5 text-xs font-semibold focus-visible:ring-1"
                    />
                    <button
                      type="button"
                      aria-label={`删除列 ${ci + 1}`}
                      onClick={() => delCol(ci)}
                      className="shrink-0 rounded p-0.5 text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((c, ci) => (
                  <td key={ci} className="border-b border-border/50 p-1 align-top">
                    {ci === 0 ? (
                      <div className="flex items-center gap-1">
                        <Input
                          value={c}
                          aria-label={`单元格 ${ri + 1}-${ci + 1}`}
                          onChange={(e) => setCell(ri, ci, e.target.value)}
                          className="h-8 border-0 bg-transparent px-1.5 text-xs focus-visible:ring-1"
                        />
                        <button
                          type="button"
                          aria-label={`删除行 ${ri + 1}`}
                          onClick={() => delRow(ri)}
                          className="shrink-0 rounded p-0.5 text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </div>
                    ) : (
                      <Input
                        value={c}
                        aria-label={`单元格 ${ri + 1}-${ci + 1}`}
                        onChange={(e) => setCell(ri, ci, e.target.value)}
                        className="h-8 border-0 bg-transparent px-1.5 text-xs focus-visible:ring-1"
                      />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" onClick={addRow}>
          <Plus className="size-3.5" /> 加行
        </Button>
        <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" onClick={addCol}>
          <Plus className="size-3.5" /> 加列
        </Button>
      </div>
    </div>
  )
}

// ---------- 公式编辑器 ----------

const SYMBOLS: { label: string; insert: string }[] = [
  { label: 'x²', insert: 'x^2' },
  { label: 'xᵢ', insert: 'x_i' },
  { label: 'a/b', insert: '\\frac{a}{b}' },
  { label: '√x', insert: '\\sqrt{x}' },
  { label: '∑', insert: '\\sum_{i=1}^{n}' },
  { label: '∫', insert: '\\int_0^1' },
  { label: '×', insert: '\\times' },
  { label: '÷', insert: '\\div' },
  { label: '±', insert: '\\pm' },
  { label: '≤', insert: '\\leq' },
  { label: '≥', insert: '\\geq' },
  { label: '≠', insert: '\\neq' },
  { label: '∞', insert: '\\infty' },
  { label: 'π', insert: '\\pi' },
  { label: 'θ', insert: '\\theta' },
  { label: 'α', insert: '\\alpha' },
  { label: 'β', insert: '\\beta' },
  { label: 'Δ', insert: '\\Delta' },
  { label: '→', insert: '\\to' },
  { label: '∈', insert: '\\in' },
  { label: '化学', insert: '\\ce{H2O}' },
]

function FormulaEditor({
  src,
  onChange,
}: {
  src: string
  onChange: (s: string) => void
}) {
  const taRef = React.useRef<HTMLTextAreaElement>(null)
  const [preview, setPreview] = React.useState('')
  const [err, setErr] = React.useState('')

  React.useEffect(() => {
    try {
      setPreview(
        katex.renderToString(src || '\\text{（输入 LaTeX 公式）}', {
          displayMode: true,
          throwOnError: true,
          output: 'html',
        }),
      )
      setErr('')
    } catch (e) {
      setPreview('')
      setErr(e instanceof Error ? e.message : '公式语法错误')
    }
  }, [src])

  const insertSymbol = (ins: string) => {
    const el = taRef.current
    if (!el) {
      onChange(src + ins)
      return
    }
    const start = el.selectionStart ?? src.length
    const end = el.selectionEnd ?? start
    const next = src.slice(0, start) + ins + src.slice(end)
    onChange(next)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + ins.length, start + ins.length)
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex min-h-20 items-center justify-center overflow-x-auto rounded-xl bg-muted/50 p-3"
        aria-live="polite"
      >
        {err ? (
          <p className="text-xs text-destructive">公式语法错误：{err.slice(0, 120)}</p>
        ) : (
          <div
            className="katex-preview text-base"
            // KaTeX 输出（本项目 rich-content 同源渲染方式）
            dangerouslySetInnerHTML={{ __html: preview }}
          />
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {SYMBOLS.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => insertSymbol(s.insert)}
            className="shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-xs transition-colors hover:bg-muted"
          >
            {s.label}
          </button>
        ))}
      </div>
      <Textarea
        ref={taRef}
        value={src}
        onChange={(e) => onChange(e.target.value)}
        aria-label="LaTeX 源码"
        placeholder="输入 LaTeX，如 \frac{1}{2}mv^2"
        className="min-h-20 resize-none rounded-xl bg-muted/40 font-mono text-sm"
      />
    </div>
  )
}

// ---------- 思维导图树编辑器（不可变路径更新） ----------

/** 按路径定位节点并替换（不可变） */
function mapNode(
  root: MindNode,
  path: number[],
  fn: (n: MindNode) => MindNode,
): MindNode {
  if (path.length === 0) return fn(root)
  const [head, ...rest] = path
  return {
    ...root,
    children: root.children.map((c, i) => (i === head ? mapNode(c, rest, fn) : c)),
  }
}

/** 在父节点的 children 中按索引移动（不可变） */
function moveChild(n: MindNode, idx: number, dir: -1 | 1): MindNode {
  const j = idx + dir
  if (j < 0 || j >= n.children.length) return n
  const children = [...n.children]
  const [x] = children.splice(idx, 1)
  children.splice(j, 0, x)
  return { ...n, children }
}

function MindTreeItem({
  node,
  path,
  siblings,
  update,
}: {
  node: MindNode
  /** 从根到本节点的子索引路径（根 = []） */
  path: number[]
  /** 同级兄弟数量（根节点无父级 → 0，移动按钮禁用） */
  siblings: number
  /** 按路径不可变更新整树 */
  update: (path: number[], fn: (n: MindNode) => MindNode) => void
}) {
  const [open, setOpen] = React.useState(true)
  const parentPath = path.slice(0, -1)
  const myIndex = path[path.length - 1]
  const isRoot = path.length === 0

  return (
    <div className={cn(!isRoot && 'ml-4 border-l border-border pl-2')}>
      <div className="flex items-center gap-1 rounded-lg px-1 py-1 hover:bg-muted/50">
        {node.children.length > 0 ? (
          <button
            type="button"
            aria-label={open ? '折叠' : '展开'}
            onClick={() => setOpen((o) => !o)}
            className="shrink-0 rounded p-0.5 text-muted-foreground"
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        ) : (
          <span className="w-[18px] shrink-0" />
        )}
        <Input
          value={node.text}
          aria-label="节点名称"
          onChange={(e) => update(path, (n) => ({ ...n, text: e.target.value }))}
          className="h-8 flex-1 border-0 bg-transparent px-1 text-sm focus-visible:ring-1"
        />
        <button
          type="button"
          aria-label="上移节点"
          disabled={isRoot || myIndex === 0}
          onClick={() => update(parentPath, (p) => moveChild(p, myIndex, -1))}
          className="shrink-0 rounded p-1 text-muted-foreground/70 hover:bg-muted disabled:opacity-30"
        >
          <ArrowUp className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="下移节点"
          disabled={isRoot || myIndex >= siblings - 1}
          onClick={() => update(parentPath, (p) => moveChild(p, myIndex, 1))}
          className="shrink-0 rounded p-1 text-muted-foreground/70 hover:bg-muted disabled:opacity-30"
        >
          <ArrowDown className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="添加子节点"
          onClick={() =>
            update(path, (n) => ({
              ...n,
              children: [...n.children, { text: '新节点', children: [] }],
            }))
          }
          className="shrink-0 rounded p-1 text-emerald-600 hover:bg-emerald-500/10"
        >
          <Plus className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="删除节点"
          disabled={isRoot}
          onClick={() =>
            update(parentPath, (p) => ({
              ...p,
              children: p.children.filter((_, i) => i !== myIndex),
            }))
          }
          className="shrink-0 rounded p-1 text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive disabled:opacity-30"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      {open &&
        node.children.map((c, i) => (
          <MindTreeItem
            key={`${i}-${c.text}`}
            node={c}
            path={[...path, i]}
            siblings={node.children.length}
            update={update}
          />
        ))}
    </div>
  )
}

function MindmapEditor({
  root,
  onChange,
}: {
  root: MindNode
  onChange: (next: MindNode) => void
}) {
  const update = React.useCallback(
    (path: number[], fn: (n: MindNode) => MindNode) => {
      onChange(mapNode(root, path, fn))
    },
    [root, onChange],
  )
  return (
    <div className="flex flex-col gap-2">
      <div className="max-h-[46dvh] overflow-y-auto rounded-xl border border-border p-2">
        <MindTreeItem node={root} path={[]} siblings={0} update={update} />
      </div>
      <p className="text-[11px] text-muted-foreground">
        节点名称可直接编辑；「+」加子节点；箭头上下移动；根节点不可删除
      </p>
    </div>
  )
}

// ---------- 主弹窗 ----------

type EditTab = 'visual' | 'source'

export function MediaEditDialog({
  mediaRef,
  onOpenChange,
  onApply,
}: {
  mediaRef: MediaRef | null
  onOpenChange: (open: boolean) => void
  /** 应用：用新源码替换块文本中的原引用（raw） */
  onApply: (ref: MediaRef, newSrc: string) => void
}) {
  const [tab, setTab] = React.useState<EditTab>('visual')
  const [src, setSrc] = React.useState('')
  const [grid, setGrid] = React.useState<TableGrid | null>(null)
  const [tree, setTree] = React.useState<MindNode | null>(null)

  React.useEffect(() => {
    if (!mediaRef) return
    setSrc(mediaRef.src)
    setTab('visual')
    if (mediaRef.kind === 'table') {
      setGrid(parseTable(mediaRef.src))
    } else if (mediaRef.kind === 'mermaid' && isMindmap(mediaRef.src)) {
      setTree(parseMindmap(mediaRef.src))
    } else {
      setGrid(null)
      setTree(null)
    }
  }, [mediaRef])

  if (!mediaRef) return null
  const ref = mediaRef

  // 可视化模式可用性
  const visualAvailable =
    (ref.kind === 'table' && !!grid) ||
    (ref.kind === 'mermaid' && !!tree) ||
    ref.kind === 'formula'
  const activeTab: EditTab = tab === 'visual' && !visualAvailable ? 'source' : tab

  const apply = () => {
    let newSrc = src
    if (activeTab === 'visual') {
      if (ref.kind === 'table' && grid) newSrc = serializeTable(grid)
      else if (ref.kind === 'mermaid' && tree) newSrc = serializeMindmap(tree)
    }
    onApply(ref, newSrc)
  }

  return (
    <Dialog open={!!ref} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88dvh] overflow-y-auto rounded-2xl sm:max-w-xl">
        <DialogHeader className="pr-10">
          <DialogTitle>编辑{MEDIA_KIND_LABEL[ref.kind]}</DialogTitle>
          <DialogDescription>
            可视化编辑与源码编辑双模式，应用后替换原引用（可撤销）
          </DialogDescription>
        </DialogHeader>

        {/* 模式切换 */}
        <div className="flex rounded-full bg-muted p-1" role="tablist" aria-label="编辑模式">
          {(
            [
              { key: 'visual' as EditTab, label: '可视化', icon: Eye, disabled: !visualAvailable },
              { key: 'source' as EditTab, label: '源码', icon: Code2, disabled: false },
            ] as const
          ).map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={activeTab === t.key}
                disabled={t.disabled}
                onClick={() => setTab(t.key)}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1.5 rounded-full py-1.5 text-sm transition-colors',
                  activeTab === t.key
                    ? 'bg-background font-medium text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                  t.disabled && 'opacity-40',
                )}
              >
                <Icon className="size-4" /> {t.label}
                {!visualAvailable && t.key === 'visual' ? '（源码类型）' : ''}
              </button>
            )
          })}
        </div>

        <div className="min-h-40">
          {activeTab === 'visual' ? (
            ref.kind === 'table' && grid ? (
              <TableGridEditor grid={grid} onChange={setGrid} />
            ) : ref.kind === 'formula' ? (
              <FormulaEditor src={src} onChange={setSrc} />
            ) : ref.kind === 'mermaid' && tree ? (
              <MindmapEditor root={tree} onChange={setTree} />
            ) : null
          ) : (
            <div className="flex flex-col gap-3">
              <Textarea
                value={src}
                onChange={(e) => setSrc(e.target.value)}
                aria-label={`${MEDIA_KIND_LABEL[ref.kind]}源码`}
                placeholder="编辑源码…"
                className="min-h-36 resize-none rounded-xl bg-muted/40 font-mono text-sm"
              />
              {ref.kind !== 'formula' && (
                <div className="max-h-40 overflow-auto rounded-xl bg-muted/50 p-2">
                  <p className="pb-1 text-[11px] text-muted-foreground">预览</p>
                  <React.Suspense fallback={<p className="text-xs text-muted-foreground">渲染中…</p>}>
                    <RichContentLazy
                      content={
                        ref.kind === 'mermaid'
                          ? '```mermaid\n' + src + '\n```'
                          : ref.kind === 'svg'
                            ? '```svg\n' + src + '\n```'
                            : ref.kind === 'table'
                              ? src
                              : '```\n' + src + '\n```'
                      }
                    />
                  </React.Suspense>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            className="flex-1 rounded-full"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            className="flex-1 rounded-full bg-zinc-900 font-semibold text-white hover:bg-zinc-800"
            onClick={apply}
            disabled={!src.trim() && !grid && !tree}
          >
            <Loader2 className="hidden" aria-hidden />
            应用修改
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
