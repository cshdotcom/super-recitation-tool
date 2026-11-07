// Speech-to-text — provider-aware.
// POST /api/asr   (multipart/form-data, field "file", optional field "provider")
//   -> { text }
//
// Providers (formData `provider` overrides the settings asrProvider):
//   zai     -> z-ai SDK audio.asr (base64 payload) [default]
//   custom  -> any OpenAI-compatible POST {baseURL}/audio/transcriptions;
//              the upload is forwarded as multipart (Blob + model field) and
//              the response is parsed from { text } / { data: { text } } /
//              plain text.
//   browser -> SpeechRecognition on the client; the server only answers 400
//              browser_mode (graceful fallback — the client normally won't
//              call this endpoint in that mode).
import { NextRequest, NextResponse } from 'next/server'
import { getZAI } from '@/lib/zai'
import { getSessionUser } from '@/lib/auth'
import { db } from '@/lib/db'

const SETTINGS_ID = 'singleton'

type AsrProvider = 'zai' | 'custom' | 'browser'

function asProvider(v: unknown): AsrProvider | null {
  return v === 'zai' || v === 'custom' || v === 'browser' ? v : null
}

function readString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * Defensive settings read: parseSettings() in src/lib/settings.ts may not
 * surface the asr* fields yet (another agent owns that file), so read the
 * raw DB row directly and fall back gracefully (missing row/columns/DB -> zai).
 */
async function getAsrSettings(): Promise<{
  provider: AsrProvider
  baseURL: string
  apiKey: string
  model: string
}> {
  try {
    const row = (await db.settings.findUnique({
      where: { id: SETTINGS_ID },
    })) as unknown as Record<string, unknown> | null
    return {
      provider: asProvider(row?.asrProvider) ?? 'zai',
      baseURL: readString(row?.asrBaseURL),
      apiKey: readString(row?.asrApiKey),
      model: readString(row?.asrModel),
    }
  } catch {
    // Schema/migration not applied yet — fall back to the built-in z-ai SDK.
    return { provider: 'zai', baseURL: '', apiKey: '', model: '' }
  }
}

/** Extract the transcript from an OpenAI-compatible /audio/transcriptions response. */
function extractTranscript(payload: unknown): string {
  if (typeof payload === 'string') return payload.trim()
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    if (typeof obj.text === 'string') return obj.text
    const inner = obj.data
    if (inner && typeof inner === 'object') {
      const innerText = (inner as Record<string, unknown>).text
      if (typeof innerText === 'string') return innerText
    }
  }
  return ''
}

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    const formData = await req.formData()
    const file = formData.get('file') as File | null
    if (!file) {
      return NextResponse.json({ error: '未提供音频' }, { status: 400 })
    }

    const providerField = formData.get('provider')
    const settings = await getAsrSettings()
    const provider: AsrProvider =
      asProvider(typeof providerField === 'string' ? providerField : null) ??
      settings.provider

    if (provider === 'browser') {
      return NextResponse.json(
        {
          error: 'browser_mode',
          message: '浏览器模式由前端 SpeechRecognition 识别，无需服务端',
        },
        { status: 400 }
      )
    }

    if (provider === 'custom') {
      if (!settings.baseURL || !settings.apiKey) {
        return NextResponse.json(
          { error: '请先在设置中配置第三方 ASR API' },
          { status: 400 }
        )
      }
      // Forward the upload as multipart (undici fetch supports FormData/Blob).
      const bytes = new Uint8Array(await file.arrayBuffer())
      const upstream = new FormData()
      upstream.append(
        'file',
        new Blob([bytes], { type: file.type || 'audio/webm' }),
        file.name || 'audio.webm'
      )
      upstream.append('model', settings.model || 'whisper-1')
      const res = await fetch(
        `${settings.baseURL.replace(/\/$/, '')}/audio/transcriptions`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${settings.apiKey}` },
          body: upstream,
        }
      )
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`第三方 ASR 请求失败 (${res.status}): ${detail.slice(0, 200)}`)
      }
      const contentType = (res.headers.get('content-type') || '').toLowerCase()
      let text = ''
      if (contentType.includes('application/json')) {
        const data: unknown = await res.json().catch(() => null)
        text = extractTranscript(data)
      } else {
        text = (await res.text()).trim()
      }
      return NextResponse.json({ text })
    }

    // provider === 'zai' — built-in pipeline.
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
