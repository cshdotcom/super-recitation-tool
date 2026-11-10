'use client'

// RichContent — reusable renderer for markdown-ish card/chat content.
// Features:
//   • GFM markdown (react-markdown + remark-gfm) with nice spacing — tables,
//     task lists, strikethrough, images
//   • syntax-highlighted fenced code blocks (rehype-highlight + github theme,
//     dark-mode token colors overridden in globals.css)
//   • LaTeX math: $inline$ and $$display$$ (remark-math + rehype-katex).
//     Currency-style $ signs are protected: a $…$ pair only becomes math when
//     the span looks like LaTeX (has letters/backslash/^_{}), so "价格$5" and
//     "$5，总共$10" stay literal text. Unmatched single $ is always literal.
//   • copy button on top-right of every code block
//   • ```mermaid blocks rendered as SVG (mermaid lazy-loaded, re-rendered on
//     theme change, error fallback falls back to a plain code block)
//   • ```svg fenced blocks render natively (sanitized), like raw <svg> segments
//   • raw <svg>…</svg> segments in the content render natively (sanitized)
//   • bordered tables with horizontal scroll on mobile
//   • optional maxHeight → the whole container scrolls vertically
//   • unified rich-media interactions (mediaInteractive, default true):
//     every media block (image / mermaid / svg / table / code / display
//     formula) gets a floating action bar (detail + download); detail opens a
//     self-contained fullscreen overlay (zoom 0.25–4x, drag-pan, download,
//     copy-source). Detail re-renders media with mediaInteractive={false} to
//     prevent recursion. All render sites (chat / quiz / papers / favorites /
//     reading view / editor previews) inherit these interactions for free.
// Never crashes on plain text — plain paragraphs just render as paragraphs.
import * as React from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
// 化学公式扩展（\ce{H2O} 等）——必须在 rehype-katex 处理前导入以补丁同一 katex 实例
import 'katex/contrib/mhchem'
import 'katex/dist/katex.min.css'
import { useTheme } from 'next-themes'
import { Check, Copy, Download, Maximize2, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react'

import { cn } from '@/lib/utils'
import { expandSpanDirectives } from '@/lib/inline-style'
import { downloadMediaSrc, MEDIA_KIND_LABEL, type MediaKind } from '@/components/recitation/media-refs'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import 'highlight.js/styles/github.css'

// ---------- $ currency guard (math false-positive protection) ----------

/** A $…$ span only counts as math when it contains a LaTeX-ish hint:
 *  ASCII letters, a backslash command or ^ _ { }. Pure numbers/CJK like
 *  "5，总共" or "100" are treated as currency and left as literal text. */
const MATH_HINT_RE = /[A-Za-z\\^_{}]/

/** Escape both dollars of a non-math $…$ pair (\$ renders a literal $). */
function guardCurrencyDollars(md: string): string {
  let out = ''
  let i = 0
  while (i < md.length) {
    const ch = md[i]
    if (ch === '\\' && i + 1 < md.length) {
      // already-escaped char — copy verbatim
      out += md.slice(i, i + 2)
      i += 2
      continue
    }
    if (ch === '$' && md[i + 1] !== '$') {
      // find a closing $ on the same line (inline math never spans lines)
      let j = i + 1
      while (j < md.length && md[j] !== '$' && md[j] !== '\n') j += 1
      if (j < md.length && md[j] === '$') {
        const inner = md.slice(i + 1, j)
        if (MATH_HINT_RE.test(inner)) {
          out += md.slice(i, j + 1) // looks like math — keep delimiters
        } else {
          out += `\\$${inner}\\$` // currency — escape so remark-math skips it
        }
        i = j + 1
        continue
      }
    }
    out += ch
    i += 1
  }
  return out
}

/** Apply the currency guard everywhere except fenced/inline code, where
 *  characters must stay untouched. $$…$$ display math is always kept. */
function guardDollarsOutsideCode(md: string): string {
  const parts = md.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g)
  return parts
    .map((p) => (/^(```|~~~|`)/.test(p) ? p : guardCurrencyDollars(p)))
    .join('')
}

// ---------- raw SVG handling ----------

/** Extract <svg>…</svg> segments so they can bypass markdown and render natively. */
function splitSvgSegments(content: string): Array<{ type: 'md' | 'svg'; value: string }> {
  const parts = content.split(/(<svg\b[\s\S]*?<\/svg\s*>)/i)
  return parts
    .filter((p) => p !== '')
    .map((value) => ({ type: /^<svg\b/i.test(value) ? ('svg' as const) : ('md' as const), value }))
}

/** Minimal sanitizer for embedded markup (raw SVG or raw HTML blocks):
 *  drop <script> tags, on* handlers and js: hrefs. */
function sanitizeEmbeddedHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/((?:xlink:)?href\s*=\s*)(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '$1"#"')
}

// ---------- unified media interactions ----------

/** 详情态数据（自包含，不依赖 MediaRef） */
interface MediaDetailState {
  kind: MediaKind
  /** 图片 url 或富媒体源码 */
  src: string
  alt?: string
  /** 代码语言（code 块） */
  lang?: string
}

interface MediaCtx {
  interactive: boolean
  onDetail: (d: MediaDetailState) => void
}

/** 悬浮操作条：详情（放大）+ 下载；桌面 hover 显示，移动端常显。 */
function MediaActionBar({
  onDetail,
  onDownload,
  className,
}: {
  onDetail: () => void
  onDownload?: () => void
  className?: string
}) {
  const btn =
    'pointer-events-auto flex size-7 items-center justify-center rounded-lg border border-border bg-background/95 text-muted-foreground shadow-sm transition-colors hover:text-foreground active:scale-95'
  return (
    <span
      className={cn(
        'absolute right-1 top-1 z-10 flex gap-1 opacity-100 transition-opacity md:pointer-events-none md:opacity-0 md:group-hover:pointer-events-auto md:group-hover:opacity-100',
        className,
      )}
    >
      <button type="button" aria-label="放大详情" title="放大详情" className={btn} onClick={onDetail}>
        <Maximize2 className="size-3.5" strokeWidth={1.75} />
      </button>
      {onDownload && (
        <button type="button" aria-label="下载保存" title="下载保存" className={btn} onClick={onDownload}>
          <Download className="size-3.5" strokeWidth={1.75} />
        </button>
      )}
    </span>
  )
}

function SvgSegment({ html, ctx }: { html: string; ctx: MediaCtx }) {
  const interactive = ctx.interactive
  const body = (
    <div
      className="my-3 flex max-w-full justify-center overflow-x-auto rounded-xl border border-border bg-background p-3"
      // Sanitized above: no script tags, no on* handlers, no js: hrefs.
      dangerouslySetInnerHTML={{ __html: html }}
      role="img"
      aria-label="内嵌 SVG 图"
    />
  )
  if (!interactive) return body
  return (
    <div
      className="group relative my-3 cursor-zoom-in"
      onClick={() => ctx.onDetail({ kind: 'svg', src: html })}
      role="button"
      aria-label="SVG 图，点击查看详情"
    >
      {body}
      <MediaActionBar
        onDetail={() => ctx.onDetail({ kind: 'svg', src: html })}
        onDownload={() => downloadMediaSrc('svg', html, 'svg')}
      />
    </div>
  )
}

// ---------- raw user HTML blocks (Shadow DOM sandbox) ----------

/** A line that opens a raw HTML block (CommonMark-ish): begins with `<tag`,
 *  `</tag` or `<!`. Plain text like "5 < 6" or "<- arrow" never matches.
 *  Detection runs BEFORE %%…%% directives are expanded, so our generated
 *  inline <span style> markup is never captured — only genuine user HTML. */
const HTML_BLOCK_OPEN_RE = /^\s*<(?:\/[a-zA-Z]|[a-zA-Z][a-zA-Z0-9-]*[\s/>]|!)/

/** Split a markdown segment into regular markdown and raw HTML blocks.
 *  An HTML block runs from its opening line to the first blank line
 *  (CommonMark type-6 rule); everything inside is treated as user HTML.
 *  Lines inside ``` / ~~~ fenced code are never captured — a fenced ```html
 *  block keeps rendering as a code block, only bare raw-HTML lines (and the
 *  bare html snippets ClozeText passes for ```html fences) are sandboxed. */
function splitHtmlSegments(content: string): Array<{ type: 'md' | 'html'; value: string }> {
  const out: Array<{ type: 'md' | 'html'; value: string }> = []
  const lines = content.split('\n')
  let buf: string[] = []
  let mode: 'md' | 'html' | null = null
  let fence = false
  const flush = () => {
    if (mode && buf.length) out.push({ type: mode, value: buf.join('\n') })
    buf = []
  }
  for (const line of lines) {
    const t = line.trim()
    // 围栏代码块内部：全部按 markdown 原样处理，不识别为 HTML 块
    if (fence) {
      if (mode === null) mode = 'md'
      buf.push(line)
      if (t.startsWith('```') || t.startsWith('~~~')) fence = false
      continue
    }
    if (mode === 'html') {
      if (t === '') {
        // 空行结束 HTML 块；空行本身归入后续 markdown 段
        flush()
        mode = 'md'
        buf.push(line)
      } else {
        buf.push(line)
      }
      continue
    }
    if (t.startsWith('```') || t.startsWith('~~~')) {
      if (mode === null) mode = 'md'
      buf.push(line)
      fence = true
      continue
    }
    if (HTML_BLOCK_OPEN_RE.test(line)) {
      flush()
      mode = 'html'
      buf.push(line)
      continue
    }
    if (mode === null) mode = 'md'
    buf.push(line)
  }
  flush()
  return out.filter((s) => s.value.trim() !== '')
}

/** HtmlSandbox — renders raw user HTML inside a real Shadow DOM so styles and
 *  layout (position / float / wide tables …) can never leak into or out of the
 *  page. The host element is width-bounded and scroll-contained. */
function HtmlSandbox({ html, className }: { html: string; className?: string }) {
  const hostRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let root: ShadowRoot | null = null
    if (host.shadowRoot) root = host.shadowRoot
    else root = host.attachShadow({ mode: 'open' })
    // minimal base styles inside the shadow so content is readable but contained
    root.innerHTML = `<style>
      :host { display: block; max-width: 100%; overflow-x: auto; contain: layout style; }
      * { max-width: 100%; }
      img { max-width: 100%; height: auto; }
      table { max-width: 100%; table-layout: auto; }
    </style>${sanitizeEmbeddedHtml(html)}`
  }, [html])
  return <div ref={hostRef} className={cn('min-w-0 max-w-full overflow-x-auto', className)} />
}

// ---------- mermaid ----------

let mermaidSeq = 0

function MermaidBlock({ code, ctx }: { code: string; ctx: MediaCtx }) {
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme === 'dark'
  const [svg, setSvg] = React.useState('')
  const [failed, setFailed] = React.useState(false)

  // Re-renders when the source or the theme changes; keeps the previous SVG
  // visible while the new one is being produced (no flicker to loading state).
  React.useEffect(() => {
    let cancelled = false
    setFailed(false)
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          theme: dark ? 'dark' : 'neutral',
          securityLevel: 'strict',
        })
        mermaidSeq += 1
        const id = `rich-mermaid-${mermaidSeq}`
        const { svg } = await mermaid.render(id, code)
        if (!cancelled) {
          setSvg(svg)
          setFailed(false)
        }
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, dark])

  if (failed) {
    // Graceful fallback: show the mermaid source as a plain code block.
    return <CodeBlock raw={code} ctx={ctx} kind="code" lang="mermaid"><code className="font-mono">{code}</code></CodeBlock>
  }
  if (!svg) {
    return (
      <div className="my-3 flex items-center justify-center rounded-xl bg-muted/50 py-8 text-xs text-muted-foreground">
        图表渲染中…
      </div>
    )
  }
  const body = (
    <div
      className="my-3 flex max-w-full justify-center overflow-x-auto rounded-xl border border-border bg-background p-3 [&_svg]:max-w-full"
      // Mermaid SVG string (securityLevel: 'strict').
      dangerouslySetInnerHTML={{ __html: svg }}
      role="img"
      aria-label="Mermaid 图表"
    />
  )
  if (!ctx.interactive) return body
  return (
    <div
      className="group relative my-3 cursor-zoom-in"
      onClick={() => ctx.onDetail({ kind: 'mermaid', src: code })}
      role="button"
      aria-label="Mermaid 图表，点击查看详情"
    >
      {body}
      <MediaActionBar
        onDetail={() => ctx.onDetail({ kind: 'mermaid', src: code })}
        onDownload={() => downloadMediaSrc('mermaid', code, 'mermaid')}
      />
    </div>
  )
}

/** ```svg 围栏块 → 原生渲染（与裸 <svg> 段一致），同样带交互条。 */
function SvgFencedBlock({ code, ctx }: { code: string; ctx: MediaCtx }) {
  const html = sanitizeEmbeddedHtml(code)
  return <SvgSegment html={html} ctx={ctx} />
}

// ---------- code blocks ----------

interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

function hastNodeText(node?: HastNode | null): string {
  if (!node) return ''
  if (node.type === 'text') return typeof node.value === 'string' ? node.value : ''
  if (Array.isArray(node.children)) return node.children.map(hastNodeText).join('')
  return ''
}

function firstElementChild(node?: HastNode | null): HastNode | undefined {
  return node?.children?.find((c) => c.type === 'element' || c.type === 'text')
}

function CodeBlock({
  raw,
  children,
  ctx,
  kind = 'code',
  lang = '',
}: {
  raw: string
  children: React.ReactNode
  ctx: MediaCtx
  /** 详情/下载用的媒体类型（mermaid 失败回退时传 'code'） */
  kind?: 'code' | 'table'
  lang?: string
}) {
  const [copied, setCopied] = React.useState(false)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(raw)
      setCopied(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 1600)
    } catch {
      // clipboard unavailable (e.g. insecure context) — ignore silently
    }
  }

  return (
    <div className="group relative my-3">
      <pre
        className={cn(
          'overflow-x-auto rounded-xl border border-border bg-muted/70 p-3 font-mono text-xs leading-relaxed',
          // 右侧留出操作按钮空间（交互态有 详情+下载+复制 三个按钮）
          ctx.interactive ? 'pr-24' : 'pr-12',
        )}
      >
        {children}
      </pre>
      <div className="absolute right-2 top-2 flex gap-1">
        {ctx.interactive && (
          <>
            <button
              type="button"
              aria-label="放大详情"
              title="放大详情"
              onClick={() => ctx.onDetail({ kind: kind === 'table' ? 'table' : 'code', src: raw, lang })}
              className="flex size-7 items-center justify-center rounded-lg border border-border bg-background/90 text-muted-foreground shadow-sm transition-colors hover:text-foreground"
            >
              <Maximize2 className="size-3.5" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              aria-label="下载保存"
              title="下载保存"
              onClick={() => downloadMediaSrc(kind === 'table' ? 'table' : 'code', raw, lang)}
              className="flex size-7 items-center justify-center rounded-lg border border-border bg-background/90 text-muted-foreground shadow-sm transition-colors hover:text-foreground"
            >
              <Download className="size-3.5" strokeWidth={1.75} />
            </button>
          </>
        )}
        <button
          type="button"
          aria-label="复制代码"
          onClick={() => void copy()}
          className="flex size-7 items-center justify-center rounded-lg border border-border bg-background/90 text-muted-foreground shadow-sm transition-colors hover:text-foreground"
        >
          {copied ? (
            <Check className="size-3.5 text-emerald-600" strokeWidth={2} />
          ) : (
            <Copy className="size-3.5" strokeWidth={1.75} />
          )}
        </button>
      </div>
    </div>
  )
}

// ---------- display formula block（katex-display → 详情/下载） ----------

/** 从 KaTeX 输出的 MathML annotation 中取回原始 LaTeX 源码。 */
function katexSourceOf(el: HTMLElement | null): string {
  return el?.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? ''
}

function FormulaDisplayBlock({ children, ctx }: { children: React.ReactNode; ctx: MediaCtx }) {
  const ref = React.useRef<HTMLSpanElement>(null)
  if (!ctx.interactive) {
    return <span className="block">{children}</span>
  }
  const src = () => katexSourceOf(ref.current)
  return (
    <span ref={ref} className="group relative block">
      {children}
      <MediaActionBar
        onDetail={() => ctx.onDetail({ kind: 'formula', src: src(), lang: 'latex' })}
        onDownload={() => downloadMediaSrc('formula', src(), 'latex')}
      />
    </span>
  )
}

// ---------- markdown component mapping ----------

function reactNodeText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(reactNodeText).join('')
  if (React.isValidElement(node)) {
    return reactNodeText((node.props as { children?: React.ReactNode }).children)
  }
  return ''
}

/** hast table 节点 → markdown 表格源码（详情/下载/朗读需要纯文本源码）。 */
function hastTableToMarkdown(node?: HastNode | null): string {
  const rows: string[][] = []
  const walk = (n?: HastNode | null) => {
    if (!n || n.type !== 'element' || !Array.isArray(n.children)) return
    if (n.tagName === 'tr') {
      const cells: string[] = []
      for (const c of n.children) {
        if (c.type === 'element' && (c.tagName === 'td' || c.tagName === 'th')) {
          cells.push(hastNodeText(c).replace(/\|/g, '\\|').trim())
        }
      }
      rows.push(cells)
      return
    }
    for (const c of n.children) walk(c)
  }
  walk(node)
  if (rows.length === 0) return ''
  const cols = Math.max(1, ...rows.map((r) => r.length))
  const pad = (r: string[]) => {
    const c = [...r]
    while (c.length < cols) c.push('')
    return c
  }
  const [head, ...body] = rows.map(pad)
  return [
    `| ${head.join(' | ')} |`,
    `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n')
}

function buildMarkdownComponents(ctx: MediaCtx): Components {
  return {
    h1: ({ children }) => (
      <h1 className="mb-2 mt-5 text-lg font-bold first:mt-0">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="mb-2 mt-4 text-base font-bold first:mt-0">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="mb-1.5 mt-3 text-sm font-bold first:mt-0">{children}</h3>
    ),
    h4: ({ children }) => (
      <h4 className="mb-1.5 mt-3 text-sm font-semibold first:mt-0">{children}</h4>
    ),
    p: ({ children }) => (
      <p className="my-2 whitespace-pre-wrap break-words leading-relaxed first:mt-0 last:mb-0">
        {children}
      </p>
    ),
    ul: ({ children }) => (
      <ul className="my-2 list-disc space-y-1 pl-5 marker:text-muted-foreground">
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-muted-foreground">
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    strong: ({ children }) => (
      <strong className="font-semibold text-foreground">{children}</strong>
    ),
    em: ({ children }) => <em className="italic">{children}</em>,
    a: ({ children, href }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="break-all text-emerald-600 underline underline-offset-2 hover:text-emerald-700"
      >
        {children}
      </a>
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-3 rounded-r-lg border-l-2 border-emerald-600/60 bg-emerald-500/5 px-3 py-1.5 text-muted-foreground">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="my-4 border-border" />,
    table: ({ node, children }) => {
      const md = hastTableToMarkdown(node as unknown as HastNode)
      const detail = () => ctx.onDetail({ kind: 'table', src: md || reactNodeText(children), lang: 'table' })
      return (
        <div className="group relative my-3 max-w-full">
          <div className="max-w-full overflow-x-auto rounded-xl border border-border">
            <table className="w-full border-collapse text-sm">{children}</table>
          </div>
          {ctx.interactive && (
            <MediaActionBar onDetail={detail} onDownload={() => downloadMediaSrc('table', md, 'table')} className="-top-2" />
          )}
        </div>
      )
    },
    thead: ({ children }) => <thead className="bg-muted/70">{children}</thead>,
    th: ({ children }) => (
      <th className="whitespace-nowrap border-b border-border px-3 py-2 text-left font-semibold">
        {children}
      </th>
    ),
    tr: ({ children }) => (
      <tr className="border-b border-border last:border-b-0">{children}</tr>
    ),
    td: ({ children }) => (
      <td className="border-b border-border px-3 py-2 align-top last:border-b-0">
        {children}
      </td>
    ),
    img: ({ src, alt }) => {
      const url = typeof src === 'string' ? src : ''
      const body = (
        <img
          src={url}
          alt={alt ?? ''}
          loading="lazy"
          className="my-2 h-auto max-w-full rounded-xl"
          // 任何来源的图片都不允许撑破容器宽度
          style={{ maxWidth: '100%', height: 'auto' }}
        />
      )
      if (!ctx.interactive) return body
      return (
        <span className="group relative my-2 inline-block max-w-full align-top">
          <span
            role="button"
            aria-label={`${alt || '图片'}，点击查看详情`}
            className="block cursor-zoom-in"
            onClick={() => ctx.onDetail({ kind: 'image', src: url, alt: alt ?? '' })}
          >
            {body}
          </span>
          <MediaActionBar
            onDetail={() => ctx.onDetail({ kind: 'image', src: url, alt: alt ?? '' })}
            onDownload={() => downloadMediaSrc('image', url)}
          />
        </span>
      )
    },
    span: ({ className, children }) => {
      // KaTeX display 公式块（rehype-katex 输出 span.katex-display）→ 加详情/下载
      if (typeof className === 'string' && className.includes('katex-display')) {
        return <FormulaDisplayBlock ctx={ctx}>{children}</FormulaDisplayBlock>
      }
      return <span className={className}>{children}</span>
    },
    pre: ({ node, children }) => {
      const el = node as unknown as HastNode | undefined
      const codeChild = firstElementChild(el)
      const classNames = Array.isArray(codeChild?.properties?.className)
        ? ((codeChild?.properties?.className as unknown[]) || []).join(' ')
        : ''
      const raw = hastNodeText(codeChild)
      if (classNames.includes('language-mermaid')) {
        return <MermaidBlock code={raw} ctx={ctx} />
      }
      if (classNames.includes('language-svg')) {
        return <SvgFencedBlock code={raw} ctx={ctx} />
      }
      const lang = /language-([A-Za-z0-9_-]+)/.exec(classNames)?.[1] ?? ''
      return (
        <CodeBlock raw={raw} ctx={ctx} lang={lang}>
          {children}
        </CodeBlock>
      )
    },
    code: ({ className, children }) => {
      const cls = typeof className === 'string' ? className : ''
      // Block-level code (inside our pre wrapper): keep it plain, pre styles it.
      if (cls.includes('language-') || reactNodeText(children).includes('\n')) {
        return <code className="font-mono">{children}</code>
      }
      // Inline code pill.
      return (
        <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-emerald-700 dark:text-emerald-400">
          {children}
        </code>
      )
    },
  }
}

// ---------- 全屏详情态（自包含 ZoomPane，不依赖 MediaDetailDialog） ----------

function MediaDetailOverlay({
  detail,
  onClose,
}: {
  detail: MediaDetailState
  onClose: () => void
}) {
  const [scale, setScale] = React.useState(1)
  const [pan, setPan] = React.useState({ x: 0, y: 0 })
  const [copied, setCopied] = React.useState(false)
  const dragRef = React.useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)

  React.useEffect(() => {
    setScale(1)
    setPan({ x: 0, y: 0 })
    setCopied(false)
  }, [detail])

  const zoom = (d: number) =>
    setScale((s) => Math.min(4, Math.max(0.25, Math.round((s + d) * 100) / 100)))

  const onStagePointerDown = (e: React.PointerEvent) => {
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onStagePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    setPan({ x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) })
  }
  const onStagePointerUp = () => {
    dragRef.current = null
  }

  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(detail.src)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* 剪贴板不可用 — 忽略 */
    }
  }

  /** 详情内容：mermaid/svg 用自身（mediaInteractive=false）渲染，防递归 */
  let content: React.ReactNode
  switch (detail.kind) {
    case 'image':
      content = (
        <img
          src={detail.src}
          alt={detail.alt || '图片详情'}
          className="max-h-[72dvh] max-w-[92vw] select-none object-contain"
          draggable={false}
        />
      )
      break
    case 'mermaid':
      content = (
        <div className="max-h-[76dvh] max-w-[92vw] overflow-auto rounded-xl bg-white p-4">
          <RichContent content={'```mermaid\n' + detail.src + '\n```'} mediaInteractive={false} />
        </div>
      )
      break
    case 'svg':
      content = (
        <div className="max-h-[76dvh] max-w-[92vw] overflow-auto rounded-xl bg-white p-4">
          <RichContent content={'```svg\n' + detail.src + '\n```'} mediaInteractive={false} />
        </div>
      )
      break
    case 'table':
      content = (
        <div className="max-h-[76dvh] max-w-[94vw] overflow-auto rounded-xl bg-background p-4 text-foreground">
          <RichContent content={detail.src} mediaInteractive={false} />
        </div>
      )
      break
    case 'formula':
      content = (
        <div className="max-w-[92vw] text-2xl text-white [&_.katex-display]:my-0">
          <RichContent content={'$$' + detail.src + '$$'} mediaInteractive={false} />
        </div>
      )
      break
    default:
      content = (
        <pre className="max-h-[76dvh] max-w-[94vw] overflow-auto rounded-xl bg-muted p-4 font-mono text-xs leading-relaxed text-foreground">
          {detail.src}
        </pre>
      )
  }

  const ctrlBtn =
    'flex size-9 items-center justify-center rounded-full bg-white/10 text-white/90 transition-colors hover:bg-white/20 disabled:opacity-30'

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="inset-0 top-0 left-0 z-[90] flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-black/90 p-0"
      >
        {/* 顶栏：类型 + 操作 */}
        <div className="flex items-center gap-1.5 border-b border-white/10 px-3 py-2">
          <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium text-white">
            {MEDIA_KIND_LABEL[detail.kind]}详情
            {detail.kind === 'image' && detail.alt ? ` · ${detail.alt}` : ''}
          </DialogTitle>
          <button
            type="button"
            aria-label="复制源码"
            title="复制源码"
            onClick={() => void copySource()}
            className={ctrlBtn}
          >
            {copied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
          </button>
          <button
            type="button"
            aria-label="下载保存"
            title="下载保存"
            onClick={() => downloadMediaSrc(detail.kind, detail.src, detail.lang ?? '')}
            className={ctrlBtn}
          >
            <Download className="size-4" />
          </button>
          <button
            type="button"
            aria-label="关闭详情"
            title="关闭"
            onClick={onClose}
            className={ctrlBtn}
          >
            <X className="size-4" />
          </button>
        </div>

        {/* 舞台：拖拽平移 + 双击 1x/2x */}
        <div
          className="relative flex-1 touch-none overflow-hidden"
          onPointerDown={onStagePointerDown}
          onPointerMove={onStagePointerMove}
          onPointerUp={onStagePointerUp}
          onPointerCancel={onStagePointerUp}
          onDoubleClick={() => {
            if (scale >= 2) {
              setScale(1)
              setPan({ x: 0, y: 0 })
            } else {
              setScale(2)
            }
          }}
        >
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, cursor: 'grab' }}
          >
            {content}
          </div>
        </div>

        {/* 底部缩放控制 */}
        <div className="flex items-center justify-center gap-2 border-t border-white/10 px-3 py-2.5">
          <button
            type="button"
            aria-label="缩小"
            className={ctrlBtn}
            disabled={scale <= 0.25}
            onClick={() => zoom(-0.25)}
          >
            <ZoomOut className="size-4" />
          </button>
          <button
            type="button"
            aria-label="重置缩放"
            title="重置缩放（双击内容 1x/2x 切换）"
            onClick={() => {
              setScale(1)
              setPan({ x: 0, y: 0 })
            }}
            className="min-w-16 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium tabular-nums text-white/90 transition-colors hover:bg-white/20"
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            type="button"
            aria-label="放大"
            className={ctrlBtn}
            disabled={scale >= 4}
            onClick={() => zoom(0.25)}
          >
            <ZoomIn className="size-4" />
          </button>
          <button
            type="button"
            aria-label="复位"
            title="复位（缩放与位移）"
            className={ctrlBtn}
            onClick={() => {
              setScale(1)
              setPan({ x: 0, y: 0 })
            }}
          >
            <RotateCcw className="size-4" />
          </button>
          <span className="hidden text-[11px] text-white/40 sm:block">拖拽平移 · 双击 1x/2x</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------- public component ----------

export const RichContent = React.memo(function RichContent({
  content,
  className,
  maxHeight,
  mediaInteractive = true,
}: {
  content: string
  className?: string
  /** Optional pixel/px-unit cap; content longer than this scrolls vertically. */
  maxHeight?: number | string
  /** 富媒体交互（详情放大 / 下载）；详情态内层渲染置 false 防递归。 */
  mediaInteractive?: boolean
}) {
  const [detail, setDetail] = React.useState<MediaDetailState | null>(null)
  const segments = React.useMemo(() => splitSvgSegments(content || ''), [content])
  const scrollStyle = React.useMemo<React.CSSProperties>(
    () => (maxHeight == null ? {} : { maxHeight, overflowY: 'auto', overscrollBehavior: 'contain' }),
    [maxHeight],
  )
  const ctx = React.useMemo<MediaCtx>(
    () => ({ interactive: mediaInteractive, onDetail: setDetail }),
    [mediaInteractive],
  )
  const components = React.useMemo(() => buildMarkdownComponents(ctx), [ctx])
  return (
    <div
      className={cn(
        'min-w-0 max-w-full break-words text-sm leading-relaxed',
        // KaTeX display blocks: breathing room + horizontal scroll on mobile
        '[&_.katex-display]:my-3 [&_.katex-display]:overflow-x-auto [&_.katex-display]:py-1 [&_.katex-error]:text-red-600 dark:[&_.katex-error]:text-red-400',
        // HTML 片段 / 内嵌元素永不溢出容器：表格横向滚动，媒体自适应宽度
        '[&_table]:max-w-full [&_video]:max-w-full [&_iframe]:max-w-full [&_img]:max-w-full',
        className,
      )}
      style={scrollStyle}
    >
      {segments.map((seg, i) =>
        seg.type === 'svg' ? (
          <SvgSegment key={`s${i}`} html={sanitizeEmbeddedHtml(seg.value)} ctx={ctx} />
        ) : (
          splitHtmlSegments(seg.value).map((sub, j) =>
            sub.type === 'html' ? (
              // 原生用户 HTML 块 → Shadow DOM 沙盒（样式/布局双向隔离，永不撑破页面）
              <HtmlSandbox key={`h${i}-${j}`} html={sub.value} className="my-3" />
            ) : (
              <ReactMarkdown
                key={`m${i}-${j}`}
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeRaw, rehypeHighlight, rehypeKatex]}
                components={components}
              >
                {/* 先展开 %%样式|文字%% 指令（代码段内不动），再护住非数学的 $ 货币对 */}
                {guardDollarsOutsideCode(expandSpanDirectives(sub.value))}
              </ReactMarkdown>
            ),
          )
        ),
      )}
      {/* 全屏详情态（自包含；不 import MediaDetailDialog，避免编辑器上下文耦合） */}
      {detail && <MediaDetailOverlay detail={detail} onClose={() => setDetail(null)} />}
    </div>
  )
})

export default RichContent
