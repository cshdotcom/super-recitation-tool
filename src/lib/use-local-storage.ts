'use client'

import * as React from 'react'

import { useServerState } from '@/lib/use-server-state'

// useLocalStorage — 兼容旧名的持久化状态 hook。
// 「没有任何数据在本地，全部实时同步服务端」：内部直接委托 useServerState ——
// 服务端为真源（/api/state AppState 表），localStorage 仅作离线镜像/首屏防闪烁。
// 所有历史调用点（reader-view 计划进度、tts-player 难句收藏/注音、各折叠态等）
// 无需改动即自动升级为服务端实时同步。
export function useLocalStorage<T>(
  key: string,
  initial: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  return useServerState<T>(key, initial)
}

// Today's key for the daily plan progress: plan-{cardId}-{yyyymmdd}
export function todayKey(cardId: string, prefix = 'plan'): string {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return `${prefix}-${cardId}-${ymd}`
}
