// POST /api/parse — file upload text extraction for the import flow.
// multipart/form-data, field "file". Requires a session.
//
// Accepted (任意类型都有处理路径，全部在服务端分流):
//   .pdf   → 多引擎解析链：unpdf（现代 pdf.js 构建）→ pdf-parse v2 兜底
//            可通过 formData 字段 engine 指定：auto(默认) | unpdf | pdf-parse
//   .docx  → mammoth.convertToHtml → Markdown（保留标题/加粗/列表/表格/下划线/链接），
//            内嵌图片入库换 /api/upload/<id> 短引用（EMF/WMF 等浏览器不可渲染的直接删除）
//   .xlsx / .xls → SheetJS 遍历全部工作表 → GFM Markdown 表格，每表前加 `## 工作表：名`
//   .pptx  → JSZip 解包每页 <a:t> 文本 + r:embed 内嵌图片入库，页前加 `## 第N页`
//   .epub  → JSZip 解包 container.xml → OPF spine，逐章 xhtml → Markdown（含图片短引用）
//   .rtf   → 剥离 RTF 控制字（\'xx 十六进制按 GBK/UTF-8 解码，失败则忽略）
//   图片 png/jpg/jpeg/webp/gif/bmp/heic → AI 视觉模型 OCR 识别文字（60s 超时）
//   音频 mp3/wav/m4a/aac/ogg/webm/amr/flac → AI 语音转文字（120s 超时，上限 30MB；
//            非 WAV/WebM 先经 ffmpeg 转码，ffmpeg 不可用时原样送识别）
//   .doc / .ppt → 旧版格式友好报错（建议另存为 .docx / .pptx）
//   文本类（txt/md/csv/json/xml/代码…）→ UTF-8 strict 解码，失败回退 GB18030
//     （很多中文 txt 是 GBK 编码）；HTML/XHTML → htmlToMarkdown 保留富文本格式与图片；
//     srt/vtt 字幕 → 剥掉序号/时间轴/WEBVTT 头，只留台词文本
//   其他未知类型 → 按文本尝试解码 + 二进制检测（NUL/控制字符/替换符占比），
//     判定为二进制则返回 422 友好提示
// Max size: 15 MB（文档/图片/文本），30 MB（音频）。
//
// Note on pdf-parse: the installed version is v2.x, a full TypeScript rewrite
// with an explicit class API — it does NOT have the v1 "debug mode" problem,
// so no deep import of 'pdf-parse/lib/pdf-parse.js' is needed.
import { NextRequest, NextResponse } from 'next/server'
import { PDFParse } from 'pdf-parse'
import mammoth from 'mammoth'
import JSZip from 'jszip'
import { getSessionUser } from '@/lib/auth'
import { db } from '@/lib/db'

export const runtime = 'nodejs'

const MAX_BYTES = 15 * 1024 * 1024 // 15 MB（文档/图片/文本）
const AUDIO_MAX_BYTES = 30 * 1024 * 1024 // 30 MB（音频）

type Kind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'epub' | 'rtf' | 'image' | 'audio' | 'text'

const TEXT_EXTS = [
  '.txt', '.md', '.markdown', '.text', '.mdown', '.mkd',
  '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.srt', '.vtt', '.log',
  '.yml', '.yaml', '.ini', '.conf', '.tex', '.bib',
  '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.h',
  '.css', '.scss', '.vue', '.rb', '.go', '.rs', '.php', '.sh', '.sql',
]

const TEXT_MIMES = [
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-yaml',
]

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.heic']
const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.webm', '.amr', '.flac']
const HTML_EXTS = ['.html', '.htm', '.xhtml']

/** 小写扩展名（含点）；无扩展名返回空串。 */
function extOf(filename: string): string {
  const name = filename.toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot) : ''
}

/**
 * Decide how to parse a file from its extension + mime type. Throws a friendly
 * Chinese error for legacy .doc/.ppt. Unknown extensions fall back to 'text'
 * (the binary check further down rejects actual binary garbage with a 422).
 */
function detectKind(filename: string, mime: string): { kind: Kind; knownText: boolean } {
  const ext = extOf(filename)
  if (ext === '.pdf' || mime === 'application/pdf') return { kind: 'pdf', knownText: false }
  if (
    ext === '.docx' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return { kind: 'docx', knownText: false }
  }
  if (ext === '.doc') {
    throw new Error('暂不支持旧版 .doc 文件，请先在 Word 中另存为 .docx 后上传')
  }
  if (
    ext === '.xlsx' ||
    ext === '.xls' ||
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'application/vnd.ms-excel'
  ) {
    return { kind: 'xlsx', knownText: false }
  }
  if (
    ext === '.pptx' ||
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    return { kind: 'pptx', knownText: false }
  }
  if (ext === '.ppt') {
    throw new Error('暂不支持旧版 .ppt 文件，请先在 PowerPoint 中另存为 .pptx 后上传')
  }
  if (ext === '.epub' || mime === 'application/epub+zip') return { kind: 'epub', knownText: false }
  if (ext === '.rtf' || mime === 'application/rtf' || mime === 'text/rtf') {
    return { kind: 'rtf', knownText: false }
  }
  if (IMAGE_EXTS.includes(ext) || mime.startsWith('image/')) {
    return { kind: 'image', knownText: false }
  }
  if (AUDIO_EXTS.includes(ext) || mime.startsWith('audio/')) {
    return { kind: 'audio', knownText: false }
  }
  const knownText =
    TEXT_EXTS.includes(ext) || mime.startsWith('text/') || TEXT_MIMES.includes(mime)
  // 未知扩展名也按文本兜底尝试解码，由 looksLikeBinary 把真正的二进制拦下
  return { kind: 'text', knownText }
}

/** Strict UTF-8 decode; falls back to GB18030 for Chinese GBK-encoded files. */
function decodeText(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buffer)
    } catch {
      // Last resort: lossy UTF-8 so we never fail the whole upload here.
      return buffer.toString('utf-8')
    }
  }
}

/** Collapse 3+ consecutive newlines into one blank line and trim edges. */
function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 安全码点转换：非法值（超平面/代理区）返回空串而不是抛错。 */
function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return ''
  try {
    return String.fromCodePoint(cp)
  } catch {
    return ''
  }
}

/** 解码 HTML/XML 实体（数字实体 + 常用具名实体；&amp; 最后处理避免二次解码）。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** HTML → 纯文本：去 style/script/注释块，块级标签与 <br> 转换行，实体解码。 */
function htmlToText(html: string): string {
  const stripped = decodeEntities(
    html
      .replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|ul|ol|table|section|article)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
  return stripped
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
}

// ---------------------------------------------------------------------------
// 富格式导入基础设施：图片入库 + 字幕清洗 + HTML → Markdown
// ---------------------------------------------------------------------------

/** zip 魔数检测：docx/xlsx/pptx/epub 本质是 zip，开头不是 PK 就绝不是有效文件。 */
function isZipBuffer(buf: Buffer): boolean {
  return buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b
}

/** zip 内媒体文件的扩展名 → mime 推断（EPUB manifest 缺 media-type、PPTX rels 用）。 */
const ZIP_MEDIA_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.emf': 'image/x-emf',
  '.wmf': 'image/x-wmf',
}

/** 可入库的图片 mime（浏览器可直接渲染的；EMF/WMF/BMP/TIFF 等会被拒）。 */
const SAVABLE_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
])
const IMAGE_IMPORT_MAX_BYTES = 8 * 1024 * 1024 // 单图 8MB 上限
const IMAGE_IMPORT_MAX_EDGE = 1200 // png/jpeg/gif/webp 长边超 1200 缩放（jpeg q80）

/**
 * 文档内嵌图片入库：直接写 Prisma Upload 表，返回 `/api/upload/<id>` 短引用。
 * 类型不支持 / 超过 8MB / sharp 处理失败 / 写库失败 → 一律返回 null，
 * 调用方跳过该图即可，绝不中断整体解析。
 */
async function saveImageToUpload(data: Buffer, mime: string): Promise<string | null> {
  try {
    const m = String(mime || '').split(';')[0].trim().toLowerCase()
    if (!SAVABLE_IMAGE_MIME.has(m)) return null
    let buf = data
    if (!buf || buf.byteLength === 0 || buf.byteLength > IMAGE_IMPORT_MAX_BYTES) return null
    if (m !== 'image/svg+xml') {
      try {
        const sharpMod = await import('sharp')
        const img = sharpMod.default(buf)
        const meta = await img.metadata()
        if (Math.max(meta.width ?? 0, meta.height ?? 0) > IMAGE_IMPORT_MAX_EDGE) {
          const resized = img.resize({
            width: IMAGE_IMPORT_MAX_EDGE,
            height: IMAGE_IMPORT_MAX_EDGE,
            fit: 'inside',
            withoutEnlargement: true,
          })
          if (m === 'image/jpeg') buf = await resized.jpeg({ quality: 80 }).toBuffer()
          else if (m === 'image/webp') buf = await resized.webp().toBuffer()
          else if (m === 'image/gif') buf = await resized.gif().toBuffer()
          else buf = await resized.png().toBuffer()
        }
      } catch {
        // sharp 处理失败（个别特殊图）→ 原样入库（体积已在 8MB 内）
      }
    }
    const base64 = buf.toString('base64')
    const row = await db.upload.create({ data: { mime: m, data: base64, bytes: buf.byteLength } })
    return `/api/upload/${row.id}`
  } catch (e) {
    console.error('[POST /api/parse] saveImageToUpload failed:', e)
    return null
  }
}

/** data:image/...;base64,xxx → 入库短引用；格式不合法/类型不支持返回 null。 */
async function saveDataUriImage(dataUri: string): Promise<string | null> {
  const dm = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(dataUri)
  if (!dm) return null
  return saveImageToUpload(Buffer.from(dm[2], 'base64'), dm[1].toLowerCase())
}

/** SRT / WebVTT 字幕 → 纯文本：去序号行、时间轴（-->）行、WEBVTT 头、NOTE 注释块与行内标签。 */
function parseSubtitle(raw: string): string {
  const out: string[] = []
  let inNote = false
  for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.trim()
    if (!t) {
      if (!inNote) out.push('')
      inNote = false
      continue
    }
    if (inNote) continue
    if (/^NOTE\b/i.test(t)) {
      inNote = true
      continue
    }
    if (/^WEBVTT/i.test(t)) continue
    if (t.includes('-->')) continue // 时间轴行
    if (/^\d+$/.test(t)) continue // SRT 序号行
    const cleaned = decodeEntities(
      t.replace(/<\d{2}:\d{2}:\d{2}[.,]\d{3}>/g, '').replace(/<\/?[a-zA-Z][^>]*>/g, ''),
    ).trim()
    if (cleaned) out.push(cleaned)
  }
  return out.join('\n').trim()
}

// --- HTML → Markdown（保格式导入核心） -------------------------------------

type MdImageResolver = (src: string, alt: string) => Promise<string | null>

interface HtmlToMdOptions {
  /** 图片解析器：入参 html 的 src/alt，返回替换后的短引用 URL；null 表示丢弃该图。 */
  resolveImage?: MdImageResolver
}

interface HtmlTextNode {
  type: 'text'
  text: string
}

interface HtmlElementNode {
  type: 'element'
  tag: string
  attrs: Record<string, string>
  children: HtmlNode[]
}

type HtmlNode = HtmlTextNode | HtmlElementNode

/** 自闭合标签（无子内容，不进栈）。 */
const HTML_VOID_TAGS = new Set([
  'br', 'img', 'hr', 'meta', 'link', 'input', 'source', 'track', 'wbr', 'area', 'base', 'col',
  'embed', 'param',
])

/** 块级标签：参与「连续内联内容聚段落 / 块级元素单独渲染」的分流。 */
const HTML_BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'dd', 'details', 'dialog', 'div', 'dl',
  'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hgroup', 'hr', 'html', 'body', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
  'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])

/** 内联样式上下文（strong 嵌套等场景用计数而非布尔）。 */
interface InlineStyleCtx {
  bold: number
  italic: number
  underline: number
  strike: number
}

const BASE_INLINE_CTX: InlineStyleCtx = { bold: 0, italic: 0, underline: 0, strike: 0 }

/** 极简属性解析：name="v" / name='v' / name=v（值过一遍实体解码）。 */
function parseHtmlAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([a-zA-Z_:@][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
  }
  return attrs
}

/** HTML 片段 → 简单节点树（正则分词 + 栈配对，容忍未闭合/错配标签）。 */
function parseHtmlFragment(html: string): HtmlNode[] {
  const root: HtmlElementNode = { type: 'element', tag: '', attrs: {}, children: [] }
  const stack: HtmlElementNode[] = [root]
  const tokenRe = /<[^>]+>/g
  let last = 0
  let m: RegExpExecArray | null
  const appendText = (text: string) => {
    if (!text) return
    const top = stack[stack.length - 1]
    if (top) top.children.push({ type: 'text', text })
  }
  while ((m = tokenRe.exec(html)) !== null) {
    if (m.index > last) appendText(html.slice(last, m.index))
    const token = m[0]
    last = m.index + token.length
    if (token.startsWith('<!') || token.startsWith('<?')) continue
    const nameMatch = /^<\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(token)
    if (!nameMatch) continue
    const tag = nameMatch[1].toLowerCase()
    if (token.startsWith('</')) {
      // 闭合标签：向上找到最近的同名开标签（连同其上层未闭合标签一起出栈）
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i
          break
        }
      }
      continue
    }
    const el: HtmlElementNode = {
      type: 'element',
      tag,
      attrs: parseHtmlAttrs(token.slice(nameMatch[0].length)),
      children: [],
    }
    // HTML 隐式闭合：<p> 遇块级标签自动闭合、<li> 遇 <li> 自动闭合（未写闭合标签的常见脏 HTML）
    if (HTML_BLOCK_TAGS.has(tag)) {
      while (stack.length > 1) {
        const topTag = stack[stack.length - 1]?.tag
        if (topTag === 'p' || (topTag === 'li' && tag === 'li')) stack.pop()
        else break
      }
    }
    const top = stack[stack.length - 1]
    if (top) top.children.push(el)
    if (!HTML_VOID_TAGS.has(tag) && !/\/\s*>$/.test(token)) stack.push(el)
  }
  if (last < html.length) stack[0].children.push({ type: 'text', text: html.slice(last) })
  return root.children
}

/** 子树的原始文本（保留空白，不解码换行折叠；pre / 行内 code 用）。 */
function extractRawText(nodes: HtmlNode[]): string {
  let out = ''
  for (const n of nodes) {
    if (n.type === 'text') out += decodeEntities(n.text)
    else if (!HTML_VOID_TAGS.has(n.tag)) out += extractRawText(n.children)
  }
  return out
}

/** markdown 链接/图片目标里的空白与括号做百分号转义，防止链接语法被打断。 */
function mdUrl(url: string): string {
  return url
    .replace(/\\/g, '%5C')
    .replace(/\s/g, '%20')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
}

/** 给内联文本套 markdown 标记。下划线用编辑器原生 %%u|…%% 指令（放最内层），加粗/斜体放外层。 */
function applyInlineMarks(text: string, ctx: InlineStyleCtx): string {
  if (!text) return text
  const lead = /^[ \t\n]*/.exec(text)?.[0] ?? ''
  const trail = /[ \t\n]*$/.exec(text)?.[0] ?? ''
  const core = text.slice(lead.length, text.length - trail.length)
  if (!core) return lead + trail
  let s = core
  // %%u|…%% 指令内不能出现 | % 换行，不满足就放弃下划线标记
  if (ctx.underline > 0 && !/[|\n%]/.test(s)) s = `%%u|${s}%%`
  if (ctx.strike > 0 && !/\n/.test(s)) s = `~~${s}~~`
  if (ctx.italic > 0 && !/\n/.test(s)) s = `*${s}*`
  if (ctx.bold > 0 && !/\n/.test(s)) s = `**${s}**`
  return lead + s + trail
}

/** 段内文本清理：逐行去首尾空白、丢空行；多行时行尾补两空格形成 markdown 硬换行。 */
function cleanInlineParagraph(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l.length > 0)
  if (lines.length === 0) return ''
  if (lines.length === 1) return lines[0]
  return lines.map((l, i) => (i < lines.length - 1 ? `${l}  ` : l)).join('\n')
}

/** <img>（含 svg <image xlink:href>）→ `![alt](url)`；resolver 返回 null 则丢弃。 */
async function renderImageNode(el: HtmlElementNode, opts: HtmlToMdOptions): Promise<string> {
  const src = el.attrs.src || el.attrs['xlink:href'] || el.attrs['data-src'] || ''
  if (!src) return ''
  const alt = (el.attrs.alt || el.attrs.title || '').replace(/[[\]\n]/g, ' ').trim()
  let url: string | null = null
  if (opts.resolveImage) {
    url = await Promise.resolve(opts.resolveImage(src, alt)).catch(() => null)
  } else {
    url = src
  }
  if (!url) return ''
  return `![${alt}](${mdUrl(url)})`
}

/** 内联节点序列 → 带 markdown 标记的字符串（<br> → 换行，实体解码，空白折叠）。 */
async function renderInlineNodes(
  nodes: HtmlNode[],
  ctx: InlineStyleCtx,
  opts: HtmlToMdOptions,
): Promise<string> {
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text') {
      out += decodeEntities(node.text).replace(/\s+/g, ' ')
      continue
    }
    if (node.tag === 'br') {
      out += '\n'
      continue
    }
    if (node.tag === 'img' || node.tag === 'image') {
      out += await renderImageNode(node, opts)
      continue
    }
    if (node.tag === 'a') {
      const inner = await renderInlineNodes(node.children, ctx, opts)
      const href = node.attrs.href || ''
      out += href && inner.trim() ? `[${inner}](${mdUrl(href)})` : inner
      continue
    }
    if (node.tag === 'strong' || node.tag === 'b') {
      const childCtx = { ...ctx, bold: ctx.bold + 1 }
      out += applyInlineMarks(await renderInlineNodes(node.children, childCtx, opts), childCtx)
      continue
    }
    if (node.tag === 'em' || node.tag === 'i') {
      const childCtx = { ...ctx, italic: ctx.italic + 1 }
      out += applyInlineMarks(await renderInlineNodes(node.children, childCtx, opts), childCtx)
      continue
    }
    if (node.tag === 'u' || node.tag === 'ins') {
      const childCtx = { ...ctx, underline: ctx.underline + 1 }
      out += applyInlineMarks(await renderInlineNodes(node.children, childCtx, opts), childCtx)
      continue
    }
    if (node.tag === 'del' || node.tag === 's' || node.tag === 'strike') {
      const childCtx = { ...ctx, strike: ctx.strike + 1 }
      out += applyInlineMarks(await renderInlineNodes(node.children, childCtx, opts), childCtx)
      continue
    }
    if (node.tag === 'code' || node.tag === 'kbd' || node.tag === 'samp' || node.tag === 'tt') {
      const t = extractRawText(node.children).replace(/\s+/g, ' ').trim()
      if (!t) continue
      out += t.includes('`') ? '`` ' + t + ' ``' : '`' + t + '`'
      continue
    }
    // 其余内联元素（span/sub/sup/font/mark/small/…）透明处理
    out += await renderInlineNodes(node.children, ctx, opts)
  }
  return out
}

/** <table> → GFM Markdown 表格（首行作表头；单元格 | 转义、换行折叠为空格）。 */
async function renderTableBlock(
  el: HtmlElementNode,
  ctx: InlineStyleCtx,
  opts: HtmlToMdOptions,
): Promise<string> {
  const rows: string[][] = []
  const visitRow = async (tr: HtmlElementNode) => {
    const cells: string[] = []
    for (const c of tr.children) {
      if (c.type === 'element' && (c.tag === 'td' || c.tag === 'th')) {
        cells.push(
          (await renderInlineNodes(c.children, ctx, opts))
            .replace(/\s*\n\s*/g, ' ')
            .replace(/[ \t]+/g, ' ')
            .trim(),
        )
      }
    }
    if (cells.some((c) => c.length > 0)) rows.push(cells)
  }
  const walk = async (node: HtmlNode) => {
    if (node.type === 'text') return
    if (node.tag === 'tr') {
      await visitRow(node)
      return
    }
    if (node.tag === 'table') return // 嵌套表不展开
    for (const c of node.children) await walk(c)
  }
  for (const c of el.children) await walk(c)
  if (rows.length === 0) return ''
  const cols = Math.max(...rows.map((r) => r.length))
  const escCell = (s: string) => s.replace(/\|/g, '\\|')
  const line = (cells: string[]) =>
    '| ' + Array.from({ length: cols }, (_, i) => escCell(cells[i] ?? '')).join(' | ') + ' |'
  const out = [line(rows[0]), '|' + Array.from({ length: cols }, () => ' --- ').join('|') + '|']
  for (const r of rows.slice(1)) out.push(line(r))
  return out.join('\n')
}

/** 列表（支持 ≥2 层嵌套）：子列表与续行统一缩进 4 空格，兼容 ul/ol 混排。 */
async function renderListBlock(
  el: HtmlElementNode,
  ctx: InlineStyleCtx,
  opts: HtmlToMdOptions,
): Promise<string> {
  const ordered = el.tag === 'ol'
  const lines: string[] = []
  let index = parseInt(el.attrs.start || '1', 10) || 1
  const emitItem = async (li: HtmlElementNode) => {
    const marker = ordered ? `${index}. ` : '- '
    index++
    const lead: HtmlNode[] = []
    const blockKids: HtmlElementNode[] = []
    for (const c of li.children) {
      if (c.type === 'element' && HTML_BLOCK_TAGS.has(c.tag)) blockKids.push(c)
      else lead.push(c)
    }
    const leadText = cleanInlineParagraph(await renderInlineNodes(lead, ctx, opts))
    const contBlocks: string[] = []
    for (const b of blockKids) {
      const md =
        b.tag === 'ul' || b.tag === 'ol'
          ? await renderListBlock(b, ctx, opts)
          : await renderBlockNode(b, ctx, opts)
      if (md.trim()) contBlocks.push(md)
    }
    if (!leadText && contBlocks.length === 0) return
    if (leadText) {
      const leadLines = leadText.split('\n')
      lines.push(marker + leadLines[0])
      for (const extra of leadLines.slice(1)) lines.push('    ' + extra)
    } else {
      lines.push(marker.trimEnd())
    }
    for (const md of contBlocks) {
      for (const l of md.split('\n')) lines.push(l.trim() ? '    ' + l : '')
    }
  }
  for (const child of el.children) {
    if (child.type === 'element' && child.tag === 'li') {
      await emitItem(child)
    } else if (child.type === 'element' && (child.tag === 'ul' || child.tag === 'ol')) {
      // 直接嵌在列表下的列表（非法但粗糙导出里常见）
      const md = await renderListBlock(child, ctx, opts)
      for (const l of md.split('\n')) lines.push(l.trim() ? '    ' + l : '')
    }
  }
  return lines.join('\n')
}

/** 单个块级元素 → Markdown。 */
async function renderBlockNode(
  el: HtmlElementNode,
  ctx: InlineStyleCtx,
  opts: HtmlToMdOptions,
): Promise<string> {
  if (el.tag === 'h1' || el.tag === 'h2' || el.tag === 'h3' || el.tag === 'h4' || el.tag === 'h5' || el.tag === 'h6') {
    const level = Number(el.tag[1])
    const text = (await renderInlineNodes(el.children, ctx, opts))
      .replace(/\s*\n\s*/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim()
    return text ? '#'.repeat(level) + ' ' + text : ''
  }
  if (el.tag === 'p') {
    return cleanInlineParagraph(await renderInlineNodes(el.children, ctx, opts))
  }
  if (el.tag === 'hr') return '---'
  if (el.tag === 'pre') {
    const raw = extractRawText(el.children).replace(/^\n+|\n+$/g, '')
    if (!raw.trim()) return ''
    let lang = /(?:^|\s)(?:language|lang)-([\w#+.-]+)/.exec(el.attrs.class || '')?.[1] || ''
    if (!lang) {
      for (const c of el.children) {
        if (c.type === 'element' && (c.tag === 'code' || c.tag === 'tt')) {
          lang = /(?:^|\s)(?:language|lang)-([\w#+.-]+)/.exec(c.attrs.class || '')?.[1] || ''
          if (lang) break
        }
      }
    }
    const fence = raw.includes('```') ? '````' : '```'
    return `${fence}${lang}\n${raw}\n${fence}`
  }
  if (el.tag === 'blockquote') {
    const inner = (await renderNodesToBlocks(el.children, ctx, opts)).join('\n\n')
    if (!inner.trim()) return ''
    return inner.split('\n').map((l) => (l.trim() ? '> ' + l : '>')).join('\n')
  }
  if (el.tag === 'ul' || el.tag === 'ol') return renderListBlock(el, ctx, opts)
  if (el.tag === 'table') return renderTableBlock(el, ctx, opts)
  if (el.tag === 'nav') {
    // EPUB 目录页/landmarks 是纯导航噪音，直接跳过
    const t = (el.attrs['epub:type'] || el.attrs.type || '').toLowerCase()
    if (t.includes('toc') || t.includes('landmarks')) return ''
  }
  // div/section/article/figure/header/dd… → 递归按块渲染（纯文本自然聚成段落）
  return (await renderNodesToBlocks(el.children, ctx, opts)).join('\n\n')
}

/** 节点序列 → 块列表：连续内联内容聚成段落，块级元素各占一块（\n\n 分隔）。 */
async function renderNodesToBlocks(
  nodes: HtmlNode[],
  ctx: InlineStyleCtx,
  opts: HtmlToMdOptions,
): Promise<string[]> {
  const blocks: string[] = []
  let run: HtmlNode[] = []
  const flushRun = async () => {
    if (run.length === 0) return
    const text = cleanInlineParagraph(await renderInlineNodes(run, ctx, opts))
    run = []
    if (text) blocks.push(text)
  }
  for (const node of nodes) {
    if (node.type === 'text' || !HTML_BLOCK_TAGS.has(node.tag)) {
      run.push(node)
      continue
    }
    await flushRun()
    const md = await renderBlockNode(node, ctx, opts)
    if (md && md.trim()) blocks.push(md)
  }
  await flushRun()
  return blocks
}

/**
 * HTML → Markdown（保格式导入核心）。
 * 覆盖：h1-h6 / 段落与硬换行 / 加粗 / 斜体 / 下划线（编辑器 %%u|…%% 语法）/ 删除线 /
 * 链接 / 嵌套列表 / 引用 / 分隔线 / 围栏代码块 / GFM 表格 / 图片（经 resolveImage
 * 入库换 `/api/upload/<id>` 短引用，返回 null 的图直接丢弃）。
 * 任何内部异常都回退 htmlToText，绝不打断导入。
 */
async function htmlToMarkdown(html: string, opts: HtmlToMdOptions = {}): Promise<string> {
  try {
    const cleaned = html
      .replace(/<\?xml[^>]*\?>/gi, '')
      .replace(/<!DOCTYPE[^>]*>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(style|script|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    const nodes = parseHtmlFragment(cleaned)
    const blocks = await renderNodesToBlocks(nodes, BASE_INLINE_CTX, opts)
    return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
  } catch (e) {
    console.error('[POST /api/parse] htmlToMarkdown failed:', e)
    return htmlToText(html)
  }
}

// ---------------------------------------------------------------------------
// 各格式解析器
// ---------------------------------------------------------------------------

/** Excel（xlsx/xls）：每工作表 `## 工作表：名` + GFM Markdown 表格（超 50 列 / 500 行截断）。 */
async function parseSpreadsheet(buffer: Buffer, filename: string): Promise<string> {
  if (extOf(filename) === '.xlsx' && !isZipBuffer(buffer)) {
    throw new Error('Excel 解析失败：文件可能已损坏或不是有效的 .xlsx 文件')
  }
  // xlsx 同时存在 ESM/CJS 两种产物，做一次 default 互取保证两种形态都能用
  const mod = await import('xlsx')
  const XLSX = (mod as unknown as { default?: typeof mod }).default ?? mod
  let workbook: ReturnType<typeof XLSX.read>
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' })
  } catch {
    throw new Error('Excel 解析失败：文件可能已损坏或不是有效的 Excel 文件')
  }
  const MAX_COLS = 50
  const MAX_ROWS = 500
  const parts: string[] = []
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]
    if (!sheet) continue
    let rawRows: unknown[][] = []
    try {
      rawRows = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        blankrows: false,
        defval: '',
        raw: false,
      }) as unknown[][]
    } catch {
      continue
    }
    const table = rawRows
      .map((r) => (Array.isArray(r) ? r : [r]))
      .map((r) => r.map((c) => String(c ?? '').replace(/\r?\n/g, ' ').trim()))
      .filter((r) => r.some((c) => c.length > 0))
    if (table.length === 0) continue
    let cols = Math.max(...table.map((r) => r.length))
    const notes: string[] = []
    if (cols > MAX_COLS) {
      notes.push(`该表共 ${cols} 列，已截断只显示前 ${MAX_COLS} 列`)
      cols = MAX_COLS
    }
    let shown = table
    if (table.length > MAX_ROWS) {
      notes.push(`该表共 ${table.length} 行，已截断只显示前 ${MAX_ROWS} 行`)
      shown = table.slice(0, MAX_ROWS)
    }
    const escCell = (s: string) => s.replace(/\|/g, '\\|')
    const line = (r: string[]) =>
      '| ' + Array.from({ length: cols }, (_, i) => escCell(r[i] ?? '')).join(' | ') + ' |'
    parts.push(
      [
        `## 工作表：${name}`,
        '',
        line(shown[0]),
        '|' + Array.from({ length: cols }, () => ' --- ').join('|') + '|',
        ...shown.slice(1).map(line),
        ...notes.map((n) => `> ${n}`),
      ].join('\n'),
    )
  }
  if (parts.length === 0) {
    throw new Error('未能从表格中提取到内容（可能是空表格）')
  }
  // 质量检查：SheetJS 对任意数据都很宽容（非表格数据也按纯文本解析），
  // 乱码/控制字符占比过高说明文件本身已损坏
  const all = parts.join('\n\n')
  let bad = 0
  for (const ch of all) {
    const c = ch.codePointAt(0) ?? 0
    if (ch === '\uFFFD' || (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0c)) {
      bad++
    }
  }
  if (bad / all.length > 0.05) {
    throw new Error('Excel 解析失败：文件可能已损坏或不是有效的 Excel 文件')
  }
  return all
}

/** PPTX：每页 `## 第N页` + 段落文本 + r:embed 内嵌图片入库（`![图片](/api/upload/x)`）。 */
async function parsePptx(buffer: Buffer): Promise<string> {
  if (!isZipBuffer(buffer)) {
    throw new Error(
      'PPT 解析失败：文件可能已损坏或不是有效的 .pptx 文件（旧版 .ppt 请先用 PowerPoint 另存为 .pptx 后上传）',
    )
  }
  let zip: JSZip | null = null
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    throw new Error('PPT 解析失败：文件可能已损坏或不是有效的 .pptx 文件')
  }
  const slides = Object.keys(zip.files)
    .map((path) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(path))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ path: m[0], num: parseInt(m[1], 10) }))
    .sort((a, b) => a.num - b.num)
  if (slides.length === 0) {
    throw new Error('PPT 解析失败：未找到幻灯片页面，文件可能已损坏或不是有效的 .pptx 文件')
  }
  const pages: string[] = []
  let imageSaved = 0
  let imageFailed = 0
  for (const slide of slides) {
    const xml = await zip.files[slide.path].async('string')
    // 每页按段落（<a:p>）聚合 <a:t> 文本块，避免不同段落的文字粘连
    const lines = xml
      .split(/<\/a:p>/)
      .map((para) =>
        Array.from(para.matchAll(/<a:t>([^<]*)<\/a:t>/g), (m) => decodeEntities(m[1])).join(''),
      )
      .filter((line) => line.length > 0)
    // 该页引用的内嵌图片：slideN.xml.rels → media 文件 → 入库短引用
    const imgLines: string[] = []
    const relsFile = zip.file(`ppt/slides/_rels/slide${slide.num}.xml.rels`)
    if (relsFile) {
      const relsXml = await relsFile.async('string')
      const seen = new Set<string>()
      for (const rel of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
        const type = /\bType="([^"]*)"/.exec(rel[0])?.[1] ?? ''
        const target = decodeEntities(/\bTarget="([^"]*)"/.exec(rel[0])?.[1] ?? '')
        if (!type.includes('/image') || !target || /^https?:\/\//i.test(target)) continue
        const mediaPath = joinZipPath('ppt/slides/', target)
        if (seen.has(mediaPath)) continue
        seen.add(mediaPath)
        const f = zip.file(mediaPath) ?? zip.file(joinZipPath('ppt/slides/', safeDecodeURI(target)))
        if (!f) {
          imageFailed++
          continue
        }
        try {
          const imgBuf = await f.async('nodebuffer')
          const url = await saveImageToUpload(imgBuf, ZIP_MEDIA_MIME[extOf(mediaPath)] ?? '')
          if (url) {
            imageSaved++
            imgLines.push(`![图片](${url})`)
          } else {
            imageFailed++
          }
        } catch {
          imageFailed++
        }
      }
    }
    if (lines.length === 0 && imgLines.length === 0) continue
    pages.push([`## 第${slide.num}页`, ...lines, ...imgLines].join('\n'))
  }
  if (pages.length === 0) {
    if (imageFailed > 0) {
      throw new Error(
        '未能从幻灯片中提取到文字或图片（可能全部为特殊格式图片页）。建议截图后改用「拍照识别导入」',
      )
    }
    throw new Error('未能从幻灯片中提取到文字（可能全部为图片页）。建议截图后改用「拍照识别导入」')
  }
  return pages.join('\n\n')
}

/** 解码 zip 内路径里的 URL 转义（%20 等），失败原样返回。 */
function safeDecodeURI(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** 拼接并规整 zip 内部路径（处理 ./ 与 ../ 相对段，去掉 ?# 后缀）。 */
function joinZipPath(base: string, href: string): string {
  const raw = `${base}${href}`.split('?')[0].split('#')[0]
  const parts: string[] = []
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return parts.join('/')
}

/** EPUB：container.xml → OPF 路径 → manifest+spine → 逐章 xhtml → Markdown（图片入库短引用）。 */
async function parseEpub(buffer: Buffer): Promise<string> {
  if (!isZipBuffer(buffer)) {
    throw new Error('EPUB 解析失败：文件可能已损坏或不是有效的 .epub 电子书')
  }
  let zip: JSZip | null = null
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    throw new Error('EPUB 解析失败：文件可能已损坏或不是有效的 .epub 电子书')
  }
  const containerFile = zip.file('META-INF/container.xml')
  if (!containerFile) {
    throw new Error('EPUB 解析失败：文件结构不完整（缺少 container.xml），可能不是有效的 .epub 文件')
  }
  const containerXml = await containerFile.async('string')
  const opfPathMatch = /<rootfile[^>]*full-path="([^"]+)"/.exec(containerXml)
  if (!opfPathMatch) {
    throw new Error('EPUB 解析失败：无法定位图书目录（OPF）文件')
  }
  const opfPath = decodeEntities(opfPathMatch[1])
  const opfFile = zip.file(opfPath) ?? zip.file(opfPath.replace(/^\/+/, ''))
  if (!opfFile) {
    throw new Error('EPUB 解析失败：图书目录（OPF）文件缺失，文件可能已损坏')
  }
  const opfXml = await opfFile.async('string')
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''

  // manifest：id → href（属性顺序不定，逐个提取）；顺手记录 路径 → media-type（图片 mime 推断）
  const manifest = new Map<string, string>()
  const mediaByPath = new Map<string, string>()
  for (const tag of opfXml.matchAll(/<item\b[^>]*>/g)) {
    const id = /\bid="([^"]*)"/.exec(tag[0])?.[1]
    const href = /\bhref="([^"]*)"/.exec(tag[0])?.[1]
    if (id && href) {
      manifest.set(id, decodeEntities(href))
      const mt = /\bmedia-type="([^"]*)"/.exec(tag[0])?.[1]
      if (mt) mediaByPath.set(joinZipPath(baseDir, decodeEntities(href)), mt.toLowerCase())
    }
  }
  // spine：正文阅读顺序
  const spineIds = Array.from(
    opfXml.matchAll(/<itemref\b[^>]*idref="([^"]*)"[^>]*>/g),
    (m) => m[1],
  )
  if (spineIds.length === 0) {
    throw new Error('EPUB 解析失败：未找到正文阅读顺序（spine），文件可能已损坏')
  }

  const parts: string[] = []
  let chapterNo = 0
  for (const id of spineIds) {
    const href = manifest.get(id)
    if (!href) continue
    const path = joinZipPath(baseDir, href)
    // spine 里偶尔混入非 xhtml 资源（PDF/图片等），按 manifest media-type 过滤
    const itemMime = mediaByPath.get(path) ?? ''
    if (itemMime && !/html|xml/.test(itemMime)) continue
    const file =
      zip.file(path) ?? zip.file(joinZipPath(baseDir, safeDecodeURI(href)))
    if (!file) continue
    const chapterDir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
    const html = await file.async('string')
    // 章节标题：优先 <title>，其次首个 h1/h2
    const titleRaw =
      /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ??
      /<h[12][^>]*>([\s\S]*?)<\/h[12]>/i.exec(html)?.[1] ??
      ''
    const chapterTitle = decodeEntities(titleRaw.replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim()
    const md = await htmlToMarkdown(html, {
      resolveImage: async (src) => {
        if (/^data:/i.test(src)) return saveDataUriImage(src)
        if (/^https?:\/\//i.test(src)) return src // 外链原样保留，不下载
        // zip 内相对路径（章节目录下）或绝对路径（/ 开头，从 zip 根解析）→ 读出图片 → 入库短引用
        const imgPath = src.startsWith('/') ? joinZipPath('', src) : joinZipPath(chapterDir, src)
        const decodedPath = src.startsWith('/')
          ? joinZipPath('', safeDecodeURI(src))
          : joinZipPath(chapterDir, safeDecodeURI(src))
        const f = zip.file(imgPath) ?? zip.file(decodedPath)
        if (!f) return null
        try {
          const imgBuf = await f.async('nodebuffer')
          const mime = mediaByPath.get(imgPath) ?? ZIP_MEDIA_MIME[extOf(imgPath)] ?? ''
          return await saveImageToUpload(imgBuf, mime)
        } catch {
          return null
        }
      },
    })
    let body = md
    // 标题提取自 h1/h2 时正文首行会重复渲染同一标题，去重
    if (chapterTitle) {
      const firstLine = body.split('\n', 1)[0] ?? ''
      const headingText = /^#{1,6}\s+(.*)$/.exec(firstLine.trim())?.[1]?.trim()
      if (headingText && headingText === chapterTitle) {
        body = body.slice(firstLine.length).replace(/^\n+/, '')
      }
    }
    if (!body.trim()) continue
    chapterNo++
    parts.push(`## ${chapterTitle || `第${chapterNo}章`}\n\n${body}`.trim())
  }
  if (parts.length === 0) {
    throw new Error('未能从 EPUB 中提取到正文文字，文件可能已损坏')
  }
  return parts.join('\n\n')
}

/** 一段连续的 \'xx 十六进制转义 → 字节序列：先 GBK（中文 RTF 常见），再 UTF-8，最后 latin1。 */
function decodeRtfHexRun(run: string): string {
  const hexes = run.match(/[0-9a-fA-F]{2}/g) || []
  if (hexes.length === 0) return ''
  const bytes = Buffer.from(hexes.map((h) => parseInt(h, 16)))
  try {
    const gbk = new TextDecoder('gb18030').decode(bytes)
    if (!gbk.includes('\uFFFD')) return gbk
  } catch {
    /* fall through */
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    /* fall through */
  }
  return bytes.toString('latin1')
}

/** RTF → 纯文本：剥离控制字/分组花括号，\'xx 按 GBK 解码，\par 转换行。 */
function parseRtf(buffer: Buffer): string {
  // RTF 主体是 ASCII，高位字节以 \'xx 转义出现，先按 latin1 读入再逐段处理
  let s = buffer.toString('latin1')

  // 可忽略的目标组（注释、字体表、颜色表、样式表、图片、OLE 对象等）
  s = s.replace(/\{\\\*(?:[^{}]|\{[^{}]*\})*\}/g, '')
  s = s.replace(
    /\{\\(?:fonttbl|colortbl|stylesheet|info|pict|object)(?:[^{}]|\{[^{}]*\})*\}/g,
    '',
  )
  // 显式换行/缩进控制字
  s = s.replace(/\\(?:par|line)\b/gi, '\n')
  s = s.replace(/\\tab\b/gi, '\t')
  // \'xx 十六进制字节（中文 RTF 常为 GBK 双字节，成对出现）
  s = s.replace(/(?:\\'([0-9a-fA-F]{2}))+/g, (run) => decodeRtfHexRun(run))
  // 其余控制字（\word、\word-123 及其后随的一个分隔空格）
  s = s.replace(/\\[a-zA-Z]+-?\d*\s?/g, '')
  // 剩余控制符号（\~ 连接空格、\- 可选连字符等）
  s = s.replace(/\\[^a-zA-Z{}\\\s]/g, '')
  // 字面转义
  s = s.replace(/\\\\/g, '\\')
  s = s.replace(/\\\{/g, '{')
  s = s.replace(/\\\}/g, '}')
  // 分组花括号
  s = s.replace(/[{}]/g, '')

  return s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
}

/**
 * 二进制检测（用于未知扩展名的文本兜底）：
 * 1) 原始字节里出现 NUL，或异常控制字符占比 > 5% → 二进制；
 * 2) 解码后替换符 \uFFFD + 控制字符合计占比 > 30% → 二进制。
 * （GB18030 几乎能解码任意字节序列，所以必须在原始字节层先拦 NUL）
 */
function looksLikeBinary(buffer: Buffer): boolean {
  let ctrl = 0
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i]
    if (b === 0) return true
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) ctrl++
  }
  if (buffer.length > 0 && ctrl / buffer.length > 0.05) return true
  const text = decodeText(buffer)
  if (!text) return false
  let bad = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if (ch === '\uFFFD' || (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0c)) {
      bad++
    }
  }
  return bad / text.length > 0.3
}

/** 与 /api/ocr 一致的中文提取提示词。 */
const OCR_PROMPT =
  '请识别并提取这张图片中的全部文字内容，保持原有的段落结构和标点符号。只返回提取的纯文字内容，不要加任何解释、前后缀或引号。'

/** 图片 mime 兜底：浏览器未提供 type 时按扩展名推断，保证 dataURI 前缀合法。 */
function normalizeImageMime(mime: string, filename: string): string {
  if (mime.startsWith('image/')) return mime
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.heic': 'image/heic',
  }
  return map[extOf(filename)] || 'image/png'
}

/** 图片 → 文字：复用 /api/ocr 的视觉模型链路（chatComplete + dataURI）。 */
async function parseImageOcr(buffer: Buffer, mime: string): Promise<string> {
  const { chatComplete } = await import('@/lib/ai')
  const { getAIConfig } = await import('@/lib/settings')
  let payload = buffer
  let payloadMime = mime
  // bmp/gif 等少数视觉模型不收的格式，先尝试用 sharp 转成 jpeg 再识别
  if (mime !== 'image/jpeg' && mime !== 'image/png' && mime !== 'image/webp') {
    try {
      const sharpMod = await import('sharp')
      const sharp = sharpMod.default
      payload = await sharp(buffer).jpeg({ quality: 90 }).toBuffer()
      payloadMime = 'image/jpeg'
    } catch {
      // 转不了就原样交给模型，失败再走友好错误
    }
  }
  try {
    const config = await getAIConfig()
    const dataURI = `data:${payloadMime};base64,${payload.toString('base64')}`
    const text = await chatComplete(
      [{ role: 'user', content: OCR_PROMPT, images: [dataURI] }],
      config,
    )
    return (typeof text === 'string' ? text : '').trim()
  } catch (e: unknown) {
    console.error('[POST /api/parse] image ocr failed:', e)
    throw new Error('图片AI识别失败：请重试，或换用「拍照识别导入」入口')
  }
}

/**
 * 音频转码兜底：ASR 后端只认 WAV/WebM，mp3/m4a/flac 等常见格式先用 ffmpeg
 * 转成低码率 WebM 再送识别。ffmpeg 不存在或转码失败时原样返回（由后端报错，
 * 错误信息会被 parseAudioAsr 翻译成友好中文提示）。
 */
async function ensureAsrFormat(buffer: Buffer, filename: string): Promise<Buffer> {
  const ext = extOf(filename)
  if (ext === '.wav' || ext === '.webm') return buffer
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawn } = await import('node:child_process')
  try {
    const dir = await mkdtemp(join(tmpdir(), 'parse-audio-'))
    try {
      const input = join(dir, `in${ext || '.bin'}`)
      await writeFile(input, buffer)
      const chunks: Buffer[] = []
      const proc = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', input,
        '-vn', '-ac', '1', '-ar', '16000',
        '-c:a', 'libopus', '-b:a', '32k',
        '-f', 'webm', 'pipe:1',
      ])
      proc.stdout.on('data', (c: Buffer) => chunks.push(c))
      // stderr 也要消费掉，避免管道缓冲区写满导致 ffmpeg 卡死
      proc.stderr.on('data', () => {})
      const code = await new Promise<number>((resolve, reject) => {
        proc.on('error', reject)
        proc.on('close', resolve)
      })
      const out = Buffer.concat(chunks)
      if (code === 0 && out.length > 0) return out
      return buffer
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  } catch {
    return buffer
  }
}

/** 音频 → 文字：z-ai SDK 语音转文字（与 /api/asr 的 zai 链路一致）。 */
async function parseAudioAsr(buffer: Buffer, filename: string): Promise<string> {
  const { getZAI } = await import('@/lib/zai')
  try {
    const payload = await ensureAsrFormat(buffer, filename)
    const zai = await getZAI()
    const response = await zai.audio.asr.create({ file_base64: payload.toString('base64') })
    return (typeof response?.text === 'string' ? response.text : '').trim()
  } catch (e: unknown) {
    // 后端原始报错多为英文技术信息，落服务端日志，给用户翻译过的提示
    console.error('[POST /api/parse] audio asr failed:', e)
    const raw = e instanceof Error ? e.message : String(e)
    const reason = /only WAV and WebM/i.test(raw)
      ? '该音频格式暂时无法识别，请换用 WAV 录音文件后重试'
      : /429|Too many|rate/i.test(raw)
        ? '服务繁忙，请稍后重试'
        : /network|timeout|ECONN/i.test(raw)
          ? '网络不稳定，请稍后重试'
          : '请重试，或确认音频中包含清晰人声'
    throw new Error(`语音转文字失败：${reason}`)
  }
}

/** 结构性首行（表格/图片/引用/代码块/列表/分隔线）不作为标题候选。 */
const NON_TITLE_LINE_RE = /^(\||!\[|>|```|---+|===+|[-*+]\s|\d+\.\s)/

/** 泛化章节标题（纯「第N章/页」或「工作表：」行）也不作为标题候选。 */
const GENERIC_HEADING_RE = /^(第[0-9一二三四五六七八九十百千零两]+[章节幕回页]|工作表[:：].*)$/

/**
 * Derive a title: filename minus extension by default; for non-text kinds
 * (pdf/docx/xlsx/pptx/epub/rtf/image/audio) prefer the first non-empty line
 * when it is plausible (2–40 chars) — falls back to the bare filename when
 * the first line looks like body text. Markdown 结构行与「第N页/工作表」泛化标题会被跳过。
 */
function deriveTitle(filename: string, content: string, kind: Kind): string {
  const dot = filename.lastIndexOf('.')
  const base = dot > 0 ? filename.slice(0, dot) : filename
  const fallback = base.trim() || '未命名背诵'

  if (kind === 'text') return fallback

  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (NON_TITLE_LINE_RE.test(line)) continue
    const text = line.replace(/^#{1,6}\s+/, '').trim()
    if (!text || GENERIC_HEADING_RE.test(text)) continue
    const stripped = text.replace(/[\s—–-]+$/, '').trim()
    return stripped.length >= 2 && stripped.length <= 40 ? stripped : fallback
  }
  return fallback
}

/** 各类型「提取结果为空」时的友好提示。 */
const EMPTY_HINTS: Partial<Record<Kind, string>> = {
  pdf: '未能从文件中提取到文字（可能是扫描版 PDF 或图片版 PDF，无文字层）。建议改用「拍照/AI 扫描」识别图片文字',
  image: '未能识别出图片中的文字（图片可能不含文字或清晰度不足）。建议换一张更清晰的图片，或改用「拍照识别导入」',
  audio: '未能从音频中识别到语音内容（可能无人声或时长过短）。建议确认录音清晰后重试',
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSessionUser()
    if (!session) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    const formData = await req.formData().catch(() => null)
    const file = formData?.get('file')
    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: '未提供文件' }, { status: 400 })
    }

    const filename = file.name || '未命名'
    const mime = file.type || ''
    let kind: Kind
    let knownText: boolean
    try {
      ;({ kind, knownText } = detectKind(filename, mime))
    } catch (err: unknown) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : '暂不支持该文件类型' },
        { status: 400 },
      )
    }

    // 大小限制：音频 30MB，其余 15MB
    const maxBytes = kind === 'audio' ? AUDIO_MAX_BYTES : MAX_BYTES
    if (file.size > maxBytes) {
      return NextResponse.json(
        {
          error:
            kind === 'audio'
              ? '音频过大，最大支持 30MB'
              : '文件过大，最大支持 15MB',
        },
        { status: 400 },
      )
    }
    if (file.size === 0) {
      return NextResponse.json({ error: '文件内容为空' }, { status: 400 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    let content = ''
    /** PDF 多引擎均失败时的真实报错（回传前端展示，不再吞掉） */
    let pdfEngineErrors: string[] = []

    // 解析超时保护：文档类 25s / 图片 OCR 60s / 音频 ASR 120s，
    // 超时返回友好提示而非挂死/500
    const withTimeout = <T>(p: Promise<T>, label: string, ms = 25000): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`${label}解析超时（${ms / 1000}s），文件可能过大或损坏`)), ms),
        ),
      ])

    if (kind === 'pdf') {
      // ---- 多引擎解析链（用户反馈 pdfjs 提取失败时自动切换引擎重试）----
      const enginePref = (formData?.get('engine') as string) || 'auto'
      const errors: string[] = []

      const tryUnpdf = async (): Promise<string> => {
        const { extractText, getDocumentProxy } = await import('unpdf')
        const pdf = await getDocumentProxy(new Uint8Array(buffer))
        const { text } = await extractText(pdf, { mergePages: true })
        return typeof text === 'string' ? text : String(text ?? '')
      }
      const tryPdfParse = async (): Promise<string> => {
        // ⚠️ pdfjs 跨引擎全局 worker 隔离（两层问题）：
        // 1) unpdf 内置 pdfjs 6.x，模块加载时无条件写 globalThis.pdfjsWorker；
        //    pdf-parse（pdfjs-dist 5.x）优先读该全局 → 版本不匹配必然抛
        //    "The API version 5.4.296 does not match the Worker version 6.4.299"。
        // 2) 打包器（Turbopack/webpack）把 pdfjs-dist 打进 chunk 后，其内部
        //    相对路径 import('pdf.worker.mjs') 兜底无法解析（chunk 目录下不存在）
        //    → "Setting up fake worker failed: Cannot find module"。
        // 修复：显式导入与 pdf-parse 配套的 pdfjs-dist 5.x worker 模块 ——
        // 该模块求值时的顶层副作用会把 globalThis.pdfjsWorker 设为正确的
        // 5.4.296 handler，pdf-parse 因此既不受 unpdf 污染、也不走坏掉的兜底。
        // 结束后恢复原全局，保证 unpdf（6.x）继续正常工作。
        const g = globalThis as { pdfjsWorker?: unknown }
        const savedWorker = g.pdfjsWorker
        let parser: InstanceType<typeof PDFParse> | null = null
        try {
          // pdfjs-dist worker 模块（求值副作用即设置 globalThis.pdfjsWorker）
          await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
          parser = new PDFParse({ data: new Uint8Array(buffer) })
          const result = await parser.getText({ pageJoiner: '\n\n' })
          return result?.text || ''
        } finally {
          await parser?.destroy().catch(() => {})
          if (savedWorker !== undefined) g.pdfjsWorker = savedWorker
          else delete g.pdfjsWorker
        }
      }
      // 质量检查：提取结果过短或乱码占比过高视为失败，继续下一个引擎。
      // \uFFFD（替换符）与 \u0000（NUL，部分 pdfjs 版本对 CJK 文档的假阳性输出）均计入乱码。
      const looksGood = (t: string): boolean => {
        if (!t || t.trim().length < 2) return false
        const bad = (t.match(/[\uFFFD\u0000]/g) || []).length
        return bad / t.length < 0.05
      }

      const chain: Array<{ name: string; run: () => Promise<string> }> =
        enginePref === 'unpdf'
          ? [{ name: 'unpdf', run: tryUnpdf }]
          : enginePref === 'pdf-parse'
            ? [{ name: 'pdf-parse', run: tryPdfParse }]
            : [
                { name: 'unpdf', run: tryUnpdf },
                { name: 'pdf-parse', run: tryPdfParse },
              ]

      for (const eng of chain) {
        try {
          const text = await withTimeout(
            eng.run().catch((e: unknown) => {
              throw new Error(
                `${eng.name} 引擎解析失败：${e instanceof Error ? e.message : '文件可能已损坏或加密'}`,
              )
            }),
            eng.name,
          )
          if (looksGood(text)) {
            content = text
            break
          }
          errors.push(`${eng.name}：提取内容为空或乱码`)
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e))
        }
      }
      if (!content && errors.length > 0) {
        console.error('[POST /api/parse] pdf engines failed:', errors.join(' | '))
        // 错误不再只进服务端日志：把引擎真实报错回传给前端（截断防膨胀），
        // 避免一律误导为「扫描版 PDF」
        pdfEngineErrors = errors.map((e) => e.slice(0, 160))
      }
    } else if (kind === 'docx') {
      if (!isZipBuffer(buffer)) {
        // 伪造/损坏的 docx（非 zip）直接友好报错，绝不透出 JSZip 英文原文
        throw new Error(
          'Word 文档解析失败：文件可能已损坏或不是有效的 .docx（旧版 .doc 请用 Word 另存为 .docx 后重试）',
        )
      }
      // 同时传 buffer（Node 版 unzip 用）+ arrayBuffer（browser-field 版 unzip 用）。
      // mammoth.convertToHtml 保留标题/加粗/列表/表格/链接；内嵌图片先转 dataURI，
      // 再统一入库换 /api/upload/<id> 短引用（EMF/WMF 等不可渲染 mime 会被丢弃）。
      const arrayBuffer = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      )
      try {
        content = await withTimeout(
          (async () => {
            const { value: html } = await mammoth.convertToHtml(
              { buffer, arrayBuffer },
              {
                convertImage: mammoth.images.imgElement(async (image) => {
                  const b64 = await image.readAsBase64String()
                  return { src: `data:${image.contentType};base64,${b64}` }
                }),
              },
            )
            return htmlToMarkdown(html || '', {
              resolveImage: (src) =>
                /^data:/i.test(src) ? saveDataUriImage(src) : Promise.resolve(null),
            })
          })(),
          'Word',
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : ''
        if (/超时/.test(msg)) throw e // 超时提示本身就是中文，原样透出
        throw new Error(
          'Word 文档解析失败：文件可能已损坏或不是有效的 .docx（旧版 .doc 请用 Word 另存为 .docx 后重试）',
        )
      }
    } else if (kind === 'xlsx') {
      content = await withTimeout(parseSpreadsheet(buffer, filename), 'Excel')
    } else if (kind === 'pptx') {
      content = await withTimeout(parsePptx(buffer), 'PPT')
    } else if (kind === 'epub') {
      content = await withTimeout(parseEpub(buffer), 'EPUB')
    } else if (kind === 'rtf') {
      content = parseRtf(buffer)
    } else if (kind === 'image') {
      content = await withTimeout(
        parseImageOcr(buffer, normalizeImageMime(mime, filename)),
        '图片识别',
        60000,
      )
    } else if (kind === 'audio') {
      content = await withTimeout(parseAudioAsr(buffer, filename), '语音转文字', 120000)
    } else {
      // text：未知扩展名先做二进制检测，避免把乱码当正文返回
      if (!knownText && looksLikeBinary(buffer)) {
        return NextResponse.json(
          {
            error:
              '无法从该文件提取文本内容。支持的类型：PDF、Word、Excel、PPT、EPUB、图片（OCR识别）、音频（语音转文字）、各类文本/代码/字幕文件',
          },
          { status: 422 },
        )
      }
      content = decodeText(buffer)
      const ext = extOf(filename)
      if (ext === '.srt' || ext === '.vtt') {
        // 字幕文件：剥掉序号/时间轴/WEBVTT 头/NOTE 注释，只留台词
        content = parseSubtitle(content)
      } else if (
        HTML_EXTS.includes(ext) ||
        mime === 'text/html' ||
        mime === 'application/xhtml+xml'
      ) {
        // HTML/XHTML：保留标题/加粗/列表/表格/图片（http 外链图片原样保留，data: 图片入库）
        content = await withTimeout(
          htmlToMarkdown(content, {
            resolveImage: (src) => {
              if (/^https?:\/\//i.test(src)) return Promise.resolve(src)
              if (/^data:/i.test(src)) return saveDataUriImage(src)
              return Promise.resolve(null) // 相对路径本地图片无法解析，丢弃
            },
          }),
          '网页',
        )
      }
    }

    content = tidyText(content)
    if (!content) {
      const hint = EMPTY_HINTS[kind] ?? '未能从文件中提取到文字（可能是空文档）'
      return NextResponse.json(
        {
          error:
            pdfEngineErrors.length > 0
              ? `${hint}。引擎详情：${pdfEngineErrors.join('；').slice(0, 300)}`
              : hint,
          engineErrors: pdfEngineErrors.length > 0 ? pdfEngineErrors : undefined,
        },
        { status: 422 },
      )
    }

    const title = deriveTitle(filename, content, kind)
    return NextResponse.json({ title, content })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/parse] failed:', err)
    // 解析类错误（超时/损坏/格式异常/识别失败）返回 422 友好中文提示，不炸前端；
    // 其余意外错误（DB/文件系统等）不透出英文原文，只给通用中文 + 服务端日志
    const isParseError = /解析|超时|损坏|提取|识别|转文字/.test(msg)
    return NextResponse.json(
      {
        error: isParseError ? msg : '文件解析失败：请重试，或换用其他支持的格式',
      },
      { status: isParseError ? 422 : 500 },
    )
  }
}
