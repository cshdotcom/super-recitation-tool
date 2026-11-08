// editor-cloze.ts — 挖空标记（{{…}}）纯函数工具（背书吧）
//
// 挖空标记语法：{{关键词}}，例如「北京的{{故宫}}很有名」。
// 纯函数、无任何框架/浏览器依赖，编辑器（material-editor）与阅读视图（reader-view）均可复用：
//   • extractClozeMarks — 提取文本中的全部挖空关键词（去重），并返回去掉 {{ }} 的正文
//   • wrapClozeMark     — 把选中文字包上 {{ }}，变成挖空标记

/**
 * 提取文本中的挖空标记。
 *
 * - 把所有 `{{xxx}}` 从 content 中去掉花括号（保留内部文字，原样不去空格）；
 * - 内部文字 trim 后作为关键词收进 keywords，重复的标记只保留一个；
 * - 空标记（`{{}}` / `{{   }}`）不产生关键词，content 中原样去掉花括号。
 *
 * @example
 * extractClozeMarks('北京的{{故宫}}和{{故宫}}很有名')
 * // → { content: '北京的故宫和故宫很有名', keywords: ['故宫'] }
 */
export function extractClozeMarks(text: string): { content: string; keywords: string[] } {
  const keywords: string[] = []
  const content = String(text ?? '').replace(
    /\{\{([^{}]*)\}\}/g,
    (_match: string, inner: string) => {
      const kw = inner.trim()
      if (kw && !keywords.includes(kw)) keywords.push(kw)
      // 去掉 {{ }}，保留内部文字
      return inner
    },
  )
  return { content, keywords }
}

/** 把选中文字包上 {{ }}，变成挖空标记。 */
export function wrapClozeMark(selected: string): string {
  return `{{${String(selected ?? '')}}}`
}
