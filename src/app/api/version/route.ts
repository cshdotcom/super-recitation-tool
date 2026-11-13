// GET /api/version — 部署版本探针（公开，无需登录）。
// 用于确认生产站运行的代码版本（防止「部署未更新导致功能缺失/旧 bug 复现」误报——
// 曾出现生产站停留在 v2.1.0 导致 /api/parse 500（旧版 mammoth 打包 bug）被误报为现版 bug）。
// 版本解析顺序：git tag（最准）→ package.json version → 硬编码兜底。
// buildId 取 .next/BUILD_ID（每次构建唯一）。
import { NextResponse } from 'next/server'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 解析当前应用版本：优先 git tag，其次 package.json，最后硬编码兜底。 */
function resolveAppVersion(): string {
  // 1. git describe —— dev/本地最准，跟随最新 tag
  try {
    const tag = execSync('git describe --tags --abbrev=0', {
      encoding: 'utf-8',
      cwd: process.cwd(),
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (tag) return tag
  } catch {
    // 生产环境可能无 git，继续 fallback
  }
  // 2. package.json version（发版时同步更新此字段）
  try {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'))
    if (pkg.version) return `v${pkg.version}`
  } catch {
    // ignore
  }
  // 3. 硬编码兜底（与最新 git tag 保持一致）
  return 'v2.8.3'
}

const APP_VERSION = resolveAppVersion()

export async function GET() {
  let buildId: string | null = null
  try {
    buildId = readFileSync(path.join(process.cwd(), '.next', 'BUILD_ID'), 'utf-8').trim() || null
  } catch {
    // dev 模式可能没有 BUILD_ID
  }
  return NextResponse.json(
    {
      version: APP_VERSION,
      buildId,
      runtime: process.env.NODE_ENV === 'production' ? 'production' : 'development',
      time: new Date().toISOString(),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
