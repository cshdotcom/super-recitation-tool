'use client'

// 部署版本徽标：拉取 /api/version 显示当前运行的版本与构建指纹。
// 用途：发布/更新生产站后，一眼确认部署是否真的生效（旧构建会显示旧版本号），
// 避免「代码已修但站点仍旧版」被误报为 bug 复现。
import * as React from 'react'
import { GitCommitHorizontal } from 'lucide-react'

interface VersionInfo {
  version: string
  buildId: string | null
  runtime: string
}

export function VersionBadge() {
  const [info, setInfo] = React.useState<VersionInfo | null>(null)

  React.useEffect(() => {
    let alive = true
    fetch('/api/version')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: VersionInfo | null) => {
        if (alive && d && typeof d.version === 'string') setInfo(d)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  if (!info) return null
  return (
    <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground/70">
      <GitCommitHorizontal className="size-3.5" strokeWidth={1.75} aria-hidden />
      <span className="font-medium">{info.version}</span>
      <span aria-hidden>·</span>
      <span>{info.runtime === 'production' ? '生产' : '开发'}模式</span>
      {info.buildId ? (
        <>
          <span aria-hidden>·</span>
          <span className="font-mono">#{info.buildId.slice(0, 8)}</span>
        </>
      ) : null}
    </p>
  )
}
