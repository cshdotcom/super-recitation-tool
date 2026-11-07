'use client'

import * as React from 'react'

import { cn } from '@/lib/utils'
import type { ClozeStyle } from '@/lib/types'
import {
  splitParagraphs,
  tokenize,
  type Segment,
} from '@/lib/cloze'

interface ClozeRendererProps {
  content: string
  keywords: string[]
  style: ClozeStyle
  showAnswers: boolean
  manualMode: boolean
  revealed: Set<number>
  onToggleKeyword: (word: string) => void
  onReveal: (index: number) => void
}

// Manual mode: split a paragraph into "word" tokens and "sep" text runs.
const WORD_RE = /[\u4e00-\u9fff\u3400-\u4dbf]+|[A-Za-z0-9]+/g

interface ManualToken {
  type: 'word' | 'sep'
  text: string
}

function tokenizeManual(paragraph: string): ManualToken[] {
  const out: ManualToken[] = []
  let last = 0
  for (const match of paragraph.matchAll(WORD_RE)) {
    const idx = match.index ?? 0
    if (idx > last) {
      out.push({ type: 'sep', text: paragraph.slice(last, idx) })
    }
    out.push({ type: 'word', text: match[0] })
    last = idx + match[0].length
  }
  if (last < paragraph.length) {
    out.push({ type: 'sep', text: paragraph.slice(last) })
  }
  return out
}

function nbspFill(len: number): string {
  const n = Math.max(1, len)
  return Array.from({ length: n })
    .map(() => '\u00A0')
    .join('')
}

export function ClozeRenderer({
  content,
  keywords,
  style,
  showAnswers,
  manualMode,
  revealed,
  onToggleKeyword,
  onReveal,
}: ClozeRendererProps) {
  const paragraphs = React.useMemo(
    () => splitParagraphs(content),
    [content],
  )
  const kwSet = React.useMemo(() => new Set(keywords), [keywords])

  // Global running index for blanks across all paragraphs.
  // We compute it as a render-time value using a ref-like object so each
  // render produces the same deterministic sequence.
  const counter = { value: 0 }

  if (paragraphs.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        请先输入或导入要背诵的内容。
      </p>
    )
  }

  return (
    <div className="text-lg leading-loose">
      {paragraphs.map((para, pIdx) => {
        if (manualMode) {
          return (
            <p key={pIdx} className="mb-4 last:mb-0">
              {tokenizeManual(para).map((tok, tIdx) => {
                if (tok.type === 'sep') {
                  return (
                    <span key={`sep-${pIdx}-${tIdx}`}>{tok.text}</span>
                  )
                }
                const isBlank = kwSet.has(tok.text)
                if (isBlank) {
                  // keyword — render as blank; click to REMOVE
                  if (style === 'highlight') {
                    return (
                      <span
                        key={`w-${pIdx}-${tIdx}`}
                        role="button"
                        tabIndex={0}
                        title="点击取消挖空"
                        onClick={() => onToggleKeyword(tok.text)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            onToggleKeyword(tok.text)
                          }
                        }}
                        className={cn(
                          'cursor-pointer rounded-full px-2 transition-colors select-none',
                          showAnswers
                            ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/30'
                            : 'bg-emerald-500/15 hover:bg-emerald-500/25',
                        )}
                      >
                        <span className={showAnswers ? '' : 'text-transparent'}>
                          {tok.text}
                        </span>
                      </span>
                    )
                  }
                  // underline
                  return (
                    <span
                      key={`w-${pIdx}-${tIdx}`}
                      role="button"
                      tabIndex={0}
                      title="点击取消挖空"
                      onClick={() => onToggleKeyword(tok.text)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onToggleKeyword(tok.text)
                        }
                      }}
                      className={cn(
                        'cursor-pointer border-b-2 border-dashed border-foreground/40 px-0.5 transition-colors hover:border-emerald-500',
                        showAnswers &&
                          'bg-amber-200/60 dark:bg-amber-500/25 rounded',
                      )}
                    >
                      {showAnswers ? tok.text : nbspFill(tok.text.length)}
                    </span>
                  )
                }
                // plain clickable word — click to ADD as keyword
                return (
                  <span
                    key={`w-${pIdx}-${tIdx}`}
                    role="button"
                    tabIndex={0}
                    title="点击挖空该词"
                    onClick={() => onToggleKeyword(tok.text)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onToggleKeyword(tok.text)
                      }
                    }}
                    className="cursor-pointer rounded px-0.5 transition-colors hover:bg-accent hover:underline"
                  >
                    {tok.text}
                  </span>
                )
              })}
            </p>
          )
        }

        // Non-manual mode: tokenize with keyword awareness
        const segments: Segment[] = tokenize(para, keywords)
        return (
          <p key={pIdx} className="mb-4 last:mb-0">
            {segments.map((seg, sIdx) => {
              if (!seg.isBlank) {
                return <span key={`s-${pIdx}-${sIdx}`}>{seg.text}</span>
              }
              const idx = counter.value++
              const isRevealed = showAnswers || revealed.has(idx)
              if (style === 'highlight') {
                return (
                  <span
                    key={`b-${pIdx}-${sIdx}`}
                    role="button"
                    tabIndex={0}
                    title={isRevealed ? '已揭示' : '点击揭示答案'}
                    onClick={() => !isRevealed && onReveal(idx)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        if (!isRevealed) onReveal(idx)
                      }
                    }}
                    className={cn(
                      'cursor-pointer rounded-full px-2 transition-colors select-none',
                      isRevealed
                        ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/25'
                        : 'bg-emerald-500/15 hover:bg-emerald-500/25',
                    )}
                  >
                    <span className={isRevealed ? '' : 'text-transparent'}>
                      {seg.text}
                    </span>
                  </span>
                )
              }
              // underline
              return (
                <span
                  key={`b-${pIdx}-${sIdx}`}
                  role="button"
                  tabIndex={0}
                  title={isRevealed ? '已揭示' : '点击揭示答案'}
                  onClick={() => !isRevealed && onReveal(idx)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      if (!isRevealed) onReveal(idx)
                    }
                  }}
                  className={cn(
                    'cursor-pointer border-b-2 border-dashed px-0.5 transition-colors',
                    isRevealed
                      ? 'border-transparent bg-amber-200/60 dark:bg-amber-500/25 rounded'
                      : 'border-foreground/40 hover:border-emerald-500',
                  )}
                >
                  {isRevealed ? seg.text : nbspFill(seg.text.length)}
                </span>
              )
            })}
          </p>
        )
      })}
    </div>
  )
}
