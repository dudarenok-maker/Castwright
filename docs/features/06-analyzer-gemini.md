# Gemini analyzer (`ANALYZER=gemini`)

> Status: stable (opt-in)
> Key files: `server/src/analyzer/gemini.ts`, `server/src/analyzer/index.ts`, `server/src/handoff/schemas.ts`
> URL surface: indirect (`#/books/:bookId/analysing`)
> OpenAPI ops: `POST /api/manuscripts/:id/analysis`

## What this covers

Opt-in analyzer mode that hits the Gemini free-tier API directly instead of the manual file-drop loop. Same Zod schemas, same SSE stream surface — only the source of the JSON differs. Per-chapter stage-2 keeps each request under the context window and spreads rate-limit recovery time.

## Invariants to preserve

- Activated by env var `ANALYZER=gemini`; requires `GEMINI_API_KEY`. Without the key the analyzer fails fast at construction; do not fall back silently to manual mode.
- `GEMINI_MODEL` env var picks the model id; default `gemini-2.5-flash`. Switching to `gemini-3-flash` (when GA) requires only an env var change.
- Stage-1 + stage-2 responses are validated against the **same** Zod schemas as the manual analyzer (`server/src/handoff/schemas.ts`). A Gemini response that fails validation surfaces as an `AnalysisError` to the client, not a 500 with raw API output.
- Per-chapter stage-2 mode (current default): the analyzer iterates chapters and calls Gemini once per chapter. Whole-manuscript stage-2 (legacy) is still supported for tiny manuscripts but not the default.
- Rate-limit / quota / auth errors are mapped to `AnalysisError` with a structured `detail` field carrying Google's `status` + `details[]` envelope (`src/lib/api.ts:407-410` consumes this and renders the collapsible detail block).
- The Gemini analyzer must override `model` from the request body when present (used by the UI re-parse dialog to A/B between models without restarting the server).

## Acceptance walkthrough

Run server with `ANALYZER=gemini`, `GEMINI_API_KEY=<key>` in `server/.env`.

1. **Happy path** — upload a small manuscript; analysis completes end-to-end without any inbox/outbox interaction. UI shows phase progress + per-chapter live ETA.
2. **Per-chapter rate-limit** — issue several analyses back-to-back to trigger the free-tier rate limit. Stream emits `{ kind: 'error', code: 'rate_limit', message, detail }`. UI shows the headline + expandable detail with Google's `quotaMetric` etc. "Start fresh" retries.
3. **Missing key** — unset `GEMINI_API_KEY` and restart the server. Analysis request errors out at construction with a useful message ("GEMINI_API_KEY required for ANALYZER=gemini").
4. **Model override** — open the re-parse dialog, pick `gemini-3-flash-preview`; click "Re-parse". Server analyzer uses the overridden model id for the run; `ui.selectedModel` persists.
5. **Schema regression** — if Gemini emits valid JSON that fails the stage-1 schema (e.g. missing `characters`), the stream surfaces `{ kind: 'error', code: 'schema-validation', detail: <issues> }`. Does not crash the server.
6. **Large manuscript** — feed a 200k-word manuscript; per-chapter mode keeps each request under ~30k tokens. UI live ETA updates per chapter.

## Out of scope

- Specific Gemini SDK version / SDK error surface — the analyzer abstracts both behind `AnalysisError`.
- Multi-model fan-out — only one model per run; A/B is done by re-running with a different `model`.
- Streaming partial JSON from Gemini — the analyzer waits for the full response per call.
