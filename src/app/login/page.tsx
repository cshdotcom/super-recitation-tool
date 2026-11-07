'use client'

// Standalone login / first-run registration page (independent route so the
// main app shell is never rendered under it).
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'

import { LoginView } from '@/components/recitation/login-view'
import type { AccountData } from '@/lib/types'

export default function LoginPage() {
  const router = useRouter()
  const [registered, setRegistered] = React.useState<boolean | null>(null)

  React.useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((res) => {
        if (res?.account) {
          // Already logged in -> straight to the app.
          router.replace('/')
          return
        }
        setRegistered(!!res?.registered)
      })
      .catch(() => setRegistered(false))
  }, [router])

  const handleAuthed = React.useCallback(
    (_acc: AccountData) => {
      router.replace('/')
    },
    [router]
  )

  if (registered === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <LoginView registered={registered} onAuthed={handleAuthed} />
    </div>
  )
}
