'use client'

// useServerState — 「服务端为真源」的持久化状态 hook。
// • 读取：先从 localStorage 即时水合（避免闪烁），随后拉取 /api/state
//   覆盖为服务端值（服务端优先；服务端无值时自动把本地旧值迁移上去）。
// • 写入：立即更新组件状态 + 写 localStorage 离线镜像 + 防抖 500ms PUT
//   服务端。拖动等高频写入不会打爆接口。
// • 若在服务端值返回前用户已本地修改（dirtyRef），放弃服务端覆盖，以
//   用户本次操作为准。
import * as React from 'react'
import { getState, putState } from '@/lib/server-state'

const SERVER_WRITE_DEBOUNCE = 500

export function useServerState<T>(
  key: string,
  initial: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = React.useState<T>(initial)
  const dirtyRef = React.useRef(false)
  const latestRef = React.useRef<T>(initial)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 按挂载代际丢弃过期请求（key 变化 / 卸载后）。 */
  const genRef = React.useRef(0)

  // 挂载 / key 变化：本地水合 → 服务端同步
  React.useEffect(() => {
    const gen = ++genRef.current
    dirtyRef.current = false
    let alive = true

    let localRaw: string | null = null
    try {
      localRaw = window.localStorage.getItem(key)
      if (localRaw !== null) setValue(JSON.parse(localRaw) as T)
    } catch {
      /* ignore corrupt entries */
    }

    void (async () => {
      const values = await getState([key])
      if (!alive || gen !== genRef.current) return
      const raw = values[key]
      if (typeof raw === 'string' && raw !== null) {
        // 服务端有值 → 服务端优先（除非用户已先行修改）
        if (dirtyRef.current) return
        try {
          setValue(JSON.parse(raw) as T)
        } catch {
          /* ignore corrupt server value */
        }
      } else if (localRaw !== null) {
        // 服务端无值但本地有 → 迁移上传
        void putState(key, localRaw)
      }
    })()

    return () => {
      alive = false
    }
  }, [key])

  const flushServer = React.useCallback(
    (serialized: string) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        void putState(key, serialized)
      }, SERVER_WRITE_DEBOUNCE)
    },
    [key],
  )

  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const set = React.useCallback(
    (next: T | ((prev: T) => T)) => {
      dirtyRef.current = true
      setValue((prev) => {
        const resolved =
          typeof next === 'function' ? (next as (p: T) => T)(prev) : next
        latestRef.current = resolved
        try {
          const serialized = JSON.stringify(resolved)
          window.localStorage.setItem(key, serialized)
          flushServer(serialized)
        } catch {
          /* storage full / unavailable — state still updates */
        }
        return resolved
      })
    },
    [key, flushServer],
  )

  return [value, set]
}
