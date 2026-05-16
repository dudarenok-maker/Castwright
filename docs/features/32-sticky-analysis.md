# 32 — Sticky analysis across navigation

**Status:** stable. Server (B1), frontend slice + middleware + view wiring (B2), and top-bar pill + docs (B3) all landed.

Analysis, once started, runs to completion (or to the user's explicit Pause) regardless of where the user navigates. The previous contract aborted the analyzer the moment the SSE socket closed — navigate-away from the analysing view tore the in-flight LLM call down, and the next visit had to re-do the chapter the abort caught. The B-series contract pins the loop to a server-owned job keyed on `manuscriptId` so navigation only unsubscribes; the job carries on until the queue drains, `/pause` is called, or a `fresh: true` POST displaces it.

Mirrors plan 31 (sticky generation) one-for-one. The patterns intentionally match — same `inFlightByX` map shape, same `Subscriber` model, same broadcast/replay split.

## Invariants

### Server (B1)

1. **The analyzer loop survives every navigation except an explicit `/pause` or a `fresh: true` displacement.** `server/src/routes/analysis.ts` owns the loop body in `runMainAnalyzerJob(job, ...)`, spawned via `void runMainAnalyzerJob(...)` from the POST handler so it outlives the request that started it. `res.on('close')` on a subscriber's response only removes that subscriber from the job's `Set<AnalysisSubscriber>` — it does NOT abort `job.controller`.

2. **In-flight jobs live in `inFlightAnalysisByManuscript: Map<string, AnalysisJob>`** (`server/src/routes/analysis.ts`). The exported probe `isAnalysisJobRunning(manuscriptId)` returns `true` iff there's an entry and its controller hasn't been aborted. Used by the frontend's pre-SSE handshake (B2) to decide between starting a new run and joining an existing one.

3. **Dispatcher: subscribe vs start.**
   - **Subscribe**: a non-aborted job exists for this `manuscriptId` AND the request did NOT pass `fresh: true`. The route handler adds an `AnalysisSubscriber` ({ send, res, keepAlive }) to the job's subscribers set, replays the catch-up state via `replayCatchUp(job, send)`, and returns. The response stays open; subsequent broadcasts hit it.
   - **Start / displace**: no existing job, or `fresh: true`. The route aborts any existing job (its catch-block in `runMainAnalyzerJob` deregisters via `endJob`), creates a fresh `AnalysisJob` in the map, registers this request as the first subscriber, and spawns the analyzer in the background.

4. **Catch-up replay** (`replayCatchUp` in `server/src/routes/analysis.ts`) is a one-shot replay run synchronously when a new subscriber joins, in this order:
   - `replay.lastPhase` — the most recent `phase` tick (cumulative, only latest matters).
   - `replay.logs` — every log line emitted on this job, in original order.
   - `replay.lastEta` — the latest `eta` event.
   - `replay.lastCastUpdate` — the latest full cast-update snapshot.
   - `replay.failedByChapterId.values()` — every still-active `chapter-failed` row. `chapter-resolved` events remove entries from the map; replays of resolved rows are intentionally suppressed.

   Heartbeats + throttles are ephemeral and NOT replayed. `result` and `error` are terminal — the job ends + deregisters right after emitting them, so a new subscriber would have to land on the FAILED dispatcher (no entry in the map) and start a fresh run.

5. **`endJob(job, finalEv?)`** is the single deregistration point. Broadcasts the optional `finalEv` (used for `result`, `error`, `cast_incomplete`, `attribution_drift`, `stage1_shrink_refused`, `aborted`), clears every subscriber's keep-alive interval, ends each subscriber's response, clears the subscribers Set, and removes the job from `inFlightAnalysisByManuscript` (only if the current entry is still this job — displacement overwrite is safe).

6. **`POST /api/manuscripts/:id/analysis/pause`** aborts `job.controller`. The analyzer's per-call signal plumbing turns the abort into an `AnalysisAbortedError`, which `runMainAnalyzerJob`'s catch surfaces as a structured `{ kind: 'error', code: 'aborted' }` final event via `endJob`. Idempotent: returns `200 { ok: true, paused: false }` when no job is running so a double-click on Pause doesn't 404.

7. **On-disk side effects are no longer gated on `clientGone`.** Pre-B1 the route skipped writing `cast.json` / `state.json` if the SSE socket closed — that was a guard against "user navigated away mid-run, don't promote the book to confirm". With sticky analysis the run survives navigation and IS the source of truth; finishing the loop always writes cast.json + state.json. The user comes back to a confirm screen which accurately reflects the completed work. Attribution-drift and stage1-shrink-refused gates still skip cast.json / state.json (those are corruption-prevention paths, not navigation-disconnect paths).

### Frontend (B2)

1. **`src/store/analysis-slice.ts`** owns `activeStream: AnalysisStreamSnapshot | null` — a narrow snapshot for the (B3) AnalysisPill. Fields: `bookId`, `manuscriptId`, `bookTitle?`, `phaseId`, `phaseLabel`, `phaseProgress` (0..1), `remainingMs` (server ETA), `lastTickAt`, `state: 'running' | 'paused' | 'halted'`, `haltCode?`, `haltReason?`. Reducers: `setActiveStream`, `clearActiveStream`, `applyAnalysisSnapshotTick`, `setHalted`, `setPaused`. Cross-book guard: every reducer except setActiveStream + clearActiveStream verifies `payload.manuscriptId === activeStream.manuscriptId` so a tick from another tab's analysis cannot clobber this tab's snapshot.

2. **`src/store/analysis-stream-middleware.ts`** is intentionally narrow: it bridges `analysis/setPaused` → `api.pauseAnalysis({ manuscriptId })`. Fire-and-forget — the server endpoint is idempotent so a failed request is benign. The view's existing imperative abort still tears down the per-tab fetch consumer; the middleware tears down the server-side analyzer loop. The two paths are independent: post-B1 the server treats SSE close as "unsubscribe", not "abort," so without an explicit `pauseAnalysis` POST the analyzer keeps running after a navigate-away.

3. **`src/views/analysing.tsx` wiring**:
   - **On SSE start** (the existing `api.analyseManuscript` call): dispatch `setActiveStream({ bookId, manuscriptId, bookTitle, phaseId: 0, phaseLabel, phaseProgress: 0, remainingMs: null, lastTickAt: Date.now(), state: 'running' })`. The pill (B3) sees this and renders live progress.
   - **On `onPhase` tick**: dispatch `applyAnalysisSnapshotTick({ manuscriptId, phaseId, phaseLabel, phaseProgress, lastTickAt })`.
   - **On `onEta` tick**: dispatch `applyAnalysisSnapshotTick({ manuscriptId, remainingMs, lastTickAt })`.
   - **On terminal success** (`onComplete`): dispatch `clearActiveStream()` — pill drops out (view transitions to confirm).
   - **On `AnalysisError`** with `code: 'aborted'`: dispatch `setPaused({ manuscriptId })` — pill renders the paused variant so the user can navigate back and resume.
   - **On `AnalysisError`** with `code: 'cast_incomplete' | 'stage1_shrink_refused' | 'attribution_drift' | unknown`: dispatch `setHalted({ manuscriptId, code, message })`.
   - **Pause button click**: in addition to the existing imperative `analysisControllerRef.current?.abort()` (which tears down the per-tab fetch), dispatch `setPaused({ manuscriptId })`. The middleware sees this and fires the server-side `pauseAnalysis` so the analyzer actually stops.

4. **Out of scope for B2** (deliberate): the middleware does NOT yet own its own SSE for the pill. Snapshot updates flow through the view's existing SSE handlers — when the user navigates away, snapshot freezes at the last-tick state. B3 can opt to extend the middleware with its own SSE if the pill needs live ticks during navigation, but the freeze-then-thaw-on-return behavior is acceptable for v1.

### Top-bar pill (B3)

1. **`AnalysisPill` in `src/components/top-bar.tsx`**, rendered to the LEFT of `GenerationPill` so both can be visible simultaneously when a generation and an analysis are alive on different books (rare but legal post-B1). Variants:
   - `running` — peach background + spinner icon, label `Analysing · {phaseLabel} · {percent}%`.
   - `stalled` — amber background + clock icon, label `Stalled · {phaseLabel}`. Derived state: `state === 'running' && (Date.now() - lastTickAt) > STALL_THRESHOLD_MS` (re-evaluated per second via the same forceClockTick used by the generation pill).
   - `paused` — neutral ink background + clock icon, label `Paused · {phaseLabel}`. No percent (paused work doesn't tick).
   - `halted` — rose background + warning icon, label `Halted · {phaseLabel} · {haltReason}` (trimmed to 32 chars + ellipsis on render; the full message lives on the button's `title` attribute for hover).

2. **`src/components/layout.tsx` plumbing**: reads `s.analysis.activeStream`, derives the pill data inline (so the per-second forceClockTick refreshes the stalled check), passes it as `analysisPill` to TopBar. Click handler routes to `/books/:bookId/analysing` so the pill is always a one-click shortcut back to the analysing view from anywhere in the app. The overall-percent formula matches the analysing view's bar: phase 0 covers 45%, phase 1 covers 50%, phase 2 covers 5% (`phaseWeights = [0.45, 0.50, 0.05]`).

3. **Tests** in `src/components/top-bar.test.tsx` cover: hidden when `analysisPill` is null, all four variants render the expected label + chip styling, click handler fires, and the pill coexists with the generation pill when both are alive.

### Local-analyzer guard (`src/hooks/use-local-analyzer-guard.tsx`)

The existing hook protects analysis-starting callsites when an audio generation is alive — that's the direction the previous version of the codebase needed because navigating away from the analysing view aborted the analyzer (so analysis-after-generation was the only scenario you could trip).

Sticky analysis (B1-B3) opens a new symmetric direction: starting TTS generation when a local analysis is alive on a different book. Both run, both compete for GPU. The reverse-direction guard is **not yet wired** — generation start happens implicitly via `generation-stream-middleware`'s reconcile loop, so there is no analogous user-facing "Start generation" callsite to hook into. The hook's comment block now references plan 32 + the new slice; a future extension can read `s.analysis.activeStream != null` alongside `s.chapters.activeStream` to offer the same confirm dialog symmetrically. Tracked in **Known follow-ups** below.

## Acceptance walkthrough

Manual smoke against the canonical e2e manuscript (`~/Downloads/Bonus Keefe Story.txt`, per CLAUDE.md):

1. **Upload + start analysis.** Open `#/books` → drag Bonus Keefe Story onto the upload tray → click through Confirm metadata → land on `#/books/:bookId/analysing` → click Start analysis. Stream begins; `AnalysisPill` appears in the top-bar.
2. **Navigate mid-stream.** Click the Books / Voices / Account chrome to leave the analysing view while a phase is in flight. Expected: server log shows no `aborted` line; the analyzer's per-chapter cache writes keep landing. `AnalysisPill` stays visible across every navigation (snapshot may freeze at the last-tick state since B2 doesn't open a middleware-owned SSE — acceptable for v1).
3. **Click pill to return.** Click the `AnalysisPill` → navigates back to `#/books/:bookId/analysing`. The view re-opens its SSE → server's dispatcher attaches it as a fresh subscriber → catch-up replay delivers `lastPhase` + accumulated log lines + `lastEta` + `lastCastUpdate` + any active `chapter-failed` rows. UI hydrates without a flash of re-init.
4. **Pause.** Click Pause analysis → middleware fires `POST /api/manuscripts/:id/analysis/pause` → server-side analyzer loop's per-call signal aborts → `runMainAnalyzerJob`'s catch emits `{ kind: 'error', code: 'aborted' }` → all attached subscribers receive it → pill flips to the paused variant.
5. **Resume.** Click Resume analysis → view fires a fresh POST → server has no existing job (the paused one was deregistered by `endJob`) → new run starts from the cache → catches up via `chapterCast` to the chapter the abort caught → continues.
6. **Trigger an `attribution_drift` error** by editing the cache to mis-attribute >5% of sentences (or simulate via a model swap to an unreliable model) → run goes through Phase 1 → server emits `{ kind: 'error', code: 'attribution_drift' }` → pill flips to the halted variant with the drift summary truncated to 32 chars (full text on hover). manuscript-edits.json on disk has the demoted sentences; cast.json + state.json untouched.
7. **Multi-tab.** Open the analysing view in a second browser tab. Both tabs receive the same broadcast events. Pausing in one tab ends the run in both (the server's `endJob` ends every attached subscriber's response).

Server-side smoke (post-B1, no UI needed):

1. `cd server && npm run dev` (analyzer = `ANALYZER=manual` or `ANALYZER=gemini` per `.env`).
2. From a browser, POST to `/api/manuscripts/m_test/analysis` (with a valid manuscriptId from the workspace). Inspect with curl:
   ```powershell
   curl -X POST -H "Content-Type: application/json" -d '{}' http://localhost:8080/api/manuscripts/m_test/analysis
   ```
   Expect SSE frames starting with `:ok` then `data: { "kind": "phase", ... }` etc.
3. Close the curl (Ctrl+C) — server logs do NOT show an aborted analyzer. The loop continues on disk (Phase 0a chapter writes still landing).
4. Re-POST while the first run is alive — second connection receives the catch-up replay (last phase + log lines + cast-update + ETA) followed by live ticks.
5. `POST /api/manuscripts/m_test/analysis/pause` — first run's loop catches AnalysisAbortedError, emits final `{kind:'error', code:'aborted'}`, both subscribers' responses end.
6. POST again — fresh run kicks off (no existing job in the map).

## Critical files

- **Server**: `server/src/routes/analysis.ts` — `inFlightAnalysisByManuscript` map, `AnalysisJob` interface, helpers (`broadcastToJob`, `trackForReplay`, `replayCatchUp`, `endJob`, `isAnalysisJobRunning`), `runMainAnalyzerJob` function, `POST /pause` endpoint.
- **Server tests**: `server/src/routes/analysis.test.ts` describe block `sticky analysis — in-flight job map + /pause endpoint`.
- **Frontend** (B2/B3): `src/store/analysis-slice.ts`, `src/store/analysis-stream-middleware.ts`, `src/store/index.ts`, `src/views/analysing.tsx`, `src/components/top-bar.tsx`, `src/components/layout.tsx`, `src/hooks/use-local-analyzer-guard.tsx`, `src/lib/api.ts`.

## Out of scope / known follow-ups

- **Subset-retry route** (`POST /:id/analysis/chapters`) remains request-bound. Most subset retries are 1-3 chapter calls and the operational pain is on the main analysis route. A future extension could wrap the subset route in the same sticky pattern, sharing the `inFlightAnalysisByManuscript` map (with a second slot keyed on `${manuscriptId}:subset`).
- **Middleware-owned SSE for the pill** (B2 / B3). The middleware doesn't yet open its own SSE — snapshot updates flow through the view's existing SSE handlers. When the user navigates away from the analysing view, snapshot freezes at the last-tick state; the pill renders the frozen state until the user returns. Acceptable for v1. If a fully-live cross-navigation pill becomes important, extend `analysis-stream-middleware.ts` to open its own SSE on `setActiveStream` (mirroring `generationStreamMiddleware.openHandle`) — server-side B1 supports multiple subscribers, so a second SSE per tab attaches cleanly without duplicate analyzer work.
- **Reverse-direction local-analyzer guard.** `useLocalAnalyzerGuard` today gates analysis-trigger callsites against a running TTS generation. The symmetric concern (TTS-start with a running local analysis) needs a corresponding guard at the generation-start callsite; deferred because generation start is implicit (middleware reconcile) and adding a UI gate there is a bigger surface change. Workaround: the user notices slow performance and pauses one.
- **Multi-tab catch-up race.** A second tab opening during the synchronous catch-up replay window can theoretically miss a tick if the first tab's reducer is mid-update. Acceptable since cast.json + manuscript-edits.json on disk are authoritative across reloads; the replay only seeds the in-memory view state.
- **Server restart drops the in-flight map.** Restart loses every active job — but the disk cache (`server/handoff/cache/{manuscriptId}.json`) survives, so the next POST resumes from cache. The pill's frozen state on the client side rehydrates when the user re-opens the analysing view.

## Related plans

- [04 — Analysing view & SSE progress](04-analysing-view-progress.md) — invariants covering the SSE event union, the analysing view's local state, and the data-integrity guards from the A-series that the B-series builds on.
- [31 — Sticky generation across navigation](31-sticky-generation.md) — sibling plan for audio generation; the patterns in this plan mirror it one-for-one. Most differences are surface-level (per-manuscript vs per-book key, phase-weighted overall vs done/total counters).
- [00 — Stage machine](00-stage-machine.md) — the `ui.stage` discriminated union the analysing view lives in; sticky analysis works *across* every stage transition.
