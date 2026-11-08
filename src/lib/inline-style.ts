// Shared inline-span style parser for the `%%…|text%%` directive syntax.
//
// Syntax accepted inside the directive (before the first `|`):
//   • bare color          %%#dc2626|文%%        → { color: '#dc2626' }
//   • named color         %%red|文%%            → { color: 'red' }  (default → {})
//   • font size (px)      %%fs:18|文%%          → { fontSize: 18 }
//   • bare size           %%18|文%%             → { fontSize: 18 }
//   • combined list       %%color:#dc2626;fs:18|文%%
//   • legacy combos       %%#dc2626,18|文%%     → color + size (comma separated)
//
// Pure function, no framework dependencies — used by the editor preview,
// rich-content (markdown renderer), cloze-text (reading view) and the
// shared card view so every surface renders identical styles.

export interface InlineSpanStyle {
  color?: string
  fontSize?: number
  underline?: boolean
}

const COLOR_VALUE_RE =
  /^(#(?:[0-9a-f]{3,8})|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]{3,20})$/i

const NAMED_ALIASES: Record<string, string> = {
  red: '#dc2626',
  orange: '#ea580c',
  green: '#16a34a',
  teal: '#0d9488',
  purple: '#7c3aed',
  pink: '#db2777',
  gray: '#64748b',
  blue: '#2563eb',
  yellow: '#ca8a04',
}

function clampPx(n: number): number | undefined {
  if (!Number.isFinite(n)) return undefined
  return Math.min(48, Math.max(10, Math.round(n)))
}

/** Parse one `key:value` pair (already lowercased). */
function parsePair(raw: string): InlineSpanStyle {
  const out: InlineSpanStyle = {}
  const [key, ...rest] = raw.split(':')
  const value = rest.join(':').trim()
  const k = (key ?? '').trim().toLowerCase()
  if (!k || !value) return out
  if (k === 'color' || k === 'c' || k === '颜色') {
    const v = NAMED_ALIASES[value.toLowerCase()] ?? value
    if (COLOR_VALUE_RE.test(v)) out.color = v
  } else if (k === 'fs' || k === 'size' || k === '字号') {
    const n = parseFloat(value)
    const px = clampPx(n)
    if (px) out.fontSize = px
  } else if (k === 'u' || k === 'underline' || k === '下划线') {
    out.underline = true
  }
  return out
}

/**
 * Parse the directive part of `%%…|text%%`. Never throws; unknown
 * directives return `{}` (renders as default text).
 */
export function parseSpanDirective(directive: string): InlineSpanStyle {
  const dir = String(directive ?? '').trim()
  if (!dir || dir.toLowerCase() === 'default') return {}

  // Combined list: `k:v;k:v` or legacy `#hex,18`
  if (dir.includes(';') || dir.includes(',')) {
    let merged: InlineSpanStyle = {}
    for (const part of dir.split(/[;,]/)) {
      const s = parseSpanDirective(part)
      merged = { ...merged, ...s }
    }
    return merged
  }

  // key:value single pair
  if (dir.includes(':')) return parsePair(dir)

  // bare number → font size
  if (/^\d+(\.\d+)?$/.test(dir)) {
    const px = clampPx(parseFloat(dir))
    return px ? { fontSize: px } : {}
  }

  // bare color token (#hex / rgb() / named)
  const v = NAMED_ALIASES[dir.toLowerCase()] ?? dir
  if (COLOR_VALUE_RE.test(v)) return { color: v }
  // bare underline directive
  if (dir.toLowerCase() === 'u' || dir.toLowerCase() === 'underline') {
    return { underline: true }
  }
  return {}
}

/** CSS inline style string for a parsed directive, e.g. `color:#dc2626;font-size:18px`. */
export function spanStyleCss(style: InlineSpanStyle): string {
  const parts: string[] = []
  if (style.color) parts.push(`color:${style.color}`)
  if (style.fontSize) parts.push(`font-size:${style.fontSize}px`)
  if (style.underline) parts.push('text-decoration:underline')
  return parts.join(';')
}

/**
 * Expand every `%%dir|text%%` span into a raw `<span style>` so rehype-raw
 * renders it. Code segments (fenced or inline) are left untouched.
 */
export function expandSpanDirectives(md: string): string {
  const parts = md.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g)
  return parts
    .map((p) => {
      if (/^(```|~~~|`)/.test(p)) return p
      return p.replace(/%%([^|\n]*)\|([^%\n]*)%%/g, (_m, dir: string, text: string) => {
        const css = spanStyleCss(parseSpanDirective(dir))
        const safeText = String(text ?? '').replace(/[<>&"]/g, (c) =>
          c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : '&quot;',
        )
        return css
          ? `<span style="${css}">${safeText}</span>`
          : safeText
      })
    })
    .join('')
}
