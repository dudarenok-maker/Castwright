# Script-review progress heartbeat, model naming, and clean model-load step

- **Date:** 2026-07-14
- **Status:** draft
- **Area:** frontend + server (script review / fs-58)
- **Related:** `docs/superpowers/specs/2026-06-23-fs58-llm-script-review-design.md`,
  `docs/features/236-prosody-review-progress-detail.md`,
  `docs/superpowers/specs/2026-07-02-prosody-review-progress-detail-design.md`

## Problem

The script-review pass (fs-58) reports progress at **per-chapter granularity only**,
and its heartbeat plumbing is dead on this code path. Three concrete failures:

1. **Frozen progress on large chapters.** The server emits one `phase` event per
   chapter (`progress = i / chapterIds.length`, `server/src/routes/script-review.ts:693`).
   A single large chapter therefore paints `0%` at start and `100%` at the very end,
   with nothing in between — the pill sits frozen behind only a CSS spinner
   (`src/components/substage-progress-pill.tsx:44`). Large chapters are already
   chunked server-side (`chunkSentencesByBudget`, `script-review.ts:714`), but the
   per-chunk loop emits no progress event.

2. **Silent wait / silent timeout before the first token.** The script-review
   `StageCall` never passes `onWaiting`, so the analyzer's 500 ms wall-clock waiting
   tick is never armed (`server/src/analyzer/gemini.ts:445`, `server/src/analyzer/ollama.ts:451`).
   `onChunk` only fires on real output text, so **nothing** is emitted between the
   chapter-start `phase` and the first token. On a cold Ollama the model call can hang
   up to the 45 s idle window (90 s across retries) with the pill frozen at the last
   percent, then fail. Compounding it, the client SSE reader has **no `case 'heartbeat'`**
   (`src/lib/api.ts:3157-3202`), so even the heartbeats the server does emit
   (post-first-token, throttled 2 s) are dropped.

3. **No model identity, and a silent cold-load degrade.** The client has no way to
   know which model is running a script-review pass — the model id rides only the
   `throttle` event (`script-review.ts:735`), never `phase`/`state`/`result`, and the
   thunk never captures it. And there is no explicit model-load step: the first
   `runScriptReviewChapter` call is what triggers a cold Ollama load. On cold-load
   failure the pass never cleanly aborts — it either transparently falls back to
   Gemini (silently, iff the error classifies as `LocalUnreachableError` **and** a
   Gemini key is configured — `server/src/analyzer/index.ts:300-320`) or degrades to
   a stream of per-chapter `chapter-failed` events (`script-review.ts:750`) while the
   loop keeps going.

## Goals

- A script-review pass never looks frozen: the **global activity pill** (top-bar
  `StatusPill` + its expanded `StatusPopover` panel) shows continuous liveness in
  every state — warming, waiting for first token, and streaming.
- The user can see **which engine + model** is running the pass, by friendly name.
- Cold-Ollama startup is an **explicit, visible step** with a **clean failure**
  (abort + Retry), not a silent hang-then-degrade.
- The existing mid-pass Gemini fallback is **kept** (it is a resilience net distinct
  from cold start) but is **surfaced** to the user instead of being silent.

## Non-goals

- No change to the inline manuscript `SubstageProgressPill`
  (`src/views/manuscript.tsx:1091`) beyond the smoother percent it inherits for free
  (see below). No new fields, timer, or model line there.
- No change to the ETA/pacing math (`chapter-pacing.ts`); intra-chapter events bump
  the bar only and leave chapter/ETA fields to last-known-value.
- No re-plumbing of script review onto the analysis-stream middleware (rejected —
  too much blast radius against script review's detached-job / attach / persistence
  semantics).
- No change to the prosody pass, which shares the `SubstageEntry` shape but is out of
  scope for this work.

## Placement decisions (where each signal renders)

Three distinct surfaces exist; this design deliberately touches only the first two:

| Surface | Component | This design |
|---|---|---|
| Compact top-bar pill (always visible) | `StatusPill` / `summarizeStatus` (`src/components/top-bar.tsx`) | **Tone only** — amber tint when `activityState === 'loading'` or `fallbackActive`. Label stays `Analysing · N%`. |
| Global activity panel (on click) | `StatusPopover` `SubstageRow` (`src/components/status-popover.tsx:110-134,247-274`) | **Full detail** — engine·model line, per-state ticking timer, `Loading model…` state, `Switched to Gemini` note. |
| Inline manuscript pill | `SubstageProgressPill` (`src/views/manuscript.tsx:1091`) | **Untouched.** Inherits the smoother per-chunk `progress` for free (it reads the same `entry.progress`). |

Rationale: the global pill is the one surface visible from every view, so making *it*
honest fixes "frozen and silent" everywhere. The compact pill stays uncluttered; a
tone change is enough to pull the eye without opening the panel.

## Design

### Data model — one entry, five optional fields

Extend `SubstageEntry` (`src/store/analysis-substage-reducers.ts:14-30`) with optional
fields, all populated by the script-review thunk and read by the panel via
`selectAnalysisSubstage` (`src/store/analysis-substage-selectors.ts:30-65`):

- `model?: string` — resolved model id (e.g. `gemma-4-31b-it`).
- `engine?: 'local' | 'gemini'` — active backend.
- `activityState?: 'loading' | 'waiting' | 'streaming'` — current phase of the pass.
- `activitySince?: number` — **client** `Date.now()` stamped when `activityState` last
  changed; the timer ticks client-side (a small `useElapsed` hook), so no server spam.
- `fallbackActive?: boolean` — set when the pass has switched Ollama → Gemini mid-run.

Percent stays a single `progress` number. The reducers already use last-known-value
semantics (`analysis-substage-reducers.ts:52-63`), so an event that carries only
`progress` leaves chapter/ETA/model fields intact.

"Engine · friendly model" is rendered by mapping `engine` (`local → Ollama`,
`gemini → Gemini`) and looking up the friendly model label via the existing
`MODEL_OPTIONS` table (`src/lib/models.ts:19-83`) — the exact mechanism the **main**
analysis pass already uses in the popover (`status-popover.tsx:251-261`).

### Server — `server/src/routes/script-review.ts` + analyzer wiring

1. **Warm phase before chapter 1 (local engine only).** Extract the warm body of
   `POST /api/ollama/load` (`server/src/routes/ollama-health.ts:309-328`) into a shared
   in-process helper (matching `num_ctx`/`num_gpu` so warming doesn't trigger a
   mid-request reload — the reason those options are matched today). In
   `runScriptReviewJob`, before the chapter loop, when `selection.engine === 'local'`,
   emit `phase { activityState: 'loading', model, engine, progress: 0 }`, then call the
   warm helper. Gemini engine skips this (no cold load).

2. **Warm failure → clean fatal abort.** If the warm helper fails, emit a single
   `error { code: 'model_load_failed', model, engine }` and **do not enter the chapter
   loop**. This is the deliberate override of today's silent degrade. The frontend
   renders a clear error with a **Retry** action that re-runs the pass.

3. **Model + engine on `phase` events.** Add `model` and `engine` to the chapter-start
   `phase` (`script-review.ts:693`) and the warm `phase`, mirroring
   `server/src/routes/analysis.ts` (which already emits `model` on its phase events).

4. **Per-chunk `phase` for intra-chapter creep.** In the existing chunk loop
   (`script-review.ts:724-752`), after each chunk emit
   `phase { progress: (i + (chunkIdx + 1) / chunkCount) / N }` (progress only). Chapter
   label / ETA persist via last-known-value. This is also what makes the inline
   manuscript pill's bar creep for free.

5. **Arm `onWaiting`.** Pass `onWaiting` on the script-review `StageCall`, wired to the
   existing throttled heartbeat (`makeThrottledHeartbeat`, `script-review.ts:673`;
   `server/src/routes/analysis-heartbeat.ts:23`). This makes the server emit liveness
   while waiting for the first token. The first `heartbeat`/`ops` for a chapter is what
   flips `activityState` `waiting → streaming`.

6. **Surface the Gemini fallback (`onFallback` hook).** Add an optional
   `onFallback?: (info: { model: string; engine: 'gemini'; reason: string }) => void`
   to the script-review `StageCall`. `FallbackAnalyzer.runScriptReviewChapter`
   (`server/src/analyzer/index.ts:300-320`) invokes it at the moment it switches on
   `LocalUnreachableError`. The route responds by emitting a `phase` carrying the
   **effective** `model`, `engine: 'gemini'`, and a `fallbackReason`
   (e.g. `"Ollama unreachable"`). The mid-pass fallback itself is unchanged — only now
   it is announced.

### Client — SSE reader, thunk, selector, render

1. **`realReviewScript` SSE reader** (`src/lib/api.ts:3136-3224`): add `case 'heartbeat'`
   (today silently dropped) and read `model`/`engine`/`activityState`/`fallbackReason`
   off `phase` events.

2. **Thunk** (`src/store/script-review-thunk.ts`): dispatch the new entry fields;
   stamp `activitySince = Date.now()` whenever `activityState` changes; set
   `fallbackActive` on a fallback `phase`. `warm/loading` on the first loading phase,
   `waiting` on chapter-start, `streaming` on first heartbeat/ops of a chapter.

3. **Selector** `selectAnalysisSubstage` (`analysis-substage-selectors.ts`): project the
   five new fields so the panel `SubstageRow` can read them.

4. **Render:**
   - **Panel** `SubstageRow` (`status-popover.tsx`): add an "Engine · friendly model"
     line; a `useElapsed(activitySince)` ticking timer whose label follows
     `activityState` — `Loading model · 8s` / `Chapter 3 of 42 · waiting for model · 12s`
     / normal streaming detail; and, when `fallbackActive`, a
     `Switched to Gemini — Ollama unreachable` note.
   - **Compact pill** `summarizeStatus` (`top-bar.tsx:140-188`): set an amber `tone`
     when the review substage `activityState === 'loading'` or `fallbackActive`. Label
     unchanged.
   - **Inline manuscript pill:** unchanged.

### Error / edge handling

- **Cold Ollama, warm fails:** `error: model_load_failed` → pass aborts before any
  chapter → panel shows the error, Retry re-runs.
- **Gemini engine:** warm phase skipped; pass starts at chapter 1 immediately.
- **Mid-pass Ollama drop (classified `LocalUnreachableError`, key configured):** existing
  fallback still runs; now announced via `onFallback` → panel flips to
  `Gemini · <model>` + note; compact pill goes amber.
- **Mid-pass model error not classified as unreachable** (HTTP non-2xx, truncation,
  empty body): unchanged — per-chapter `chapter-failed`, loop continues. Out of scope
  to change here.
- **Reconnect / attach** (`attachToRunningReview`): the new fields must survive the
  `state` snapshot path — include `model`/`engine`/`activityState`/`fallbackActive` in
  the `ScriptReviewReplayState` snapshot (`script-review.ts:218-231,441-478`) so a
  re-attach repaints them (`activitySince` is re-stamped client-side on attach).

## Testing

- **Server** (`server/src/routes/script-review.*.test.ts`):
  - warm helper invoked for `engine==='local'`; `loading` phase emitted first.
  - warm failure → `model_load_failed` emitted and **no** chapter runs.
  - multi-chunk chapter emits a `phase` per chunk with monotonically increasing
    `progress`.
  - `phase` events carry `model` + `engine`.
  - `onWaiting` armed → a heartbeat is emitted while waiting for the first token.
  - `onFallback` → a `phase` with `engine: 'gemini'` + `fallbackReason` is emitted.
  - `state` snapshot includes the new fields (re-attach repaint).
- **Frontend**:
  - thunk test: heartbeat + model + chunk `phase` + fallback events populate the
    entry (`model`, `engine`, `activityState`, `fallbackActive`, creeping `progress`).
  - component test: panel `SubstageRow` renders friendly `Engine · model`, the ticking
    timer per state, and the fallback note; `summarizeStatus` returns the amber tone
    for `loading`/`fallbackActive`.
- **E2E** (`e2e/`): one mock-mode Playwright spec — start a script review, open the
  status popover, assert it shows the model name and a moving progress indicator (the
  change crosses SSE → redux → layout → popover seams and two surfaces, so it earns an
  e2e per the testing-discipline bar).

## Rollout / tracking

- Bug-shaped work (progress broken + unclean cold-load degrade). File/verify a GitHub
  issue at PR time per the PR-gate issue-verification rule; link with `Closes #NN`.
- New behaviour → paired automated tests above. Update `docs/features/INDEX.md` only if
  this graduates to a tracked plan doc; otherwise the issue + this spec + tests are the
  record. Add release-notes entries (`docs/release-notes-next.md` + `RELEASE_NOTES.md`)
  in the implementing PR.
