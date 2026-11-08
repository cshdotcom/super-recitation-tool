// editor-cloze.ts — 挖空标记（{{…}}）纯函数工具（背书吧）
//
// 挖空标记语法：{{关键词}}，例如「北京的{{故宫}}很有名」。
// 纯函数、无任何框架/浏览器依赖，编辑器（material-editor）与阅读视图（reader-view）均可复用：
//   • extractClozeMarks — 提取文本中的全部挖空标记（去重 + 位置感知），并返回去掉 {{ }} 的正文
//   • wrapClozeMark     — 把选中文字包上 {{ }}，变成挖空标记
//
// 位置感知：同一关键词在文中出现多次时，{{ }} 标记只挖它标记的那一次出现
// （生成 { t, occ } 条目），不会误伤其他句子的同字词。

import type { KwEntry } from '@/lib/types'

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOcc(haystack: string, needle: string): number {
  if (!needle) return 0
  let n = 0
  let idx = haystack.indexOf(needle)
  while (idx >= 0) {
    n += 1
    idx = haystack.indexOf(needle, idx + 1)
  }
  return n
}

/**
 * 提取文本中的挖空标记。
 *
 * - 把所有 `{{xxx}}` 从 content 中去掉花括号（保留内部文字，原样不去空格）；
 * - 内部文字 trim 后作为关键词收进 entries；occ 为该词在【去标记后正文】中
 *   的出现序号（0 基）——只挖标记处，不误伤其他出现；
 * - 空标记（`{{}}` / `{{   }}`）不产生关键词，content 中原样去掉花括号。
 */
export function extractClozeMarks(text: string): {
  content: string
  keywords: KwEntry[]
  /** 兼容旧调用：纯文本关键词数组（去重） */
  texts: string[]
} {
  const src = String(text ?? '')
  const re = /\{\{([^{}]*)\}\}/g
  let plain = ''
  let lastIdx = 0
  const entries: KwEntry[] = []
  const texts: string[] = []
  const seenSlot = new Set<string>()

  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    plain += src.slice(lastIdx, m.index)
    lastIdx = m.index + m[0].length
    const kw = m[1].trim()
    if (!kw) continue
    const occ = countOcc(plain, kw)
    const slot = `${kw}\u0000${occ}`
    if (!seenSlot.has(slot)) {
      seenSlot.add(slot)
      entries.push({ t: kw, occ })
    }
    if (!texts.includes(kw)) texts.push(kw)
    plain += kw
  }
  plain += src.slice(lastIdx)

  return { content: plain, keywords: entries, texts }
}

/** 把选中文字包上 {{ }}，变成挖空标记。 */
export function wrapClozeMark(selected: string): string {
  return `{{${String(selected ?? '')}}}`
}
