# Task BE — Backend API routes for 超级背书工具

**Agent**: BE (backend)
**Status**: ✅ Complete
**Scope**: All server-only API routes + settings/card serializers. Frontend untouched.

## Files created
1. `src/lib/settings.ts` — singleton settings helpers (`getSettings`, `parseSettings`, `getAIConfig`)
2. `src/lib/card.ts` — `serializeCard` (Prisma row → JSON-safe `CardData`)
3. `src/app/api/cards/route.ts` — `GET` list / `POST` create
4. `src/app/api/cards/[id]/route.ts` — `GET` / `PATCH` / `DELETE` (params awaited as Promise per Next.js 16)
5. `src/app/api/ocr/route.ts` — image OCR via `zai.chat.completions.createVision`
6. `src/app/api/cloze/route.ts` — AI auto cloze; falls back to `ruleCloze` on parse failure
7. `src/app/api/title/route.ts` — auto title generation (≤12 chars)
8. `src/app/api/tts/route.ts` — chunked MP3 synthesis, ≤900 chars per chunk
9. `src/app/api/asr/route.ts` — base64 audio → `{ text }`
10. `src/app/api/chat/route.ts` — `supervise` / `ask` modes, multi-turn
11. `src/app/api/quiz/route.ts` — `fill` / `short` / `choice` quiz, default 5 questions
12. `src/app/api/mindmap/route.ts` — 2-level mind-map JSON
13. `src/app/api/settings/route.ts` — `GET` / `PATCH` (upsert singleton)

## Verification
- `bun run lint` → **EXIT 0**, zero warnings/errors.
- `tsc --noEmit` → only 3 pre-existing errors in `examples/` and `skills/` dirs (out of scope).
- Dev server log shows "Compiled in 139ms" — no compile errors from these files.

## Notes for downstream agents (frontend)
- All AI routes return `{ error: string }` with HTTP 500 on failure — toast on `error` field.
- `GET /api/cards` returns `{ cards: CardData[] }`; single-card `GET` returns the card object directly.
- `POST /api/cards` returns the created `CardData` with status 201.
- `PATCH /api/cards/:id` accepts partial fields `{ title?, content?, keywords?: string[] }` — keywords are auto `JSON.stringify`-ed server-side; just send a string array.
- `POST /api/tts` returns binary `audio/mpeg` (not JSON). On error returns JSON `{ error }` with 500 — handle non-OK responses before reading the blob.
- `POST /api/ocr` and `POST /api/asr` expect `multipart/form-data` with a `file` field.
- `POST /api/cloze` for content <20 chars returns `{ keywords: [] }` (skips LLM).
- `POST /api/chat` accepts `{ mode, messages: ChatMessage[], content }` and returns `{ reply }`.
- `POST /api/quiz` accepts `{ content, keywords?, count? }` (count clamped to [1,10], default 5), returns `{ questions: QuizQuestion[] }`.
- `POST /api/mindmap` returns `{ mindmap: MindNode }`.
- `GET /api/settings` returns `SettingsData`; `PATCH /api/settings` accepts any subset of `{ clozeStyle, showAnswers, tools: ToolToggles, aiProvider, aiBaseURL, aiApiKey, aiModel }` — tools are merged with `DEFAULT_TOOLS` server-side.

## Deviations from spec
- `/agent-ctx` is **not writable** by my user account (`z`, uid 1001). Created this record at `/home/z/my-project/agent-ctx/BE-backend.md` as an accessible fallback — same content.
- `createVision` requires a `model` field per the SDK type defs; added `model: 'glm-4.6v'` (matching the existing `skills/VLM/scripts/vlm.ts` reference). The spec omitted `model` — without it the SDK call would still work at runtime (the field is sent to the server), but including it keeps TypeScript happy.
- TTS route adds a `Content-Length` header (harmless addition; helps some clients show progress).
- z-ai SDK is used **server-side only** (in `src/lib/zai.ts`, `src/lib/ai.ts`, and the `ocr` / `tts` / `asr` route handlers). `src/lib/cloze.ts`, `src/lib/card.ts`, `src/lib/types.ts` remain client-safe.
