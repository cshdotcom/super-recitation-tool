'use client'

// MediaEditDialog — 富媒体二次编辑弹窗：可视化 ⇄ 源码 双模式 + 容错 + AI。
//   table   → 表格网格编辑器（增删行列、单元格编辑）
//   formula → 公式编辑器（KaTeX 实时预览 + 常用符号面板 + LaTeX 输入）
//   mermaid mindmap → 思维导图树编辑器（加/改名/删/移动节点）
//   mermaid graph/flowchart → 流程图结构化编辑器（节点 + 连线，Select 选端点）
//   svg → SVG 可视化编辑器（形状面板 / 画布拖拽 / 属性栏，复杂元素源码保留）
//   其他 code → 实时预览 + 源码编辑
// 容错（apply 前校验 + 部分加载 + AI 修复）：
//   • mermaid：mermaid.parse 校验；失败时按错误行号逐行剥离出「净化版」预览，
//     顶部黄色横幅提示「第 X 行有误已忽略」，可 AI 修复 / 仍用原文
//   • svg：DOMParser parsererror 校验；formula：katex renderToString 校验
//   • AI 修复：调 /api/media-ai 返回修复代码先预览 → 接纳 / 撤销
// AI 助理：右下角临时悬浮对话（AiAssistPopover），生成代码一键写入编辑器，
//   写入后自动切回可视化继续编辑。
// 应用后 onApply(newSrc) 由宿主替换块文本中的原文（可撤销）。

import * as React from 'react'
import katex from 'katex'
// 化学公式扩展（\ce{}）——与 rich-content 共享同一 katex 实例，弹窗内独立可用
import 'katex/contrib/mhchem'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Eye,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  Undo2,
  Wand2,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  MEDIA_KIND_LABEL,
  buildFlow,
  isMindmap,
  parseFlow,
  parseMindmap,
  parseTable,
  serializeMindmap,
  serializeTable,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  type FlowShape,
  type MediaKind,
  type MediaRef,
  type MindNode,
  type TableGrid,
} from '@/components/recitation/media-refs'
import { AiAssistPopover } from '@/components/recitation/ai-assist-popover'
import { SvgVisualEditor } from '@/components/recitation/media-svg-editor'

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

// ---------- 流程图结构化编辑器（graph / flowchart） ----------

const FLOW_SHAPES: Array<{ value: FlowShape; label: string }> = [
  { value: 'rect', label: '方块' },
  { value: 'round', label: '圆角' },
  { value: 'diamond', label: '菱形' },
  { value: 'circle', label: '圆形' },
]

function FlowEditor({
  flow,
  onChange,
}: {
  flow: FlowGraph
  onChange: (f: FlowGraph) => void
}) {
  const [section, setSection] = React.useState<'nodes' | 'edges'>('nodes')

  const genId = () => {
    let i = flow.nodes.length + 1
    let id = `N${i}`
    while (flow.nodes.some((n) => n.id === id)) {
      i += 1
      id = `N${i}`
    }
    return id
  }
  const setNode = (id: string, patch: Partial<FlowNode>) =>
    onChange({ ...flow, nodes: flow.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) })
  const addNode = () =>
    onChange({ ...flow, nodes: [...flow.nodes, { id: genId(), label: '新节点', shape: 'rect' }] })
  const delNode = (id: string) =>
    onChange({
      nodes: flow.nodes.filter((n) => n.id !== id),
      edges: flow.edges.filter((e) => e.from !== id && e.to !== id),
      dir: flow.dir,
    })
  const setEdge = (i: number, patch: Partial<FlowEdge>) =>
    onChange({ ...flow, edges: flow.edges.map((e, k) => (k === i ? { ...e, ...patch } : e)) })
  const addEdge = () => {
    if (flow.nodes.length < 2) {
      toast.warning('请先添加至少两个节点')
      return
    }
    onChange({
      ...flow,
      edges: [...flow.edges, { from: flow.nodes[0].id, to: flow.nodes[1].id, style: '-->' }],
    })
  }

  const delBtn =
    'shrink-0 rounded p-1 text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive'

  return (
    <div className="flex flex-col gap-2">
      {/* 分区切换 + 方向 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-full bg-muted p-1" role="tablist" aria-label="流程图编辑分区">
          {(
            [
              { key: 'nodes' as const, label: `节点 ${flow.nodes.length}` },
              { key: 'edges' as const, label: `连线 ${flow.edges.length}` },
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={section === t.key}
              onClick={() => setSection(t.key)}
              className={cn(
                'rounded-full px-3 py-1 text-xs transition-colors',
                section === t.key
                  ? 'bg-background font-medium text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-1">
          <Button
            variant="outline"
            size="sm"
            aria-label="自上而下布局"
            className={cn(
              'h-7 rounded-full px-2.5 text-xs',
              (flow.dir === 'TD' || flow.dir === 'TB') && 'border-primary text-primary',
            )}
            onClick={() => onChange({ ...flow, dir: 'TD' })}
          >
            纵向
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label="自左向右布局"
            className={cn(
              'h-7 rounded-full px-2.5 text-xs',
              flow.dir === 'LR' && 'border-primary text-primary',
            )}
            onClick={() => onChange({ ...flow, dir: 'LR' })}
          >
            横向
          </Button>
        </div>
      </div>

      <div className="max-h-[46dvh] space-y-1.5 overflow-y-auto rounded-xl border border-border p-2">
        {section === 'nodes' ? (
          <>
            {flow.nodes.map((n) => (
              <div key={n.id} className="flex items-center gap-1.5">
                <span
                  className="shrink-0 rounded-md bg-muted px-1.5 py-1 font-mono text-[10px] text-muted-foreground"
                  aria-label={`节点标识 ${n.id}`}
                >
                  {n.id}
                </span>
                <Input
                  value={n.label}
                  aria-label={`节点 ${n.id} 名称`}
                  onChange={(e) => setNode(n.id, { label: e.target.value })}
                  className="h-8 min-w-0 flex-1 rounded-lg text-sm"
                />
                <Select
                  value={n.shape ?? 'rect'}
                  onValueChange={(v) => setNode(n.id, { shape: v as FlowShape })}
                >
                  <SelectTrigger
                    size="sm"
                    aria-label={`节点 ${n.id} 形状`}
                    className="h-8 w-[74px] shrink-0 rounded-lg text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FLOW_SHAPES.map((s) => (
                      <SelectItem key={s.value} value={s.value} className="text-xs">
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <button
                  type="button"
                  aria-label={`删除节点 ${n.id}`}
                  onClick={() => delNode(n.id)}
                  className={delBtn}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-full rounded-full text-xs"
              onClick={addNode}
            >
              <Plus className="size-3.5" /> 添加节点
            </Button>
          </>
        ) : (
          <>
            {flow.edges.map((e, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1.5">
                <Select value={e.from} onValueChange={(v) => setEdge(i, { from: v })}>
                  <SelectTrigger
                    size="sm"
                    aria-label={`连线 ${i + 1} 起点`}
                    className="h-8 min-w-20 flex-1 rounded-lg text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {flow.nodes.map((n) => (
                      <SelectItem key={n.id} value={n.id} className="text-xs">
                        {n.label || n.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span aria-hidden className="text-xs text-muted-foreground">
                  →
                </span>
                <Select value={e.to} onValueChange={(v) => setEdge(i, { to: v })}>
                  <SelectTrigger
                    size="sm"
                    aria-label={`连线 ${i + 1} 终点`}
                    className="h-8 min-w-20 flex-1 rounded-lg text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {flow.nodes.map((n) => (
                      <SelectItem key={n.id} value={n.id} className="text-xs">
                        {n.label || n.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={e.label ?? ''}
                  placeholder="连线文字（可空）"
                  aria-label={`连线 ${i + 1} 文字`}
                  onChange={(ev) => setEdge(i, { label: ev.target.value })}
                  className="h-8 min-w-24 flex-1 rounded-lg text-xs"
                />
                <button
                  type="button"
                  aria-label={`删除连线 ${i + 1}`}
                  onClick={() =>
                    onChange({ ...flow, edges: flow.edges.filter((_, k) => k !== i) })
                  }
                  className={delBtn}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-full rounded-full text-xs"
              onClick={addEdge}
              disabled={flow.nodes.length < 2}
            >
              <Plus className="size-3.5" /> 添加连线
            </Button>
          </>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        节点：改名 / 换形状 / 删除（自动移除相关连线）；连线：选起点终点、可加文字；删除节点前先记住被引用的连线
      </p>
    </div>
  )
}

// ---------- 语法校验 + 部分加载 ----------

type Verdict = { ok: true } | { ok: false; message: string; line?: number }

/** mermaid 语法校验（动态加载 mermaid，与 rich-content 渲染同一内核）；错误信息带行号时提取。 */
async function validateMermaidSrc(code: string): Promise<Verdict> {
  if (!code.trim()) return { ok: true }
  try {
    const mermaid = (await import('mermaid')).default
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
    await mermaid.parse(code)
    return { ok: true }
  } catch (e) {
    const message =
      e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e ?? '')
    const m = message.match(/line\s*(\d+)/i) || message.match(/第\s*(\d+)\s*行/)
    const line = m ? parseInt(m[1], 10) : undefined
    return { ok: false, message: message.slice(0, 200) || '语法错误', line }
  }
}

/** SVG 源码校验（DOMParser parsererror）。 */
function validateSvgSrc(code: string): Verdict {
  if (!code.trim()) return { ok: true }
  try {
    const doc = new DOMParser().parseFromString(code, 'image/svg+xml')
    const err = doc.querySelector('parsererror')
    if (err) {
      return { ok: false, message: ('SVG 解析错误：' + (err.textContent || '')).slice(0, 200) }
    }
    if (doc.documentElement && doc.documentElement.tagName.toLowerCase() !== 'svg') {
      return { ok: false, message: 'SVG 源码必须以 <svg> 根元素开头' }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, message: (e instanceof Error ? e.message : 'SVG 解析失败').slice(0, 200) }
  }
}

/** LaTeX 公式校验（katex renderToString）。 */
function validateFormulaSrc(code: string): Verdict {
  if (!code.trim()) return { ok: true }
  try {
    katex.renderToString(code, { throwOnError: true, displayMode: true, output: 'html' })
    return { ok: true }
  } catch (e) {
    return {
      ok: false,
      message: ('公式语法错误：' + (e instanceof Error ? e.message : '')).slice(0, 200),
    }
  }
}

async function validateMediaSrc(kind: MediaKind, code: string): Promise<Verdict> {
  if (kind === 'mermaid') return validateMermaidSrc(code)
  if (kind === 'svg') return validateSvgSrc(code)
  if (kind === 'formula') return validateFormulaSrc(code)
  return { ok: true } // table / code / image 不校验
}

/**
 * mermaid 部分加载：整体解析失败时按错误行号逐行剥离出错行重试（最多 6 次），
 * 成功返回净化版 + 被移除的原始行号；无法定位行号 / 剥到声明行 → null。
 */
async function partialLoadMermaid(
  code: string,
  first: Verdict,
): Promise<{ clean: string; removedOrig: number[] } | null> {
  if (!first.ok && first.line == null) return null
  const lines = code.split(/\r?\n/)
  const origIdx = lines.map((_, i) => i + 1)
  let errLine = first.ok ? undefined : first.line
  const removedOrig: number[] = []
  for (let iter = 0; iter < 6; iter++) {
    // 第 1 行是声明行（mindmap / graph TD），不能删；越界也无法继续
    if (errLine == null || errLine < 2 || errLine > lines.length) return null
    removedOrig.push(origIdx[errLine - 1])
    lines.splice(errLine - 1, 1)
    origIdx.splice(errLine - 1, 1)
    const verdict = await validateMermaidSrc(lines.join('\n'))
    if (verdict.ok) return { clean: lines.join('\n'), removedOrig }
    errLine = verdict.ok ? undefined : verdict.line
  }
  return null
}

// ---------- 主弹窗 ----------

type EditTab = 'visual' | 'source'

/** 实时校验状态 */
type CheckState =
  | { status: 'ok' }
  | { status: 'checking' }
  | { status: 'error'; message: string; line?: number }
  | { status: 'partial'; clean: string; removedOrig: number[]; message: string }

/** MediaKind → /api/media-ai kind */
function apiKindOf(ref: MediaRef): 'mermaid' | 'svg' | 'table' | 'formula' | 'code' {
  if (ref.kind === 'mermaid' || ref.kind === 'svg' || ref.kind === 'table' || ref.kind === 'formula') {
    return ref.kind
  }
  return 'code'
}

/** 源码 → RichContent 可渲染文本（预览 / AI 修复预览共用） */
function renderableOf(kind: MediaKind, code: string): string {
  switch (kind) {
    case 'mermaid':
      return '```mermaid\n' + code + '\n```'
    case 'svg':
      return '```svg\n' + code + '\n```'
    case 'table':
      return code
    case 'formula':
      return '$$' + code + '$$'
    default:
      return '```\n' + code + '\n```'
  }
}

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
  const [flow, setFlow] = React.useState<FlowGraph | null>(null)

  // 容错 + AI
  const [check, setCheck] = React.useState<CheckState>({ status: 'ok' })
  const [forceOriginal, setForceOriginal] = React.useState(false)
  const [fix, setFix] = React.useState<{ loading: boolean; code: string | null } | null>(null)
  const [applying, setApplying] = React.useState(false)
  const [aiOpen, setAiOpen] = React.useState(false)
  const checkGenRef = React.useRef(0)

  React.useEffect(() => {
    if (!mediaRef) return
    setSrc(mediaRef.src)
    setTab('visual')
    setForceOriginal(false)
    setFix(null)
    setAiOpen(false)
    setCheck({ status: 'ok' })
    if (mediaRef.kind === 'table') {
      setGrid(parseTable(mediaRef.src))
      setTree(null)
      setFlow(null)
    } else if (mediaRef.kind === 'mermaid' && isMindmap(mediaRef.src)) {
      // mindmap → 树编辑器；graph/flowchart → 流程图编辑器（不再静默落源码）
      const t = parseMindmap(mediaRef.src)
      if (t) {
        setTree(t)
        setFlow(null)
      } else {
        setTree(null)
        setFlow(parseFlow(mediaRef.src))
      }
    } else {
      setGrid(null)
      setTree(null)
      setFlow(null)
    }
  }, [mediaRef])

  // 实时校验（mermaid / svg / formula，防抖 600ms；mermaid 失败尝试部分加载）
  React.useEffect(() => {
    const kind = mediaRef?.kind
    if (!kind || (kind !== 'mermaid' && kind !== 'svg' && kind !== 'formula')) {
      setCheck({ status: 'ok' })
      return
    }
    setForceOriginal(false)
    const gen = ++checkGenRef.current
    const timer = setTimeout(() => {
      void (async () => {
        setCheck({ status: 'checking' })
        const verdict = await validateMediaSrc(kind, src)
        if (checkGenRef.current !== gen) return
        if (verdict.ok) {
          setCheck({ status: 'ok' })
          return
        }
        if (kind === 'mermaid') {
          const partial = await partialLoadMermaid(src, verdict)
          if (checkGenRef.current !== gen) return
          if (partial) {
            setCheck({
              status: 'partial',
              clean: partial.clean,
              removedOrig: partial.removedOrig,
              message: verdict.message,
            })
            return
          }
        }
        setCheck({ status: 'error', message: verdict.message, line: verdict.line })
      })()
    }, 600)
    return () => clearTimeout(timer)
  }, [src, mediaRef])

  if (!mediaRef) return null
  const ref = mediaRef

  // 可视化模式可用性（svg 始终可用：编辑器内部容错解析）
  const visualAvailable =
    (ref.kind === 'table' && !!grid) ||
    (ref.kind === 'mermaid' && (!!tree || !!flow)) ||
    ref.kind === 'formula' ||
    ref.kind === 'svg'
  const activeTab: EditTab = tab === 'visual' && !visualAvailable ? 'source' : tab

  // 预览用源码：mermaid 部分加载成功时用净化版
  const previewSrc =
    ref.kind === 'mermaid' && check.status === 'partial' ? check.clean : src

  /** 外部写入新代码（AI 助理应用 / AI 修复接纳）→ 重新解析可视化结构 */
  const reparseVisual = (code: string) => {
    if (ref.kind === 'table') {
      setGrid(parseTable(code))
    } else if (ref.kind === 'mermaid') {
      const t = parseMindmap(code)
      if (t) {
        setTree(t)
        setFlow(null)
      } else {
        setTree(null)
        setFlow(parseFlow(code))
      }
    }
  }

  /** AI 生成代码写入编辑器：写入源码 + 重解析 + 切回可视化（可继续可视化编辑） */
  const applyAiCode = (code: string) => {
    setSrc(code)
    setForceOriginal(false)
    reparseVisual(code)
    const can =
      ref.kind === 'table'
        ? !!parseTable(code)
        : ref.kind === 'mermaid'
          ? !!(parseMindmap(code) || parseFlow(code))
          : ref.kind === 'formula' || ref.kind === 'svg'
    setTab(can ? 'visual' : 'source')
    toast.success('AI 代码已写入，可继续可视化编辑')
  }

  /** AI 修复语法错误（结果先预览，接纳 / 撤销） */
  const startFix = async (errMsg: string) => {
    if (fix?.loading) return
    setFix({ loading: true, code: null })
    try {
      const res = await fetch('/api/media-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: apiKindOf(ref),
          currentCode: src,
          instruction: `修复语法错误，尽量保留原有内容与结构。错误信息：${errMsg}`,
        }),
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(err.error || `请求失败（${res.status}）`)
      }
      const data = (await res.json()) as { code?: string }
      const code = typeof data.code === 'string' ? data.code : ''
      if (!code.trim()) throw new Error('AI 返回为空')
      setFix({ loading: false, code })
    } catch (e) {
      setFix(null)
      toast.error('AI 修复失败：' + (e instanceof Error ? e.message : '未知错误'))
    }
  }

  const acceptFix = () => {
    if (!fix?.code) return
    setSrc(fix.code)
    setFix(null)
    setForceOriginal(false)
    reparseVisual(fix.code)
    toast.success('已应用 AI 修复代码（校验将自动重跑）')
  }

  const apply = async () => {
    if (applying) return
    let newSrc = src
    if (activeTab === 'visual') {
      if (ref.kind === 'table' && grid) newSrc = serializeTable(grid)
      else if (ref.kind === 'mermaid' && tree) newSrc = serializeMindmap(tree)
      else if (ref.kind === 'mermaid' && flow) newSrc = buildFlow(flow.nodes, flow.edges, flow.dir)
    }
    if (!newSrc.trim()) {
      toast.warning('内容不能为空')
      return
    }
    // 校验策略：已点「仍用原文」或部分加载已确认（预览用净化版、应用用原文）时跳过；
    // 可视化编辑器序列化出的新代码始终校验。
    const skipValidate =
      forceOriginal || (newSrc === src && check.status === 'partial')
    if (!skipValidate) {
      setApplying(true)
      try {
        const verdict = await validateMediaSrc(ref.kind, newSrc)
        if (!verdict.ok) {
          setCheck({ status: 'error', message: verdict.message, line: verdict.line })
          toast.error('存在语法错误：可点击「AI 修复」，或「仍用原文」继续应用')
          return
        }
      } finally {
        setApplying(false)
      }
    }
    onApply(ref, newSrc)
  }

  /**
   * 点击 / 聚焦 AI 助理悬浮窗时不关闭本弹窗（非模态组合）。
   * Radix 外部事件是 CustomEvent，真实点击目标在 detail.originalEvent.target。
   */
  const outsideGuard = (e: {
    target?: EventTarget | null
    detail?: { originalEvent?: { target?: EventTarget | null } }
    preventDefault: () => void
  }) => {
    const t = (e.detail?.originalEvent?.target ?? e.target) as HTMLElement | null
    if (t && typeof t.closest === 'function' && t.closest('[data-ai-assist]')) e.preventDefault()
  }

  const bannerVisible =
    !forceOriginal && (check.status === 'error' || check.status === 'partial')
  const bannerMsg =
    check.status === 'partial'
      ? `第 ${check.removedOrig.join('、')} 行有误已忽略（预览用净化版）：${check.message}`
      : check.status === 'error'
        ? `语法校验未通过：${check.message}`
        : ''

  return (
    <>
      <Dialog
        open={!!ref}
        onOpenChange={(o) => {
          if (!o) setAiOpen(false)
          onOpenChange(o)
        }}
        modal={false}
      >
        <DialogContent
          className="max-h-[88dvh] overflow-y-auto rounded-2xl sm:max-w-xl"
          onPointerDownOutside={outsideGuard}
          onFocusOutside={outsideGuard}
          // AI 助理悬浮窗打开时，Esc 只关悬浮窗、不关编辑弹窗
          onEscapeKeyDown={(e) => {
            if (aiOpen) e.preventDefault()
          }}
        >
          <DialogHeader className="flex-row items-start justify-between gap-2 space-y-0 pr-10">
            <div className="min-w-0">
              <DialogTitle>编辑{MEDIA_KIND_LABEL[ref.kind]}</DialogTitle>
              <DialogDescription>
                可视化 ⇄ 源码双模式，应用后替换原引用（可撤销）
              </DialogDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0 rounded-full text-xs"
              onClick={() => setAiOpen(true)}
            >
              <Sparkles className="size-3.5" /> AI 助理
            </Button>
          </DialogHeader>

          {/* 校验 / 部分加载横幅 */}
          {bannerVisible && (
            <div
              role="alert"
              className={cn(
                'rounded-xl border px-3 py-2 text-xs',
                check.status === 'partial'
                  ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'
                  : 'border-destructive/40 bg-destructive/10 text-destructive',
              )}
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <p className="min-w-0 flex-1 break-words">{bannerMsg}</p>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-2 pl-6">
                <Button
                  size="sm"
                  className="h-7 rounded-full bg-zinc-900 px-3 text-[11px] font-medium text-white hover:bg-zinc-800"
                  disabled={fix?.loading}
                  onClick={() => void startFix(bannerMsg)}
                >
                  <Wand2 className="size-3" /> AI修复
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-full px-3 text-[11px]"
                  onClick={() => setForceOriginal(true)}
                >
                  仍用原文
                </Button>
              </div>
            </div>
          )}

          {/* AI 修复预览（接纳 / 撤销） */}
          {fix && (
            <div className="rounded-xl border border-emerald-300 bg-emerald-50/70 p-3 dark:border-emerald-500/40 dark:bg-emerald-500/10">
              {fix.loading ? (
                <p className="flex items-center gap-2 text-xs text-emerald-800 dark:text-emerald-300">
                  <Loader2 className="size-4 animate-spin" /> AI 正在修复语法错误…
                </p>
              ) : (
                fix.code != null && (
                  <>
                    <p className="text-xs font-medium text-emerald-800 dark:text-emerald-300">
                      AI 修复建议（先预览，再决定）
                    </p>
                    <div className="mt-2 max-h-40 overflow-auto rounded-lg bg-background p-2">
                      <React.Suspense
                        fallback={<p className="py-2 text-center text-xs text-muted-foreground">渲染中…</p>}
                      >
                        <RichContentLazy content={renderableOf(ref.kind, fix.code)} />
                      </React.Suspense>
                    </div>
                    <details className="mt-1.5">
                      <summary className="cursor-pointer text-[11px] text-muted-foreground">
                        查看修复后源码
                      </summary>
                      <pre className="mt-1 max-h-32 overflow-auto rounded-lg bg-muted/50 p-2 font-mono text-[11px]">
                        {fix.code}
                      </pre>
                    </details>
                    <div className="mt-2 flex gap-2">
                      <Button
                        size="sm"
                        className="h-8 rounded-full bg-emerald-600 px-4 text-xs font-medium text-white hover:bg-emerald-700"
                        onClick={acceptFix}
                      >
                        <Check className="size-3.5" /> 接纳
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 rounded-full px-4 text-xs"
                        onClick={() => setFix(null)}
                      >
                        <Undo2 className="size-3.5" /> 撤销
                      </Button>
                    </div>
                  </>
                )
              )}
            </div>
          )}

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
              ) : ref.kind === 'mermaid' && flow ? (
                <FlowEditor flow={flow} onChange={setFlow} />
              ) : ref.kind === 'svg' ? (
                <SvgVisualEditor code={src} onChange={setSrc} />
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
                    <p className="pb-1 text-[11px] text-muted-foreground">
                      预览{check.status === 'partial' ? '（净化版，出错行已忽略）' : ''}
                    </p>
                    <React.Suspense fallback={<p className="text-xs text-muted-foreground">渲染中…</p>}>
                      {/* 预览同样带统一富媒体交互（点击/悬浮可放大详情、下载） */}
                      <RichContentLazy content={renderableOf(ref.kind, previewSrc)} />
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
              onClick={() => void apply()}
              disabled={applying || (!src.trim() && !grid && !tree && !flow)}
            >
              {applying ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> 校验中…
                </>
              ) : (
                '应用修改'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AI 助理悬浮窗（非模态，portal 到 body，不打断编辑器） */}
      <AiAssistPopover
        open={aiOpen}
        onOpenChange={setAiOpen}
        kind={ref.kind}
        currentCode={src}
        onApply={applyAiCode}
      />
    </>
  )
}
