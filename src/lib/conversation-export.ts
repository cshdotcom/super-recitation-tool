// conversation-export — AI 对话消息导出引擎（纯客户端）。
// 支持格式：
//   • md        Markdown（## 用户 / ## AI 分节；includeImages 嵌 dataURL；
//               mdMode 'source' 富媒体保留源码原样，'html' 时 mermaid/$$公式$$/
//               表格包成内联 HTML，如 <pre class="mermaid">）
//   • html      完整独立 HTML 文档（内嵌基础样式，对话气泡风，图片 dataURL 内嵌）
//   • txt       纯文本（[用户] / [AI]）
//   • pdf       隐藏 iframe 写入打印优化 HTML → window.print()（jsPDF 默认字体
//               不支持中文，此法最稳）
//   • image     html-to-image 渲染隐藏 DOM（复刻气泡样式，浅色固定主题）→ PNG 下载
//   • clipboard Markdown 文本复制到剪贴板
//   • json      结构化 JSON（不含 dataURL 本体，仅记录张数）
// 输入支持单对话消息数组或多对话分节（批量导出合并文档）。

import { toast } from 'sonner'

// ---------- 类型 ----------

export interface ExportMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** dataURL 图片（可选）。 */
  images?: string[]
  createdAt?: string
}

export interface ExportSection {
  /** 对话标题。 */
  title: string
  /** 对话类型（chat/analysis/...，仅展示用）。 */
  type?: string
  messages: ExportMessage[]
}

export type ExportFormat = 'md' | 'html' | 'txt' | 'pdf' | 'image' | 'clipboard' | 'json'

export interface ExportOpts {
  format: ExportFormat
  /** 是否包含图片（dataURL 内嵌）。 */
  includeImages: boolean
  /** MD 的富媒体形态：source=源码原样 / html=包成内联 HTML。 */
  mdMode: 'source' | 'html'
}

export const EXPORT_FORMAT_META: {
  value: ExportFormat
  label: string
  ext: string
}[] = [
  { value: 'md', label: 'Markdown', ext: 'md' },
  { value: 'html', label: 'HTML', ext: 'html' },
  { value: 'txt', label: 'TXT', ext: 'txt' },
  { value: 'pdf', label: 'PDF', ext: 'html' },
  { value: 'image', label: '图片', ext: 'png' },
  { value: 'clipboard', label: '剪贴板', ext: '' },
  { value: 'json', label: 'JSON', ext: 'json' },
]

// ---------- 基础工具 ----------

/** 文件名安全化（去非法字符，限长）。 */
export function safeFileName(t: string): string {
  const s = (t || '对话').replace(/[\\/:*?"<>|\n\r\t]/g, '_').trim()
  return s.slice(0, 50) || '对话'
}

/** 触发浏览器下载文本文件。 */
export function downloadTextFile(
  filename: string,
  text: string,
  mime = 'text/plain',
): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function ts(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN', { hour12: false })
}

function roleZh(role: 'user' | 'assistant'): string {
  return role === 'user' ? '用户' : 'AI'
}

function normalizeSections(
  input: ExportMessage[] | ExportSection[],
): { single: boolean; sections: ExportSection[] } {
  if (Array.isArray(input) && input.length > 0 && 'messages' in input[0]) {
    return { single: false, sections: input as ExportSection[] }
  }
  // 单对话消息数组 → 包装成一个 section
  return {
    single: true,
    sections: [{ title: '', messages: (input as ExportMessage[]) ?? [] }],
  }
}

// ---------- MD 富媒体 → 内联 HTML（mdMode='html'） ----------

/** MD 表格行解析：`| a | b |` → ['a','b']。 */
function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-') && line.includes('|')
}

/** MD 表格 → <table> HTML（单元格内容原样，用于 mdMode='html' 的 MD 导出）。 */
function mdTableToHtml(lines: string[]): string {
  const rows = lines.map(splitTableRow).filter((r) => r.some((c) => c.length > 0))
  if (rows.length === 0) return lines.join('\n')
  const [head, ...body] = rows
  const th = head.map((c) => `<th>${c}</th>`).join('')
  const trs = body
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')
  return `<table>\n<thead>\n<tr>${th}</tr>\n</thead>\n<tbody>\n${trs}\n</tbody>\n</table>`
}

/**
 * mdMode='html'：把富媒体块包成内联 HTML——
 *   • ```mermaid 围栏 → <pre class="mermaid">（mermaid.js 标准容器）
 *   • 块级 $$公式$$ → <div class="math-block">（保留 $$ 定界符，KaTeX 兼容）
 *   • MD 表格 → <table>
 * 其余内容原样保留（mdMode='source' 时全文原样）。
 */
export function richBlocksToInlineHtml(md: string): string {
  const lines = md.split(/\r?\n/)
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // ```mermaid 围栏
    const fence = line.match(/^\s*```mermaid\s*$/)
    if (fence) {
      const buf: string[] = []
      i += 1
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i])
        i += 1
      }
      i += 1 // 跳过结束围栏
      out.push('<pre class="mermaid">')
      out.push(...buf)
      out.push('</pre>')
      continue
    }
    // 块级 $$ 公式（成对）
    if (/^\s*\$\$/.test(line) && !/\$\$\s*\$\$/.test(line)) {
      const single = line.trim().endsWith('$$') && line.trim().length > 4
      if (single) {
        out.push(`<div class="math-block">${line.trim()}</div>`)
        i += 1
        continue
      }
      const buf: string[] = [line]
      i += 1
      while (i < lines.length && !/\$\$\s*$/.test(lines[i])) {
        buf.push(lines[i])
        i += 1
      }
      if (i < lines.length) {
        buf.push(lines[i])
        i += 1
      }
      out.push('<div class="math-block">')
      out.push(...buf)
      out.push('</div>')
      continue
    }
    // MD 表格（当前行 | 开头 + 下一行是分隔行）
    if (
      line.trim().startsWith('|') &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const buf: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        buf.push(lines[i])
        i += 1
      }
      out.push(mdTableToHtml(buf))
      continue
    }
    out.push(line)
    i += 1
  }
  return out.join('\n')
}

// ---------- Markdown ----------

export function messagesToMarkdown(
  input: ExportMessage[] | ExportSection[],
  opts: Pick<ExportOpts, 'includeImages' | 'mdMode'>,
  docTitle?: string,
): string {
  const { single, sections } = normalizeSections(input)
  const now = new Date().toLocaleString('zh-CN', { hour12: false })
  const lines: string[] = []

  if (single) {
    const sec = sections[0]
    lines.push(`# ${docTitle || sec.title || 'AI 对话'}`)
    lines.push('')
    if (sec.type) lines.push(`- 类型：${sec.type}`)
    lines.push(`- 导出时间：${now}`)
    lines.push('')
    lines.push('---')
    lines.push('')
  } else {
    lines.push(`# ${docTitle || `AI 对话导出（${sections.length} 个）`}`)
    lines.push('')
    lines.push(`- 导出时间：${now}`)
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  for (const sec of sections) {
    if (!single) {
      lines.push(`## ${sec.title || '未命名对话'}`)
      lines.push('')
    }
    const msgHead = single ? '##' : '###'
    for (const m of sec.messages) {
      const time = m.createdAt ? `（${ts(m.createdAt)}）` : ''
      lines.push(`${msgHead} ${roleZh(m.role)}${time}`)
      lines.push('')
      const body =
        opts.mdMode === 'html' ? richBlocksToInlineHtml(m.content) : m.content
      lines.push(body.trim() || '（无文字内容）')
      if (opts.includeImages && m.images && m.images.length > 0) {
        lines.push('')
        m.images.forEach((src, idx) => {
          lines.push(`![附图 ${idx + 1}](${src})`)
        })
      }
      lines.push('')
    }
    if (!single) {
      lines.push('---')
      lines.push('')
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

// ---------- TXT ----------

export function messagesToText(
  input: ExportMessage[] | ExportSection[],
  docTitle?: string,
): string {
  const { single, sections } = normalizeSections(input)
  const lines: string[] = []
  const head = docTitle || (single ? sections[0].title : '') || 'AI 对话'
  lines.push(head)
  lines.push(`导出时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`)
  lines.push('')
  for (const sec of sections) {
    if (!single) {
      lines.push(`========== ${sec.title || '未命名对话'} ==========`)
      lines.push('')
    }
    for (const m of sec.messages) {
      lines.push(`[${roleZh(m.role)}]`)
      lines.push(m.content.trim() || '（无文字内容）')
      if (m.images && m.images.length > 0) {
        lines.push(`（附图 ${m.images.length} 张）`)
      }
      lines.push('')
    }
  }
  return lines.join('\n').trim() + '\n'
}

// ---------- JSON ----------

export function messagesToJson(input: ExportMessage[] | ExportSection[]): string {
  const { single, sections } = normalizeSections(input)
  return JSON.stringify(
    {
      title: single ? sections[0].title || 'AI 对话' : `AI 对话导出（${sections.length} 个）`,
      exportedAt: new Date().toISOString(),
      conversations: sections.map((sec) => ({
        title: sec.title,
        type: sec.type ?? '',
        messages: sec.messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.images && m.images.length > 0 ? { imageCount: m.images.length } : {}),
          createdAt: m.createdAt ?? '',
        })),
      })),
    },
    null,
    2,
  )
}

// ---------- 轻量 Markdown → HTML（HTML/PDF/图片 共用） ----------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 行内 markdown → HTML（code/bold/italic/link；内容先转义，安全）。 */
function inlineMd(s: string): string {
  let t = escapeHtml(s)
  // 行内代码先保护
  const codes: string[] = []
  t = t.replace(/`([^`\n]+)`/g, (_m, c: string) => {
    codes.push(c)
    return `\u0000${codes.length - 1}\u0000`
  })
  // 图片 ![alt](src)
  t = t.replace(
    /!\[([^\]]*)\]\(([^)\s]+)\)/g,
    (_m, alt: string, src: string) =>
      `<img src="${src}" alt="${alt}" style="max-width:100%;border-radius:8px" />`,
  )
  // 链接 [text](url)
  t = t.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, txt: string, href: string) =>
      `<a href="${href}" target="_blank" rel="noreferrer">${txt}</a>`,
  )
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${codes[Number(i)]}</code>`)
  return t
}

/** 轻量 markdown 块级 → HTML（标题/列表/引用/代码块/表格/公式/段落）。 */
function mdToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  let para: string[] = []
  const flushPara = () => {
    if (para.length > 0) {
      out.push(`<p>${inlineMd(para.join('<br />'))}</p>`)
      para = []
    }
  }
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      flushPara()
      i += 1
      continue
    }
    // 代码围栏
    const fence = line.match(/^\s*```([a-zA-Z0-9_-]*)\s*$/)
    if (fence) {
      flushPara()
      const lang = fence[1]
      const buf: string[] = []
      i += 1
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i])
        i += 1
      }
      i += 1
      if (lang === 'mermaid') {
        out.push(
          `<pre class="mermaid" style="background:#f6f8fa;border:1px solid #e5e7eb;border-radius:10px;padding:12px;overflow-x:auto;font-size:12px;line-height:1.6">${escapeHtml(buf.join('\n'))}</pre>`,
        )
      } else {
        out.push(
          `<pre style="background:#f6f8fa;border:1px solid #e5e7eb;border-radius:10px;padding:12px;overflow-x:auto;font-size:12.5px;line-height:1.65"><code>${escapeHtml(buf.join('\n'))}</code></pre>`,
        )
      }
      continue
    }
    // 块级公式
    if (/^\s*\$\$/.test(line)) {
      flushPara()
      const buf: string[] = [line.trim()]
      const closed = line.trim().endsWith('$$') && line.trim().length > 4
      i += 1
      if (!closed) {
        while (i < lines.length && !/\$\$\s*$/.test(lines[i])) {
          buf.push(lines[i].trim())
          i += 1
        }
        if (i < lines.length) {
          buf.push(lines[i].trim())
          i += 1
        }
      }
      out.push(
        `<div class="math-block" style="text-align:center;padding:8px 0;font-family:'Times New Roman',STIX Two Math,serif;font-size:15px">${escapeHtml(buf.join(' ')).replace(/\$\$/g, '')}</div>`,
      )
      continue
    }
    // 标题
    const head = line.match(/^(#{1,6})\s+(.*)$/)
    if (head) {
      flushPara()
      const lv = head[1].length
      out.push(`<h${lv}>${inlineMd(head[2])}</h${lv}>`)
      i += 1
      continue
    }
    // 分隔线
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flushPara()
      out.push('<hr />')
      i += 1
      continue
    }
    // 引用
    if (/^\s*>\s?/.test(line)) {
      flushPara()
      const buf: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''))
        i += 1
      }
      out.push(
        `<blockquote style="margin:8px 0;padding:6px 12px;border-left:3px solid #10b981;background:#ecfdf5;color:#065f46;border-radius:0 8px 8px 0">${inlineMd(buf.join('<br />'))}</blockquote>`,
      )
      continue
    }
    // 表格
    if (
      line.trim().startsWith('|') &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      flushPara()
      const buf: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        buf.push(lines[i])
        i += 1
      }
      out.push(mdTableToHtml2(buf))
      continue
    }
    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara()
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
        i += 1
      }
      out.push(
        `<ul style="margin:6px 0;padding-left:22px">${items.map((it) => `<li>${inlineMd(it)}</li>`).join('')}</ul>`,
      )
      continue
    }
    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushPara()
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''))
        i += 1
      }
      out.push(
        `<ol style="margin:6px 0;padding-left:22px">${items.map((it) => `<li>${inlineMd(it)}</li>`).join('')}</ol>`,
      )
      continue
    }
    para.push(line)
    i += 1
  }
  flushPara()
  return out.join('\n')
}

/** MD 表格（已 inline 转义的行）→ <table>。 */
function mdTableToHtml2(lines: string[]): string {
  const rows = lines.map(splitTableRow)
  const [head, ...body] = rows
  const th = head.map((c) => `<th>${inlineMd(c)}</th>`).join('')
  const trs = body.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('')
  return `<table style="border-collapse:collapse;margin:8px 0;width:100%;font-size:13px"><thead><tr style="background:#f0fdf4">${th}</tr></thead><tbody>${trs}</tbody></table>`
    .replace(/<th>/g, '<th style="border:1px solid #d1d5db;padding:6px 10px;text-align:left">')
    .replace(/<td>/g, '<td style="border:1px solid #d1d5db;padding:6px 10px">')
}

// ---------- HTML 文档 ----------

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans CJK SC',sans-serif"

/**
 * 完整独立 HTML 文档（内嵌样式，气泡风）。
 * variant：screen=浏览器查看 / print=打印(PDF) / image=图片渲染（固定宽度浅色）。
 */
export function messagesToHtmlDoc(
  input: ExportMessage[] | ExportSection[],
  opts: Pick<ExportOpts, 'includeImages'>,
  variant: 'screen' | 'print' | 'image' = 'screen',
  docTitle?: string,
): string {
  const { single, sections } = normalizeSections(input)
  const title = docTitle || (single ? sections[0].title : `AI 对话导出（${sections.length} 个）`) || 'AI 对话'
  const width = variant === 'image' ? '720px' : 'max-width:720px'
  const bodyBg = variant === 'image' ? '#ffffff' : '#f8fafc'
  const printCss =
    variant === 'print'
      ? `@page { size: auto; margin: 14mm; }
         body { background: #fff !important; }
         .msg { break-inside: avoid; page-break-inside: avoid; }`
      : ''
  const parts: string[] = []
  for (const sec of sections) {
    if (!single) {
      parts.push(
        `<h2 style="margin:26px 0 10px;font-size:19px;border-left:4px solid #10b981;padding-left:10px">${escapeHtml(sec.title || '未命名对话')}</h2>`,
      )
    }
    for (const m of sec.messages) {
      const isUser = m.role === 'user'
      const time = m.createdAt ? ts(m.createdAt) : ''
      const imgs =
        opts.includeImages && m.images && m.images.length > 0
          ? `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">${m.images
              .map(
                (src) =>
                  `<img src="${src}" alt="附图" style="max-width:180px;border-radius:10px;border:1px solid rgba(0,0,0,.08)" />`,
              )
              .join('')}</div>`
          : ''
      parts.push(
        `<div class="msg" style="display:flex;flex-direction:column;align-items:${isUser ? 'flex-end' : 'flex-start'};margin:14px 0">` +
          `<div style="max-width:86%;padding:10px 14px;border-radius:16px;line-height:1.75;font-size:14.5px;${
            isUser
              ? 'background:#10b981;color:#fff;border-bottom-right-radius:6px'
              : 'background:#ffffff;color:#1f2937;border:1px solid #e5e7eb;border-bottom-left-radius:6px'
          }">` +
          mdToHtml(m.content) +
          imgs +
          `</div>` +
          (time
            ? `<span style="font-size:11px;color:#94a3b8;margin-top:4px">${isUser ? '用户' : 'AI'} · ${time}</span>`
            : '') +
          `</div>`,
      )
    }
  }
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0;padding:24px 16px;background:${bodyBg};color:#1f2937;font-family:${FONT_STACK}; }
  main { ${width};margin:0 auto; }
  h1 { font-size:22px;margin:0 0 4px; }
  .meta { font-size:12px;color:#64748b;margin-bottom:18px; }
  a { color:#059669; }
  p { margin:6px 0;white-space:pre-wrap;word-break:break-word; }
  h1,h2,h3,h4,h5,h6 { line-height:1.5; }
  ${printCss}
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">导出时间：${new Date().toLocaleString('zh-CN', { hour12: false })} · 由背书吧导出</p>
  ${parts.join('\n')}
</main>
</body>
</html>`
}

// ---------- PDF（iframe 打印） ----------

async function exportAsPdf(html: string): Promise<void> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe')
    iframe.setAttribute('aria-hidden', 'true')
    iframe.style.cssText =
      'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;'
    document.body.appendChild(iframe)
    let done = false
    const cleanup = () => {
      if (done) return
      done = true
      iframe.remove()
      resolve()
    }
    iframe.onload = () => {
      // 等待图片加载完成再打印
      const win = iframe.contentWindow
      if (!win) {
        cleanup()
        return
      }
      const imgs = Array.from(win.document.images)
      const waitAll = () =>
        Promise.all(
          imgs.map((im) =>
            im.complete
              ? undefined
              : new Promise<void>((r) => {
                  im.addEventListener('load', () => r(), { once: true })
                  im.addEventListener('error', () => r(), { once: true })
                }),
          ),
        )
      void waitAll().then(() => {
        win.focus()
        win.print()
        // 打印对话框关闭时间不定，延迟清理（部分浏览器打印中移除会取消）
        window.setTimeout(cleanup, 120_000)
        win.addEventListener('afterprint', () => window.setTimeout(cleanup, 800), { once: true })
      })
    }
    iframe.srcdoc = html
  })
}

// ---------- 图片（html-to-image） ----------

async function exportAsImage(html: string, filename: string): Promise<void> {
  const { toPng } = await import('html-to-image')
  // 隐藏离屏容器：固定 720px 宽浅色主题，复刻气泡样式
  const holder = document.createElement('div')
  holder.setAttribute('aria-hidden', 'true')
  holder.style.cssText =
    'position:fixed;left:-99999px;top:0;width:720px;background:#ffffff;pointer-events:none;'
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const main = doc.querySelector('main')
  if (!main) throw new Error('渲染导出内容失败')
  holder.appendChild(main)
  document.body.appendChild(holder)
  try {
    // 等待图片解码
    const imgs = Array.from(holder.querySelectorAll('img'))
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
    const dataUrl = await toPng(holder, {
      pixelRatio: 2,
      backgroundColor: '#ffffff',
      skipFonts: true,
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

// ---------- mermaid 预渲染（HTML / PDF / 图片 导出增强） ----------

/**
 * 把导出 HTML 中的 `<pre class="mermaid">源码</pre>` 用 mermaid.render 渲染成
 * 内联 svg（居中白底容器包裹；渲染失败的块保留源码原文，绝不丢内容）。
 * 导出 HTML/PDF/图片 前调用，保证收到的文档无需外部脚本即可看到图。
 */
async function renderMermaidBlocksInHtml(html: string): Promise<string> {
  if (!html.includes('class="mermaid"')) return html
  const mermaid = (await import('mermaid')).default
  mermaid.initialize({
    startOnLoad: false,
    theme: 'neutral',
    securityLevel: 'strict',
    flowchart: { htmlLabels: false },
  })
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const pres = Array.from(doc.querySelectorAll('pre.mermaid'))
  let seq = 0
  for (const pre of pres) {
    const code = (pre.textContent ?? '').trim()
    if (!code) continue
    try {
      seq += 1
      const { svg } = await mermaid.render(`conv-export-mermaid-${seq}`, code)
      const wrap = doc.createElement('div')
      wrap.setAttribute(
        'style',
        'text-align:center;background:#f6f8fa;border:1px solid #e5e7eb;border-radius:10px;padding:12px;overflow-x:auto',
      )
      wrap.innerHTML = svg
      pre.replaceWith(wrap)
    } catch {
      // 渲染失败：保留源码块（导出不中断）
    }
  }
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`
}

// ---------- 主入口 ----------

/**
 * 导出消息（数组=单对话 / 分节=多对话合并文档）。
 * @param baseName 文件名基础（不含扩展名）
 */
export async function exportMessages(
  input: ExportMessage[] | ExportSection[],
  opts: ExportOpts,
  baseName = 'AI对话',
): Promise<void> {
  const hasAny = Array.isArray(input) && input.length > 0
  if (!hasAny) {
    toast.error('没有可导出的消息')
    return
  }
  const name = safeFileName(baseName)
  try {
    switch (opts.format) {
      case 'md':
        downloadTextFile(
          `${name}.md`,
          messagesToMarkdown(input, opts),
          'text/markdown',
        )
        toast.success('已导出 Markdown')
        break
      case 'html': {
        const html = await renderMermaidBlocksInHtml(messagesToHtmlDoc(input, opts, 'screen'))
        downloadTextFile(`${name}.html`, html, 'text/html')
        toast.success('已导出 HTML')
        break
      }
      case 'txt':
        downloadTextFile(`${name}.txt`, messagesToText(input), 'text/plain')
        toast.success('已导出 TXT')
        break
      case 'json':
        downloadTextFile(`${name}.json`, messagesToJson(input), 'application/json')
        toast.success('已导出 JSON')
        break
      case 'pdf': {
        const tid = toast.loading('正在准备打印…')
        await exportAsPdf(await renderMermaidBlocksInHtml(messagesToHtmlDoc(input, opts, 'print')))
        toast.dismiss(tid)
        break
      }
      case 'image': {
        const tid = toast.loading('正在生成图片…')
        await exportAsImage(
          await renderMermaidBlocksInHtml(messagesToHtmlDoc(input, opts, 'image')),
          `${name}.png`,
        )
        toast.success('已导出图片', { id: tid })
        break
      }
      case 'clipboard': {
        const md = messagesToMarkdown(input, { ...opts, includeImages: false })
        await navigator.clipboard.writeText(md)
        toast.success('已复制到剪贴板')
        break
      }
    }
  } catch (err) {
    toast.error('导出失败：' + (err instanceof Error ? err.message : '未知错误'))
  }
}
