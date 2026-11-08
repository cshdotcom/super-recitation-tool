// 极简手绘简笔画插画库 — 黑描边(2px) + 浅紫(#c7c9f5)色块，透明背景。
// 每个插画都是 <svg viewBox="0 0 120 120">，宽高由 className 控制。
interface IllProps {
  className?: string
}

const STROKE = '#27272a' // 黑描边
const PURPLE = '#c7c9f5' // 浅紫填充
const PURPLE_LIGHT = '#dedff9' // 更浅一档的紫（翻盖/纸页）
const PURPLE_DEEP = '#d6d7f3' // 深一档的紫（开口内壁）
const WHITE = '#ffffff'

// 树懒挂在树枝上睡觉，头旁 "zZZ"
export function SlothIll({ className }: IllProps) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      stroke={STROKE}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* 树枝 + 叶子 */}
      <path d="M6 32 C 40 26, 78 34, 114 28" strokeWidth={3.5} />
      <path d="M18 31 C 12 22, 4 20, 2 23 C 6 30, 13 33, 18 31 Z" fill={PURPLE} />

      {/* 两只手臂勾住树枝（先黑后紫的双层描边法） */}
      <path d="M36 56 C 29 49, 27 39, 30 31 C 31 27, 36 28, 35 32" strokeWidth={7} />
      <path
        d="M36 56 C 29 49, 27 39, 30 31 C 31 27, 36 28, 35 32"
        stroke={PURPLE}
        strokeWidth={3.5}
      />
      <path d="M50 54 C 47 45, 46 38, 48 30 C 49 26, 54 27, 53 31" strokeWidth={7} />
      <path
        d="M50 54 C 47 45, 46 38, 48 30 C 49 26, 54 27, 53 31"
        stroke={PURPLE}
        strokeWidth={3.5}
      />

      {/* 身体 */}
      <ellipse cx="44" cy="68" rx="19" ry="23" fill={PURPLE} />

      {/* 下垂的两条腿 + 爪 */}
      <path d="M36 86 C 34 92, 35 97, 39 98" strokeWidth={7} />
      <path d="M36 86 C 34 92, 35 97, 39 98" stroke={PURPLE} strokeWidth={3.5} />
      <path d="M36 99 l-4 3 M40 99 l-1 4" strokeWidth={2} />
      <path d="M51 86 C 50 92, 51 97, 54 98" strokeWidth={7} />
      <path d="M51 86 C 50 92, 51 97, 54 98" stroke={PURPLE} strokeWidth={3.5} />
      <path d="M51 99 l-3 4 M54 99 l1 4" strokeWidth={2} />

      {/* 头 + 睡脸 */}
      <circle cx="63" cy="50" r="12.5" fill={PURPLE} />
      <path d="M56.5 48 Q59 51 61.5 48" />
      <path d="M66.5 48 Q69 51 71.5 48" />
      <ellipse cx="64" cy="53.5" rx="2.2" ry="1.6" fill={STROKE} strokeWidth={1} />
      <path d="M61 57.5 Q64 60 67 57.5" strokeWidth={1.75} />

      {/* zZZ */}
      <text
        x="78"
        y="45"
        fontSize="10"
        fontWeight="700"
        fill={STROKE}
        stroke="none"
        fontFamily="Arial, sans-serif"
      >
        z
      </text>
      <text
        x="85"
        y="34"
        fontSize="13"
        fontWeight="700"
        fill={STROKE}
        stroke="none"
        fontFamily="Arial, sans-serif"
      >
        Z
      </text>
      <text
        x="94"
        y="23"
        fontSize="16"
        fontWeight="700"
        fill={STROKE}
        stroke="none"
        fontFamily="Arial, sans-serif"
      >
        Z
      </text>
    </svg>
  )
}

// 打开的纸箱 + 上方放射短线（惊喜开箱），箱体浅紫、白色标签
export function BoxOpenIll({ className }: IllProps) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      stroke={STROKE}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* 放射短线 */}
      <path d="M42 40 L34 28" strokeWidth={2.5} />
      <path d="M52 36 L48 22" strokeWidth={2.5} />
      <path d="M68 36 L72 22" strokeWidth={2.5} />
      <path d="M78 40 L86 28" strokeWidth={2.5} />

      {/* 箱子后壁（开口内可见） */}
      <path d="M30 66 L36 54 L84 54 L90 66 Z" fill={PURPLE_DEEP} />

      {/* 向外打开的左右翻盖 */}
      <path d="M30 66 L12 48 L24 40 L40 58 Z" fill={PURPLE_LIGHT} />
      <path d="M90 66 L108 48 L96 40 L80 58 Z" fill={PURPLE_LIGHT} />

      {/* 箱体 */}
      <rect x="30" y="66" width="60" height="34" rx="3" fill={PURPLE} />

      {/* 白色标签 */}
      <rect x="44" y="76" width="28" height="16" rx="2" fill={WHITE} strokeWidth={1.75} />
      <path d="M49 82 L61 82 M49 86 L67 86" strokeWidth={1.5} />
    </svg>
  )
}

// 台历（螺旋圈 + 格子）+ 左下角秒表
export function CalendarClockIll({ className }: IllProps) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      stroke={STROKE}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* 台历本体 */}
      <rect x="36" y="26" width="66" height="62" rx="6" fill={PURPLE} />

      {/* 螺旋圈 */}
      <circle cx="48" cy="25" r="3.5" fill={WHITE} />
      <circle cx="62" cy="25" r="3.5" fill={WHITE} />
      <circle cx="76" cy="25" r="3.5" fill={WHITE} />
      <circle cx="90" cy="25" r="3.5" fill={WHITE} />

      {/* 格子 */}
      <path d="M36 42 H102" strokeWidth={1.5} />
      <path d="M36 60 H102" strokeWidth={1.5} />
      <path d="M36 76 H102" strokeWidth={1.5} />
      <path d="M52.5 42 V88 M69 42 V88 M85.5 42 V88" strokeWidth={1.5} />

      {/* 秒表（叠在台历左下角） */}
      <rect x="25" y="57" width="10" height="6" rx="2" fill={WHITE} strokeWidth={1.75} />
      <path d="M30 63 L30 68" strokeWidth={3} />
      <circle cx="30" cy="85" r="17" fill={WHITE} />
      <path d="M30 72 L30 75" strokeWidth={1.75} />
      <path d="M30 85 L30 75" strokeWidth={2.25} />
      <path d="M30 85 L37 89" strokeWidth={2.25} />
    </svg>
  )
}

// 手指点击手机屏幕，手机旁气泡 "..."
export function PhoneTapIll({ className }: IllProps) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      stroke={STROKE}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* 手机 */}
      <rect x="40" y="20" width="44" height="82" rx="9" fill={PURPLE} />
      <rect x="45.5" y="29" width="33" height="64" rx="4" strokeWidth={1.5} />
      <path d="M56 24.5 L68 24.5" strokeWidth={2} />
      <path d="M57 97 L67 97" strokeWidth={2} />

      {/* 点击涟漪 */}
      <path d="M50 34 A13 13 0 0 1 74 34" strokeWidth={2} />
      <path d="M55 37 A8 8 0 0 1 69 37" strokeWidth={2} />

      {/* 伸出的手指 */}
      <path d="M56 62 L56 47 Q56 41 62 41 Q68 41 68 47 L68 60 Z" fill={WHITE} />

      {/* 手握拳 */}
      <path
        d="M52 62 Q50 76 56 82 Q64 87 71 82 Q77 76 73 62 Z"
        fill={PURPLE}
      />
      <path d="M60 68 L60 78 M66 68 L66 78" strokeWidth={1.5} />

      {/* "..." 气泡 */}
      <rect x="88" y="38" width="28" height="20" rx="9" fill={WHITE} />
      <path d="M93 57.5 L89 65 L99 58.5 Z" fill={WHITE} strokeWidth={1.75} />
      <circle cx="96" cy="48" r="1.7" fill={STROKE} strokeWidth={1} />
      <circle cx="102" cy="48" r="1.7" fill={STROKE} strokeWidth={1} />
      <circle cx="108" cy="48" r="1.7" fill={STROKE} strokeWidth={1} />
    </svg>
  )
}

// 叠起来的三张文件纸（描边风）
export function FilesStackIll({ className }: IllProps) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      stroke={STROKE}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="40" y="20" width="48" height="48" rx="4" fill={WHITE} />
      <rect x="36" y="30" width="48" height="48" rx="4" fill={WHITE} />
      <rect x="32" y="40" width="48" height="48" rx="4" fill={PURPLE} />
      <path d="M40 52 L72 52 M40 60 L72 60 M40 68 L64 68" strokeWidth={2} />
    </svg>
  )
}
