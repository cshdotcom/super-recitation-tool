// Client-safe sentence splitting used by 耳返背书 / 摹写 / 轮盘抽背 / TTS 播放器.

/**
 * 行内/块级标记剥离：把超级编辑器的富文本标记转换为适合朗读与句子拆分的纯文本。
 * - 图片（含 dataURL）直接移除；链接保留文字
 * - Markdown 表格：分隔行删除，数据行去掉竖线（单元格以逗号连接，可读）
 * - 标题/引用/列表标记移除
 * - 行内公式保留 tex 内容（去美元符）
 * - 字色 %%color|文%%、荧光 ==文==、加粗/斜体/删除线/行内代码、挖空 {{词}} → 保留文字
 */
export function stripMarkup(content: string): string {
  let s = String(content ?? '')
  // 图片（含 base64 dataURL）→ 移除；链接 [text](url) → text
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 表格分隔行（| --- | --- |）删除
  s = s.replace(/^[ \t]*\|?[ \t:|-]+\|[ \t:|-]*$/gm, '')
  // 表格数据行：| a | b | → a，b
  s = s.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_m, row: string) =>
    row
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
      .join('，'),
  )
  // 标题/引用/列表标记
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
  s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, '')
  s = s.replace(/^([ \t]*)[-*+][ \t]+/gm, '$1')
  s = s.replace(/^([ \t]*)\d+\.[ \t]+/gm, '$1')
  // 公式 $$..$$ / $..$ → 保留内容
  s = s.replace(/\$\$([^$]+)\$\$/g, '$1')
  s = s.replace(/\$([^$\n]+)\$/g, '$1')
  // 字色 %%color|文%%
  s = s.replace(/%%[^|\n]*\|[^%\n]*%%/g, (m) => m.replace(/^%%[^|\n]*\|/, '').replace(/%%$/, ''))
  // 挖空 {{词}} / 荧光 ==文==
  s = s.replace(/\{\{([^}]+)\}\}/g, '$1')
  s = s.replace(/==([^=\n]+)==/g, '$1')
  // 加粗/删除线/行内代码/斜体
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  s = s.replace(/~~([^~\n]+)~~/g, '$1')
  s = s.replace(/`([^`\n]+)`/g, '$1')
  s = s.replace(/\*([^*\n]+)\*/g, '$1')
  return s
}

// Split content into sentences, keeping the trailing punctuation attached.
// Splits after 。！？；!?; and newlines.
export function splitSentences(content: string): string[] {
  const plain = stripMarkup(content)
  if (!plain.trim()) return []
  const raw = plain.split(/(?<=[。！？；!?;])\s*|\r?\n/)
  const out: string[] = []
  let buf = ''
  for (const piece of raw) {
    if (!piece) continue
    buf += piece
    if (/[。！？；!?;]\s*$/.test(piece) || piece.trim().length >= 60) {
      const s = buf.trim()
      if (s) out.push(s)
      buf = ''
    } else {
      buf += ' '
    }
  }
  const tail = buf.trim()
  if (tail) out.push(tail)
  return out.length > 0 ? out : [plain.trim()]
}
