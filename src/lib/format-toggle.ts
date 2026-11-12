// 行内格式包裹/解除（toggle）共享逻辑 — material-editor 与表格编辑器共用。
//
// 语义（与 Word 等富文本编辑器一致）：已生效 → 再点一次解除；未生效 → 包裹，
// 与其他格式（高亮/下划线/字色…）任意嵌套，渲染端（inline-style.ts 递归
// 分词器）保证层层叠加。
//
// 对称标记分两族处理：
//  ① 同字符重复族（`*`/`**`/`==`/`~~`/`` ` ``）：按「字符层」开关。
//     `*` 与 `**` 共用星号，必须按选区两侧的完整星号串（run）计算层数，
//     否则「对加粗文字点斜体」会被误判为解除一层星号：
//       - `**x**` 点斜体 → 加一层 → `***x***`（加粗+斜体）
//       - `***x***` 点斜体 → 减一层 → `**x**`；点加粗 → `*x*`
//       - `**x**` 点加粗 → 解除 → `x`
//     激活判定与渲染器一致：星号串 min 长度为奇 → 斜体生效；≥2 → 加粗生效。
//  ② 非对称标记（`%%u|`/`%%`）：字符串本身区分开/闭角色，直接配对。
//
// 纯函数：返回新文本与新的选区，调用方负责提交与光标恢复。

export interface FormatToggleResult {
  value: string
  start: number
  end: number
}

function clampSel(value: string, selStart: number, selEnd: number): { start: number; end: number } {
  const start = Math.max(0, Math.min(selStart, value.length))
  const end = Math.max(start, Math.min(selEnd, value.length))
  return { start, end }
}

/** `*`/`**`/`==`/`~~`/`` ` `` 这类由同一字符重复组成的对称标记。 */
function isSymmetricRepeat(before: string, after: string): string | null {
  if (before !== after || before.length < 1) return null
  const c = before[0]
  for (const ch of before) if (ch !== c) return null
  return c
}

// ---------------------------------------------------------------------------
// ① 同字符重复族：按 run 层开关
// ---------------------------------------------------------------------------

/** 收集字符串中字符 c 的连续 run；role 按行内奇偶交替（第 1、3…个为开，
 * 第 2、4…为闭），与渲染器的贪心配对语义一致。 */
function charRuns(value: string, c: string): Array<{ start: number; len: number; role: 'open' | 'close' }> {
  const runs: Array<{ start: number; len: number; role: 'open' | 'close' }> = []
  let parity = 0
  let i = 0
  while (i < value.length) {
    if (value[i] === '\n') {
      parity = 0
      i += 1
      continue
    }
    if (value[i] === c) {
      let len = 0
      while (value[i + len] === c) len += 1
      runs.push({ start: i, len, role: parity % 2 === 0 ? 'open' : 'close' })
      parity += 1
      i += len
      continue
    }
    i += 1
  }
  return runs
}

/** pos 所在 run（pos 指向该 run 内的任意位置，含边界紧邻） */
function runAt(
  runs: Array<{ start: number; len: number; role?: 'open' | 'close' }>,
  pos: number,
) {
  return runs.find((r) => pos >= r.start && pos < r.start + r.len) ?? null
}

function toggleSymmetricRepeat(
  value: string,
  start: number,
  end: number,
  marker: string,
  ph: string,
): FormatToggleResult {
  const c = marker[0]
  const L = marker.length
  const hasSel = end > start
  const selLen = end - start

  // 选区两侧（含选区首尾）的完整同字符 run
  let runStart = start
  while (runStart > 0 && value[runStart - 1] === c) runStart -= 1
  let runEnd = end
  while (runEnd < value.length && value[runEnd] === c) runEnd += 1
  const leftRun = start - runStart
  const rightRun = runEnd - end
  let innerLead = 0
  while (innerLead < selLen && value[start + innerLead] === c) innerLead += 1
  let innerTail = 0
  while (innerTail < selLen - innerLead && value[end - 1 - innerTail] === c) innerTail += 1
  const totalOpen = leftRun + innerLead
  const totalClose = innerTail + rightRun
  const touchesOpen = leftRun > 0 || innerLead > 0
  const touchesClose = rightRun > 0 || innerTail > 0

  // ---- 选区连标记构成完整标记区 → 按层开关 ----
  if (hasSel && touchesOpen && touchesClose && totalOpen >= L && totalClose >= L) {
    const bodyStart = runStart + totalOpen
    const bodyEnd = runEnd - totalClose
    const body = value.slice(bodyStart, bodyEnd)
    // 正文里还有同字符（如 `==a====b==` 选中全部）→ 结构歧义，退回普通包裹
    // 两侧 run 角色校验：开侧 run 须为「开」、闭侧 run 须为「闭」，
    // 拦下 `**a**xyz**b**`（选区两侧是前一对的闭 + 后一对的开）这类误判。
    const runs = charRuns(value, c)
    const openRun = runAt(runs, Math.min(runStart + totalOpen - 1, runEnd - 1))
    const closeRun = runAt(runs, Math.max(runStart, runEnd - totalClose))
    const rolesOk =
      openRun !== null && closeRun !== null && openRun.role === 'open' && closeRun.role === 'close'
    if (!body.includes(c) && rolesOk) {
      const minRun = Math.min(totalOpen, totalClose)
      // 星号族：`*` 的激活与否取决于奇偶层（`**` 先占两层）；其余按整层数
      const active =
        c === '*' && L === 1 ? minRun % 2 === 1 : Math.floor(minRun / L) >= 1
      if (active) {
        // 解除一层：两侧各去 L 个字符
        const open = c.repeat(totalOpen - L)
        const close = c.repeat(totalClose - L)
        return {
          value: value.slice(0, runStart) + open + body + close + value.slice(runEnd),
          start: runStart + open.length,
          end: runStart + open.length + body.length,
        }
      }
      // 未激活 → 两侧各加 L 个字符（叠加一层）
      const open = c.repeat(totalOpen + L)
      const close = c.repeat(totalClose + L)
      return {
        value: value.slice(0, runStart) + open + body + close + value.slice(runEnd),
        start: runStart + open.length,
        end: runStart + open.length + body.length,
      }
    }
  }

  // ---- 光标（无选区）：同名标记对内 → 延续格式插占位文字 ----
  if (!hasSel) {
    if (leftRun >= L && rightRun >= L) {
      // 光标在 `**|**` 型空对内（或两对紧邻之间）：直接插入占位（安全，不产生歧义结构）
      return {
        value: value.slice(0, start) + ph + value.slice(end),
        start,
        end: start + ph.length,
      }
    }
    let p = -1
    for (let k = start - L; k >= 0; k -= 1) {
      if (value.slice(k, k + L) === marker) {
        p = k
        break
      }
    }
    if (p >= 0 && p + L <= start) {
      const q = value.indexOf(marker, start)
      const beforeCursor = value.slice(p + L, start)
      const afterCursor = value.slice(start, q < 0 ? start : q)
      if (q >= 0 && !beforeCursor.includes(marker) && !afterCursor.includes(marker)) {
        return {
          value: value.slice(0, start) + ph + value.slice(end),
          start,
          end: start + ph.length,
        }
      }
    }
    // 普通位置 → 包裹占位文字
    return {
      value: value.slice(0, start) + marker + ph + marker + value.slice(end),
      start: start + L,
      end: start + L + ph.length,
    }
  }

  // ---- 有选区、不在标记区 → 包裹选区（与其他格式自然嵌套）----
  return {
    value: value.slice(0, start) + marker + value.slice(start, end) + marker + value.slice(end),
    start: start + L,
    end: end + L,
  }
}

// ---------------------------------------------------------------------------
// ② 非对称标记（`%%u|` / `%%`）
// ---------------------------------------------------------------------------

function toggleAsymmetric(
  value: string,
  start: number,
  end: number,
  before: string,
  after: string,
  ph: string,
): FormatToggleResult {
  const hasSel = end > start

  // 1) 选区包含完整标记对 → 解除
  if (
    hasSel &&
    end - start > before.length + after.length &&
    value.slice(start, start + before.length) === before &&
    value.slice(end - after.length, end) === after
  ) {
    const body = value.slice(start + before.length, end - after.length)
    return {
      value: value.slice(0, start) + body + value.slice(end),
      start,
      end: start + body.length,
    }
  }

  // 2) 选区恰为标记对内部文字（两侧紧邻标记）→ 扩展整对并解除
  if (
    value.slice(Math.max(0, start - before.length), start) === before &&
    value.slice(end, end + after.length) === after
  ) {
    const s0 = start - before.length
    const e0 = end + after.length
    const body = value.slice(s0 + before.length, e0 - after.length)
    return {
      value: value.slice(0, s0) + body + value.slice(e0),
      start: s0,
      end: s0 + body.length,
    }
  }

  // 3) 光标在同名标记对内部 → 插占位文字延续格式
  if (!hasSel) {
    let p = -1
    for (let k = start - before.length; k >= 0; k -= 1) {
      if (value.slice(k, k + before.length) === before) {
        p = k
        break
      }
    }
    if (p >= 0 && p + before.length <= start) {
      const q = value.indexOf(after, start)
      const beforeCursor = value.slice(p + before.length, start)
      const afterCursor = value.slice(start, q < 0 ? start : q)
      if (q >= 0 && !beforeCursor.includes(after) && !afterCursor.includes(before)) {
        return {
          value: value.slice(0, start) + ph + value.slice(end),
          start,
          end: start + ph.length,
        }
      }
    }
    return {
      value: value.slice(0, start) + before + ph + after + value.slice(end),
      start: start + before.length,
      end: start + before.length + ph.length,
    }
  }

  // 4) 有选区 → 包裹
  return {
    value: value.slice(0, start) + before + value.slice(start, end) + after + value.slice(end),
    start: start + before.length,
    end: end + before.length,
  }
}

/**
 * 选区 [start,end) 恰好是另一族行内格式的完整包裹（`==…==` / `~~…~~` /
 * `%%样式|…%%`）时，返回剥壳后的内层选区 —— 让「对 ==***x***== 整体
 * 点加粗」真正作用于内层星号区（解除内层加粗），而不是在外面包一层。
 * 每次只剥一层（递归调用 toggleWrap 自然支持多层）。
 */
function stripOuterWrapper(
  value: string,
  start: number,
  end: number,
  ownBefore: string,
): { start: number; end: number } | null {
  const selLen = end - start
  if (selLen <= 4) return null
  // ==高亮==
  if (
    ownBefore !== '==' &&
    value.slice(start, start + 2) === '==' &&
    value.slice(end - 2, end) === '=='
  ) {
    return { start: start + 2, end: end - 2 }
  }
  // ~~删除线~~
  if (
    ownBefore !== '~~' &&
    value.slice(start, start + 2) === '~~' &&
    value.slice(end - 2, end) === '~~'
  ) {
    return { start: start + 2, end: end - 2 }
  }
  // %%样式|文字%%（非本格式时才剥）
  if (!ownBefore.startsWith('%%')) {
    const head = value.slice(start, Math.min(end, start + 44))
    const m = /^%%[^|%\n]{1,40}\|/.exec(head)
    if (m && m[0].length < selLen - 2 && value.slice(end - 2, end) === '%%') {
      return { start: start + m[0].length, end: end - 2 }
    }
  }
  return null
}

export function toggleWrap(
  value: string,
  selStart: number,
  selEnd: number,
  before: string,
  after: string,
  ph: string,
): FormatToggleResult {
  const { start, end } = clampSel(value, selStart, selEnd)
  // 选区恰好包含另一族格式的完整包裹 → 剥壳后对内层应用（多层递归剥）
  const inner = stripOuterWrapper(value, start, end, before)
  if (inner) return toggleWrap(value, inner.start, inner.end, before, after, ph)
  const c = isSymmetricRepeat(before, after)
  if (c) return toggleSymmetricRepeat(value, start, end, before, ph)
  return toggleAsymmetric(value, start, end, before, after, ph)
}

/** 引用（`> ` 行前缀）按行开关：选中行全部已有前缀则移除，否则逐行添加。 */
export function toggleQuoteLines(
  value: string,
  selStart: number,
  selEnd: number,
): FormatToggleResult {
  const { start, end } = clampSel(value, selStart, selEnd)
  const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const lineEndIdx = value.indexOf('\n', Math.max(end, start))
  const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx
  const lines = value.slice(lineStart, lineEnd).split('\n')
  const allQuoted = lines.every((l) => l.startsWith('> ') || !l.trim())
  const nextChunk = lines
    .map((l) => {
      if (allQuoted) return l.replace(/^> ?/, '')
      return l.startsWith('>') ? l : `> ${l}`
    })
    .join('\n')
  return {
    value: value.slice(0, lineStart) + nextChunk + value.slice(lineEnd),
    start: lineStart,
    end: lineStart + nextChunk.length,
  }
}
