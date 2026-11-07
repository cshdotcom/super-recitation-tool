'use client'

import * as React from 'react'
import {
  Camera,
  ChevronDown,
  Copy,
  Fingerprint,
  KeyRound,
  Loader2,
  LogOut,
  User,
} from 'lucide-react'
import { toast } from 'sonner'

import type { AccountData } from '@/lib/types'
import { cn } from '@/lib/utils'
import { BottomSheet } from '@/components/recitation/bottom-sheet'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface AccountSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: AccountData
  onAccountChange: (account: AccountData) => void
  onLogout: () => void
}

/** Read an image file, center-crop to a square and downscale to 128x128 JPEG data URL. */
function resizeImageToAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      try {
        const size = 128
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('当前浏览器不支持 Canvas')
        const scale = Math.max(size / img.width, size / img.height)
        const w = img.width * scale
        const h = img.height * scale
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片读取失败，请换一张试试'))
    }
    img.src = url
  })
}

export function AccountSheet({
  open,
  onOpenChange,
  account,
  onAccountChange,
  onLogout,
}: AccountSheetProps) {
  const [nameDraft, setNameDraft] = React.useState(account.username)
  const [savingName, setSavingName] = React.useState(false)
  const [avatarSaving, setAvatarSaving] = React.useState(false)

  const [pwOpen, setPwOpen] = React.useState(false)
  const [pwForm, setPwForm] = React.useState({ current: '', next: '', confirm: '' })
  const [savingPw, setSavingPw] = React.useState(false)

  const fileInputRef = React.useRef<HTMLInputElement>(null)

  // Sync drafts when the sheet opens (or username changes from elsewhere).
  React.useEffect(() => {
    if (open) {
      setNameDraft(account.username)
      setPwForm({ current: '', next: '', confirm: '' })
      setPwOpen(false)
    }
  }, [open, account.username])

  /** PATCH /api/auth/profile and push the returned account upward. */
  const patchProfile = async (body: Record<string, unknown>, successMsg: string) => {
    const res = await fetch('/api/auth/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || '保存失败')
    if (data.account) onAccountChange(data.account as AccountData)
    toast.success(successMsg)
  }

  const pickAvatar = () => fileInputRef.current?.click()

  const handleAvatarFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setAvatarSaving(true)
    try {
      const avatar = await resizeImageToAvatar(file)
      await patchProfile({ avatar }, '头像已更新')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '头像更新失败')
    } finally {
      setAvatarSaving(false)
    }
  }

  const handleSaveUsername = async () => {
    const name = nameDraft.trim()
    if (!name) return toast.error('用户名不能为空')
    if (name === account.username) return
    setSavingName(true)
    try {
      await patchProfile({ username: name }, '用户名已更新')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '用户名更新失败')
    } finally {
      setSavingName(false)
    }
  }

  const handleSavePassword = async () => {
    if (!pwForm.current) return toast.error('请输入当前密码')
    if (!pwForm.next) return toast.error('请输入新密码')
    if (pwForm.next.length < 4) return toast.error('新密码至少需要 4 位')
    if (pwForm.next !== pwForm.confirm) return toast.error('两次输入的新密码不一致')

    setSavingPw(true)
    try {
      await patchProfile(
        { currentPassword: pwForm.current, newPassword: pwForm.next },
        '密码已更新',
      )
      setPwForm({ current: '', next: '', confirm: '' })
      setPwOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '密码更新失败')
    } finally {
      setSavingPw(false)
    }
  }

  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(account.id)
      toast.success('账号 ID 已复制')
    } catch {
      toast.error('复制失败，请手动复制')
    }
  }

  const handleLogout = async () => {
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || '退出失败')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '退出失败')
    } finally {
      onOpenChange(false)
      onLogout()
    }
  }

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="账号">
      <div className="mt-4 flex-1 space-y-4 overflow-y-auto pb-6">
        {/* ---------- avatar ---------- */}
        <div className="flex items-center gap-4 rounded-2xl border border-border bg-card px-4 py-4">
          <Avatar className="size-14 border border-border">
            {account.avatar ? (
              <AvatarImage src={account.avatar} alt={account.username} />
            ) : (
              <AvatarFallback className="bg-emerald-600/10 text-lg font-bold text-emerald-600">
                {account.username.slice(0, 1) || '账'}
              </AvatarFallback>
            )}
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-bold">{account.username}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">支持 JPG / PNG，自动裁剪为 128×128</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-9 shrink-0 rounded-full"
            onClick={pickAvatar}
            disabled={avatarSaving}
          >
            {avatarSaving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Camera className="size-4" strokeWidth={1.75} />
            )}
            换头像
          </Button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => void handleAvatarFile(e)}
        />

        {/* ---------- username ---------- */}
        <div className="rounded-2xl border border-border bg-card px-4 py-4">
          <div className="flex items-center gap-2 text-sm font-bold">
            <User className="size-4 text-muted-foreground" strokeWidth={1.75} />
            用户名
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              maxLength={24}
              placeholder="输入新用户名"
              aria-label="用户名"
              className="h-10 flex-1 rounded-xl"
            />
            <Button
              size="sm"
              className="h-10 shrink-0 rounded-full px-5"
              onClick={() => void handleSaveUsername()}
              disabled={savingName || !nameDraft.trim() || nameDraft.trim() === account.username}
            >
              {savingName && <Loader2 className="size-4 animate-spin" />}
              保存
            </Button>
          </div>
        </div>

        {/* ---------- password ---------- */}
        <div className="rounded-2xl border border-border bg-card px-4 py-4">
          <button
            type="button"
            aria-expanded={pwOpen}
            onClick={() => setPwOpen((v) => !v)}
            className="flex w-full items-center gap-2 text-sm font-bold outline-none"
          >
            <KeyRound className="size-4 text-muted-foreground" strokeWidth={1.75} />
            <span className="flex-1 text-left">修改密码</span>
            <ChevronDown
              className={cn(
                'size-4 text-muted-foreground transition-transform',
                pwOpen && 'rotate-180',
              )}
              strokeWidth={1.75}
            />
          </button>
          {pwOpen && (
            <div className="mt-3 space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="pw-current" className="text-xs text-muted-foreground">当前密码</Label>
                <Input
                  id="pw-current"
                  type="password"
                  value={pwForm.current}
                  onChange={(e) => setPwForm((f) => ({ ...f, current: e.target.value }))}
                  autoComplete="current-password"
                  className="h-10 rounded-xl"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pw-next" className="text-xs text-muted-foreground">新密码</Label>
                <Input
                  id="pw-next"
                  type="password"
                  value={pwForm.next}
                  onChange={(e) => setPwForm((f) => ({ ...f, next: e.target.value }))}
                  placeholder="至少 4 位"
                  autoComplete="new-password"
                  className="h-10 rounded-xl"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pw-confirm" className="text-xs text-muted-foreground">确认新密码</Label>
                <Input
                  id="pw-confirm"
                  type="password"
                  value={pwForm.confirm}
                  onChange={(e) => setPwForm((f) => ({ ...f, confirm: e.target.value }))}
                  autoComplete="new-password"
                  className="h-10 rounded-xl"
                />
              </div>
              <Button
                className="h-10 w-full rounded-full font-semibold"
                onClick={() => void handleSavePassword()}
                disabled={savingPw}
              >
                {savingPw && <Loader2 className="size-4 animate-spin" />}
                更新密码
              </Button>
            </div>
          )}
        </div>

        {/* ---------- account id ---------- */}
        <div className="rounded-2xl border border-border bg-card px-4 py-4">
          <div className="flex items-center gap-2 text-sm font-bold">
            <Fingerprint className="size-4 text-muted-foreground" strokeWidth={1.75} />
            账号 ID
          </div>
          <button
            type="button"
            onClick={() => void handleCopyId()}
            aria-label="复制账号 ID"
            className="mt-2 flex w-full items-center gap-2 rounded-xl bg-muted/50 px-3 py-2.5 text-left transition-colors hover:bg-muted"
          >
            <span className="flex-1 break-all font-mono text-xs text-muted-foreground">
              {account.id}
            </span>
            <Copy className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          </button>
        </div>

        {/* ---------- logout ---------- */}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              className="h-11 w-full rounded-full border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <LogOut className="size-4" strokeWidth={1.75} />
              退出登录
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="rounded-2xl">
            <AlertDialogHeader>
              <AlertDialogTitle>退出登录？</AlertDialogTitle>
              <AlertDialogDescription>
                退出后需要重新输入用户名和密码才能访问你的背书卡。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => void handleLogout()}
              >
                退出
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </BottomSheet>
  )
}
