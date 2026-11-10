'use client'

// Standalone share page: /share/[token]. Renders the shared card OR shared AI
// conversation depending on the share kind (component self-detects), with a
// friendly error screen otherwise.
import * as React from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'

import { SharedConversationView } from '@/components/recitation/shared-conversation-view'

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
      {/* 自动分流：卡片分享 → 内部委托 SharedCardView；对话分享 → 对话视图 */}
      <SharedConversationView token={token} onExit={handleExit} />
    </div>
  )
}
