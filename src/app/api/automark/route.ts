// AI 自动标记引擎 — 导入/编辑器「是否AI自动标记」的真实实现。
// POST /api/automark
//   Body: {
//     content?: string                  // 整篇课文（导入链路：AI 标记全文 + 语义分块）
//     blocks?: { front: string; back: string }[]   // 编辑器链路：逐块标记 back，不重新分块
//     options?: { cloze?: boolean; highlight?: boolean; media?: boolean }
//     title?: string
//   }
//   -> { content?: string, blocks?: { front: string; back: string }[] }
//
// 标记语法 = 超级编辑器全部富文本能力（material-editor FORMAT_MAP / cloze {{}}）：
//   {{关键词}}            挖空（保存时 extractClozeMarks 转为 keywords）
//   ==重点==              荧光高亮
//   %%u|重点词%%           下划线
//   %%#dc2626|极重要%%     红色强调（少用）
//   **核心术语**            加粗
//   ```mermaid mindmap```  思维导图（结构梳理）
//   | markdown 表格 |      对比归纳表
//   $$LaTeX$$              数学/物理/化学公式（化学用 \ce{}）
//
// 「AI 自动画图」= AI 用上述富媒体语法基于上下文绘制（思维导图/表格/公式），
// 不是图片生成。原文逐字保留，只包裹标记。
import { NextRequest, NextResponse } from 'next/server'
import { chatComplete, extractJSON } from '@/lib/ai'
import { getAIConfig } from '@/lib/settings'
import { getSessionUser } from '@/lib/auth'

export const runtime = 'nodejs'
export const maxDuration = 120

const MAX_CHARS = 6000

interface MarkOptions {
  cloze: boolean
  highlight: boolean
  media: boolean
}

interface BlockInput {
  front: string
  back: string
}

interface AutomarkResult {
  content?: string
  blocks?: BlockInput[]
}

/** 语法清单（按开关拼装，写进 system prompt） */
function syntaxSpec(o: MarkOptions): string {
  const lines: string[] = []
  if (o.cloze) {
    lines.push(
      '- 挖空：{{关键词}} — 密度约为全文字数的 10%-15%；只挑名词短语、动词短语、成语、专有名词、人名地名、数字、核心论点词组（2-12字）；绝不挖虚词（的/了/是/在/和/我们）和标点；已挖空的词不要再叠加其他标记。',
    )
  }
  if (o.highlight) {
    lines.push(
      '- 荧光重点：==重点句== — 句子级重点（论点句/主旨句/定义），全文 5-12 处。示例：==国破山河在==。',
      '- 下划线：%%u|重点词%% — 词级关键点，全文 8-20 处。示例：%%u|烽火连三月%%。',
      '- 红色强调：%%#dc2626|极重要词%% — 全文最多 3 处，仅用于最核心概念。示例：%%#dc2626|春望%%。',
      '- 加粗：**术语** — 学科术语/关键人物，少量使用。示例：**杜甫**。',
    )
  }
  if (o.media) {
    lines.push(
      '- 富媒体（开启时必须提供 mindmap 字段）：',
      '  - 思维导图：把全文知识结构写入 mindmap 字段（源码见输出格式说明），梳理层级关系，节点 5-15 个。',
      '  - 对比表格：出现并列对象（人物/事物/分类/数字对比）时，可在相关块的 back 里用 markdown 表格归纳（竖线分隔，第二行 | --- | 分隔行）。',
      '  - 数学公式：数理化内容用双美元符号包裹的 LaTeX（化学用 \\\\ce{...}），行内用单美元符号。',
    )
  }
  return lines.length > 0 ? lines.join('\n') : '-（本次无需任何标记，原样返回）'
}

/** 标记配对语法硬规则与正反例（防止 AI 产出错乱嵌套如 `*#7c3aed|词%%*%%`） */
const SYNTAX_HARD_RULES = `
标记配对硬规则（违反会导致渲染错乱，必须严格遵守）：
1. 每个标记的起止符必须成对出现，不允许半个。
   - 正确：**术语** / ==重点== / %%u|词%% / %%#dc2626|词%% / {{词}}
   - 错误：*术语* （单个*）/ ==重点 （缺结束）/ %%u|词 （缺%%结束）/ %%#7c3aed|词%%*%% （多余%%）
2. %% 指令的标准格式严格为：%%<样式键>|<原文>%% 。样式键只能是：u、#十六进制色、fs:数字、或它们的组合（如 #dc2626,fs:18）。样式键里绝不能出现 * = { } 等标记字符。
   - 正确：%%u|烽火连三月%% / %%#dc2626|春望%% / %%fs:18|标题%%
   - 错误：%%*#7c3aed|词%%*%% （样式键里有*）/ %%#7c3aed词%% （缺|）/ %%|词%% （缺样式键）
3. 嵌套规则（只允许以下几种，其他一律不嵌套）：
   - 允许：%%u|**词**%% （下划线包裹加粗）、%%#dc2626|**词**%% （红色包裹加粗）、%%u|==词==%% 、%%#hex|==词==%%
   - 允许：==**词**== 、 **==词==**
   - 禁止：**%%u|词%%** （加粗包裹指令——会错乱）、 %%u|%%fs:18|词%%%%%% （指令套指令）、 {{**词**}} （挖空套加粗）、 {{==词==}}
4. 不同标记默认不叠加；同一处只用一种标记，除非用上方明确允许的嵌套组合。
5. 富媒体块（代码围栏/表格/公式）独立成段（前后各留一个空行），不插在句子中间。
6. 原文逐字保留：标记只包裹原文子串，绝不改写、增删、调换、翻译、纠正原文任何字符；输入若为无意义的测试文本（如 "test123456"）则原样返回不加任何标记。
`

/**
 * 服务端标记清洗器：检测并修复/剥离 AI 产出的错乱标记。
 * 处理：孤立的 %%（不成对）、%%指令格式错误（缺|/样式键含非法字符）、
 * 禁止的嵌套（**%%...%%** 加粗包裹指令）、未闭合的 ** == {{ }}。
 * 策略：能修复的修复（剥多余符号），不能修复的剥离标记符保留原文文字。
 */
function sanitizeMarks(text: string): string {
  if (!text) return text
  let s = text
  // 1) 剥离禁止的嵌套：**%%...%%** → %%...%%（加粗包裹指令）；同理 ==%%...%%== / *%%...%%*
  s = s.replace(/\*\*(%%[^%\n]*?\|[^%]*?%%)\*\*/g, '$1')
  s = s.replace(/==(%%[^%\n]*?\|[^%]*?%%)==/g, '$1')
  // 2) 校验每个 %%...%% 指令：合法格式 = %%<keys>|<text>%%，keys 不含 * = { } % | 且非空，text 不含 %
  //    非法的整段 %%...%% 配对 → 剥掉 %% 与 | 留文字；孤立 %% → 删除
  //    先处理成对的 %%...%%（贪婪匹配最短配对，text 内不含 %）
  s = s.replace(/%%([^%\n]*?)\|([^%]*?)%%/g, (whole, keys: string, inner: string) => {
    // keys 合法性：仅允许 u / #hex / fs:N / 以及逗号分号组合
    const k = String(keys).trim()
    const validKeys = /^[u#]?$|^#[0-9a-fA-F]{3,8}$|^fs:\d+$|^u[,;]?$|^#[0-9a-fA-F]{3,8}[,;](fs:\d+|u)?$|^(fs:\d+|u)([,;]#[0-9a-fA-F]{3,8}|[,;]u)?$|^#[0-9a-fA-F]{3,8},fs:\d+$/.test(k) || /^(u|#[0-9a-fA-F]{3,8}|fs:\d+)([,;](u|#[0-9a-fA-F]{3,8}|fs:\d+))*$/.test(k)
    if (!validKeys || !inner) return inner // 剥标记留文字
    return `%%${k}|${inner}%%`
  })
  // 3) 剩余的孤立 %%（未配对）→ 删除（避免渲染时把后续文字整段吞掉）
  //    先统计：若 %% 出现次数为奇数，删最后一个
  const count = (s.match(/%%/g) || []).length
  if (count % 2 !== 0) {
    const idx = s.lastIndexOf('%%')
    s = s.slice(0, idx) + s.slice(idx + 2)
  }
  // 4) 修未闭合的 ** ：奇数个 ** → 删最后一个（防整段加粗）
  const starCount = (s.match(/\*\*/g) || []).length
  if (starCount % 2 !== 0) {
    const idx = s.lastIndexOf('**')
    s = s.slice(0, idx) + s.slice(idx + 2)
  }
  // 5) 修未闭合的 == ：奇数个 → 删最后一个
  const eqCount = (s.match(/==/g) || []).length
  if (eqCount % 2 !== 0) {
    const idx = s.lastIndexOf('==')
    s = s.slice(0, idx) + s.slice(idx + 2)
  }
  // 6) 修未闭合的 {{ }}：分别计数，奇数个删最后
  const lbCount = (s.match(/{{/g) || []).length
  const rbCount = (s.match(/}}/g) || []).length
  if (lbCount > rbCount) {
    const idx = s.lastIndexOf('{{')
    s = s.slice(0, idx) + s.slice(idx + 2)
  } else if (rbCount > lbCount) {
    const idx = s.lastIndexOf('}}')
    s = s.slice(0, idx) + s.slice(idx + 2)
  }
  return s
}

function buildSystemPrompt(o: MarkOptions, mode: 'content' | 'blocks'): string {
  const base =
    '你是「背书吧」App 的编辑器自动标记引擎。用户给你课文/背诵材料，你用编辑器标记语法输出标记后的文本。' +
    '最高规则：原文必须逐字保留（标记只是原样包裹原文子串），绝不改写、增删、调换原文文字；标记符号本身要配对完整。\n\n' +
    '可用标记语法：\n' +
    syntaxSpec(o) +
    SYNTAX_HARD_RULES +
    '\n通用规则：\n' +
    '- 不同标记默认不嵌套；同一处只用一种标记，除非使用硬规则中明确允许的嵌套组合。\n' +
    '- 富媒体块独立成段（前后各留一个空行），不插在句子中间。\n'
  if (mode === 'content') {
    return (
      base +
      '\n你的回复必须且只能是一个 JSON 对象（以 { 开头、} 结尾，绝不输出 JSON 以外的任何文字）：\n' +
      '{"content":"标记后的完整课文（含挖空/重点标记；不要把思维导图写在这里）",' +
      '"mindmap":"' +
      (o.media
        ? '全文结构思维导图源码：首行 mindmap，其后每行一个节点按层级缩进2空格、根节点形如 根((标题))；不要写反引号围栏；JSON 字符串内换行写成 \\n 转义。此字段必填，'
        : '（本次不需要，返回空字符串）') +
      '",' +
      '"blocks":[{"front":"核心论点（问题形式，≤20字）","back":"该块完整内容（含标记）"}]}\n' +
      'blocks 规则：按语义把全文分成 2-8 块（每块 1-4 句）；front 是针对该块的提问式论点；back 是该块原文（含标记）；块的 back 拼接起来 ≈ 全文。'
    )
  }
  return (
    base +
    '\n你将收到 JSON 数组形式的 blocks（每块有 front 和 back）。逐块标记 back（front 原样保留）。' +
    (o.media ? '另外提供 mindmap 字段：全文结构思维导图源码（首行 mindmap，每行一个节点按层级缩进2空格，根节点形如 根((标题))，不要反引号围栏，换行用 \\n 转义）。' : '') +
    '\n你的回复必须且只能是一个 JSON 对象（以 { 开头、} 结尾，绝不输出 JSON 以外的任何文字）：\n' +
    '{"blocks":[{"front":"原样","back":"标记后的内容"}]' +
    (o.media ? ',"mindmap":"…"' : '') +
    '}（blocks 数量与顺序和输入一致）'
  )
}

/** 校验 & 清洗 AI 返回的 blocks */
function sanitizeBlocks(raw: unknown): BlockInput[] {
  if (!Array.isArray(raw)) return []
  const out: BlockInput[] = []
  for (const b of raw.slice(0, 30)) {
    if (!b || typeof b !== 'object') continue
    const front = typeof (b as BlockInput).front === 'string' ? (b as BlockInput).front : ''
    const back = typeof (b as BlockInput).back === 'string' ? (b as BlockInput).back : ''
    if (back.trim()) out.push({ front, back })
  }
  return out
}

/** AI 常见失误兜底：剥掉包 JSON 的 ```json 围栏 */
function normalizeJsonish(text: string): string {
  let t = text.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t)
  if (fence) t = fence[1]
  return t
}

/** 清洗 mindmap 字段：去围栏/保证首行 mindmap；无效返回 null */
function cleanMindmap(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let s = raw.trim()
  s = s.replace(/^```(?:mermaid)?\s*/i, '').replace(/```\s*$/, '')
  s = s.replace(/^mindmap\b\s*/i, '')
  const lines = s
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim())
    .slice(0, 40)
  if (lines.length < 2) return null
  return ['mindmap', ...lines].join('\n')
}

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 })

    const body = (await req.json().catch(() => ({}))) as {
      content?: unknown
      blocks?: unknown
      options?: { cloze?: unknown; highlight?: unknown; media?: unknown }
      title?: unknown
    }

    const options: MarkOptions = {
      cloze: body?.options?.cloze !== false,
      highlight: body?.options?.highlight !== false,
      media: body?.options?.media !== false,
    }

    const inputBlocks = sanitizeBlocks(body?.blocks)
    const content = typeof body?.content === 'string' ? body.content : ''
    const mode: 'content' | 'blocks' = inputBlocks.length > 0 ? 'blocks' : 'content'
    if (mode === 'content' && !content.trim()) {
      return NextResponse.json({ error: '内容不能为空' }, { status: 400 })
    }

    // 截断保护（超长课文标记前 6000 字）
    const truncated = content.slice(0, MAX_CHARS)
    const blocksTruncated = inputBlocks.map((b) => ({
      front: b.front.slice(0, 120),
      back: b.back.slice(0, MAX_CHARS),
    }))

    const userPayload =
      mode === 'content'
        ? `标题：${typeof body?.title === 'string' && body.title.trim() ? body.title.trim() : '（无）'}\n\n课文：\n${truncated}${options.media ? '\n\n（提醒：回复 JSON 中必须包含 mindmap 字段，写出全文结构思维导图源码）' : ''}`
        : `blocks（JSON）：\n${JSON.stringify(blocksTruncated)}${options.media ? '\n\n（提醒：回复 JSON 中必须包含 mindmap 字段，写出全文结构思维导图源码）' : ''}`

    const messages = [
      { role: 'system' as const, content: buildSystemPrompt(options, mode) },
      { role: 'user' as const, content: userPayload },
    ]

    const config = await getAIConfig()
    const raw = await chatComplete(messages, config)
    const rawText = String(raw ?? '')

    // 解析 JSON；失败时兜底 —— 原文含标记符号则把原文当标记结果（绝不硬失败）
    let parsed: (AutomarkResult & { mindmap?: unknown }) | null = null
    let parseFailed = false
    try {
      parsed = extractJSON<AutomarkResult & { mindmap?: unknown }>(normalizeJsonish(rawText))
    } catch {
      parseFailed = true
    }

    /** 服务端组装 mermaid 围栏（AI 只给源码，避免 JSON 内嵌围栏转义失败） */
    const mindmap = options.media ? cleanMindmap(parsed?.mindmap) : null
    const mindmapMd = mindmap ? `\n\n\`\`\`mermaid\n${mindmap}\n\`\`\`` : ''

    if (mode === 'blocks') {
      let marked = sanitizeBlocks(parsed?.blocks).map((b) => ({
        front: b.front,
        back: sanitizeMarks(b.back),
      }))
      if (marked.length === 0 && parseFailed && /\{\{|==|%%|\*\*/.test(rawText)) {
        // 兜底：AI 直接输出了标记后的整段文本 → 整体作为一块
        marked = [{ front: '', back: sanitizeMarks(rawText.trim().slice(0, MAX_CHARS)) }]
      }
      if (marked.length === 0) {
        return NextResponse.json(
          { error: 'AI 标记结果解析失败，请重试或稍后手动标记' },
          { status: 502 },
        )
      }
      if (mindmapMd) {
        // 追加思维导图到最后一块（不重复追加）
        const last = marked[marked.length - 1]
        if (!last.back.includes('```mermaid')) {
          marked = [...marked.slice(0, -1), { ...last, back: last.back + mindmapMd }]
        }
      }
      return NextResponse.json({ blocks: marked })
    }

    let markedContent = typeof parsed?.content === 'string' ? sanitizeMarks(parsed.content) : ''
    let markedBlocks = sanitizeBlocks(parsed?.blocks).map((b) => ({
      front: b.front,
      back: sanitizeMarks(b.back),
    }))
    if (!markedContent.trim() && parseFailed && /\{\{|==|%%|\*\*/.test(rawText)) {
      // 兜底：原文即标记结果
      markedContent = sanitizeMarks(rawText.trim().slice(0, MAX_CHARS))
      markedBlocks = [{ front: '', back: markedContent }]
    }
    if (!markedContent.trim()) {
      return NextResponse.json(
        { error: 'AI 标记结果解析失败，请重试或稍后手动标记' },
        { status: 502 },
      )
    }
    if (mindmapMd && !markedContent.includes('```mermaid')) {
      markedContent += mindmapMd
      if (markedBlocks.length > 0) {
        const last = markedBlocks[markedBlocks.length - 1]
        markedBlocks = [
          ...markedBlocks.slice(0, -1),
          { ...last, back: last.back.includes('```mermaid') ? last.back : last.back + mindmapMd },
        ]
      }
    }
    return NextResponse.json({
      content: markedContent,
      blocks: markedBlocks,
      truncated: content.length > MAX_CHARS,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[POST /api/automark] failed:', err)
    return NextResponse.json(
      { error: /标记|解析|AI/.test(msg) ? msg : `AI 自动标记失败：${msg}` },
      { status: 502 },
    )
  }
}
