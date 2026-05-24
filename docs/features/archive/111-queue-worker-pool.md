---
status: stable
shipped: 2026-05-25
owner: null
---

# Persisted queue as the single source of truth + N configurable generation workers

> Status: stable (all 4 waves shipped — setting + per-book map + the worker pool + the `GEN_CHAPTER_CONCURRENCY` retire)
> Key files: `src/store/generation-stream-runner.ts`, `src/store/queue-dispatcher-middleware.ts`, `src/store/chapters-slice.ts`, `src/store/generation-stream-middleware.ts`, `server/src/routes/generation.ts`, `src/views/account.tsx`
> URL surface: `#/books/<id>/generate`, global queue modal + top-bar pill, Account view
> OpenAPI ops: `GET/PUT /api/user/settings` (new `generationWorkers` field); generation SSE unchanged

## Benefit / Rationale

Completes plan 102's intended migration. The leftover "generating override" — the `generation-stream-middleware` reconcile opening an SSE directly whenever `hasWork(chapters)` is true (first-run after analysis + resume-on-reopen) — bypassed the workspace queue, so the queue modal showed "Empty" while a book generated (plan 110 patched the symptom read-side; this fixes the root).

- **User:** the persisted `.queue.json` queue genuinely *is* what's generating — reorder/cancel/pause work on real entries; generation resumes from the queue across reloads with no book open; a single **"Generation workers"** setting (default 2) tunes how many chapters synthesise at once.
- **Technical:** one stream-open path (the dispatcher), one persisted source of truth. Parallelism is queue-level (N workers), not per-book.
- **Architectural:** removes the dual SSE-open paths; the GPU semaphore stays the orthogonal VRAM guard.

## Architectural impact

- **Worker model = coalesce per book (Option A):** the dispatcher claims up to N queued entries from the flat queue across books, groups same-book claims into ONE stream (`chapterIds:[...]`); the existing plan-87 server pool fans them out. Different books → separate concurrent streams. Cap = distinct in-flight chapters ≤ N.
- **Hard constraint:** the server keys jobs by book (`inFlightByBook`, `generation.ts`) and aborts a book's prior job on any forced request, so two concurrent streams for the SAME book can't coexist — hence coalesce-per-book, one stream per book.
- **`activeStream` (single) → `activeStreams: Record<bookId, snapshot>`**; runner single `handle` → `Map<bookId, OpenHandle>`.
- **`GEN_CHAPTER_CONCURRENCY` is retired (renamed to `GEN_WORKERS`):** the plan-87 pool stays as the within-book fan-out engine; its width is the resolved `generationWorkers` setting (env override `GEN_WORKERS`, default 2). The old `GEN_CHAPTER_CONCURRENCY` env is no longer read (wave 4). Plan 107 within-chapter parallelism is independent (keys off `gpuSemaphore.maxConcurrency`).
- **Reversibility:** `generationWorkers=1` reproduces serial generation.

## Wave sequence (each wave = one PR, ordered so there is NO parallelism-regression window)

- **Wave 1 (shipped) — `generationWorkers` setting end-to-end.** openapi `UserSettings`/`UserSettingsPatch`; `server/src/workspace/user-settings.ts` (`z.number().int().min(1).max(4)`, default 2, `getResolvedGenerationWorkers()` resolver: `GEN_WORKERS` env > legacy `GEN_CHAPTER_CONCURRENCY` env > setting > 2); `generation.ts` pool width reads the resolver; `account-defaults.ts` + `account-slice.ts` (`setGenerationWorkers`) + `account.tsx` (number input). The setting immediately tunes within-book fan-out via the existing pool; cross-book lands in Wave 3. No behavior change at the default (2).
- **Wave 2 (shipped) — `activeStream` → per-book map (client-only).** `activeStreams: Record<bookId, snapshot>` + reducers (`setActiveStream` keyed by bookId, `clearActiveStream(bookId)`, `updateActiveStreamProgress({bookId,…})`) + `selectActiveStreams`/`selectAnyActiveStream`; cross-book guard reframed for the map; migrated the top-bar pill (aggregates done/total/inProgress, stalled iff every stream quiet, onClick → queue modal when >1 book), broadcast-middleware (wire still one snapshot), local-analyzer guard, queue-slice Part-A overlay selectors, dispatcher single-in-flight gate. Runner still single-handle (N=1, behaviour identical).
- **Wave 3 (shipped) — worker pool.** Runner → `Map<bookId, OpenHandle>` with per-stream tick routing (each stream's `onTick` dispatches `applyGenerationTick` only for the viewed book + self-drives snapshot/rollup/idle-close); `close(bookId)`/`closeAll`/`openBookIds`/`openChapterIds`/`hasOpenStreamForBook`. Dispatcher fills up to N workers (`generationWorkers`) from the flat queue, coalescing same-book claims into one stream; a `completed` set prevents re-claiming an entry between its stream closing and the DELETE landing (the no-loop guard). The `hasWork` reconcile override is GONE — the middleware now only does enqueue-on-work (auto-enqueue the viewed book's pending chapters, gated by pause + the reverse-local-analyzer guard), the halt path (pause each open book + `closeAll`), and the pending-revision stubs. New tests: `generation-stream-runner.test.ts` (multi-handle, per-book idle close, rollup, cross-book snapshot), rewritten dispatcher tests (N-slot fill, same-book coalesce/no-abort, no double-claim, no-loop), rewritten middleware tests (enqueue-on-work + analyzer guard + halt + stubs).
- **Wave 4 (shipped) — retire `GEN_CHAPTER_CONCURRENCY`.** `getResolvedGenerationWorkers` no longer reads the legacy env; the generation tests + `.env`/docs references renamed to `GEN_WORKERS`; the plan-87 archive notes the rename.

## Invariants to preserve

- One stream per book (the server's per-book job model is untouched).
- Queue/synthesis concurrency only — the GPU semaphore (`GPU_CONCURRENCY`) remains the VRAM guard; raising `generationWorkers` never risks OOM.
- No regen loop: a completed chapter's entry is removed before the dispatcher re-picks it; a `done` row is never re-enqueued.

## Test plan

### Automated coverage

- **Wave 1:** `server/src/workspace/user-settings.test.ts` — `generationWorkers` schema (accepts 1–4, rejects 0/5/2.5, optional) + `getResolvedGenerationWorkers` resolver chain (default 2, `GEN_WORKERS`, legacy `GEN_CHAPTER_CONCURRENCY`, env-precedence, cached setting, non-numeric fallback). `src/store/account-slice.test.ts` — `setGenerationWorkers` reducer + fetch/save round-trip. `src/views/account.test.tsx` — input renders persisted value, defaults to 2, clamps to [1,4], round-trips through Save.
- **Waves 2–4 (pending):** per-book activeStream reducers + pill aggregation; dispatcher N-slot fill + no-loop + no-double-claim + same-book-no-abort; cross-book e2e (`e2e/`); plan-87 env rename.

### Manual acceptance walkthrough

Run in mock mode: analyse a book → it auto-enqueues + drains via the queue (no override); open the queue modal mid-run → real reorderable/cancelable entries; set workers=2 in Account → two chapters/books synthesise at once; reload mid-run → resumes from persisted `.queue.json`.

## Out of scope

Literal N-streams-per-book (would require re-keying the server's per-book job model — no user-visible benefit on a single GPU). Per-quote emotion / language work (other plans).

## Ship notes

Shipped 2026-05-25 across four PRs: #223 (wave 1 — the `generationWorkers` setting end-to-end), #224 (wave 2 — `activeStream` → per-book map), #225 (wave 3 — the worker pool: multi-handle runner + dispatcher N-slots + override removal + the mock-queue that lets generation run in mock mode), and the wave-4 retire of `GEN_CHAPTER_CONCURRENCY` (renamed to `GEN_WORKERS`). Plan 110 (PR #219) shipped the read-side honesty overlay + GPU-badge rename earlier; its overlay stays as a safety net (the queue is now authoritative, so it rarely fires). Behaviour delta vs the original sketch (BACKLOG #44 "reflection enqueue"): the user chose the cleaner worker-pool model — the `hasWork` override is removed entirely rather than mirrored, and parallelism is a configurable queue-worker count (coalesce-per-book) rather than per-book batching.
