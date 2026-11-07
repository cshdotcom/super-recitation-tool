// Settings endpoints.
// GET    /api/settings   -> current settings (singleton)
// PATCH  /api/settings   -> upsert partial settings
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSettings, parseSettings } from '@/lib/settings'
import { DEFAULT_TOOLS, type ClozeStyle, type ToolToggles } from '@/lib/types'

const ID = 'singleton'

export async function GET() {
  try {
    return NextResponse.json(await getSettings())
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[GET /api/settings] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))

    // If no fields supplied, just return current settings.
    if (
      body === null ||
      typeof body !== 'object' ||
      Object.keys(body).length === 0
    ) {
      return NextResponse.json(await getSettings())
    }

    const data: Record<string, string | boolean> = {}

    if (typeof body?.clozeStyle === 'string') {
      const style: ClozeStyle = body.clozeStyle === 'highlight' ? 'highlight' : 'underline'
      data.clozeStyle = style
    }
    if (typeof body?.showAnswers === 'boolean') {
      data.showAnswers = body.showAnswers
    }
    if (body?.tools && typeof body.tools === 'object') {
      const merged: ToolToggles = { ...DEFAULT_TOOLS }
      for (const key of Object.keys(DEFAULT_TOOLS) as (keyof ToolToggles)[]) {
        if (typeof body.tools[key] === 'boolean') {
          merged[key] = body.tools[key]
        }
      }
      data.tools = JSON.stringify(merged)
    }
    if (typeof body?.aiProvider === 'string') {
      data.aiProvider = body.aiProvider === 'custom' ? 'custom' : 'zai'
    }
    if (typeof body?.aiBaseURL === 'string') {
      data.aiBaseURL = body.aiBaseURL
    }
    if (typeof body?.aiApiKey === 'string') {
      data.aiApiKey = body.aiApiKey
    }
    if (typeof body?.aiModel === 'string') {
      data.aiModel = body.aiModel
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json(await getSettings())
    }

    const row = await db.settings.upsert({
      where: { id: ID },
      update: data,
      create: { id: ID, ...data },
    })
    return NextResponse.json(parseSettings(row as never))
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[PATCH /api/settings] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
