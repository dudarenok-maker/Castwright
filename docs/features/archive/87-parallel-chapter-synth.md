---
status: stable
shipped: '2026-05-21'
owner: dudarenok-maker
---

# Parallel chapter synthesis with bounded worker pool

> **REMOVED (2026-05-25, plan-111 follow-up):** the within-book chapter worker pool this plan introduced has been **removed**. Concurrency is now **one chapter per queue worker** via the plan-111 queue dispatcher — N (`generationWorkers`) chapters run concurrently across all books (including sibling chapters of the same book), each as its own `${bookId}::${chapterId}` server job. The server renders exactly its target chapter; there is no longer a within-book `Promise.all` pool fanning a book's chapters out (a trivial sequential `${bookId}::*` loop remains only for the back-compat no-/multi-id caller path). The per-chapter SSE track shape, the per-chapter stall watchdog, and plan-107 within-*chapter* sentence parallelism all survive — only the chapter-level pool described below is gone. See `docs/features/archive/111-queue-worker-pool.md` § "Update — 2026-05-25" for the full delta. Everything below is historical.
>
> **Plan 111 update (2026-05-25):** the pool's width env `GEN_CHAPTER_CONCURRENCY` was renamed to `GEN_WORKERS` and is now driven by the `generationWorkers` user setting (default 2). The pool itself (this plan) is unchanged — it's the within-book fan-out engine the plan-111 queue dispatcher opens streams against. References to `GEN_CHAPTER_CONCURRENCY` below are historical; read them as `GEN_WORKERS`.
>
> Status: stable
> Key files: `server/src/routes/generation.ts:485-530`, `server/src/synthesise-chapter.ts`, `src/lib/api.ts`, `src/store/ui-slice.ts`
> URL surface: indirect — `#/books/<id>/generation`; SSE stream emitted by `POST /api/books/:bookId/generation`
> OpenAPI ops: `POST /api/books/{id}/generation` — wire shape unchanged; SSE event payloads gain per-chapter track identification (every event already carries `chapterId`; consumer must stop assuming events arrive in monotonic chapter order)

## Benefit / Rationale

- **User:** for an 80-chapter book, ~2× faster generation on a single 8 GB GPU. Kokoro v1 is ~1 GB resident and two concurrent inferences fit without eviction. The user perceives this as "the book renders in half the wall-clock" — directly visible in the generation pill and on-disk arrival of `<bookDir>/audio/<slug>.mp3` files.
- **Technical:** the sidecar `/synthesize` route is already concurrent (`asyncio.to_thread` offload, GIL-releasing inference). `server/tts-sidecar/tests/test_concurrent_synthesis.py:214-244` pins that N concurrent calls run in wall-clock ~single-call time per engine. The bottleneck is the orchestrator's sequential `for…await synthesiseChapter` at `server/src/routes/generation.ts:485-530` — replacing that loop with a bounded `Promise.all` pool extracts the parallelism the sidecar already supports.
- **Architectural:** opens a per-chapter SSE track shape that future per-sentence parallelism (BACKLOG Could #21 / A2) can stack on without re-plumbing the consumer.

## Architectural impact

- **New seam:** `GEN_CHAPTER_CONCURRENCY` env (default `2`); bounded worker pool over the chapter array. Each chapter still walks its sentences sequentially per plan 70d.
- **SSE consumer change:** events from multiple chapters interleave on the wire. The frontend consumer (`src/lib/api.ts`) routes by `chapterId` into per-chapter progress tracks in `src/store/ui-slice.ts`. The global ETA derivation switches from "cumulative seconds remaining on the current chapter" to "max(per-chapter ETA)" across the in-flight set.
- **Stall watchdog stays per-chapter:** the `onGroupStart` heartbeat (plan 16) fires once per sentence group within a chapter; concurrent chapters each have their own watchdog timer (no shared 30 s window). One stalled chapter no longer blocks siblings — it surfaces as a per-track "stalled" pill while the others keep advancing.
- **Disk-write contention:** negligible. Per-chapter `<bookDir>/audio/<slug>.mp3` paths differ by `chapterId`, no overlap.
- **Migration:** none. Existing `BookStateJson` fields unchanged. Old in-flight generation streams (resumed from sticky state per plan 31) keep working — when concurrency env is unset or `1`, behaviour reverts to today's serial loop exactly.
- **Reversibility:** flip `GEN_CHAPTER_CONCURRENCY=1` to disable. The serial branch is preserved in the code as the `K=1` case of the same pool.

## Invariants to preserve

- Plan 16 SSE event shape — chapter ids unchanged, event types (`chapter:start`, `chapter:sentence-done`, `chapter:done`, etc.) unchanged.
- Plan 70d per-sentence groups inside `synthesiseChapter` unchanged — concurrency is at the chapter layer only, not the sentence layer.
- Plan 28 on-disk audio format unchanged (MP3 VBR V2 + `<slug>.mp3` + segments.json metadata).
- Plan 31 sticky-generation contract unchanged — resume after navigation still works; the per-chapter track shape is computed deterministically from the (active book, chapter array, in-flight set) tuple.
- [project_concurrent_multibook_workflow] preserved — per-chapter dist folders prevent cross-book / cross-chapter collisions.

## Test plan

### Automated coverage

- Vitest server (`server/src/routes/generation.test.ts`) — asserts the worker pool starts exactly K chapters concurrently when K = `GEN_CHAPTER_CONCURRENCY`; remaining chapters queue and start as siblings finish; K=1 path is byte-identical to today's serial behaviour.
- Vitest frontend (`src/store/ui-slice.test.ts` and `src/lib/api.test.ts`) — asserts per-chapter ETA tracking and SSE event routing by `chapterId` (interleaved events from chapter A and chapter B route to the correct track).
- Playwright e2e (`e2e/generation-parallel.spec.ts`, new) — in mock mode, asserts chapter 2 emits `chapter:start` before chapter 1's `chapter:done`. Mock mode is sufficient because we're verifying orchestrator shape, not GPU throughput.

### Manual acceptance walkthrough

Real-backend regression on the canonical end-to-end manuscript:

1. **Pre-reboot baseline:** per [feedback_reboot_before_perf_baselines], reboot first; record `GEN_CHAPTER_CONCURRENCY=1` wall-clock for `server/src/__fixtures__/the-coalfall-commission.md` end-to-end generation (single Kokoro engine, no other GPU consumers).
2. **Default-concurrency run:** set `GEN_CHAPTER_CONCURRENCY=2`, regenerate same book; expect 50–70% of serial baseline wall-clock (target: 2× speedup minus orchestrator overhead).
3. **Pill UI:** generation pill shows aggregated "K of N" + per-chapter mini-bars (UI detail TBD during implementation).
4. **Stall scenario:** kill the sidecar mid-chapter-2 while chapters 1 and 3 are in flight; chapter 2 track shows "stalled" pill within 30 s; chapters 1 and 3 continue and complete; resume mode (plan 31) restarts only chapter 2 on the next navigate-back.

## Out of scope

- **A2 — within-chapter sentence parallelism** → BACKLOG Could #21. Stacks on this plan; defer until measurement shows GPU headroom remains under default concurrency.
- **A3 — both engines (Kokoro + XTTS) resident** → BACKLOG Could #22. Independent of chapter concurrency; speed gain conditional on mixed-engine casts.
- **B1 — per-phase analyzer model** → plan 88 (parallel branch).
- **C2/C3/C5 — frontend perf bundle** → plan 89 (parallel branch).

## Ship notes

Shipped **2026-05-21** via PR [#102](https://github.com/dudarenok-maker/AudioBook-Generator/pull/102), merged at commit `7b6cd1c`. Implementation followed the plan unchanged.

Highlights:
- `processOneChapter` extracted from the inline body of `runMainGenerationJob` in `server/src/routes/generation.ts` and wrapped in a K-wide index-pulling worker pool driven by `GEN_CHAPTER_CONCURRENCY` (default `2`, invalid env falls back to `2`, range `>=1`).
- Cascade-fatal aborts the shared signal so in-flight siblings exit cleanly; `job.currentChapterId` cleanup is sibling-safe.
- `src/store/chapters-slice.ts` routes interleaved per-chapter events (progress, chapter_complete, chapter_failed) by `chapterId` — events for chapter B never touch chapter A's row, even when both are `in_progress` simultaneously.
- 10 new tests landed: 6 server vitest cases in `server/src/routes/generation.test.ts` (K=1 strict, K=2 both-in-flight, K=2 start-ordering, K=2 no-drop, K>N clamp, invalid-env fallback) + 4 frontend vitest cases in `src/store/chapters-slice.test.ts` (interleaved-event routing). Existing tests set `GEN_CHAPTER_CONCURRENCY=1` in `beforeAll` to preserve byte-identical serial assertions.
- Punted to **BACKLOG Could #27**: Playwright e2e for interleaved SSE in mock mode. The current `mockStreamGeneration` hard-codes serial advance; teaching the mock to interleave is a separate isolated change.

Wall-clock measurement against the canonical end-to-end manuscript is in the manual-acceptance walkthrough; defer to the user's run for actual numbers once Round-4 perf-tuning pass opens.
