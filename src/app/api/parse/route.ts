// POST /api/parse — file upload text extraction for the import flow.
// multipart/form-data, field "file". Requires a session.
//
// Accepted:
//   .pdf  → pdf-parse v2 (class API: new PDFParse({ data }).getText())
//   .docx → mammoth.extractRawText({ buffer })
//   .txt / .md / .markdown / any text/* → UTF-8 decode with GB18030 fallback
//     (many Chinese .txt files on disk are GBK-encoded; UTF-8 is tried strictly
//      first and GB18030 is used when strict UTF-8 decoding fails)
// Anything else is rejected with a Chinese error message. Max size: 15 MB.
//
// Note on pdf-parse: the installed version is v2.x, a full TypeScript rewrite
// with an explicit class API — it does NOT have the v1 "debug mode" problem
// (index.js reading ./test/data/*.pdf when !module.parent), so no deep import
// of 'pdf-parse/lib/pdf-parse.js' is needed.
import { NextRequest, NextResponse } from 'next/server'
import { PDFParse } from 'pdf-parse'
import mammoth from 'mammoth'
import { getSessionUser } from '@/lib/auth'

export const runtime = 'nodejs'

const MAX_BYTES = 15 * 1024 * 1024 // 15 MB

type Kind = 'pdf' | 'docx' | 'text'

const TEXT_EXTS = ['.txt', '.md', '.markdown', '.text', '.mdown', '.mkd']

/** Decide how to parse a file from its extension + mime type. Throws when unsupported. */
function detectKind(filename: string, mime: string): Kind {
  const name = filename.toLowerCase()
  const ext = name.slice(name.lastIndexOf('.')) // includes the dot
  if (ext === '.pdf' || mime === 'application/pdf') return 'pdf'
  if (
    ext === '.docx' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'docx'
  }
  if (ext === '.doc') {
    throw new Error('暂不支持旧版 .doc 文件，请先在 Word 中另存为 .docx 后上传')
  }
  if (TEXT_EXTS.includes(ext) || mime.startsWith('text/')) return 'text'
  throw new Error('暂不支持该文件类型，请上传 PDF、Word(.docx) 或文本文件（txt/md）')
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

/**
 * Derive a title: filename minus extension by default; for pdf/docx prefer the
 * first non-empty line when it is plausible (2–40 chars) — falls back to the
 * bare filename when the first line looks like body text.
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
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: '文件过大，最大支持 15MB' },
        { status: 400 },
      )
    }
    if (file.size === 0) {
      return NextResponse.json({ error: '文件内容为空' }, { status: 400 })
    }

    const filename = file.name || '未命名'
    const mime = file.type || ''
    let kind: Kind
    try {
      kind = detectKind(filename, mime)
    } catch (err: unknown) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : '暂不支持该文件类型' },
        { status: 400 },
      )
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    let content = ''

    if (kind === 'pdf') {
      const parser = new PDFParse({ data: new Uint8Array(buffer) })
      try {
        // Clean page boundary: no "-- 1 of 1 --" markers, just a blank line.
        const result = await parser.getText({ pageJoiner: '\n\n' })
        content = result.text || ''
      } finally {
        await parser.destroy().catch(() => {})
      }
    } else if (kind === 'docx') {
      // Pass BOTH `buffer` (Node path) and `arrayBuffer` (browser-field path).
      // Under a standalone production build where mammoth is NOT listed in
      // serverExternalPackages, its `browser` field would remap unzip.js to a
      // build that only reads options.arrayBuffer — supplying both keeps the
      // call robust regardless of which unzip implementation is loaded.
      const arrayBuffer = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      )
      const { value } = await mammoth.extractRawText({
        buffer,
        arrayBuffer,
      })
      content = value || ''
    } else {
      content = decodeText(buffer)
    }

    content = tidyText(content)
    if (!content) {
      return NextResponse.json(
        { error: '未能从文件中提取到文字（可能是扫描版 PDF 或空文档）' },
        { status: 422 },
      )
    }

    const title = deriveTitle(filename, content, kind)
    return NextResponse.json({ title, content })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/parse] failed:', err)
    return NextResponse.json(
      { error: `文件解析失败：${msg}` },
      { status: 500 },
    )
  }
}
