# Generation stream

> Status: stable
> Key files: `src/views/generation.tsx`, `src/store/chapters-slice.ts` (`applyGenerationTick`, `regenerateChapter`/`regenerateCharacter`/`batchRegenerateCharacters`), `src/lib/api.ts` (`realStreamGeneration`), `server/src/routes/generation.ts`, `server/src/routes/chapter-audio.ts`, `server/src/tts/synthesise-chapter.ts`, `server/src/tts/mp3.ts`, `server/src/workspace/chapter-audio-file.ts`
> URL surface: `#/books/:bookId/generate`
> OpenAPI ops: `POST /api/books/:bookId/generation` (SSE stream), `GET /api/books/:bookId/chapters/:chapterId/audio` (segments JSON), `GET /api/books/:bookId/chapters/:chapterId/audio.mp3` (range-supporting MP3, new generations), `GET /api/books/:bookId/chapters/:chapterId/audio.wav` (range-supporting WAV, legacy)
> Paired tests: `src/store/chapters-slice.test.ts`, `server/src/routes/chapter-audio.test.ts`, `server/src/tts/mp3.test.ts`
> Cross-links: [28 — Chapter audio format](28-chapter-audio-format.md)

## What this covers

Streams chapter audio generation via Server-Sent-Events. The client opens a long-running POST with `{ modelKey, chapterIds?, force? }`; the server iterates chapters, synthesises each character's same-speaker groups via the chosen TTS provider, emits ticks for progress / assembling / completion / failure / idle, and on `chapter_complete` encodes the concatenated PCM to MP3 (LAME VBR V2 via system ffmpeg — see [plan 28](28-chapter-audio-format.md) for the format contract) and writes `<slug>.mp3` + `<slug>.segments.json`. The client maps ticks into per-chapter/per-character state transitions in the chapters slice, plays the resulting MP3 via the MiniPlayer, and forwards a `pendingRegen` spec on the next stream open when the user regenerates.

## Invariants to preserve

- `realStreamGeneration` returns a canceller function that calls `controller.abort()`; aborts surface as DOMException `AbortError` and are NOT mapped to a failure tick. Treat abort as "the canceller did its job."
- `GenerationTick` union: `'progress' | 'chapter_assembling' | 'chapter_complete' | 'chapter_failed' | 'idle'`. Payload fields per type:
  - `progress` → `chapterId, characterId, progress, currentLine, totalLines`. One emitted per same-speaker group; `characterId` is the live speaker.
  - `chapter_assembling` → `chapterId` (required); `totalGroups?`, `durationSec?` carry the run summary about to land on disk. Fired between the last group and the MP3 encode + write (encoder + atomic-rename detail in [plan 28](28-chapter-audio-format.md)).
  - `chapter_complete` → `chapterId`; `totalLines` optional.
  - `chapter_failed` → either `chapterId + errorReason` (per-chapter synth failure), OR **no `chapterId`** with `errorReason` (stream-level setup error: modelKey rejected, cast missing, sidecar down). The chapter-less form populates `chaptersState.lastError` and flips the currently in-flight chapter to `failed`.
  - `idle` → no extra fields. Fired when the server has nothing to do.
- SSE frame format mirrors analysis stream: `data: <json>\n\n`, `\n`-joined multi-line `data:`.
- `chapterIds?: number[]` — optional subset; when absent, server defaults to "all chapters lacking audio on disk."
- `force?: boolean` — when true, re-synthesises chapters even if a `.mp3` or legacy `.wav` already exists for that chapter (`chapterAudioExists` in `server/src/workspace/chapter-audio-file.ts` is the format-agnostic predicate).
- Per-character state inside a chapter: `queued` → `in_progress` → `done` | `skipped`. `applyGenerationTick` uses the tick's real `characterId` to flip exactly one character to `in_progress`; any other character previously marked `in_progress` flips to `done`. `skipped` is preserved.
- The next-chapter auto-promote is driven by the server's own `progress` tick for the next chapterId — the client does **not** auto-promote on `chapter_complete`.
- `Chapter.phase: 'assembling' | null` is a UI-only sub-state set on `chapter_assembling` and cleared on `chapter_complete` / `chapter_failed`. It lets the Generate view show a neutral striped bar + "Assembling…" pill instead of the synthesis gradient stuck near 99 %. Not part of the OpenAPI schema.
- `pendingRegen: { chapterIds, force: true } | null` is set by the three regenerate reducers (`regenerateChapter`, `regenerateCharacter`, `batchRegenerateCharacters`) and consumed by the Generate view, which forwards it to the next `streamGeneration` call. `regenEpoch` is a monotonic counter the view watches as a `useEffect` dep so a repeat regenerate (same chapter, same character) still re-opens the SSE. `pendingRegen` is cleared on the `idle` tick so it doesn't auto-replay; `regenEpoch` is never reset.
- `chaptersState.generationStartedAt` is set on the first `progress` or `chapter_assembling` tick of a run and drives the elapsed-based ETA. Cleared on `idle` when no chapter is `in_progress` or `queued`.
- Malformed ticks are logged and skipped; do not throw.

## Acceptance walkthrough

Run with `VITE_USE_MOCKS=false`, sidecar (or Gemini) up.

1. **Start generation from a freshly confirmed cast** → URL becomes `#/books/<id>/generate`; SSE stream opens; chapters list each show queued state for their characters.
2. **Per-character progress** — current chapter's character cards transition `queued → in_progress → done` driven by the tick's `characterId` (no client-side threshold inference). `currentLine / totalLines` updates inside `in_progress`.
3. **Assembling phase** — after the last per-group `progress` tick, a `chapter_assembling` tick fires. The chapter row shows a neutral ink-toned striped bar instead of the magenta synthesis gradient and an "Assembling…" pill; the expanded row shows "Writing chapter file…". Resolves to `done` on `chapter_complete`.
4. **Chapter complete** — chapter card shows "complete" badge; the MP3 exists on disk under `books/<Author>/<Series>/<Title>/audio/<chapter-slug>.mp3` (legacy chapters from before the format switch may still be `.wav` — see [plan 28](28-chapter-audio-format.md)). The next queued chapter starts automatically the moment the server emits its own `progress` tick for it; nothing on the client gates the promotion.
5. **Preview playback** — click Preview on a done row → `setCurrentTrack(chapterId)` dispatched; MiniPlayer mounts a real `<audio>` element backed by `GET /api/books/:bookId/chapters/:chapterId/audio.mp3` (or `audio.wav` for legacy chapters — the JSON metadata endpoint picks the suffix matching the on-disk file; range-supported, so seek works) and renders the segment colours from `GET .../audio` (JSON ChapterAudio).
6. **Per-chapter failure** — kill the TTS provider mid-chapter. Stream emits `chapter_failed` with `chapterId + errorReason`; that row goes red with the reason inline. Subsequent queued chapters are unaffected — the server may move on to the next chapter, in which case its `progress` ticks promote it as normal.
7. **Stream-level failure** — point the engine at a bad `modelKey` (or down the sidecar). Stream emits `chapter_failed` **without `chapterId`**; the dismissible error banner appears above the chapter list; the in-flight chapter flips to `failed`; queued chapters re-pill as "Blocked" until the banner is dismissed.
8. **Cancel mid-generation** — click Cancel / navigate away → `controller.abort()` fires; no error toast surfaces (per the abort exception filter). The next chapter does not start; in-progress chapter may finish if the server has already kicked off synthesis.
9. **Regenerate (this/forward/character/batch)** — one of the three regenerate reducers populates `pendingRegen` + bumps `regenEpoch` + clears `lastError` and `generationStartedAt`. The Generate view's `useEffect` re-opens the SSE with `{ chapterIds: pendingRegen.chapterIds, force: true }`. Spec is cleared on `idle`; `regenEpoch` keeps incrementing so a follow-up regenerate of the same target re-fires.
10. **Subset run** — start with `chapterIds: [5, 7, 9]` → only those chapters enter `in_progress`; others stay queued/unaffected.
11. **Idle tick** — when no chapter is in progress (mock mode polling or server breather), an `idle` tick fires; UI does not interpret it as failure. `pendingRegen` is cleared; `generationStartedAt` is cleared only if no chapter is `in_progress`/`queued`.

## Out of scope

- Chunked streaming for live playback during generation — current path encodes the whole MP3 then signals complete (atomic write via `<slug>.mp3.tmp-…` → `rename`).
- Multi-book parallel generation — single-book scope per stream.
- Resume after server restart — the next POST decides what's missing on disk and resumes from there.
