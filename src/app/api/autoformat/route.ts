// POST /api/autoformat — AI 智能排版（导入的混乱文本 → 结构清晰的 Markdown）。
// body: { content: string, instruction?: string }
//   content：待排版的文本（超长时服务端截断保留前 8000 字）
//   instruction：可选的用户补充指令（拼进用户消息）
// 返回: { content: string } — 排版后的 Markdown（原文逐字保留，只加结构符号）。
//
// 【服务端防乱搞校验（原文保真检查）】
// AI 排版只允许「加 Markdown 结构符号」，绝不许改写/丢失原文。提示词约束之外，
// 服务端在返回前做字符级保真校验（见 fidelityCheck），不达标先让 AI 用更严格
// 的提示词重试一次，仍不达标返回
//   422 { error: 'AI 排版结果未通过原文保真校验，已放弃修改（原文未改动）。请换个说法或稍后再试' }
// ——宁可放弃排版也不动用户原文。
//
// AI 失败返回 500 {error:'AI 排版失败，请稍后重试'}；每次尝试 60s 超时保护；
// session 鉴权。
import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getAIConfig } from '@/lib/settings'
import { AUTO_FORMAT_MAX_CHARS, autoFormatText } from '@/lib/ai'

export const runtime = 'nodejs'
export const maxDuration = 120

const TIMEOUT_MS = 60_000
const MAX_INSTRUCTION_LEN = 1000
/** 内容字符覆盖率阈值：结果必须覆盖原文内容字符序列的 ≥85%（丢内容超过 15% 即失败）。 */
const FIDELITY_COVERAGE = 0.85

// ---------- 原文保真校验（防 AI 增删改内容） ----------

/**
 * 提取「内容字符序列」：把文本剥掉全部 Markdown 结构符号后，只保留
 * 汉字 + 字母 + 数字（比较口径与任务规则一致：标点、符号、空白都不参与比对）。
 *
 * 剥掉的纯语法结构（两侧同口径剥离，保证公平对比）：
 *   • %%u| 与 %%（挖空指令定界符，内部文字保留）
 *   • ==（高亮定界）、$$ / $（公式定界，内部 LaTeX 保留）
 *   • ![alt](url) / [text](url) 链接与图片（地址属于语法，整条剥除）
 *   • [[audio:uuid|标题]] / [[video:uuid]] 音视频引用（语法引用，整条剥除）
 *   • 其余全部 ASCII/标点符号（#、*、-、>、`、|、~、_、!、[、]、(、)、空格、换行…）
 */
function extractContentSequence(text: string): string {
  let s = text || ''
  // 1) 挖空/高亮/公式定界符号：只剥符号，内部内容字符保留
  s = s.replace(/%%u\|/gi, ' ').replace(/%%/g, ' ').replace(/==/g, ' ').replace(/\$/g, ' ')
  // 2) 链接与图片 ![alt](url) / [text](url)：整条剥除（url 是地址语法，非背诵内容）
  s = s.replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
  // 3) 音视频引用 [[…]]：整条剥除（uuid/语法引用，非背诵内容）
  s = s.replace(/\[\[[^\]]*\]\]/g, ' ')
  // 4) 只保留汉字 + 字母 + 数字（\p{L} 含汉字；其余符号/标点/空白全部丢弃）
  s = s.replace(/[^\p{L}\p{N}]/gu, ' ')
  return s.replace(/\s+/g, '')
}

/**
 * 原文保真校验（字符级防乱搞检查）：
 *
 * 算法（贪心双指针的保序子序列检查）：
 *   origSeq = 原文内容字符序列，resSeq = 排版结果内容字符序列
 *   1. 双指针从两序列头部出发：resSeq[j] 在 origSeq 中向后找相同字符，
 *      找到则两指针同进（matched++），否则只进 origSeq 指针。
 *   2. 全部匹配完成（j 走到末尾）⇒ 结果序列是原文序列的保序子序列
 *      ⇒ AI 没有新增/杜撰任何内容字符（新增内容会让 j 卡住）。
 *   3. 覆盖率 = matched / origSeq.length ≥ 85%
 *      ⇒ AI 没有丢失超过 15% 的原文内容字符。
 *   4. 原文序列为空（纯符号/标点文本）时无可比内容，直接放行。
 *
 * @returns null = 通过；string = 未通过的原因（用于日志）
 */
function fidelityCheck(original: string, result: string): string | null {
  const origSeq = extractContentSequence(original)
  const resSeq = extractContentSequence(result)
  // 原文没有可比内容字符（纯符号/标点）→ 无从丢失，放行
  if (origSeq.length === 0) return null
  let i = 0 // origSeq 指针
  let j = 0 // resSeq 指针
  while (i < origSeq.length && j < resSeq.length) {
    if (origSeq[i] === resSeq[j]) {
      i++
      j++
    } else {
      i++
    }
  }
  // 结果里有原文找不到的字符（保序子序列不成立）→ AI 新增/改写了内容
  if (j < resSeq.length) {
    const extra = resSeq.slice(j, j + 10)
    return `结果包含原文没有的内容字符（从「${extra}…」处失配），疑似 AI 改写或新增内容`
  }
  // 覆盖率：匹配到的原文内容字符占比（丢了内容 → 覆盖不足）
  const coverage = j / origSeq.length
  if (coverage < FIDELITY_COVERAGE) {
    return `结果仅覆盖原文内容字符的 ${(coverage * 100).toFixed(1)}%（要求 ≥${FIDELITY_COVERAGE * 100}%），疑似 AI 删减/丢失内容`
  }
  return null
}

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    const body = (await req.json().catch(() => ({}))) as {
      content?: unknown
      instruction?: unknown
    }
    const content = typeof body?.content === 'string' ? body.content : ''
    if (!content.trim()) {
      return NextResponse.json({ error: '内容不能为空' }, { status: 400 })
    }
    const instruction =
      typeof body?.instruction === 'string'
        ? body.instruction.trim().slice(0, MAX_INSTRUCTION_LEN)
        : ''

    const config = await getAIConfig()
    // 保真对比口径：与 autoFormatText 内部截断一致（AI 只见过前 8000 字）
    const original = content.slice(0, AUTO_FORMAT_MAX_CHARS)

    // 单次尝试：60s 超时保护（autoFormatText 内部不再计时）
    const attempt = (strict: boolean) =>
      Promise.race([
        autoFormatText(content, instruction, config, strict ? { strict: true } : undefined),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('AI 排版超时（60 秒），请重试')),
            TIMEOUT_MS,
          ),
        ),
      ])

    // 第一次排版 + 保真校验
    let formatted = await attempt(false)
    if (!formatted || !formatted.trim()) {
      return NextResponse.json({ error: 'AI 排版失败，请稍后重试' }, { status: 500 })
    }
    let reason = fidelityCheck(original, formatted)
    if (reason) {
      console.warn('[POST /api/autoformat] 保真校验未通过（第 1 次）：', reason)
      // 给 AI 一次更严格提示词的重试机会
      formatted = await attempt(true)
      if (!formatted || !formatted.trim()) {
        return NextResponse.json({ error: 'AI 排版失败，请稍后重试' }, { status: 500 })
      }
      reason = fidelityCheck(original, formatted)
      if (reason) {
        console.warn('[POST /api/autoformat] 保真校验未通过（第 2 次），放弃修改：', reason)
        return NextResponse.json(
          {
            error:
              'AI 排版结果未通过原文保真校验，已放弃修改（原文未改动）。请换个说法或稍后再试',
          },
          { status: 422 },
        )
      }
    }

    return NextResponse.json({ content: formatted })
  } catch (err: unknown) {
    console.error('[POST /api/autoformat] failed:', err)
    return NextResponse.json({ error: 'AI 排版失败，请稍后重试' }, { status: 500 })
  }
}
