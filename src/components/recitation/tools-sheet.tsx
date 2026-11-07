'use client'

import * as React from 'react'
import {
  Volume2,
  Mic,
  FileQuestion,
  GraduationCap,
  MessageCircleQuestion,
  Network,
  ArrowLeft,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import type { CardData, SettingsData } from '@/lib/types'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { TtsPlayer } from './tts-player'
import { AsrRecorder } from './asr-recorder'
import { QuizPanel } from './quiz-panel'
import { ChatTool } from './chat-tool'
import { MindmapView } from './mindmap-view'

interface ToolsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tool: string | null
  onToolChange: (tool: string | null) => void
  card: CardData | null
  settings: SettingsData | null
}

const TOOLS = [
  { key: 'tts', label: '朗读文本', icon: Volume2, desc: 'AI 朗读全文' },
  { key: 'asr', label: '录音背书', icon: Mic, desc: '语音识别打分' },
  { key: 'quiz', label: 'AI出题', icon: FileQuestion, desc: '智能生成练习' },
  { key: 'supervise', label: 'AI督背', icon: GraduationCap, desc: '引导背诵' },
  { key: 'ask', label: 'AI问问', icon: MessageCircleQuestion, desc: '对课文提问' },
  { key: 'mindmap', label: '思维导图', icon: Network, desc: '结构化整理' },
] as const

export function ToolsSheet({
  open,
  onOpenChange,
  tool,
  onToolChange,
  card,
  settings,
}: ToolsSheetProps) {
  const activeTool = TOOLS.find((t) => t.key === tool) ?? null

  const enabledTools = React.useMemo(() => {
    if (!settings) return TOOLS
    return TOOLS.filter((t) => settings.tools[t.key as keyof SettingsData['tools']])
  }, [settings])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={cn(
          'flex w-full flex-col gap-0 p-0',
          tool ? 'sm:max-w-lg' : 'sm:max-w-md',
        )}
      >
        <SheetHeader className="border-b p-4">
          <div className="flex items-center gap-2">
            {activeTool && (
              <button
                type="button"
                onClick={() => onToolChange(null)}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent"
                aria-label="返回工具列表"
              >
                <ArrowLeft className="size-4" /> 返回
              </button>
            )}
            <SheetTitle className="text-base">
              {activeTool ? activeTool.label : '背书工具'}
            </SheetTitle>
          </div>
          {!activeTool && (
            <SheetDescription>
              选择一个工具开始背诵练习（受设置开关控制）
            </SheetDescription>
          )}
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-4">
          {!card ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
              <FileQuestion className="size-8 text-muted-foreground/40" />
              请先选择或创建一张背书卡
            </div>
          ) : !activeTool ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {enabledTools.map((t) => {
                const Icon = t.icon
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => onToolChange(t.key)}
                    className="flex flex-col items-center gap-2 rounded-xl border p-4 text-center transition-colors hover:bg-accent"
                  >
                    <span className="flex size-10 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
                      <Icon className="size-5" />
                    </span>
                    <span className="text-sm font-medium">{t.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {t.desc}
                    </span>
                  </button>
                )
              })}
              {enabledTools.length === 0 && (
                <div className="col-span-full py-10 text-center text-sm text-muted-foreground">
                  所有工具已关闭，请到设置中开启
                </div>
              )}
            </div>
          ) : activeTool.key === 'tts' ? (
            <TtsPlayer text={card.content} />
          ) : activeTool.key === 'asr' ? (
            <AsrRecorder
              originalText={card.content}
              keywords={card.keywords}
            />
          ) : activeTool.key === 'quiz' ? (
            <QuizPanel content={card.content} keywords={card.keywords} />
          ) : activeTool.key === 'supervise' ? (
            <ChatTool mode="supervise" content={card.content} />
          ) : activeTool.key === 'ask' ? (
            <ChatTool mode="ask" content={card.content} />
          ) : activeTool.key === 'mindmap' ? (
            <MindmapView content={card.content} />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
