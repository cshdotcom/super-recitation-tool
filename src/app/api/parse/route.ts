// POST /api/parse — file upload text extraction for the import flow.
// multipart/form-data, field "file". Requires a session.
//
// Accepted (任意类型都有处理路径，全部在服务端分流):
//   .pdf   → 多引擎解析链：unpdf（现代 pdf.js 构建）→ pdf-parse v2 兜底
//            可通过 formData 字段 engine 指定：auto(默认) | unpdf | pdf-parse
//   .docx  → mammoth.extractRawText({ buffer })
//   .xlsx / .xls → SheetJS 遍历全部工作表转 CSV，每表前加【工作表: 名称】标题行
//   .pptx  → JSZip 解包 ppt/slides/slideN.xml，按页提取 <a:t> 文本，页前加【第N页】
//   .epub  → JSZip 解包 container.xml → OPF manifest+spine，按阅读顺序提取 xhtml 正文
//   .rtf   → 剥离 RTF 控制字（\'xx 十六进制按 GBK/UTF-8 解码，失败则忽略）
//   图片 png/jpg/jpeg/webp/gif/bmp/heic → AI 视觉模型 OCR 识别文字（60s 超时）
//   音频 mp3/wav/m4a/aac/ogg/webm/amr/flac → AI 语音转文字（120s 超时，上限 30MB；
//            非 WAV/WebM 先经 ffmpeg 转码，ffmpeg 不可用时原样送识别）
//   .doc / .ppt → 旧版格式友好报错（建议另存为 .docx / .pptx）
//   文本类（txt/md/csv/json/xml/html/srt/vtt/代码…）→ UTF-8 strict 解码，
//     失败回退 GB18030（很多中文 txt 是 GBK 编码）；HTML 类文件剥离标签只留文本
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

/** Excel（xlsx/xls）：遍历全部工作表转 CSV，每表前加【工作表: 名称】标题行。 */
async function parseSpreadsheet(buffer: Buffer): Promise<string> {
  // xlsx 同时存在 ESM/CJS 两种产物，做一次 default 互取保证两种形态都能用
  const mod = await import('xlsx')
  const XLSX = (mod as unknown as { default?: typeof mod }).default ?? mod
  let workbook: ReturnType<typeof XLSX.read>
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' })
  } catch {
    throw new Error('Excel 解析失败：文件可能已损坏或不是有效的 Excel 文件')
  }
  const parts: string[] = []
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]
    if (!sheet) continue
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false })
    const body = csv.replace(/\r\n?/g, '\n').trim()
    if (!body) continue
    parts.push(`【工作表: ${name}】\n${body}`)
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

/** PPTX：解包 ppt/slides/slideN.xml（按页码排序），提取每页 <a:t> 文本。 */
async function parsePptx(buffer: Buffer): Promise<string> {
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
  for (const slide of slides) {
    const xml = await zip.files[slide.path].async('string')
    // 每页按段落（<a:p>）聚合 <a:t> 文本块，避免不同段落的文字粘连
    const lines = xml
      .split(/<\/a:p>/)
      .map((para) =>
        Array.from(para.matchAll(/<a:t>([^<]*)<\/a:t>/g), (m) => decodeEntities(m[1])).join(''),
      )
      .filter((line) => line.length > 0)
    if (lines.length > 0) pages.push(`【第${slide.num}页】\n${lines.join('\n')}`)
  }
  if (pages.length === 0) {
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

/** EPUB：container.xml → OPF 路径 → manifest+spine 阅读顺序 → 逐个 xhtml 提取正文。 */
async function parseEpub(buffer: Buffer): Promise<string> {
  let zip: JSZip | null = null
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    throw new Error('EPUB 解析失败：文件可能已损坏或不是有效的 .epub 文件')
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

  // manifest：id → href（属性顺序不定，逐个提取）
  const manifest = new Map<string, string>()
  for (const tag of opfXml.matchAll(/<item\b[^>]*>/g)) {
    const id = /\bid="([^"]*)"/.exec(tag[0])?.[1]
    const href = /\bhref="([^"]*)"/.exec(tag[0])?.[1]
    if (id && href) manifest.set(id, decodeEntities(href))
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
  for (const id of spineIds) {
    const href = manifest.get(id)
    if (!href) continue
    const path = joinZipPath(baseDir, href)
    const file =
      zip.file(path) ?? zip.file(joinZipPath(baseDir, safeDecodeURI(href)))
    if (!file) continue
    const html = await file.async('string')
    const text = htmlToText(html)
    if (text) parts.push(text)
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

/**
 * Derive a title: filename minus extension by default; for non-text kinds
 * (pdf/docx/xlsx/pptx/epub/rtf/image/audio) prefer the first non-empty line
 * when it is plausible (2–40 chars) — falls back to the bare filename when
 * the first line looks like body text.
 */
function deriveTitle(filename: string, content: string, kind: Kind): string {
  const dot = filename.lastIndexOf('.')
  const base = dot > 0 ? filename.slice(0, dot) : filename
  const fallback = base.trim() || '未命名背诵'

  if (kind === 'text') return fallback

  const firstLine = content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (firstLine) {
    const stripped = firstLine.replace(/[\s—–-]+$/, '').trim()
    if (stripped.length >= 2 && stripped.length <= 40) {
      return stripped
    }
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
      // 同时传 buffer（Node 版 unzip 用）+ arrayBuffer（browser-field 版 unzip 用）。
      const arrayBuffer = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      )
      const { value } = await withTimeout(
        mammoth.extractRawText({ buffer, arrayBuffer }).catch((e: unknown) => {
          throw new Error(
            `Word 解析失败：${e instanceof Error ? e.message : '文件可能已损坏或不是有效的 .docx'}`,
          )
        }),
        'Word',
      )
      content = value || ''
    } else if (kind === 'xlsx') {
      content = await withTimeout(parseSpreadsheet(buffer), 'Excel')
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
      // HTML 类文件剥离标签只留正文文本
      if (
        HTML_EXTS.includes(extOf(filename)) ||
        mime === 'text/html' ||
        mime === 'application/xhtml+xml'
      ) {
        content = htmlToText(content)
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
    // 解析类错误（超时/损坏/格式异常/识别失败）返回 422 友好提示，不炸前端
    const isParseError = /解析|超时|损坏|提取|识别|转文字/.test(msg)
    return NextResponse.json(
      {
        error: isParseError ? msg : `文件解析失败：${msg}`,
      },
      { status: isParseError ? 422 : 500 },
    )
  }
}
