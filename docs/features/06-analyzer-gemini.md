# Gemini analyzer (`ANALYZER=gemini`)

> Status: stable (opt-in direct, OR automatic fallback when `ANALYZER=local` and Ollama is unreachable — see [plan 29](29-analyzer-ollama-local.md))
> Key files: `server/src/analyzer/gemini.ts`, `server/src/analyzer/rate-limit.ts`, `server/src/analyzer/index.ts`, `server/src/handoff/schemas.ts`
> URL surface: indirect (`#/books/:bookId/analysing`)
> OpenAPI ops: `POST /api/manuscripts/:id/analysis`

## What this covers

Opt-in analyzer mode that hits the Gemini free-tier API directly instead of the manual file-drop loop. Same Zod schemas, same SSE stream surface — only the source of the JSON differs. Per-chapter stage-2 keeps each request under the context window and a per-model RPM/TPM/RPD limiter ensures retries can't compound rate-limit pressure into 429/500 storms.

## Invariants to preserve

- Activated by env var `ANALYZER=gemini`; requires `GEMINI_API_KEY`. Without the key the analyzer fails fast at construction; do not fall back silently to manual mode.
- `GEMINI_MODEL` env var picks the model id; default `gemma-4-31b-it` (separate free-tier bucket from `gemini-*` and the most generous daily cap at 1,500 RPD). Switching to `gemini-3.1-flash-lite` etc. requires only an env var change.
- Stage-1 + stage-2 responses are validated against the **same** Zod schemas as the manual analyzer (`server/src/handoff/schemas.ts`). A Gemini response that fails validation surfaces as an `AnalysisError` to the client, not a 500 with raw API output.
- Per-chapter stage-2 mode (current default): the analyzer iterates chapters and calls Gemini once per chapter. Whole-manuscript stage-2 (legacy) is still supported for tiny manuscripts but not the default.
- **Every outbound Gemini call (primary AND retry) goes through `GeminiRateLimiter.acquire()`** — a per-model token bucket tracking RPM, input-TPM, and RPD. Retries can never bypass it; this is the load-bearing safety net against the retry-storm pathology where a 5xx retry on a 3-s tick from N parallel workers spikes RPM and creates more 429s than primaries.
- **Retry policy**: max 3 attempts per call, 90 s total wall-clock budget, exponential backoff with jitter `[1.5s, 6s]`. Retries on 5xx (500/503/504) and per-minute 429. Per-minute 429s honor Google's `retry-delay` from `details[].RetryInfo` — the limiter is notified via `recordRejection()` so the next acquire waits at least that long. **Daily-quota 429s are NOT retried** — they throw `DailyQuotaExhaustedError` and surface as `code: 'daily_quota'` with the next-UTC-midnight reset time in the detail blob.
- **Built-in per-model limits** (pulled from `aistudio.google.com/app/rate-limit` 2026-05-16; override via `GEMINI_RPM_<slug>`, `GEMINI_TPM_<slug>`, `GEMINI_RPD_<slug>` env vars; see `server/.env.example`):

  | Model                    | RPM | TPM       | RPD   |
  | ------------------------ | --- | --------- | ----- |
  | `gemini-3.1-flash-lite`  | 15  | 250,000   | 500   |
  | `gemini-3-flash-preview` | 5   | 250,000   | 20    |
  | `gemini-2.5-flash`       | 5   | 250,000   | 20    |
  | `gemma-4-31b-it`         | 15  | Unlimited | 1,500 |
  | `gemma-4-26b-a4b-it`     | 15  | Unlimited | 1,500 |
  | unknown (fallback)       | 5   | 100,000   | 50    |

- TPM is **input** tokens per minute (output doesn't count). Estimate is `Math.ceil(promptChars / 4) + 1_000`; reconciled against `usageMetadata.promptTokenCount` once the SDK returns it so persistent estimation drift doesn't accumulate.
- When the limiter has to delay a call (>1 s wait), the analyzer's `onThrottle(waitMs, reason)` fires. The route layer maps that to an SSE `{ kind: 'throttle', model, waitMs, reason }` event; the analysing view renders a "Throttling Gemini … · resuming in Ns" pill on the affected per-chapter row (replaces the heartbeat row while active). Reasons: `'rpm' | 'tpm' | 'rpd' | 'retry-after'`.
- Rate-limit / quota / auth errors are mapped to `AnalysisError` with a structured `detail` field carrying Google's `status` + `details[]` envelope (`src/lib/api.ts:407-410` consumes this and renders the collapsible detail block).
- **`parseAndValidate` rescues four classes of malformed model output** (shared with the Ollama analyzer via `repairUnescapedQuotes` / `trimTrailingProse` / `repairStructuralPunctuation` exports from `gemini.ts`):
  1. ` ```json ... ``` ` markdown fences (`stripCodeFences`) — model wrapped its JSON despite the system-prompt prohibition.
  2. Unescaped inner double-quotes inside string values (`repairUnescapedQuotes`) — model emitted dialogue with raw `"` characters instead of `\"`. Verified against real failing raws ch8 byte 2363 / ch10 byte 1432.
  3. Trailing prose after the outer closing brace (`trimTrailingProse`) — model finished its JSON and then continued writing free-form commentary. Ch44 pos 37588 shape in the the Coalfall Commission regression.
  4. Single-token structural punctuation gaps (`repairStructuralPunctuation`, bounded at 2 inserts by default) — one missing comma between adjacent properties OR up to two missing close braces / brackets at EOF. Ch49 pos 32464 shape. Deeper truncation (3+ unclosed) stays unparseable so the retry policy in `ollama.ts:352` correctly drops the broken assistant turn instead of replaying a half-rescued skeleton.

  All four passes are no-ops on byte-clean JSON, so they layer without false positives. Coverage: `server/src/analyzer/parse-and-repair.test.ts` (47 cases).

- The Gemini analyzer must override `model` from the request body when present (used by the UI re-parse dialog to A/B between models without restarting the server).

## Acceptance walkthrough

Run server with `ANALYZER=gemini`, `GEMINI_API_KEY=<key>` in `server/.env`.

1. **Happy path** — upload a small manuscript; analysis completes end-to-end without any inbox/outbox interaction. UI shows phase progress + per-chapter live ETA.
2. **Throttling pill visible under RPM pressure** — set `GEMINI_RPM_GEMINI_3_1_FLASH_LITE=2` in `server/.env`, restart, kick a fresh analysis with concurrency=3 chapters. At least one per-chapter row must render the amber "Throttling Gemini 3.1 Flash Lite · resuming in Ns" pill while the limiter waits for the window to slide. Run completes without surfacing a 429/500 error to the user.
3. **Retry on 429 with retry-delay** — force a per-minute 429 (e.g. set the env override low and fire several chapters concurrently). Server log shows `[gemini] 429 — retrying in Nms (attempt …)`. The eventual response succeeds; UI never displays a `rate_limit` error.
4. **Daily quota exhausted** — set `GEMINI_RPD_<model>=1`, kick two analyses. Second errors out cleanly with code `daily_quota`; the UI shows the headline + collapsible detail naming the resetAt time. No retry burn.
5. **Missing key** — unset `GEMINI_API_KEY` and restart the server. Analysis request errors out at construction with a useful message ("GEMINI_API_KEY required for ANALYZER=gemini").
6. **Model override** — open the re-parse dialog, pick `gemini-3-flash-preview`; click "Re-parse". Server analyzer uses the overridden model id for the run; `ui.selectedModel` persists. The limiter switches to the picked model's bucket (5 RPM / 20 RPD).
7. **Schema regression** — if Gemini emits valid JSON that fails the stage-1 schema (e.g. missing `characters`), the stream surfaces `{ kind: 'error', code: 'schema-validation', detail: <issues> }`. Does not crash the server. The follow-up validation retry also goes through the limiter (verified in `server/src/analyzer/gemini.test.ts`).
8. **Large manuscript** — feed a 200k-word manuscript; per-chapter mode keeps each request under ~30k tokens. UI live ETA updates per chapter.

## Out of scope

- Specific Gemini SDK version / SDK error surface — the analyzer abstracts both behind `AnalysisError`.
- Multi-model fan-out — only one model per run; A/B is done by re-running with a different `model`.
- Streaming partial JSON from Gemini — the analyzer waits for the full response per call.
- TTS rate limiting — the same `GeminiRateLimiter` machinery is reusable for the Gemini TTS path (`gemini-2.5-flash-preview-tts` is 3 RPM / 10K TPM / 10 RPD per AI Studio), but wiring it in is a separate follow-up.
