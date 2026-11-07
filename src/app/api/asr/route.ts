// Speech-to-text via the z-ai SDK.
// POST /api/asr   (multipart/form-data, field name "file") -> { text }
import { NextRequest, NextResponse } from 'next/server'
import { getZAI } from '@/lib/zai'

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File | null
    if (!file) {
      return NextResponse.json({ error: '未提供音频' }, { status: 400 })
    }
    const buf = Buffer.from(await file.arrayBuffer())
    const base64 = buf.toString('base64')

    const zai = await getZAI()
    const response = await zai.audio.asr.create({ file_base64: base64 })
    const text: string =
      typeof response?.text === 'string' ? response.text : ''
    return NextResponse.json({ text })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/asr] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
