'use client'

import * as React from 'react'

// Small localStorage-backed state hook (client-side only flags such as
// 显示快捷编辑栏 / 显示背书工具栏 / 今日计划进度).
export function useLocalStorage<T>(
  key: string,
  initial: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = React.useState<T>(initial)
  const hydratedRef = React.useRef(false)

  // Hydrate from localStorage after mount (avoids SSR mismatch).
  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key)
      if (raw !== null) setValue(JSON.parse(raw) as T)
    } catch {
      /* ignore corrupt entries */
    }
    hydratedRef.current = true
     
  }, [key])

  const set = React.useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved =
          typeof next === 'function' ? (next as (p: T) => T)(prev) : next
        try {
          window.localStorage.setItem(key, JSON.stringify(resolved))
        } catch {
          /* storage full / unavailable — state still updates */
        }
        return resolved
      })
    },
    [key],
  )

  return [value, set]
}

// Today's key for the daily plan progress: plan-{cardId}-{yyyymmdd}
export function todayKey(cardId: string, prefix = 'plan'): string {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return `${prefix}-${cardId}-${ymd}`
}
