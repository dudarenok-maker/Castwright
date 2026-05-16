# 32 — Sticky analysis across navigation

**Status:** B1 landed (server). Frontend (B2/B3) WIP — see commit log.

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

### Frontend (B2 — WIP)

To be filled in once B2 lands. Sketch:
- `src/store/analysis-slice.ts` owns `activeStream: AnalysisStreamSnapshot | null` mirroring `chapters.activeStream`. Cross-book tick guard ensures a tick for a non-current book updates the snapshot but not the per-view phase log.
- `src/store/analysis-stream-middleware.ts` opens the SSE; the handle survives navigation and book switches; closes only on `setPaused(true)` or a terminal event.
- `src/views/analysing.tsx` no longer owns the SSE — consumes the slice. Pause button dispatches `setPaused(true)`. Mount with `activeStream` present hydrates from the snapshot without firing a fresh POST.

### Top-bar pill (B3 — WIP)

To be filled in once B3 lands. Sketch:
- `AnalysisPill` in `src/components/top-bar.tsx` next to `GenerationPill`. Reads `analysis.activeStream`. Click navigates back to `#/books/:bookId/analysing`. Variants: running / paused / halted / stalled.

## Acceptance walkthrough

To be expanded in B3. Server-side smoke (post-B1):

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

## Out of scope (B1)

- Subset-retry route (`POST /:id/analysis/chapters`) remains request-bound — most subset retries are 1-3 chapter calls and the operational pain is on the main analysis route.
- Frontend slice + middleware (B2).
- Top-bar pill + local-analyzer-guard wiring (B3).
- Multi-tab catch-up beyond the synchronous replay window — if a tab opens during a partial replay there's a tiny race; acceptable since cast.json + manuscript-edits.json on disk are the authoritative source of truth across reloads.
