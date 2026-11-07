// Shared types used by both backend API routes and the frontend.

export type ClozeStyle = 'circle' | 'underline'

export interface CardPlan {
  goal: number
}

// One doodle stroke: array of normalized [x, y] points (0..1 relative to content box).
export type Stroke = [number, number][]

export interface CardData {
  id: string
  title: string
  content: string
  keywords: string[]
  strokes: Stroke[] // 涂鸦笔迹 (persisted)
  plan: CardPlan | null
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

export interface SettingsData {
  id: string
  clozeStyle: ClozeStyle
  showAnswers: boolean
  tools: ToolToggles
  fontSize: number
  pageMode: PageMode
  aiProvider: 'zai' | 'custom'
  aiBaseURL: string
  aiApiKey: string
  aiModel: string
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export type QuizType = 'fill' | 'short' | 'choice'

export interface QuizQuestion {
  type: QuizType
  question: string
  answer: string
  options?: string[]
}

export interface MindNode {
  title: string
  children?: MindNode[]
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
