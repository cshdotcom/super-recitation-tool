// Client-safe sentence splitting used by 耳返背书 / 摹写 / 轮盘抽背 panels.

// Split content into sentences, keeping the trailing punctuation attached.
// Splits after 。！？；!?; and newlines.
export function splitSentences(content: string): string[] {
  if (!content.trim()) return []
  const raw = content.split(/(?<=[。！？；!?;])\s*|\r?\n/)
  const out: string[] = []
  let buf = ''
  for (const piece of raw) {
    if (!piece) continue
    buf += piece
    if (/[。！？；!?;]\s*$/.test(piece) || piece.trim().length >= 60) {
      const s = buf.trim()
      if (s) out.push(s)
      buf = ''
    } else {
      buf += ' '
    }
  }
  const tail = buf.trim()
  if (tail) out.push(tail)
  return out.length > 0 ? out : [content.trim()]
}
