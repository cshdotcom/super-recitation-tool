// Server-only settings helpers (singleton row in SQLite).
import { db } from './db'
import type { AIConfig } from './ai'
import {
  DEFAULT_TOOLS,
  type SettingsData,
  type ToolToggles,
  type ClozeStyle,
  type PageMode,
  type VoiceProvider,
} from './types'

const ID = 'singleton'

export function parseSettings(row: {
  id: string
  clozeStyle: string
  showAnswers: boolean
  tools: string
  fontSize: number
  pageMode: string
  aiProvider: string
  aiBaseURL: string | null
  aiApiKey: string | null
  aiModel: string | null
  ttsProvider?: string | null
  ttsBaseURL?: string | null
  ttsApiKey?: string | null
  ttsModel?: string | null
  asrProvider?: string | null
  asrBaseURL?: string | null
  asrApiKey?: string | null
  asrModel?: string | null
} | null): SettingsData {
  let tools: ToolToggles = { ...DEFAULT_TOOLS }
  try {
    if (row?.tools) tools = { ...DEFAULT_TOOLS, ...JSON.parse(row.tools) }
  } catch {}

  let clozeStyle: ClozeStyle = 'circle'
  if (row?.clozeStyle === 'underline') clozeStyle = 'underline'
  // legacy 'highlight' maps to the new 圈圈 (circle) style

  let pageMode: PageMode = 'scroll'
  if (row?.pageMode === 'paged') pageMode = 'paged'

  // Voice providers accept zai | custom | browser; anything else falls back to zai.
  const voiceProvider = (v: string | null | undefined): VoiceProvider =>
    v === 'custom' || v === 'browser' ? v : 'zai'

  return {
    id: row?.id ?? ID,
    clozeStyle,
    showAnswers: !!row?.showAnswers,
    tools,
    fontSize: typeof row?.fontSize === 'number' ? row.fontSize : 18,
    pageMode,
    aiProvider: (row?.aiProvider as 'zai' | 'custom') || 'zai',
    aiBaseURL: row?.aiBaseURL ?? '',
    aiApiKey: row?.aiApiKey ?? '',
    aiModel: row?.aiModel ?? '',
    ttsProvider: voiceProvider(row?.ttsProvider),
    ttsBaseURL: row?.ttsBaseURL ?? '',
    ttsApiKey: row?.ttsApiKey ?? '',
    ttsModel: row?.ttsModel ?? '',
    asrProvider: voiceProvider(row?.asrProvider),
    asrBaseURL: row?.asrBaseURL ?? '',
    asrApiKey: row?.asrApiKey ?? '',
    asrModel: row?.asrModel ?? '',
  }
}

export async function getSettings(): Promise<SettingsData> {
  const row = await db.settings.findUnique({ where: { id: ID } })
  return parseSettings(row as never)
}

export async function getAIConfig(): Promise<AIConfig> {
  const s = await getSettings()
  return {
    provider: s.aiProvider,
    baseURL: s.aiBaseURL,
    apiKey: s.aiApiKey,
    model: s.aiModel,
  }
}
