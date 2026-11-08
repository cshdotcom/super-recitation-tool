// Client-safe cloze / text helpers. No z-ai imports here so this file can be
// imported by both server and client code.

export interface Segment {
  text: string
  isBlank: boolean
}

const CJK = '\\u4e00-\\u9fff\\u3400-\\u4dbf'

export function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Split `content` into segments. Segments whose text exactly matches one of
// `keywords` are marked as blanks (挖空). Longer keywords are matched first
// so that e.g. "挑山工" wins over "挑山".
export function tokenize(content: string, keywords: string[]): Segment[] {
  const kws = keywords.map((k) => k.trim()).filter(Boolean)
  if (kws.length === 0) return [{ text: content, isBlank: false }]
  const sorted = [...new Set(kws)].sort((a, b) => b.length - a.length)
  const pattern = new RegExp(`(${sorted.map(escapeReg).join('|')})`, 'g')
  const parts = content.split(pattern)
  const kwset = new Set(kws)
  return parts
    .filter((p) => p !== undefined && p !== '')
    .map((p) => ({ text: p, isBlank: kwset.has(p) }))
}

// Rule-based cloze — 挖空单位是「字」：every Nth CJK character (or latin word)
// is picked as a keyword. Punctuation/whitespace is skipped when counting.
export function ruleCloze(content: string, step: number): string[] {
  if (step < 2) return []
  const charPattern = new RegExp(`[${CJK}]|[a-zA-Z0-9]+`, 'g')
  const tokens = content.match(charPattern) || []
  const kws: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    if ((i + 1) % step === 0) {
      // A latin token stays whole; a CJK match is a single char already.
      kws.push(tokens[i])
    }
  }
  return Array.from(new Set(kws))
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
