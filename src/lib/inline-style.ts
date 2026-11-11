// Shared inline-span style parser for the `%%…|text%%` directive syntax.
//
// Syntax accepted inside the directive (before the first `|`):
//   • bare color          %%#dc2626|文%%        → { color: '#dc2626' }
//   • named color         %%red|文%%            → { color: 'red' }  (default → {})
//   • font size (px)      %%fs:18|文%%          → { fontSize: 18 }
//   • bare size           %%18|文%%             → { fontSize: 18 }
//   • combined list       %%color:#dc2626;fs:18|文%%
//   • legacy combos       %%#dc2626,18|文%%     → color + size (comma separated)
//
// Pure functions, no framework dependencies — used by the editor preview,
// rich-content (markdown renderer), cloze-text (reading view) and the
// shared card view so every surface renders identical styles.
//
// v2 嵌套支持：新增跨标记递归分词器（tokenizer）。任意两层/三层组合
// （`**%%u|x%%**`、`%%u|**x**%%`、`==%%u|x%%==`、`**%%u|==x==%%**` …）
// 在编辑器预览、阅读页（cloze-text）与 rich-content（react-markdown）三条
// 链路上一致渲染：嵌套标记层层展开、样式叠加，不再互相吞掉。
// expandSpanDirectives 的输出对 react-markdown 友好（`%%`/`==` 展开为带
// 内联样式的 HTML，`**`/`*`/`~~` 仍留给 markdown 引擎），且保持幂等
// （对已展开结果再次调用不再变化）。

export interface InlineSpanStyle {
  color?: string
  fontSize?: number
  underline?: boolean
}

const COLOR_VALUE_RE =
  /^(#(?:[0-9a-f]{3,8})|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]{3,20})$/i

const NAMED_ALIASES: Record<string, string> = {
  red: '#dc2626',
  orange: '#ea580c',
  green: '#16a34a',
  teal: '#0d9488',
  purple: '#7c3aed',
  pink: '#db2777',
  gray: '#64748b',
  blue: '#2563eb',
  yellow: '#ca8a04',
}

function clampPx(n: number): number | undefined {
  if (!Number.isFinite(n)) return undefined
  return Math.min(48, Math.max(10, Math.round(n)))
}

/** Parse one `key:value` pair (already lowercased). */
function parsePair(raw: string): InlineSpanStyle {
  const out: InlineSpanStyle = {}
  const [key, ...rest] = raw.split(':')
  const value = rest.join(':').trim()
  const k = (key ?? '').trim().toLowerCase()
  if (!k || !value) return out
  if (k === 'color' || k === 'c' || k === '颜色') {
    const v = NAMED_ALIASES[value.toLowerCase()] ?? value
    if (COLOR_VALUE_RE.test(v)) out.color = v
  } else if (k === 'fs' || k === 'size' || k === '字号') {
    const n = parseFloat(value)
    const px = clampPx(n)
    if (px) out.fontSize = px
  } else if (k === 'u' || k === 'underline' || k === '下划线') {
    out.underline = true
  }
  return out
}

/**
 * Parse the directive part of `%%…|text%%`. Never throws; unknown
 * directives return `{}` (renders as default text).
 */
export function parseSpanDirective(directive: string): InlineSpanStyle {
  const dir = String(directive ?? '').trim()
  if (!dir || dir.toLowerCase() === 'default') return {}

  // Combined list: `k:v;k:v` or legacy `#hex,18`
  if (dir.includes(';') || dir.includes(',')) {
    let merged: InlineSpanStyle = {}
    for (const part of dir.split(/[;,]/)) {
      const s = parseSpanDirective(part)
      merged = { ...merged, ...s }
    }
    return merged
  }

  // key:value single pair
  if (dir.includes(':')) return parsePair(dir)

  // bare number → font size
  if (/^\d+(\.\d+)?$/.test(dir)) {
    const px = clampPx(parseFloat(dir))
    return px ? { fontSize: px } : {}
  }

  // bare color token (#hex / rgb() / named)
  const v = NAMED_ALIASES[dir.toLowerCase()] ?? dir
  if (COLOR_VALUE_RE.test(v)) return { color: v }
  // bare underline directive
  if (dir.toLowerCase() === 'u' || dir.toLowerCase() === 'underline') {
    return { underline: true }
  }
  return {}
}

/** CSS inline style string for a parsed directive, e.g. `color:#dc2626;font-size:18px`. */
export function spanStyleCss(style: InlineSpanStyle): string {
  const parts: string[] = []
  if (style.color) parts.push(`color:${style.color}`)
  if (style.fontSize) parts.push(`font-size:${style.fontSize}px`)
  if (style.underline) parts.push('text-decoration:underline')
  return parts.join(';')
}

// ---------------------------------------------------------------------------
// 跨标记嵌套分词器（tokenizer）
//
// 一次线性扫描 + 递归下降：`%%…|…%%`、`==…==`、`**…**`、`*…*`、`~~…~~`
// 作为容器（开/闭配对，内容递归解析）；`` `…` ``、`$…$`、`$$…$$`、`![a](u)`、
// `{{…}}` 作为原子（内容不再嵌套）。容器内容允许跨标记嵌套，同名标记不嵌套
// （与旧扁平解析器的内容约束保持一致，单层行为的渲染结果不变）。
//
// mode：
//   • 'top'  — 只识别 原子 + `%%` 指令 + `==` 高亮。`**`/`*`/`~~` 保持为
//              markdown 文本（留给 react-markdown 解析），用于 HTML 展开链路。
//   • 'full' — 全部标记都识别（runs 扁平化，及容器内容的递归解析）。
// ---------------------------------------------------------------------------

export type InlineNodeKind =
  | 'text'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'highlight'
  | 'span'
  | 'code'
  | 'math'
  | 'image'
  | 'cloze'

export interface InlineNode {
  kind: InlineNodeKind
  /** 叶子文本（text / code / cloze） */
  text?: string
  /** span（%%…|…%%）解析出的样式 */
  style?: InlineSpanStyle
  /** math 的 TeX 源码 */
  tex?: string
  /** math 是否为展示型 $$…$$ */
  display?: boolean
  /** image 的 alt / src */
  alt?: string
  src?: string
  /** 容器（bold/italic/strike/highlight/span）子节点 */
  children?: InlineNode[]
}

interface ParseOpts {
  mode: 'top' | 'full'
  /** 允许多行 $$…$$ 展示公式作为原子（保护其中的 ==/%% 不被展开） */
  mlDollar: boolean
}

const CODE_RE = /^`([^`\n]+)`/
const MATH_DISPLAY_RE = /^\$\$([^$\n]+?)\$\$/
const MATH_DISPLAY_ML_RE = /^\$\$([\s\S]+?)\$\$/
const MATH_INLINE_RE = /^\$([^$\n]+)\$/
const IMAGE_RE = /^!\[([^\]]*)\]\(([^)]+)\)/
const CLOZE_RE = /^\{\{([^{}]*)\}\}/
const DIRECTIVE_OPEN_RE = /^%%([^|\n%]+)\|/

/**
 * 找到 `%%dir|` 之后的配对闭合 `%%`。内容里的嵌套 `%%dir2|` 会先被
 * 递归消费；遇到换行（所有标记都是单行语法）或找不到闭合时返回 -1。
 */
function findDirectiveClose(s: string, from: number): number {
  let k = from
  while (k < s.length) {
    if (s[k] === '\n') return -1
    if (s[k] === '%' && s[k + 1] === '%') {
      const open = DIRECTIVE_OPEN_RE.exec(s.slice(k))
      if (open) {
        const nestedEnd = findDirectiveClose(s, k + open[0].length)
        if (nestedEnd < 0) return -1
        k = nestedEnd + 2
        continue
      }
      return k
    }
    k += 1
  }
  return -1
}

/** 在 [from, s.length) 内找第一个 `delim`，且 [from, hit) 不含 `\n`；否则 -1。 */
function findCloseOnSameLine(s: string, delim: string, from: number): number {
  let k = from
  while (k < s.length) {
    if (s[k] === '\n') return -1
    if (s.startsWith(delim, k)) return k
    k += 1
  }
  return -1
}

function parseLevel(s: string, opts: ParseOpts): InlineNode[] {
  const out: InlineNode[] = []
  const full = opts.mode === 'full'
  let i = 0
  let textStart = 0
  const pushToken = (node: InlineNode, next: number) => {
    if (i > textStart) out.push({ kind: 'text', text: s.slice(textStart, i) })
    out.push(node)
    i = next
    textStart = next
  }

  while (i < s.length) {
    const ch = s[i]

    // ---- 原子：行内代码 ----
    if (ch === '`') {
      const m = CODE_RE.exec(s.slice(i))
      if (m) {
        pushToken({ kind: 'code', text: m[1] }, i + m[0].length)
        continue
      }
      i += 1
      continue
    }

    // ---- 原子：公式（$$ 展示型优先于 $ 行内型）----
    if (ch === '$') {
      const rest = s.slice(i)
      const disp = MATH_DISPLAY_RE.exec(rest)
      if (disp) {
        pushToken({ kind: 'math', tex: disp[1], display: true }, i + disp[0].length)
        continue
      }
      if (opts.mlDollar) {
        const dispMl = MATH_DISPLAY_ML_RE.exec(rest)
        if (dispMl) {
          pushToken({ kind: 'math', tex: dispMl[1], display: true }, i + dispMl[0].length)
          continue
        }
      }
      const inl = MATH_INLINE_RE.exec(rest)
      if (inl) {
        pushToken({ kind: 'math', tex: inl[1] }, i + inl[0].length)
        continue
      }
      i += 1
      continue
    }

    // ---- 原子：行内图片 ----
    if (ch === '!' && s[i + 1] === '[') {
      const m = IMAGE_RE.exec(s.slice(i))
      if (m) {
        pushToken({ kind: 'image', alt: m[1], src: m[2] }, i + m[0].length)
        continue
      }
      i += 1
      continue
    }

    // ---- 原子：{{挖空}}（背诵标记；各链路按需剥掉花括号）----
    if (ch === '{' && s[i + 1] === '{') {
      const m = CLOZE_RE.exec(s.slice(i))
      if (m) {
        pushToken({ kind: 'cloze', text: m[1] }, i + m[0].length)
        continue
      }
      i += 1
      continue
    }

    // ---- 容器：%%样式|文字%%（top/full 都识别）----
    if (ch === '%' && s[i + 1] === '%') {
      const open = DIRECTIVE_OPEN_RE.exec(s.slice(i))
      if (open) {
        const contentStart = i + open[0].length
        const close = findDirectiveClose(s, contentStart)
        if (close >= 0) {
          const content = s.slice(contentStart, close)
          pushToken(
            {
              kind: 'span',
              style: parseSpanDirective(open[1]),
              children: parseLevel(content, { mode: 'full', mlDollar: opts.mlDollar }),
            },
            close + 2,
          )
          continue
        }
      }
      // 不是合法指令（或未闭合）——按普通文本处理，前进 1 后重试
      i += 1
      continue
    }

    // ---- 容器：==高亮==（top/full 都识别）----
    if (ch === '=' && s[i + 1] === '=') {
      const close = findCloseOnSameLine(s, '==', i + 2)
      if (close >= 0) {
        const content = s.slice(i + 2, close)
        if (content && !content.includes('=') && !content.includes('\n')) {
          pushToken(
            { kind: 'highlight', children: parseLevel(content, { mode: 'full', mlDollar: opts.mlDollar }) },
            close + 2,
          )
          continue
        }
      }
      i += 1
      continue
    }

    if (full) {
      // ---- 容器：~~删除线~~ ----
      if (ch === '~' && s[i + 1] === '~') {
        const close = findCloseOnSameLine(s, '~~', i + 2)
        if (close >= 0) {
          const content = s.slice(i + 2, close)
          if (content && !content.includes('~') && !content.includes('\n')) {
            pushToken(
              { kind: 'strike', children: parseLevel(content, { mode: 'full', mlDollar: opts.mlDollar }) },
              close + 2,
            )
            continue
          }
        }
        i += 1
        continue
      }

      if (ch === '*') {
        // ***x*** → 加粗套斜体（CommonMark 语义）
        if (s.startsWith('***', i)) {
          const close = findCloseOnSameLine(s, '***', i + 3)
          if (close >= 0) {
            const content = s.slice(i + 3, close)
            if (content && !content.includes('\n')) {
              pushToken(
                {
                  kind: 'bold',
                  children: [
                    {
                      kind: 'italic',
                      children: parseLevel(content, { mode: 'full', mlDollar: opts.mlDollar }),
                    },
                  ],
                },
                close + 3,
              )
              continue
            }
          }
          i += 1
          continue
        }
        // **x**
        if (s[i + 1] === '*') {
          const close = findCloseOnSameLine(s, '**', i + 2)
          if (close >= 0) {
            const content = s.slice(i + 2, close)
            if (content && !content.includes('\n')) {
              pushToken(
                { kind: 'bold', children: parseLevel(content, { mode: 'full', mlDollar: opts.mlDollar }) },
                close + 2,
              )
              continue
            }
          }
          i += 1
          continue
        }
        // *x*
        const close = findCloseOnSameLine(s, '*', i + 1)
        if (close >= 0) {
          const content = s.slice(i + 1, close)
          if (content && !content.includes('\n')) {
            pushToken(
              { kind: 'italic', children: parseLevel(content, { mode: 'full', mlDollar: opts.mlDollar }) },
              close + 1,
            )
            continue
          }
        }
        i += 1
        continue
      }
    }

    i += 1
  }

  if (s.length > textStart) out.push({ kind: 'text', text: s.slice(textStart) })
  return out
}

// ---------------------------------------------------------------------------
// 序列化一：HTML（react-markdown + rehype-raw 链路）
//
// `%%`/`==` 展开为带样式的 HTML；容器内部的 `**`/`*`/`~~` 转成
// <strong>/<em>/<del>（嵌套内容不再依赖 markdown 引擎在 HTML 邻位解析）。
// 顶层（depth 0）的普通文本不转义、`**` 等保持 markdown —— 与旧行为一致。
// ---------------------------------------------------------------------------

function escapeHtmlText(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  )
}

function serializeHtml(nodes: InlineNode[], depth: number): string {
  let out = ''
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += depth === 0 ? (n.text ?? '') : escapeHtmlText(n.text ?? '')
        break
      case 'bold':
        out += `<strong>${serializeHtml(n.children ?? [], depth + 1)}</strong>`
        break
      case 'italic':
        out += `<em>${serializeHtml(n.children ?? [], depth + 1)}</em>`
        break
      case 'strike':
        out += `<del>${serializeHtml(n.children ?? [], depth + 1)}</del>`
        break
      case 'highlight':
        out += `<mark>${serializeHtml(n.children ?? [], depth + 1)}</mark>`
        break
      case 'span': {
        const css = n.style ? spanStyleCss(n.style) : ''
        const inner = serializeHtml(n.children ?? [], depth + 1)
        out += css ? `<span style="${css}">${inner}</span>` : inner
        break
      }
      case 'code':
        out += '`' + (depth === 0 ? (n.text ?? '') : escapeHtmlText(n.text ?? '')) + '`'
        break
      case 'math': {
        const body = depth === 0 ? (n.tex ?? '') : escapeHtmlText(n.tex ?? '')
        out += n.display ? `$$${body}$$` : `$${body}$`
        break
      }
      case 'image':
        out += `![${escapeHtmlText(n.alt ?? '')}](${n.src ?? ''})`
        break
      case 'cloze':
        out += `{{${n.text ?? ''}}}`
        break
    }
  }
  return out
}

/**
 * Expand every `%%dir|text%%` span into a raw `<span style>`（嵌套内容里的
 * `**`/`==`/`~~`/`%%` 一并层层展开），并把 `==高亮==` 展开为 `<mark>`
 * （react-markdown 无 `==` 语法，富文本高亮在此层统一补齐）。
 * 围栏代码块与（多行）`$$…$$` 展示公式内的内容保持原样。
 * 幂等：对已展开的结果再次调用不再变化。
 */
export function expandSpanDirectives(md: string): string {
  const src = String(md ?? '')
  if (!src) return src
  const parts = src.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/g)
  return parts
    .map((p, idx) => {
      if (idx % 2 === 1) return p // 围栏代码块：原样
      if (!p) return p
      return serializeHtml(parseLevel(p, { mode: 'top', mlDollar: true }), 0)
    })
    .join('')
}

// ---------------------------------------------------------------------------
// 序列化二：扁平 runs（cloze-text 阅读页）
//
// 深度优先展开为按文档序排列的叶子 run 列表；`plain` 为去掉全部标记后的
// 纯文本（挖空关键词与位置都基于 plain 计算），`start` 是 run.text 在
// plain 中的偏移。图片不进入 plain；公式按 TeX 源码进入 plain。
// ---------------------------------------------------------------------------

export interface InlineStyleRun {
  text: string
  /** run.text 在 plain 中的偏移 */
  start: number
  bold?: boolean
  italic?: boolean
  strike?: boolean
  highlight?: boolean
  /** %%u|…%%（或嵌套继承）的下划线 */
  underline?: boolean
  color?: string
  fontSize?: number
  code?: boolean
  /** TeX 源码（行内/展示公式） */
  math?: string
  mathDisplay?: boolean
  image?: { alt: string; src: string }
}

interface RunCtx {
  bold?: boolean
  italic?: boolean
  strike?: boolean
  highlight?: boolean
  underline?: boolean
  color?: string
  fontSize?: number
}

export function tokenizeInlineRuns(text: string): { runs: InlineStyleRun[]; plain: string } {
  const nodes = parseLevel(String(text ?? ''), { mode: 'full', mlDollar: false })
  const runs: InlineStyleRun[] = []
  let plain = ''

  const leaf = (run: Omit<InlineStyleRun, 'start'>) => {
    runs.push({ ...run, start: plain.length })
    plain += run.text
  }

  const walk = (list: InlineNode[], ctx: RunCtx) => {
    for (const n of list) {
      switch (n.kind) {
        case 'text':
          leaf({ text: n.text ?? '', ...ctx })
          break
        case 'cloze':
          // 与旧扁平解析器一致：{{…}} 整体作为可见文本进入 plain
          leaf({ text: `{{${n.text ?? ''}}}`, ...ctx })
          break
        case 'code':
          runs.push({ text: n.text ?? '', start: plain.length, code: true, ...ctx })
          plain += n.text ?? ''
          break
        case 'math':
          runs.push({
            text: n.tex ?? '',
            start: plain.length,
            math: n.tex ?? '',
            mathDisplay: n.display || undefined,
            ...ctx,
          })
          plain += n.tex ?? ''
          break
        case 'image':
          // 零长度 run：不进入 plain、不可挖空（alt/src 永不显示为文本）
          runs.push({ text: '', start: plain.length, image: { alt: n.alt ?? '', src: n.src ?? '' }, ...ctx })
          break
        case 'bold':
          walk(n.children ?? [], { ...ctx, bold: true })
          break
        case 'italic':
          walk(n.children ?? [], { ...ctx, italic: true })
          break
        case 'strike':
          walk(n.children ?? [], { ...ctx, strike: true })
          break
        case 'highlight':
          walk(n.children ?? [], { ...ctx, highlight: true })
          break
        case 'span': {
          const st = n.style ?? {}
          walk(n.children ?? [], {
            ...ctx,
            color: st.color ?? ctx.color,
            fontSize: st.fontSize ?? ctx.fontSize,
            underline: st.underline || ctx.underline,
          })
          break
        }
      }
    }
  }

  walk(nodes, {})
  return { runs, plain }
}

// ---------------------------------------------------------------------------
// 序列化三：纯文本清洗（AI 出题用）
//
// 剥离背诵标记（`%%样式|文字%%`、`==高亮==`、`{{挖空}}` → 仅保留内部文字），
// 其余富媒体 markdown（加粗/斜体/删除线/代码/公式/图片）原样重建。
// 嵌套安全：`**%%u|==x==%%**` → `**x**`。
// ---------------------------------------------------------------------------

function serializeQuizText(nodes: InlineNode[]): string {
  let out = ''
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text ?? ''
        break
      case 'bold':
        out += `**${serializeQuizText(n.children ?? [])}**`
        break
      case 'italic':
        out += `*${serializeQuizText(n.children ?? [])}*`
        break
      case 'strike':
        out += `~~${serializeQuizText(n.children ?? [])}~~`
        break
      case 'highlight':
      case 'span':
        out += serializeQuizText(n.children ?? [])
        break
      case 'code':
        out += '`' + (n.text ?? '') + '`'
        break
      case 'math':
        out += n.display ? `$$${n.tex ?? ''}$$` : `$${n.tex ?? ''}$`
        break
      case 'image':
        out += `![${n.alt ?? ''}](${n.src ?? ''})`
        break
      case 'cloze':
        out += n.text ?? ''
        break
    }
  }
  return out
}

/**
 * 剥离背诵标记（`%%…|…%%`、`==…==`、`{{…}}`），保留内部文字；
 * 加粗/斜体/删除线/代码/公式/图片等其余 markdown 原样保留（重建定界符）。
 */
export function stripRecitationMarks(text: string): string {
  const src = String(text ?? '')
  if (!src) return src
  return serializeQuizText(parseLevel(src, { mode: 'top', mlDollar: true }))
}
