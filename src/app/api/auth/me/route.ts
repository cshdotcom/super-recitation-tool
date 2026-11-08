// GET /api/auth/me -> { registered: boolean, account: {id,username,avatar} | null }
// Never 401 — lets the client decide between register and login.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'

export async function GET() {
  try {
    const [account, count] = await Promise.all([
      getSessionUser(),
      db.account.count(),
    ])
    return NextResponse.json({ registered: count > 0, account })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[GET /api/auth/me] failed:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
