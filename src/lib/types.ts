// Shared types used by both backend API routes and the frontend.

export type ClozeStyle = 'underline' | 'highlight'

export interface CardData {
  id: string
  title: string
  content: string
  keywords: string[]
  createdAt: string
  updatedAt: string
}

export interface ToolToggles {
  tts: boolean
  asr: boolean
  quiz: boolean
  supervise: boolean
  ask: boolean
  mindmap: boolean
}

export const DEFAULT_TOOLS: ToolToggles = {
  tts: true,
  asr: true,
  quiz: true,
  supervise: true,
  ask: true,
  mindmap: true,
}

export interface SettingsData {
  id: string
  clozeStyle: ClozeStyle
  showAnswers: boolean
  tools: ToolToggles
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
