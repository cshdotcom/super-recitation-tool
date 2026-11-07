// Text-to-speech — provider-aware.
// POST /api/tts   { text, voice?, speed?, provider? }
//
// Providers (request `provider` overrides the settings ttsProvider):
//   zai     -> z-ai SDK (default). Splits the text into <=900-char chunks on
//              sentence boundaries, synthesises each chunk as WAV, extracts
//              the PCM payload from each WAV (the SDK emits non-standard
//              AIGC/LIST chunks before `data`), and concatenates the PCM into
//              a single valid 44-byte-header WAV file. -> audio/wav
//   custom  -> any OpenAI-compatible POST {baseURL}/audio/speech endpoint.
//              Each chunk is requested as mp3 (frames concatenate); accepts
//              raw audio/* responses or JSON envelopes with base64 audio
//              (b64 / audio_b64 / data). -> upstream content-type or audio/mpeg
//   browser -> Web Speech API on the client; the server only answers 400
//              browser_mode (graceful fallback — the client normally won't
//              call this endpoint in that mode).
import { NextRequest, NextResponse } from 'next/server'
import { getZAI } from '@/lib/zai'
import { getSessionUser } from '@/lib/auth'
import { db } from '@/lib/db'

const MAX_CHUNK = 900
const SETTINGS_ID = 'singleton'

type TtsProvider = 'zai' | 'custom' | 'browser'

interface FmtInfo {
  channels: number
  sampleRate: number
  bitsPerSample: number
}

function asProvider(v: unknown): TtsProvider | null {
  return v === 'zai' || v === 'custom' || v === 'browser' ? v : null
}

function readString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * Defensive settings read: parseSettings() in src/lib/settings.ts may not
 * surface the tts* fields yet (another agent owns that file), so read the
 * raw DB row directly and fall back gracefully (missing row/columns/DB -> zai).
 */
async function getTtsSettings(): Promise<{
  provider: TtsProvider
  baseURL: string
  apiKey: string
  model: string
}> {
  try {
    const row = (await db.settings.findUnique({
      where: { id: SETTINGS_ID },
    })) as unknown as Record<string, unknown> | null
    return {
      provider: asProvider(row?.ttsProvider) ?? 'zai',
      baseURL: readString(row?.ttsBaseURL),
      apiKey: readString(row?.ttsApiKey),
      model: readString(row?.ttsModel),
    }
  } catch {
    // Schema/migration not applied yet — fall back to the built-in z-ai SDK.
    return { provider: 'zai', baseURL: '', apiKey: '', model: '' }
  }
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

/**
 * One OpenAI-compatible /audio/speech call for a single chunk.
 * Accepts either raw audio/* bytes or a JSON envelope with base64 audio
 * (b64 / audio_b64 / data fields).
 */
async function synthesizeCustomChunk(opts: {
  baseURL: string
  apiKey: string
  model: string
  chunk: string
  voice: string
  speed: number
}): Promise<{ buffer: Buffer; contentType: string }> {
  const url = `${opts.baseURL.replace(/\/$/, '')}/audio/speech`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model || 'tts-1',
      input: opts.chunk,
      voice: opts.voice || 'alloy',
      speed: opts.speed,
      response_format: 'mp3',
      stream: false,
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`第三方 TTS 请求失败 (${res.status}): ${detail.slice(0, 200)}`)
  }
  const contentType = (res.headers.get('content-type') || '').toLowerCase()
  if (contentType.startsWith('audio/')) {
    return {
      buffer: Buffer.from(new Uint8Array(await res.arrayBuffer())),
      contentType,
    }
  }
  // JSON envelope carrying base64 audio.
  let payload: Record<string, unknown> = {}
  try {
    payload = (await res.json()) as Record<string, unknown>
  } catch {
    throw new Error('第三方 TTS 返回格式异常（既非 audio 也非 JSON）')
  }
  const b64 = [payload.b64, payload.audio_b64, payload.data].find(
    (v) => typeof v === 'string' && v.length > 0
  )
  if (typeof b64 === 'string') {
    return { buffer: Buffer.from(b64, 'base64'), contentType: 'audio/mpeg' }
  }
  throw new Error('第三方 TTS 返回 JSON 中缺少音频数据（b64/audio_b64/data）')
}

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    const body = await req.json().catch(() => ({}))
    const text: string = typeof body?.text === 'string' ? body.text : ''
    if (!text.trim()) {
      return NextResponse.json({ error: '文本不能为空' }, { status: 400 })
    }
    const rawVoice: string =
      typeof body?.voice === 'string' && body.voice.trim()
        ? body.voice.trim()
        : ''
    let speed: number =
      typeof body?.speed === 'number' && Number.isFinite(body.speed)
        ? body.speed
        : 1.0
    if (speed < 0.5) speed = 0.5
    if (speed > 2.0) speed = 2.0

    // Provider: request override > settings ttsProvider > 'zai'.
    const settings = await getTtsSettings()
    const provider: TtsProvider = asProvider(body?.provider) ?? settings.provider

    if (provider === 'browser') {
      return NextResponse.json(
        {
          error: 'browser_mode',
          message: '浏览器模式由前端 Web Speech API 合成，无需服务端',
        },
        { status: 400 }
      )
    }

    const chunks = splitTextIntoChunks(text, MAX_CHUNK)

    if (provider === 'custom') {
      if (!settings.baseURL || !settings.apiKey) {
        return NextResponse.json(
          { error: '请先在设置中配置第三方 TTS API' },
          { status: 400 }
        )
      }
      const voice = rawVoice || 'alloy'
      const parts: Buffer[] = []
      let upstreamType = ''
      for (const chunk of chunks) {
        const r = await synthesizeCustomChunk({
          baseURL: settings.baseURL,
          apiKey: settings.apiKey,
          model: settings.model,
          chunk,
          voice,
          speed,
        })
        if (!upstreamType) upstreamType = r.contentType
        parts.push(r.buffer)
      }
      const audio = Buffer.concat(parts)
      return new NextResponse(audio, {
        status: 200,
        headers: {
          'Content-Type': upstreamType || 'audio/mpeg',
          'Cache-Control': 'no-cache',
          'Content-Length': String(audio.length),
        },
      })
    }

    // provider === 'zai' — built-in pipeline (audio/wav).
    const voice = rawVoice || 'tongtong'
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

    return new NextResponse(new Uint8Array(wav), {
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
