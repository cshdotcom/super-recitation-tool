// GET /api/version — 部署版本探针（公开，无需登录）。
// 用于确认生产站运行的代码版本（防止「部署未更新导致功能缺失/旧 bug 复现」误报——
// 曾出现生产站停留在 v2.1.0 导致 /api/parse 500（旧版 mammoth 打包 bug）被误报为现版 bug）。
// APP_VERSION 随每次发版手动更新；buildId 取 .next/BUILD_ID（每次构建唯一）。
import { NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 应用版本（发版时更新，与 git tag 一致） */
const APP_VERSION = 'v2.7.1'

export async function GET() {
  let buildId: string | null = null
  try {
    buildId = (await readFile(path.join(process.cwd(), '.next', 'BUILD_ID'), 'utf-8')).trim() || null
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
