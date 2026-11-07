'use client'

import * as React from 'react'
import { ChevronLeft, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import type { QuizReportStats } from '@/lib/types'

interface QuizReportViewProps {
  onBack: () => void
}

function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

function formatDay(date: string): string {
  const [, m, d] = date.split('-')
  return `${Number(m)}月${Number(d)}日`
}

// 树懒睡觉简笔画：浅紫身体 + 黑描边 + zZZ
function SlothIllustration() {
  return (
    <svg
      viewBox="0 0 150 110"
      className="h-24 w-36 shrink-0"
      fill="none"
      aria-hidden
      role="img"
    >
      {/* 树枝 */}
      <path
        d="M6 74 Q 75 62 144 74"
        stroke="#171717"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path d="M26 70 l-7 -9 M120 69 l7 -9" stroke="#171717" strokeWidth="2" strokeLinecap="round" />
      {/* 身体（趴在树枝上） */}
      <ellipse cx="64" cy="56" rx="32" ry="20" fill="#c7c9f5" stroke="#171717" strokeWidth="2" />
      {/* 头 */}
      <circle cx="95" cy="52" r="16" fill="#c7c9f5" stroke="#171717" strokeWidth="2" />
      {/* 眼罩斑纹 */}
      <path
        d="M88 46 q6 -4 12 0 q-2 6 -6 6 q-4 0 -6 -6 Z"
        fill="#dcdcfb"
        stroke="#171717"
        strokeWidth="1.6"
      />
      {/* 闭眼 */}
      <path d="M90 50 q3 2.5 5.5 0" stroke="#171717" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M97 50 q3 2.5 5.5 0" stroke="#171717" strokeWidth="1.8" strokeLinecap="round" />
      {/* 微笑 + 鼻子 */}
      <path d="M97 57 q3 2.5 6 0" stroke="#171717" strokeWidth="1.6" strokeLinecap="round" />
      {/* 前爪搭在树枝上 */}
      <path
        d="M56 74 q-2 6 4 7 M64 75 q-1 6 5 6.5"
        stroke="#171717"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      {/* zZZ */}
      <text x="112" y="26" fontSize="14" fontWeight="700" fill="#171717">z</text>
      <text x="122" y="18" fontSize="17" fontWeight="700" fill="#171717">Z</text>
      <text x="133" y="10" fontSize="20" fontWeight="700" fill="#171717">Z</text>
    </svg>
  )
}

// 空状态简笔画：手指点手机 + "..." 气泡
function EmptyReportIllustration() {
  return (
    <svg viewBox="0 0 140 110" className="h-28 w-36" fill="none" aria-hidden role="img">
      {/* 气泡 */}
      <ellipse cx="88" cy="26" rx="24" ry="14" fill="#c7c9f5" stroke="#171717" strokeWidth="2" />
      <path d="M74 38 l-4 10 l12 -8" fill="#c7c9f5" stroke="#171717" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="80" cy="26" r="2.2" fill="#171717" />
      <circle cx="88" cy="26" r="2.2" fill="#171717" />
      <circle cx="96" cy="26" r="2.2" fill="#171717" />
      {/* 手机 */}
      <rect x="40" y="34" width="44" height="66" rx="9" fill="#c7c9f5" stroke="#171717" strokeWidth="2" />
      <rect x="47" y="46" width="30" height="40" rx="3" fill="#ffffff" stroke="#171717" strokeWidth="1.6" />
      <path d="M56 39 h12" stroke="#171717" strokeWidth="2" strokeLinecap="round" />
      {/* 手指点屏幕 */}
      <path
        d="M84 74 q10 -8 16 -2 q6 6 -2 14 q-8 8 -18 6 q-10 -2 -12 -12"
        fill="#c7c9f5"
        stroke="#171717"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M84 74 l-1 -12" stroke="#171717" strokeWidth="2" strokeLinecap="round" />
      {/* 放射线 */}
      <path d="M30 28 l-6 -6 M28 44 h-9 M132 44 h-9" stroke="#171717" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

// 答题报告：今日数据 + 近30天详情（全屏视图）
export function QuizReportView({ onBack }: QuizReportViewProps) {
  const [stats, setStats] = React.useState<QuizReportStats | null>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await fetch(
          `/api/quiz-items?report=1&tzOffset=${new Date().getTimezoneOffset()}`,
        )
        if (!res.ok) throw new Error('加载报告失败')
        const data = (await res.json()) as QuizReportStats
        if (alive) setStats(data)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '加载报告失败')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const activeDays = (stats?.days ?? []).filter((d) => d.answered > 0)
  const isEmpty = !loading && activeDays.length === 0

  return (
    <div className="min-h-dvh bg-muted/40">
      {/* 顶栏 */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="relative mx-auto flex h-14 max-w-2xl items-center px-4">
          <button
            type="button"
            aria-label="返回"
            onClick={onBack}
            className="shrink-0 rounded-full p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="size-6 text-foreground" strokeWidth={2} />
          </button>
          <h1 className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-lg font-bold">
            答题报告
          </h1>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 pb-16 pt-4">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-24 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            <span className="text-sm">加载中…</span>
          </div>
        ) : (
          <>
            {/* 大卡片：插画 + 今日数据 */}
            <section className="rounded-2xl bg-card p-5">
              <div className="flex items-center gap-3">
                <SlothIllustration />
                <div className="min-w-0 flex-1">
                  <h2 className="text-2xl font-bold">树懒附体！</h2>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                    暂停的这段时间，乌龟已绕地球爬了半圈🐢
                  </p>
                </div>
              </div>

              <div className="mt-4 border-t border-border pt-4">
                <p className="text-sm text-muted-foreground">今日数据：</p>
                <div className="mt-3 grid grid-cols-2">
                  <div className="flex flex-col items-center justify-center gap-1.5 border-r border-border">
                    <span className="text-4xl font-bold leading-none">
                      {stats?.todayAnswered ?? 0}
                    </span>
                    <span className="text-sm text-muted-foreground">练习题数</span>
                  </div>
                  <div className="flex flex-col items-center justify-center gap-1.5">
                    <span className="flex items-baseline gap-1">
                      <span className="text-4xl font-bold leading-none">
                        {formatClock(stats?.todaySeconds ?? 0)}
                      </span>
                      <span className="text-xs text-muted-foreground">秒</span>
                    </span>
                    <span className="text-sm text-muted-foreground">练习时长</span>
                  </div>
                </div>
              </div>
            </section>

            {/* 报告详情 */}
            <h2 className="mb-2 mt-6 text-xl font-bold">报告详情</h2>
            {isEmpty ? (
              <div className="flex flex-col items-center gap-4 rounded-2xl bg-card py-12">
                <EmptyReportIllustration />
                <p className="text-sm text-muted-foreground">
                  暂无报告产生，快去练习吧～
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border overflow-hidden rounded-2xl bg-card">
                {activeDays.map((d) => (
                  <div key={d.date} className="flex items-center justify-between px-4 py-3.5">
                    <span className="text-sm font-medium">{formatDay(d.date)}</span>
                    <span className="flex items-center gap-4 text-sm">
                      <span className="text-muted-foreground">
                        答题 <span className="font-bold text-foreground">{d.answered}</span>
                      </span>
                      <span className="text-muted-foreground">
                        答错 <span className="font-bold text-red-500">{d.wrong}</span>
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
