// POST /api/upload — 图片服务器上传（编辑器「插入图片链接」可选转存）。
// Body: { url?: string, dataUrl?: string, name?: string }
//   • url    → 服务端抓取远程图片（校验 image/* 与 ≤3MB），转存 base64
//   • dataUrl→ 直接存（data:image/...;base64,xxx，≤3MB 解码后）
// 返回 { id, url: "/api/upload/<id>" }，正文用该 URL 引用即不再依赖外部图床。
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'

export const runtime = 'nodejs'

const MAX_BYTES = 3 * 1024 * 1024 // 3MB

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/svg+xml',
])

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
        return NextResponse.json({ error: '图片 dataURL 格式不正确' }, { status: 400 })
      }
      mime = m[1].toLowerCase()
      base64 = m[2]
    } else if (typeof body?.url === 'string' && /^https?:\/\//i.test(body.url)) {
      // 远程链接 → 服务端抓取
      const res = await fetch(body.url, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BeishuBa/1.0)' },
      }).catch(() => null)
      if (!res || !res.ok) {
        return NextResponse.json({ error: '无法下载该图片链接，请检查地址' }, { status: 400 })
      }
      mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      if (!ALLOWED_MIME.has(mime)) {
        return NextResponse.json({ error: '该链接不是支持的图片类型' }, { status: 400 })
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.byteLength > MAX_BYTES) {
        return NextResponse.json(
          { error: '图片过大（最大 3MB），未保存到服务器' },
          { status: 400 },
        )
      }
      base64 = buf.toString('base64')
    } else {
      return NextResponse.json({ error: '请提供图片链接或 dataURL' }, { status: 400 })
    }

    if (!ALLOWED_MIME.has(mime)) {
      return NextResponse.json({ error: '不支持的图片类型' }, { status: 400 })
    }
    const bytes = Math.floor((base64.length * 3) / 4)
    if (bytes > MAX_BYTES) {
      return NextResponse.json(
        { error: '图片过大（最大 3MB），未保存到服务器' },
        { status: 400 },
      )
    }

    const row = await db.upload.create({
      data: { mime, data: base64, bytes },
    })
    return NextResponse.json({ id: row.id, url: `/api/upload/${row.id}` }, { status: 201 })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/upload] failed:', err)
    return NextResponse.json({ error: `上传失败：${msg}` }, { status: 500 })
  }
}
