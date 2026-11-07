// OCR via the z-ai vision model.
// POST /api/ocr   (multipart/form-data, field name "file")
import { NextRequest, NextResponse } from 'next/server'
import { getZAI } from '@/lib/zai'

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File | null
    if (!file) {
      return NextResponse.json({ error: '未提供图片' }, { status: 400 })
    }
    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    const base64 = buffer.toString('base64')
    const mime = file.type || 'image/jpeg'

    const zai = await getZAI()
    const response = await zai.chat.completions.createVision({
      model: 'glm-4.6v',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '请识别并提取这张图片中的全部文字内容，保持原有的段落结构和标点符号。只返回提取的纯文字内容，不要加任何解释、前后缀或引号。',
            },
            {
              type: 'image_url',
              image_url: { url: `data:${mime};base64,${base64}` },
            },
          ],
        },
      ],
      thinking: { type: 'disabled' },
    })
    const text = response.choices?.[0]?.message?.content ?? ''
    return NextResponse.json({ text })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/ocr] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
