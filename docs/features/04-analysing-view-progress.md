# Analysing view & SSE progress

> Status: stable
> Key files: `src/views/analysing.tsx`, `src/lib/api.ts` (`realAnalyseManuscript`, `AnalysisError`)
> URL surface: `#/books/:bookId/analysing`
> OpenAPI ops: `POST /api/manuscripts/:id/analysis` (SSE stream)

## What this covers

Server-sent-events stream rendering for the two-stage analysis pipeline. Phase ticks drive a multi-step progress bar; structured `live` payloads on each phase tick surface the active chapter + elapsed-of-estimate ETA so the user sees liveness between log entries. The view supports model selection (via the re-parse dialog) and a "Start fresh" toggle that discards any cached partial progress.

## Invariants to preserve

- Stream event union: `{ kind: 'phase' | 'log' | 'result' | 'error', ... }` (`src/lib/api.ts:397-410`). Frontend handlers must accept each kind; unknown kinds are ignored, not thrown.
- `live` payload shape: `{ chapterIndex, totalChapters, chapterTitle, elapsedMs, estMs }` (`src/lib/api.ts:55-61`). All five fields are required when `live` is present.
- Request body is omitted entirely when neither `model` nor `fresh` is set; included only when one is (`src/lib/api.ts:424-429`). Do not always send a body — manual-mode servers may not parse JSON.
- `AnalysisError` carries `code` (e.g. `'rate_limit'`, `'auth'`, `'unknown'`) and optional structured `detail` (e.g. Google's `status` + `details[]`) (`src/lib/api.ts:412-421`). UI surfaces the headline message inline and the `detail` in a collapsible block.
- SSE frame format is `data: <json>\n\n`; multiple `data:` lines per frame join with `\n` (`src/lib/api.ts:458-468`). Do not change the splitter.
- "Start fresh" sets `fresh: true` in the request body; the server discards any partial progress before re-running (no resume).

## Acceptance walkthrough

Run with `VITE_USE_MOCKS=false` (server on `:8080`, `ANALYZER=manual` or `ANALYZER=gemini`).

1. **Land on `#/books/:bookId/analysing` after upload** → stream opens; phase 1 progress bar starts ticking. Log lines appear under the active phase (e.g. "Detected 23 characters across 14 chapters").
2. **Live ETA** — during stage-2 chapter processing, the `live` block shows `"Chapter 4 of 14 — Mara at the Cliff · 32s elapsed / ~58s est"`. The progress bar reflects `elapsedMs / estMs`.
3. **Stream ends with a `result` event** → frontend dispatches `analysisComplete({ bookId })`; URL transitions to `#/books/:bookId/confirm`.
4. **Force a server error** (kill the analyzer mid-stream, or hit Gemini without `GEMINI_API_KEY`) → stream emits `{ kind: 'error', code, message, detail }`; UI shows the message inline with an expandable "Details" block; user can click "Start fresh" to retry.
5. **Click "Start fresh"** from the re-parse dialog → request body includes `{ fresh: true }`; server discards cached partials and re-runs from phase 1.
6. **Pick a model** from the re-parse dialog (e.g. `gemma-3-27b`) → request body includes `{ model: 'gemma-3-27b' }`; subsequent analysis uses that model. `ui.selectedModel` updates.
7. **Cancel mid-stream** (navigate away) → stream connection closes; no further ticks. Returning to `#/books/:bookId/analysing` resumes a fresh stream (server decides whether to resume from cache or restart).
8. **Empty result** — if the analyzer returns zero characters or zero chapters, the stream still emits a `result` event; frontend transitions to `confirm` with an empty cast and the user sees an empty state in the confirm view (no crash).

## Out of scope

- Specific phase timings or labels — those are server-driven.
- Resumability of partial progress — depends on analyzer mode (covered in `05-analyzer-manual-handoff.md` and `06-analyzer-gemini.md`).
- Network reconnection — stream errors are surfaced, not silently retried.
