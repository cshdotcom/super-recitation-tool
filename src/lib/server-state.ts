'use client'

// 服务端 KV 状态（/api/state）客户端助手 —— 所有用户数据统一存服务端
// （答题草稿、作答记录、每日背诵计划进度、眼睛按钮位置、涂鸦调色板、
//  TTS 音色记忆等）。localStorage 仅作离线镜像/兜底，服务端永远是真源。
export async function getState(
  keys: string[],
): Promise<Record<string, string | null>> {
  if (keys.length === 0) return {}
  try {
    const qs = keys.map((k) => `key=${encodeURIComponent(k)}`).join('&')
    const res = await fetch(`/api/state?${qs}`)
    if (!res.ok) return {}
    const data = (await res.json()) as { values?: Record<string, string | null> }
    return data.values ?? {}
  } catch {
    return {}
  }
}

export async function getStatePrefix(prefix: string): Promise<Record<string, string>> {
  try {
    const res = await fetch(`/api/state?prefix=${encodeURIComponent(prefix)}`)
    if (!res.ok) return {}
    const data = (await res.json()) as { values?: Record<string, string | null> }
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(data.values ?? {})) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export async function putState(key: string, value: string): Promise<boolean> {
  try {
    const res = await fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function putStateEntries(
  entries: { key: string; value: string }[],
): Promise<boolean> {
  if (entries.length === 0) return true
  try {
    const res = await fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function deleteState(key: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/state?key=${encodeURIComponent(key)}`, {
      method: 'DELETE',
    })
    return res.ok
  } catch {
    return false
  }
}

export async function deleteStatePrefix(prefix: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/state?prefix=${encodeURIComponent(prefix)}`, {
      method: 'DELETE',
    })
    return res.ok
  } catch {
    return false
  }
}
