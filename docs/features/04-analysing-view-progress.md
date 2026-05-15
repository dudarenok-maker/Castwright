# Analysing view & SSE progress

> Status: stable
> Key files: `src/views/analysing.tsx`, `src/lib/api.ts` (`realAnalyseManuscript`, `AnalysisError`)
> URL surface: `#/books/:bookId/analysing`
> OpenAPI ops: `POST /api/manuscripts/:id/analysis` (SSE stream)

## What this covers

Server-sent-events stream rendering for the two-stage analysis pipeline. Phase ticks drive a multi-step progress bar; structured `live` payloads on each phase tick surface the active chapter + elapsed-of-estimate ETA so the user sees liveness between log entries. The view supports model selection (via the re-parse dialog) and a "Start fresh" toggle that discards any cached partial progress.

## Invariants to preserve

- Stream event union: `{ kind: 'phase' | 'log' | 'result' | 'error', ... }` (`src/lib/api.ts:397-410`). Frontend handlers must accept each kind; unknown kinds are ignored, not thrown.
- `live` payload shape: `{ totalChapters, chapters: AnalysisLiveChapter[] }` where each in-flight chapter is `{ chapterIndex, chapterTitle, elapsedMs, estMs }` (`src/lib/api.ts:55-70`). The server emits one entry per chapter currently in flight, sorted by `chapterIndex` ascending; the UI renders one row per chapter so a stuck chapter doesn't visually mask the others making progress.
- Request body is omitted entirely when neither `model` nor `fresh` is set; included only when one is (`src/lib/api.ts:424-429`). Do not always send a body — manual-mode servers may not parse JSON.
- `AnalysisError` carries `code` (e.g. `'rate_limit'`, `'auth'`, `'unknown'`) and optional structured `detail` (e.g. Google's `status` + `details[]`) (`src/lib/api.ts:412-421`). UI surfaces the headline message inline and the `detail` in a collapsible block.
- SSE frame format is `data: <json>\n\n`; multiple `data:` lines per frame join with `\n` (`src/lib/api.ts:458-468`). Do not change the splitter.
- "Start fresh" sets `fresh: true` in the request body; the server discards any partial progress before re-running (no resume).
- **Phase 0 cast roster persists as a visible outcome.** Once `cast-update` events have populated the cast slice, the chip list under the Phase 0 row stays visible even after Phase 0 completes — including the cached-resume fast path that fires after a model switch, where the server only re-emits a single "Phase 0 already complete" log line. The roster is Phase 0's outcome and must not vanish when the active phase advances.
- **Phase 1 cannot start while any chapter is missing its cast.** When `cache.failedChapterIds` is non-empty at the end of Phase 0a, the main analysis route emits `{ kind: 'error', code: 'cast_incomplete', ... }` and ends without writing `cache.stage1` (`server/src/routes/analysis.ts` — search "Phase 1+ MUST NOT advance"). The view treats this code specially: no red error banner, `castIncomplete` flag set, retry buttons in the failed-chapter panel are clickable, and once `failedChapters` drains to 0 the auto-resume effect re-fires `/analysis/stream` so Phase 1 picks up automatically.
- **Failed-chapter Retry button is clickable mid-stream.** The original guard disabled it while `conn === 'streaming'`, citing Ollama VRAM contention — but Ollama just serialises chats and Gemini has no such conflict. Today only an in-flight retry of THAT chapter disables it; only one chapter can retry at a time (`retryingChapterId` tracks the active one). While the main run is in flight the retry handler skips `conn`/`phase`/`heartbeat` writes so it doesn't flicker the main run's indicators.
- **Dropped-quote ledger is append-only.** Each Phase 0 verify pass that drops at least one quote appends a batch to `.audiobook/dropped-quotes.json` (envelope shape in `server/src/store/dropped-quotes.ts`). Both analysis routes write — they share the `persistDroppedQuotesBatch` helper so the field names stay aligned. Quotes are capped at `MAX_QUOTE_CHARS` (2000) with a `truncated: true` flag; reasons are enumerated (`not_in_source` | `empty_after_normalisation`) from the single conditional in `verifyEvidenceAgainstSource`. The analysing view's `DroppedQuotesPanel` reads the latest batch only via `GET /api/books/:bookId/dropped-quotes` and groups entries by character — no Restore button in Phase 1; this is a read-only audit surface for tuning the verifier prompt.

## Acceptance walkthrough

Run with `VITE_USE_MOCKS=false` (server on `:8080`, `ANALYZER=manual` or `ANALYZER=gemini`).

1. **Land on `#/books/:bookId/analysing` after upload** → stream opens; phase 1 progress bar starts ticking. Log lines appear under the active phase (e.g. "Detected 23 characters across 14 chapters").
2. **Live ETA** — during stage-2 chapter processing, the `live` block shows one row per in-flight chapter, e.g. `"Chapter 2/7 · DAY ONE · 4:15 of ~0:21 over budget"` on top of `"Chapter 7/7 · DAY SIX · 0:08 of ~2:03"`. Rows are sorted by chapter order so a slow chapter cannot hide concurrent progress.
3. **Stream ends with a `result` event** → frontend dispatches `analysisComplete({ bookId })`; URL transitions to `#/books/:bookId/confirm`.
4. **Force a server error** (kill the analyzer mid-stream, or hit Gemini without `GEMINI_API_KEY`) → stream emits `{ kind: 'error', code, message, detail }`; UI shows the message inline with an expandable "Details" block; user can click "Start fresh" to retry.
5. **Click "Start fresh"** from the re-parse dialog → request body includes `{ fresh: true }`; server discards cached partials and re-runs from phase 1.
6. **Pick a model** from the re-parse dialog (e.g. `gemma-3-27b`) → request body includes `{ model: 'gemma-3-27b' }`; subsequent analysis uses that model. `ui.selectedModel` updates.
7. **Cancel mid-stream** (navigate away) → stream connection closes; no further ticks. Returning to `#/books/:bookId/analysing` resumes a fresh stream (server decides whether to resume from cache or restart).
8. **Empty result** — if the analyzer returns zero characters or zero chapters, the stream still emits a `result` event; frontend transitions to `confirm` with an empty cast and the user sees an empty state in the confirm view (no crash).
9. **Per-chapter failure → paused, awaiting retry** — when a Gemini 5xx (or analyzer JSON repair miss) trips a single chapter's cast detection, the stream continues past that chapter, records it in `cache.failedChapterIds`, and emits `chapter-failed` for the UI. At the end of Phase 0a, if any chapter is still failed, the route emits `{ kind: 'error', code: 'cast_incomplete' }` and ends without advancing to Phase 1. The failed-chapter panel renders with "Paused — N chapter(s) still need cast detection" and active Retry buttons. Clicking Retry hits the subset endpoint; on success the row disappears. Once every failed chapter resolves the view auto-fires a fresh `/analysis/stream` that advances to Phase 1 — the user never has to click "Try again" themselves.
10. **Retry mid-stream** — failed-chapter rows can appear while Phase 0 is still streaming other chapters. The Retry button stays clickable; firing one runs the subset endpoint in parallel with the main stream. The subset endpoint's `chapter-failed` re-emission upserts the row (with the fresh error message); a clean success drops the row.
11. **Dropped-quote panel** — after the verify pass at the end of Phase 0, the panel under the cast preview surfaces any quotes the verifier rejected (model fabrications). Two reasons render: "not in source" (stitched dialogue or hallucinated lines) and "empty after normalisation" (pure punctuation / whitespace). PowerShell audit: `Get-Content .audiobook/dropped-quotes.json | ConvertFrom-Json`. Grep into `.batches[-1].entries` for the latest pass; the array grows on every run.

## Out of scope

- Specific phase timings or labels — those are server-driven.
- Resumability of partial progress — depends on analyzer mode (covered in `05-analyzer-manual-handoff.md` and `06-analyzer-gemini.md`).
- Network reconnection — stream errors are surfaced, not silently retried.
