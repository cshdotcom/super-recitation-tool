// Shared types used by both backend API routes and the frontend.

export type ClozeStyle = 'circle' | 'underline'

export interface CardPlan {
  goal: number
}

// ---------- doodle strokes ----------
export type Point = [number, number]

export type DoodleTool = 'pen' | 'pencil' | 'marker' | 'brush' | 'eraser'

// A styled doodle stroke (v2).
export interface DoodleStroke {
  pts: Point[]
  color: string
  width: number
  tool: DoodleTool
}

// Legacy strokes were plain point arrays; they still render (black pen).
export type Stroke = Point[] | DoodleStroke

export function isDoodleStroke(s: Stroke): s is DoodleStroke {
  return !Array.isArray(s)
}

export interface CardData {
  id: string
  title: string
  content: string
  keywords: string[]
  strokes: Stroke[] // 涂鸦笔迹 (persisted)
  plan: CardPlan | null
  mindmaps: MindmapDoc[] // 已保存的思维导图
  createdAt: string
  updatedAt: string
}

// Quick edit bar toggles (screenshot: AI快速分块/AI快速挖空/涂鸦/挖空刷/手动挖空/规则挖空)
// + recitation tool toggles (背书工具 grid).
export interface ToolToggles {
  aiChunk: boolean
  aiCloze: boolean
  doodle: boolean
  brush: boolean
  manualCloze: boolean
  ruleCloze: boolean

  tts: boolean
  quiz: boolean
  supervise: boolean
  asr: boolean
  mindmap: boolean
  ask: boolean
  earback: boolean
  copywrite: boolean
  wheel: boolean
}

export const DEFAULT_TOOLS: ToolToggles = {
  aiChunk: true,
  aiCloze: true,
  doodle: true,
  brush: true,
  manualCloze: true,
  ruleCloze: true,

  tts: true,
  quiz: true,
  supervise: true,
  asr: true,
  mindmap: true,
  ask: true,
  earback: true,
  copywrite: true,
  wheel: true,
}

export type PageMode = 'scroll' | 'paged'

// Provider for TTS / ASR:
//   zai     -> z-ai-web-dev-sdk (built-in)
//   custom  -> any OpenAI-compatible endpoint (/audio/speech, /audio/transcriptions)
//   browser -> Web Speech API (speechSynthesis / SpeechRecognition), no server needed
export type VoiceProvider = 'zai' | 'custom' | 'browser'

// App themes (白天/晚上/护眼/羊皮纸). Persisted server-side in Settings.theme.
export type ThemeName = 'light' | 'dark' | 'green' | 'sepia'
export const THEME_OPTIONS: { value: ThemeName | 'system'; label: string }[] = [
  { value: 'light', label: '白天模式' },
  { value: 'dark', label: '夜间模式' },
  { value: 'green', label: '护眼模式' },
  { value: 'sepia', label: '羊皮纸模式' },
  { value: 'system', label: '跟随系统' },
]

/** Voice/rate defaults for one context (朗读/背书酱/督背/问问/出题...). */
export interface VoicePrefTTS {
  provider: VoiceProvider
  /** z-ai voice name or OpenAI voice id */
  voice: string
  /** playback speed 0.5 - 3 */
  speed: number
  /** browser speechSynthesis voiceURI (browser provider only) */
  voiceURI?: string
}
export interface VoicePrefASR {
  provider: VoiceProvider
  /** recognition language (browser provider only) */
  lang?: string
}
export interface VoicePref {
  tts?: VoicePrefTTS
  asr?: VoicePrefASR
}
/** map of context key -> pref, e.g. { reader: { tts: {...} }, ask: {...} } */
export type VoicePrefs = Record<string, VoicePref>
export const VOICE_CONTEXTS = [
  'reader',    // AI 朗读
  'tts',       // 朗读文本工具
  'asr',       // 背诵录音识别
  'supervise', // AI 督背
  'quiz',      // 出题
  'ask',       // AI 问问
  'earback',   // 磨耳朵
  'copywrite', // 默写
] as const
export type VoiceContext = (typeof VOICE_CONTEXTS)[number]

export interface SettingsData {
  id: string
  clozeStyle: ClozeStyle
  showAnswers: boolean
  tools: ToolToggles
  fontSize: number
  pageMode: PageMode
  theme: ThemeName | 'system'
  voicePrefs: VoicePrefs
  aiProvider: 'zai' | 'custom'
  aiBaseURL: string
  aiApiKey: string
  aiModel: string
  ttsProvider: VoiceProvider
  ttsBaseURL: string
  ttsApiKey: string
  ttsModel: string
  asrProvider: VoiceProvider
  asrBaseURL: string
  asrApiKey: string
  asrModel: string
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  /** data-URI images attached to (user) messages — vision requests. */
  images?: string[]
}

export type QuizType = 'fill' | 'short' | 'choice'

export interface QuizQuestion {
  type: QuizType
  question: string
  answer: string
  options?: string[]
}

export interface MindNode {
  id: string
  title: string
  children?: MindNode[]
}

/** A saved mind map document (per card). */
export interface MindmapDoc {
  id: string
  title: string
  /** scope label, e.g. 第1页 / 全文 */
  scope?: string
  levels?: number
  root: MindNode
  createdAt?: string
  updatedAt?: string
}

// ---------- account ----------
export interface AccountData {
  id: string
  username: string
  avatar: string // data URL ('' = none)
}

// ---------- share ----------
export interface ShareInfo {
  token: string
  /** ISO date or null = 无限 (never expires). */
  expiresAt: string | null
  createdAt: string
}

// TTS voice options supported by the z-ai SDK.
export const TTS_VOICES = [
  { value: 'tongtong', label: '童童 · 温暖亲切' },
  { value: 'chuichui', label: '锤锤 · 活泼可爱' },
  { value: 'xiaochen', label: '晓辰 · 沉稳专业' },
  { value: 'jam', label: 'Jam · 英音绅士' },
  { value: 'kazi', label: '卡子 · 清晰标准' },
  { value: 'douji', label: '豆姬 · 自然流畅' },
  { value: 'luodo', label: '洛多 · 富有感染力' },
] as const
