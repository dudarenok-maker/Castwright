# 32 — Sticky analysis across navigation

**Status:** stable. Server (B1), frontend slice + middleware + view wiring (B2), top-bar pill + docs (B3), middleware-owned cross-navigation SSE (D1), reverse-direction local-analyzer guard (D2), and cold-boot rehydration end-to-end (E1 server + E2 frontend) all landed. D1 (middleware-owned SSE) lifted the cross-navigation freeze on the pill — middleware now owns its own subscribe-only SSE in addition to the pause-bridge. D2 wired the symmetric reverse-direction local-analyzer guard so an explicit TTS-start (Resume / Regenerate\*) prompts when a local analysis is alive somewhere in the workspace.

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

2. **`src/store/analysis-stream-middleware.ts`** carries two limbs:
   - **Pause-bridge** (B2): `analysis/setPaused` → `api.pauseAnalysis({ manuscriptId })`. Fire-and-forget — the server endpoint is idempotent so a failed request is benign. The view's existing imperative abort still tears down the per-tab fetch consumer; the middleware tears down the server-side analyzer loop.
   - **Subscribe-only SSE handle** (D1): mirror of `generation-stream-middleware.ts`'s `openHandle` / `closeHandle`. Opens on the **first `applyAnalysisSnapshotTick`** (NOT on `setActiveStream`), passing only the snapshot-relevant callbacks (`onPhase`, `onEta`, `onSeriesPrior`); stays open across every navigation; closes on `setPaused` / `setHalted` / `clearActiveStream` / a terminal SSE event. The first-tick trigger guarantees the server-side job is already alive before the middleware POSTs, so the middleware's options-less POST is guaranteed to take the server dispatcher's subscribe path — it cannot race the view's POST and accidentally drop `fresh: true` / `model: ...` start-decision opts. Cross-manuscript displacement (a new `setActiveStream` for a different `manuscriptId`) aborts the old handle; the new handle opens on its own first tick.

3. **`src/views/analysing.tsx` wiring**:
   - **On SSE start** (the existing `api.analyseManuscript` call): dispatch `setActiveStream({ bookId, manuscriptId, bookTitle, phaseId: 0, phaseLabel, phaseProgress: 0, remainingMs: null, lastTickAt: Date.now(), state: 'running' })`. The pill (B3) sees this and renders live progress.
   - **On `onPhase` tick**: dispatch `applyAnalysisSnapshotTick({ manuscriptId, phaseId, phaseLabel, phaseProgress, lastTickAt })`.
   - **On `onEta` tick**: dispatch `applyAnalysisSnapshotTick({ manuscriptId, remainingMs, lastTickAt })`.
   - **On terminal success** (`onComplete`): dispatch `clearActiveStream()` — pill drops out (view transitions to confirm).
   - **On `AnalysisError`** with `code: 'aborted'`: dispatch `setPaused({ manuscriptId })` — pill renders the paused variant so the user can navigate back and resume.
   - **On `AnalysisError`** with `code: 'cast_incomplete' | 'stage1_shrink_refused' | 'attribution_drift' | unknown`: dispatch `setHalted({ manuscriptId, code, message })`.
   - **Pause button click**: in addition to the existing imperative `analysisControllerRef.current?.abort()` (which tears down the per-tab fetch), dispatch `setPaused({ manuscriptId })`. The middleware sees this and fires the server-side `pauseAnalysis` so the analyzer actually stops.

4. **D1 contract — what the middleware consumes vs leaves to the view.** To avoid double-dispatching into stateful reducers, the middleware-owned SSE consumes only the snapshot-relevant subset of the event union: `onPhase` (→ `applyAnalysisSnapshotTick`), `onEta` (→ `applyAnalysisSnapshotTick`), `onSeriesPrior` (→ `setSeriesPrior`), terminal `AnalysisError` (→ `setPaused` for `code: 'aborted'`, `setHalted` for any other code), and `onComplete` (→ `clearActiveStream`). `onLog`, `onCastUpdate`, `onChapterFailed`, `onChapterResolved`, `onHeartbeat`, and `onThrottle` stay view-only — they drive local `useState` or merge into the cast slice from the view's own SSE, and a middleware double-dispatch would either fight the view for reducer ownership or waste work. The snapshot-subset overlap between the view + middleware is intentional and idempotent: the slice's `applyAnalysisSnapshotTick` reducer keeps the latest tick regardless of which consumer dispatched it.

### Top-bar pill (B3)

1. **`AnalysisPill` in `src/components/top-bar.tsx`**, rendered to the LEFT of `GenerationPill` so both can be visible simultaneously when a generation and an analysis are alive on different books (rare but legal post-B1). Variants:
   - `running` — peach background + spinner icon, label `Analysing · {phaseLabel} · {percent}%`.
   - `stalled` — amber background + clock icon, label `Stalled · {phaseLabel}`. Derived state: `state === 'running' && (Date.now() - lastTickAt) > STALL_THRESHOLD_MS` (re-evaluated per second via the same forceClockTick used by the generation pill).
   - `paused` — neutral ink background + clock icon, label `Paused · {phaseLabel}`. No percent (paused work doesn't tick).
   - `halted` — rose background + warning icon, label `Halted · {phaseLabel} · {haltReason}` (trimmed to 32 chars + ellipsis on render; the full message lives on the button's `title` attribute for hover).

2. **`src/components/layout.tsx` plumbing**: reads `s.analysis.activeStream`, derives the pill data inline (so the per-second forceClockTick refreshes the stalled check), passes it as `analysisPill` to TopBar. Click handler routes to `/books/:bookId/analysing` so the pill is always a one-click shortcut back to the analysing view from anywhere in the app. The overall-percent formula matches the analysing view's bar: phase 0 covers 45%, phase 1 covers 50%, phase 2 covers 5% (`phaseWeights = [0.45, 0.50, 0.05]`).

3. **Tests** in `src/components/top-bar.test.tsx` cover: hidden when `analysisPill` is null, all four variants render the expected label + chip styling, click handler fires, and the pill coexists with the generation pill when both are alive.

### Forward + reverse local-analyzer guards

Two sibling hooks live in `src/hooks/`:

- **Forward** (`use-local-analyzer-guard.tsx`): gates analysis-starting callsites when a TTS generation is alive. Reads `s.chapters.activeStream` (TTS handle) + `s.ui.selectedModel` (which engine the user is about to fire). Pre-existing.
- **Reverse** (`use-reverse-local-analyzer-guard.tsx`, D2): gates TTS-starting callsites when a local analysis is alive. Reads `s.analysis.activeStream` (analysis handle) + the **`engine`** field captured ON that snapshot at `setActiveStream` time (not `s.ui.selectedModel`, which could have changed mid-stream).

D2 added an `engine?: 'local' | 'gemini'` field to `AnalysisStreamSnapshot` (`src/store/analysis-slice.ts`) so the reverse hook knows what the running analysis is actually using. The view dispatches it at `setActiveStream` (`src/views/analysing.tsx`) from `MODEL_OPTIONS.find(m => m.id === selectedModel)?.engine`. Capturing on the snapshot — not reading `selectedModel` at guard-decision time — ensures a user model-switch mid-stream cannot misclassify the running run.

**Insertion contract for the reverse guard (explicit TTS-start callsites only):**

- `src/views/generation.tsx` Pause/Resume toggle, but only on the `paused → !paused` transition. Pausing TTS doesn't compete for GPU; only resuming does. The toggle's onClick branches: `if (paused) reverseGuard(() => setPaused(false)); else setPaused(true);`.
- `src/components/layout.tsx` regenerate-modal onConfirm callbacks: `RegenerateModal`, `CharacterRegenerateModal`, `BatchCharacterRegenerateModal`. The onConfirm closes its own modal first (so the reverse-guard dialog doesn't stack on top), then wraps the regen dispatch + view change in `reverseAnalyzerGuard(...)`.

**Implicit reconcile path (middleware-level rule, 2026-05-17 follow-up):**

`generation-stream-middleware.ts`'s reconcile-driven `openHandle` enforces the same `engine === 'local'` + bookId-match rule as the D2 hook, but at the middleware level (not via a modal). The scenario the original D2 deliberately left open — cold-boot rehydration of a book with both an alive local analysis AND queued chapters — would auto-fire generation behind the user's back, competing for the GPU. The middleware now refuses by dispatching `chaptersActions.setPaused(true)` instead of opening the handle; the user reads the live AnalysisPill, knows what's running, and clicks Resume on Generate when ready. No new modal is added — the explicit-start sites still use the D2 hook (so the user gets the consent prompt on Resume / Regenerate), and the implicit-start site silently refuses (the user's intent on a cold-boot reload is ambiguous; defaulting to "don't act" matches the principle of least surprise). Pinned by `src/store/generation-stream-middleware.test.ts` ("reverse-local-analyzer guard (plan 32 D2 follow-up)") — five cases covering: local-engine gates, gemini-engine doesn't, paused doesn't, halted doesn't, cross-book doesn't.

**Explicitly NOT gated (still the case):**

- The forward guard never fires on an already-running TTS generation (the user-initiated stop path is just `setPaused(true)`).

**Modal confirm action:** `dispatch(analysisActions.setPaused({ manuscriptId }))`. The pause-bridge + D1 close-handler in `analysis-stream-middleware.ts` together (a) fire `POST /pause` to the server, (b) close the middleware's own SSE, and (c) flip the snapshot's state to `paused` so the pill renders the paused variant. The user can resume from the analysing route afterwards.

## Acceptance walkthrough

Manual smoke against the canonical e2e manuscript (`~/Downloads/the Coalfall Commission.txt`, per CLAUDE.md):

1. **Upload + start analysis.** Open `#/books` → drag the Coalfall Commission onto the upload tray → click through Confirm metadata → land on `#/books/:bookId/analysing` → click Start analysis. Stream begins; `AnalysisPill` appears in the top-bar.
2. **Navigate mid-stream.** Click the Books / Voices / Account chrome to leave the analysing view while a phase is in flight. Expected: server log shows no `aborted` line; the analyzer's per-chapter cache writes keep landing. `AnalysisPill` stays visible AND keeps ticking across every navigation (D1 middleware-owned SSE attaches as a second subscriber to the server's in-flight job, so phase progress / ETA refreshes without the view being mounted).
3. **Click pill to return.** Click the `AnalysisPill` → navigates back to `#/books/:bookId/analysing`. The view re-opens its SSE → server's dispatcher attaches it as a fresh subscriber → catch-up replay delivers `lastPhase` + accumulated log lines + `lastEta` + `lastCastUpdate` + any active `chapter-failed` rows. UI hydrates without a flash of re-init.
4. **Pause.** Click Pause analysis → middleware fires `POST /api/manuscripts/:id/analysis/pause` → server-side analyzer loop's per-call signal aborts → `runMainAnalyzerJob`'s catch emits `{ kind: 'error', code: 'aborted' }` → all attached subscribers receive it → pill flips to the paused variant.
5. **Resume.** Click Resume analysis → view fires a fresh POST → server has no existing job (the paused one was deregistered by `endJob`) → new run starts from the cache → catches up via `chapterCast` to the chapter the abort caught → continues.
6. **Trigger an `attribution_drift` error** by editing the cache to mis-attribute >5% of sentences (or simulate via a model swap to an unreliable model) → run goes through Phase 1 → server emits `{ kind: 'error', code: 'attribution_drift' }` → pill flips to the halted variant with the drift summary truncated to 32 chars (full text on hover). manuscript-edits.json on disk has the demoted sentences; cast.json + state.json untouched.
7. **Multi-tab.** Open the analysing view in a second browser tab. Both tabs receive the same broadcast events. Pausing in one tab ends the run in both (the server's `endJob` ends every attached subscriber's response).

8. **Browser reload (cold-boot, server still alive — E2).** Start an analysis, wait for the Phase 0 → Phase 1 boundary (visible in pill label change). `.audiobook/analysis-state.json` should exist with `phaseId: 1, state: 'running', engine: 'local'|'gemini'`. **Reload the tab** (Ctrl-Shift-R). Pill reappears with running state because the server's in-flight job is still alive and `snapshotInFlightAnalysis` returns its current phase ahead of the disk fallback.

9. **Pause → server restart → browser reload (cold-boot, server restarted — E2).** Click Pause analysis → pill flips to paused, `analysis-state.json` updates to `state: 'paused'`. **Stop the server** (Ctrl-C in `cd server && npm run dev`). Restart. **Reload the tab.** Pill reappears as paused — the in-flight map is empty so the discovery endpoint falls through to disk; the disk file was already paused so no coercion was needed. Click the pill → analysing view → click Resume → new SSE → catch-up replay from disk cache → continues from the last completed chapter.

10. **Crash mid-run (cold-boot, running→paused coercion — E2).** Start an analysis. While Phase 0 is mid-flight, kill the server hard (close the terminal or kill the Node process; do NOT pause first). Restart server. **Reload the tab.** Pill reappears as **paused** (not running), because the disk file's last write said `running` but the coercion logic in `GET /:bookId/analysis/state` promotes it since no live job exists. The user can click pill → Resume → analyzer picks up from the last completed chapter via the cache.

11. **Negative case — completion deletes the file.** Let an analysis run to a `result` event (terminal success). Verify `.audiobook/analysis-state.json` no longer exists. **Reload the tab.** No pill appears (the discovery endpoint returns 404 → frontend leaves the slice empty).

12. **Halt case — `attribution_drift` write.** Force an `attribution_drift` (edit the cache to mis-attribute >5% of sentences). Pill flips to halted. Verify `analysis-state.json` has `state: 'halted'`, `haltCode: 'attribution_drift'`, `haltReason` truncated to ≤256 chars. **Reload the tab.** Pill reappears as halted; the user can navigate to the analysing view and retry from there.

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

### Cold-boot rehydration (E1)

The B/C/D invariants cover navigation and same-process reload, but the `inFlightAnalysisByManuscript` map is in-memory and the `analysis.activeStream` Redux snapshot lives in the browser tab — both evaporate when their respective process restarts. E1 closes that gap by persisting a minimal snapshot to `.audiobook/analysis-state.json` at phase boundaries + on terminal events, and exposing a discovery endpoint the frontend can call on layout mount.

1. **On-disk schema** lives at `server/src/store/analysis-state.ts`. Minimal subset of `AnalysisStreamSnapshot` — manuscriptId, phaseId/Label/Progress, state (`running` | `paused` | `halted`), `haltCode?`, `haltReason?` (trimmed to 256 chars), `lastTickAt`, `writtenAt`. Sibling to state.json under `.audiobook/`; path resolved via `analysisStateJsonPath(bookDir)` in `server/src/workspace/paths.ts`.

2. **Write sites in `analysis.ts`**:
   - **Phase-tick** (`trackForReplay`'s `phase` branch): every `kind:'phase'` event calls `persistRunningSnapshot(job, false)`. Throttled by `ANALYSIS_STATE_WRITE_THROTTLE_MS = 5000` so dense Phase 0a sub-ticks don't hammer the filesystem. Force-write is reserved for terminal events.
   - **Pause endpoint** (`POST /:id/analysis/pause`): writes `state:'paused'` synchronously _before_ aborting the controller. The synchronous write guarantees a cold-boot fetch right after pause sees paused state — the analyzer's `endJob({code:'aborted'})` catch will write the same state asynchronously (idempotent).
   - **`endJob(job, finalEv)`**: branches on the final event:
     - `kind:'result'` (terminal success) OR no final event → `deleteAnalysisState(bookDir)` so a completed analysis doesn't keep showing a pill.
     - `kind:'error', code:'aborted'` → write `state:'paused'`.
     - `kind:'error', code:<anything else>` (attribution_drift / cast_incomplete / stage1_shrink_refused / unknown_manuscript / upstream) → write `state:'halted'` with the trimmed haltCode + haltReason.

3. **`AnalysisJob` carries `bookDir: string | null`** — set at job creation from `record.bookDir`. `null` for legacy POST /api/manuscripts uploads that have no workspace book; those skip every disk write site, matching the existing cast.json / state.json guards.

4. **Discovery endpoint** lives at `GET /api/books/:bookId/analysis/state` in `server/src/routes/book-state.ts` (not analysis.ts — book-state already has the `findBookByBookId` lookup machinery). Resolution order: (a) look up `manuscriptId` from the book's state.json, (b) check the in-flight map via `snapshotInFlightAnalysis(manuscriptId)` — live job wins because its `replay.lastPhase` is freshest, (c) read `.audiobook/analysis-state.json` and **coerce `running` → `paused`** since no live job means the analyzer didn't survive the restart, (d) 404. Returns the `AnalysisStateFile` shape directly so the frontend can pass it to `setActiveStream` largely unchanged.

5. **What the coercion buys us**: the on-disk file is the _last phase-boundary snapshot_. After a server crash that file still says `running` because the analyzer never reached its terminal-write code path. Returning `running` to the client would lie — the pill would show live progress that's actually frozen. Coercing to `paused` instead matches the UX promise: the user clicks Resume, a new POST seeds a fresh in-flight job from disk cache, and live ticks resume.

6. **Frontend wiring (E2)**. `src/lib/api.ts` exports `getAnalysisState(bookId): Promise<AnalysisStateResponse | null>` — returns null on 404 so callers treat "no in-flight analysis" identically to "endpoint unreachable". `src/components/layout.tsx`'s per-book hydration effect (the same effect that already calls `getBookState`) fires `getAnalysisState` after the book-state response lands and, if it returns a snapshot, dispatches `analysisActions.setActiveStream` with the rehydrated shape (engine field included so the reverse-direction guard sees the right engine). The 404 case **does NOT clear** the slice — opening a book with no analysis must not clobber another book's still-live pill, consistent with how `chapters.activeStream` survives book switches.

   **Analysing-view side of the same rehydration** (added after the original E2 landing). The view's local `analysisStarted` state was previously never seeded from the slice, so a reload during an in-flight run left the _top-bar pill_ correctly streaming while the _view itself_ was stuck on a disabled "Start analysis" CTA — clicking it then issued a fresh POST that the server happily routed through its subscribe path, masking the bug as "I had to click before things appeared to run". `src/views/analysing.tsx` now runs a one-shot cold-boot effect (gated by `coldBootRehydratedRef`) that reads `s.analysis.activeStream` after mount: for `state='running'` it flips `analysisStarted=true` so the analysis SSE subscribes without a click; for `state='paused'` or `'halted'` it sets `hasStartedOnceRef.current=true` only, so the button label reads "Resume analysis" but no auto-fire happens — an explicit Pause must never be auto-undone. Regression tests live in `src/views/analysing.test.tsx` under `AnalysingView — cold-boot rehydration from analysis slice`.

7. **v1 scope: per-currently-opened-book only.** Discovery fires when the user opens any specific book and the layout transitions to `analysing | confirm | ready`. _Closed 2026-05-17:_ `GET /api/library/active-analyses` ships with the cold-boot top-bar pill (E2), and `feat/frontend-library-paused-badge` (2026-05-17) extends that same response into a per-card "Paused — resume?" / "Halted — review?" badge on the library home so the user spots an unopened paused book without clicking through. See invariant 8 below.

8. **Library-card paused badge.** Layout's existing `useEffect(api.getActiveAnalyses)` (one network call) now fans the result into two slices: the freshest snapshot drives the top-bar pill (E2, via `analysisActions.hydrateColdBoot`), and the full `snapshots` array drives the library slice's per-book badge (`libraryActions.hydratePausedSnapshots`). The library slice stores them in `pausedSnapshots: Record<string, ActiveAnalysisSummary>` — a separate map from `books[]` so the `getLibrary()` and `getActiveAnalyses()` effects can resolve in either order without racing. `BookCard` reads via `selectPausedSnapshotForBook(state, bookId)` and renders the badge in the cover's top-right when the book is NOT the currently-active card (an active card already shows the "Open" badge in the same slot, and the top-bar pill conveys the same paused state). State coercion `'paused'` → "Paused — resume?" (amber), `'halted'` → "Halted — review?" (rose). Pinned by `src/views/book-library.test.tsx` ("paused badge" cases).

## Critical files

- **Server core**: `server/src/routes/analysis.ts` — `inFlightAnalysisByManuscript` map, `AnalysisJob` interface (now with `bookDir`, `engine`, `lastDiskWriteAt`), helpers (`broadcastToJob`, `trackForReplay`, `replayCatchUp`, `endJob`, `isAnalysisJobRunning`, `snapshotInFlightAnalysis`, `persistRunningSnapshot`, `persistTerminalSnapshot`), `runMainAnalyzerJob` function, `POST /pause` endpoint.
- **Server cold-boot store**: `server/src/store/analysis-state.ts` — `readAnalysisState` / `writeAnalysisState` / `deleteAnalysisState`, `AnalysisStateFile` interface.
- **Server cold-boot endpoint**: `server/src/routes/book-state.ts` — `GET /:bookId/analysis/state` handler with memory-first / disk-fallback / running→paused coercion.
- **Server paths**: `server/src/workspace/paths.ts` — `analysisStateJsonPath(bookDir)`.
- **Server tests**: `server/src/routes/analysis.test.ts` (`sticky analysis — in-flight job map + /pause endpoint`), `server/src/store/analysis-state.test.ts` (read/write/delete + haltReason trim + malformed-JSON tolerance + engine round-trip), `server/src/routes/book-state.test.ts` (`book-state router — GET /:bookId/analysis/state` with 404 cases, paused/halted passthrough, running→paused coercion).
- **Frontend types**: `src/lib/types.ts` — `AnalysisStateResponse`.
- **Frontend API**: `src/lib/api.ts` — `getAnalysisState(bookId)` (real + mock).
- **Frontend wiring**: `src/components/layout.tsx` — per-book hydration effect dispatches `setActiveStream` from the cold-boot response after `getBookState` lands.
- **Frontend tests**: `src/lib/api-analysis-state.test.ts` (wire-level 404/200/halted/5xx/url-encoding), existing `src/store/analysis-slice.test.ts` (setActiveStream covers the new engine field via the type).
- **Frontend** (B2/B3/D1/D2): `src/store/analysis-slice.ts`, `src/store/analysis-stream-middleware.ts`, `src/store/index.ts`, `src/views/analysing.tsx`, `src/components/top-bar.tsx`, `src/hooks/use-local-analyzer-guard.tsx`, `src/hooks/use-reverse-local-analyzer-guard.tsx`.

## Out of scope / known follow-ups

- **Subset-retry route sticky — end-to-end** _(server: D1; frontend wiring: shipped 2026-05-17 in `feat/server-plan32-subset-sticky`)_. The server-side scaffolding for `inFlightSubsetByManuscript` landed with D1: `POST /:id/analysis/chapters` registers an `AnalysisJob` with `kind: 'subset'` + `subsetChapterIds` in the second in-flight map; the analyzer work runs in a detached `runSubsetAnalyzerJob` so a client disconnect doesn't abort it; concurrent re-POSTs attach as second subscribers via the shared `replayCatchUp` helper; `/pause` aborts both main and subset for the manuscript; `snapshotInFlightAnalysis` returns the subset job's state when one is live, falling back to main when only main is live. The cold-boot file already gains `kind` + `subsetChapterIds`, and `AnalysisPill` already swaps the headline to "Retrying · N chapters · 42%" when `kind === 'subset'`. **The 2026-05-17 follow-up closes the frontend gap**: the subset-retry dispatch sites in `src/views/analysing.tsx` (`handleRetryChapter`) and `src/views/generation.tsx` (`handleToggleExcluded` un-exclude path) now dispatch `setActiveStream({ kind: 'subset', subsetChapterIds: [...] })` and `applyAnalysisSnapshotTick` on every phase event — without those, the pill never rendered the subset variant during a live retry, and `analysis-stream-middleware.ts` could never attach as a sticky subscriber. `analysis-stream-middleware.ts` now branches `openHandle` on `snap.kind`: `subset` POSTs to `api.runAnalysisForChapters(manuscriptId, snap.subsetChapterIds, ...)` so the subscribe lands on the subset route's dispatcher; `main` (or undefined for legacy snapshots) keeps its original `api.analyseManuscript(...)` path. The middleware's displacement guard now closes the handle on `(manuscriptId, kind)` change so a main→subset shift on the same manuscript re-opens cleanly. Subset terminal success deliberately does NOT `deleteAnalysisState` so any sibling main snapshot survives. Pinned by `server/src/routes/analysis.test.ts` ("sticky subset retry — second in-flight slot"), `src/components/top-bar.test.tsx` ("AnalysisPill subset variant"), and `src/store/analysis-stream-middleware.test.ts` ("subset-retry route — plan 32 follow-up").
- **Cold-load tab rehydrates a server-side in-flight job.** D1's middleware-owned SSE opens on the first tick the view dispatches — so a fresh tab that lands on a non-analysing view (e.g. straight onto `/books`) does not discover a server-side in-flight job on its own. The user has to visit the analysing route once to trigger the view's POST, which seeds the snapshot and lets D1's first-tick trigger open the middleware handle. Track a separate follow-up if this becomes user-visible (the workaround — open the analysing view once — is cheap).
- **Implicit reconcile-driven generation start while a local analysis is alive.** D2 only gates EXPLICIT user-driven TTS-start callsites (Resume button, Regenerate modal confirms). The `generation-stream-middleware.ts` reconcile path that auto-opens a stream when the user lands on Generate with queued chapters is intentionally left unguarded — the user already consented when they originally started generation, and prompting on every navigation would surprise them. If this becomes user-visible (e.g. a user reports both runs slowed down because they navigated back to Generate without realising local analysis was still going), gate via a new "model contention controller" that distinguishes navigation-driven from user-driven opens.
- **Multi-tab catch-up race.** A second tab opening during the synchronous catch-up replay window can theoretically miss a tick if the first tab's reducer is mid-update. Acceptable since cast.json + manuscript-edits.json on disk are authoritative across reloads; the replay only seeds the in-memory view state.
- **Library-home pill for an unopened paused book.** _Shipped 2026-05-17_ as `feat/frontend-library-paused-badge`. The `GET /api/library/active-analyses` endpoint already exists (shipped with E2's cold-boot top-bar pill); the library slice now stores its per-book snapshots in a separate `pausedSnapshots` map, and `BookCard` renders a "Paused — resume?" / "Halted — review?" badge for any book whose snapshot is present and which is not the currently-active card. See invariant 8 in §"Server cold-boot rehydration (E1 + E2)".

## Related plans

- [04 — Analysing view & SSE progress](04-analysing-view-progress.md) — invariants covering the SSE event union, the analysing view's local state, and the data-integrity guards from the A-series that the B-series builds on.
- [31 — Sticky generation across navigation](31-sticky-generation.md) — sibling plan for audio generation; the patterns in this plan mirror it one-for-one. Most differences are surface-level (per-manuscript vs per-book key, phase-weighted overall vs done/total counters).
- [00 — Stage machine](00-stage-machine.md) — the `ui.stage` discriminated union the analysing view lives in; sticky analysis works _across_ every stage transition.
