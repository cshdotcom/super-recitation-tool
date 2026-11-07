// Server-only settings helpers.
// Reads / upserts the singleton Settings row and derives the AIConfig.
import { db } from './db'
import { DEFAULT_TOOLS, type SettingsData, type ToolToggles, type ClozeStyle } from './types'
import type { AIConfig } from './ai'

const ID = 'singleton'

type SettingsRow = {
  id: string
  clozeStyle: string
  showAnswers: boolean
  tools: string
  aiProvider: string
  aiBaseURL: string | null
  aiApiKey: string | null
  aiModel: string | null
} | null

export function parseSettings(row: SettingsRow): SettingsData {
  let tools: ToolToggles = { ...DEFAULT_TOOLS }
  try {
    if (row?.tools) tools = { ...DEFAULT_TOOLS, ...JSON.parse(row.tools) }
  } catch {
    /* keep defaults */
  }
  const clozeStyle = ((row?.clozeStyle as ClozeStyle) || 'underline')
  const aiProvider =
    row?.aiProvider === 'custom' ? 'custom' : ((row?.aiProvider as 'zai' | 'custom') || 'zai')
  return {
    id: row?.id ?? ID,
    clozeStyle,
    showAnswers: !!row?.showAnswers,
    tools,
    aiProvider,
    aiBaseURL: row?.aiBaseURL ?? '',
    aiApiKey: row?.aiApiKey ?? '',
    aiModel: row?.aiModel ?? '',
  }
}

export async function getSettings(): Promise<SettingsData> {
  const row = await db.settings.findUnique({ where: { id: ID } })
  return parseSettings(row as SettingsRow)
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
