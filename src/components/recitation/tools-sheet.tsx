'use client'

import * as React from 'react'
import {
  FerrisWheel,
  FileQuestion,
  GraduationCap,
  Headphones,
  MessageCircleQuestion,
  Mic,
  Network,
  PenLine,
  Volume2,
} from 'lucide-react'

import type { CardData, SettingsData, ToolToggles } from '@/lib/types'
import { cn } from '@/lib/utils'
import { BottomSheet } from '@/components/recitation/bottom-sheet'
import { ToolTogglesSheet } from '@/components/recitation/tool-toggles-sheet'
import { TtsPlayer } from '@/components/recitation/tts-player'
import { AsrRecorder } from '@/components/recitation/asr-recorder'
import { QuizPanel } from '@/components/recitation/quiz-panel'
import { ChatTool } from '@/components/recitation/chat-tool'
import { MindmapView } from '@/components/recitation/mindmap-view'
import { EarbackPanel } from '@/components/recitation/panel-earback'
import { CopywritePanel } from '@/components/recitation/panel-copywrite'
import { WheelPanel } from '@/components/recitation/panel-wheel'

export type ToolKey = keyof Omit<ToolToggles, 'aiChunk' | 'aiCloze' | 'doodle' | 'brush' | 'manualCloze' | 'ruleCloze'>

interface ToolsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Active tool; null shows the grid. */
  tool: string | null
  onToolChange: (tool: string | null) => void
  card: CardData | null
  settings: SettingsData
  onChangeSettings: (patch: Partial<SettingsData>) => void
}

const TOOLS: {
  key: ToolKey
  label: string
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
}[] = [
  { key: 'tts', label: '朗读文本', icon: Volume2 },
  { key: 'quiz', label: 'AI出题', icon: FileQuestion },
  { key: 'supervise', label: 'AI督背', icon: GraduationCap },
  { key: 'asr', label: '录音背书', icon: Mic },
  { key: 'mindmap', label: '思维导图', icon: Network },
  { key: 'ask', label: 'AI问问', icon: MessageCircleQuestion },
  { key: 'earback', label: '耳返背书', icon: Headphones },
  { key: 'copywrite', label: '摹写', icon: PenLine },
  { key: 'wheel', label: '轮盘抽背', icon: FerrisWheel },
]

const TOOL_TITLES: Record<string, string> = {
  tts: '朗读文本',
  quiz: 'AI出题',
  supervise: 'AI督背',
  asr: '录音背书',
  mindmap: '思维导图',
  ask: 'AI问问',
  earback: '耳返背书',
  copywrite: '摹写',
  wheel: '轮盘抽背',
}

export function ToolsSheet({
  open,
  onOpenChange,
  tool,
  onToolChange,
  card,
  settings,
  onChangeSettings,
}: ToolsSheetProps) {
  const [togglesOpen, setTogglesOpen] = React.useState(false)

  const enabledTools = TOOLS.filter((t) => settings.tools[t.key])
  const content = card?.content ?? ''

  const renderPanel = () => {
    if (!card) {
      return (
        <div className="py-16 text-center text-sm text-muted-foreground">
          请先选择一张有内容的背书卡
        </div>
      )
    }
    switch (tool) {
      case 'tts':
        return <TtsPlayer text={content} settings={settings} />
      case 'asr':
        return (
          <AsrRecorder
            originalText={content}
            keywords={card.keywords}
            settings={settings}
          />
        )
      case 'quiz':
        return <QuizPanel content={content} keywords={card.keywords} />
      case 'supervise':
        return <ChatTool mode="supervise" content={content} />
      case 'ask':
        return <ChatTool mode="ask" content={content} allowImages />
      case 'mindmap':
        return (
          <MindmapView
            key={card.id}
            content={content}
            cardId={card.id}
            cardTitle={card.title}
            initialDocs={card.mindmaps ?? []}
          />
        )
      case 'earback':
        return <EarbackPanel content={content} />
      case 'copywrite':
        return <CopywritePanel content={content} />
      case 'wheel':
        return <WheelPanel content={content} />
      default:
        return null
    }
  }

  return (
    <>
      {/* Grid sheet (Screenshot C) */}
      <BottomSheet
        open={open && tool === null}
        onOpenChange={onOpenChange}
        title="背书工具"
        showClose={false}
        rightAction={
          <button
            type="button"
            onClick={() => setTogglesOpen(true)}
            className="rounded-full px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            自定义编辑
          </button>
        }
      >
        <div className="mt-5 grid grid-cols-4 gap-3 overflow-y-auto pb-4">
          {enabledTools.map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => onToolChange(t.key)}
                className="flex flex-col items-center gap-1.5"
              >
                <span
                  className={cn(
                    'flex size-[72px] w-full items-center justify-center rounded-2xl border border-border bg-card shadow-sm transition-all',
                    'hover:-translate-y-0.5 hover:shadow-md',
                  )}
                >
                  <Icon className="size-7 text-foreground/80" strokeWidth={1.5} />
                </span>
                <span className="text-xs text-muted-foreground">{t.label}</span>
              </button>
            )
          })}
          {enabledTools.length === 0 && (
            <div className="col-span-4 py-10 text-center text-sm text-muted-foreground">
              所有背书工具均已关闭，可在「自定义编辑」中开启
            </div>
          )}
        </div>
      </BottomSheet>

      {/* Active tool panel sheet */}
      <BottomSheet
        open={open && tool !== null}
        onOpenChange={(o) => {
          if (!o) {
            onToolChange(null)
            onOpenChange(false)
          }
        }}
        title={tool ? TOOL_TITLES[tool] ?? '背书工具' : '背书工具'}
        rightAction={
          <button
            type="button"
            onClick={() => onToolChange(null)}
            className="rounded-full px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            返回
          </button>
        }
      >
        <div className="mt-4 overflow-y-auto pb-6">{renderPanel()}</div>
      </BottomSheet>

      <ToolTogglesSheet
        open={togglesOpen}
        onOpenChange={setTogglesOpen}
        settings={settings}
        onChangeSettings={onChangeSettings}
      />
    </>
  )
}
