// OCR via the configured AI provider's vision model (z-ai SDK or any
// OpenAI-compatible endpoint — see src/lib/ai.ts chatComplete).
// Supports two input shapes:
//   1) multipart/form-data, field "file"  (backward compatible, no crop)
//   2) application/json: { image: dataURI, crop?: { x, y, width, height } }
// When `crop` is provided (pixel coords on the natural image, as produced by
// react-easy-crop's onCropComplete `croppedAreaPixels`), the image is cropped
// server-side with sharp before being sent to the vision model.
import sharp from 'sharp'
import { NextRequest, NextResponse } from 'next/server'
import { chatComplete } from '@/lib/ai'
import { getAIConfig } from '@/lib/settings'

interface CropBox {
  x: number
  y: number
  width: number
  height: number
}

interface OcrJsonBody {
  image?: string
  crop?: CropBox
}

// Parse a data URI ("data:image/jpeg;base64,....") into { buffer, mime }.
function parseDataURI(dataURI: string): { buffer: Buffer; mime: string } {
  const match = /^data:([^;]+);base64,([\s\S]*)$/.exec(dataURI.trim())
  if (!match) throw new Error('图片格式不正确，需为 data URI')
  const mime = match[1] || 'image/jpeg'
  const buffer = Buffer.from(match[2], 'base64')
  return { buffer, mime }
}

const OCR_PROMPT =
  '请识别并提取这张图片中的全部文字内容，保持原有的段落结构和标点符号。只返回提取的纯文字内容，不要加任何解释、前后缀或引号。'

async function runVision(buffer: Buffer, mime: string): Promise<string> {
  const config = await getAIConfig()
  const dataURI = `data:${mime};base64,${buffer.toString('base64')}`
  return chatComplete(
    [{ role: 'user', content: OCR_PROMPT, images: [dataURI] }],
    config
  )
}

export async function POST(req: NextRequest) {
  try {
    let buffer: Buffer
    let mime: string
    let crop: CropBox | undefined

    const contentType = req.headers.get('content-type') || ''

    if (contentType.includes('application/json')) {
      const body = (await req.json()) as OcrJsonBody
      if (!body.image) {
        return NextResponse.json({ error: '未提供图片' }, { status: 400 })
      }
      const parsed = parseDataURI(body.image)
      buffer = parsed.buffer
      mime = parsed.mime
      crop = body.crop
    } else {
      const formData = await req.formData()
      const file = formData.get('file') as File | null
      if (!file) {
        return NextResponse.json({ error: '未提供图片' }, { status: 400 })
      }
      buffer = Buffer.from(await file.arrayBuffer())
      mime = file.type || 'image/jpeg'
    }

    // Crop server-side when a crop box is supplied.
    if (
      crop &&
      crop.width > 0 &&
      crop.height > 0 &&
      Number.isFinite(crop.x) &&
      Number.isFinite(crop.y)
    ) {
      const left = Math.round(crop.x)
      const top = Math.round(crop.y)
      const width = Math.round(crop.width)
      const height = Math.round(crop.height)
      // Clamp to ≥1px to avoid sharp errors on tiny crops.
      const safeWidth = Math.max(1, width)
      const safeHeight = Math.max(1, height)
      try {
        buffer = await sharp(buffer)
          .extract({ left, top, width: safeWidth, height: safeHeight })
          .toBuffer()
      } catch (extractErr) {
        // Crop region exceeded image bounds or other sharp error — fall back to
        // the full image rather than failing the whole OCR.
        console.warn('[POST /api/ocr] crop extract failed, using full image:', extractErr)
      }
    }

    const text = await runVision(buffer, mime)
    return NextResponse.json({ text })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/ocr] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
