'use client'

// Standalone paper-share page: /s/[token]. 试卷分享链接统一指向此路由，与
// /share/[token]（卡片/对话分享）同构。SharedPaperView 自检测分享类型：试卷
// 分享直接渲染；卡片/对话分享链接误入时委托既有 SharedConversationView 兼容
// 渲染；无效 / 过期 token 显示友好空态。
import * as React from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'

import { SharedPaperView } from '@/components/recitation/shared-paper-view'

export default function PaperSharePage() {
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
      {/* 自动分流：试卷分享 → 试卷视图；卡片/对话分享 → 委托既有公开视图 */}
      <SharedPaperView token={token} onExit={handleExit} />
    </div>
  )
}
