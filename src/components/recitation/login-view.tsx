'use client'

import * as React from 'react'
import { BookOpenText, ImagePlus, Info, Loader2, LockKeyhole } from 'lucide-react'
import { toast } from 'sonner'

import type { AccountData } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'

interface LoginViewProps {
  /** 系统是否已初始化账号（true = 仅可登录，false = 可注册唯一账号）。 */
  registered: boolean
  onAuthed: (account: AccountData) => void
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

export function LoginView({ registered, onAuthed }: LoginViewProps) {
  const mode: 'register' | 'login' = registered ? 'login' : 'register'

  const [username, setUsername] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [confirmPassword, setConfirmPassword] = React.useState('')
  const [avatar, setAvatar] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const pickAvatar = () => fileInputRef.current?.click()

  const handleAvatarFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    try {
      const dataUrl = await resizeImageToAvatar(file)
      setAvatar(dataUrl)
      toast.success('头像已就绪')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '头像处理失败')
    }
  }

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    const name = username.trim()
    if (!name) return toast.error('请输入用户名')
    if (name.length < 2 || name.length > 24) return toast.error('用户名需为 2-24 个字符')
    if (!password) return toast.error('请输入密码')
    if (password.length < 4) return toast.error('密码至少需要 4 位')
    if (password !== confirmPassword) return toast.error('两次输入的密码不一致')

    setSubmitting(true)
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name, password, avatar: avatar || undefined }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '注册失败')
      toast.success('注册成功，开始背诵吧！')
      onAuthed(data.account as AccountData)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '注册失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    const name = username.trim()
    if (!name) return toast.error('请输入用户名')
    if (!password) return toast.error('请输入密码')

    setSubmitting(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '登录失败')
      toast.success('登录成功，欢迎回来！')
      onAuthed(data.account as AccountData)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '登录失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-screen flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        {/* ---------- brand ---------- */}
        <div className="flex flex-col items-center text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-emerald-600/10">
            <BookOpenText className="size-8 text-emerald-600" strokeWidth={1.75} />
          </div>
          <h1 className="mt-4 text-2xl font-bold tracking-tight">超级背书</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            AI 挖空 · AI 出题 · TTS 朗读 · 语音识别
          </p>
        </div>

        {/* ---------- card ---------- */}
        <div className="mt-8 rounded-3xl border border-border bg-card p-6 shadow-sm">
          {mode === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-4" autoComplete="on">
              <div className="flex items-center gap-2 rounded-xl bg-muted/60 px-3 py-2.5 text-xs text-muted-foreground">
                <LockKeyhole className="size-3.5 shrink-0 text-emerald-600" strokeWidth={1.75} />
                账号已初始化，仅可登录
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="login-username">用户名</Label>
                <Input
                  id="login-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="输入用户名"
                  autoComplete="username"
                  className="h-11 rounded-xl"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="login-password">密码</Label>
                <Input
                  id="login-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入密码"
                  autoComplete="current-password"
                  className="h-11 rounded-xl"
                />
              </div>
              <Button type="submit" disabled={submitting} className="h-11 w-full rounded-full font-semibold">
                {submitting && <Loader2 className="size-4 animate-spin" />}
                登录
              </Button>
            </form>
          ) : (
            <form onSubmit={handleRegister} className="space-y-4" autoComplete="off">
              {/* avatar picker */}
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={pickAvatar}
                  aria-label="选择头像"
                  className="group relative shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <Avatar className="size-16 border border-border">
                    {avatar ? (
                      <AvatarImage src={avatar} alt="头像预览" />
                    ) : (
                      <AvatarFallback className="bg-emerald-600/10 text-emerald-600">
                        <ImagePlus className="size-6" strokeWidth={1.75} />
                      </AvatarFallback>
                    )}
                  </Avatar>
                  <span className="absolute -bottom-0.5 -right-0.5 flex size-5 items-center justify-center rounded-full bg-emerald-600 text-white shadow">
                    <ImagePlus className="size-3" strokeWidth={2} />
                  </span>
                </button>
                <div className="min-w-0">
                  <p className="text-sm font-bold">头像（可选）</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">点击左侧圆形按钮上传，自动裁剪为圆形</p>
                </div>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => void handleAvatarFile(e)}
              />

              <div className="space-y-1.5">
                <Label htmlFor="reg-username">用户名</Label>
                <Input
                  id="reg-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="2-24 个字符"
                  maxLength={24}
                  autoComplete="username"
                  className="h-11 rounded-xl"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reg-password">密码</Label>
                <Input
                  id="reg-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="至少 4 位"
                  autoComplete="new-password"
                  className="h-11 rounded-xl"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="reg-confirm">确认密码</Label>
                <Input
                  id="reg-confirm"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="再次输入密码"
                  autoComplete="new-password"
                  className="h-11 rounded-xl"
                />
              </div>

              <div className="flex items-start gap-2 rounded-xl bg-emerald-600/10 px-3 py-2.5 text-xs leading-relaxed text-emerald-700 dark:text-emerald-400">
                <Info className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
                首次注册将创建本系统唯一账号，注册入口随后关闭
              </div>

              <Button type="submit" disabled={submitting} className="h-11 w-full rounded-full bg-emerald-600 font-semibold text-white hover:bg-emerald-600/90">
                {submitting && <Loader2 className="size-4 animate-spin" />}
                注册并开始使用
              </Button>
            </form>
          )}
        </div>

        <p className="mt-6 text-center text-[11px] text-muted-foreground/70">
          数据仅存储于本机，账号用于保护你的背诵内容
        </p>
      </div>
    </main>
  )
}
