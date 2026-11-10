'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'
import { Copy, Eraser, Eye, Flag, GripVertical, RotateCcw, Volume2 } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { parseSpanDirective } from '@/lib/inline-style'
import {
  computeBlankRanges,
  occAt,
  splitCharTokens,
  normKeywordEntries,
} from '@/lib/cloze'
import type { ClozeStyle, KwEntry } from '@/lib/types'
import { LongPressMenu, type MenuAction } from '@/components/recitation/long-press-menu'
import katex from 'katex'
// 化学公式扩展（\ce{}）——补丁与 RichContent 共享的同一 katex 实例
import 'katex/contrib/mhchem'

const LONG_PRESS_MS = 420
const MOVE_TOLERANCE = 12
/** 选区浮动菜单宽度（px，与面板 style.width 一致） */
const SEL_MENU_WIDTH = 208
/** 选区浮动菜单估算高度（含拖动把手，用于定位/clamp） */
const SEL_MENU_H = 150
/** 菜单与选区上下边缘的最小垂直间距：避开上下两个选择手柄（拖块） */
const SEL_MENU_GAP = 56
const VIEWPORT_INSET = 8
/** 涂刷插值采样步长（px）：越小越不漏字 */
const BRUSH_SAMPLE_STEP = 4
/** 手柄拖到视口上下边缘多少 px 内时自动滚动页面 */
const HANDLE_AUTOSCROLL_EDGE = 88
/** 选区菜单拖动偏移的记忆 key（localStorage，跨会话记忆） */
const SEL_MENU_DRAG_KEY = 'sb:cloze-selmenu-offset'

interface CharToken {
  text: string
  isChar: boolean // 字 token (toggleable) vs separator
}

// ---------------------------------------------------------------------------
// 轻量富文本内联解析：加粗/斜体/删除线/行内代码/荧光笔/字色/行内公式。
// plain = 去掉标记后的纯文本（挖空关键词与位置都基于 plain 计算）。
// ---------------------------------------------------------------------------

interface InlineRun {
  text: string
  /** offset of run.text inside the paragraph's plain text */
  start: number
  cls?: string
  code?: boolean
  color?: string
  /** 选中文字字号（%%fs:18|文%%），px；覆盖段落基准字号 */
  fontSize?: number
  /** 行内公式 TeX（$…$ 或同行 $$…$$），渲染时不可挖空 */
  math?: string
  /** true = $$…$$ 展示型（同行内出现） */
  mathDisplay?: boolean
  /** 行内图片 ![alt](src)：原位渲染 <img>；text 恒为空串，不进入 plain（alt/base64 永不显示为文本） */
  image?: { alt: string; src: string }
}

const INLINE_RE =
  /\$\$([^$\n]+?)\$\$|\$([^$\n]+)\$|%%([^|\n]+)\|([^%\n]*)%%|==([^=\n]+)==|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|`([^`\n]+)`|\*([^*\n]+)\*|!\[([^\]]*)\]\(([^)]+)\)/g

function parseInline(line: string): { runs: InlineRun[]; plain: string } {
  const runs: InlineRun[] = []
  let plain = ''
  let last = 0
  let m: RegExpExecArray | null
  INLINE_RE.lastIndex = 0
  while ((m = INLINE_RE.exec(line)) !== null) {
    if (m.index > last) {
      runs.push({ text: line.slice(last, m.index), start: plain.length })
      plain += line.slice(last, m.index)
    }
    if (m[1] !== undefined) {
      // 行内出现的 $$…$$ 展示公式（同行前有文字时也能渲染）
      runs.push({ text: m[1], start: plain.length, math: m[1], mathDisplay: true })
      plain += m[1]
    } else if (m[2] !== undefined) {
      runs.push({ text: m[2], start: plain.length, cls: 'italic text-primary/90', math: m[2] })
      plain += m[2]
    } else if (m[3] !== undefined) {
      // %%样式|文字%%：共享解析器支持颜色（#hex/名称）与字号 fs:18，可组合 %%color:#dc2626;fs:18|文%%
      const st = parseSpanDirective(m[3])
      runs.push({ text: m[4] ?? '', start: plain.length, color: st.color, fontSize: st.fontSize })
      plain += m[4] ?? ''
    } else if (m[5] !== undefined) {
      runs.push({ text: m[5], start: plain.length, cls: 'rounded-sm bg-amber-300/70 px-0.5 dark:bg-amber-500/40' })
      plain += m[5]
    } else if (m[6] !== undefined) {
      runs.push({ text: m[6], start: plain.length, cls: 'font-bold' })
      plain += m[6]
    } else if (m[7] !== undefined) {
      runs.push({ text: m[7], start: plain.length, cls: 'line-through opacity-70' })
      plain += m[7]
    } else if (m[8] !== undefined) {
      runs.push({ text: m[8], start: plain.length, code: true })
      plain += m[8]
    } else if (m[9] !== undefined) {
      runs.push({ text: m[9], start: plain.length, cls: 'italic' })
      plain += m[9]
    } else if (m[10] !== undefined) {
      // 行内图片（alt 可含 / 等特殊字符）：原位渲染，不进入 plain、不可挖空，
      // 从而 alt 与 base64 永不会作为可见文本泄漏
      runs.push({ text: '', start: plain.length, image: { alt: m[10], src: m[11] ?? '' } })
    }
    last = m.index + m[0].length
  }
  if (last < line.length) {
    runs.push({ text: line.slice(last), start: plain.length })
    plain += line.slice(last)
  }
  if (runs.length === 0 && line) runs.push({ text: line, start: 0 })
  return { runs, plain }
}

// 表格行解析：| a | b | → [a, b]
function splitTableRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())
}

function isTableLine(line: string): boolean {
  const t = line.trim()
  return t.startsWith('|') && t.endsWith('|') && t.length > 2
}

function isTableSeparator(line: string): boolean {
  const t = line.trim()
  return /^\|[\s:|-]+\|$/.test(t)
}

function isImageLine(line: string): boolean {
  return /^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(line)
}

function parseImageLine(line: string): { alt: string; src: string } | null {
  const m = line.match(/!\[([^\]]*)\]\(([^)]+)\)/)
  if (!m) return null
  return { alt: m[1], src: m[2] }
}

// 段落块：text（可挖空）| image | formula | table | code（mermaid/html等，RichContent 渲染）
type Block =
  | { kind: 'text'; runs: InlineRun[]; plain: string; plainStart: number; tocPara?: number }
  | { kind: 'image'; alt: string; src: string }
  | { kind: 'formula'; tex: string; display: boolean }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'code'; lang: string; code: string }

/**
 * 把一段文本拆成可渲染块，并给出每段纯文本在「全局 plain」中的偏移，
 * 使挖空范围（绝对下标）能映射回段落内部。图片/表格/公式块不参与挖空。
 */
function buildBlocks(content: string): { blocks: Block[]; plain: string } {
  const lines = content.split(/(\r?\n)/)
  // tokens: 交替 [文本行, 换行符]；逐行扫描并组合块
  const rawLines: { text: string; start: number }[] = []
  let offset = 0
  for (let i = 0; i < lines.length; i += 2) {
    const text = lines[i] ?? ''
    rawLines.push({ text, start: offset })
    offset += text.length + (lines[i + 1]?.length ?? 0)
  }

  const blocks: Block[] = []
  const plainParts: string[] = []
  let plainLen = 0
  let textParaCount = 0

  const pushPlain = (plain: string, tocPara: number) => {
    const block: Block = { kind: 'text', runs: [], plain: '', plainStart: 0, tocPara }
    const parsed = parseInline(plain)
    block.runs = parsed.runs
    block.plain = parsed.plain
    block.plainStart = plainLen
    blocks.push(block)
    plainParts.push(parsed.plain, '\n')
    plainLen += parsed.plain.length + 1
  }

  let i = 0
  while (i < rawLines.length) {
    const { text, start } = rawLines[i]
    const trimmed = text.trim()

    // 空行：跳过（占一个换行，不影响 plain 对齐——空行不产生 plain）
    if (!trimmed) {
      i += 1
      continue
    }

    // 图片行
    if (isImageLine(text)) {
      const img = parseImageLine(text)
      if (img) {
        blocks.push({ kind: 'image', alt: img.alt, src: img.src })
        i += 1
        continue
      }
    }

    // 围栏代码块：```lang ... ```（mermaid 思维导图/流程图、html 块、其它代码）
    if (trimmed.startsWith('```')) {
      const lang = trimmed.replace(/^`+/, '').trim()
      let j = i + 1
      const buf: string[] = []
      while (j < rawLines.length && !rawLines[j].text.trim().startsWith('```')) {
        buf.push(rawLines[j].text)
        j += 1
      }
      // 闭合存在时消费闭合行；未闭合时也渲染已收集内容（容错）
      const closed = j < rawLines.length
      blocks.push({ kind: 'code', lang, code: buf.join('\n') })
      i = closed ? j + 1 : j
      continue
    }

    // 独立公式块 $$ ... $$（单行或多行）
    if (trimmed.startsWith('$$')) {
      const single = trimmed.match(/^\$\$(.+)\$\$$/)
      if (single) {
        blocks.push({ kind: 'formula', tex: single[1], display: true })
        i += 1
        continue
      }
      if (trimmed === '$$') {
        // 多行公式：收集到闭合 $$
        let j = i + 1
        const buf: string[] = []
        while (j < rawLines.length && rawLines[j].text.trim() !== '$$') {
          buf.push(rawLines[j].text)
          j += 1
        }
        if (j < rawLines.length) {
          blocks.push({ kind: 'formula', tex: buf.join('\n'), display: true })
          i = j + 1
          continue
        }
      }
    }

    // 表格块（连续 | 行，跳过分隔行）
    if (isTableLine(text)) {
      const rows: string[][] = []
      let j = i
      while (j < rawLines.length && isTableLine(rawLines[j].text)) {
        if (!isTableSeparator(rawLines[j].text)) rows.push(splitTableRow(rawLines[j].text))
        j += 1
      }
      if (rows.length > 0) {
        blocks.push({ kind: 'table', rows })
        i = j
        continue
      }
    }

    // 普通文本段
    pushPlain(text, textParaCount)
    textParaCount += 1
    i += 1
  }

  return { blocks, plain: plainParts.join('') }
}

interface ClozeTextProps {
  content: string
  keywords: KwEntry[]
  style: ClozeStyle
  showAnswers: boolean
  fontSize: number
  /** 挖空刷 mode: drag over 字 to blank them. */
  brushMode?: boolean
  /** 手动挖空 mode: double-click 字 to blank them. */
  manualMode?: boolean
  /** When provided (AI快速分块), render numbered chunk blocks instead of plain paragraphs. */
  chunks?: string[] | null
  /** When provided (paged mode), render horizontal snap pages. */
  pages?: string[] | null
  onPageChange?: (page: number, total: number) => void
  revealed: Set<number>
  onReveal: (idx: number) => void
  /** Toggle one occurrence: (text, occ) — occ = 出现序号，-1 = 旧格式全部。 */
  onToggleKeyword: (word: string, occ: number) => void
  /** 挖空编辑模式: tapping a blank removes it; the selection menu's 挖空 action
   * routes to onSelectCloze instead of the reader keyword updater. */
  selectionMode?: boolean
  /** Called with (text, occ) when 挖空选中 is tapped (编辑模式). */
  onSelectCloze?: (text: string, occ: number) => void
  /** ALWAYS-ON custom selection menu (reader mode): captures long-press
   * (mobile) + right-click (desktop) character selection and shows a floating
   * menu with a 挖空 button. */
  selectMenuEnabled?: boolean
  /** 挖空 the selected substring (multi-字 selection blanks that whole part). */
  onSelectionCloze?: (text: string, occ: number) => void
  /** 取消挖空 — called when the selection is an existing keyword. */
  onSelectionUncloze?: (text: string, occ: number) => void
  /** Full override of the per-blank long-press menu actions. */
  menuActions?: MenuAction[]
  /** 取消挖空 — only adds the menu action when provided. */
  onRemoveKeyword?: (word: string, occ: number) => void
  /** 标记难点 — only adds the menu action when provided. */
  onMarkHard?: (word: string) => void
  /** Fallback for custom keys when menuActions is overridden. */
  onMenuAction?: (key: string, word: string, idx: number, occ: number) => void
  /** 只读（访客共享视图）：隐藏挖空/取消挖空入口，仅保留朗读/复制与点按显示。 */
  readOnly?: boolean
  /** 覆盖内部朗读实现（默认浏览器 speechSynthesis；登录用户传默认配置引擎）。 */
  speakText?: (text: string) => void
}

interface BlankPos {
  start: number
  end: number
  text: string
  occ: number
  idx: number // 渲染序（reveal 集合的 key）
}

export function ClozeText({
  content,
  keywords,
  style,
  showAnswers,
  fontSize,
  brushMode = false,
  manualMode = false,
  chunks = null,
  pages = null,
  onPageChange,
  revealed,
  onReveal,
  onToggleKeyword,
  selectionMode = false,
  onSelectCloze,
  selectMenuEnabled = false,
  onSelectionCloze,
  onSelectionUncloze,
  menuActions,
  onRemoveKeyword,
  onMarkHard,
  onMenuAction,
  readOnly = false,
  speakText: speakTextProp,
}: ClozeTextProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const draggingRef = React.useRef(false)
  const [page, setPage] = React.useState(0)
  // 查看答案 (per-blank menu): single blanks revealed for 2s, independent of
  // the global showAnswers toggle.
  const [tempRevealed, setTempRevealed] = React.useState<Set<number>>(new Set())
  const tempTimersRef = React.useRef<Map<number, number>>(new Map())

  React.useEffect(() => {
    const timers = tempTimersRef.current
    return () => {
      timers.forEach((t) => window.clearTimeout(t))
      timers.clear()
    }
  }, [])

  const tempReveal = (idx: number) => {
    setTempRevealed((prev) => {
      const n = new Set(prev)
      n.add(idx)
      return n
    })
    const prevTimer = tempTimersRef.current.get(idx)
    if (prevTimer) window.clearTimeout(prevTimer)
    const t = window.setTimeout(() => {
      tempTimersRef.current.delete(idx)
      setTempRevealed((prev) => {
        const n = new Set(prev)
        n.delete(idx)
        return n
      })
    }, 2000)
    tempTimersRef.current.set(idx, t)
  }

  // ---------------------------------------------------------------------------
  // Stuck-orange fix: the parent `revealed` set is add-only in some callers
  // (reader-view's handleReveal early-returns when idx is already present), so
  // tapping a revealed blank could never clear it — the blank stayed amber
  // (orange) forever. We layer a local `hiddenBlanks` override on top of the
  // prop: effectiveRevealed = revealed.has(idx) && !hiddenBlanks.has(idx).
  // Tapping cycles a blank  empty → revealed (calls onReveal) → hidden (local
  // override) → revealed again. When showAnswers is globally on, tapping a
  // blank that is NOT individually revealed is a no-op so the global reveal
  // can't permanently lock individual blanks.
  // ---------------------------------------------------------------------------
  const [hiddenBlanks, setHiddenBlanks] = React.useState<Set<number>>(new Set())

  // Drop stale overrides when the parent's revealed set changes (e.g. the
  // parent resets on text change) — keep only entries still backed by the prop.
  React.useEffect(() => {
    setHiddenBlanks((prev) => {
      if (prev.size === 0) return prev
      let changed = false
      const next = new Set<number>()
      for (const idx of prev) {
        if (revealed.has(idx)) next.add(idx)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [revealed])

  const toggleBlank = (idx: number) => {
    const inProp = revealed.has(idx)
    const inHidden = hiddenBlanks.has(idx)
    if (inProp && !inHidden) {
      // Currently revealed → hide locally (toggle off without mutating parent).
      setHiddenBlanks((prev) => {
        const n = new Set(prev)
        n.add(idx)
        return n
      })
    } else if (inHidden) {
      // Locally hidden → re-reveal (remove the local override).
      setHiddenBlanks((prev) => {
        const n = new Set(prev)
        n.delete(idx)
        return n
      })
    } else if (!showAnswers) {
      // Fresh reveal — only when showAnswers is off, so the global reveal
      // can't lock individual blanks that were never explicitly tapped.
      onReveal(idx)
    }
  }

  // 朗读 — 优先外部注入的引擎（默认配置），否则浏览器 speechSynthesis。
  const speakText = React.useCallback(
    (text: string) => {
      if (speakTextProp) {
        speakTextProp(text)
        return
      }
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        toast.error('当前浏览器不支持朗读')
        return
      }
      try {
        window.speechSynthesis.cancel()
        const u = new SpeechSynthesisUtterance(text)
        u.lang = 'zh-CN'
        u.rate = 0.9
        window.speechSynthesis.speak(u)
      } catch {
        toast.error('朗读失败，请重试')
      }
    },
    [speakTextProp],
  )

  // 复制文本
  const copyText = (text: string) => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => toast.success(`已复制「${text.slice(0, 12)}${text.length > 12 ? '…' : ''}」`))
      .catch(() => toast.error('复制失败，请长按手动复制'))
  }

  const handleBlankMenuAction = (key: string, word: string, idx: number, occ: number) => {
    switch (key) {
      case 'reveal':
        tempReveal(idx)
        break
      case 'speak':
        speakText(word)
        break
      case 'copy':
        copyText(word)
        break
      case 'remove':
        if (onRemoveKeyword && !readOnly) {
          onRemoveKeyword(word, occ)
          toast.success(`已取消挖空「${word}」`)
        }
        break
      case 'mark':
        if (onMarkHard) {
          onMarkHard(word)
          toast.success(`已标记难点「${word}」`)
        }
        break
      default:
        onMenuAction?.(key, word, idx, occ)
    }
  }

  const entries = React.useMemo(() => normKeywordEntries(keywords), [keywords])

  const sources = React.useMemo((): SourceCtx[] => {
    const list: { key: string; src: string; chunkIndex: number | null }[] = []
    if (chunks) {
      chunks.forEach((c, i) => list.push({ key: `chunk-${i}`, src: c, chunkIndex: i }))
    } else if (pages) {
      pages.forEach((p, i) => list.push({ key: `page-${i}`, src: p, chunkIndex: null }))
    } else {
      list.push({ key: 'root', src: content, chunkIndex: null })
    }
    let idxOffset = 0
    return list.map(({ key, src, chunkIndex }) => {
      const { blocks, plain } = buildBlocks(src)
      const ranges = computeBlankRanges(plain, entries).map((r) => ({
        ...r,
        occ: occAt(plain, r.text, r.start),
      }))
      // reveal key 全局连续（跨分块不冲突）
      const blanks: BlankPos[] = ranges.map((r, i) => ({ ...r, idx: idxOffset + i }))
      idxOffset += blanks.length
      const blankByStart = new Map<number, BlankPos>(blanks.map((b) => [b.start, b]))
      return { key, raw: src, chunkIndex, blocks, plain, blanks, blankByStart, blankSet: new Set<number>() }
    })
  }, [chunks, pages, content, entries])

  // 选择菜单/挖空刷：解析选中文本属于哪个渲染源 + 其出现序号。
  const resolveSelection = React.useCallback(
    (text: string): { occ: number; plain: string } => {
      for (const s of sources) {
        const idx = s.plain.indexOf(text)
        if (idx >= 0) return { occ: occAt(s.plain, text, idx), plain: s.plain }
      }
      return { occ: -1, plain: '' }
    },
    [sources],
  )
  const isTextBlanked = React.useCallback(
    (text: string) => sources.some((s) => s.blanks.some((b) => b.text === text)),
    [sources],
  )
  /** 按出现序号判断：同一字的第 N 次出现是否已被挖空（跨句隔离的关键）。 */
  const isOccBlanked = React.useCallback(
    (text: string, occ: number | null) => {
      if (occ === null || occ < 0) return isTextBlanked(text)
      return sources.some((s) => s.blanks.some((b) => b.text === text && b.occ === occ))
    },
    [sources, isTextBlanked],
  )
  /** 由字元素上的 data-src/data-pos 精确解析所属出现序号（点第二处“明月”不再误伤第一处）。 */
  const occFromCharEl = React.useCallback(
    (el: HTMLElement | null, text: string): number | null => {
      if (!el) return null
      // 挖空词 span：data-word 是答案文本；普通字 span：用 textContent。
      const t = el.dataset.word || text
      if (!t) return null
      const srcKey = el.dataset.src
      const pos = Number(el.dataset.pos)
      if (srcKey === undefined || Number.isNaN(pos)) return null
      const src = sources.find((s) => s.key === srcKey)
      if (!src) return null
      return occAt(src.plain, t, pos)
    },
    [sources],
  )


  // ===========================================================================
  // 自定义选择菜单 (character-level, 自由选择框): long-press (touch) or
  // right-click (desktop) starts a selection; two draggable teardrop handles
  // let the user freely stretch/shrink the selected range (like native mobile
  // text selection) — the floating menu carries a 挖空选中 button.
  // ===========================================================================
  const menuEnabled = (selectionMode || selectMenuEnabled) && !brushMode
  // 触屏设备才禁用原生选择（用自定义长按选字）；桌面保留原生拖选，
  // 右键菜单直接读取原生 selection。
  const [isTouchDevice] = React.useState(
    () =>
      typeof window !== 'undefined' &&
      ('ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0),
  )
  const suppressNativeSelect = menuEnabled && isTouchDevice
  const [selHL, setSelHL] = React.useState<Set<number>>(new Set())
  const [selMenu, setSelMenu] = React.useState<{
    x: number
    y: number
    /** 自动定位的基准点（用户拖动偏移基于此记忆，下次打开继续生效） */
    baseX: number
    baseY: number
    above: boolean
    text: string
    isKeyword: boolean
    /** 打开菜单时解析的精确出现序号（null = 未解析，走首个出现回退）。 */
    occ?: number | null
  } | null>(null)
  // 用户拖动选区菜单产生的偏移（相对自动定位基准），localStorage 记忆。
  const selMenuOffRef = React.useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 })
  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SEL_MENU_DRAG_KEY)
      if (!raw) return
      const p = JSON.parse(raw) as { dx?: unknown; dy?: unknown }
      if (typeof p?.dx === 'number' && typeof p?.dy === 'number') {
        selMenuOffRef.current = { dx: p.dx, dy: p.dy }
      }
    } catch {
      /* noop */
    }
  }, [])
  // 手柄尖端坐标（拖拽时实时更新）；menuOpen=false 时只显示手柄不显示菜单。
  const [selTips, setSelTips] = React.useState<{
    start: { x: number; y: number }
    end: { x: number; y: number }
  } | null>(null)
  const [handleDrag, setHandleDrag] = React.useState<'start' | 'end' | null>(null)
  const handleDragRef = React.useRef<'start' | 'end' | null>(null)
  const selectingRef = React.useRef(false)
  const pressTimerRef = React.useRef<number | null>(null)
  const pressStartRef = React.useRef<{ x: number; y: number } | null>(null)
  const anchorRef = React.useRef<number>(-1)
  const focusRef = React.useRef<number>(-1)
  const [selMounted, setSelMounted] = React.useState(false)
  React.useEffect(() => setSelMounted(true), [])

  // Ordered char spans (document order == render order).
  const getCharEls = React.useCallback((): HTMLElement[] => {
    const root = rootRef.current
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLElement>('[data-char]'))
  }, [])

  const clearSelHighlight = React.useCallback(() => {
    anchorRef.current = -1
    focusRef.current = -1
    setSelHL(new Set())
    setSelTips(null)
    setSelMenu(null)
  }, [])

  // 计算选择范围两端的手柄尖端坐标 + 菜单锚点。
  const computeSelLayout = React.useCallback(
    (a: number, f: number) => {
      const els = getCharEls()
      if (!els.length) return null
      const lo = Math.max(0, Math.min(a, f))
      const hi = Math.min(els.length - 1, Math.max(a, f))
      const r1 = els[lo].getBoundingClientRect()
      const r2 = els[hi].getBoundingClientRect()
      const top = Math.min(r1.top, r2.top)
      const bottom = Math.max(r1.bottom, r2.bottom)
      const left = Math.min(r1.left, r2.left)
      const right = Math.max(r1.right, r2.right)
      return {
        startTip: { x: left, y: top },
        endTip: { x: right, y: bottom },
        bbox: { top, bottom, left, right },
        above: top > 150,
      }
    },
    [getCharEls],
  )

  const highlightRange = React.useCallback(
    (a: number, f: number) => {
      const els = getCharEls()
      if (!els.length) return
      const lo = Math.max(0, Math.min(a, f))
      const hi = Math.min(els.length - 1, Math.max(a, f))
      const s = new Set<number>()
      for (let i = lo; i <= hi; i++) s.add(i)
      anchorRef.current = a
      focusRef.current = f
      setSelHL(s)
      const layout = computeSelLayout(a, f)
      if (layout) setSelTips({ start: layout.startTip, end: layout.endTip })
    },
    [getCharEls, computeSelLayout],
  )

  const extractSelText = React.useCallback(
    (a: number, f: number): string => {
      const els = getCharEls()
      const root = rootRef.current
      if (!els.length || !root) return ''
      const lo = Math.max(0, Math.min(a, f))
      const hi = Math.min(els.length - 1, Math.max(a, f))
      const first = els[lo]
      const last = els[hi]
      // 用 TreeWalker 走文本节点：包含选中范围内的标点/空白（data-char 只覆盖字，
      // 直接拼接会漏掉中间的标点，导致关键词不再是原文连续子串）。
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let out = ''
      let inRange = false
      while (walker.nextNode()) {
        const node = walker.currentNode
        const parentEl = node.parentElement
        if (!parentEl) continue
        if (!inRange) {
          if (parentEl === first || first.contains(parentEl) || parentEl.contains(first)) {
            inRange = true
          } else {
            continue
          }
        }
        out += node.textContent ?? ''
        if (parentEl === last || last.contains(parentEl) || parentEl.contains(last)) break
      }
      return out.trim()
    },
    [getCharEls],
  )

  const clearPressTimer = () => {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current)
      pressTimerRef.current = null
    }
  }

  const closeSelMenu = React.useCallback(() => {
    setSelMenu(null)
    clearSelHighlight()
  }, [clearSelHighlight])

  // 打开任何弹窗/抽屉（Radix dialog / popper）或收到 sb-close-selection 事件时，
  // 自动关闭选择菜单——避免选字框浮在 AI出题等面板上挡住操作。
  React.useEffect(() => {
    if (typeof window === 'undefined') return
    const close = () => closeSelMenu()
    window.addEventListener('sb-close-selection', close)
    let scheduled = false
    const obs = new MutationObserver(() => {
      if (scheduled) return
      scheduled = true
      window.requestAnimationFrame(() => {
        scheduled = false
        const root = rootRef.current
        if (!root) return
        // 选择菜单自身 portaled 到 body，这里只关心外部弹层出现的情况。
        if (!selMenu && !selTips) return
        const dialog = document.querySelector(
          '[role="dialog"][data-state="open"], [data-radix-popper-content-wrapper]',
        )
        if (dialog && !root.contains(dialog)) close()
      })
    })
    obs.observe(document.body, { childList: true, subtree: true })
    return () => {
      window.removeEventListener('sb-close-selection', close)
      obs.disconnect()
    }
  }, [closeSelMenu, selMenu, selTips])

  const charIdxFromPoint = (x: number, y: number): number => {
    const el = document.elementFromPoint(x, y)
    const charEl = el?.closest('[data-char]') as HTMLElement | null
    if (!charEl) {
      // 命中不到字时，退化为找最近的字（垂直距离优先）——手柄拖出文本区时仍可用。
      const els = getCharEls()
      if (!els.length) return -1
      let best = -1
      let bestDist = Infinity
      for (let i = 0; i < els.length; i++) {
        const r = els[i].getBoundingClientRect()
        const cx = Math.min(Math.max(x, r.left), r.right)
        const cy = Math.min(Math.max(y, r.top), r.bottom)
        const d = Math.hypot(x - cx, y - cy)
        if (d < bestDist) {
          bestDist = d
          best = i
        }
      }
      return bestDist <= 120 ? best : -1
    }
    const els = getCharEls()
    return els.indexOf(charEl)
  }

  // 兼容旧调用（pointer/右键事件直接取坐标）。
  const charIdxFromEvent = (e: { clientX: number; clientY: number }): number =>
    charIdxFromPoint(e.clientX, e.clientY)

  // ---- 选区菜单定位 ----
  // 菜单与选区上下保持 SEL_MENU_GAP(56px) 间距：避开上下两个选择手柄（拖块），
  // 顶部放不下时放选区下方（同样 56px 间距），始终 clamp 在视口内。
  const clampMenuX = (x: number) =>
    Math.min(
      Math.max(x, SEL_MENU_WIDTH / 2 + VIEWPORT_INSET),
      Math.max(SEL_MENU_WIDTH / 2 + VIEWPORT_INSET, window.innerWidth - SEL_MENU_WIDTH / 2 - VIEWPORT_INSET),
    )
  const clampMenuY = (y: number) =>
    Math.min(
      Math.max(y, SEL_MENU_H / 2 + VIEWPORT_INSET),
      Math.max(SEL_MENU_H / 2 + VIEWPORT_INSET, window.innerHeight - SEL_MENU_H / 2 - VIEWPORT_INSET),
    )

  const placeSelMenu = (bbox: { top: number; bottom: number; left: number; right: number }) => {
    const halfH = SEL_MENU_H / 2
    const vh = window.innerHeight
    const x = clampMenuX((bbox.left + bbox.right) / 2)
    const yAbove = bbox.top - SEL_MENU_GAP - halfH
    const yBelow = bbox.bottom + SEL_MENU_GAP + halfH
    const fitsAbove = yAbove - halfH >= VIEWPORT_INSET
    const fitsBelow = yBelow + halfH <= vh - VIEWPORT_INSET
    let above = fitsAbove || !fitsBelow
    let y = above ? yAbove : yBelow
    if (!fitsAbove && !fitsBelow) {
      // 两侧都放不下：选空间更大的一侧并 clamp 进视口
      above = bbox.top > vh - bbox.bottom
      y = above ? yAbove : yBelow
    }
    return { x, y: clampMenuY(y), above }
  }

  /** 桌面右键路径：菜单出现在点击点附近（同样应用记忆偏移 + clamp）。 */
  const openMenuAtPoint = (x: number, y: number, text: string, isKeyword: boolean, occ: number | null) => {
    const baseX = clampMenuX(x)
    const baseY = clampMenuY(y)
    setSelMenu({
      x: clampMenuX(baseX + selMenuOffRef.current.dx),
      y: clampMenuY(baseY + selMenuOffRef.current.dy),
      baseX,
      baseY,
      above: y > window.innerHeight / 2,
      text,
      isKeyword,
      occ,
    })
  }

  const openMenuForRange = React.useCallback(
    (a: number, f: number, at?: { x: number; y: number }, occ?: number | null) => {
      const els = getCharEls()
      const lo = Math.max(0, Math.min(a, f))
      const hi = Math.min(els.length - 1, Math.max(a, f))
      if (hi < lo) return
      const text = extractSelText(a, f)
      if (!text) return
      const layout = computeSelLayout(a, f)
      if (!layout) return
      const kw = isOccBlanked(text, occ ?? null)
      if (at) {
        openMenuAtPoint(at.x, at.y, text, kw, occ ?? null)
        return
      }
      const base = placeSelMenu(layout.bbox)
      const off = selMenuOffRef.current
      setSelMenu({
        x: clampMenuX(base.x + off.dx),
        y: clampMenuY(base.y + off.dy),
        baseX: base.x,
        baseY: base.y,
        above: base.above,
        text,
        isKeyword: kw,
        occ: occ ?? null,
      })
    },
    [extractSelText, getCharEls, computeSelLayout, isOccBlanked],
  )

  // ---- pointer flow (touch long-press → drag selection with handles) ----
  const handleRootPointerDown = (e: React.PointerEvent) => {
    if (!menuEnabled) return
    if (e.pointerType === 'mouse') return // mouse uses right-click
    if (selMenu || selTips) return // selection active: backdrop handles closing
    const target = e.target as HTMLElement
    // Blanks wrapped by LongPressMenu handle their own long-press menu.
    const inBlank = !!target.closest('[data-word]')
    const charEl = target.closest('[data-char]') as HTMLElement | null
    if (!charEl) return
    if (inBlank && !selectionMode) return
    pressStartRef.current = { x: e.clientX, y: e.clientY }
    clearPressTimer()
    pressTimerRef.current = window.setTimeout(() => {
      pressTimerRef.current = null
      const idx = getCharEls().indexOf(charEl)
      if (idx < 0) return
      try {
        navigator.vibrate?.(25)
      } catch {
        /* haptics unsupported */
      }
      selectingRef.current = true
      highlightRange(idx, idx)
      openMenuForRange(idx, idx, undefined, occFromCharEl(charEl, charEl.textContent ?? ''))
    }, LONG_PRESS_MS)
  }

  const handleRootPointerMove = (e: React.PointerEvent) => {
    if (!menuEnabled) return
    const start = pressStartRef.current
    if (selectingRef.current) {
      const idx = charIdxFromEvent(e)
      if (idx >= 0 && idx !== focusRef.current) {
        highlightRange(anchorRef.current, idx)
      }
      return
    }
    if (!start || pressTimerRef.current === null) return
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > MOVE_TOLERANCE) {
      clearPressTimer()
      pressStartRef.current = null
    }
  }

  const handleRootPointerEnd = (e: React.PointerEvent) => {
    if (!menuEnabled) return
    if (selectingRef.current) {
      selectingRef.current = false
      pressStartRef.current = null
      const a = anchorRef.current
      const f = focusRef.current
      if (a >= 0 && f >= 0) {
        openMenuForRange(a, f)
      }
      return
    }
    clearPressTimer()
    pressStartRef.current = null
    void e
  }

  // ---- 自由选择手柄（teardrop）：拖动任意手柄自由拉升/收缩选择范围 ----
  const HANDLE_BODY_OFFSET = 34 // 手柄身体离尖端的距离
  const handleDragPosRef = React.useRef<{ x: number; y: number } | null>(null)
  const autoScrollRafRef = React.useRef<number | null>(null)

  /** 手柄尖端 → 解析字并更新选择范围（拖拽与自动滚动共用）。 */
  const resolveHandleToChar = (which: 'start' | 'end', tip: { x: number; y: number }) => {
    const idx = charIdxFromPoint(tip.x, tip.y)
    if (idx < 0) return
    if (which === 'start' && idx !== anchorRef.current) {
      highlightRange(idx, focusRef.current)
    } else if (which === 'end' && idx !== focusRef.current) {
      highlightRange(anchorRef.current, idx)
    }
  }

  // 手柄拖到视口上下边缘时自动滚动页面（解决“选择框无法继续往下滑动选择手柄”）。
  const startAutoScroll = () => {
    if (autoScrollRafRef.current !== null) return
    const step = () => {
      autoScrollRafRef.current = window.requestAnimationFrame(step)
      const which = handleDragRef.current
      const pos = handleDragPosRef.current
      if (!which || !pos) return
      const vh = window.innerHeight
      let dy = 0
      if (pos.y < HANDLE_AUTOSCROLL_EDGE) {
        dy = -Math.ceil(Math.min(16, (HANDLE_AUTOSCROLL_EDGE - pos.y) / 5 + 3))
      } else if (pos.y > vh - HANDLE_AUTOSCROLL_EDGE) {
        dy = Math.ceil(Math.min(16, (pos.y - (vh - HANDLE_AUTOSCROLL_EDGE)) / 5 + 3))
      }
      if (dy === 0) return
      window.scrollBy(0, dy)
      // 内容随滚动位移后，重新解析手柄下的字（选择随滚动继续延伸）
      resolveHandleToChar(which, pos)
    }
    autoScrollRafRef.current = window.requestAnimationFrame(step)
  }
  const stopAutoScroll = () => {
    if (autoScrollRafRef.current !== null) {
      window.cancelAnimationFrame(autoScrollRafRef.current)
      autoScrollRafRef.current = null
    }
  }
  React.useEffect(() => stopAutoScroll, [])

  const beginHandleDrag = (which: 'start' | 'end') => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* noop */
    }
    handleDragRef.current = which
    setHandleDrag(which)
    setSelMenu(null) // 拖拽期间隐藏菜单，松手再出现
    handleDragPosRef.current =
      which === 'start'
        ? { x: e.clientX + 6, y: e.clientY - HANDLE_BODY_OFFSET + 4 }
        : { x: e.clientX - 6, y: e.clientY + HANDLE_BODY_OFFSET - 4 }
    startAutoScroll()
  }
  const moveHandleDrag = (which: 'start' | 'end') => (e: React.PointerEvent) => {
    if (handleDragRef.current !== which) return
    e.preventDefault()
    // 手柄身体相对尖端有偏移：start 身体在尖端下方，end 在上方。
    // 反推尖端坐标 → 用尖端定位字。
    const tip =
      which === 'start'
        ? { x: e.clientX + 6, y: e.clientY - HANDLE_BODY_OFFSET + 4 }
        : { x: e.clientX - 6, y: e.clientY + HANDLE_BODY_OFFSET - 4 }
    handleDragPosRef.current = tip
    resolveHandleToChar(which, tip)
  }
  const endHandleDrag = (which: 'start' | 'end') => (e: React.PointerEvent) => {
    if (handleDragRef.current !== which) return
    e.preventDefault()
    handleDragRef.current = null
    setHandleDrag(null)
    stopAutoScroll()
    handleDragPosRef.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* noop */
    }
    const a = anchorRef.current
    const f = focusRef.current
    if (a >= 0 && f >= 0) {
      try {
        navigator.vibrate?.(15)
      } catch {
        /* noop */
      }
      openMenuForRange(a, f)
    }
  }

  // ---- 选区菜单拖动（把手）：拖到不挡手柄的位置，偏移跨会话记忆 ----
  const selMenuDragRef = React.useRef<{ px: number; py: number; baseX: number; baseY: number } | null>(null)
  const beginSelMenuDrag = (e: React.PointerEvent) => {
    if (!selMenu) return
    e.preventDefault()
    e.stopPropagation()
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* noop */
    }
    selMenuDragRef.current = {
      px: e.clientX,
      py: e.clientY,
      baseX: selMenu.baseX + selMenuOffRef.current.dx,
      baseY: selMenu.baseY + selMenuOffRef.current.dy,
    }
  }
  const moveSelMenuDrag = (e: React.PointerEvent) => {
    const d = selMenuDragRef.current
    if (!d || !selMenu) return
    e.preventDefault()
    e.stopPropagation()
    setSelMenu({
      ...selMenu,
      x: clampMenuX(d.baseX + (e.clientX - d.px)),
      y: clampMenuY(d.baseY + (e.clientY - d.py)),
    })
  }
  const endSelMenuDrag = (e: React.PointerEvent) => {
    const d = selMenuDragRef.current
    if (!d) return
    selMenuDragRef.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* noop */
    }
    if (!selMenu) return
    // 记忆相对自动定位基准的偏移（下次打开继续生效）
    const off = { dx: selMenu.x - selMenu.baseX, dy: selMenu.y - selMenu.baseY }
    selMenuOffRef.current = off
    try {
      window.localStorage.setItem(SEL_MENU_DRAG_KEY, JSON.stringify(off))
    } catch {
      /* noop */
    }
  }

  // ---- right-click (desktop): native selection OR char under cursor ----
  const handleRootContextMenu = (e: React.MouseEvent) => {
    if (!menuEnabled) return
    const target = e.target as HTMLElement
    const inBlank = !!target.closest('[data-word]')
    if (inBlank && !selectionMode) return // LongPressMenu on the blank handles it
    e.preventDefault()
    clearPressTimer()

    const sel = document.getSelection()
    const selText = (sel?.toString() ?? '').trim()
    const root = rootRef.current
    const nativeInside =
      sel &&
      !sel.isCollapsed &&
      sel.rangeCount > 0 &&
      root &&
      sel.anchorNode &&
      sel.focusNode &&
      root.contains(sel.anchorNode) &&
      root.contains(sel.focusNode)

    if (nativeInside && selText && selText.length <= 200) {
      // 尝试从选区起点解析精确出现序号（拖选第二处「明月」也能精准挖空这一处）。
      const anchorEl = (sel!.anchorNode?.parentElement ?? null)?.closest?.(
        '[data-char]',
      ) as HTMLElement | null
      const occSel = occFromCharEl(anchorEl, selText)
      const occValid = occSel !== null && occSel >= 0
      openMenuAtPoint(
        e.clientX,
        e.clientY,
        selText,
        occValid ? isOccBlanked(selText, occSel) : isTextBlanked(selText),
        occValid ? occSel : null,
      )
      return
    }

    // No native selection: select the 字 under the cursor.
    const idx = charIdxFromEvent(e)
    if (idx < 0) return
    const underEl = getCharEls()[idx] ?? (e.target as HTMLElement).closest?.('[data-char]')
    highlightRange(idx, idx)
    openMenuForRange(
      idx,
      idx,
      { x: e.clientX, y: e.clientY },
      occFromCharEl(underEl as HTMLElement | null, (underEl as HTMLElement | null)?.textContent ?? ''),
    )
  }

  const handleSelMenuAction = (key: string) => {
    const cur = selMenu
    if (!cur) return
    switch (key) {
      case 'cloze': {
        if (readOnly) break
        const text = cur.text
        // 优先用打开菜单时记录的精确出现序号；拖选路径回退到首个出现。
        const occ = cur.occ ?? resolveSelection(text).occ
        if (cur.isKeyword) {
          // already blanked → uncloze
          if (selectionMode) {
            onToggleKeyword(text, occ)
          } else {
            onSelectionUncloze?.(text, occ)
            toast.success(`已取消挖空「${text.slice(0, 10)}${text.length > 10 ? '…' : ''}」`)
          }
        } else if (selectionMode) {
          onSelectCloze?.(text, occ)
        } else {
          onSelectionCloze?.(text, occ)
          toast.success(
            `已挖空 ${Array.from(text).length} 字「${text.slice(0, 10)}${text.length > 10 ? '…' : ''}」`,
          )
        }
        closeSelMenu()
        document.getSelection()?.removeAllRanges()
        break
      }
      case 'copy':
        copyText(cur.text)
        break
      case 'speak':
        speakText(cur.text)
        break
    }
  }

  // Global close listeners while the selection menu is open.
  React.useEffect(() => {
    if (!selMenu && !selTips) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') closeSelMenu()
    }
    const onScroll = () => {
      if (!handleDragRef.current) closeSelMenu()
    }
    const onResize = () => closeSelMenu()
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [selMenu, selTips, handleDrag, closeSelMenu])

  React.useEffect(() => clearPressTimer, [])

  const selOriginX = selMenu
    ? selMenu.x > window.innerWidth / 2
      ? 'right'
      : 'left'
    : 'left'
  const selOriginY = selMenu
    ? selMenu.above
      ? 'bottom'
      : 'top'
    : 'top'

  // ---- 自由选择框 portal：手柄 + 浮动菜单 ----
  // 层级关系（Bug2 修复核心）：
  //   9997 点按关闭层（selBackdrop，菜单打开时才挂）
  //   9998 手柄层（selOverlay，永远高于关闭层 → 菜单打开时也能直接抓拖块）
  //   9999 菜单面板本体（无整屏容器，pointer-events 只在面板 → 绝不遮挡手柄/正文）
  const teardropCls =
    'pointer-events-auto absolute size-6 rounded-full bg-white shadow-[0_2px_10px_rgba(0,0,0,0.35)] ring-1 ring-black/10'
  const selOverlay = selTips ? (
    <div data-cloze-ui="1" className="fixed inset-0 z-[9998]" style={{ pointerEvents: 'none' }}>
      {/* start handle — 身体在尖端左下方 */}
      <div
        role="button"
        aria-label="拖动调整选择起点"
        data-cloze-ui="1"
        style={{
          position: 'fixed',
          left: selTips.start.x,
          top: selTips.start.y,
          transform: `translate(-10px, ${HANDLE_BODY_OFFSET - 10}px)`,
          touchAction: 'none',
        }}
        className={teardropCls}
        onPointerDown={beginHandleDrag('start')}
        onPointerMove={moveHandleDrag('start')}
        onPointerUp={endHandleDrag('start')}
        onPointerCancel={endHandleDrag('start')}
      >
        <span className="absolute left-1/2 top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-500" />
      </div>
      {/* end handle — 身体在尖端右上方 */}
      <div
        role="button"
        aria-label="拖动调整选择终点"
        data-cloze-ui="1"
        style={{
          position: 'fixed',
          left: selTips.end.x,
          top: selTips.end.y,
          transform: `translate(-14px, ${-(HANDLE_BODY_OFFSET + 14)}px)`,
          touchAction: 'none',
        }}
        className={teardropCls}
        onPointerDown={beginHandleDrag('end')}
        onPointerMove={moveHandleDrag('end')}
        onPointerUp={endHandleDrag('end')}
        onPointerCancel={endHandleDrag('end')}
      >
        <span className="absolute left-1/2 top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-500" />
      </div>
    </div>
  ) : null

  // 点按任意空白处关闭选择（仅在菜单打开时挂载；低于手柄层，不会拦截拖块）
  const selBackdrop = selMenu ? (
    <div
      data-cloze-ui="1"
      aria-hidden
      className="fixed inset-0 z-[9997]"
      onPointerDown={(e) => {
        e.stopPropagation()
        closeSelMenu()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        closeSelMenu()
      }}
    />
  ) : null

  const selMenuPanel = selMenu ? (
    <div
      role="menu"
      aria-label="选择菜单"
      data-cloze-ui="1"
      style={{
        position: 'fixed',
        left: selMenu.x,
        top: selMenu.y,
        width: SEL_MENU_WIDTH,
        zIndex: 9999,
        transformOrigin: `${selOriginX} ${selOriginY}`,
        transform: 'translate(-50%, -50%)',
      }}
      className="pointer-events-auto rounded-2xl border border-white/10 bg-zinc-900/95 p-1.5 pt-0 text-white shadow-2xl backdrop-blur"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 拖动把手：菜单可拖到不挡手柄的位置，偏移跨会话记忆 */}
      <div
        role="button"
        aria-label="拖动菜单位置"
        tabIndex={0}
        onPointerDown={beginSelMenuDrag}
        onPointerMove={moveSelMenuDrag}
        onPointerUp={endSelMenuDrag}
        onPointerCancel={endSelMenuDrag}
        className="flex h-9 w-full cursor-grab touch-none items-center justify-center rounded-lg text-zinc-400 transition-colors hover:text-zinc-200 active:cursor-grabbing"
      >
        <GripVertical className="size-4" strokeWidth={1.75} />
      </div>
        {!readOnly && (
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation()
              handleSelMenuAction('cloze')
            }}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] transition-colors',
              selMenu.isKeyword
                ? 'text-amber-300 hover:bg-amber-400/15'
                : 'text-emerald-300 hover:bg-emerald-400/15',
            )}
          >
            {selMenu.isKeyword ? (
              <RotateCcw className="size-4 shrink-0" strokeWidth={1.75} />
            ) : (
              <Eraser className="size-4 shrink-0" strokeWidth={1.75} />
            )}
            <span className="truncate">
              {selMenu.isKeyword
                ? `取消挖空「${selMenu.text.slice(0, 6)}${selMenu.text.length > 6 ? '…' : ''}」`
                : `挖空选中${Array.from(selMenu.text).length > 1 ? `（${Array.from(selMenu.text).length}字）` : ''}`}
            </span>
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          onClick={(e) => {
            e.stopPropagation()
            handleSelMenuAction('speak')
          }}
          className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-zinc-100 transition-colors hover:bg-white/10"
        >
          <Volume2 className="size-4 shrink-0" strokeWidth={1.75} />
          <span className="truncate">朗读</span>
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={(e) => {
            e.stopPropagation()
            handleSelMenuAction('copy')
          }}
          className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-zinc-100 transition-colors hover:bg-white/10"
        >
          <Copy className="size-4 shrink-0" strokeWidth={1.75} />
          <span className="truncate">复制</span>
        </button>
    </div>
  ) : null

  // ===========================================================================
  // 挖空刷 v2.1：一次连续滑动 = 一个空（松手才提交）
  //
  // 手机端「挖 1~2 个词就停」的根因与对策：
  //  1) touch-action:none 必须挂在**块级文字层**上——此前只挂在行内字 <span> 上，
  //     而 CSS 规范规定 touch-action 不适用于 non-replaced inline 元素（浏览器
  //     直接忽略）→ 触摸被当作页面滚动，~150ms 后浏览器接管派发 pointercancel，
  //     涂刷被迫提前提交（与“挖 1~2 个词就停”完全吻合）。
  //     → 现在 brushMode 时给每个渲染源的块级包裹层加 touchAction:'none'（wrap()）。
  //  2) 涂刷期间零 setState（ref + classList 高亮）：重渲染不会重建 DOM / 丢 capture。
  //  3) elementFromPoint 命中悬浮 UI（[data-cloze-ui] 工具栏/手柄/菜单）时只跳过
  //     该采样点，绝不中断整次涂刷；命中非文字区域同样只不扩展。
  //  4) getCoalescedEvents 合并事件 + 每 4px 线段插值，快速滑动不漏字。
  //  5) window 级 pointermove/pointerup/pointercancel 兜底（部分安卓浏览器
  //     setPointerCapture 不稳定）；且只响应当次涂刷的 pointerId——第二根手指
  //     /手掌抬起的 pointerup 不再误提交（此前多指误触也会提前结束涂刷）。
  //  6) pointercancel（来电/手势接管）同样提交已采集的词，不丢已选内容。
  // ===========================================================================
  const brushAccRef = React.useRef<Map<string, Set<HTMLElement>>>(new Map())
  const brushModeRef = React.useRef(brushMode)
  const brushPointerIdRef = React.useRef<number | null>(null)
  React.useEffect(() => {
    brushModeRef.current = brushMode
  }, [brushMode])

  const brushAddEl = (el: HTMLElement) => {
    const srcKey = el.dataset.src || 'root'
    let set = brushAccRef.current.get(srcKey)
    if (!set) {
      set = new Set()
      brushAccRef.current.set(srcKey, set)
    }
    if (!set.has(el)) {
      set.add(el)
      // 临时高亮（松手后由正式挖空样式接管）
      el.classList.add('rounded-sm', 'bg-accent')
    }
  }

  const commitBrush = () => {
    const groups = brushAccRef.current
    if (groups.size === 0) return
    let committed = 0
    for (const [srcKey, els] of groups) {
      if (els.size === 0) continue
      const src = sources.find((s) => s.key === srcKey)
      if (!src) continue
      // 按位置排序，取 min..max 连续区间（划过的部分连成一个空，支持跨行/跨段）
      const sorted = [...els].sort((a, b) => Number(a.dataset.pos) - Number(b.dataset.pos))
      const first = sorted[0]
      const last = sorted[sorted.length - 1]
      const startPos = Number(first.dataset.pos)
      const lastPos = Number(last.dataset.pos)
      const lastLen = Array.from(last.dataset.word || last.textContent || '').length
      const text = src.plain.slice(startPos, lastPos + lastLen).trim()
      if (!text) continue
      // 已是完整挖空词时不重复提交
      const occ = occAt(src.plain, text, startPos)
      if (isOccBlanked(text, occ)) continue
      onSelectionCloze?.(text, occ)
      committed += 1
    }
    for (const set of groups.values()) {
      for (const el of set) el.classList.remove('rounded-sm', 'bg-accent')
    }
    brushAccRef.current = new Map()
    if (committed > 0) {
      toast.success(`已挖空 ${committed} 处`)
    }
  }

  // latest-ref：window 兜底监听只挂一次，回调始终取最新
  const commitBrushRef = React.useRef(commitBrush)
  React.useEffect(() => {
    commitBrushRef.current = commitBrush
  })

  const lastBrushPosRef = React.useRef<{ x: number; y: number } | null>(null)

  /** 采样一个点：命中悬浮 UI 只跳过（不中断），命中字则收集。 */
  const brushSamplePoint = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    if (!el) return
    // 悬浮工具栏/选择手柄/菜单等挖空 UI：跳过该采样点（继续而非中断）
    if (el.closest('[data-cloze-ui]')) return
    const wordEl = el.closest('[data-char][data-pos]') as HTMLElement | null
    if (wordEl) brushAddEl(wordEl)
  }

  /** last→cur 线段插值采样（步长 4px）：快划时补齐 pointermove 之间的空隙。 */
  const brushSampleSegment = (x0: number, y0: number, x1: number, y1: number) => {
    const dx = x1 - x0
    const dy = y1 - y0
    const dist = Math.hypot(dx, dy)
    const n = Math.max(1, Math.ceil(dist / BRUSH_SAMPLE_STEP))
    for (let i = 1; i <= n; i++) {
      const t = i / n
      brushSamplePoint(x0 + dx * t, y0 + dy * t)
    }
  }

  const brushHandleMove = (x: number, y: number) => {
    const last = lastBrushPosRef.current
    if (last) brushSampleSegment(last.x, last.y, x, y)
    else brushSamplePoint(x, y)
    lastBrushPosRef.current = { x, y }
  }

  /** 结束涂刷：提交已采集的词（pointercancel 也走这里，不丢已选词）。 */
  const endBrush = () => {
    if (!draggingRef.current) return
    draggingRef.current = false
    brushPointerIdRef.current = null
    lastBrushPosRef.current = null
    commitBrushRef.current()
  }

  const brushMoveRef = React.useRef(brushHandleMove)
  const brushEndRef = React.useRef(endBrush)
  React.useEffect(() => {
    brushMoveRef.current = brushHandleMove
    brushEndRef.current = endBrush
  })

  // window 级兜底：涂刷激活期间接收 move/up/cancel（部分安卓浏览器
  // setPointerCapture 不稳/丢失时仍能继续采样与提交）。
  React.useEffect(() => {
    const isBrushPointer = (ev: PointerEvent) =>
      brushPointerIdRef.current === null || ev.pointerId === brushPointerIdRef.current
    const onMove = (ev: PointerEvent) => {
      if (!brushModeRef.current || !draggingRef.current || !isBrushPointer(ev)) return
      brushMoveRef.current(ev.clientX, ev.clientY)
    }
    const onEnd = (ev: PointerEvent) => {
      if (!brushModeRef.current || !draggingRef.current || !isBrushPointer(ev)) return
      brushEndRef.current()
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
    }
  }, [])

  // 挖空刷按下：只有按在「字」上才启动刷（空白处按下 = 页面滚动意图）。
  // setPointerCapture 到根容器：后续 move 全部锁定，滑过行间空白不丢事件。
  const handleBrushPointerDown = (e: React.PointerEvent) => {
    if (!brushMode) return
    const target = e.target as HTMLElement
    const wordEl = target.closest?.('[data-char][data-pos]') as HTMLElement | null
    if (!wordEl) return
    draggingRef.current = true
    brushPointerIdRef.current = e.pointerId
    brushAccRef.current = new Map()
    brushAddEl(wordEl)
    lastBrushPosRef.current = { x: e.clientX, y: e.clientY }
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* noop */
    }
  }

  const handleBrushPointerMove = (e: React.PointerEvent) => {
    if (!brushMode || !draggingRef.current) return
    // getCoalescedEvents：一次回调拿到浏览器合并的高频采样点（快划不漏字）；
    // 不支持的浏览器回退到当前事件坐标。
    const native = e.nativeEvent
    const coalescer = (native as { getCoalescedEvents?: () => PointerEvent[] }).getCoalescedEvents
    let pts: PointerEvent[] = []
    if (typeof coalescer === 'function') {
      try {
        pts = coalescer.call(native)
      } catch {
        pts = []
      }
    }
    if (pts.length === 0) pts = [native]
    for (const p of pts) brushHandleMove(p.clientX, p.clientY)
  }

  const scrollToPage = (idx: number) => {
    const el = containerRef.current
    if (!el) return
    const target = Math.max(0, Math.min(idx, (pages?.length ?? 1) - 1))
    el.scrollTo({ left: target * el.clientWidth, behavior: 'smooth' })
    setPage(target)
  }

  // Report page changes for the reader's page indicator.
  React.useEffect(() => {
    onPageChange?.(page, pages?.length ?? 1)
  }, [page, pages?.length])

  // ===========================================================================
  // 渲染管线：buildBlocks → computeBlankRanges(plain) → 逐字渲染（挖空 + 富样式）
  // 每个渲染源（全文 / 分块 / 分页）独立建块与挖空范围，全部在 useMemo 中完成，
  // 渲染期间不再改写任何 ref（react-hooks 规则）。
  // ===========================================================================
  interface SourceCtx {
    key: string
    raw: string
    chunkIndex: number | null
    blocks: Block[]
    plain: string
    blanks: BlankPos[]
    blankByStart: Map<number, BlankPos>
    blankSet: Set<number>
  }



  const renderSource = (ctx: SourceCtx): React.ReactNode => {
    const { raw: src, key: srcKey } = ctx

    let charIdx = -1

    // Highlight classes applied while the custom selection covers this token.
    const hlCls = (isBlank: boolean) =>
      selHL.size > 0 && charIdx >= 0 && selHL.has(charIdx)
        ? isBlank
          ? 'outline-2 outline-amber-500/80'
          : 'rounded-sm bg-amber-300/70 outline-2 outline-amber-500/80 dark:bg-amber-500/40'
        : undefined

    const renderBlank = (b: BlankPos, extraCls?: string) => {
      const idx = b.idx
      const text = b.text
      charIdx += 1
      const ci = charIdx
      // effectiveRevealed accounts for the local hiddenBlanks override so a
      // blank the user toggled off stops showing the amber "revealed" tint.
      const isRevealed = revealed.has(idx) && !hiddenBlanks.has(idx)
      const tempOn = tempRevealed.has(idx)
      const visible = showAnswers || isRevealed || tempOn
      const effRevealed = isRevealed || tempOn

      // Shared answer-state tints: amber once this blank's answer is shown as
      // revealed, emerald when answers are globally on but not peeked here.
      const revealedCls = 'bg-amber-200/70 text-foreground dark:bg-amber-500/30'
      const peekedCls = 'bg-emerald-500/10 text-foreground/90'

      let styleCls = ''
      let inner: React.ReactNode = text
      switch (style) {
        case 'circle':
          styleCls = cn(
            'inline-block rounded-[50%] border-2 px-2 text-center',
            !visible && 'border-foreground/50 text-transparent',
            visible && effRevealed && cn('border-emerald-500/60', revealedCls),
            visible && !effRevealed && cn('border-emerald-500/40', peekedCls),
          )
          break
        case 'underline':
          styleCls = cn(
            'border-b-2',
            !visible && 'border-dashed border-foreground/50 text-transparent',
            visible && effRevealed && cn('border-emerald-500/60', revealedCls),
            visible && !effRevealed && cn('border-emerald-500/40', peekedCls),
          )
          break
        case 'blur':
          styleCls = cn(
            'rounded-sm',
            !visible && 'opacity-80',
            visible && effRevealed && revealedCls,
            visible && !effRevealed && peekedCls,
          )
          break
        case 'star':
          styleCls = cn(
            !visible && 'text-foreground/45',
            visible && effRevealed && cn('rounded-sm', revealedCls),
            visible && !effRevealed && cn('rounded-sm', peekedCls),
          )
          if (!visible) inner = '*'.repeat(Array.from(text).length)
          break
        case 'blank':
          styleCls = cn(
            'rounded',
            !visible && 'bg-muted-foreground/15 text-transparent',
            visible && effRevealed && revealedCls,
            visible && !effRevealed && peekedCls,
          )
          break
        case 'highlight':
          styleCls = cn(
            'rounded',
            !visible && 'bg-amber-300/60 text-transparent',
            visible && effRevealed && revealedCls,
            visible && !effRevealed && peekedCls,
          )
          break
      }

      const blank = (
        <span
          key={`b-${idx}`}
          role="button"
          tabIndex={0}
          aria-label={
            selectionMode
              ? `已挖空：${text}，点击取消挖空`
              : visible
                ? `已显示：${text}`
                : '点击显示答案'
          }
          data-word={text}
          data-char="1"
          data-ci={ci}
          data-pos={b.start}
          data-src={ctx.key}
          onClick={(e) => {
            e.stopPropagation()
            if (!brushMode) {
              if (selectionMode) onToggleKeyword(text, b.occ)
              else toggleBlank(idx)
            }
          }}
          onDoubleClick={
            selectionMode
              ? undefined
              : (e) => {
                  e.stopPropagation()
                  if (!readOnly) onToggleKeyword(text, b.occ)
                }
          }
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              if (!brushMode) {
                if (selectionMode) onToggleKeyword(text, b.occ)
                else toggleBlank(idx)
              }
            }
          }}
          className={cn(
            'cursor-pointer align-middle',
            style !== 'blur' && 'transition-colors',
            styleCls,
            extraCls,
            hlCls(true),
          )}
          style={{
            minWidth: '1.5em',
            ...(style === 'blur'
              ? {
                  filter: !visible ? 'blur(5px)' : 'blur(0px)',
                  transition:
                    'filter 200ms ease, opacity 200ms ease, background-color 200ms ease, color 200ms ease',
                }
              : {}),
          }}
        >
          {inner}
        </span>
      )

      // 编辑模式: render blanks bare — tapping a blank toggles it off; the
      // unified selection menu handles long-press/right-click.
      if (selectionMode) return blank

      const blankActions: MenuAction[] =
        menuActions ??
        [
          { key: 'reveal', label: '查看答案', icon: <Eye className="size-3.5" strokeWidth={1.75} /> },
          { key: 'speak', label: '朗读', icon: <Volume2 className="size-3.5" strokeWidth={1.75} /> },
          { key: 'copy', label: '复制', icon: <Copy className="size-3.5" strokeWidth={1.75} /> },
          ...(onRemoveKeyword && !readOnly
            ? [{ key: 'remove', label: '取消挖空', icon: <Eraser className="size-3.5" strokeWidth={1.75} /> }]
            : []),
          ...(onMarkHard
            ? [{ key: 'mark', label: '标记难点', icon: <Flag className="size-3.5" strokeWidth={1.75} /> }]
            : []),
        ]

      return (
        <LongPressMenu
          key={`b-${idx}`}
          actions={blankActions}
          onAction={(key) => handleBlankMenuAction(key, text, idx, b.occ)}
        >
          {blank}
        </LongPressMenu>
      )
    }

    // 渲染一个文本块：runs + 空白位置 → spans。
    const renderTextBlock = (block: Extract<Block, { kind: 'text' }>, blockKey: string) => {
      const { runs, plainStart, plain: pPlain } = block
      const pStart = plainStart
      const pEnd = plainStart + pPlain.length

      const out: React.ReactNode[] = []
      let pos = pStart // 当前渲染到的 plain 绝对位置
      let ri = 0

      while (pos < pEnd && ri < runs.length) {
        const run = runs[ri]
        const runStart = pStart + run.start
        const runEndAbs = runStart + run.text.length
        if (pos < runStart) {
          // 防御：run 之间的间隙
          const gap = pPlain.slice(pos - pStart, run.start)
          if (gap) out.push(<span key={`${blockKey}-g${pos}`}>{gap}</span>)
          pos = runStart
        }
        const blankAtPos = ctx.blankByStart.get(pos)
        if (blankAtPos) {
          out.push(
            <React.Fragment key={`${blockKey}-b${blankAtPos.start}`}>
              {renderBlank(blankAtPos)}
            </React.Fragment>,
          )
          pos = blankAtPos.end
          // 空白可能跨越多个 run：跳过被覆盖的 runs
          while (ri < runs.length && pStart + runs[ri].start + runs[ri].text.length <= pos) ri += 1
          continue
        }
        // 行内公式 run：katex 渲染（不可挖空、不逐字拆分），pos 连续推进保证后续 data-pos 正确
        if (run.math) {
          const before = pPlain.slice(pos - pStart, run.start)
          if (before) out.push(<span key={`${blockKey}-mb${pos}`}>{before}</span>)
          out.push(
            <span key={`${blockKey}-m${runStart}`} className="inline-block align-middle">
              <FormulaBlock tex={run.math} display={!!run.mathDisplay} inline />
            </span>,
          )
          pos = runEndAbs
          ri += 1
          continue
        }
        // 行内图片 run：原位渲染 <img>（零长度 run，不推进 plain，不可挖空）
        if (run.image) {
          out.push(
            <img
              key={`${blockKey}-img${runStart}-${ri}`}
              src={run.image.src}
              alt={run.image.alt || '课文配图'}
              loading="lazy"
              className="my-1 inline-block h-auto max-w-full rounded-xl align-middle"
            />,
          )
          pos = runEndAbs
          ri += 1
          continue
        }
        // 在 run 内：下一段到 run 末尾或下一个空白起点
        const nextBlank = ctx.blanks.find((bb) => bb.start > pos && bb.start < runEndAbs)
        const segEnd = nextBlank ? Math.min(nextBlank.start, runEndAbs) : runEndAbs
        const segPlain = pPlain.slice(pos - pStart, segEnd - pStart)
        const runCls = run.code
          ? 'rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]'
          : run.cls
        const styleProp =
          run.color || run.fontSize
            ? {
                color: run.color,
                fontSize: run.fontSize ? `${run.fontSize}px` : undefined,
              }
            : undefined
        const chars = splitCharTokens(segPlain)
        for (let ci2 = 0; ci2 < chars.length; ci2++) {
          const w = chars[ci2]
          if (!w.isChar) {
            out.push(
              <span key={`${blockKey}-s${pos}-${ci2}`} style={styleProp} className={runCls}>
                {w.text}
              </span>,
            )
            pos += w.text.length
            continue
          }
          charIdx += 1
          const key = `${blockKey}-c${pos}`
          out.push(
            <span
              key={key}
              data-char="1"
              data-ci={charIdx}
              data-pos={pos}
              data-src={ctx.key}
              data-word={brushMode ? w.text : undefined}
              style={styleProp}
              className={cn(
                runCls,
                // 挖空刷：字上加 touch-none 仅为兼容兜底——真正生效的是外层块级
                // wrap() 上的 touchAction:'none'（touch-action 对行内 span 无效），
                // 行间/页边空白仍可滑动页面（空白处按下不启动涂刷）。
                brushMode &&
                  'cursor-crosshair touch-none rounded-sm transition-colors hover:bg-accent/70',
                manualMode && 'cursor-text rounded-sm transition-colors hover:bg-accent/70',
                hlCls(false),
              )}
              onDoubleClick={
                manualMode && !readOnly
                  ? (e) => {
                      e.stopPropagation()
                      onToggleKeyword(w.text, occAt(ctx.plain, w.text, pos))
                    }
                  : undefined
              }
            >
              {w.text}
            </span>,
          )
          pos += w.text.length
        }
        if (pos >= runEndAbs) ri += 1
      }
      // while 条件（pos < pEnd）可能在还有零长度图片 run 时提前退出（如段落末尾/纯图片行）：补渲染
      for (; ri < runs.length; ri += 1) {
        const run = runs[ri]
        if (!run.image) break
        out.push(
          <img
            key={`${blockKey}-img${pStart + run.start}-${ri}`}
            src={run.image.src}
            alt={run.image.alt || '课文配图'}
            loading="lazy"
            className="my-1 inline-block h-auto max-w-full rounded-xl align-middle"
          />,
        )
      }
      // run 之后的尾文本（防御）
      if (pos < pEnd) {
        const rest = pPlain.slice(pos - pStart)
        if (rest) out.push(<span key={`${blockKey}-tail${pos}`}>{rest}</span>)
      }

      return (
        <p key={blockKey} data-toc-para={block.tocPara} className="whitespace-pre-wrap">
          {out}
        </p>
      )
    }

    const renderBlock = (block: Block, i: number): React.ReactNode => {
      switch (block.kind) {
        case 'text':
          return renderTextBlock(block, `t${i}`)
        case 'image':
          return (
            <div key={`img${i}`} className="py-1">
              <img
                src={block.src}
                alt={block.alt || '课文配图'}
                loading="lazy"
                className="max-w-full h-auto rounded-xl"
              />
            </div>
          )
        case 'formula':
          return <FormulaBlock key={`fx${i}`} tex={block.tex} display={block.display} />
        case 'code':
          return <CodeBlockSegment key={`cb${i}`} lang={block.lang} code={block.code} />
        case 'table':
          return (
            <div key={`tb${i}`} className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full border-collapse text-[0.95em]">
                <tbody>
                  {block.rows.map((row, ri2) => (
                    <tr key={ri2} className={ri2 === 0 ? 'bg-muted/60 font-medium' : ''}>
                      {row.map((cell, ci3) => (
                        <td
                          key={ci3}
                          className="border border-border px-2.5 py-1.5 align-top leading-relaxed"
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
      }
    }

    // brushMode 时给块级文字层禁用触摸滚动（touch-action 对行内 span 无效，
    // 必须挂在块级层上，否则浏览器把涂刷当滚动 → ~150ms 后 pointercancel）。
    const wrap = (nodes: React.ReactNode[]) => (
      <div
        className="space-y-3"
        style={{ touchAction: brushMode ? 'none' : undefined }}
      >
        {nodes}
      </div>
    )
    const body = ctx.blocks.map((b, i) => renderBlock(b, i))

    if (ctx.chunkIndex !== null) {
      return (
        <div
          key={srcKey}
          data-toc-chunk={ctx.chunkIndex}
          className="rounded-xl border border-border bg-card p-4 shadow-sm"
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-full bg-emerald-600 text-xs font-semibold text-white">
              {ctx.chunkIndex + 1}
            </span>
            <span className="text-xs text-muted-foreground">
              第 {ctx.chunkIndex + 1} 块 · {src.length} 字
            </span>
          </div>
          {wrap(body)}
        </div>
      )
    }
    return wrap(body)
  }

  // ---- layout ----
  // 统一根容器：三种布局（全文/分块/分页）都挂 rootRef + 指针处理器。
  // 此前分块/分页布局完全没有挂事件 → 挖空刷与长按选字在这两种模式下失效。
  // brushMode 时根容器统一 select-none + 禁用长按弹菜单（防涂刷被系统手势打断）。
  return (
    <div
      ref={rootRef}
      className={cn(
        (brushMode || suppressNativeSelect) &&
          'select-none [-webkit-touch-callout:none] [-webkit-user-select:none]',
      )}
      onPointerDown={(e) => {
        handleBrushPointerDown(e)
        handleRootPointerDown(e)
      }}
      onPointerMove={(e) => {
        handleBrushPointerMove(e)
        handleRootPointerMove(e)
      }}
      onPointerUp={(e) => {
        // 挖空刷：松手提交（根容器 pointerup 先于 window 兜底触发；endBrush 幂等）
        if (brushMode && draggingRef.current) {
          endBrush()
        } else {
          draggingRef.current = false
        }
        try {
          ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
        } catch {
          /* noop */
        }
        handleRootPointerEnd(e)
      }}
      onPointerCancel={(e) => {
        // pointercancel（来电/手势接管等）同样提交已采集的词，不丢已选内容
        if (brushMode && draggingRef.current) {
          endBrush()
        } else {
          draggingRef.current = false
        }
        try {
          ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
        } catch {
          /* noop */
        }
        handleRootPointerEnd(e)
      }}
      onContextMenu={handleRootContextMenu}
    >
      {chunks ? (
        <div className="flex flex-col gap-3">
          {sources.map((s) => (
            <React.Fragment key={s.key}>{renderSource(s)}</React.Fragment>
          ))}
        </div>
      ) : pages ? (
        <div className="relative">
          <div
            ref={containerRef}
            className="flex snap-x snap-mandatory overflow-x-auto scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            onScroll={(e) => {
              const el = e.currentTarget
              const cur = Math.round(el.scrollLeft / Math.max(1, el.clientWidth))
              if (cur !== page) setPage(cur)
            }}
          >
            {sources.map((s) => (
              <div key={s.key} className="w-full shrink-0 snap-center px-1">
                {renderSource(s)}
              </div>
            ))}
          </div>
          {pages.length > 1 && (
            <>
              <button
                type="button"
                aria-label="上一页"
                disabled={page <= 0}
                onClick={() => scrollToPage(page - 1)}
                className="absolute left-0 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background/90 shadow-md transition-opacity disabled:opacity-25"
              >
                ‹
              </button>
              <button
                type="button"
                aria-label="下一页"
                disabled={page >= pages.length - 1}
                onClick={() => scrollToPage(page + 1)}
                className="absolute right-0 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background/90 shadow-md transition-opacity disabled:opacity-25"
              >
                ›
              </button>
            </>
          )}
        </div>
      ) : (
        <div
          className="leading-loose text-zinc-800 dark:text-zinc-200"
          style={{ fontSize: `${fontSize}px` }}
        >
          {sources.map((s) => (
            <React.Fragment key={s.key}>{renderSource(s)}</React.Fragment>
          ))}
        </div>
      )}
      {selMounted && selBackdrop ? createPortal(selBackdrop, document.body) : null}
      {selMounted && selOverlay ? createPortal(selOverlay, document.body) : null}
      {selMounted && selMenuPanel ? createPortal(selMenuPanel, document.body) : null}
    </div>
  )
}

// 公式块：katex 渲染（不可挖空）。失败时回退为等宽文本。
// inline=true 时输出 <span>（段落 <p> 内不允许嵌套 <div>）。
function FormulaBlock({ tex, display, inline }: { tex: string; display: boolean; inline?: boolean }) {
  let html: string | null = null
  try {
    html = katex.renderToString(tex.trim(), {
      displayMode: display,
      throwOnError: false,
      output: 'html',
    })
  } catch {
    html = null
  }
  if (html) {
    const cls = cn(
      'overflow-x-auto bg-muted/40 px-3 py-2',
      display && !inline ? 'text-center' : '',
    )
    if (inline) {
      return <span className={cls} dangerouslySetInnerHTML={{ __html: html }} />
    }
    return (
      <div className={cn(cls, 'rounded-xl')} dangerouslySetInnerHTML={{ __html: html }} />
    )
  }
  if (inline) {
    return (
      <span className="rounded bg-muted/40 px-1 font-mono text-[0.92em]">
        {display ? '$$' : '$'}
        {tex}
        {display ? '$$' : '$'}
      </span>
    )
  }
  return (
    <div className="overflow-x-auto rounded-xl bg-muted/40 px-3 py-2 font-mono text-sm">
      {display ? '$$' : '$'}
      {tex}
      {display ? '$$' : '$'}
    </div>
  )
}

// 代码/图表块：mermaid（思维导图/流程图/树状图）、html、其它语言 → RichContent 渲染。
// React.lazy 按需加载，避免给纯文本背诵场景增加体积。
const RichContentLazy = React.lazy(
  () => import('@/components/recitation/rich-content').then((m) => ({ default: m.RichContent })),
)

function CodeBlockSegment({ lang, code }: { lang: string; code: string }) {
  const isHtml = /^html?$/i.test(lang.trim())
  // html 块直接交给 rehypeRaw 渲染；其余包回围栏（mermaid → SVG，其它 → 高亮代码）
  const content = isHtml ? code : `\`\`\`${(lang || 'text').trim()}\n${code}\n\`\`\``
  return (
    <div className="my-1">
      <React.Suspense
        fallback={
          <div className="rounded-xl bg-muted/50 py-6 text-center text-xs text-muted-foreground">
            图表/代码渲染中…
          </div>
        }
      >
        <RichContentLazy content={content} />
      </React.Suspense>
    </div>
  )
}
