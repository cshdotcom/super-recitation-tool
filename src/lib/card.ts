import type { CardData, CardPlan, Stroke } from './types'

export function serializeCard(c: {
  id: string
  title: string
  content: string
  keywords: string
  strokes: string
  plan: string
  createdAt: Date
  updatedAt: Date
}): CardData {
  let keywords: string[] = []
  try {
    keywords = JSON.parse(c.keywords || '[]')
  } catch {}

  let strokes: Stroke[] = []
  try {
    const parsed = JSON.parse(c.strokes || '[]')
    if (Array.isArray(parsed)) {
      strokes = parsed.filter(
        (s): s is Stroke =>
          Array.isArray(s) && s.every((p) => Array.isArray(p) && p.length === 2),
      )
    }
  } catch {}

  let plan: CardPlan | null = null
  try {
    const parsed = JSON.parse(c.plan || 'null')
    if (parsed && typeof parsed === 'object' && typeof parsed.goal === 'number') {
      plan = { goal: parsed.goal }
    }
  } catch {}

  return {
    id: c.id,
    title: c.title,
    content: c.content,
    keywords,
    strokes,
    plan,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }
}
