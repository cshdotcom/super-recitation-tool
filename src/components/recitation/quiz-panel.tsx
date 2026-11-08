'use client'

import * as React from 'react'
import {
  Loader2,
  FileQuestion,
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  RotateCcw,
  Check,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  Minus,
  Save,
  Star,
  Sparkles,
  AlertCircle,
} from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import type { QuizQuestion } from '@/lib/types'
import { putState, getState, deleteState } from '@/lib/server-state'
import { VoiceInput } from '@/components/recitation/voice-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// ---------- 扩展题型：两步出题新增 多选(multi) / 判断(judge) ----------
export type QuizTypeX = QuizQuestion['type'] | 'multi' | 'judge'

export interface QuizQuestionX {
  type: QuizTypeX
  question: string
  answer: string
  options?: string[]
}

const TYPE_LABEL: Record<QuizTypeX, string> = {
  fill: '填空',
  short: '简答',
  choice: '单选',
  multi: '多选',
  judge: '判断',
}

const VALID_TYPES: readonly string[] = ['fill', 'short', 'choice', 'multi', 'judge']

/** 多选题多个选项在同一字符串中的内部分隔符 */
const MULTI_SEP = '\u0001'

// ---------- 知识点 ----------
interface PointItem {
  id: string
  text: string
  importance: 'core' | 'secondary'
  source: 'ai' | 'manual'
}

// ---------- 题型配置（Step 2） ----------
const QUESTION_TYPES = [
  { key: 'choice', label: '单选题', hint: '四选一', def: 5 },
  { key: 'multi', label: '多选题', hint: '多个正确答案', def: 3 },
  { key: 'judge', label: '判断题', hint: '正确 / 错误', def: 5 },
  { key: 'fill', label: '填空题', hint: '补全空缺内容', def: 5 },
  { key: 'short', label: '简答题', hint: '简答要点 · 自评对错', def: 3 },
] as const
type QuestionTypeKey = (typeof QUESTION_TYPES)[number]['key']
const MAX_PER_TYPE = 10

// ---------- 出题期间进度文案 ----------
const POINT_STAGES = ['正在阅读课文…', '正在提炼核心考点…', '正在整理知识点…', '即将完成…']
const GEN_STAGES = ['正在回顾知识点…', '正在编写题目…', '正在核对答案…', '即将完成…']

// ---------- 作答记录（错题本展示「我的答案」用，key = cardId::question） ----------
// 服务端为主（/api/state key=quiz:user-answers），localStorage 仅作离线镜像。
const USER_ANSWERS_KEY = 'sb:quiz:user-answers:v1'
const SERVER_ANSWERS_KEY = 'quiz:user-answers'

export interface QuizUserAnswer {
  userAnswer: string
  at: number
}

export function userAnswerKey(cardId: string, question: string): string {
  return `${cardId}::${question}`
}

/** 内存缓存（避免每次作答都重新拉取）。 */
let answersCache: Record<string, QuizUserAnswer> | null = null

function readLocalAnswers(): Record<string, QuizUserAnswer> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(USER_ANSWERS_KEY)
    return raw
      ? (JSON.parse(raw) as Record<string, QuizUserAnswer>)
      : {}
  } catch {
    return {}
  }
}

function writeLocalAnswers(all: Record<string, QuizUserAnswer>) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(USER_ANSWERS_KEY, JSON.stringify(all))
  } catch {
    /* ignore */
  }
}

function trimAnswers(all: Record<string, QuizUserAnswer>) {
  const keys = Object.keys(all)
  if (keys.length <= 300) return all
  const out: Record<string, QuizUserAnswer> = {}
  for (const k of keys.slice(keys.length - 300)) out[k] = all[k]
  return out
}

/** 服务端优先加载作答记录（首次调用时自动把本地旧数据迁移上服务端）。 */
export async function fetchQuizUserAnswers(): Promise<Record<string, QuizUserAnswer>> {
  if (answersCache) return answersCache
  const local = readLocalAnswers()
  try {
    const values = await getState([SERVER_ANSWERS_KEY])
    const raw = values[SERVER_ANSWERS_KEY]
    if (raw) {
      const server = JSON.parse(raw) as Record<string, QuizUserAnswer>
      const merged = { ...local, ...server }
      answersCache = merged
      // 本地有而服务端没有（旧版本数据）→ 迁移上传
      if (Object.keys(local).some((k) => !(k in server))) {
        void putState(SERVER_ANSWERS_KEY, JSON.stringify(trimAnswers(merged)))
      }
      return merged
    }
    if (Object.keys(local).length > 0) {
      // 服务端为空但本地有 → 全量迁移
      void putState(SERVER_ANSWERS_KEY, JSON.stringify(trimAnswers(local)))
    }
  } catch {
    /* 解析失败 → 使用本地镜像 */
  }
  answersCache = local
  return local
}

/** 记录一次作答（同步写入内存 + 异步落库服务端 + 本地镜像）。 */
export function recordQuizUserAnswer(cardId: string, question: string, userAnswer: string) {
  if (typeof window === 'undefined' || !cardId || !question) return
  void (async () => {
    const all = await fetchQuizUserAnswers()
    all[userAnswerKey(cardId, question)] = {
      userAnswer: userAnswer.slice(0, 500),
      at: Date.now(),
    }
    writeLocalAnswers(all)
    await putState(SERVER_ANSWERS_KEY, JSON.stringify(trimAnswers(all)))
  })()
}

// ---------- 作答草稿（key 含 cardId，服务端为主 + localStorage 镜像） ----------
const draftKey = (cardId?: string) => `sb:quiz:draft:${cardId || 'adhoc'}`
const draftStateKey = (cardId?: string) => `quiz:draft:${cardId || 'adhoc'}`

interface QuizDraft {
  v: 1
  savedAt: number
  prompted?: boolean
  questions: QuizQuestionX[]
  answers: Record<number, string>
  revealed: number[]
  favorites: number[]
  checkMode: 'all' | 'each'
}

// ---------- 判定 ----------
function normText(s: string): string {
  return s
    .replace(/\s+/g, '')
    .replace(/[。．.，,、；;：:！!？?"'「」『』（）()【】[\]]/g, '')
}

function normJudge(s: string): string {
  const t = (s || '').trim()
  if (['对', '正确', '√', '是', 'T', 'true'].includes(t)) return '正确'
  if (['错', '错误', '×', 'X', '否', 'F', 'false'].includes(t)) return '错误'
  return t
}

/** null = 需要自评（简答题） */
function gradeAnswer(q: QuizQuestionX, userAns: string): boolean | null {
  const ans = (userAns || '').trim()
  if (!ans) return false
  switch (q.type) {
    case 'choice':
      return ans === q.answer.trim()
    case 'judge':
      return normJudge(ans) === normJudge(q.answer)
    case 'multi': {
      const picked = ans
        .split(MULTI_SEP)
        .map((s) => s.trim())
        .filter(Boolean)
      const correct = q.answer
        .split(/[、,，;；]/)
        .map((s) => s.trim())
        .filter(Boolean)
      if (picked.length === 0 || picked.length !== correct.length) return false
      return [...picked].sort().join('\u0002') === [...correct].sort().join('\u0002')
    }
    case 'fill': {
      if (normText(ans) === normText(q.answer)) return true
      const ua = ans
        .split(/[、,，;；]/)
        .map((s) => normText(s))
        .filter(Boolean)
      const ca = q.answer
        .split(/[、,，;；]/)
        .map((s) => normText(s))
        .filter(Boolean)
      return ua.length > 1 && ua.length === ca.length && ua.every((x, i) => x === ca[i])
    }
    case 'short':
    default:
      return null
  }
}

function formatDraftAge(ts: number): string {
  const min = Math.max(1, Math.round((Date.now() - ts) / 60000))
  if (min < 60) return `${min} 分钟前`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.round(h / 24)} 天前`
}

interface QuizPanelProps {
  content: string
  keywords: string[]
  /** 错题/收藏上报归属卡 */
  cardId?: string
  cardTitle?: string
  /** 答对后自动移除错题 — 答对N次后 */
  autoRemove?: number
}

type Step = 'idle' | 'points' | 'types' | 'generating' | 'answering'

export function QuizPanel({
  content,
  keywords,
  cardId,
  cardTitle,
  autoRemove = 2,
}: QuizPanelProps) {
  // ---- 向导步骤 ----
  const [step, setStep] = React.useState<Step>(content.trim() ? 'points' : 'idle')

  // ---- Step1 知识点 ----
  const [points, setPoints] = React.useState<PointItem[]>([])
  const [selectedPoints, setSelectedPoints] = React.useState<Set<string>>(new Set())
  const [pointsLoading, setPointsLoading] = React.useState(false)
  const [pointsError, setPointsError] = React.useState<string | null>(null)
  const [editingPoint, setEditingPoint] = React.useState<PointItem | null>(null)
  const [editText, setEditText] = React.useState('')
  const [editImportance, setEditImportance] = React.useState<'core' | 'secondary'>('core')
  const [addOpen, setAddOpen] = React.useState(false)
  const [addText, setAddText] = React.useState('')
  const [addImportance, setAddImportance] = React.useState<'core' | 'secondary'>('core')

  // ---- Step2 题型数量 ----
  const [typeCounts, setTypeCounts] = React.useState<Record<QuestionTypeKey, number>>({
    choice: 5,
    multi: 3,
    judge: 5,
    fill: 5,
    short: 3,
  })
  const totalCount = React.useMemo(
    () => Object.values(typeCounts).reduce((a, b) => a + b, 0),
    [typeCounts],
  )

  // ---- 加载进度文案 ----
  const [stageIdx, setStageIdx] = React.useState(0)
  const stageLenRef = React.useRef(POINT_STAGES.length)
  const stageTimer = React.useRef<number | null>(null)
  const startStages = React.useCallback((len: number) => {
    stageLenRef.current = len
    setStageIdx(0)
    if (stageTimer.current) window.clearInterval(stageTimer.current)
    stageTimer.current = window.setInterval(() => {
      setStageIdx((i) => Math.min(i + 1, stageLenRef.current - 1))
    }, 2600)
  }, [])
  const stopStages = React.useCallback(() => {
    if (stageTimer.current) {
      window.clearInterval(stageTimer.current)
      stageTimer.current = null
    }
  }, [])
  React.useEffect(() => stopStages, [stopStages])

  // ---- 作答 ----
  const [questions, setQuestions] = React.useState<QuizQuestionX[]>([])
  const [answers, setAnswers] = React.useState<Record<number, string>>({})
  const [revealed, setRevealed] = React.useState<Set<number>>(new Set())
  const [favorites, setFavorites] = React.useState<Set<number>>(new Set())
  const [checkMode, setCheckMode] = React.useState<'all' | 'each'>('all')
  const [checked, setChecked] = React.useState(false)
  const [selfJudge, setSelfJudge] = React.useState<Record<number, boolean>>({})
  const [reported, setReported] = React.useState<Set<number>>(new Set())
  const [quizStart, setQuizStart] = React.useState<number>(Date.now())

  // ---- 草稿恢复 ----
  const [pendingDraft, setPendingDraft] = React.useState<QuizDraft | null>(null)
  const draftCheckedRef = React.useRef(false)

  // ---- Step1：AI 提炼知识点 ----
  const fetchPoints = React.useCallback(async () => {
    if (!content.trim()) return
    setPointsLoading(true)
    setPointsError(null)
    startStages(POINT_STAGES.length)
    try {
      const res = await fetch('/api/quiz-points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '知识点生成失败')
      }
      const data = (await res.json()) as {
        points?: { text: string; importance: 'core' | 'secondary' }[]
      }
      const pts: PointItem[] = (data.points ?? []).map((p, i) => ({
        id: `pt-${i}-${p.text.slice(0, 8)}`,
        text: p.text,
        importance: p.importance === 'core' ? 'core' : 'secondary',
        source: 'ai' as const,
      }))
      if (pts.length === 0) throw new Error('AI 未返回知识点，请重试')
      setPoints(pts)
      setSelectedPoints(new Set(pts.map((p) => p.id)))
    } catch (err) {
      setPointsError(err instanceof Error ? err.message : '知识点生成失败')
    } finally {
      stopStages()
      setPointsLoading(false)
    }
  }, [content, startStages, stopStages])

  // 首次进入：从服务端检测同卡片的作答草稿 → 弹「恢复上次作答？」
  // （服务端为主，localStorage 只作离线镜像；发现仅本地有旧草稿时自动迁移上传）
  React.useEffect(() => {
    draftCheckedRef.current = true
    let alive = true
    void (async () => {
      const validate = (d: unknown): d is QuizDraft => {
        const x = d as QuizDraft
        const ok =
          x?.v === 1 &&
          Array.isArray(x.questions) &&
          x.questions.some(
            (q) =>
              q &&
              typeof q.question === 'string' &&
              typeof q.answer === 'string' &&
              VALID_TYPES.includes(q.type),
          ) &&
          !x.prompted
        return ok
      }
      // 1) 服务端草稿
      try {
        const values = await getState([draftStateKey(cardId)])
        const raw = values[draftStateKey(cardId)]
        if (raw) {
          const d = JSON.parse(raw) as QuizDraft
          if (alive && validate(d)) setPendingDraft(d)
          return
        }
      } catch {
        /* 服务端不可用 → 回退本地 */
      }
      // 2) 本地旧草稿（迁移上传后仍可恢复）
      try {
        const raw = window.localStorage.getItem(draftKey(cardId))
        if (!raw) return
        const d = JSON.parse(raw) as QuizDraft
        if (validate(d)) {
          if (alive) setPendingDraft(d)
          void putState(draftStateKey(cardId), raw) // 迁移到服务端
        }
      } catch {
        /* ignore */
      }
    })()
    return () => {
      alive = false
    }
  }, [cardId])

  // 进入 Step1 且尚无知识点数据时自动拉取（含草稿取消后的进入）
  React.useEffect(() => {
    if (!draftCheckedRef.current) return
    if (step === 'points' && points.length === 0 && !pointsLoading && !pointsError) {
      void fetchPoints()
    }
  }, [step, points.length, pointsLoading, pointsError, fetchPoints])

  const clearDraftStorage = React.useCallback(() => {
    void deleteState(draftStateKey(cardId))
    try {
      window.localStorage.removeItem(draftKey(cardId))
    } catch {
      /* ignore */
    }
  }, [cardId])

  const dismissDraft = () => {
    setPendingDraft(null)
    // 标记「已提示过」并写回服务端（+本地镜像），不再重复弹窗
    void (async () => {
      let d: QuizDraft | null = null
      try {
        const values = await getState([draftStateKey(cardId)])
        const raw = values[draftStateKey(cardId)]
        if (raw) d = JSON.parse(raw) as QuizDraft
      } catch {}
      if (!d) {
        try {
          const raw = window.localStorage.getItem(draftKey(cardId))
          if (raw) d = JSON.parse(raw) as QuizDraft
        } catch {}
      }
      if (d) {
        d.prompted = true
        const s = JSON.stringify(d)
        void putState(draftStateKey(cardId), s)
        try {
          window.localStorage.setItem(draftKey(cardId), s)
        } catch {}
      }
    })()
  }

  const restoreDraft = (d: QuizDraft) => {
    const qs = (d.questions || []).filter(
      (q): q is QuizQuestionX =>
        !!q &&
        typeof q.question === 'string' &&
        typeof q.answer === 'string' &&
        VALID_TYPES.includes(q.type),
    )
    setPendingDraft(null)
    if (qs.length === 0) return
    setQuestions(qs)
    setAnswers(d.answers ?? {})
    setRevealed(new Set(Array.isArray(d.revealed) ? d.revealed : []))
    setFavorites(new Set(Array.isArray(d.favorites) ? d.favorites : []))
    setCheckMode(d.checkMode === 'each' ? 'each' : 'all')
    setChecked(false)
    setSelfJudge({})
    setReported(new Set())
    setQuizStart(Date.now())
    setStep('answering')
    toast.success('已恢复上次作答')
  }

  const saveDraft = () => {
    if (questions.length === 0) return
    const draft: QuizDraft = {
      v: 1,
      savedAt: Date.now(),
      questions,
      answers,
      revealed: [...revealed],
      favorites: [...favorites],
      checkMode,
    }
    const s = JSON.stringify(draft)
    // 服务端为主 + 本地镜像（离线兜底）
    void putState(draftStateKey(cardId), s)
    try {
      window.localStorage.setItem(draftKey(cardId), s)
    } catch {
      /* ignore */
    }
    toast.success('已添加到草稿（已存服务端），下次打开可恢复')
  }

  // ---- Step2 → 生成题目 ----
  const generate = async () => {
    const sel = points.filter((p) => selectedPoints.has(p.id))
    if (sel.length === 0) {
      toast.warning('请至少选择一个知识点')
      return
    }
    setStep('generating')
    startStages(GEN_STAGES.length)
    try {
      const res = await fetch('/api/quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          keywords,
          points: sel.map((p) => ({ text: p.text, importance: p.importance })),
          types: typeCounts,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || '出题失败')
      }
      const data = (await res.json()) as { questions?: QuizQuestionX[] }
      const qs = (data.questions ?? []).filter(
        (q): q is QuizQuestionX =>
          !!q && typeof q.question === 'string' && typeof q.answer === 'string',
      )
      if (qs.length === 0) throw new Error('AI 未返回题目，请重试')
      setQuestions(qs)
      setAnswers({})
      setRevealed(new Set())
      setFavorites(new Set())
      setChecked(false)
      setSelfJudge({})
      setReported(new Set())
      setQuizStart(Date.now())
      clearDraftStorage()
      setStep('answering')
      toast.success(`已生成 ${qs.length} 道题`)
    } catch (err) {
      toast.error('出题失败：' + (err instanceof Error ? err.message : '未知错误'))
      setStep('types')
    } finally {
      stopStages()
    }
  }

  // ---- 错题/收藏上报 ----
  const reportItem = (q: QuizQuestionX, right: boolean, userAns: string, silent = false) => {
    const isJudge = q.type === 'judge'
    void fetch('/api/quiz-items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cardId,
        cardTitle,
        // 判断题按双选项单选上报、多选按填空上报（答案即选项文本），便于错题本重练
        type: isJudge ? 'choice' : q.type,
        question: q.question,
        answer: isJudge ? normJudge(q.answer) : q.answer,
        options: isJudge ? ['正确', '错误'] : q.type === 'multi' ? [] : (q.options ?? []),
        result: right ? 'right' : 'wrong',
        autoRemove,
        durationSec: Math.min(600, Math.round((Date.now() - quizStart) / 1000)),
        userAnswer: userAns.slice(0, 500),
      }),
    }).catch(() => {})
    recordQuizUserAnswer(cardId || '', q.question, userAns)
    if (!silent && !right) toast.warning('已加入错题本')
  }

  // ---- 逐题检查：查看答案 ----
  const toggleReveal = (idx: number) => {
    const q = questions[idx]
    if (!q) return
    const willReveal = !revealed.has(idx)
    setRevealed((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
    if (!willReveal || reported.has(idx)) return
    const g = gradeAnswer(q, answers[idx] || '')
    if (g === null) return // 简答题：等自评
    setReported((prev) => new Set(prev).add(idx))
    reportItem(q, g, answers[idx] || '')
  }

  // ---- 简答题自评（对/错计入错题） ----
  const judgeSelf = (idx: number, right: boolean) => {
    setSelfJudge((prev) => ({ ...prev, [idx]: right }))
    if (reported.has(idx)) return
    setReported((prev) => new Set(prev).add(idx))
    const q = questions[idx]
    if (q) reportItem(q, right, answers[idx] || '')
  }

  // ---- 统一检查：全部作答完一次性判分 ----
  const runUnifiedCheck = () => {
    const unanswered = questions.filter((_, i) => !(answers[i] || '').trim()).length
    if (unanswered > 0) {
      toast.warning(`还有 ${unanswered} 道题未作答，请先完成`)
      return
    }
    setChecked(true)
    setRevealed(new Set(questions.map((_, i) => i)))
    let wrong = 0
    const newReported = new Set<number>()
    questions.forEach((q, i) => {
      if (q.type === 'short') return // 简答题等待自评
      const right = gradeAnswer(q, answers[i] || '') === true
      newReported.add(i)
      if (!right) wrong++
      reportItem(q, right, answers[i] || '', true)
    })
    setReported(newReported)
    const shortCount = questions.filter((q) => q.type === 'short').length
    if (shortCount > 0) {
      toast(
        `${wrong > 0 ? `答错 ${wrong} 题；` : ''}${shortCount} 道简答题请对照参考答案自评`,
      )
    } else if (wrong > 0) {
      toast.warning(`${wrong} 道题已加入错题本`)
    } else {
      toast.success('全部答对，太棒了！')
    }
  }

  const answeredCount = questions.filter((_, i) => (answers[i] || '').trim()).length

  const score = React.useMemo(() => {
    let total = 0
    let right = 0
    questions.forEach((q, i) => {
      if (!reported.has(i)) return
      total++
      if (q.type === 'short') {
        if (selfJudge[i]) right++
      } else if (gradeAnswer(q, answers[i] || '') === true) {
        right++
      }
    })
    return { total, right }
  }, [questions, reported, selfJudge, answers])

  const clearAnswers = () => {
    setAnswers({})
    setRevealed(new Set())
    setChecked(false)
    setSelfJudge({})
    setReported(new Set())
    setQuizStart(Date.now())
  }

  // ---- 收藏 ----
  const toggleFavorite = (idx: number) => {
    const q = questions[idx]
    if (!q) return
    const willFav = !favorites.has(idx)
    setFavorites((prev) => {
      const next = new Set(prev)
      if (willFav) next.add(idx)
      else next.delete(idx)
      return next
    })
    const isJudge = q.type === 'judge'
    void fetch('/api/quiz-items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cardId,
        cardTitle,
        type: isJudge ? 'choice' : q.type,
        question: q.question,
        answer: isJudge ? normJudge(q.answer) : q.answer,
        options: isJudge ? ['正确', '错误'] : q.type === 'multi' ? [] : (q.options ?? []),
        favorite: willFav,
      }),
    })
      .then(() => toast.success(willFav ? '已收藏题目' : '已取消收藏'))
      .catch(() => toast.error('收藏失败，请重试'))
  }

  // ---- 知识点操作 ----
  const allSelected = points.length > 0 && points.every((p) => selectedPoints.has(p.id))
  const toggleAllPoints = () => {
    setSelectedPoints(allSelected ? new Set() : new Set(points.map((p) => p.id)))
  }
  const togglePoint = (id: string) => {
    setSelectedPoints((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const openEditPoint = (p: PointItem) => {
    setEditingPoint(p)
    setEditText(p.text)
    setEditImportance(p.importance)
  }
  const saveEditPoint = () => {
    const text = editText.trim()
    if (!text) {
      toast.warning('知识点内容不能为空')
      return
    }
    if (editingPoint) {
      setPoints((prev) =>
        prev.map((p) =>
          p.id === editingPoint.id ? { ...p, text, importance: editImportance } : p,
        ),
      )
    }
    setEditingPoint(null)
    toast.success('已更新知识点')
  }
  const addPoint = () => {
    const text = addText.trim()
    if (!text) {
      toast.warning('请输入知识点内容')
      return
    }
    const item: PointItem = {
      id: `pt-m-${Date.now()}`,
      text,
      importance: addImportance,
      source: 'manual',
    }
    setPoints((prev) => [...prev, item])
    setSelectedPoints((prev) => new Set(prev).add(item.id))
    setAddText('')
    setAddImportance('core')
    setAddOpen(false)
    toast.success('已添加知识点')
  }

  const setAnswer = (idx: number, val: string) => {
    setAnswers((prev) => ({ ...prev, [idx]: val }))
  }

  const toggleMultiOption = (idx: number, opt: string) => {
    setAnswers((prev) => {
      const cur = (prev[idx] || '').split(MULTI_SEP).filter(Boolean)
      const next = cur.includes(opt) ? cur.filter((o) => o !== opt) : [...cur, opt]
      return { ...prev, [idx]: next.join(MULTI_SEP) }
    })
  }

  return (
    <div className="flex min-h-[62vh] flex-col">
      {/* ================= 空闲入口 ================= */}
      {step === 'idle' && (
        <IdleView canStart={!!content.trim()} onStart={() => setStep('points')} />
      )}

      {/* ================= Step 1 选择知识点 ================= */}
      {step === 'points' && (
        <div className="flex flex-1 flex-col">
          <StepHeader
            title="选择知识点"
            onBack={() => setStep('idle')}
            right={
              points.length > 0 && !pointsLoading ? (
                <button
                  type="button"
                  onClick={toggleAllPoints}
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  {allSelected ? '取消全选' : '全选'}
                </button>
              ) : null
            }
          />
          {pointsLoading || (!pointsError && points.length === 0) ? (
            <ProgressView
              text={POINT_STAGES[Math.min(stageIdx, POINT_STAGES.length - 1)]}
              sub="AI 正在从课文中提炼知识点"
            />
          ) : pointsError ? (
            <ErrorView message={pointsError} onRetry={() => void fetchPoints()} />
          ) : (
            <>
              <p className="px-1 pb-2 text-xs text-muted-foreground">
                AI 从课文提炼出 {points.length} 个知识点，勾选出题范围
              </p>
              <div className="flex flex-col gap-2">
                {points.map((p, i) => (
                  <PointCard
                    key={p.id}
                    index={i}
                    point={p}
                    selected={selectedPoints.has(p.id)}
                    onToggle={() => togglePoint(p.id)}
                    onEdit={() => openEditPoint(p)}
                  />
                ))}
              </div>
              <div className="sticky bottom-0 mt-6 rounded-2xl border border-border bg-card/95 p-3 shadow-lg shadow-black/5 backdrop-blur">
                <p className="pb-2 text-center text-xs text-muted-foreground">
                  已选 {selectedPoints.size} / {points.length} 个知识点
                </p>
                <div className="flex gap-2.5">
                  <Button
                    variant="outline"
                    className="h-12 flex-1 rounded-2xl text-base"
                    onClick={() => setAddOpen(true)}
                  >
                    <Plus className="size-4" /> 添加知识点
                  </Button>
                  <Button
                    className="h-12 flex-[1.3] rounded-full bg-zinc-900 text-base font-semibold text-white hover:bg-zinc-800"
                    disabled={selectedPoints.size === 0}
                    onClick={() => setStep('types')}
                  >
                    下一步 <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ================= Step 2 选择题型 ================= */}
      {step === 'types' && (
        <div className="flex flex-1 flex-col">
          <StepHeader
            title="选择题型"
            onBack={() => setStep('points')}
            right={<span className="text-xs text-muted-foreground">共 {totalCount} 题</span>}
          />
          <div className="flex flex-col gap-2.5">
            {QUESTION_TYPES.map((t) => {
              const n = typeCounts[t.key]
              return (
                <div
                  key={t.key}
                  className="flex items-center justify-between gap-2 rounded-2xl border border-border bg-card px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold">{t.label}</p>
                    <p className="text-[11px] text-muted-foreground">{t.hint}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <SquareBtn
                      label={`减少${t.label}数量`}
                      disabled={n <= 0}
                      onClick={() =>
                        setTypeCounts((prev) => ({ ...prev, [t.key]: Math.max(0, n - 1) }))
                      }
                    >
                      <Minus className="size-4" />
                    </SquareBtn>
                    <span className="flex h-9 min-w-14 items-center justify-center rounded-full bg-muted px-1.5">
                      <input
                        type="number"
                        min={0}
                        max={MAX_PER_TYPE}
                        value={n}
                        onChange={(e) => {
                          const v = Math.max(
                            0,
                            Math.min(MAX_PER_TYPE, Math.floor(Number(e.target.value) || 0)),
                          )
                          setTypeCounts((prev) => ({ ...prev, [t.key]: v }))
                        }}
                        aria-label={`${t.label}数量`}
                        className="w-7 bg-transparent text-center text-sm font-bold text-foreground outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      />
                      <span className="text-xs text-muted-foreground">题</span>
                    </span>
                    <SquareBtn
                      label={`增加${t.label}数量`}
                      disabled={n >= MAX_PER_TYPE}
                      onClick={() =>
                        setTypeCounts((prev) => ({
                          ...prev,
                          [t.key]: Math.min(MAX_PER_TYPE, n + 1),
                        }))
                      }
                    >
                      <Plus className="size-4" />
                    </SquareBtn>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="sticky bottom-0 mt-6 rounded-2xl border border-border bg-card/95 p-3 shadow-lg shadow-black/5 backdrop-blur">
            <p className="pb-2 text-center text-xs text-muted-foreground">
              将根据已选的 {selectedPoints.size} 个知识点出 {totalCount} 道题
            </p>
            <Button
              className="h-12 w-full rounded-full bg-zinc-900 text-base font-semibold text-white hover:bg-zinc-800"
              disabled={totalCount === 0}
              onClick={() => void generate()}
            >
              下一步 <ChevronRight className="size-4" />
            </Button>
            {questions.length > 0 && (
              <button
                type="button"
                onClick={() => setStep('answering')}
                className="mt-2 w-full text-center text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                返回已生成的 {questions.length} 道题
              </button>
            )}
          </div>
        </div>
      )}

      {/* ================= 出题中 ================= */}
      {step === 'generating' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-5 py-16 text-center">
          <div className="flex size-16 items-center justify-center rounded-full bg-emerald-500/10">
            <Loader2 className="size-8 animate-spin text-emerald-600" />
          </div>
          <div>
            <p className="text-sm font-bold">
              {GEN_STAGES[Math.min(stageIdx, GEN_STAGES.length - 1)]}
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              AI 正在根据 {selectedPoints.size} 个知识点编写 {totalCount} 道题，请稍候…
            </p>
          </div>
          <div className="h-1.5 w-40 overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-emerald-500/70" />
          </div>
        </div>
      )}

      {/* ================= 作答 ================= */}
      {step === 'answering' && questions.length > 0 && (
        <div className="flex flex-1 flex-col">
          <StepHeader
            title="开始答题"
            onBack={() => setStep('types')}
            right={
              <button
                type="button"
                onClick={saveDraft}
                className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <Save className="size-3.5" /> 存草稿
              </button>
            }
          />

          {/* 检查模式切换 + 进度 */}
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex rounded-full bg-muted p-0.5">
              {(
                [
                  { key: 'all', label: '统一检查' },
                  { key: 'each', label: '逐题检查' },
                ] as const
              ).map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setCheckMode(m.key)}
                  className={cn(
                    'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                    checkMode === m.key ? 'bg-zinc-900 text-white' : 'text-muted-foreground',
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">
              已答 {answeredCount} / {questions.length}
            </span>
          </div>

          <ol className="flex flex-col gap-3">
            {questions.map((q, idx) => {
              const isJudge = q.type === 'judge'
              const isMulti = q.type === 'multi'
              const isChoice = q.type === 'choice'
              const isShort = q.type === 'short'
              const userAnswer = answers[idx] || ''
              const isRevealed = revealed.has(idx) || (checkMode === 'all' && checked)
              const isReported = reported.has(idx)
              const options = isJudge ? ['正确', '错误'] : (q.options ?? [])
              const pickedSet = isMulti
                ? new Set(userAnswer.split(MULTI_SEP).filter(Boolean))
                : null
              const isRight = isShort ? selfJudge[idx] === true : gradeAnswer(q, userAnswer) === true
              const multiCorrect = isMulti
                ? q.answer
                    .split(/[、,，;；]/)
                    .map((s) => s.trim())
                    .filter(Boolean)
                : null

              return (
                <li key={idx}>
                  <Card className="gap-3 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-start gap-2">
                        <span className="pt-0.5 text-xs font-semibold text-muted-foreground">
                          {idx + 1}.
                        </span>
                        <p className="text-sm leading-relaxed">{renderQuestionText(q.question)}</p>
                      </div>
                      <Badge variant="secondary" className={cn('shrink-0', badgeTone(q.type))}>
                        {TYPE_LABEL[q.type]}
                      </Badge>
                      <button
                        type="button"
                        aria-label={favorites.has(idx) ? '取消收藏' : '收藏题目'}
                        onClick={() => toggleFavorite(idx)}
                        className={cn(
                          'shrink-0 rounded-full p-1.5 transition-colors',
                          favorites.has(idx)
                            ? 'text-amber-400 hover:text-amber-500'
                            : 'text-muted-foreground/50 hover:text-amber-400',
                        )}
                      >
                        <Star
                          className="size-4"
                          strokeWidth={1.75}
                          fill={favorites.has(idx) ? 'currentColor' : 'none'}
                        />
                      </button>
                    </div>

                    {/* 选择 / 多选 / 判断 */}
                    {(isChoice || isJudge || isMulti) && (
                      <div className="flex flex-col gap-1.5">
                        {options.map((opt, oIdx) => {
                          const selected = isMulti
                            ? pickedSet?.has(opt) ?? false
                            : userAnswer === opt
                          const correctOpt = isRevealed
                            ? isMulti
                              ? multiCorrect?.includes(opt) ?? false
                              : opt === q.answer
                            : false
                          const wrongPick = isRevealed && selected && !correctOpt
                          return (
                            <button
                              key={oIdx}
                              type="button"
                              disabled={isRevealed}
                              onClick={() =>
                                isMulti ? toggleMultiOption(idx, opt) : setAnswer(idx, opt)
                              }
                              className={cn(
                                'flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors',
                                !isRevealed && selected
                                  ? 'border-emerald-500/50 bg-emerald-500/10'
                                  : 'hover:bg-accent',
                                correctOpt &&
                                  'border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
                                wrongPick &&
                                  'border-destructive/40 bg-destructive/10 text-destructive',
                              )}
                            >
                              <span>
                                {isChoice && (
                                  <span className="mr-1.5 font-semibold text-muted-foreground">
                                    {String.fromCharCode(65 + oIdx)}.
                                  </span>
                                )}
                                {opt}
                              </span>
                              {correctOpt && (
                                <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
                              )}
                              {wrongPick && <XCircle className="size-4 shrink-0 text-destructive" />}
                              {isMulti && !isRevealed && selected && (
                                <Check className="size-4 shrink-0 text-emerald-600" />
                              )}
                            </button>
                          )
                        })}
                      </div>
                    )}

                    {/* 填空 / 简答（均支持语音输入） */}
                    {(q.type === 'fill' || isShort) && (
                      <div className="flex flex-col gap-2">
                        {isShort ? (
                          <div className="flex items-end gap-1.5">
                            <Textarea
                              value={userAnswer}
                              onChange={(e) => setAnswer(idx, e.target.value)}
                              placeholder="在此输入你的答案…（可语音输入）"
                              rows={3}
                              disabled={isRevealed}
                              className="text-sm"
                            />
                            <VoiceInput
                              size="sm"
                              context="quiz"
                              disabled={isRevealed}
                              onText={(t) =>
                                setAnswer(
                                  idx,
                                  (answers[idx] || '') + t,
                                )
                              }
                            />
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <Input
                              value={userAnswer}
                              onChange={(e) => setAnswer(idx, e.target.value)}
                              placeholder="在此输入你的答案…（可语音输入）"
                              disabled={isRevealed}
                            />
                            <VoiceInput
                              size="sm"
                              context="quiz"
                              disabled={isRevealed}
                              onText={(t) =>
                                setAnswer(
                                  idx,
                                  (answers[idx] || '') + t,
                                )
                              }
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {/* 答案 */}
                    {isRevealed && (
                      <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                        <p>
                          <span className="text-muted-foreground">参考答案：</span>
                          <span className="font-medium text-emerald-700 dark:text-emerald-300">
                            {isJudge ? normJudge(q.answer) : q.answer}
                          </span>
                        </p>
                        {isMulti && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            你的选择：
                            {userAnswer.split(MULTI_SEP).filter(Boolean).join('、') || '（未作答）'}
                          </p>
                        )}
                        {isShort && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            简答题请对照参考答案，自评对错
                          </p>
                        )}
                      </div>
                    )}

                    {/* 简答题自评 */}
                    {isRevealed && isShort && !isReported && (
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          className="h-10 flex-1 rounded-full border-destructive/40 text-sm text-destructive hover:bg-destructive/10"
                          onClick={() => judgeSelf(idx, false)}
                        >
                          <XCircle className="size-4" /> 答错了
                        </Button>
                        <Button
                          className="h-10 flex-1 rounded-full bg-emerald-600 text-sm text-white hover:bg-emerald-700"
                          onClick={() => judgeSelf(idx, true)}
                        >
                          <CheckCircle2 className="size-4" /> 答对了
                        </Button>
                      </div>
                    )}

                    {/* 判定结果 */}
                    {isReported && (
                      <div className="flex items-center justify-end gap-1 text-xs font-medium">
                        {isRight ? (
                          <span className="flex items-center gap-1 text-emerald-600">
                            <CheckCircle2 className="size-3.5" /> 答对
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-destructive">
                            <XCircle className="size-3.5" /> 答错
                          </span>
                        )}
                      </div>
                    )}

                    {/* 逐题检查按钮 */}
                    {checkMode === 'each' && (
                      <div className="flex items-center justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleReveal(idx)}
                          className="text-xs text-muted-foreground"
                        >
                          {isRevealed ? (
                            <>
                              <EyeOff className="size-3" /> 隐藏答案
                            </>
                          ) : (
                            <>
                              <Eye className="size-3" /> 查看答案
                            </>
                          )}
                        </Button>
                      </div>
                    )}
                  </Card>
                </li>
              )
            })}
          </ol>

          {/* 得分 */}
          {score.total > 0 && (
            <div className="mt-3 flex items-center justify-between rounded-xl border bg-muted/30 px-4 py-2.5 text-sm">
              <span className="text-muted-foreground">
                练习得分{questions.some((q) => q.type === 'short') ? '（简答按自评计）' : ''}
              </span>
              <span className="font-bold">
                {score.right} / {score.total}
              </span>
            </div>
          )}

          {/* 底部操作 */}
          <div className="sticky bottom-0 mt-6 rounded-2xl border border-border bg-card/95 p-3 shadow-lg shadow-black/5 backdrop-blur">
            {checkMode === 'all' && !checked ? (
              <Button
                className="h-12 w-full rounded-full bg-zinc-900 text-base font-semibold text-white hover:bg-zinc-800"
                onClick={runUnifiedCheck}
              >
                <CheckCircle2 className="size-4" /> 检查答案
              </Button>
            ) : (
              <Button
                variant="outline"
                className="h-11 w-full rounded-full text-sm text-muted-foreground"
                onClick={clearAnswers}
              >
                <RotateCcw className="size-3.5" /> 清空答题
              </Button>
            )}
          </div>
        </div>
      )}

      {/* ================= 编辑知识点 ================= */}
      <Dialog open={!!editingPoint} onOpenChange={(o) => !o && setEditingPoint(null)}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>编辑知识点</DialogTitle>
            <DialogDescription>修改知识点文字与重要度</DialogDescription>
          </DialogHeader>
          <Textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            rows={3}
            className="text-sm"
            placeholder="知识点内容"
          />
          <div className="flex items-center justify-end">
            <VoiceInput
              size="sm"
              context="quiz"
              onText={(t) => setEditText((p) => (p ? p + t : t))}
            />
          </div>
          <ImportancePicker value={editImportance} onChange={setEditImportance} />
          <DialogFooter className="gap-2">
            <Button variant="outline" className="flex-1 rounded-full" onClick={() => setEditingPoint(null)}>
              取消
            </Button>
            <Button
              className="flex-1 rounded-full bg-zinc-900 text-white hover:bg-zinc-800"
              onClick={saveEditPoint}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ================= 添加知识点 ================= */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>添加知识点</DialogTitle>
            <DialogDescription>手动补充一个需要考察的知识点</DialogDescription>
          </DialogHeader>
          <Textarea
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            rows={3}
            className="text-sm"
            placeholder="例如：本文的中心思想…（可语音输入）"
          />
          <div className="flex items-center justify-end">
            <VoiceInput
              size="sm"
              context="quiz"
              onText={(t) => setAddText((p) => (p ? p + t : t))}
            />
          </div>
          <ImportancePicker value={addImportance} onChange={setAddImportance} />
          <DialogFooter className="gap-2">
            <Button variant="outline" className="flex-1 rounded-full" onClick={() => setAddOpen(false)}>
              取消
            </Button>
            <Button
              className="flex-1 rounded-full bg-zinc-900 text-white hover:bg-zinc-800"
              onClick={addPoint}
            >
              添加
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ================= 恢复草稿 ================= */}
      <Dialog
        open={!!pendingDraft}
        onOpenChange={(o) => {
          if (!o) dismissDraft()
        }}
      >
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>恢复上次作答？</DialogTitle>
            <DialogDescription>
              {pendingDraft &&
                `检测到 ${pendingDraft.questions.length} 道题的作答草稿（${formatDraftAge(pendingDraft.savedAt)}保存），可继续作答。`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="flex-1 rounded-full" onClick={dismissDraft}>
              不恢复
            </Button>
            <Button
              className="flex-1 rounded-full bg-zinc-900 text-white hover:bg-zinc-800"
              onClick={() => pendingDraft && restoreDraft(pendingDraft)}
            >
              恢复作答
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------- 小组件 ----------

// 向导头部：返回箭头 + 居中标题 + 右侧动作
function StepHeader({
  title,
  onBack,
  right,
}: {
  title: string
  onBack?: () => void
  right?: React.ReactNode
}) {
  return (
    <div className="relative mb-3 flex items-center justify-between gap-2 py-2">
      {onBack ? (
        <button
          type="button"
          aria-label="返回"
          onClick={onBack}
          className="-ml-1 shrink-0 rounded-full p-1.5 transition-colors hover:bg-accent"
        >
          <ChevronLeft className="size-5" strokeWidth={2} />
        </button>
      ) : (
        <span className="size-8 shrink-0" />
      )}
      <h2 className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-base font-bold">
        {title}
      </h2>
      <div className="flex min-w-8 shrink-0 items-center justify-end">{right}</div>
    </div>
  )
}

// 知识点卡片：黑色圆形勾选框 + 文字 + 标签 chips + 编辑铅笔
function PointCard({
  index,
  point,
  selected,
  onToggle,
  onEdit,
}: {
  index: number
  point: PointItem
  selected: boolean
  onToggle: () => void
  onEdit: () => void
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border bg-card p-3.5 transition-colors',
        selected ? 'border-zinc-900/60 dark:border-zinc-100/40' : 'border-border',
      )}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={`选择知识点${index + 1}：${point.text}`}
          onClick={onToggle}
          className={cn(
            'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
            selected
              ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
              : 'border-zinc-400 bg-transparent text-transparent dark:border-zinc-600',
          )}
        >
          <Check className="size-3" strokeWidth={3} />
        </button>
        <div className="min-w-0 flex-1 cursor-pointer select-none" onClick={onToggle}>
          <p className="text-sm leading-relaxed">{point.text}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {point.source === 'ai' ? 'AI生成' : '手动添加'}
            </span>
            {point.importance === 'core' ? (
              <span className="rounded-md bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium text-rose-600 dark:text-rose-400">
                核心
              </span>
            ) : (
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                次要
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          aria-label="编辑知识点"
          onClick={onEdit}
          className="shrink-0 rounded-full p-1.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
        >
          <Pencil className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

// 白色圆角方形 − / + 按钮
function SquareBtn({
  children,
  label,
  disabled,
  onClick,
}: {
  children: React.ReactNode
  label: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  )
}

// 重要度选择（核心 / 次要）
function ImportancePicker({
  value,
  onChange,
}: {
  value: 'core' | 'secondary'
  onChange: (v: 'core' | 'secondary') => void
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs text-muted-foreground">重要度</p>
      <div className="flex gap-2">
        {(
          [
            { key: 'core', label: '核心' },
            { key: 'secondary', label: '次要' },
          ] as const
        ).map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            className={cn(
              'h-10 flex-1 rounded-xl border text-sm font-medium transition-colors',
              value === o.key
                ? o.key === 'core'
                  ? 'border-rose-500/50 bg-rose-500/10 text-rose-600 dark:text-rose-400'
                  : 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                : 'border-border bg-card text-muted-foreground hover:bg-accent',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// 加载进度视图
function ProgressView({ text, sub }: { text: string; sub?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-14 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-emerald-500/10">
        <Loader2 className="size-7 animate-spin text-emerald-600" />
      </div>
      <div>
        <p className="text-sm font-bold">{text}</p>
        {sub && <p className="mt-1.5 text-xs text-muted-foreground">{sub}</p>}
      </div>
    </div>
  )
}

// 错误重试视图
function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-14 text-center">
      <AlertCircle className="size-9 text-destructive/70" strokeWidth={1.5} />
      <p className="max-w-64 text-sm text-muted-foreground">{message}</p>
      <Button
        className="h-10 rounded-full bg-zinc-900 px-8 text-sm font-semibold text-white hover:bg-zinc-800"
        onClick={onRetry}
      >
        重试
      </Button>
    </div>
  )
}

// 空闲入口视图
function IdleView({ canStart, onStart }: { canStart: boolean; onStart: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 py-14 text-center">
      <FileQuestion className="size-10 text-muted-foreground/30" strokeWidth={1.5} />
      <div>
        <p className="text-sm font-bold">AI 智能出题</p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          先选择知识点，再选择题型与数量
          <br />
          统一检查 · 错题自动收集 · 支持存草稿
        </p>
      </div>
      <Button
        disabled={!canStart}
        onClick={onStart}
        className="h-12 rounded-full bg-zinc-900 px-10 text-base font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        <Sparkles className="size-4" /> 开始出题
      </Button>
      {!canStart && <p className="text-xs text-destructive">当前背书卡内容为空，无法出题</p>}
    </div>
  )
}

// 题型徽标配色
function badgeTone(t: QuizTypeX): string {
  switch (t) {
    case 'choice':
      return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    case 'multi':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
    case 'judge':
      return 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
    default:
      return 'bg-secondary'
  }
}

function renderQuestionText(text: string): React.ReactNode {
  // Highlight ____ fill placeholders
  if (!text) return null
  const parts = text.split(/_{2,}/)
  if (parts.length === 1) return text
  return (
    <>
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {p}
          {i < parts.length - 1 && (
            <span className="mx-1 inline-block min-w-[3rem] border-b-2 border-dashed border-foreground/40 align-baseline" />
          )}
        </React.Fragment>
      ))}
    </>
  )
}
