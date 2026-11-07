'use client'

// Client-safe helpers for per-context voice preferences (音色/倍速默认).
// Prefs are persisted server-side via PATCH /api/settings; the server
// shallow-merges the submitted context keys into the stored voicePrefs map.
import * as React from 'react'
import { toast } from 'sonner'

import type { SettingsData, VoicePref } from '@/lib/types'

/** Playable speed options (browser utterance rate supports up to 3; the
 * server clamps >2 back to 2 for cloud synthesis). */
export const SPEED_OPTIONS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0]

/** Read the saved voice pref for one feature context (undefined = follow global). */
export function getVoicePref(
  settings: SettingsData | null,
  ctx: string,
): VoicePref | undefined {
  return settings?.voicePrefs?.[ctx]
}

/**
 * Persist one context's voice pref.
 * PATCH body: { voicePrefs: { [ctx]: pref } } — the server shallow-merges
 * the context key, other contexts are preserved.
 * Resolves true when saved successfully (toasts are shown here).
 */
export async function saveVoicePref(ctx: string, pref: VoicePref): Promise<boolean> {
  try {
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voicePrefs: { [ctx]: pref } }),
    })
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(err.error || '保存失败')
    }
    toast.success('已保存为该功能默认音色')
    return true
  } catch (err) {
    toast.error('保存默认音色失败：' + (err instanceof Error ? err.message : '未知错误'))
    return false
  }
}

/** Clamp a speed value into the supported 0.5–3 range. */
export function clampSpeed(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 1
  return Math.min(3, Math.max(0.5, n))
}

/**
 * Fetch the app settings once on mount (used by tool panels that don't
 * receive settings via props but still need per-context voice defaults).
 */
export function useSettingsLite(): SettingsData | null {
  const [settings, setSettings] = React.useState<SettingsData | null>(null)
  React.useEffect(() => {
    let alive = true
    fetch('/api/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((s: SettingsData | null) => {
        if (alive && s) setSettings(s)
      })
      .catch(() => {
        /* settings stay null — callers fall back to provider defaults */
      })
    return () => {
      alive = false
    }
  }, [])
  return settings
}
