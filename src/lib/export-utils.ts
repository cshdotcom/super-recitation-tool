'use client'

// 通用导出工具库（背书吧）
// 提供 TXT / Markdown / HTML / 打印导出 PDF / JSON 备份等导出方式，
// 全部为纯函数（仅下载/打印时使用 DOM API），可被任意客户端组件复用。
//
// 中文零乱码策略：
//   - TXT ：UTF-8 + BOM（\uFEFF 前缀），Windows 记事本直接打开不乱码
//   - HTML：完整独立文档（<!DOCTYPE html> + <meta charset="utf-8">），
//           图片（markdown dataURL 与 /api/upload/ 引用）均保留为 <img>
//   - 打印/PDF：浏览器原生打印（用户选「另存为 PDF」），中文由系统字体渲染，
//           不引入 jsPDF 内嵌 CJK 字体方案，天然零乱码
//   - Markdown / JSON：标准 UTF-8

/** 记忆素材问答块（与 MaterialBlock 兼容） */
export interface ExportBlock {
  /** 核心论点（正面） */
  front: string
  /** 完整内容（背面） */
  back: string
  /** 已隐藏（折叠不显示） */
  hidden?: boolean
}

/** 可导出的卡片对象（CardData 的宽松子集，blocks 兼容数组或 JSON 字符串） */
export interface ExportCard {
  id?: string
  title?: string | null
  content?: string | null
  /** 记忆素材问答块；兼容数组或 JSON 字符串两种存储形态 */
  blocks?: ExportBlock[] | string | null
  createdAt?: string | null
  updatedAt?: string | null
}

/** 构建打印/HTML 文档时的可选项 */
export interface BuildHtmlOptions {
  /** 写入 iframe 后自动调起浏览器打印窗口（打印·导出 PDF 用） */
  autoPrint?: boolean
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/** 文件名安全化：去掉文件系统非法字符（/ \ : * ? " < > |）与控制符。 */
export function safeFilename(name: string | null | undefined): string {
  const cleaned = (name ?? '')
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  return cleaned || '背书卡'
}

/** 触发浏览器下载（a[download]）。 */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Safari 需要给下载留一点时间，延迟回收 objectURL
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** blocks 归一化：接受数组或 JSON 字符串，过滤非法项。 */
function normalizeBlocks(card: ExportCard): ExportBlock[] {
  const raw: unknown = card.blocks
  let list: unknown = raw
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(list)) return []
  const out: ExportBlock[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const b = item as Partial<ExportBlock>
    if (typeof b.front !== 'string' && typeof b.back !== 'string') continue
    out.push({ front: b.front ?? '', back: b.back ?? '', hidden: !!b.hidden })
  }
  return out
}

/** 中文日期（2025 年 6 月 1 日）；非法日期回退为当前时间。 */
function fmtDate(d?: string | null): string {
  const parsed = d ? new Date(d) : new Date()
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

/** 纯文本导出时，图片 markdown 语法换成全角占位符（dataURL 太长会污染文本）。 */
function imageToTextPlaceholder(src: string): string {
  return src.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m: string, alt: string) =>
    alt.trim() ? `［图片：${alt.trim()}］` : '［图片］',
  )
}

// ---------------------------------------------------------------------------
// Markdown → HTML（轻量 GFM 子集渲染，无外部依赖）
// 支持：标题/围栏代码/行内代码/粗斜体/删除线/链接/图片/引用/有序无序列表/
//       表格/分隔线/段落换行。图片 dataURL 与 /api/upload/ 引用均保留。
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 图片地址规范化：站内相对路径（/api/upload/…）补全为绝对地址，下载后的 HTML 里也能加载。 */
function normalizeImgSrc(src: string): string {
  if (/^(https?:|data:)/i.test(src)) return src
  if (src.startsWith('/') && typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin + src
  }
  return src
}

/** 行内元素渲染。输入必须是「已做 HTML 转义」的文本。 */
function renderInline(escaped: string): string {
  // 1. 先保护行内代码，避免代码内容被其它行内语法改写
  const codeSpans: string[] = []
  let out = escaped.replace(/`([^`]+)`/g, (_m: string, code: string) => {
    codeSpans.push(`<code>${code}</code>`)
    return `\u0000C${codeSpans.length - 1}\u0000`
  })
  // 2. 图片 ![alt](src)（必须先于链接，否则 ![..](..) 会被链接规则误吞）
  out = out.replace(
    /!\[([^\]]*)\]\(\s*([^)\s]+)\s*(?:&quot;[^&]*&quot;)?\s*\)/g,
    (_m: string, alt: string, src: string) => `<img alt="${alt}" src="${normalizeImgSrc(src)}"/>`,
  )
  // 3. 链接 [text](href)
  out = out.replace(
    /\[([^\]]+)\]\(\s*([^)\s]+)\s*(?:&quot;[^&]*&quot;)?\s*\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
  )
  // 4. 粗体 / 斜体 / 粗斜体 / 删除线
  out = out
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w\\])__([^_\n]+)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/(^|[^\w\\])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  // 5. 还原行内代码
  out = out.replace(/\u0000C(\d+)\u0000/g, (_m: string, i: string) => codeSpans[Number(i)] ?? '')
  return out
}

/** 表格分隔行：仅由 空白/竖线/冒号/短横线 组成，且同时含 - 和 |。 */
function isTableSeparator(line: string): boolean {
  return /^[\s|:-]+$/.test(line) && line.includes('-') && line.includes('|')
}

/** 块级 Markdown 渲染（可递归，用于引用块）。 */
function renderMarkdown(src: string): string {
  const lines = (src || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .split('\n')
  const html: string[] = []
  const n = lines.length
  let i = 0

  while (i < n) {
    const line = lines[i]

    // 空行
    if (!line.trim()) {
      i++
      continue
    }

    // 围栏代码块 ``` / ~~~
    const fence = line.match(/^\s*(```+|~~~+)\s*(.*)$/)
    if (fence) {
      const lang = fence[2].trim().replace(/[^a-zA-Z0-9_+-]/g, '')
      const buf: string[] = []
      i++
      while (i < n && !/^\s*(```+|~~~+)/.test(lines[i])) {
        buf.push(lines[i])
        i++
      }
      i++ // 跳过收尾围栏
      html.push(
        `<pre><code${lang ? ` class="language-${lang}"` : ''}>${escapeHtml(buf.join('\n'))}</code></pre>`,
      )
      continue
    }

    // 标题 # ~ ######
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2].trim()))}</h${level}>`)
      i++
      continue
    }

    // 分隔线 --- *** ___
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      html.push('<hr/>')
      i++
      continue
    }

    // 表格（当前行含 |，下一行是分隔行）
    if (line.includes('|') && i + 1 < n && isTableSeparator(lines[i + 1])) {
      const cells = (row: string): string[] =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim())
      const head = cells(line)
      i += 2
      const bodyRows: string[][] = []
      while (i < n && lines[i].trim() && lines[i].includes('|') && !isTableSeparator(lines[i])) {
        bodyRows.push(cells(lines[i]))
        i++
      }
      html.push(
        `<table><thead><tr>${head
          .map((c) => `<th>${renderInline(escapeHtml(c))}</th>`)
          .join('')}</tr></thead><tbody>${bodyRows
          .map((r) => `<tr>${r.map((c) => `<td>${renderInline(escapeHtml(c))}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      )
      continue
    }

    // 引用块 >（递归渲染，支持嵌套）
    if (/^\s*>/.test(line)) {
      const buf: string[] = []
      while (i < n && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      html.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`)
      continue
    }

    // 列表（有序 / 无序，扁平一层）
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line)
      const items: string[] = []
      while (i < n && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''))
        i++
      }
      const tag = ordered ? 'ol' : 'ul'
      html.push(`<${tag}>${items.map((it) => `<li>${renderInline(escapeHtml(it))}</li>`).join('')}</${tag}>`)
      continue
    }

    // 段落：连续收集到空行 / 其它块级语法为止，段内单个换行渲染为 <br/>
    const para: string[] = [line]
    i++
    while (i < n) {
      const cur = lines[i]
      if (!cur.trim()) break
      if (/^\s*(```|~~~|#{1,6}\s|>)/.test(cur)) break
      if (/^\s*([-*+]|\d+[.)])\s+/.test(cur)) break
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(cur)) break
      if (cur.includes('|') && i + 1 < n && isTableSeparator(lines[i + 1])) break
      para.push(cur)
      i++
    }
    html.push(`<p>${renderInline(escapeHtml(para.join('\n'))).replace(/\n/g, '<br/>')}</p>`)
  }
  return html.join('\n')
}

// ---------------------------------------------------------------------------
// TXT 导出
// ---------------------------------------------------------------------------

/** 导出 TXT（UTF-8 + BOM，Windows 记事本零乱码）。返回所用文件名。 */
export function exportCardTxt(card: ExportCard): string {
  const title = (card.title ?? '').trim() || '未命名背诵'
  const content = (card.content ?? '').trim()
  const blocks = normalizeBlocks(card).filter((b) => b.front.trim() || b.back.trim())

  const lines: string[] = [title, '='.repeat(24), '']
  if (content) {
    lines.push(imageToTextPlaceholder(content), '')
  }
  if (blocks.length) {
    lines.push('─'.repeat(24), '记忆素材', '─'.repeat(24), '')
    blocks.forEach((b, idx) => {
      if (b.front.trim()) lines.push(`【问 ${idx + 1}】${b.front.trim()}`)
      if (b.back.trim()) lines.push(`【答】${imageToTextPlaceholder(b.back.trim())}`)
      lines.push('')
    })
  }
  lines.push('——', `导出自「背书吧」 · ${fmtDate(card.updatedAt ?? card.createdAt)}`)

  const text = `\uFEFF${lines.join('\n')}\n`
  const filename = `${safeFilename(card.title)}.txt`
  downloadBlob(filename, new Blob([text], { type: 'text/plain;charset=utf-8' }))
  return filename
}

// ---------------------------------------------------------------------------
// Markdown 导出
// ---------------------------------------------------------------------------

/** 导出 Markdown（与超级编辑器导出格式对齐且为其超集：含标题/正文/记忆素材/页脚）。 */
export function exportCardMarkdown(card: ExportCard): string {
  const title = (card.title ?? '').trim() || '未命名背诵'
  const content = (card.content ?? '').trim()
  const blocks = normalizeBlocks(card).filter((b) => b.front.trim() || b.back.trim())

  const out: string[] = [`# ${title}`, '']
  if (content) out.push(content, '')
  if (blocks.length) {
    out.push('---', '', `## 记忆素材（${blocks.length} 条）`, '')
    blocks.forEach((b, idx) => {
      if (idx > 0) out.push('---', '')
      if (b.front.trim()) out.push(`**${b.front.trim()}**`, '')
      if (b.back.trim()) out.push(b.back.trim(), '')
    })
    out.push('')
  }
  out.push('---', '', `> 导出自「背书吧」 · ${fmtDate(card.updatedAt ?? card.createdAt)}`)

  const filename = `${safeFilename(card.title)}.md`
  downloadBlob(
    filename,
    new Blob([`${out.join('\n')}\n`], { type: 'text/markdown;charset=utf-8' }),
  )
  return filename
}

// ---------------------------------------------------------------------------
// HTML 导出 / 打印导出 PDF
// ---------------------------------------------------------------------------

const DOC_STYLES = `* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: #f5f5f2;
  color: #26262a;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', 'WenQuanYi Micro Hei', sans-serif;
  font-size: 17px;
  line-height: 1.9;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 720px; margin: 0 auto; padding: 56px 28px 44px; background: #ffffff; min-height: 100vh; }
h1.title { margin: 0 0 10px; font-size: 1.7em; line-height: 1.45; font-weight: 700; text-align: center; }
p.meta { margin: 0 0 42px; text-align: center; font-size: 13px; color: #9a9aa0; }
.content h1, .content h2, .content h3, .content h4, .content h5, .content h6 { margin: 1.5em 0 0.6em; line-height: 1.5; font-weight: 700; }
.content h1 { font-size: 1.4em; }
.content h2 { font-size: 1.25em; }
.content h3 { font-size: 1.12em; }
.content h4, .content h5, .content h6 { font-size: 1em; }
.content p { margin: 0 0 1.15em; }
img { max-width: 100%; height: auto; border-radius: 10px; margin: 6px 0; }
a { color: #0e9f6e; }
ul, ol { margin: 0 0 1.15em; padding-left: 1.8em; }
li { margin: 0.35em 0; }
hr { border: 0; border-top: 1px solid #e6e6e0; margin: 2.2em auto; width: 55%; }
code { font-family: ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, 'Courier New', monospace; background: #f2f2ee; border-radius: 5px; padding: 2px 6px; font-size: 0.86em; }
pre { background: #f6f6f2; border: 1px solid #e6e6e0; border-radius: 12px; padding: 14px 18px; overflow-x: auto; line-height: 1.65; font-size: 0.86em; }
pre code { background: none; border: 0; padding: 0; font-size: 1em; }
blockquote { margin: 1.2em 0; padding: 2px 18px; border-left: 4px solid #d8d8d0; border-radius: 0 10px 10px 0; background: #fafaf6; color: #55555c; }
table { border-collapse: collapse; width: 100%; margin: 1.3em 0; font-size: 0.92em; }
th, td { border: 1px solid #dcdcd4; padding: 8px 12px; text-align: left; vertical-align: top; }
th { background: #f2f2ec; font-weight: 600; }
section.blocks { margin-top: 52px; }
section.blocks > h2 { font-size: 1.22em; text-align: center; letter-spacing: 0.2em; margin: 0 0 26px; font-weight: 700; }
.qa { border: 1px solid #e6e6e0; border-radius: 14px; background: #fdfdfb; padding: 16px 20px; margin: 0 0 14px; page-break-inside: avoid; break-inside: avoid; }
.qa > h3 { margin: 0 0 10px; font-size: 1.02em; color: #0b7a5b; font-weight: 700; }
.qa .back p { margin: 0 0 0.85em; }
footer.doc-footer { margin-top: 56px; padding-top: 18px; border-top: 1px solid #e6e6e0; text-align: center; color: #a0a0a6; font-size: 12.5px; }
.print-btn {
  position: fixed; top: 20px; right: 20px; z-index: 99;
  border: 0; border-radius: 999px; background: #0e9f6e; color: #ffffff;
  font-family: inherit; font-size: 14px; font-weight: 600; padding: 10px 20px;
  cursor: pointer; box-shadow: 0 6px 18px rgba(14, 159, 110, 0.35);
}
.print-btn:hover { background: #0b7a5b; }
@media print {
  @page { margin: 18mm 16mm; }
  html, body { background: #ffffff; }
  body { font-size: 12pt; }
  .wrap { max-width: none; padding: 0; min-height: auto; }
  .no-print { display: none !important; }
  .qa { background: none; }
  pre, blockquote, table, .qa, img { page-break-inside: avoid; break-inside: avoid; }
  h1, h2, h3 { page-break-after: avoid; break-after: avoid; }
  a { color: inherit; text-decoration: none; }
}`

/**
 * 构建完整独立 HTML 文档字符串（<!DOCTYPE html> + charset + viewport + 内嵌样式）。
 * 正文 Markdown 渲染（图片/代码块/表格/引用/列表），blocks 渲染为问答卡片，
 * 所有文本均正确转义 HTML 实体；含 no-print 打印按钮与 @media print 打印规则。
 */
export function buildCardHtml(card: ExportCard, opts: BuildHtmlOptions = {}): string {
  const title = (card.title ?? '').trim() || '未命名背诵'
  const content = (card.content ?? '').trim()
  const blocks = normalizeBlocks(card).filter((b) => b.front.trim() || b.back.trim())
  const charCount = (content + blocks.map((b) => `${b.front}${b.back}`).join('')).replace(/\s/g, '')
    .length

  const contentHtml = content ? `\n    <div class="content">${renderMarkdown(content)}</div>` : ''
  const blocksHtml = blocks.length
    ? `\n    <section class="blocks">
      <h2>记忆素材（${blocks.length} 条）</h2>${blocks
        .map(
          (b) => `
      <div class="qa">${b.front.trim() ? `\n        <h3>${escapeHtml(b.front.trim())}</h3>` : ''}${b.back.trim() ? `\n        <div class="back">${renderMarkdown(b.back)}</div>` : ''}
      </div>`,
        )
        .join('')}
    </section>`
    : ''
  const autoPrintScript = opts.autoPrint
    ? `\n  <script>
    window.addEventListener('load', function () {
      setTimeout(function () { try { window.focus(); window.print(); } catch (e) {} }, 200);
    });
  </script>`
    : ''

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>${DOC_STYLES}</style>
</head>
<body>
  <div class="wrap">
    <h1 class="title">${escapeHtml(title)}</h1>
    <p class="meta">共 ${charCount} 字 · ${fmtDate(card.updatedAt ?? card.createdAt)}</p>${contentHtml}${blocksHtml}
    <footer class="doc-footer">导出自「背书吧」 · ${fmtDate()}</footer>
  </div>
  <button type="button" class="print-btn no-print" onclick="window.print()">打印 / 导出 PDF</button>${autoPrintScript}
</body>
</html>`
}

/** 导出 HTML（下载 .html 完整独立文档）。返回所用文件名。 */
export function exportCardHtml(card: ExportCard): string {
  const filename = `${safeFilename(card.title)}.html`
  downloadBlob(
    filename,
    new Blob([buildCardHtml(card)], { type: 'text/html;charset=utf-8' }),
  )
  return filename
}

/**
 * 打印 / 导出 PDF：创建隐藏 iframe → 写入完整 HTML → 自动调起浏览器原生打印。
 * 用户在打印窗口选择「另存为 PDF」即可得到 PDF；中文由系统字体渲染，零乱码。
 */
export function printCard(card: ExportCard): void {
  if (typeof document === 'undefined') return
  const html = buildCardHtml(card, { autoPrint: true })

  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.title = 'print'
  // 0x0 固定定位（与 print-js 相同做法）：不影响当前页面，各浏览器均可正常打印
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  document.body.appendChild(iframe)

  const doc = iframe.contentDocument ?? iframe.contentWindow?.document
  if (!doc) {
    iframe.remove()
    return
  }
  doc.open()
  doc.write(html)
  doc.close()

  // 打印结束后清理 iframe；部分浏览器不触发 afterprint，附加超时兜底
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    setTimeout(() => iframe.remove(), 500)
  }
  iframe.contentWindow?.addEventListener('afterprint', cleanup)
  setTimeout(cleanup, 10 * 60 * 1000)
}

// ---------------------------------------------------------------------------
// JSON 备份导出
// ---------------------------------------------------------------------------

/** 导出当前卡片完整 JSON 备份（含记忆素材 blocks）。返回所用文件名。 */
export function exportCardJson(card: ExportCard): string {
  const payload = {
    app: '背书吧',
    kind: 'card-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    card: {
      id: card.id ?? '',
      title: (card.title ?? '').trim(),
      content: card.content ?? '',
      blocks: normalizeBlocks(card),
      createdAt: card.createdAt ?? null,
      updatedAt: card.updatedAt ?? null,
    },
  }
  const filename = `${safeFilename(card.title)}.json`
  downloadBlob(
    filename,
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }),
  )
  return filename
}
