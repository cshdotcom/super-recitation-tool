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
//   • ```html fenced blocks render inside a Shadow-DOM sandbox (sanitized, width-
//     bounded, scroll-contained) with the unified floating action bar (detail /
//     download); bare raw-HTML lines keep the same sandbox path as before
//   • raw <svg>…</svg> segments in the content render natively (sanitized)
//   • audio/video references — [[audio:<uuid>]] / [[video:<uuid>|标题]] — render
//     as native players (rounded card with title + <audio> bar / <video max-h-72>),
//     preprocessed into image placeholders before react-markdown (code spans
//     untouched); detail overlay shows a bigger player + download
//   • bordered tables with horizontal scroll on mobile
//   • optional maxHeight → the whole container scrolls vertically
//   • unified rich-media interactions (mediaInteractive, default true):
//     every media block (image / mermaid / svg / table / code / display
//     formula / audio / video) gets a floating action bar (detail + download +
//     export-PNG/SVG for vector & rendered blocks); detail opens a
//     self-contained fullscreen overlay (zoom 0.25–4x, drag-pan, download,
//     copy-source, export). Detail re-renders media with mediaInteractive={false}
//     to prevent recursion. All render sites (chat / quiz / papers / favorites /
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
import { Check, Copy, Download, FileDown, ImageDown, Maximize2, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { expandSpanDirectives } from '@/lib/inline-style'
import {
  downloadMediaSrc,
  downloadSvgElement,
  downloadSvgElementAsPng,
  fileTimestamp,
  MEDIA_KIND_LABEL,
  type MediaRefKind,
} from '@/components/recitation/media-refs'
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

// ---------- 音视频引用（[[audio:<uuid>]] / [[video:<uuid>|标题]]） ----------

/**
 * 把音视频引用换成图片 markdown 占位（`![av-audio:标题](/api/upload/<uuid>)`），
 * 由下方 img 组件映射识别前缀后渲染原生播放器。代码段（围栏/行内）内不动。
 * 与编辑器/上传链路的引用契约：播放地址固定为 /api/upload/<uuid>。
 */
function mediaRefPlaceholders(md: string): string {
  const parts = md.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g)
  return parts
    .map((p) => {
      if (/^(```|~~~|`)/.test(p)) return p
      return p.replace(
        /\[\[(audio|video):([a-f0-9-]+)(?:\|([^\]]*))?\]\]/g,
        (_m: string, kind: string, uuid: string, title: string | undefined) => {
          const label = (title ?? '').trim() || (kind === 'audio' ? '音频' : '视频')
          return `![av-${kind}:${label}](/api/upload/${uuid})`
        },
      )
    })
    .join('')
}

/** 音频引用块：圆角卡片（🔊 标题 + 原生 audio 条）；详情态/下载走统一媒体交互。 */
function AudioBlock({ url, title, ctx }: { url: string; title: string; ctx: MediaCtx }) {
  const body = (
    <span className="my-2 flex w-full max-w-full items-center gap-2.5 rounded-xl border border-border bg-muted/40 px-3 py-2">
      <span
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-sm"
        aria-hidden
      >
        🔊
      </span>
      <span className="min-w-0 flex-1">
        <span className="mb-1 block truncate text-xs font-medium text-foreground">{title}</span>
        <audio controls preload="metadata" src={url} className="h-8 w-full min-w-0" />
      </span>
    </span>
  )
  if (!ctx.interactive) return body
  return (
    <span className="group relative my-2 block max-w-full">
      {body}
      <MediaActionBar
        onDetail={() => ctx.onDetail({ kind: 'audio', src: url, alt: title })}
        onDownload={() => downloadMediaSrc('audio', url)}
      />
    </span>
  )
}

/** 视频引用块：原生 video 播放器（限高 max-h-72，点击进详情可大屏播放）。 */
function VideoBlock({ url, title, ctx }: { url: string; title: string; ctx: MediaCtx }) {
  const body = (
    <video
      controls
      playsInline
      preload="metadata"
      src={url}
      className="my-2 max-h-72 w-full max-w-full rounded-xl border border-border bg-black"
    />
  )
  if (!ctx.interactive) return body
  return (
    <span className="group relative my-2 block max-w-full">
      {title && (
        <span className="mb-1 block truncate text-xs font-medium text-muted-foreground">{title}</span>
      )}
      {body}
      <MediaActionBar
        onDetail={() => ctx.onDetail({ kind: 'video', src: url, alt: title })}
        onDownload={() => downloadMediaSrc('video', url)}
      />
    </span>
  )
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
  kind: MediaRefKind
  /** 图片 url / 音视频播放地址或富媒体源码 */
  src: string
  alt?: string
  /** 代码语言（code 块） */
  lang?: string
}

interface MediaCtx {
  interactive: boolean
  onDetail: (d: MediaDetailState) => void
}

/** 悬浮操作条：详情（放大）+ 下载 + 导出图片（PNG/SVG）；桌面 hover 显示，移动端常显。
 *  按钮尺寸 size-8 保证移动端触控友好；点击均阻止冒泡（容器点击 = 打开详情）。 */
function MediaActionBar({
  onDetail,
  onDownload,
  onExportPng,
  onExportSvg,
  className,
}: {
  onDetail: () => void
  onDownload?: () => void
  /** 导出 PNG 图片（mermaid / SVG 图，带日期时间戳文件名） */
  onExportPng?: () => void
  /** 导出 SVG 源文件（mermaid / SVG 图） */
  onExportSvg?: () => void
  className?: string
}) {
  const btn =
    'pointer-events-auto flex size-8 items-center justify-center rounded-lg border border-border bg-background/95 text-muted-foreground shadow-sm transition-colors hover:text-foreground active:scale-95'
  return (
    <span
      className={cn(
        'absolute right-1 top-1 z-10 flex gap-1 opacity-100 transition-opacity md:pointer-events-none md:opacity-0 md:group-hover:pointer-events-auto md:group-hover:opacity-100',
        className,
      )}
    >
      <button
        type="button"
        aria-label="放大详情"
        title="放大详情"
        className={btn}
        onClick={(e) => {
          e.stopPropagation()
          onDetail()
        }}
      >
        <Maximize2 className="size-4" strokeWidth={1.75} />
      </button>
      {onDownload && (
        <button
          type="button"
          aria-label="下载保存"
          title="下载保存"
          className={btn}
          onClick={(e) => {
            e.stopPropagation()
            onDownload()
          }}
        >
          <Download className="size-4" strokeWidth={1.75} />
        </button>
      )}
      {onExportPng && (
        <button
          type="button"
          aria-label="导出PNG"
          title="导出PNG"
          className={btn}
          onClick={(e) => {
            e.stopPropagation()
            onExportPng()
          }}
        >
          <ImageDown className="size-4" strokeWidth={1.75} />
        </button>
      )}
      {onExportSvg && (
        <button
          type="button"
          aria-label="导出SVG"
          title="导出SVG"
          className={btn}
          onClick={(e) => {
            e.stopPropagation()
            onExportSvg()
          }}
        >
          <FileDown className="size-4" strokeWidth={1.75} />
        </button>
      )}
    </span>
  )
}

// ---------- DOM → PNG 导出（公式/表格导出共用，html-to-image） ----------

/** 页面 @font-face 内嵌 CSS（KaTeX 公式字体导出必需；一次生成全局缓存）。 */
let fontEmbedCssCache: string | null = null
async function cachedFontEmbedCss(): Promise<string | undefined> {
  try {
    if (fontEmbedCssCache === null) {
      const { getFontEmbedCSS } = await import('html-to-image')
      fontEmbedCssCache = await getFontEmbedCSS(document.body)
    }
    return fontEmbedCssCache || undefined
  } catch {
    return undefined
  }
}

/** 等待容器内图片全部解码完成（/api/upload 与 dataURL 均适用）。 */
async function waitImagesDecoded(root: HTMLElement): Promise<void> {
  const imgs = Array.from(root.querySelectorAll('img'))
  await Promise.all(
    imgs.map((im) =>
      im.complete
        ? undefined
        : new Promise<void>((r) => {
            im.addEventListener('load', () => r(), { once: true })
            im.addEventListener('error', () => r(), { once: true })
          }),
    ),
  )
}

/** 元素 → 白底 PNG 下载（2x；克隆进离屏容器加内边距，不带走操作条按钮）。 */
async function exportElementAsPng(
  el: Element,
  filename: string,
  opts: { color?: string } = {},
): Promise<void> {
  const { toPng } = await import('html-to-image')
  const width = Math.max(1, Math.ceil(el.getBoundingClientRect().width))
  const holder = document.createElement('div')
  holder.setAttribute('aria-hidden', 'true')
  holder.style.cssText = `position:fixed;left:-99999px;top:0;width:${width + 64}px;background:#ffffff;padding:24px 32px;`
  if (opts.color) holder.style.color = opts.color
  holder.appendChild(el.cloneNode(true))
  document.body.appendChild(holder)
  try {
    await waitImagesDecoded(holder)
    const dataUrl = await toPng(holder, {
      pixelRatio: 2,
      backgroundColor: '#ffffff',
      fontEmbedCSS: await cachedFontEmbedCss(),
    })
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    holder.remove()
  }
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
 *  Lines inside ``` / ~~~ fenced code are never captured here — fenced blocks
 *  stay intact for react-markdown, whose `pre` mapping then routes ```html
 *  fences to HtmlFencedBlock (sandbox) and keeps other fences as code blocks.
 *  Bare raw-HTML lines (and the bare html snippets ClozeText passes for
 *  ```html fences) still take this sandbox path unchanged. */
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
  const boxRef = React.useRef<HTMLDivElement>(null)

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
          // 纯 SVG 文本标签（不用 foreignObject）：导出 PNG/SVG 时跨浏览器序列化不丢文字
          flowchart: { htmlLabels: false },
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

  /** 容器内渲染好的 svg 元素（导出用；未渲染完成返回 null） */
  const renderedSvg = (): SVGSVGElement | null => boxRef.current?.querySelector('svg') ?? null

  const handleExportSvg = () => {
    const el = renderedSvg()
    if (!el) {
      toast.error('图表尚未渲染完成，请稍后再试')
      return
    }
    try {
      toast.success(`已导出 ${downloadSvgElement(el, MEDIA_KIND_LABEL.mermaid)}`)
    } catch {
      toast.error('导出 SVG 失败')
    }
  }

  const handleExportPng = async () => {
    const el = renderedSvg()
    if (!el) {
      toast.error('图表尚未渲染完成，请稍后再试')
      return
    }
    const tid = toast.loading('正在生成 PNG…')
    try {
      const name = await downloadSvgElementAsPng(el, MEDIA_KIND_LABEL.mermaid)
      toast.success(`已导出 ${name}`, { id: tid })
    } catch {
      toast.error('导出 PNG 失败', { id: tid })
    }
  }

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
      ref={boxRef}
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
        onExportPng={() => void handleExportPng()}
        onExportSvg={handleExportSvg}
      />
    </div>
  )
}

/** ```svg 围栏块 → 原生渲染（与裸 <svg> 段一致），同样带交互条。 */
function SvgFencedBlock({ code, ctx }: { code: string; ctx: MediaCtx }) {
  const html = sanitizeEmbeddedHtml(code)
  return <SvgSegment html={html} ctx={ctx} />
}

/** ```html 围栏块 → Shadow DOM 沙盒渲染（与裸 HTML 块同一隔离内核：
 *  sanitizeEmbeddedHtml 去 script/on* 事件 / js: + width-bounded + scroll-contained
 *  防溢出），带悬浮操作条（详情 / 下载 .html）。 */
function HtmlFencedBlock({ code, ctx }: { code: string; ctx: MediaCtx }) {
  const html = sanitizeEmbeddedHtml(code)
  const body = (
    <div className="my-3 max-w-full overflow-hidden rounded-xl border border-border bg-background p-3">
      <HtmlSandbox html={html} />
    </div>
  )
  if (!ctx.interactive) return body
  return (
    <div className="group relative my-3">
      {body}
      <MediaActionBar
        onDetail={() => ctx.onDetail({ kind: 'html', src: code })}
        onDownload={() => downloadMediaSrc('html', code, 'html')}
      />
    </div>
  )
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
  // Only a real element child counts as the <code> inside <pre>. A leading
  // text node (e.g. raw HTML `<pre>\n<code>…</code></pre>` with whitespace)
  // must NOT be returned — it has no properties, so it would wipe the language
  // class and yield raw='\n', wrapping multi-block content in a fake code block.
  return node?.children?.find((c) => c.type === 'element')
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
          // 右侧留出操作按钮空间（交互态有 详情+下载+复制 三个 size-8 按钮）
          ctx.interactive ? 'pr-30' : 'pr-14',
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
              className="flex size-8 items-center justify-center rounded-lg border border-border bg-background/90 text-muted-foreground shadow-sm transition-colors hover:text-foreground"
            >
              <Maximize2 className="size-4" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              aria-label="下载保存"
              title="下载保存"
              onClick={() => downloadMediaSrc(kind === 'table' ? 'table' : 'code', raw, lang)}
              className="flex size-8 items-center justify-center rounded-lg border border-border bg-background/90 text-muted-foreground shadow-sm transition-colors hover:text-foreground"
            >
              <Download className="size-4" strokeWidth={1.75} />
            </button>
          </>
        )}
        <button
          type="button"
          aria-label="复制代码"
          onClick={() => void copy()}
          className="flex size-8 items-center justify-center rounded-lg border border-border bg-background/90 text-muted-foreground shadow-sm transition-colors hover:text-foreground"
        >
          {copied ? (
            <Check className="size-4 text-emerald-600" strokeWidth={2} />
          ) : (
            <Copy className="size-4" strokeWidth={1.75} />
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
  /** KaTeX 渲染结果（含 html）→ 白底容器 → PNG */
  const handleExportPng = async () => {
    const node =
      ref.current?.querySelector('.katex-display') ?? ref.current?.querySelector('.katex') ?? ref.current
    if (!node) return
    const tid = toast.loading('正在生成图片…')
    try {
      await exportElementAsPng(node, `${MEDIA_KIND_LABEL.formula}-${fileTimestamp()}.png`)
      toast.success('已导出公式图片', { id: tid })
    } catch {
      toast.error('导出图片失败', { id: tid })
    }
  }
  return (
    <span ref={ref} className="group relative block">
      {children}
      <MediaActionBar
        onDetail={() => ctx.onDetail({ kind: 'formula', src: src(), lang: 'latex' })}
        onDownload={() => downloadMediaSrc('formula', src(), 'latex')}
        onExportPng={() => void handleExportPng()}
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

/** GFM 表格块：横向滚动容器 + 悬浮操作条（详情 / 下载 MD / 导出 PNG 图片）。 */
function TableBlock({
  node,
  children,
  ctx,
}: {
  node?: HastNode
  children: React.ReactNode
  ctx: MediaCtx
}) {
  const wrapRef = React.useRef<HTMLDivElement>(null)
  const md = hastTableToMarkdown(node)
  const detail = () => ctx.onDetail({ kind: 'table', src: md || reactNodeText(children), lang: 'table' })
  /** 表格元素 → 白底容器 → PNG（白底、2x，含表头底色与边框样式） */
  const handleExportPng = async () => {
    const tbl = wrapRef.current?.querySelector('table')
    if (!tbl) return
    const tid = toast.loading('正在生成图片…')
    try {
      await exportElementAsPng(tbl, `${MEDIA_KIND_LABEL.table}-${fileTimestamp()}.png`)
      toast.success('已导出表格图片', { id: tid })
    } catch {
      toast.error('导出图片失败', { id: tid })
    }
  }
  return (
    <div ref={wrapRef} className="group relative my-3 max-w-full">
      <div className="max-w-full overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
      {ctx.interactive && (
        <MediaActionBar
          onDetail={detail}
          onDownload={() => downloadMediaSrc('table', md, 'table')}
          onExportPng={() => void handleExportPng()}
          className="-top-2"
        />
      )}
    </div>
  )
}

/** 行内样式透传：react-markdown v10（hast-util-to-jsx-runtime）已把 hast 的
 * style 字符串转成对象 —— 对象直接透传；字符串（其他来源/旧链路）就地转换。 */
function inlineStyleProp(s: unknown): React.CSSProperties | undefined {
  if (typeof s === 'object' && s !== null) return s as React.CSSProperties
  if (typeof s !== 'string' || !s.trim()) return undefined
  const out: Record<string, string> = {}
  for (const part of s.split(';')) {
    const i = part.indexOf(':')
    if (i <= 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (!k || !v) continue
    out[k.startsWith('--') ? k : k.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = v
  }
  return Object.keys(out).length ? (out as React.CSSProperties) : undefined
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
    table: ({ node, children }) => (
      <TableBlock node={node as unknown as HastNode} ctx={ctx}>
        {children}
      </TableBlock>
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
    img: ({ src, alt }) => {
      const url = typeof src === 'string' ? src : ''
      const altText = alt ?? ''
      // 音视频引用占位（mediaRefPlaceholders 生成）→ 原生播放器卡片
      if (url && altText.startsWith('av-audio:')) {
        return <AudioBlock url={url} title={altText.slice('av-audio:'.length) || '音频'} ctx={ctx} />
      }
      if (url && altText.startsWith('av-video:')) {
        return <VideoBlock url={url} title={altText.slice('av-video:'.length) || '视频'} ctx={ctx} />
      }
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
    span: ({ className, style, children }) => {
      // KaTeX display 公式块（rehype-katex 输出 span.katex-display）→ 加详情/下载
      if (typeof className === 'string' && className.includes('katex-display')) {
        return <FormulaDisplayBlock ctx={ctx}>{children}</FormulaDisplayBlock>
      }
      // 行内样式透传（%%下划线/字色/字号%% 展开出的 <span style=…>）
      return (
        <span className={className} style={inlineStyleProp(style)}>
          {children}
        </span>
      )
    },
    pre: ({ node, children }) => {
      const el = node as unknown as HastNode | undefined
      const codeChild = firstElementChild(el)
      const classNames = Array.isArray(codeChild?.properties?.className)
        ? ((codeChild?.properties?.className as unknown[]) || []).join(' ')
        : ''
      // No <code> child (e.g. raw <pre>text</pre>): fall back to the whole
      // <pre>'s text so the copy button still grabs the real content instead
      // of an empty string.
      const raw = codeChild ? hastNodeText(codeChild) : hastNodeText(el)
      if (classNames.includes('language-mermaid')) {
        return <MermaidBlock code={raw} ctx={ctx} />
      }
      if (classNames.includes('language-svg')) {
        return <SvgFencedBlock code={raw} ctx={ctx} />
      }
      // ```html 围栏 → 沙盒渲染（不再作为纯代码块展示）
      if (classNames.includes('language-html')) {
        return <HtmlFencedBlock code={raw} ctx={ctx} />
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
      // Preserve the original className (hljs + language-X) so highlight.js
      // token CSS and the dark-mode overrides in globals.css actually apply —
      // dropping it made every fenced block render with default color and
      // looked like a flat mono blob ("显示成代码块").
      if (cls.includes('language-') || cls.includes('hljs') || reactNodeText(children).includes('\n')) {
        return <code className={cn('font-mono', cls)}>{children}</code>
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
  const stageRef = React.useRef<HTMLDivElement>(null)

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

  // ---- 详情态导出（mermaid / SVG / 表格 / 公式） ----
  const canExportVector = detail.kind === 'mermaid' || detail.kind === 'svg'
  const canExportPng = canExportVector || detail.kind === 'table' || detail.kind === 'formula'

  const handleExportSvg = () => {
    const el = stageRef.current?.querySelector('svg')
    if (!el) {
      toast.error('内容尚未渲染完成，请稍后再试')
      return
    }
    try {
      toast.success(`已导出 ${downloadSvgElement(el, MEDIA_KIND_LABEL[detail.kind])}`)
    } catch {
      toast.error('导出 SVG 失败')
    }
  }

  const handleExportPng = async () => {
    if (canExportVector) {
      const el = stageRef.current?.querySelector('svg')
      if (!el) {
        toast.error('内容尚未渲染完成，请稍后再试')
        return
      }
      const tid = toast.loading('正在生成 PNG…')
      try {
        const name = await downloadSvgElementAsPng(el, MEDIA_KIND_LABEL[detail.kind])
        toast.success(`已导出 ${name}`, { id: tid })
      } catch {
        toast.error('导出 PNG 失败', { id: tid })
      }
      return
    }
    // 表格 / 公式：克隆进白底容器 → html-to-image（公式强制深色文字，避免白底白字）
    const el =
      detail.kind === 'table'
        ? stageRef.current?.querySelector('table')
        : (stageRef.current?.querySelector('.katex-display') ?? stageRef.current?.querySelector('.katex'))
    if (!el) return
    const tid = toast.loading('正在生成图片…')
    try {
      await exportElementAsPng(el, `${MEDIA_KIND_LABEL[detail.kind]}-${fileTimestamp()}.png`, {
        color: detail.kind === 'formula' ? '#18181b' : undefined,
      })
      toast.success('已导出图片', { id: tid })
    } catch {
      toast.error('导出图片失败', { id: tid })
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
    case 'audio':
      content = (
        <div className="w-[92vw] max-w-md rounded-2xl bg-white p-5">
          <p className="mb-3 truncate text-center text-sm font-semibold text-zinc-900">
            {detail.alt || MEDIA_KIND_LABEL.audio}
          </p>
          <audio controls preload="metadata" src={detail.src} className="w-full" />
        </div>
      )
      break
    case 'video':
      content = (
        <video
          controls
          playsInline
          preload="metadata"
          src={detail.src}
          className="max-h-[72dvh] max-w-[92vw] rounded-xl bg-black"
        />
      )
      break
    case 'mermaid':
      content = (
        <div
          ref={stageRef}
          className="max-h-[76dvh] max-w-[92vw] overflow-auto rounded-xl bg-white p-4"
        >
          <RichContent content={'```mermaid\n' + detail.src + '\n```'} mediaInteractive={false} />
        </div>
      )
      break
    case 'svg':
      content = (
        <div ref={stageRef} className="max-h-[76dvh] max-w-[92vw] overflow-auto rounded-xl bg-white p-4">
          <RichContent content={'```svg\n' + detail.src + '\n```'} mediaInteractive={false} />
        </div>
      )
      break
    case 'html':
      content = (
        <div
          ref={stageRef}
          className="max-h-[76dvh] max-w-[94vw] overflow-auto rounded-xl bg-background p-4 text-foreground"
        >
          <RichContent content={'```html\n' + detail.src + '\n```'} mediaInteractive={false} />
        </div>
      )
      break
    case 'table':
      content = (
        <div
          ref={stageRef}
          className="max-h-[76dvh] max-w-[94vw] overflow-auto rounded-xl bg-background p-4 text-foreground"
        >
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
          {canExportPng && (
            <button
              type="button"
              aria-label="导出PNG"
              title="导出PNG"
              onClick={() => void handleExportPng()}
              className={ctrlBtn}
            >
              <ImageDown className="size-4" />
            </button>
          )}
          {canExportVector && (
            <button
              type="button"
              aria-label="导出SVG"
              title="导出SVG"
              onClick={handleExportSvg}
              className={ctrlBtn}
            >
              <FileDown className="size-4" />
            </button>
          )}
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
                {/* 先展开 %%样式|文字%% 指令（代码段内不动），再把音视频引用换成播放器占位
                    （img 组件映射渲染 audio/video），最后护住非数学的 $ 货币对 */}
                {guardDollarsOutsideCode(mediaRefPlaceholders(expandSpanDirectives(sub.value)))}
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
