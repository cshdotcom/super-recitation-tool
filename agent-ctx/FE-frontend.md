# Task ID: FE — Frontend of 超级背书工具 (Super Recitation Tool)

## Agent
FE (Frontend agent). Built the complete UI for the Next.js 16 App Router + TypeScript + Tailwind 4 + shadcn/ui "超级背书工具" (AI-powered recitation / memorization tool).

## Scope
Created / modified ONLY frontend files. Did NOT touch:
- `src/app/api/**` (BE agent owns these)
- `src/lib/zai.ts`, `src/lib/ai.ts`, `src/lib/db.ts`, `prisma/**` (backend libs)
- `package.json`, `next.config.ts`, `tailwind.config.ts`, `eslint.config.mjs`
- `src/lib/types.ts`, `src/lib/cloze.ts`, `src/lib/utils.ts` (already provided — imported as-is)

## Files created / modified
1. `src/app/layout.tsx` — **MODIFIED**. Kept Geist + Geist_Mono fonts. New metadata (title "超级背书工具 · AI 记忆背诵助手"). Wrapped body children in `<ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>`. Replaced old radix `Toaster` with sonner `Toaster` from `@/components/ui/sonner` (`richColors position="top-center"`). `<html lang="zh-CN" suppressHydrationWarning>`.
2. `src/components/theme-provider.tsx` — **CREATED**. Thin wrapper over `next-themes` `NextThemesProvider`.
3. `src/components/theme-toggle.tsx` — **CREATED**. `'use client'`. Hydration-safe Sun/Moon toggle button using `useTheme()`. `variant="ghost" size="icon"`.
4. `src/components/recitation/card-list.tsx` — **CREATED**. Sidebar with "新建背书卡" primary button, count badge, `ScrollArea max-h-[60vh]` list of cards with relative-time meta (`date-fns` `formatDistanceToNow` + `zhCN` locale), trash-icon with `AlertDialog` confirm, emerald highlight for active card, empty state.
5. `src/components/recitation/import-panel.tsx` — **CREATED**. Card with 4 method chips (粘贴/上传图片识别/上传 .txt/新建空白), hidden file inputs, large `Textarea min-h-[240px]`, OCR via `POST /api/ocr` FormData, .txt reading via `file.text()`, AI title via `POST /api/title`, char count, primary "开始背诵" pill button, framer-motion fade-in.
6. `src/components/recitation/cloze-renderer.tsx` — **CREATED**. Renders paragraphs from `splitParagraphs(content)`. Two modes:
   - **Non-manual**: uses `tokenize(para, keywords)` → segments. Each blank gets a global running index. Hidden underline (`border-b-2 border-dashed border-foreground/40` + `&nbsp;`×len), hidden highlight (`bg-emerald-500/15` + `text-transparent`). Revealed underline → `bg-amber-200/60`, revealed highlight → `bg-emerald-500/20 text-emerald-700`. Clicking reveals.
   - **Manual mode**: split into word/sep tokens via `[\u4e00-\u9fff\u3400-\u4dbf]+|[A-Za-z0-9]+`. Keyword words render as blanks (click to REMOVE); plain words render as clickable hover-underline text (click to ADD). All keyboard-accessible.
7. `src/components/recitation/study-view.tsx` — **CREATED**. Main study orchestrator card. Editable title (click → Input), meta badges (字数, 挖空数), AI 标题 button, 编辑内容 button. Toolbar with `ToggleGroup type="single"` for cloze mode (AI/manual/rule), `Select` for rule step (2/3/4/5) + 应用 button using `ruleCloze`, AI 快速挖空 button (`POST /api/cloze`), 显示答案 `Switch`, style `ToggleGroup` (下划线/高亮), 清空挖空 button, divider, then enabled tool buttons filtered by `settings.tools`. Renders `<ClozeRenderer>` in a centered readable area. "重置已揭示" button when `revealed.size>0` and `!showAnswers`. Calls `onUpdate` (debounced in parent) for keyword/title persistence; `onChangeStyle` / `onToggleShowAnswers` for settings persistence.
8. `src/components/recitation/tools-sheet.tsx` — **CREATED**. `Sheet` side="right" with width adapting to active tool (`sm:max-w-lg` when tool active). When `tool===null`: grid of enabled tools (filtered by `settings.tools`) with lucide icons (Volume2, Mic, FileQuestion, GraduationCap, MessageCircleQuestion, Network). Otherwise renders the matching tool subcomponent. Back button when active. Muted empty state when no card.
9. `src/components/recitation/tts-player.tsx` — **CREATED**. `Select` voice (from `TTS_VOICES`), `Slider` 0.5–2.0 step 0.1 for speed, "朗读全文" emerald button → `POST /api/tts` JSON → `res.blob()` → `URL.createObjectURL` → `<audio controls>` auto-play. Re-generate ghost button. Char count note.
10. `src/components/recitation/asr-recorder.tsx` — **CREATED**. Big round mic button (pulses red when recording, emerald when idle). `navigator.mediaDevices.getUserMedia({audio:true})` → `MediaRecorder` (prefer `audio/webm`) → `Blob` → `POST /api/asr` FormData('file', blob, 'rec.webm'). Uses `similarity(originalText, text)` from `@/lib/cloze` for score, `normalize()` for keyword containment check. Result card with big score (emerald ≥80, amber ≥60, red else), matched/missed keyword badges, transcribed text box, "再录一次" button. Timer while recording. Mic permission errors handled with toast. Cleanup on unmount.
11. `src/components/recitation/quiz-panel.tsx` — **CREATED**. "生成练习题" emerald button → `POST /api/quiz` {content, keywords, count:5}. Renders list with type Badge (填空 amber / 选择 emerald / 简答 secondary). Choice: option buttons with emerald-correct / destructive-wrong styling when revealed. Fill/short: `Input` + revealable 参考答案 box. Per-question "查看答案/隐藏答案" toggle. Footer score row. "清空答题" button.
12. `src/components/recitation/chat-tool.tsx` — **CREATED**. For `mode='supervise'`: auto-seeds initial assistant greeting by sending "开始背诵吧，请引导我。" on mount (guarded by ref). For `mode='ask'`: shows hint, no auto-seed. Messages list with user (right, `bg-primary`) / assistant (left, `bg-muted`) bubbles. Typing indicator with three bouncing dots. Auto-scroll to bottom on new message. Enter-to-send input row. Sends full message history (typed as `ChatMessage[]`) to `POST /api/chat` with `{mode, messages, content}`.
13. `src/components/recitation/mindmap-view.tsx` — **CREATED**. "生成思维导图" emerald button → `POST /api/mindmap` {content}. Renders recursive tree: root as emerald pill, children as `MindmapNode` sub-component with `border-l-2 border-emerald-500/30 pl-3` connectors, collapsible via chevron click.
14. `src/components/recitation/settings-sheet.tsx` — **CREATED**. `Sheet` side="right" `sm:max-w-md`. Three sections separated by `Separator`:
    - **显示设置**: `RadioGroup` for clozeStyle (下划线/高亮) with live previews; `Switch` for showAnswers.
    - **背书工具**: row + `Switch` for each of 6 tools.
    - **AI 模型**: `RadioGroup` (z-ai SDK 默认 / 第三方 OpenAI 兼容 API). When custom: `Input` baseURL, `Input type="password"` apiKey, `Input` model. Helper text explaining which features use which provider.
    Footer: 保存 (PATCH `/api/settings`) + 重置默认 ghost.
15. `src/app/page.tsx` — **REWRITTEN**. `'use client'` orchestrator. State: `cards`, `currentCard`, `settings`, `editing` + `draft`, sheet open flags. Loads `GET /api/cards` + `GET /api/settings` in parallel on mount (skeleton fallback). Layout: sticky header (`BookOpenText` emerald + 超级背书 + AI 记忆背诵 Badge + ThemeToggle + 设置), `main` with `grid md:grid-cols-[260px_1fr]` (CardList sidebar + main content), sticky footer with `mt-auto`. Debounced 700ms PATCH on card updates via `setTimeout` ref. Handler for new/select/delete/import/edit/settings-save/style-change/show-answers-toggle. Renders `<ToolsSheet>` + `<SettingsSheet>` at root.

## API contract consumed (all relative `fetch`)
- `GET /api/cards` → `{ cards }`
- `POST /api/cards` `{title, content, keywords}` → `CardData`
- `GET /api/cards/[id]` → `CardData`
- `PATCH /api/cards/[id]` `{title?, content?, keywords?}` → `CardData`
- `DELETE /api/cards/[id]` → `{ok}`
- `POST /api/ocr` FormData `file` → `{text}`
- `POST /api/cloze` `{content}` → `{keywords}`
- `POST /api/title` `{content}` → `{title}`
- `POST /api/tts` `{text, voice?, speed?}` → `audio/mpeg` blob
- `POST /api/asr` FormData `file` → `{text}`
- `POST /api/chat` `{mode, messages, content}` → `{reply}`
- `POST /api/quiz` `{content, keywords?, count?}` → `{questions}`
- `POST /api/mindmap` `{content}` → `{mindmap}`
- `GET /api/settings` → `SettingsData`
- `PATCH /api/settings` partial → `SettingsData`

## Design language adherence
- Neutral palette via `bg-background` / `text-foreground` / `bg-card` / `border-border` / `text-muted-foreground`. No indigo, no blue.
- Primary actions: `bg-primary text-primary-foreground` black pill buttons (`rounded-full px-5`).
- AI accent = emerald (`text-emerald-600`, `bg-emerald-500/10`, `bg-emerald-600 text-white`).
- Blanks two styles as specified: underline (dashed `border-foreground/40` + `&nbsp;` fill) and highlight (`bg-emerald-500/15` + `text-transparent`). Revealed: amber for underline, emerald for highlight. All clickable.
- Cards `rounded-2xl border bg-card`. Padding `p-3`/`p-4`/`p-6`. Gaps `gap-3`/`gap-4`.
- Responsive `md:grid-cols-[260px_1fr]`; sidebar stacks above content on mobile.
- Sticky footer via root `min-h-screen flex flex-col` + `footer mt-auto`.
- `sonner` toasts (`toast.success/error/loading/warning/info`).
- Semantic `<header>`, `<main>`, `<footer>`.
- Subtle framer-motion fade/slide on `import-panel` and `study-view`.
- Chinese throughout (labels, toasts, hints).
- Mobile-first; touch targets ≥ 36px.

## Verification
- `bun run lint` → **0 errors, 0 warnings** (clean).
- `curl http://localhost:3000/` → HTTP 200, page renders "超级背书", "AI 记忆背诵", "我的背书卡", "新建背书卡", "开始你的第一次背诵" strings all present.
- Dev server log shows `✓ Compiled in 3.8s` then `✓ Compiled in 139ms` with no errors after edits.

## Critical rules honored
- All stateful/browser-API components start with `'use client'`.
- **No `z-ai-web-dev-sdk` import anywhere in `src/components/**` or `src/app/**`** — verified via grep. All AI calls go through relative `fetch('/api/...')`.
- All fetch paths are RELATIVE (`/api/cards`, `/api/tts`, etc.) — never absolute URLs, never ports.
- Reused existing shadcn/ui components (Button, Card, Input, Textarea, Label, Badge, Switch, Select, Slider, ScrollArea, Separator, ToggleGroup, RadioGroup, Sheet, AlertDialog, Skeleton, Sonner Toaster) — did NOT rebuild any.
- `cn` from `@/lib/utils` for conditional classes throughout.
- TypeScript strict, typed props (no `any`).
- `date-fns` `formatDistanceToNow` + `zhCN` locale for relative dates.
- Did NOT write tests. Did NOT run `bun run build`. Did NOT modify `package.json` or backend files.
- Welcome state (no current card) renders `ImportPanel welcome`. Fully responsive.
- Sticky footer at bottom with `mt-auto` inside `min-h-screen flex flex-col` root.

## Deviations from spec
- None of substance. Minor: in `chat-tool.tsx` I auto-seed the supervise greeting via a `seededRef` guard inside a `useEffect` (instead of inside `useCallback`'s body), and added `send` to the dep array (lint-clean). Same observable behavior.
- `study-view.tsx` keeps `content` from `card.content` as a `useState` initialized once (synced via effect on `card.id`); since the spec only edits content via `onEdit` → parent toggles `editing=true` → ImportPanel (which POSTs a new content via PATCH on import), content is read-only inside StudyView itself, matching the spec ("编辑内容" ghost button → `onEdit`).
- Quiz "正确 X / Y" counts only choice auto-eval + fill/short self-checked-via-reveal with exact-match answer; this is the simplest interpretation per spec.

## Final note
No z-ai SDK is imported client-side. All AI calls go through `fetch('/api/...')` relative paths.
