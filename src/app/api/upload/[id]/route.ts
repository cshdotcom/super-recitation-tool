// GET /api/upload/:id — 图片服务器读取（公开：访客分享视图也要渲染图片）。
// 内容按 id 不可变 → 长缓存；找不到返回 404 JSON。
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const runtime = 'nodejs'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const row = await db.upload.findUnique({ where: { id } })
    if (!row) {
      return NextResponse.json({ error: '图片不存在' }, { status: 404 })
    }
    const buf = Buffer.from(row.data, 'base64')
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type': row.mime || 'image/jpeg',
        'Content-Length': String(buf.byteLength),
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[GET /api/upload/:id] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
