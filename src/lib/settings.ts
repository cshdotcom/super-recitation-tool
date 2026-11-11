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
  type VoicePrefs,
} from './types'

const ID = 'singleton'

export function parseSettings(row: {
  id: string
  clozeStyle: string
  showAnswers: boolean
  tools: string
  fontSize: number
  pageMode: string
  theme?: string | null
  voicePrefs?: string | null
  aiProvider: string
  aiBaseURL: string | null
  aiApiKey: string | null
  aiModel: string | null
  ttsProvider?: string | null
  ttsBaseURL?: string | null
  ttsApiKey?: string | null
  ttsModel?: string | null
  ttsVoice?: string | null
  ttsSpeed?: number | null
  asrProvider?: string | null
  asrBaseURL?: string | null
  asrApiKey?: string | null
  asrModel?: string | null
  quizAutoRemove?: number | null
  aiAutoCloze?: boolean | null
  aiAutoFormat?: boolean | null
  quizAutoPaper?: boolean | null
  aiSystemPrompt?: string | null
  aiRules?: string | null
  aiSelfThinking?: boolean | null
  aiTemperature?: number | null
  aiMaxTokens?: number | null
  pdfEngine?: string | null
} | null): SettingsData {
  let tools: ToolToggles = { ...DEFAULT_TOOLS }
  try {
    if (row?.tools) tools = { ...DEFAULT_TOOLS, ...JSON.parse(row.tools) }
  } catch {}

  let clozeStyle: ClozeStyle = 'circle'
  if (['circle', 'underline', 'blur', 'star', 'blank', 'highlight'].includes(row?.clozeStyle || '')) {
    clozeStyle = row!.clozeStyle as ClozeStyle
  }

  let pageMode: PageMode = 'scroll'
  if (row?.pageMode === 'paged') pageMode = 'paged'

  const theme =
    row?.theme === 'light' ||
    row?.theme === 'dark' ||
    row?.theme === 'green' ||
    row?.theme === 'sepia'
      ? row.theme
      : 'system'

  let voicePrefs: VoicePrefs = {}
  try {
    if (row?.voicePrefs) voicePrefs = JSON.parse(row.voicePrefs) as VoicePrefs
  } catch {}

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
    theme,
    voicePrefs,
    aiProvider: (row?.aiProvider as 'zai' | 'custom') || 'zai',
    aiBaseURL: row?.aiBaseURL ?? '',
    aiApiKey: row?.aiApiKey ?? '',
    aiModel: row?.aiModel ?? '',
    ttsProvider: voiceProvider(row?.ttsProvider),
    ttsBaseURL: row?.ttsBaseURL ?? '',
    ttsApiKey: row?.ttsApiKey ?? '',
    ttsModel: row?.ttsModel ?? '',
    // 全局默认 TTS 音色：z-ai 音色名（tongtong/chuichui/…）或 custom 音色 id。
    // 只接受 TTS_VOICES 里的有效值，否则空串 → 播放器回退到默认童童。
    ttsVoice:
      typeof row?.ttsVoice === 'string' && row.ttsVoice ? row.ttsVoice : '',
    ttsSpeed:
      typeof row?.ttsSpeed === 'number' && Number.isFinite(row.ttsSpeed)
        ? Math.min(3, Math.max(0.5, row.ttsSpeed))
        : 1,
    asrProvider: voiceProvider(row?.asrProvider),
    asrBaseURL: row?.asrBaseURL ?? '',
    asrApiKey: row?.asrApiKey ?? '',
    asrModel: row?.asrModel ?? '',
    quizAutoRemove:
      typeof row?.quizAutoRemove === 'number' && [1, 2, 3, 5].includes(row.quizAutoRemove)
        ? (row.quizAutoRemove as 1 | 2 | 3 | 5)
        : 2,
    aiAutoCloze: !!row?.aiAutoCloze,
    // 导入时 AI 智能排版（默认关）
    aiAutoFormat: !!row?.aiAutoFormat,
    // AI 出题后自动存入试卷夹（默认开）
    quizAutoPaper: row?.quizAutoPaper === undefined ? true : !!row.quizAutoPaper,
    aiSystemPrompt: row?.aiSystemPrompt ?? '',
    aiRules: row?.aiRules ?? '',
    aiSelfThinking: !!row?.aiSelfThinking,
    aiTemperature:
      typeof row?.aiTemperature === 'number' && Number.isFinite(row.aiTemperature)
        ? Math.min(2, Math.max(0, row.aiTemperature))
        : null,
    aiMaxTokens:
      typeof row?.aiMaxTokens === 'number' && Number.isFinite(row.aiMaxTokens)
        ? Math.round(row.aiMaxTokens)
        : null,
    pdfEngine:
      row?.pdfEngine === 'unpdf' || row?.pdfEngine === 'pdf-parse' ? row.pdfEngine : 'auto',
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
