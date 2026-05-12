# Generation stream

> Status: stable
> Key files: `src/views/generation.tsx`, `src/store/chapters-slice.ts` (`applyGenerationTick`), `src/lib/api.ts` (`realStreamGeneration`), `server/src/routes/generation.ts`, `server/src/tts/synthesise-chapter.ts`
> URL surface: `#/books/:bookId/generate`
> OpenAPI ops: `POST /api/books/:bookId/generation` (SSE stream)

## What this covers

Streams chapter audio generation via Server-Sent-Events. The client opens a long-running POST with `{ modelKey, chapterIds?, force? }`; the server iterates chapters, synthesises each character's lines via the chosen TTS provider, and emits ticks for progress, completion, failures, and idle. The client maps ticks into per-chapter/per-character state transitions in the chapters slice.

## Invariants to preserve

- `realStreamGeneration` returns a canceller function that calls `controller.abort()`; aborts surface as DOMException `AbortError` and are NOT mapped to a failure tick (`src/lib/api.ts:583-587`). Treat abort as "the canceller did its job."
- `GenerationTick` union: `'progress' | 'chapter_complete' | 'chapter_failed' | 'idle'`. Required fields per type: `progress` → `chapterId, characterId, progress, currentLine, totalLines`; `chapter_complete` → `chapterId`; `chapter_failed` → `chapterId, errorReason`; `idle` → no extra fields.
- SSE frame format mirrors analysis stream: `data: <json>\n\n`, `\n`-joined multi-line `data:`.
- `chapterIds?: number[]` — optional subset; when absent, server defaults to "all chapters lacking audio on disk."
- `force?: boolean` — when true, re-synthesises chapters even if WAV already exists.
- Per-character state inside a chapter: `queued` → `in_progress` → `done` | `skipped`. `applyGenerationTick` advances state atomically.
- Malformed ticks are logged and skipped (`src/lib/api.ts:575-577`); do not throw.

## Acceptance walkthrough

Run with `VITE_USE_MOCKS=false`, sidecar (or Gemini) up.

1. **Start generation from a freshly confirmed cast** → URL becomes `#/books/<id>/generate`; SSE stream opens; chapters list each show queued state for their characters.
2. **Per-character progress** — current chapter's character cards transition `queued → in_progress → done`. `currentLine / totalLines` updates inside `in_progress`.
3. **Chapter complete** — chapter card shows "complete" badge; WAV exists on disk under `books/<Author>/<Series>/<Title>/.audiobook/chapters/<chapter-slug>.wav`.
4. **Failure recovery** — kill the TTS provider mid-chapter. Stream emits `chapter_failed` with `errorReason`; UI shows the error on the chapter card; next queued chapter does NOT start automatically. User can click Retry.
5. **Cancel mid-generation** — click Cancel / navigate away → `controller.abort()` fires; no error toast surfaces (per the abort exception filter). The next chapter does not start; in-progress chapter may finish if the server has already kicked off synthesis.
6. **Subset run** — start with `chapterIds: [5, 7, 9]` → only those chapters enter `in_progress`; others stay queued/unaffected.
7. **Force re-render** — re-run with `force: true` on a chapter that already has a WAV → server overwrites the existing file; stream emits `progress` ticks for re-synthesis.
8. **Idle tick** — when no chapter is in progress (mock mode polling or server breather), an `idle` tick fires; UI does not interpret it as failure.

## Out of scope

- Chunked WAV streaming for live playback during generation — current path writes the whole WAV then signals complete.
- Multi-book parallel generation — single-book scope per stream.
- Resume after server restart — the next POST decides what's missing on disk and resumes from there.
