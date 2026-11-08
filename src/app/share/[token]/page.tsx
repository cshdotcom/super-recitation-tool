'use client'

// Standalone share page: /share/[token]. Renders the shared card if the link
// is valid & unexpired, with a friendly error screen otherwise.
import * as React from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'

import { SharedCardView } from '@/components/recitation/shared-card-view'

export default function SharePage() {
  const params = useParams<{ token: string }>()
  const router = useRouter()
  const token = typeof params?.token === 'string' ? params.token : ''

  const handleExit = React.useCallback(() => {
    router.replace('/')
  }, [router])

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <SharedCardView token={token} onExit={handleExit} />
    </div>
  )
}
