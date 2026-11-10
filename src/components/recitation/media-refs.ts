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
