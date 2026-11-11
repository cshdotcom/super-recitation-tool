'use client'

// AiAssistPopover — 富媒体编辑器的临时 AI 助理悬浮窗（右下角，非模态）。
//   • 临时会话：消息只存组件 state（内存），关闭即清空，绝不落库
//   • 上下文：每次发送都带当前媒体 kind + 最新代码（POST /api/media-ai）
//   • AI 回复：代码块带「应用到编辑器」（写入编辑器源码并切回可视化继续编辑）
//     / 复制；消息级「朗读」（/api/tts，401 或失败回退 speechSynthesis zh-CN）+ 复制
//   • 语音输入：浏览器原生 webkitSpeechRecognition（zh-CN，实时中间结果），
//     识别文字填入输入框（与 voice-input.tsx 的浏览器引擎同款逻辑）
//   • 图片上传：≤2MB、canvas 压缩到 800px，以 dataURI 附到用户消息（气泡显示
//     缩略图）；/api/media-ai 走视觉模型，AI 可「看图生成代码」（手绘草图 → SVG 等）
//   • 对话配置：系统补充指令（localStorage 持久）+ 可选采样温度（0~1.5）
//   • 技能清单：生成 / 修改 / 解释 / 修复 / 优化 / 转换（SVG↔mermaid↔表格）
//     一键填入指令模板
// 实现说明：纯 createPortal 悬浮层（z-[80]，不遮罩、无焦点陷阱），打开时不
// 打断宿主编辑器；点击外部不关闭（防误触丢会话），仅 X / 应用后关闭。宿主
// MediaEditDialog 通过 data-ai-assist 识别本层，点击/聚焦此处不会误关编辑器。

import * as React from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  Copy,
  ImagePlus,
  Loader2,
  Mic,
  Send,
  Settings2,
  Sparkles,
  Square,
  Volume2,
  X,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { MEDIA_KIND_LABEL, type MediaKind } from '@/components/recitation/media-refs'

/** 临时消息（内存态）；用户消息可带 dataURI 附图 */
interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  /** 用户消息附图（data:image/ URI 缩略图） */
  images?: string[]
}

/** MediaKind → /api/media-ai 的 kind */
const API_KIND: Record<MediaKind, 'mermaid' | 'svg' | 'html' | 'table' | 'formula' | 'code'> = {
  image: 'code',
  table: 'table',
  mermaid: 'mermaid',
  svg: 'svg',
  html: 'html',
  code: 'code',
  formula: 'formula',
}

// ---------- 对话配置（localStorage 持久，仅本机） ----------

const CFG_INSTRUCTION_KEY = 'bs:ai-assist:instruction'
const CFG_TEMP_ON_KEY = 'bs:ai-assist:temp-on'
const CFG_TEMP_KEY = 'bs:ai-assist:temp'

/** 读取配置（指令补充 / 是否启用自定义温度 / 温度值）；异常一律回默认值。 */
function loadAssistConfig(): { instruction: string; tempOn: boolean; temp: number } {
  if (typeof window === 'undefined') return { instruction: '', tempOn: false, temp: 0.7 }
  try {
    return {
      instruction: window.localStorage.getItem(CFG_INSTRUCTION_KEY) ?? '',
      tempOn: window.localStorage.getItem(CFG_TEMP_ON_KEY) === '1',
      temp: Math.min(
        1.5,
        Math.max(0, Number(window.localStorage.getItem(CFG_TEMP_KEY)) || 0.7),
      ),
    }
  } catch {
    return { instruction: '', tempOn: false, temp: 0.7 }
  }
}

// ---------- 语音输入（浏览器原生 webkitSpeechRecognition，zh-CN） ----------
// 与 voice-input.tsx 的浏览器引擎同款逻辑：continuous + interimResults，
// 断流自动重启（keepAlive），用户主动停止后把最终文字交给回调。

interface SpeechRecognitionAlternativeLike {
  transcript: string
}
interface SpeechRecognitionResultLike {
  isFinal: boolean
  length: number
  [index: number]: SpeechRecognitionAlternativeLike
}
interface SpeechRecognitionResultListLike {
  length: number
  [index: number]: SpeechRecognitionResultLike
}
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: SpeechRecognitionResultListLike
}
interface SpeechRecognitionErrorEventLike {
  error: string
}
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** 浏览器语音输入 hook：listening=识别中（动效）；stop 后把识别文字交给 onDone。 */
function useBrowserSpeechInput(onDone: (text: string) => void): {
  listening: boolean
  interim: string
  start: () => void
  stop: () => void
} {
  const [listening, setListening] = React.useState(false)
  const [interim, setInterim] = React.useState('')
  const recogRef = React.useRef<SpeechRecognitionLike | null>(null)
  const finalRef = React.useRef('')
  const interimRef = React.useRef('')
  const keepAliveRef = React.useRef(false)
  const stoppedRef = React.useRef(false)
  const onDoneRef = React.useRef(onDone)
  React.useEffect(() => {
    onDoneRef.current = onDone
  })

  const teardown = React.useCallback(() => {
    const recog = recogRef.current
    if (recog) {
      recog.onresult = null
      recog.onerror = null
      recog.onend = null
      try {
        recog.abort()
      } catch {
        /* ignore */
      }
      recogRef.current = null
    }
    finalRef.current = ''
    interimRef.current = ''
    setInterim('')
    setListening(false)
  }, [])

  // 卸载时彻底清理
  React.useEffect(() => () => teardown(), [teardown])

  const start = React.useCallback(() => {
    const Ctor = getRecognitionCtor()
    if (!Ctor) {
      toast.error('当前浏览器不支持语音识别，请直接打字输入')
      return
    }
    finalRef.current = ''
    interimRef.current = ''
    stoppedRef.current = false
    keepAliveRef.current = true
    const recog = new Ctor()
    recog.lang = 'zh-CN'
    recog.continuous = true
    recog.interimResults = true
    recog.maxAlternatives = 1
    recog.onresult = (e) => {
      let it = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        const t = r[0]?.transcript ?? ''
        if (r.isFinal) finalRef.current += t
        else it += t
      }
      interimRef.current = it
      setInterim(it)
    }
    recog.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        keepAliveRef.current = false
        toast.error('未授予麦克风权限，请在浏览器中允许后重试')
        teardown()
      } else if (e.error === 'no-speech') {
        toast.warning('没有检测到语音，请靠近麦克风再说一次')
      } else if (e.error !== 'aborted') {
        toast.error('识别出错：' + e.error)
      }
    }
    recog.onend = () => {
      if (keepAliveRef.current) {
        // 浏览器自动断流 → 重启续听
        try {
          recog.start()
        } catch {
          /* ignore */
        }
        return
      }
      if (stoppedRef.current) {
        const raw = (finalRef.current + interimRef.current).trim()
        recogRef.current = null
        teardown()
        if (raw) onDoneRef.current(raw)
        else toast.warning('未识别到内容，请靠近麦克风再试一次')
      }
    }
    try {
      recog.start()
    } catch (err) {
      keepAliveRef.current = false
      toast.error('无法启动语音识别：' + (err instanceof Error ? err.message : '未知错误'))
      return
    }
    recogRef.current = recog
    setListening(true)
  }, [teardown])

  const stop = React.useCallback(() => {
    stoppedRef.current = true
    keepAliveRef.current = false
    const recog = recogRef.current
    if (recog) {
      try {
        recog.stop()
      } catch {
        /* ignore */
      }
    }
    setListening(false)
  }, [])

  return { listening, interim, start, stop }
}

// ---------- 图片上传（≤2MB，canvas 压缩到 800px） ----------

/** 附图上限（张）/ 体积上限 / 压缩长边（px）——与追问弹层同规格。 */
const MAX_IMAGES = 2
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_DIM = 800

/** 图片文件 → dataURL：校验 ≤2MB，长边 >800px 时 canvas 压缩为 800px JPEG。 */
function processImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('请选择图片文件'))
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error('图片不能超过 2MB'))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.onload = () => {
      const dataUrl = reader.result as string
      const img = new Image()
      img.onerror = () => reject(new Error('图片解析失败'))
      img.onload = () => {
        let w = img.width
        let h = img.height
        if (w > MAX_IMAGE_DIM || h > MAX_IMAGE_DIM) {
          const scale = Math.min(MAX_IMAGE_DIM / w, MAX_IMAGE_DIM / h)
          w = Math.round(w * scale)
          h = Math.round(h * scale)
        }
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(dataUrl)
          return
        }
        ctx.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      }
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  })
}

// ---------- 技能清单（可点击模板按钮 → 填入输入框） ----------

interface SkillItem {
  title: string
  desc: string
  tpl: string
}

/** AI 助理全部技能（中文文案；点击即把指令模板填入输入框）。 */
const SKILLS: SkillItem[] = [
  {
    title: '生成代码',
    desc: '直接描述想要什么，AI 从零生成。例：「画一个水循环示意图 SVG」「生成光合作用流程图 mermaid」「生成元素周期表片段表格」',
    tpl: '请从零生成：',
  },
  {
    title: '修改当前',
    desc: '编辑器当前源码会随消息自动发给 AI，直接说怎么改即可',
    tpl: '请修改当前代码：',
  },
  {
    title: '解释代码',
    desc: '让 AI 逐段解释当前源码的作用、关键语法与注意点',
    tpl: '请逐段解释当前代码的作用、关键语法和注意点。',
  },
  {
    title: '修复语法',
    desc: '一键请 AI 修复语法错误（与编辑器顶部「AI修复」同源）',
    tpl: '请检查并修复当前代码的语法错误，尽量保留原有内容与结构，直接输出修复后的完整代码。',
  },
  {
    title: '优化美化',
    desc: '让 AI 在完全保留内容的前提下优化布局与样式',
    tpl: '请在完全保留内容的前提下优化当前代码的布局与样式，直接输出完整代码。',
  },
  {
    title: '转 mermaid',
    desc: '把当前图转换成 mermaid 流程图 / 思维导图源码',
    tpl: '请把当前内容转换为 mermaid flowchart 流程图源码，内容保持一致，直接输出完整源码。',
  },
  {
    title: '转 SVG',
    desc: '把当前图转换成 SVG 矢量图源码',
    tpl: '请把当前内容转换为 SVG 图示源码，内容保持一致，直接输出完整源码。',
  },
  {
    title: '转表格',
    desc: '把当前内容整理成 markdown 表格',
    tpl: '请把当前内容整理为 markdown 表格，内容保持一致，直接输出表格源码。',
  },
]

// ---------- 中文朗读（/api/tts → speechSynthesis 兜底） ----------

/**
 * 轻量中文朗读 hook：优先 POST /api/tts 播放合成音频，
 * 401 / 请求失败时回退浏览器 speechSynthesis（zh-CN）。
 */
export function useChineseSpeech(): {
  speak: (text: string) => void
  stop: () => void
  speaking: boolean
} {
  const [speaking, setSpeaking] = React.useState(false)
  const audioRef = React.useRef<HTMLAudioElement | null>(null)
  const urlRef = React.useRef<string | null>(null)
  const genRef = React.useRef(0)

  const stop = React.useCallback(() => {
    genRef.current += 1
    window.speechSynthesis?.cancel()
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
    setSpeaking(false)
  }, [])

  const speak = React.useCallback(
    (raw: string) => {
      const text = (raw || '').trim().replace(/\s+/g, ' ').slice(0, 800)
      if (!text) {
        toast.warning('没有可朗读的内容')
        return
      }
      genRef.current += 1
      const gen = genRef.current
      window.speechSynthesis?.cancel()
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
      setSpeaking(true)
      void (async () => {
        const tid = toast.loading('正在生成语音…')
        try {
          const res = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice: 'tongtong', speed: 1 }),
          })
          if (!res.ok) throw new Error(`tts ${res.status}`)
          const blob = await res.blob()
          if (genRef.current !== gen) {
            toast.dismiss(tid)
            return
          }
          const url = URL.createObjectURL(blob)
          if (urlRef.current) URL.revokeObjectURL(urlRef.current)
          urlRef.current = url
          const audio = new Audio(url)
          audio.onended = () => {
            if (genRef.current === gen) setSpeaking(false)
          }
          audio.onerror = () => {
            if (genRef.current === gen) setSpeaking(false)
          }
          audioRef.current = audio
          toast.success('开始朗读', { id: tid })
          try {
            await audio.play()
          } catch {
            /* autoplay blocked — 忽略 */
          }
        } catch {
          toast.dismiss(tid)
          // 回退：浏览器语音合成（zh-CN）
          const synth = window.speechSynthesis
          if (!synth) {
            toast.error('当前浏览器不支持语音合成')
            setSpeaking(false)
            return
          }
          const u = new SpeechSynthesisUtterance(text)
          u.lang = 'zh-CN'
          u.onend = () => {
            if (genRef.current === gen) setSpeaking(false)
          }
          u.onerror = () => {
            if (genRef.current === gen) setSpeaking(false)
          }
          synth.speak(u)
        }
      })()
    },
    [],
  )

  React.useEffect(() => {
    return () => {
      genRef.current += 1
      window.speechSynthesis?.cancel()
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    }
  }, [])

  return { speak, stop, speaking }
}

// ---------- AI 回复分段（提示词要求纯代码，但模型常带围栏/解释） ----------

function splitCodeFences(text: string): Array<{ type: 'text' | 'code'; value: string }> {
  const out: Array<{ type: 'text' | 'code'; value: string }> = []
  const re = /```[A-Za-z0-9_-]*\r?\n([\s\S]*?)```/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last && text.slice(last, m.index).trim()) {
      out.push({ type: 'text', value: text.slice(last, m.index).trim() })
    }
    if (m[1].trim()) out.push({ type: 'code', value: m[1] })
    last = m.index + m[0].length
  }
  if (last < text.length && text.slice(last).trim()) {
    out.push({ type: 'text', value: text.slice(last).trim() })
  }
  if (out.length === 0 && text.trim()) out.push({ type: 'code', value: text.trim() })
  return out
}

// ---------- 主组件 ----------

export function AiAssistPopover({
  open,
  onOpenChange,
  kind,
  currentCode,
  onApply,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  /** 当前编辑的富媒体类型（上下文提示词带上） */
  kind: MediaKind
  /** 当前编辑器内的最新源码（每次发送时取） */
  currentCode: string
  /** 把 AI 生成的代码写入编辑器（宿主负责切回可视化 tab） */
  onApply: (code: string) => void
}) {
  const [messages, setMessages] = React.useState<ChatMsg[]>([])
  const [input, setInput] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  /** 待发送附图（dataURI；发送后挂到用户消息上） */
  const [pendingImages, setPendingImages] = React.useState<string[]>([])
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const { speak, stop: stopSpeech, speaking } = useChineseSpeech()

  // 对话配置（补充指令 + 温度；localStorage 持久）
  const [cfgOpen, setCfgOpen] = React.useState(false)
  const [skillsOpen, setSkillsOpen] = React.useState(false)
  const [extraInstruction, setExtraInstruction] = React.useState('')
  const [tempOn, setTempOn] = React.useState(false)
  const [temperature, setTemperature] = React.useState(0.7)
  const cfgLoadedRef = React.useRef(false)

  // 打开时读一次本机配置（避免 SSR/水合不一致）
  React.useEffect(() => {
    if (open && !cfgLoadedRef.current) {
      cfgLoadedRef.current = true
      const cfg = loadAssistConfig()
      setExtraInstruction(cfg.instruction)
      setTempOn(cfg.tempOn)
      setTemperature(cfg.temp)
    }
  }, [open])

  // 配置变更 → localStorage（静默容错）
  React.useEffect(() => {
    if (!cfgLoadedRef.current) return
    try {
      window.localStorage.setItem(CFG_INSTRUCTION_KEY, extraInstruction)
      window.localStorage.setItem(CFG_TEMP_ON_KEY, tempOn ? '1' : '0')
      window.localStorage.setItem(CFG_TEMP_KEY, String(temperature))
    } catch {
      /* 私隐模式等写入失败 — 忽略 */
    }
  }, [extraInstruction, tempOn, temperature])

  // 语音输入：识别完成 → 追加到输入框（start/stop 均为稳定回调，可安全进依赖数组）
  const {
    listening: micListening,
    interim: micInterim,
    start: micStart,
    stop: micStop,
  } = useBrowserSpeechInput((text) => {
    setInput((v) => (v ? `${v}${v.endsWith(' ') ? '' : ' '}${text}` : text))
  })

  // 关闭即清空（临时对话，不保存记录；语音识别一并停止）
  React.useEffect(() => {
    if (!open) {
      stopSpeech()
      micStop()
      setMessages([])
      setInput('')
      setPendingImages([])
      setLoading(false)
      setCfgOpen(false)
      setSkillsOpen(false)
    }
  }, [open, stopSpeech, micStop])

  React.useEffect(() => {
    if (open) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, loading, open])

  const handleFilesChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // 允许重复选择同一文件
    if (files.length === 0) return
    const room = MAX_IMAGES - pendingImages.length
    if (room <= 0) {
      toast.warning(`最多附 ${MAX_IMAGES} 张图片`)
      return
    }
    if (files.length > room) toast.warning(`最多附 ${MAX_IMAGES} 张图片，已保留前 ${room} 张`)
    for (const f of files.slice(0, room)) {
      try {
        const dataUrl = await processImageFile(f)
        setPendingImages((arr) => (arr.length >= MAX_IMAGES ? arr : [...arr, dataUrl]))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '图片处理失败')
      }
    }
  }

  const send = async () => {
    const text = input.trim()
    const imgs = pendingImages
    if ((!text && imgs.length === 0) || loading) return
    // 指令组装：只发图无文字时给默认指令；补充指令拼在用户指令后
    const baseText = text || `请仔细观察图片内容，生成对应的${MEDIA_KIND_LABEL[kind]}代码。`
    const finalInstruction = extraInstruction.trim()
      ? `${baseText}\n\n【补充指令】${extraInstruction.trim()}`
      : baseText
    // 历史只带文本（附图不重复发送，控制请求体大小）
    const history = messages.slice(-20).map(({ role, content }) => ({ role, content }))
    setInput('')
    setPendingImages([])
    setLoading(true)
    setMessages((m) => [...m, { role: 'user', content: baseText, ...(imgs.length ? { images: imgs } : {}) }])
    try {
      const res = await fetch('/api/media-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: API_KIND[kind],
          currentCode,
          instruction: finalInstruction,
          history,
          ...(imgs.length > 0 ? { images: imgs } : {}),
          ...(tempOn ? { temperature } : {}),
        }),
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(err.error || `请求失败（${res.status}）`)
      }
      const data = (await res.json()) as { code?: string }
      const reply = typeof data.code === 'string' ? data.code : ''
      if (!reply.trim()) throw new Error('AI 返回为空，请重试')
      setMessages((m) => [...m, { role: 'assistant', content: reply }])
    } catch (e) {
      const msg = e instanceof Error ? e.message : '未知错误'
      setMessages((m) => [...m, { role: 'assistant', content: `（生成失败：${msg}）` }])
      toast.error('AI 生成失败：' + msg)
    } finally {
      setLoading(false)
    }
  }

  const applyCode = (code: string) => {
    onApply(code)
    onOpenChange(false)
  }

  /** 技能模板 → 填入输入框（追加而非覆盖，防丢已输入内容） */
  const fillSkillTemplate = (tpl: string) => {
    setInput((v) => (v.trim() ? `${v.trim()}\n${tpl}` : tpl))
    setSkillsOpen(false)
  }

  /** 复制整条消息（朗读旁的小按钮） */
  const copyMessage = (content: string) => {
    void navigator.clipboard
      .writeText(content)
      .then(() => toast.success('已复制'))
      .catch(() => toast.error('复制失败'))
  }

  // Esc 关闭（自管，不用 Radix 层）
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  if (!open || typeof document === 'undefined') return null

  // 纯 portal 悬浮层（非 Radix）：不打断宿主编辑器、点击外部不关闭（防误触丢会话）。
  // 宿主编辑器（MediaEditDialog）通过 data-ai-assist 识别本层，外部点击时不误关。
  return createPortal(
    <div
      data-ai-assist="1"
      role="dialog"
      aria-modal="false"
      aria-label="AI 助理"
      className="fixed bottom-3 left-3 right-3 z-[80] flex h-[60dvh] w-auto flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl sm:bottom-5 sm:left-auto sm:right-5 sm:w-[min(92vw,400px)]"
    >
      {/* 头部 */}
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Sparkles className="size-4" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">AI 助理</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {MEDIA_KIND_LABEL[kind]} · 临时对话 · 不保存记录
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={skillsOpen ? '收起技能清单' : '查看技能清单'}
          title="技能清单"
          aria-expanded={skillsOpen}
          className={cn('size-8 shrink-0 rounded-full', skillsOpen && 'bg-accent text-accent-foreground')}
          onClick={() => {
            setSkillsOpen((v) => !v)
            setCfgOpen(false)
          }}
        >
          <Zap className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={cfgOpen ? '收起对话设置' : '对话设置'}
          title="对话设置"
          aria-expanded={cfgOpen}
          className={cn('size-8 shrink-0 rounded-full', cfgOpen && 'bg-accent text-accent-foreground')}
          onClick={() => {
            setCfgOpen((v) => !v)
            setSkillsOpen(false)
          }}
        >
          <Settings2 className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="关闭 AI 助理"
          className="size-8 shrink-0 rounded-full"
          onClick={() => onOpenChange(false)}
        >
          <X className="size-4" />
        </Button>
      </div>

      {/* 技能清单（可点击模板 → 填入输入框） */}
      {skillsOpen && (
        <div
          className="max-h-56 shrink-0 space-y-1.5 overflow-y-auto border-b border-border bg-muted/30 px-3 py-2.5"
          aria-label="AI 技能清单"
        >
          <p className="text-[11px] font-medium text-muted-foreground">
            AI 助理具备以下技能，点击即可把指令模板填入输入框：
          </p>
          {SKILLS.map((s) => (
            <button
              key={s.title}
              type="button"
              onClick={() => fillSkillTemplate(s.tpl)}
              className="w-full rounded-xl border border-border bg-background px-2.5 py-2 text-left transition-colors hover:bg-accent"
            >
              <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <Zap className="size-3 shrink-0 text-primary" />
                {s.title}
              </span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                {s.desc}
              </span>
            </button>
          ))}
          <p className="text-[10px] leading-relaxed text-muted-foreground/70">
            提示：「修改当前 / 解释 / 修复 / 优化 / 转换」都会把编辑器当前源码一并发给
            AI；「生成代码」也可搭配图片上传，让 AI 看手绘草图直接生成。
          </p>
        </div>
      )}

      {/* 对话设置（补充指令 + 温度） */}
      {cfgOpen && (
        <div className="shrink-0 space-y-3 border-b border-border bg-muted/30 px-3 py-2.5">
          <div>
            <label htmlFor="ai-assist-instruction" className="text-[11px] font-medium text-muted-foreground">
              系统补充指令（每次发送自动附加，仅本机保存）
            </label>
            <Textarea
              id="ai-assist-instruction"
              value={extraInstruction}
              onChange={(e) => setExtraInstruction(e.target.value)}
              rows={2}
              placeholder="例：配色简洁不花哨；标签统一中文；节点不超过 10 个"
              className="mt-1 min-h-14 resize-none rounded-xl bg-background text-xs"
            />
          </div>
          <div>
            <label className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
              <input
                type="checkbox"
                checked={tempOn}
                onChange={(e) => setTempOn(e.target.checked)}
                className="size-4 accent-primary"
              />
              自定义温度（不勾选用服务端默认）
            </label>
            {tempOn && (
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={1.5}
                  step={0.1}
                  value={temperature}
                  aria-label="采样温度"
                  onChange={(e) => setTemperature(Number(e.target.value))}
                  className="h-6 flex-1 accent-primary"
                />
                <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
                  {temperature.toFixed(1)}
                </span>
              </div>
            )}
            <p className="mt-1 text-[10px] text-muted-foreground/70">
              温度越低越稳定，越高越发散（0 ~ 1.5）
            </p>
          </div>
        </div>
      )}

        {/* 会话区 */}
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain px-3 py-3">
          {messages.length === 0 && !loading && (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
              <Sparkles className="size-6 text-muted-foreground/50" strokeWidth={1.5} />
              <p className="text-xs leading-relaxed text-muted-foreground">
                告诉 AI 你想要什么，例如：
                <br />
                「画一个三次函数图像」
                <br />
                「把这张思维导图再扩充一层」
                <br />
                「生成一张苏轼生平时间线表格」
              </p>
              <p className="text-[11px] leading-relaxed text-muted-foreground/70">
                可语音输入、上传手绘草图让 AI 看图生成；
                <br />
                点右上角 ⚡ 查看全部技能
              </p>
            </div>
          )}
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="flex flex-col items-end gap-1">
                <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3 py-2 text-sm text-primary-foreground">
                  {m.content}
                </p>
                {m.images && m.images.length > 0 && (
                  <div className="flex max-w-[85%] flex-wrap justify-end gap-1">
                    {m.images.map((img, k) => (
                      <img
                        key={k}
                        src={img}
                        alt={`附图 ${k + 1}`}
                        className="h-16 w-16 rounded-lg border border-border object-cover"
                      />
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div key={i} className="flex flex-col items-start gap-1">
                <div className="flex items-center gap-1 self-start">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                    AI
                  </span>
                  <button
                    type="button"
                    aria-label={speaking ? '停止朗读' : '朗读 AI 回复'}
                    title={speaking ? '停止朗读' : '朗读'}
                    onClick={() => (speaking ? stopSpeech() : speak(m.content))}
                    className="rounded p-1 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {speaking ? <Square className="size-3" /> : <Volume2 className="size-3" />}
                  </button>
                  <button
                    type="button"
                    aria-label="复制本条回复"
                    title="复制"
                    onClick={() => copyMessage(m.content)}
                    className="rounded p-1 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <Copy className="size-3" />
                  </button>
                </div>
                {splitCodeFences(m.content).map((seg, j) =>
                  seg.type === 'text' ? (
                    <p
                      key={j}
                      className="max-w-[92%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-muted px-3 py-2 text-sm"
                    >
                      {seg.value}
                    </p>
                  ) : (
                    <div
                      key={j}
                      className="w-full overflow-hidden rounded-2xl rounded-bl-md border border-border"
                    >
                      <div className="flex items-center justify-between gap-2 bg-muted/70 px-2.5 py-1.5">
                        <span className="text-[10px] font-medium text-muted-foreground">
                          {MEDIA_KIND_LABEL[kind]}代码
                        </span>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 rounded-full px-2 text-[11px] text-muted-foreground"
                            onClick={() => {
                              void navigator.clipboard
                                .writeText(seg.value)
                                .then(() => toast.success('代码已复制'))
                                .catch(() => toast.error('复制失败'))
                            }}
                          >
                            <Copy className="size-3" /> 复制
                          </Button>
                          <Button
                            size="sm"
                            className="h-7 rounded-full bg-zinc-900 px-2.5 text-[11px] font-medium text-white hover:bg-zinc-800"
                            onClick={() => applyCode(seg.value)}
                          >
                            <Check className="size-3" /> 应用到编辑器
                          </Button>
                        </div>
                      </div>
                      <pre className="max-h-44 overflow-auto bg-muted/30 p-2.5 font-mono text-[11px] leading-relaxed">
                        {seg.value}
                      </pre>
                    </div>
                  ),
                )}
              </div>
            ),
          )}
          {loading && (
            <div className="flex items-center gap-2 self-start rounded-2xl rounded-bl-md bg-muted px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> AI 正在生成…
            </div>
          )}
        </div>

        {/* 输入区 */}
        <div className="border-t border-border p-2.5">
          {/* 待发送附图缩略图 */}
          {pendingImages.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {pendingImages.map((img, i) => (
                <span key={i} className="relative">
                  <img
                    src={img}
                    alt={`待发送附图 ${i + 1}`}
                    className="h-14 w-14 rounded-lg border border-border object-cover"
                  />
                  <button
                    type="button"
                    aria-label={`移除附图 ${i + 1}`}
                    onClick={() => setPendingImages((arr) => arr.filter((_, k) => k !== i))}
                    className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-zinc-900/80 text-white shadow"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {/* 语音识别中状态（动效 + 实时中间结果） */}
          {micListening && (
            <div className="mb-2 flex items-start gap-1.5 rounded-xl border border-red-200 bg-red-50/70 px-2.5 py-1.5 dark:border-red-500/30 dark:bg-red-500/10">
              <span className="relative mt-1 flex size-2 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400" />
                <span className="relative inline-flex size-2 rounded-full bg-red-500" />
              </span>
              <p className="max-h-12 flex-1 overflow-y-auto text-xs leading-relaxed text-red-700 dark:text-red-300">
                {micInterim || '聆听中…（点击麦克风结束）'}
              </p>
            </div>
          )}
          <div className="flex items-end gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              aria-label="上传图片（最多 2 张，每张 ≤2MB）"
              title="上传图片（看图生成代码）"
              disabled={loading || pendingImages.length >= MAX_IMAGES}
              onClick={() => fileInputRef.current?.click()}
              className="size-10 shrink-0 rounded-full text-muted-foreground hover:bg-accent hover:text-emerald-600"
            >
              <ImagePlus className="size-4.5" strokeWidth={1.9} />
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => void handleFilesChange(e)}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={micListening ? '停止语音输入' : '语音输入'}
              title={micListening ? '停止语音输入' : '语音输入'}
              disabled={loading}
              onClick={() => (micListening ? micStop() : micStart())}
              className={cn(
                'size-10 shrink-0 rounded-full',
                micListening
                  ? 'bg-destructive text-white shadow-md shadow-destructive/30 hover:bg-destructive'
                  : 'text-muted-foreground hover:bg-accent hover:text-emerald-600',
              )}
            >
              {micListening ? <Square className="size-4" /> : <Mic className="size-4.5" strokeWidth={1.9} />}
            </Button>
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send()
                }
              }}
              rows={2}
              aria-label="对 AI 的指令"
              placeholder={`描述你想要的${MEDIA_KIND_LABEL[kind]}…`}
              className="min-h-11 flex-1 resize-none rounded-xl bg-muted/40 text-sm"
            />
            <Button
              size="icon"
              aria-label="发送"
              disabled={(!input.trim() && pendingImages.length === 0) || loading}
              onClick={() => void send()}
              className="size-11 shrink-0 rounded-full bg-zinc-900 text-white hover:bg-zinc-800"
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            </Button>
          </div>
          <p className={cn('pt-1.5 text-center text-[10px] text-muted-foreground/70')}>
            Enter 发送 · Shift+Enter 换行 · 应用后可继续可视化编辑
          </p>
        </div>
    </div>,
    document.body,
  )
}
