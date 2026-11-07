// Text-to-speech via the z-ai SDK.
// POST /api/tts   { text, voice?, speed? }  -> audio/wav
//
// Splits the text into chunks of <=900 chars along Chinese / English sentence
// boundaries, synthesises each chunk as WAV, extracts the PCM payload from
// each WAV (the SDK emits non-standard AIGC/LIST chunks before `data`), and
// concatenates the PCM into a single valid WAV file.
import { NextRequest, NextResponse } from 'next/server'
import { getZAI } from '@/lib/zai'

const MAX_CHUNK = 900

interface FmtInfo {
  channels: number
  sampleRate: number
  bitsPerSample: number
}

/** Split text into chunks no longer than maxLen, breaking on sentence boundaries. */
function splitTextIntoChunks(text: string, maxLen = MAX_CHUNK): string[] {
  if (text.length <= maxLen) return [text]
  const chunks: string[] = []
  const parts = text.match(/[^。！？!?.\n]*[。！？!?.\n]?/g) || [text]
  let buf = ''
  for (const p of parts) {
    if (!p) continue
    if (p.length > maxLen) {
      if (buf) {
        chunks.push(buf)
        buf = ''
      }
      for (let i = 0; i < p.length; i += maxLen) {
        chunks.push(p.slice(i, i + maxLen))
      }
      continue
    }
    if ((buf + p).length > maxLen) {
      if (buf) chunks.push(buf)
      buf = p
    } else {
      buf += p
    }
  }
  if (buf) chunks.push(buf)
  return chunks.filter((c) => c.length > 0)
}

/** Walk the RIFF chunks of a WAV buffer, returning the fmt info and the PCM data. */
function parseWav(buf: Buffer): { fmt: FmtInfo; pcm: Buffer } {
  let fmt: FmtInfo | null = null
  let pcm = Buffer.alloc(0)
  let i = 12 // skip "RIFF" + size + "WAVE"
  while (i + 8 <= buf.length) {
    const id = buf.slice(i, i + 4).toString('latin1')
    const size = buf.readUInt32LE(i + 4)
    const bodyStart = i + 8
    const bodyEnd = Math.min(bodyStart + size, buf.length)
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(bodyStart + 2),
        sampleRate: buf.readUInt32LE(bodyStart + 4),
        bitsPerSample: buf.readUInt16LE(bodyStart + 14),
      }
    } else if (id === 'data') {
      pcm = buf.slice(bodyStart, bodyEnd)
    }
    i += 8 + size + (size % 2)
  }
  if (!fmt) fmt = { channels: 1, sampleRate: 24000, bitsPerSample: 16 }
  return { fmt, pcm }
}

/** Build a canonical 44-byte-header WAV from raw PCM. */
function buildWav(pcm: Buffer, fmt: FmtInfo): Buffer {
  const byteRate = (fmt.sampleRate * fmt.channels * fmt.bitsPerSample) / 8
  const blockAlign = (fmt.channels * fmt.bitsPerSample) / 8
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(fmt.channels, 22)
  header.writeUInt32LE(fmt.sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(fmt.bitsPerSample, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const text: string = typeof body?.text === 'string' ? body.text : ''
    if (!text.trim()) {
      return NextResponse.json({ error: '文本不能为空' }, { status: 400 })
    }
    const voice: string =
      typeof body?.voice === 'string' && body.voice.trim()
        ? body.voice.trim()
        : 'tongtong'
    let speed: number =
      typeof body?.speed === 'number' && Number.isFinite(body.speed)
        ? body.speed
        : 1.0
    if (speed < 0.5) speed = 0.5
    if (speed > 2.0) speed = 2.0

    const chunks = splitTextIntoChunks(text, MAX_CHUNK)
    const zai = await getZAI()
    const pcms: Buffer[] = []
    let fmt: FmtInfo | null = null

    for (const chunk of chunks) {
      const r = await zai.audio.tts.create({
        input: chunk,
        voice,
        speed,
        response_format: 'wav',
        stream: false,
      })
      const buf = Buffer.from(new Uint8Array(await r.arrayBuffer()))
      const parsed = parseWav(buf)
      if (!fmt) fmt = parsed.fmt
      pcms.push(parsed.pcm)
    }

    const mergedPcm = Buffer.concat(pcms)
    const wav = buildWav(mergedPcm, fmt ?? { channels: 1, sampleRate: 24000, bitsPerSample: 16 })

    return new NextResponse(wav, {
      status: 200,
      headers: {
        'Content-Type': 'audio/wav',
        'Cache-Control': 'no-cache',
        'Content-Length': String(wav.length),
      },
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/tts] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
