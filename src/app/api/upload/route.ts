// POST /api/upload — 图片/音频/视频服务器上传（编辑器「插入图片」与富媒体引用转存）。
// Body: { url?: string, dataUrl?: string, name?: string }
//   • url    → 服务端抓取远程文件（按 Content-Type 判类型与大小），转存 base64
//   • dataUrl→ 直接存（data:<mime>;base64,xxx）
// 类型：图片（jpeg/png/webp/gif/bmp/svg）、常见音频（audio/* 全放行）、
//       常见视频（mp4/webm/quicktime/m4v/ogg）。
// 大小：图片 ≤ 3MB；音频/视频 ≤ 30MB（超限返回 413）。
// 返回 { id, url: "/api/upload/<id>", mime }，正文用该 URL 引用即不再依赖外部图床。
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'

export const runtime = 'nodejs'

const IMAGE_MAX_BYTES = 3 * 1024 * 1024 // 图片 3MB
const AV_MAX_BYTES = 30 * 1024 * 1024 // 音频/视频 30MB

const IMAGE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/svg+xml',
])

const VIDEO_MIME = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-m4v',
  'video/ogg',
])

type UploadKind = 'image' | 'av'

/** mime → 入库类别；audio/* 全放行（常见音频 mime 一网打尽），不认识返回 null。 */
function classifyMime(mime: string): UploadKind | null {
  const m = mime.toLowerCase()
  if (IMAGE_MIME.has(m)) return 'image'
  if (m.startsWith('audio/') || VIDEO_MIME.has(m)) return 'av'
  return null
}

/** 按类别返回超限响应（图片沿用 400 旧文案；音频/视频 413）。 */
function tooLargeResponse(kind: UploadKind): NextResponse {
  if (kind === 'image') {
    return NextResponse.json(
      { error: '图片过大（最大 3MB），未保存到服务器' },
      { status: 400 },
    )
  }
  return NextResponse.json({ error: '音频/视频不能超过 30MB' }, { status: 413 })
}

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }
    const body = await req.json().catch(() => ({}))

    let mime = ''
    let base64 = ''

    if (typeof body?.dataUrl === 'string' && body.dataUrl.startsWith('data:')) {
      // dataURL 直传：data:image/jpeg;base64,xxxx（[\s\S] 兼容任意字符，不依赖 es2018 s 标志）
      const m = /^data:([^;,]+);base64,([\s\S]+)$/.exec(body.dataUrl)
      if (!m) {
        return NextResponse.json({ error: '文件 dataURL 格式不正确' }, { status: 400 })
      }
      mime = m[1].toLowerCase()
      base64 = m[2]
    } else if (typeof body?.url === 'string' && /^https?:\/\//i.test(body.url)) {
      // 远程链接 → 服务端抓取，按 Content-Type 判断类型与大小
      const res = await fetch(body.url, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BeishuBa/1.0)' },
      }).catch(() => null)
      if (!res || !res.ok) {
        return NextResponse.json({ error: '无法下载该链接，请检查地址' }, { status: 400 })
      }
      mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      const remoteKind = classifyMime(mime)
      if (!remoteKind) {
        return NextResponse.json(
          { error: '该链接不是支持的图片/音频/视频类型' },
          { status: 400 },
        )
      }
      const remoteLimit = remoteKind === 'image' ? IMAGE_MAX_BYTES : AV_MAX_BYTES
      // Content-Length 预检：超大文件不必读进内存
      const declared = parseInt(res.headers.get('content-length') || '', 10)
      if (Number.isFinite(declared) && declared > remoteLimit) {
        return tooLargeResponse(remoteKind)
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.byteLength > remoteLimit) {
        return tooLargeResponse(remoteKind)
      }
      base64 = buf.toString('base64')
    } else {
      return NextResponse.json({ error: '请提供文件链接或 dataURL' }, { status: 400 })
    }

    const kind = classifyMime(mime)
    if (!kind) {
      return NextResponse.json(
        { error: '不支持的文件类型（仅支持图片与常见音频/视频）' },
        { status: 400 },
      )
    }
    const limit = kind === 'image' ? IMAGE_MAX_BYTES : AV_MAX_BYTES
    const bytes = Math.floor((base64.length * 3) / 4)
    if (bytes > limit) {
      return tooLargeResponse(kind)
    }

    const row = await db.upload.create({
      data: { mime, data: base64, bytes },
    })
    return NextResponse.json(
      { id: row.id, url: `/api/upload/${row.id}`, mime },
      { status: 201 },
    )
  } catch (err: unknown) {
    // 原始报错多为英文技术信息，只进服务端日志，给用户友好中文
    console.error('[POST /api/upload] failed:', err)
    return NextResponse.json({ error: '上传失败，请稍后重试' }, { status: 500 })
  }
}
