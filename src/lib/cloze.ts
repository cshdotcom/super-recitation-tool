// Client-safe cloze / text helpers. No z-ai imports here so this file can be
// imported by both server and client code.

import type { KwEntry } from '@/lib/types'

export interface Segment {
  text: string
  isBlank: boolean
}

/** A blank range in absolute char offsets of the (stripped) source text. */
export interface BlankRange {
  start: number
  end: number
  text: string
}

const CJK = '\\u4e00-\\u9fff\\u3400-\\u4dbf'

export function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// Keyword entry model (position-aware 挖空):
//   - plain string            → legacy entry: blanks EVERY occurrence
//   - { t, occ }  occ = -1    → same as legacy (all occurrences)
//   - { t, occ }  occ >= 0    → blanks only the occ-th (0-based) occurrence
// Manual selection / 挖空刷 / dblclick create occurrence-scoped entries so
// blanking one 炸 no longer blanks every other 炸 in unrelated sentences.
// ---------------------------------------------------------------------------

/** Defensively normalize unknown keyword JSON into KwEntry[]. */
export function normKeywordEntries(keywords: unknown): KwEntry[] {
  if (!Array.isArray(keywords)) return []
  const out: KwEntry[] = []
  for (const k of keywords) {
    if (typeof k === 'string') {
      const t = k.trim()
      if (t) out.push(t)
    } else if (k && typeof k === 'object') {
      const o = k as { t?: unknown; occ?: unknown }
      const t = typeof o.t === 'string' ? o.t.trim() : ''
      if (!t) continue
      const occ = Number.isFinite(Number(o.occ)) ? Math.floor(Number(o.occ)) : -1
      out.push({ t, occ })
    }
  }
  return out
}

export function kwText(e: KwEntry): string {
  return typeof e === 'string' ? e : e.t
}

export function kwOcc(e: KwEntry): number {
  return typeof e === 'string' ? -1 : e.occ
}

/** Same keyword + same occurrence slot (or both "all")? */
function sameSlot(a: KwEntry, t: string, occ: number): boolean {
  if (kwText(a) !== t) return false
  const o = kwOcc(a)
  return o === occ || o === -1 || occ === -1
}

/** Unique texts sorted longest-first (longer keywords win matches). */
function distinctTexts(entries: KwEntry[]): string[] {
  return Array.from(new Set(entries.map(kwText))).sort((a, b) => b.length - a.length)
}

/**
 * Compute ALL blank ranges over `content` (absolute char offsets).
 * Occurrence-scoped entries only blank their own occurrence; legacy
 * string entries blank every occurrence.
 */
export function computeBlankRanges(content: string, keywords: KwEntry[]): BlankRange[] {
  const entries = normKeywordEntries(keywords)
  if (!content || entries.length === 0) return []
  const texts = distinctTexts(entries)
  const pattern = new RegExp(`(${texts.map(escapeReg).join('|')})`, 'g')
  const counters = new Map<string, number>()
  const ranges: BlankRange[] = []
  let m: RegExpExecArray | null
  while ((m = pattern.exec(content)) !== null) {
    const text = m[1]
    const occ = counters.get(text) ?? 0
    counters.set(text, occ + 1)
    const hit = entries.some((e) => sameSlot(e, text, occ))
    if (hit) ranges.push({ start: m.index, end: m.index + text.length, text })
  }
  // Defensive merge of overlapping ranges (keep the longer span).
  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: BlankRange[] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r.start < last.end) {
      if (r.end > last.end) last.end = r.end
    } else {
      merged.push({ ...r })
    }
  }
  return merged
}

/** Split `content` into segments; segments inside a blank range are marked. */
export function tokenize(content: string, keywords: KwEntry[]): Segment[] {
  const ranges = computeBlankRanges(content, keywords)
  if (ranges.length === 0) return [{ text: content, isBlank: false }]
  const out: Segment[] = []
  let cursor = 0
  for (const r of ranges) {
    if (r.start > cursor) out.push({ text: content.slice(cursor, r.start), isBlank: false })
    out.push({ text: content.slice(r.start, r.end), isBlank: true })
    cursor = r.end
  }
  if (cursor < content.length) out.push({ text: content.slice(cursor), isBlank: false })
  return out
}

/** Which occurrence (0-based, of `text` in `content`) does `charStart` hit? -1 if not the text. */
export function occAt(content: string, text: string, charStart: number): number {
  if (!text) return -1
  if (content.slice(charStart, charStart + text.length) !== text) return -1
  let occ = 0
  let idx = content.indexOf(text)
  while (idx >= 0 && idx < charStart) {
    occ += 1
    idx = content.indexOf(text, idx + 1)
  }
  return occ
}

/**
 * Toggle an occurrence-scoped keyword entry (manual cloze paths).
 * `content` is the full source text so a legacy "blank all" entry can be
 * expanded into per-occurrence entries without losing the other blanks.
 */
export function toggleOccurrence(
  keywords: KwEntry[],
  text: string,
  occ: number,
  content: string,
): KwEntry[] {
  const entries = normKeywordEntries(keywords)
  const exactIdx = entries.findIndex((e) => kwText(e) === text && kwOcc(e) === occ)
  if (exactIdx >= 0) return entries.filter((_, i) => i !== exactIdx)
  // A legacy "all" entry already covers this occurrence — expand it into
  // per-occurrence entries for every OTHER occurrence, then toggle this one.
  const allIdx = entries.findIndex((e) => kwText(e) === text && kwOcc(e) === -1)
  if (allIdx >= 0 && occ >= 0) {
    const next = entries.filter((_, i) => i !== allIdx)
    const total = countTextOccurrences(content, text)
    const seen = new Set(next.filter((e) => kwText(e) === text).map((e) => kwOcc(e)))
    for (let o = 0; o < total; o++) {
      if (o !== occ && !seen.has(o)) next.push({ t: text, occ: o })
    }
    return next
  }
  return [...entries, occ >= 0 ? { t: text, occ } : text]
}

/**
 * Remove exactly one occurrence slot of `text` (取消挖空 on one blank).
 * If a legacy all-entry covers it, expand to per-occurrence entries keeping
 * every other occurrence blanked.
 */
export function removeOccurrence(
  keywords: KwEntry[],
  text: string,
  occ: number,
  content: string,
): KwEntry[] {
  const entries = normKeywordEntries(keywords)
  const exactIdx = entries.findIndex((e) => kwText(e) === text && kwOcc(e) === occ)
  if (exactIdx >= 0) return entries.filter((_, i) => i !== exactIdx)
  const allIdx = entries.findIndex((e) => kwText(e) === text && kwOcc(e) === -1)
  if (allIdx < 0) return entries
  const next = entries.filter((_, i) => i !== allIdx)
  const total = countTextOccurrences(content, text)
  const seen = new Set(next.filter((e) => kwText(e) === text).map((e) => kwOcc(e)))
  for (let o = 0; o < total; o++) {
    if (o !== occ && !seen.has(o)) next.push({ t: text, occ: o })
  }
  return next
}

/** Remove every entry of `text` (取消全部同名挖空). */
export function removeAllText(keywords: KwEntry[], text: string): KwEntry[] {
  return normKeywordEntries(keywords).filter((e) => kwText(e) !== text)
}

/** Count occurrences of `text` within `content` (fast scan). */
export function countTextOccurrences(content: string, text: string): number {
  if (!content || !text) return 0
  let n = 0
  let idx = content.indexOf(text)
  while (idx >= 0) {
    n += 1
    idx = content.indexOf(text, idx + 1)
  }
  return n
}

/** Plain string[] of all keyword texts (for prompts / counts / legacy APIs). */
export function keywordTexts(keywords: KwEntry[]): string[] {
  return Array.from(new Set(normKeywordEntries(keywords).map(kwText)))
}

// Rule-based cloze — 挖空单位是「字」：every Nth CJK character (or latin word)
// is picked. Returns occurrence-scoped entries so only the picked positions
// are blanked (no more "same char blanks everywhere" side effects).
export function ruleCloze(content: string, step: number): KwEntry[] {
  if (step < 2) return []
  const charPattern = new RegExp(`[${CJK}]|[a-zA-Z0-9]+`, 'g')
  const entries: KwEntry[] = []
  const counters = new Map<string, number>()
  const seen = new Set<string>()
  let i = 0
  let m: RegExpExecArray | null
  while ((m = charPattern.exec(content)) !== null) {
    i += 1
    if ((i % step) !== 0) continue
    const token = m[0]
    const occ = counters.get(token) ?? 0
    counters.set(token, occ + 1)
    const key = `${token}\u0000${occ}`
    if (!seen.has(key)) {
      seen.add(key)
      entries.push({ t: token, occ })
    }
  }
  return entries
}

// Split text into 字级 tokens: each CJK character is its own token, latin
// sequences stay whole words. Used by 挖空刷 / 手动挖空 / selection.
export function splitCharTokens(text: string): { text: string; isChar: boolean }[] {
  const SPLIT = new RegExp(`([${CJK}]|[a-zA-Z0-9]+)`, 'g')
  const FULL = new RegExp(`^([${CJK}]|[a-zA-Z0-9]+)$`)
  return text
    .split(SPLIT)
    .filter((p) => p !== '' && p !== undefined)
    .map((p) => ({ text: p, isChar: FULL.test(p) }))
}

export function splitParagraphs(content: string): string[] {
  return content.split(/\r?\n/).map((p) => p).filter((p) => p.trim().length > 0)
}

/** Split into paragraphs KEEPING each paragraph's absolute start offset. */
export function splitParagraphSpans(
  content: string,
): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = []
  const re = /[^\r\n]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    if (m[0].trim().length > 0) out.push({ text: m[0], start: m.index })
  }
  return out
}

// Levenshtein edit distance.
export function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (!m) return n
  if (!n) return m
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0)
  )
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp[m][n]
}

// Remove whitespace + punctuation for fair comparison.
export function normalize(s: string): string {
  return (s || '').replace(/[\s\p{P}]/gu, '')
}

// 0..1 similarity ratio between two strings.
export function similarity(a: string, b: string): number {
  const na = normalize(a)
  const nb = normalize(b)
  if (!na && !nb) return 1
  if (!na || !nb) return 0
  const dist = levenshtein(na, nb)
  return Math.max(0, 1 - dist / Math.max(na.length, nb.length))
}
