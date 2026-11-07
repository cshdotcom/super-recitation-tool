import type { CardData, CardPlan, DoodleStroke, DoodleTool, Point, Stroke } from './types'

const TOOLS: readonly DoodleTool[] = ['pen', 'pencil', 'marker', 'brush', 'eraser']

function isPoint(p: unknown): p is Point {
  return (
    Array.isArray(p) &&
    p.length === 2 &&
    typeof p[0] === 'number' &&
    typeof p[1] === 'number'
  )
}

// Lenient check used when reading strokes back from the DB: legacy point
// arrays are passed through as-is, and DoodleStroke objects must at least
// have pts/color/width/tool of the right types.
export function isValidStroke(s: unknown): s is Stroke {
  if (Array.isArray(s)) return s.every(isPoint)
  if (s && typeof s === 'object') {
    const d = s as Partial<DoodleStroke>
    return (
      Array.isArray(d.pts) &&
      d.pts.every(isPoint) &&
      typeof d.color === 'string' &&
      typeof d.width === 'number' &&
      typeof d.tool === 'string'
    )
  }
  return false
}

// Stricter normalization for incoming PATCH payloads: DoodleStroke objects
// get their width clamped to 1..60 and their tool whitelisted.
export function normalizeStrokeInput(s: unknown): Stroke | null {
  if (Array.isArray(s)) {
    return s.every(isPoint) ? (s as Point[]) : null
  }
  if (s && typeof s === 'object') {
    const d = s as Partial<DoodleStroke>
    if (!Array.isArray(d.pts) || !d.pts.every(isPoint)) return null
    if (typeof d.color !== 'string') return null
    if (typeof d.width !== 'number' || !Number.isFinite(d.width)) return null
    if (typeof d.tool !== 'string' || !TOOLS.includes(d.tool as DoodleTool)) return null
    const stroke: DoodleStroke = {
      pts: d.pts,
      color: d.color,
      width: Math.min(60, Math.max(1, d.width)),
      tool: d.tool as DoodleTool,
    }
    return stroke
  }
  return null
}

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
      strokes = parsed.filter(isValidStroke)
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
