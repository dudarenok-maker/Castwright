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
- `engine?: 'local' | 'gemini'` — **effective** active backend (flips to `gemini` on a
  mid-pass fallback).
- `activityState?: 'loading' | 'waiting' | 'streaming'` — current phase of the pass.
  **Coarse state (`loading`/`waiting`) is owned by the server** and stamped onto `phase`
  events (so it is replayable from the state snapshot on reattach); the **`streaming`
  upgrade is client-only**, applied off a live streaming heartbeat/`ops` (see Client.2).
  After a reattach mid-stream the entry reads `waiting` until the next live heartbeat
  (~2 s self-heal) — acceptable, and the reason `streaming` is deliberately not in the
  snapshot.
- `activitySince?: number` — **client** `Date.now()` stamped when `activityState` last
  changes; the timer ticks client-side (a small `useElapsed` hook), so no server spam.
  Known limitation: re-stamped on reattach, so the timer resets to `0 s` on reload even
  mid-operation (a 40 s cold load can momentarily read `0 s`). Accepted as minor UX debt.
- `fallbackActive?: boolean` — set when the pass has switched Ollama → Gemini mid-run.
  Idempotent (see M3 resolution) — safe to set repeatedly.

Percent stays a single `progress` number. The reducers already use last-known-value
semantics (`analysis-substage-reducers.ts:52-63`), so an event that carries only
`progress` leaves chapter/ETA/model fields intact.

**Reducer/selector surface (do not understate this).** The five fields are **not**
carried by the shared payload types `SetActiveSubstagePayload` /
`UpdateSubstageProgressPayload` or the shared reducer bodies
(`analysis-substage-reducers.ts:14-63`), which prosody also uses. Implementation must:
(a) extend both payload types and both reducer functions to pass the new fields through;
(b) route **every** post-init script-review event through `updateProgress` (merge), never
`setActive` — `setActiveSubstage` **fully replaces** the entry (`:35-47`), so a stray
`setActive` after pass start wipes the new fields; (c) widen the `selectAnalysisSubstage`
projection (`:30-65`) **and** the two consumer prop shapes — `StatusInput.analysisSubstage`
(today `{ kind, percent }` only, `top-bar.tsx:169`) for the amber tone, and the
`SubstageRow` prop (`status-popover.tsx:110-134`) for the engine·model / timer / fallback
lines. This is more than "add optional fields."

"Engine · friendly model" is rendered by mapping `engine` (`local → Ollama`,
`gemini → Gemini`) and looking up the friendly model label via the existing
`MODEL_OPTIONS` table (`src/lib/models.ts:19-83`) — the exact mechanism the **main**
analysis pass already uses in the popover (`status-popover.tsx:251-261`). An **uncurated**
local Ollama tag not in `MODEL_OPTIONS` falls back to its raw id (matches the main pass);
panel copy must not assume the label is always friendly.

### Server — `server/src/routes/script-review.ts` + analyzer wiring

1. **Warm phase before chapter 1 (local engine only).** Extract the warm body of
   `POST /api/ollama/load` (`server/src/routes/ollama-health.ts:309-328`) into a shared
   in-process helper (matching `num_ctx`/`num_gpu` so warming doesn't trigger a
   mid-request reload — the reason those options are matched today; the analyzer chat
   path uses the same `resolveAnalyzerNumCtx()`/`resolveAnalyzerNumGpu()`,
   `ollama.ts:606,610`, so the cache key matches). In `runScriptReviewJob`, before the
   chapter loop, when `selection.engine === 'local'`, emit
   `phase { activityState: 'loading', model, engine, progress: 0 }`, then call the warm
   helper against `selection.model`. Gemini engine skips this (no cold load).

   **Warm the model the first chapter will actually use.** Per-phase model selection
   (`selectAnalyzerForPhase`) resolves `selection.model` for `phase1`; warm *that* id, not
   `getResolvedOllamaModel()`, or we can warm the wrong tag.

2. **Warm failure — gate the abort on whether a fallback exists (C1).** `selectAnalyzer`
   returns `engine: 'local'` **even when a `FallbackAnalyzer` wrapping Gemini is
   configured** (`index.ts:193-198`), with `selection.fallbackModel` set to the Gemini
   model. So warm-failure handling must branch:
   - **`selection.fallbackModel === null`** (bare Ollama, no Gemini key): emit
     `error { code: 'model_load_failed', model, engine }`, **do not enter the chapter
     loop**. Frontend shows the error + a **Retry** action (re-runs the pass). This is the
     clean-abort the user asked for.
   - **`selection.fallbackModel` present**: warm failure must **not** abort — a working
     "Ollama-down + Gemini-up" setup completes on Gemini today, and aborting would break
     it and loop on Retry. Instead, proactively switch the pass to the Gemini fallback,
     fire the `onFallback` announcement (§6), and enter the loop on Gemini. (Do **not**
     block the whole pass on a warm probe when there is a viable cloud path.)

3. **Model + engine + coarse `activityState` on `phase` events.** Add `model`, `engine`,
   and `activityState` to the chapter-start `phase` (`script-review.ts:693`, →`waiting`)
   and the warm `phase` (→`loading`), mirroring `server/src/routes/analysis.ts` (which
   already emits `model` on its phase events). Stamping `activityState` on `phase` is what
   makes it survive into the state snapshot for reattach (M2).

4. **Per-chunk `phase` for intra-chapter creep.** In the existing chunk loop
   (`script-review.ts:724-752`), after each chunk emit
   `phase { progress: (i + (chunkIdx + 1) / chunkCount) / N }` (progress only). Chapter
   label / ETA persist via last-known-value. Monotonic: the last chunk's `(i+1)/N` equals
   the next chapter-start value, so it never goes backwards or overshoots.
   **Scope caveat (m1):** this only moves the bar for **multi-chunk local** chapters. Cloud
   engines get a `MAX_SAFE_INTEGER` chunk budget → exactly one chunk, and any local chapter
   that fits one chunk emits `(i+1)/N` only when it finishes. For those, liveness is carried
   entirely by the **client-side ticking timer**, not the bar — which is fine, but the
   "single large chapter no longer frozen" promise is delivered by the *timer* for the
   single-chunk/cloud case and by the *bar* only for oversized local chapters.

5. **Streaming detection — no `onWaiting` (M1).** Do **not** arm `onWaiting`. It is
   redundant here: script review is not on the analysis-stream middleware (its "avoid a
   false Stalled" rationale doesn't apply), the visible waiting liveness is already the
   client-side `useElapsed` timer, and `onChunk` heartbeats already fire today
   (`script-review.ts:734`). `waiting → streaming` is a **client** transition detected from
   a heartbeat that carries `receivedBytes` (i.e. one originating from `onChunk`, not a
   pre-token waiting tick) or from an `ops` event — see Client.2. Arming `onWaiting` would
   emit a *waiting* heartbeat indistinguishable at the payload level except by the absence
   of `receivedBytes`, so relying on "first heartbeat = streaming" would falsely show
   "streaming" while still waiting.

6. **Surface the Gemini fallback (`onFallback` hook, M3).** Add an optional
   `onFallback?: (info: { model: string; engine: 'gemini'; reason: string }) => void`
   to the script-review `StageCall`. `FallbackAnalyzer.runScriptReviewChapter`
   (`server/src/analyzer/index.ts:300-320`) invokes it when it switches on
   `LocalUnreachableError`. `FallbackAnalyzer` is **stateless**, so without a guard it
   fires once per chunk/chapter and re-pays the Ollama connection-failure latency every
   chapter. Add a **per-job latch in the route**: on the first `onFallback`, switch the
   loop's analyzer to Gemini directly for the remaining chapters (skipping the doomed
   Ollama primary) and emit the announcement `phase` **once** — effective `model`,
   `engine: 'gemini'`, `fallbackReason` (e.g. `"Ollama unreachable"`). Re-fires are
   idempotent on the client regardless.

### Client — SSE reader, thunk, selector, render

1. **`realReviewScript` SSE reader** (`src/lib/api.ts:3136-3224`): add `case 'heartbeat'`
   (today silently dropped). Read `model`/`engine`/`activityState`/`fallbackReason` off
   `phase` events. Distinguish a **streaming** heartbeat (payload carries `receivedBytes`,
   from `onChunk`) from a bare waiting tick — only the former (or an `ops` event) upgrades
   the state to `streaming`.

2. **Thunk** (`src/store/script-review-thunk.ts`): dispatch the new entry fields **via
   the merge action (`updateProgress`), never `setActive`** after the initial `setActive`
   at pass start (`:45`) — a later `setActive` would wipe the new fields. Coarse
   `activityState` (`loading`/`waiting`) arrives already stamped on `phase` events; the
   thunk upgrades to `streaming` on the first streaming heartbeat/`ops` for a chapter.
   Stamp `activitySince = Date.now()` whenever the resulting `activityState` changes; set
   `fallbackActive = true` on a fallback `phase`.

3. **Selector** `selectAnalysisSubstage` (`analysis-substage-selectors.ts`): project the
   five new fields so the panel `SubstageRow` can read them. (Note m2: this selector
   prefers prosody and returns only one substage — if a prosody pass runs concurrently for
   any book, the review's model/timer will not surface. Rare; accepted, noted here.)

4. **Render:**
   - **Panel** `SubstageRow` (`status-popover.tsx`): add an "Engine · friendly model"
     line; a `useElapsed(activitySince)` ticking timer whose label follows
     `activityState` — `Loading model · 8s` / `Chapter 3 of 42 · waiting for model · 12s`
     / normal streaming detail; and, when `fallbackActive`, a
     `Switched to Gemini — Ollama unreachable` note.
   - **Compact pill** `summarizeStatus` (`top-bar.tsx:140-188`): set an amber `tone`
     when the review substage `activityState === 'loading'` or `fallbackActive`. Label
     unchanged. Reachability confirmed: the substage rung (`top-bar.tsx:168`) sits **above**
     the paused-analysis rung (`:179`), so a review pass reaches it and the tone applies.
   - **Inline manuscript pill:** unchanged.

5. **Retry affordance (m5).** Warm-failure `model_load_failed` (bare-Ollama case only)
   surfaces via the existing error toast (`script-review-thunk.ts:136-143`) with an added
   **Retry action** that **re-dispatches `runReviewScript(bookId)`** (a fresh run, not a
   resume). This is net-new UI — there is no Retry today. A test asserts Retry re-runs.

### Error / edge handling

- **Cold Ollama, warm fails, NO Gemini key** (`fallbackModel === null`):
  `error: model_load_failed` → pass aborts before any chapter → panel shows the error,
  toast Retry re-runs.
- **Cold Ollama, warm fails, Gemini key configured** (`fallbackModel` present, C1): do
  **not** abort — switch to Gemini, fire `onFallback`, run the pass on Gemini. Panel reads
  `Gemini · <model>` + the fallback note; compact pill amber. (Preserves today's working
  behaviour instead of regressing it.)
- **Gemini engine selected outright:** warm phase skipped; pass starts at chapter 1.
- **Mid-pass Ollama drop (classified `LocalUnreachableError`, key configured):** existing
  fallback still runs; now announced once via `onFallback` + per-job latch (§Server.6) →
  panel flips to `Gemini · <model>` + note; compact pill amber; remaining chapters skip
  the dead Ollama primary.
- **Mid-pass model error not classified as unreachable** (HTTP non-2xx, truncation,
  empty body): unchanged — per-chapter `chapter-failed`, loop continues. Out of scope.
- **Cancellation racing the warm step:** an abort arriving during the `/load` warm call
  must cancel cleanly (no `model_load_failed` surfaced for a user-initiated cancel) — the
  warm helper takes the job's abort signal; a cancel short-circuits to the existing
  `error { code: 'cancelled' }` path. Covered by a test.
- **Reconnect / attach** (`attachToRunningReview`): `model`/`engine`/`activityState`
  (coarse) survive because they are stamped on `phase`, and the snapshot's `lastPhase`
  (`script-review.ts:667`) is the last broadcast `phase`. `streaming` is **not** in the
  snapshot (heartbeats aren't replayed); a reattach mid-stream reads `waiting` and
  self-heals on the next live heartbeat (~2 s). `activitySince` is re-stamped client-side
  on attach (timer resets — known limitation, above). `fallbackActive` is derivable from
  the snapshot's effective `engine === 'gemini'`.

## Testing

- **Server** (`server/src/routes/script-review.*.test.ts`):
  - warm helper invoked for `engine==='local'` against `selection.model`; `loading` phase
    emitted first.
  - warm failure with **`fallbackModel === null`** → `model_load_failed` emitted and
    **no** chapter runs.
  - warm failure with **`fallbackModel` present** (C1) → **no** `model_load_failed`;
    pass switches to Gemini, `onFallback` announcement emitted, chapters run on Gemini.
  - multi-chunk chapter emits a `phase` per chunk with strictly increasing `progress`
    that never exceeds the next chapter-start value; single-chunk chapter emits only the
    end `(i+1)/N`.
  - `phase` events carry `model` + `engine` + coarse `activityState`.
  - `onFallback` → exactly one announcement `phase` with `engine: 'gemini'` +
    `fallbackReason`; the per-job latch stops further Ollama primary attempts.
  - cancellation during the warm step → `error { code: 'cancelled' }`, **not**
    `model_load_failed`.
  - `state` snapshot includes `model`/`engine`/`activityState` (coarse) for re-attach.
- **Frontend**:
  - thunk test: model/`phase` + streaming-heartbeat (with `receivedBytes`) + fallback
    events populate the entry via merge (`model`, `engine`, `activityState` incl. the
    `waiting → streaming` upgrade, `fallbackActive`, creeping `progress`); a bare waiting
    heartbeat does **not** flip to `streaming`; a stray `setActive` would (negative test)
    wipe fields — assert the thunk uses merge.
  - component test: panel `SubstageRow` renders friendly `Engine · model`, the ticking
    timer per state, and the fallback note; `summarizeStatus` returns the amber tone
    for `loading`/`fallbackActive` **and** that the substage rung is reachable (not
    outranked by a paused main-analysis rung).
  - Retry test: `model_load_failed` toast Retry re-dispatches `runReviewScript` (fresh
    run).
- **E2E** (`e2e/`): one mock-mode Playwright spec — start a script review, open the
  status popover, assert it shows the model name and a moving progress indicator (the
  change crosses SSE → redux → layout → popover seams and two surfaces, so it earns an
  e2e per the testing-discipline bar).

## Assumption-check resolutions (2026-07-14, Opus adversarial pass)

- **C1 (Critical) — warm-abort regressed a working config.** Resolved: warm failure only
  aborts when `selection.fallbackModel === null`; with a Gemini fallback configured it
  switches to Gemini instead of aborting (§Server.2, §Error handling).
- **M1 (Major) — wrong streaming signal / redundant `onWaiting`.** Resolved: dropped the
  `onWaiting` change; `streaming` is a client upgrade off a `receivedBytes`-bearing
  heartbeat or `ops` (§Server.5, §Client.1–2).
- **M2 (Major) — `activityState` ownership contradiction.** Resolved: server owns coarse
  `loading`/`waiting` on `phase` (replayable); client owns the `streaming` upgrade
  (self-heals after reattach) (§Data model, §Server.3, §Error handling).
- **M3 (Major) — `onFallback` not once-per-switch.** Resolved: per-job latch fires the
  announcement once and stops retrying dead Ollama; client flag is idempotent (§Server.6).
- **M4 (Major) — reducer/selector surface understated.** Resolved: spelled out payload +
  reducer + selector + prop-shape changes and the merge-not-`setActive` rule (§Data model).
- **Minors folded:** m1 per-chunk creep scope caveat (§Server.4), m2 concurrent-prosody
  hides review (§Client.3), m3 attach timer reset (§Data model), m4 uncurated tag → raw id
  (§Data model), m5 Retry placement + test (§Client.5), m6 test gaps (§Testing).

## Rollout / tracking

- Bug-shaped work (progress broken + unclean cold-load degrade). File/verify a GitHub
  issue at PR time per the PR-gate issue-verification rule; link with `Closes #NN`.
- New behaviour → paired automated tests above. Update `docs/features/INDEX.md` only if
  this graduates to a tracked plan doc; otherwise the issue + this spec + tests are the
  record. Add release-notes entries (`docs/release-notes-next.md` + `RELEASE_NOTES.md`)
  in the implementing PR.
