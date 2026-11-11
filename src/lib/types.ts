// Shared types used by both backend API routes and the frontend.

// 挖空显示样式 — matches the 挖空显示样式 sheet:
//   underline 下划线 | blur 模糊 | star 星号 | blank 空白 | highlight 高亮 | circle 圈圈
export type ClozeStyle = 'circle' | 'underline' | 'blur' | 'star' | 'blank' | 'highlight'

export const CLOZE_STYLE_OPTIONS: { value: ClozeStyle; label: string }[] = [
  { value: 'underline', label: '下划线' },
  { value: 'blur', label: '模糊' },
  { value: 'star', label: '星号' },
  { value: 'blank', label: '空白' },
  { value: 'highlight', label: '高亮' },
  { value: 'circle', label: '圈圈' },
]

export interface CardPlan {
  /** 今日计划：每日目标次数（保留旧语义） */
  goal: number
  /** 每日计划：新学章节量 (制作背书计划) */
  dailyNew?: number
  /** 每日计划：复习遍数 (复习5遍) */
  reviewTimes?: number
}

// ---------- 挖空关键词（位置感知） ----------
// - plain string          → 旧格式：挖空该词的【所有】出现位置
// - { t, occ } occ = -1   → 同上（所有出现）
// - { t, occ } occ >= 0   → 只挖第 occ（0 基）次出现 —— 手动挖空/挖空刷/
//   选择框生成这种条目，避免「挖一个字，全文同字都被挖」的误伤。
export type KwEntry = string | { t: string; occ: number }

// ---------- 文字编辑工具 (Q&A material blocks) ----------
export interface MaterialBlock {
  /** 核心论点（正面） */
  front: string
  /** 完整内容（背面） */
  back: string
  /** 已隐藏（折叠不显示） */
  hidden?: boolean
}

// ---------- 专注内容 ----------
export interface FocusContentData {
  id: string
  name: string
  minutes: number
  /** preset key (bg-silk...) 或 dataURL */
  bg: string
  ord: number
  todaySeconds: number
  totalSeconds: number
  focusCount: number
  createdAt: string
  updatedAt: string
}

// ---------- review (熟悉/模糊/忘记) ----------
export type ReviewAction = 'familiar' | 'fuzzy' | 'forget'
export const REVIEW_ACTIONS: { value: ReviewAction; label: string }[] = [
  { value: 'familiar', label: '熟悉' },
  { value: 'fuzzy', label: '模糊' },
  { value: 'forget', label: '忘记' },
]

/** Per-card mastery derived from the latest review action. */
export type Mastery = 'familiar' | 'fuzzy' | 'forget' | 'none'

export interface ReviewStats {
  todayCount: number      // 今日复习次数
  streakDays: number      // 连续复习天数
  todaySeconds: number    // 今日用时（分钟显示时除以60）
  mastery: Record<Mastery, number> // 掌握情况（按卡片）
  calendar: Record<string, number> // 'YYYY-MM-DD' -> 复习次数（近一年）
}

// ---------- quiz items (错题本 / 收藏题目) ----------
export interface QuizItemData {
  id: string
  cardId: string
  cardTitle: string
  type: QuizType
  question: string
  answer: string
  options: string[]
  wrongCount: number
  rightCount: number
  favorite: boolean
  createdAt: string
  updatedAt: string
}

export interface WrongStats {
  rate: number        // 错题率（今日答错/今日答题 %）
  wrongCount: number  // 错题数
  todayWrong: number  // 今日错题
  multiWrong: number  // 多次做错（wrongCount>=2）
  buckets: { fivePlus: number; three: number; two: number; one: number }
}

/** 答对后自动移除错题 — 答对N次后 */
export type AutoRemoveThreshold = 1 | 2 | 3 | 5

export interface QuizReportStats {
  todayAnswered: number // 今日练习题数
  todaySeconds: number  // 今日练习时长（秒）
  days: { date: string; answered: number; wrong: number }[] // 近30天报告详情
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
  keywords: KwEntry[]
  strokes: Stroke[] // 涂鸦笔迹 (persisted)
  plan: CardPlan | null
  mindmaps: MindmapDoc[] // 已保存的思维导图
  blocks: MaterialBlock[] // 文字编辑工具 Q&A blocks
  categoryId: string // 项目分类 id（"" = 未分类）
  pinned: boolean // 置顶
  ord: number // 自定义排序序号
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

// 项目（分类文件夹）
export interface ProjectData {
  id: string
  name: string
  ord: number
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
  reviewMode: boolean

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
  reviewMode: true,

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
  /** 全局默认 TTS 音色（per-context voicePrefs 未设置时回退；空 = 童童 tongtong） */
  ttsVoice: string
  /** 全局默认 TTS 倍速 0.5-3（per-context 未设置时回退；默认 1） */
  ttsSpeed: number
  asrProvider: VoiceProvider
  asrBaseURL: string
  asrApiKey: string
  asrModel: string
  /** 错题本：答对后自动移除 — 答对N次后 */
  quizAutoRemove: 1 | 2 | 3 | 5
  /** 导入时是否开启 AI 自动挖空 */
  aiAutoCloze: boolean
  /** 导入时是否开启 AI 智能排版（整理混乱段落/标题/列表，原文逐字保留） */
  aiAutoFormat: boolean
  /** AI 出题完成后自动存入试卷夹（默认开） */
  quizAutoPaper: boolean
  /** AI 对话全局配置（服务端持久化，多端同步） */
  aiSystemPrompt: string
  aiRules: string
  aiSelfThinking: boolean
  aiTemperature: number | null
  aiMaxTokens: number | null
  /** PDF 解析引擎: auto | unpdf | pdf-parse */
  pdfEngine: 'auto' | 'unpdf' | 'pdf-parse'
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
  /** 收藏/错题上报用 */
  cardId?: string
  cardTitle?: string
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

// ---------- 复习计划模板 ----------
export interface ReviewPlanData {
  id: string
  name: string
  /** 复习时间安排（天数偏移，0 = 现在/当天） */
  days: number[]
  builtIn: boolean
  createdAt: string
  updatedAt: string
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
