'use client'

// 复习算法可视化调参面板（v2.8.0+）
// 支持全局默认 / 单卡覆盖两种作用域；算法多选 + 预设模板一键切换 + 滑块输入 +
// FSRS w 数组表 + 自定义公式编辑器（带安全求值测试）+ 实时 R 衰减曲线与 4 档预览。
import * as React from 'react'
import { toast } from 'sonner'
import { Brain, Save, Plus, RotateCcw, Sparkles, FlaskConical } from 'lucide-react'

import {
  type AlgorithmConfig,
  type AlgorithmType,
  type AlgorithmTemplateData,
  type CardPreview,
  ALGORITHM_TYPES,
  GRADES,
  defaultConfig,
  isValidAlgType,
  mergeConfig,
  safeEval,
} from '@/lib/spaced-repetition'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

export interface AlgorithmConfigDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 作用域：global=全局默认 card=单卡覆盖 */
  scope: 'global' | 'card'
  cardId?: string
  cardTitle?: string
  onSaved?: () => void
}

export function AlgorithmConfigDialog({
  open,
  onOpenChange,
  scope,
  cardId,
  cardTitle,
  onSaved,
}: AlgorithmConfigDialogProps) {
  const [enabled, setEnabled] = React.useState<AlgorithmType[]>(['fsrs'])
  const [algorithm, setAlgorithm] = React.useState<AlgorithmType>('fsrs')
  const [config, setConfig] = React.useState<AlgorithmConfig>(defaultConfig())
  const [templates, setTemplates] = React.useState<AlgorithmTemplateData[]>([])
  const [followGlobal, setFollowGlobal] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [preview, setPreview] = React.useState<CardPreview | null>(null)
  const [tab, setTab] = React.useState('basic')

  // 加载配置 + 模板
  React.useEffect(() => {
    if (!open) return
    let alive = true
    void (async () => {
      try {
        const cfgUrl = scope === 'card' && cardId ? `/api/algorithms/config?cardId=${cardId}` : '/api/algorithms/config'
        const [cfgRes, tplRes] = await Promise.all([
          fetch(cfgUrl).then((r) => r.json()),
          fetch('/api/algorithms/templates').then((r) => r.json()),
        ])
        if (!alive) return
        const g = cfgRes.global
        const resolved = cfgRes.resolved
        const cardCfg = cfgRes.card
        setEnabled(g?.enabled?.length ? g.enabled.filter(isValidAlgType) : ['fsrs'])
        setAlgorithm(resolved?.algorithm ?? 'fsrs')
        setConfig(mergeConfig(resolved?.config ?? g?.config))
        setFollowGlobal(scope === 'card' && !cardCfg?.algorithm)
        setTemplates(tplRes.templates ?? [])
      } catch (e) {
        toast.error('加载算法配置失败')
      }
    })()
    return () => {
      alive = false
    }
  }, [open, scope, cardId])

  // 实时预览（防抖）
  React.useEffect(() => {
    if (!open || tab !== 'preview') return
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/algorithms/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            memory: { s: 3, d: 5, reps: 2, lapses: 0, state: 'review', lastGrade: 'good', lastReviewAt: new Date(Date.now() - 86400000 * 3).toISOString(), step: 0, history: [] },
            config,
            algorithm,
            tzOffset: new Date().getTimezoneOffset(),
          }),
        })
        const data = await res.json()
        setPreview(data.preview ?? null)
      } catch {
        /* ignore */
      }
    }, 300)
    return () => clearTimeout(t)
  }, [open, tab, config, algorithm])

  const update = <K extends keyof AlgorithmConfig>(k: K, v: AlgorithmConfig[K]) =>
    setConfig((c) => ({ ...c, [k]: v }))

  const applyTemplate = (t: AlgorithmTemplateData) => {
    setAlgorithm(t.type)
    setConfig(mergeConfig(t.config))
    toast.success(`已套用模板「${t.name}」`)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const body =
        scope === 'global'
          ? { scope: 'global', algorithm, config, enabled }
          : { scope: 'card', cardId, algorithm: followGlobal ? null : algorithm, config: followGlobal ? {} : config, enabled: followGlobal ? [] : enabled }
      const res = await fetch('/api/algorithms/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error('保存失败')
      toast.success(scope === 'global' ? '全局默认算法已保存' : '本书算法已保存')
      onSaved?.()
      onOpenChange(false)
    } catch (e) {
      toast.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleSaveAsTemplate = async () => {
    const name = window.prompt('模板名称', `${ALGORITHM_TYPES.find((a) => a.value === algorithm)?.label} 自定义`)
    if (!name) return
    try {
      const res = await fetch('/api/algorithms/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type: algorithm, config, description: '' }),
      })
      if (!res.ok) throw new Error('保存失败')
      const data = await res.json()
      setTemplates((t) => [...t, data.template])
      toast.success('模板已保存')
    } catch {
      toast.error('保存模板失败')
    }
  }

  const resetToDefault = () => {
    setConfig(mergeConfig({}))
    toast.info('已重置为默认参数')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Brain className="size-5 text-emerald-600" />
            复习算法配置
            <Badge variant="secondary" className="ml-1 text-[11px]">
              {scope === 'global' ? '全局默认' : `单书：${cardTitle ?? ''}`}
            </Badge>
          </DialogTitle>
          <DialogDescription className="text-xs">
            FSRS 级间隔重复算法 · 目标保留率可调 · 多算法并行 · 自定义公式可视化
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[70vh]">
          <div className="space-y-4 px-5 py-4">
            {/* 单卡：跟随全局开关 */}
            {scope === 'card' && (
              <div className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <div className="text-xs">
                  <p className="font-medium text-amber-700 dark:text-amber-400">跟随全局默认</p>
                  <p className="mt-0.5 text-muted-foreground">开启后本书使用全局算法配置，不单独覆盖</p>
                </div>
                <Switch checked={followGlobal} onCheckedChange={setFollowGlobal} />
              </div>
            )}

            {/* 算法多选 + 当前算法 */}
            <section className={cn(followGlobal && 'pointer-events-none opacity-40')}>
              <p className="mb-2 text-xs font-medium text-muted-foreground">启用算法（可多选，复习页顶栏切换）</p>
              <div className="flex flex-wrap gap-2">
                {ALGORITHM_TYPES.map((a) => (
                  <button
                    key={a.value}
                    type="button"
                    onClick={() =>
                      setEnabled((en) => (en.includes(a.value) ? en.filter((x) => x !== a.value) : [...en, a.value]))
                    }
                    className={cn(
                      'rounded-full border px-3 py-1 text-xs transition-colors',
                      enabled.includes(a.value)
                        ? 'border-emerald-600 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400'
                        : 'border-border text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {a.label}
                  </button>
                ))}
              </div>

              <p className="mb-2 mt-4 text-xs font-medium text-muted-foreground">当前默认算法</p>
              <div className="flex flex-wrap gap-2">
                {ALGORITHM_TYPES.filter((a) => enabled.includes(a.value)).map((a) => (
                  <button
                    key={a.value}
                    type="button"
                    onClick={() => setAlgorithm(a.value)}
                    className={cn(
                      'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                      algorithm === a.value
                        ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900'
                        : 'border-border hover:bg-muted',
                    )}
                  >
                    {a.label}
                  </button>
                ))}
                {enabled.length === 0 && (
                  <span className="text-xs text-muted-foreground">请至少启用一个算法</span>
                )}
              </div>
            </section>

            <Separator />

            {/* 预设模板 */}
            <section className={cn(followGlobal && 'pointer-events-none opacity-40')}>
              <p className="mb-2 text-xs font-medium text-muted-foreground">预设模板（一键套用整套参数）</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => applyTemplate(t)}
                    className="flex flex-col items-start rounded-lg border border-border p-2.5 text-left transition-colors hover:bg-muted"
                  >
                    <span className="flex w-full items-center gap-1 text-xs font-medium">
                      {t.name}
                      {t.builtIn && <Badge variant="outline" className="ml-auto px-1 py-0 text-[9px]">内置</Badge>}
                    </span>
                    <span className="mt-1 line-clamp-2 text-[10px] text-muted-foreground">{t.description}</span>
                  </button>
                ))}
              </div>
            </section>

            <Separator />

            {/* 参数 Tabs */}
            <div className={cn(followGlobal && 'pointer-events-none opacity-40')}>
              <Tabs value={tab} onValueChange={setTab}>
                <TabsList className="grid w-full grid-cols-4">
                  <TabsTrigger value="basic" className="text-xs">基础</TabsTrigger>
                  <TabsTrigger value="advanced" className="text-xs">高级·w</TabsTrigger>
                  <TabsTrigger value="custom" className="text-xs">自定义</TabsTrigger>
                  <TabsTrigger value="preview" className="text-xs">预览</TabsTrigger>
                </TabsList>

                {/* 基础参数 */}
                <TabsContent value="basic" className="mt-3 space-y-4">
                  <SliderRow
                    label="目标保留率"
                    desc="下次复习时机使回忆率落到该值（越高复习越频繁）"
                    value={config.desiredRetention}
                    min={0.6}
                    max={0.95}
                    step={0.01}
                    fmt={(v) => `${(v * 100).toFixed(0)}%`}
                    onChange={(v) => update('desiredRetention', v)}
                  />
                  <NumberRow
                    label="最大间隔（天）"
                    value={config.maxInterval}
                    min={1}
                    max={36500}
                    onChange={(v) => update('maxInterval', v)}
                  />
                  <NumberRow
                    label="最小间隔（天）"
                    value={config.minInterval}
                    min={0}
                    max={365}
                    step={0.1}
                    onChange={(v) => update('minInterval', v)}
                  />
                  <SliderRow
                    label="Easy 增益"
                    desc="点「简单」时稳定性额外乘的系数"
                    value={config.easyBonus}
                    min={1}
                    max={2.5}
                    step={0.05}
                    fmt={(v) => `${v.toFixed(2)}×`}
                    onChange={(v) => update('easyBonus', v)}
                  />
                  <SliderRow
                    label="Hard 惩罚"
                    desc="点「困难」时稳定性乘的系数"
                    value={config.hardPenalty}
                    min={0.3}
                    max={1}
                    step={0.05}
                    fmt={(v) => `${v.toFixed(2)}×`}
                    onChange={(v) => update('hardPenalty', v)}
                  />
                  <SliderRow
                    label="遗忘后 S 保留"
                    desc="忘记时稳定性保留比例（越低重学越频繁）"
                    value={config.lapseSRetention}
                    min={0.05}
                    max={0.9}
                    step={0.05}
                    fmt={(v) => `${v.toFixed(2)}`}
                    onChange={(v) => update('lapseSRetention', v)}
                  />
                  <NumberRow
                    label="遗忘后 S 下限（天）"
                    value={config.lapseMinS}
                    min={0.05}
                    max={10}
                    step={0.05}
                    onChange={(v) => update('lapseMinS', v)}
                  />
                  <NumberRow
                    label="每日新卡上限"
                    value={config.dailyNewLimit}
                    min={0}
                    max={1000}
                    onChange={(v) => update('dailyNewLimit', v)}
                  />
                  <NumberRow
                    label="每日复习上限"
                    value={config.dailyReviewLimit}
                    min={0}
                    max={5000}
                    onChange={(v) => update('dailyReviewLimit', v)}
                  />
                  <div className="space-y-1.5">
                    <Label className="text-xs">复习排序策略</Label>
                    <Select value={config.reviewOrder} onValueChange={(v) => update('reviewOrder', v as AlgorithmConfig['reviewOrder'])}>
                      <SelectTrigger className="h-9 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="due">到期优先（最早到期在前）</SelectItem>
                        <SelectItem value="lowR">最易忘优先（R 从小到大）</SelectItem>
                        <SelectItem value="random">随机</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <StepsEditor
                    label="初学步骤（分钟）"
                    value={config.learningSteps}
                    onChange={(v) => update('learningSteps', v)}
                  />
                  <StepsEditor
                    label="重学步骤（分钟）"
                    value={config.relearnSteps}
                    onChange={(v) => update('relearnSteps', v)}
                  />
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <SwitchRow label="间隔抖动（防成簇到期）" checked={config.fuzz} onChange={(v) => update('fuzz', v)} />
                    <SwitchRow label="提前复习增益" checked={config.enableEarlyReview} onChange={(v) => update('enableEarlyReview', v)} />
                    <SwitchRow label="延迟复习惩罚" checked={config.enableLatePenalty} onChange={(v) => update('enableLatePenalty', v)} />
                  </div>
                </TabsContent>

                {/* 高级 w 数组 */}
                <TabsContent value="advanced" className="mt-3 space-y-2">
                  <div className="flex items-center gap-2 rounded-md bg-muted/50 p-2 text-[11px] text-muted-foreground">
                    <Sparkles className="size-3.5" />
                    FSRS w 参数（17 值）— 高级调参，直接影响稳定性/难度更新公式
                  </div>
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {config.w.map((val, i) => (
                      <div key={i} className="flex items-center gap-2 rounded border border-border px-2 py-1">
                        <span className="flex-1 truncate text-[11px] text-muted-foreground">
                          w[{i}] · {W_LABEL_TW[i]}
                        </span>
                        <Input
                          type="number"
                          step={0.01}
                          value={val}
                          onChange={(e) => {
                            const w = [...config.w]
                            w[i] = Number(e.target.value) || 0
                            update('w', w)
                          }}
                          className="h-7 w-20 text-xs"
                        />
                      </div>
                    ))}
                  </div>
                </TabsContent>

                {/* 自定义公式 */}
                <TabsContent value="custom" className="mt-3 space-y-3">
                  {algorithm !== 'custom' && (
                    <div className="rounded-md bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-400">
                      提示：当前算法不是「自定义公式」模式，以下公式仅在切换到自定义模式后生效
                    </div>
                  )}
                  <ExprEditor
                    label="新稳定性 S 表达式"
                    placeholder="S * (1 + 0.9 * pow(max(1,11-D), 0.3) * pow(1-R, 0.5) * pow(max(0.01,S), -0.2)) * ratingFactor"
                    value={config.customExpr.stability}
                    onChange={(v) => update('customExpr', { ...config.customExpr, stability: v })}
                  />
                  <ExprEditor
                    label="新难度 D 表达式"
                    placeholder="mean(max(1, min(10, D - 0.8 * (rating - 3))), 5, 0.2)"
                    value={config.customExpr.difficulty}
                    onChange={(v) => update('customExpr', { ...config.customExpr, difficulty: v })}
                  />
                  <ExprEditor
                    label="新间隔（天）表达式"
                    placeholder="9 * newS * (pow(desiredRetention, -1) - 1)"
                    value={config.customExpr.interval}
                    onChange={(v) => update('customExpr', { ...config.customExpr, interval: v })}
                  />
                  <div className="rounded-md bg-muted/50 p-2 text-[11px] text-muted-foreground">
                    <p className="font-medium text-foreground">可用变量</p>
                    <p className="mt-1">S（旧稳定） D（旧难度） R（当前回忆率） t（经过天数） reps lapses rating（1-4） ratingFactor desiredRetention newS（新稳定，仅间隔表达式）</p>
                    <p className="mt-1 font-medium text-foreground">可用函数</p>
                    <p className="mt-1">min max pow sqrt exp log abs round floor ceil sin cos clamp mean</p>
                  </div>
                </TabsContent>

                {/* 预览 */}
                <TabsContent value="preview" className="mt-3 space-y-3">
                  <RCurve preview={preview} />
                  <FourButtonPreview preview={preview} />
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </ScrollArea>

        {/* 底部操作条 */}
        <div className="flex items-center gap-2 border-t border-border px-5 py-3">
          <Button variant="ghost" size="sm" className="text-xs" onClick={resetToDefault}>
            <RotateCcw className="mr-1 size-3.5" /> 重置默认
          </Button>
          <Button variant="outline" size="sm" className="text-xs" onClick={handleSaveAsTemplate}>
            <Plus className="mr-1 size-3.5" /> 存为模板
          </Button>
          <Button size="sm" className="ml-auto text-xs" onClick={handleSave} disabled={saving || (scope === 'card' && !followGlobal && enabled.length === 0)}>
            <Save className="mr-1 size-3.5" /> {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---- 子控件 ----
function SliderRow({
  label,
  desc,
  value,
  min,
  max,
  step,
  fmt,
  onChange,
}: {
  label: string
  desc?: string
  value: number
  min: number
  max: number
  step: number
  fmt: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <span className="text-xs font-semibold tabular-nums text-emerald-600">{fmt(value)}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={(v) => onChange(v[0])} />
      {desc && <p className="text-[10px] text-muted-foreground">{desc}</p>}
    </div>
  )
}

function NumberRow({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-8 w-24 text-xs"
      />
    </div>
  )
}

function SwitchRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between rounded border border-border px-2.5 py-1.5">
      <Label className="text-xs">{label}</Label>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function StepsEditor({ label, value, onChange }: { label: string; value: number[]; onChange: (v: number[]) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="flex flex-wrap gap-1.5">
        {value.map((v, i) => (
          <div key={i} className="flex items-center gap-1 rounded border border-border px-1">
            <Input
              type="number"
              min={1}
              value={v}
              onChange={(e) => {
                const arr = [...value]
                arr[i] = Number(e.target.value) || 1
                onChange(arr)
              }}
              className="h-7 w-16 text-xs"
            />
            <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} className="text-xs text-muted-foreground hover:text-red-500">
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => onChange([...value, 10])}
          className="rounded border border-dashed border-border px-2 text-xs text-muted-foreground hover:bg-muted"
        >
          + 步骤
        </button>
      </div>
    </div>
  )
}

function ExprEditor({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string
  value?: string
  placeholder?: string
  onChange: (v: string) => void
}) {
  const [testResult, setTestResult] = React.useState<string>('')
  const runTest = () => {
    try {
      const vars = { S: 5, D: 5, R: 0.7, t: 3, reps: 3, lapses: 0, rating: 3, ratingFactor: 1, desiredRetention: 0.9, newS: 6, interval: 5, maxInterval: 365, minInterval: 1, easeBonus: 1.3, hardPenalty: 0.7, lapseSRetention: 0.3, PI: Math.PI, E: Math.E }
      const r = safeEval(value || '', vars)
      setTestResult(`= ${r.toFixed(4)}`)
    } catch (e) {
      setTestResult(`错误: ${(e as Error).message}`)
    }
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={runTest}>
          <FlaskConical className="mr-1 size-3" /> 测试
        </Button>
      </div>
      <Textarea
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[60px] font-mono text-[11px]"
      />
      {testResult && <p className="text-[11px] text-muted-foreground">S=5 D=5 R=0.7 rating=3 → {testResult}</p>}
    </div>
  )
}

function RCurve({ preview }: { preview: CardPreview | null }) {
  if (!preview) return <Skeleton />
  const pts = preview.rCurve
  const w = 320
  const h = 120
  const maxR = 1
  const maxDay = pts.length ? pts[pts.length - 1].days : 60
  const path = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${(p.days / maxDay) * w} ${h - p.r * h}`)
    .join(' ')
  const targetY = h - preview.current.r * h
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="mb-1 text-xs font-medium">记忆衰减曲线 R(t)</p>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full">
        <line x1={0} y1={targetY} x2={w} y2={targetY} stroke="#10b981" strokeDasharray="3 3" strokeWidth={0.5} opacity={0.4} />
        <path d={path} fill="none" stroke="#5b5bf0" strokeWidth={1.5} />
        <circle cx={(preview.current.elapsedDays / maxDay) * w} cy={h - preview.current.r * h} r={3} fill="#ef4444" />
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>S={preview.current.s.toFixed(2)} D={preview.current.d.toFixed(2)}</span>
        <span>当前 R={(preview.current.r * 100).toFixed(0)}%</span>
      </div>
    </div>
  )
}

function FourButtonPreview({ preview }: { preview: CardPreview | null }) {
  if (!preview) return <Skeleton />
  return (
    <div className="grid grid-cols-4 gap-2">
      {preview.grades.map((g) => (
        <div key={g.grade} className="rounded-lg border border-border p-2 text-center" style={{ borderTopColor: GRADES.find((x) => x.value === g.grade)?.color, borderTopWidth: 2 }}>
          <p className="text-xs font-medium" style={{ color: GRADES.find((x) => x.value === g.grade)?.color }}>
            {GRADES.find((x) => x.value === g.grade)?.label}
          </p>
          <p className="mt-0.5 text-sm font-bold tabular-nums">{fmtInterval(g.interval)}</p>
          <p className="text-[10px] text-muted-foreground">S={g.newS.toFixed(1)}</p>
        </div>
      ))}
    </div>
  )
}

function Skeleton() {
  return <div className="h-32 animate-pulse rounded-lg bg-muted" />
}

function fmtInterval(days: number): string {
  if (days < 1) return `${Math.round(days * 1440)}分`
  if (days < 30) return `${days.toFixed(1)}天`
  if (days < 365) return `${Math.round(days / 30)}月`
  return `${(days / 365).toFixed(1)}年`
}

const W_LABEL_TW = [
  '新卡·忘记 S0',
  '新卡·困难 S0',
  '新卡·良好 S0',
  '新卡·简单 S0',
  '初始难度 D0',
  '难度更新权重',
  '难度回归权重',
  '稳定增益 a',
  '增益(1-R)幂',
  '增益 S 幂',
  '增益(11-D)幂',
  '遗忘 S 保留',
  '困难 S 系数',
  '简单 S 系数',
  '重学毕业 S',
  'Fuzz 范围',
  '保留',
]
