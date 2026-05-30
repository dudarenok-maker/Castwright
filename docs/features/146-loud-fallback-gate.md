---
status: active
shipped: null
owner: null
---

# Per-chapter loud Qwen→Kokoro fallback gate + resident-model visibility

> Status: active
> Key files: `server/src/tts/qwen-fallback-set.ts`, `server/src/routes/generation.ts`, `server/src/workspace/queue-io.ts`, `server/src/routes/queue.ts`, `src/store/queue-dispatcher-middleware.ts`, `src/store/generation-stream-runner.ts`, `src/modals/queue-modal.tsx`, `src/components/layout.tsx`
> URL surface: queue modal (`#/…` global overlay); TTS-engines pill in the status popover
> OpenAPI ops: `POST /api/queue/{entryId}/confirm-fallback`, `POST /api/queue/{entryId}/skip-fallback`

## Benefit / Rationale

Closes the 2026-05-30 "why is Kokoro loaded on my all-Qwen book, and why can't I see or stop it?" incident. Three coupled fixes:

- **User:** a chapter that would silently render an **undesigned Qwen voice in Kokoro** now PAUSES and asks per chapter (Render anyway / Skip) instead of quietly shipping a generic voice. Every model actually resident in the sidecar — including a pre-warmed/fallback Kokoro — gets a visible Stop pill, so the user can always see and kill what's holding VRAM.
- **Technical:** a fully-designed, healthy all-Qwen book **never loads Kokoro** anymore. The pre-warm was unconditional (`if (qwenInUse)`), wasting ~1 GB of VRAM and oversubscribing an 8 GB card (the driver spilled into shared system memory → RTF collapse). It now warms Kokoro only when a fallback will actually render.
- **Architectural:** introduces `awaiting_confirm` as a first-class queue state — the worker parks a chapter server-side and the persisted `.queue.json` is the durable record, surviving reloads. Builds on srv-16's server-authoritative completion; the fallback decision is computed once, deterministically, from cast + chapter sentences.

## Architectural impact

- **New seam — `computeQwenKokoroFallbackSet(speakingCharacters, defaultEngine)`** (`server/src/tts/qwen-fallback-set.ts`): the single predicate for "which Qwen-routed characters have no designed voice". Reused by both the gate (park decision) and the Kokoro pre-warm (only-when-needed).
- **New queue state `awaiting_confirm` + fields `fallbackCharacters` / `fallbackConfirmed`** (`queue-io.ts`). Additive to the openapi `QueueEntry` (status enum + two optional fields) — a v1 reader tolerates them; no schema bump (mirrors the `requiredEngines` precedent).
- **New SSE tick `chapter_awaiting_fallback_confirm`** carrying `fallbackCharacters` — surfaced as a warn toast directing the user to the queue.
- **Invariants preserved:**
  - The plan-135 all-cast `qwen_unavailable_kokoro_fallback` warning (engine UNAVAILABLE) is untouched and mutually exclusive with this gate — the gate only fires when Qwen is healthy (`!qwenUnavailable`). See `docs/features/archive/135-qwen-loud-fallback.md`.
  - srv-16 server-authoritative completion: `completeEntry` is now a **no-op for an `awaiting_confirm` entry**, so neither the frontend `/complete` reconcile nor the srv-16 done-flip can clobber a parked row.
  - srv-12 orphan-reset: the worker flips to `awaiting_confirm` (serialized) BEFORE the stream closes, so `resetEntryToQueued` (in_progress-only) no-ops on the parked entry.
  - Back-compat: a generation run with no `queueEntryId` (legacy caller) is NEVER gated — it renders straight through exactly as before.
- **Migration story:** none required. New status/fields are additive; the boot orphan sweep (`resetInProgressToQueued`) leaves `awaiting_confirm` untouched (an unanswered question, not orphaned in-flight work).
- **Reversibility:** delete the gate block in `processOneChapter` + revert the pre-warm condition → behaviour returns to silent fallback. The queue fields/status are inert without the worker writing them.

## Invariants to preserve

- `computeQwenKokoroFallbackSet` predicate (`server/src/tts/qwen-fallback-set.ts`) is exactly: `resolveCharacterEngine(c, defaultEngine) === 'qwen' && pickVoiceForEngine('qwen', toVoiceLike(c), buildHintFromCast(c)) === ''`. It is called ONLY when `!qwenUnavailable`.
- The gate condition in `generation.ts` `processOneChapter`: fires only when `qwenInUse && !qwenUnavailable && job.queueEntryId != null && !job.fallbackConfirmed && fallbackSet.length > 0`.
- `completeEntry` (`queue-io.ts`) returns the file unchanged when the target entry's status is `awaiting_confirm`.
- The dispatcher claim filter (`queue-dispatcher-middleware.ts`) claims only `status === 'queued'`; the reconcile skips `/complete` for an entry whose snapshot status is `awaiting_confirm`.
- `enginesToShow` (`layout.tsx`) includes any engine whose `ttsLifecycle[e].state` is `ready`/`streaming`/`loading`, regardless of the current book's cast.

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/qwen-fallback-set.test.ts`) — the predicate: undesigned-qwen included, designed excluded, non-qwen excluded, run-default routing, legacy override field, stable id-sort, all-designed → empty.
- Vitest server (`server/src/workspace/queue-io.test.ts`) — `markAwaitingConfirm` / `confirmFallback` / `skipFallback` transitions + guards; boot sweep leaves `awaiting_confirm` untouched; `cancel` removes a parked entry; `completeEntry` no-op on parked.
- Vitest server (`server/src/routes/queue.test.ts`) — `/confirm-fallback` (→ queued + confirmed), `/skip-fallback` (→ removed), idempotent no-ops on non-parked.
- Vitest server (`server/src/routes/generation-fallback-gate.test.ts`) — END-TO-END: an undesigned-voice chapter parks (awaiting_confirm + `chapter_awaiting_fallback_confirm` tick, no synth/complete); a `fallbackConfirmed` re-dispatch renders through; a no-`queueEntryId` run is never gated.
- Vitest unit (`src/store/generation-stream-runner.test.ts`) — the awaiting tick surfaces a warn toast naming chapter + characters, deduped by entry.
- Vitest unit (`src/store/queue-dispatcher-middleware.test.ts`) — reconcile does NOT `/complete` a parked entry (stays re-claimable); `fallbackConfirmed` is threaded into the stream open for a confirmed entry.
- Vitest unit (`src/modals/queue-modal.test.tsx`) — awaiting_confirm row names the characters + renders Render-anyway / Skip; the buttons POST the right endpoints.

Untested-on-purpose: the layout pill change (resident-model visibility) is covered by typecheck + the existing `layout.test.tsx` battery staying green; a dedicated assertion that a resident-but-unused Kokoro shows a pill is a follow-up if the seam regresses.

### Manual acceptance walkthrough

Real backend + sidecar (`npm start`), an all-Qwen book where at least one speaking character has NO designed Qwen voice:

1. Queue that chapter → it flips to **Needs confirmation** in the queue modal, naming the character(s); a warn toast points at the queue; **other queued chapters keep rendering**.
2. The TTS-engines pill shows **Qwen** (and Kokoro only if it actually loaded for a confirmed fallback) — every resident model is visible with a Stop control.
3. Click **Skip** → the chapter drops from the queue, nothing rendered in Kokoro.
4. Re-queue + click **Render anyway** → the chapter renders (in Kokoro) and completes; no re-prompt.
5. A fully-designed all-Qwen book → **no Kokoro pill ever appears**, no gate, RTF unaffected.

## Out of scope

- Auto-designing the missing Qwen voice (the gate surfaces the gap; designing is the cast-review flow, plan 108).
- The `reused Qwen voice dropped at generation` root cause (separate bug — see memory `project_reused_qwen_voice_dropped_at_generation`); this gate would CATCH that case loudly but does not fix the hydration root cause.
- Making Kokoro unloadable mid-render (the pill exposes Stop, but unloading an in-use narrator engine is user-driven and unguarded by design).

## Ship notes

(Filled when status → stable.)
