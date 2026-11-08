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
//   • raw <svg>…</svg> segments in the content render natively (sanitized)
//   • bordered tables with horizontal scroll on mobile
//   • optional maxHeight → the whole container scrolls vertically
// Never crashes on plain text — plain paragraphs just render as paragraphs.
import * as React from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import 'katex/dist/katex.min.css'
import { useTheme } from 'next-themes'
import { Check, Copy } from 'lucide-react'

import { cn } from '@/lib/utils'
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

/** Minimal sanitizer: drop <script> tags, on* handlers and js: hrefs. */
function sanitizeSvg(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/((?:xlink:)?href\s*=\s*)(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '$1"#"')
}

function SvgSegment({ html }: { html: string }) {
  return (
    <div
      className="my-3 flex max-w-full justify-center overflow-x-auto rounded-xl border border-border bg-background p-3"
      // Sanitized above: no script tags, no on* handlers, no js: hrefs.
      dangerouslySetInnerHTML={{ __html: html }}
      role="img"
      aria-label="内嵌 SVG 图"
    />
  )
}

// ---------- mermaid ----------

let mermaidSeq = 0

function MermaidBlock({ code }: { code: string }) {
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
    return <CodeBlock raw={code}><code className="font-mono">{code}</code></CodeBlock>
  }
  if (!svg) {
    return (
      <div className="my-3 flex items-center justify-center rounded-xl bg-muted/50 py-8 text-xs text-muted-foreground">
        图表渲染中…
      </div>
    )
  }
  return (
    <div
      className="my-3 flex max-w-full justify-center overflow-x-auto rounded-xl border border-border bg-background p-3 [&_svg]:max-w-full"
      // Mermaid SVG string (securityLevel: 'strict').
      dangerouslySetInnerHTML={{ __html: svg }}
      role="img"
      aria-label="Mermaid 图表"
    />
  )
}

// ---------- code blocks ----------

interface HastNode {
  type: string
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

function CodeBlock({ raw, children }: { raw: string; children: React.ReactNode }) {
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
      <pre className="overflow-x-auto rounded-xl border border-border bg-muted/70 p-3 font-mono text-xs leading-relaxed">
        {children}
      </pre>
      <button
        type="button"
        aria-label="复制代码"
        onClick={() => void copy()}
        className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-lg border border-border bg-background/90 text-muted-foreground shadow-sm transition-colors hover:text-foreground"
      >
        {copied ? (
          <Check className="size-3.5 text-emerald-600" strokeWidth={2} />
        ) : (
          <Copy className="size-3.5" strokeWidth={1.75} />
        )}
      </button>
    </div>
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

const MARKDOWN_COMPONENTS: Components = {
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
  table: ({ children }) => (
    <div className="my-3 max-w-full overflow-x-auto rounded-xl border border-border">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
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
  img: ({ src, alt }) => (
    <img src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} loading="lazy" className="my-2 max-w-full rounded-lg" />
  ),
  pre: ({ node, children }) => {
    const el = node as unknown as HastNode | undefined
    const codeChild = firstElementChild(el)
    const classNames = Array.isArray(codeChild?.properties?.className)
      ? ((codeChild?.properties?.className as unknown[]) || []).join(' ')
      : ''
    const raw = hastNodeText(codeChild)
    if (classNames.includes('language-mermaid')) {
      return <MermaidBlock code={raw} />
    }
    return <CodeBlock raw={raw}>{children}</CodeBlock>
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

// ---------- public component ----------

export const RichContent = React.memo(function RichContent({
  content,
  className,
  maxHeight,
}: {
  content: string
  className?: string
  /** Optional pixel/px-unit cap; content longer than this scrolls vertically. */
  maxHeight?: number | string
}) {
  const segments = React.useMemo(() => splitSvgSegments(content || ''), [content])
  const scrollStyle = React.useMemo<React.CSSProperties>(
    () => (maxHeight == null ? {} : { maxHeight, overflowY: 'auto', overscrollBehavior: 'contain' }),
    [maxHeight],
  )
  return (
    <div
      className={cn(
        'text-sm leading-relaxed',
        // KaTeX display blocks: breathing room + horizontal scroll on mobile
        '[&_.katex-display]:my-3 [&_.katex-display]:overflow-x-auto [&_.katex-display]:py-1 [&_.katex-error]:text-red-600 dark:[&_.katex-error]:text-red-400',
        className,
      )}
      style={scrollStyle}
    >
      {segments.map((seg, i) =>
        seg.type === 'svg' ? (
          <SvgSegment key={i} html={sanitizeSvg(seg.value)} />
        ) : (
          <ReactMarkdown
            key={i}
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeRaw, rehypeHighlight, rehypeKatex]}
            components={MARKDOWN_COMPONENTS}
          >
            {guardDollarsOutsideCode(seg.value)}
          </ReactMarkdown>
        ),
      )}
    </div>
  )
})

export default RichContent
