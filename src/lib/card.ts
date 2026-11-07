// Server-side card serializer: converts a Prisma Card row into the JSON shape
// the frontend expects (keywords string -> string[], Date -> ISO string).
import type { CardData } from './types'

type CardRow = {
  id: string
  title: string
  content: string
  keywords: string
  createdAt: Date
  updatedAt: Date
}

export function serializeCard(c: CardRow): CardData {
  let keywords: string[] = []
  try {
    keywords = JSON.parse(c.keywords || '[]')
  } catch {
    keywords = []
  }
  return {
    id: c.id,
    title: c.title,
    content: c.content,
    keywords,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }
}
