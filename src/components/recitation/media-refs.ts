// media-refs — 从编辑器块文本中检测全部富媒体引用（图片 / 表格 / mermaid /
// SVG / 代码块 / 公式），供 MediaRefStrip（块顶预览条）、MediaDetailDialog
// （放大详情）、MediaEditDialog（可视化编辑）共用。
//
// 引用机制：所有富媒体都以「文本内标记」存在（![](url) / |表格| / ```mermaid /
// $$公式$$），块顶预览条解析渲染，点击可定位 / 替换 / 编辑 / 删除 / 复制引用。

export type MediaKind = 'image' | 'table' | 'mermaid' | 'svg' | 'code' | 'formula'

export interface MediaRef {
  kind: MediaKind
  /** 块文本中的精确子串（替换 / 定位 / 删除都用它） */
  raw: string
  /** 图片 url 或富媒体源码 */
  src: string
  alt: string
  /** 代码围栏语言（mermaid/svg/其他） */
  lang: string
  start: number
  end: number
}

export const MEDIA_KIND_LABEL: Record<MediaKind, string> = {
  image: '图片',
  table: '表格',
  mermaid: '思维导图',
  svg: 'SVG 图',
  code: '代码',
  formula: '公式',
}

/** mermaid 代码块是否是 mindmap（可视化树编辑仅支持 mindmap） */
export function isMindmap(src: string): boolean {
  return /^\s*(mindmap|graph|flowchart)\b/i.test(src)
}

interface Span {
  start: number
  end: number
}

function overlaps(a: Span, list: Span[]): boolean {
  return list.some((b) => a.start < b.end && b.start < a.end)
}

/** 提取块文本中的全部富媒体引用（顺序按出现位置） */
export function extractMediaRefs(text: string): MediaRef[] {
  const refs: MediaRef[] = []
  const taken: Span[] = []
  if (!text) return refs

  // 1) 围栏代码块（mermaid / svg / html / 其他代码）— 优先占位
  const fenceRe = /```([A-Za-z0-9_-]*)\r?\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = fenceRe.exec(text)) !== null) {
    const lang = (m[1] || '').toLowerCase()
    const src = m[2]
    const kind: MediaKind = lang === 'mermaid' ? 'mermaid' : lang === 'svg' || lang === 'html' ? 'svg' : 'code'
    refs.push({
      kind,
      raw: m[0],
      src,
      alt: '',
      lang,
      start: m.index,
      end: m.index + m[0].length,
    })
    taken.push({ start: m.index, end: m.index + m[0].length })
  }

  // 2) 图片 ![](url)
  const imgRe = /!\[([^\]]*)\]\(([^)\s]+)\)/g
  while ((m = imgRe.exec(text)) !== null) {
    if (overlaps({ start: m.index, end: m.index + m[0].length }, taken)) continue
    refs.push({
      kind: 'image',
      raw: m[0],
      src: m[2],
      alt: m[1],
      lang: '',
      start: m.index,
      end: m.index + m[0].length,
    })
    taken.push({ start: m.index, end: m.index + m[0].length })
  }

  // 3) 独立公式 $$...$$
  const fmlRe = /\$\$([\s\S]+?)\$\$/g
  while ((m = fmlRe.exec(text)) !== null) {
    if (overlaps({ start: m.index, end: m.index + m[0].length }, taken)) continue
    refs.push({
      kind: 'formula',
      raw: m[0],
      src: m[1],
      alt: '',
      lang: 'latex',
      start: m.index,
      end: m.index + m[0].length,
    })
    taken.push({ start: m.index, end: m.index + m[0].length })
  }

  // 4) markdown 表格（连续 ≥2 行 |…|，且第二行是分隔行 |---|）
  const lineRe = /[^\n]+/g
  const tableLines: { start: number; end: number; text: string }[] = []
  while ((m = lineRe.exec(text)) !== null) {
    const line = m[0]
    if (/^\s*\|.+\|\s*$/.test(line)) {
      tableLines.push({ start: m.index, end: m.index + line.length, text: line })
    }
  }
  for (let i = 0; i + 1 < tableLines.length; i++) {
    const a = tableLines[i]
    const b = tableLines[i + 1]
    // a 与 b 相邻（中间只有换行）
    if (!/^\s*\|[\s:|-]+\|\s*$/.test(b.text)) continue
    const span = { start: a.start, end: b.end }
    if (overlaps(span, taken)) continue
    // 吸收后续连续表格行
    let end = b.end
    let j = i + 2
    while (j < tableLines.length && tableLines[j].start <= end + 3) {
      end = tableLines[j].end
      j++
    }
    refs.push({
      kind: 'table',
      raw: text.slice(a.start, end),
      src: text.slice(a.start, end),
      alt: '',
      lang: 'table',
      start: a.start,
      end,
    })
    taken.push({ start: a.start, end })
  }

  refs.sort((a, b) => a.start - b.start)
  return refs
}

/** 复制引用命令：图片返回 markdown 引用，富媒体返回原文（粘贴即用） */
export function refCommand(ref: MediaRef): string {
  return ref.raw
}

// ---------- markdown 表格 ⇄ 网格 ----------

export interface TableGrid {
  head: string[]
  rows: string[][]
}

/** markdown 表格源码 → 网格（解析失败返回 null） */
export function parseTable(src: string): TableGrid | null {
  const lines = src
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^\|.+\|$/.test(l))
  if (lines.length < 2) return null
  const splitRow = (l: string) =>
    l
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim())
  const head = splitRow(lines[0])
  const rows: string[][] = []
  for (let i = 1; i < lines.length; i++) {
    if (/^\|[\s:|-]+\|$/.test(lines[i])) continue
    const cells = splitRow(lines[i])
    while (cells.length < head.length) cells.push('')
    rows.push(cells.slice(0, head.length))
  }
  return { head, rows }
}

/** 网格 → markdown 表格源码 */
export function serializeTable(g: TableGrid): string {
  const n = Math.max(g.head.length, 1)
  const head = g.head.slice(0, n)
  while (head.length < n) head.push('')
  const esc = (c: string) => c.replace(/\|/g, '\\|')
  const lines = [
    `| ${head.map(esc).join(' | ')} |`,
    `| ${Array.from({ length: n }, () => '---').join(' | ')} |`,
    ...g.rows.map((r) => {
      const cells = r.slice(0, n)
      while (cells.length < n) cells.push('')
      return `| ${cells.map(esc).join(' | ')} |`
    }),
  ]
  return lines.join('\n')
}

// ---------- mermaid mindmap ⇄ 树 ----------

export interface MindNode {
  text: string
  children: MindNode[]
}

/** mermaid mindmap 源码 → 树（非 mindmap 或解析失败返回 null） */
export function parseMindmap(src: string): MindNode | null {
  const lines = src.split(/\r?\n/).map((l) => l.replace(/\s+$/, ''))
  // 去掉 mindmap 声明行
  let idx = lines.findIndex((l) => /^\s*mindmap\b/i.test(l))
  if (idx === -1) return null
  const rootText =
    lines[idx].replace(/^\s*mindmap\b/i, '').trim() || '主题'
  const body = lines.slice(idx + 1)
  const root: MindNode = { text: rootText, children: [] }
  const stack: { indent: number; node: MindNode }[] = [{ indent: -1, node: root }]
  for (const line of body) {
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    const text = line.trim()
    if (text.startsWith('%%') || text.startsWith('classDef') || text.startsWith('class ')) continue
    const node: MindNode = { text: text.replace(/^[^\w\u4e00-\u9fff(]+/, '').trim() || '节点', children: [] }
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop()
    stack[stack.length - 1].node.children.push(node)
    stack.push({ indent, node })
  }
  return root
}

/** 树 → mermaid mindmap 源码 */
export function serializeMindmap(root: MindNode): string {
  const lines = ['mindmap']
  const esc = (t: string) => {
    let s = t.trim() || '节点'
    // 根节点双圆括号
    return s
  }
  const walk = (n: MindNode, depth: number) => {
    if (depth >= 0) lines.push(`${'  '.repeat(depth + 1)}${esc(n.text)}`)
    n.children.forEach((c) => walk(c, depth + 1))
  }
  // mindmap 根：第一行 mindmap 后，根节点本身作为缩进0
  lines.push(`  ((${root.text}))`)
  root.children.forEach((c) => walk(c, 1))
  return lines.join('\n')
}

// ---------- 下载工具 ----------

/** 触发浏览器下载（文本类源码 / 图片 url） */
export function downloadMedia(ref: MediaRef): void {
  if (ref.kind === 'image') {
    const a = document.createElement('a')
    a.href = ref.src
    a.download = `图片-${Date.now()}.jpg`
    a.target = '_blank'
    a.rel = 'noopener'
    a.click()
    return
  }
  const ext =
    ref.kind === 'table' ? 'md' : ref.kind === 'formula' ? 'tex' : ref.lang === 'svg' ? 'svg' : ref.kind === 'mermaid' ? 'mmd' : 'txt'
  const mime = ref.lang === 'svg' || ref.kind === 'svg' ? 'image/svg+xml' : 'text/plain;charset=utf-8'
  const blob = new Blob([ref.src], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${MEDIA_KIND_LABEL[ref.kind]}-${Date.now()}.${ext}`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ---------- 下载（无完整 MediaRef 场景：RichContent 详情态等） ----------

/** 触发下载（按类型 + 源码直出；RichContent 内嵌媒体块没有完整 MediaRef，用此入口）。 */
export function downloadMediaSrc(kind: MediaKind, src: string, lang = ''): void {
  downloadMedia({ kind, raw: '', src, alt: '', lang, start: 0, end: 0 })
}

// ---------- mermaid flowchart（graph / flowchart）⇄ 节点/连线 ----------

export type FlowDir = 'TD' | 'TB' | 'LR' | 'RL' | 'BT'
export type FlowShape = 'rect' | 'round' | 'diamond' | 'circle'
/** 连线样式（重建时保留；缺省 '-->'） */
export type FlowLinkStyle = '-->' | '---' | '-.->' | '==>'

export interface FlowNode {
  id: string
  label: string
  /** 节点形状（重建时保留；缺省 rect 方块） */
  shape?: FlowShape
}

export interface FlowEdge {
  from: string
  to: string
  /** 连线文字（可省略） */
  label?: string
  /** 连线样式（可省略，默认 '-->'） */
  style?: FlowLinkStyle
}

export interface FlowGraph {
  nodes: FlowNode[]
  edges: FlowEdge[]
  dir: FlowDir
}

/** 拆节点 token（如 `A[开始]` / `B{判断}` / `C`）→ id + 标签 + 形状；不认识返回 null。 */
function parseFlowNodeToken(tok: string): { id: string; label: string; shape: FlowShape } | null {
  let i = 0
  while (i < tok.length && /[\w\u4e00-\u9fff]/.test(tok[i])) i++
  const id = tok.slice(0, i)
  if (!id) return null
  const rest = tok.slice(i)
  const inner = (s: string) => s.replace(/\s+/g, ' ').trim() || id
  if (rest.startsWith('((')) {
    const m = rest.match(/^\(\(([\s\S]*)\)\)$/)
    if (m) return { id, label: inner(m[1]), shape: 'circle' }
  }
  if (rest.startsWith('[')) {
    const m = rest.match(/^\[([\s\S]*)\]$/)
    if (m) return { id, label: inner(m[1]), shape: 'rect' }
  }
  if (rest.startsWith('(')) {
    const m = rest.match(/^\(([\s\S]*)\)$/)
    if (m) return { id, label: inner(m[1]), shape: 'round' }
  }
  if (rest.startsWith('{')) {
    const m = rest.match(/^\{([\s\S]*)\}$/)
    if (m) return { id, label: inner(m[1]), shape: 'diamond' }
  }
  if (rest === '') return { id, label: id, shape: 'rect' }
  return null
}

interface FlowToken {
  node?: string
  edge?: { label?: string; style: FlowLinkStyle }
}

/** 箭头收尾形式（长在前短在后，保证贪心匹配） */
const FLOW_CLOSER_RE =
  /^(?:-{2,}>|-\.+->|-\.->|={2,}>|-->|==>|\.->|-{3,}|-{2,}|-\.-|-\.|={2,}|\.-)/

/** 把箭头片段归类为 4 种受支持样式；无法归类返回 null。 */
function flowLinkStyle(arrowText: string): FlowLinkStyle | null {
  if (!arrowText || !/^[-=.]/
    .test(arrowText)) return null
  if (/^=/.test(arrowText)) return '==>'
  if (/\./.test(arrowText)) return '-.->'
  if (/>$/.test(arrowText.trim())) return '-->'
  return '---'
}

/**
 * 扫描一行 flowchart 语句，切成 节点 / 连线 交替的 token 序列。
 * 支持：A-->B、A--文字-->B、A---B、A-->|文字|B、A-.->B、A==>B、链式 A-->B-->C。
 * 不认识的语法返回 null（上层退回源码模式，绝不丢内容）。
 */
function scanFlowLine(line: string): FlowToken[] | null {
  const toks: FlowToken[] = []
  let i = 0
  const n = line.length
  let expectNode = true
  while (i < n) {
    const ch = line[i]
    if (ch === ' ' || ch === '\t') {
      i++
      continue
    }
    if (expectNode) {
      let j = i
      while (j < n && /[\w\u4e00-\u9fff]/.test(line[j])) j++
      if (j === i) return null
      const open = line[j]
      if (open === '[' || open === '(' || open === '{') {
        const close = open === '[' ? ']' : open === '(' ? ')' : '}'
        let depth = 0
        let end = -1
        for (let k = j; k < n; k++) {
          if (line[k] === open) depth++
          else if (line[k] === close) {
            depth--
            if (depth === 0) {
              end = k
              break
            }
          }
        }
        if (end === -1) return null
        j = end + 1
      }
      toks.push({ node: line.slice(i, j) })
      i = j
      expectNode = false
      continue
    }
    // ---- 连线段：[-=.] 开头的箭头序列 ----
    let j = i
    while (j < n && (line[j] === '-' || line[j] === '=' || line[j] === '.')) j++
    let seg = line.slice(i, j)
    if (!seg) return null
    if (j < n && line[j] === '>') {
      seg += '>'
      j++
    }
    let label: string | undefined
    // 形如 `-- 文字 -->` / `== 文字 ==>` / `-. 文字 .->`：开头是无 > 的箭头、后面跟文字再接收尾箭头
    const opener = seg.replace(/>$/, '')
    if (!seg.endsWith('>') && /^(-{2,}|={2,}|-\.+)$/.test(opener)) {
      const rest = line.slice(j)
      const m = rest.match(/^([^-=|>.]*?)\s*(-{2,}>|-\.+->|-\.->|={2,}>|-->|==>|\.->|-{3,}|-{2,}|-\.-|-\.|={2,}|\.-)/)
      if (m && m[2]) {
        label = m[1].trim() || undefined
        j += m[0].length
        seg = line.slice(i, j)
      }
    }
    // `-->|文字|` / `---|文字|` 形式
    if (j < n && line[j] === '|') {
      const close = line.indexOf('|', j + 1)
      if (close === -1) return null
      label = line.slice(j + 1, close).trim() || undefined
      j = close + 1
    }
    const style = flowLinkStyle(seg)
    if (!style) return null
    toks.push({ edge: { label, style } })
    i = j
    expectNode = true
  }
  if (expectNode) return null // 行尾必须落在节点上
  return toks
}

/**
 * mermaid graph/flowchart 源码 → 节点 + 连线（解析失败返回 null → 编辑器退回源码模式）。
 * 遇到 subgraph / classDef / style 等无法结构化表达的指令时保守返回 null。
 */
export function parseFlow(raw: string): FlowGraph | null {
  if (!raw) return null
  const lines = raw.split(/\r?\n/)
  let declIdx = -1
  let dir: FlowDir = 'TD'
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t || t.startsWith('%%')) continue
    const m = t.match(/^(?:graph|flowchart)[ \t]+(TD|TB|LR|RL|BT)\s*$/i)
    if (m) {
      declIdx = i
      dir = m[1].toUpperCase() as FlowDir
      break
    }
    return null // 首个有效行不是 graph/flowchart 声明 → 不是流程图
  }
  if (declIdx === -1) return null

  const nodes = new Map<string, FlowNode>()
  const edges: FlowEdge[] = []
  const register = (tok: string): FlowNode | null => {
    const p = parseFlowNodeToken(tok)
    if (!p) return null
    const existing = nodes.get(p.id)
    if (existing) {
      // 首次出现的形状标签优先；后续裸 id 复用首见信息
      if (p.label !== p.id && existing.label === existing.id) {
        const merged = { ...existing, label: p.label, shape: p.shape }
        nodes.set(p.id, merged)
        return merged
      }
      return existing
    }
    const node: FlowNode = { id: p.id, label: p.label, shape: p.shape }
    nodes.set(p.id, node)
    return node
  }

  for (let i = declIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t || t.startsWith('%%')) continue
    if (/^(subgraph|end|classDef|class|style|linkStyle|click|direction)\b/i.test(t)) return null
    const toks = scanFlowLine(t)
    if (!toks) return null
    const nodeToks: string[] = []
    const edgeToks: NonNullable<FlowToken['edge']>[] = []
    for (const tok of toks) {
      if (tok.node) nodeToks.push(tok.node)
      else if (tok.edge) edgeToks.push(tok.edge)
    }
    if (nodeToks.length === 0) return null
    if (edgeToks.length !== nodeToks.length - 1) return null
    if (edgeToks.length === 0) {
      if (!register(nodeToks[0])) return null
      continue
    }
    for (let k = 0; k < edgeToks.length; k++) {
      const a = register(nodeToks[k])
      const b = register(nodeToks[k + 1])
      if (!a || !b) return null
      edges.push({ from: a.id, to: b.id, label: edgeToks[k].label, style: edgeToks[k].style })
    }
  }
  if (nodes.size === 0) return null
  return { nodes: Array.from(nodes.values()), edges, dir }
}

/** 节点/连线 → 合法 mermaid graph 源码（标签中的括号/竖线转全角，保证语法合法）。 */
export function buildFlow(nodes: FlowNode[], edges: FlowEdge[], dir: FlowDir = 'TD'): string {
  const FULLWIDTH: Record<string, string> = {
    '|': '｜',
    '[': '［',
    ']': '］',
    '{': '｛',
    '}': '｝',
    '(': '（',
    ')': '）',
  }
  const esc = (s: string) =>
    (s || '')
      .replace(/[|[\]{}()]/g, (c) => FULLWIDTH[c] ?? c)
      .replace(/\s+/g, ' ')
      .trim()
  const wrap = (n: FlowNode) => {
    const label = esc(n.label) || n.id
    switch (n.shape) {
      case 'round':
        return `${n.id}(${label})`
      case 'diamond':
        return `${n.id}{${label}}`
      case 'circle':
        return `${n.id}((${label}))`
      default:
        return `${n.id}[${label}]`
    }
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const arrow = (e: FlowEdge) => {
    const style = e.style ?? '-->'
    const label = e.label ? esc(e.label) : ''
    return label ? `${style}|${label}|` : style
  }
  const lines = [`graph ${dir}`]
  const used = new Set<string>()
  for (const e of edges) {
    const a = nodeById.get(e.from)
    const b = nodeById.get(e.to)
    if (!a || !b) continue
    used.add(a.id)
    used.add(b.id)
    lines.push(`  ${wrap(a)} ${arrow(e)} ${wrap(b)}`)
  }
  for (const n of nodes) {
    if (!used.has(n.id)) lines.push(`  ${wrap(n)}`)
  }
  return lines.join('\n')
}
