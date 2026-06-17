# Deterministic-test playbook

How to convert a contention-flaky server test (real-timer poll + drive-to-completion
+ real I/O) into a deterministic one that passes flat under load. Proven on
`server/src/routes/analysis-pipelining.test.ts` (was ~368 s under induced load →
~2–4 s flat).

## The recipe

1. **Mock real I/O that isn't under test.** Add a `vi.mock(...)` for the module
   doing disk/network work (e.g. `vi.mock('../store/analysis-cache.js', ...)` with
   an in-memory `Map`). The empty/miss shape must match the real return
   (`{ chapters: {} }`, not `{}`). This removes the load-sensitive I/O from the
   assertion path. Back the lost integration coverage with a dedicated,
   deterministic regression test (see `analysis-cache.race.test.ts`).
2. **Await events, not the clock.** Replace `waitFor(() => trace.some((t) =>
   t.phase === X && t.chapterId === Y), budgetMs)` with `await
   fixture.whenDispatched(X, Y)`. The fixture's `whenDispatched` is **pre-armed**
   (resolves immediately if the entry exists, else on the push that creates it).
   For multi-id waits: `await Promise.all(ids.map((id) => fixture.whenDispatched(phase, id)))`.
3. **Negative assertions: drain to quiescence + a positive control.** To prove
   "X did NOT happen", a fixed microtask count is a vacuous pass. Loop microtasks
   until the trace length is stable (`settle()`), AND assert a positive control
   (something that SHOULD have happened did) so a vacuous pass is caught, THEN
   assert the absence.
4. **Mind hold/release races.** Before `releasePhase0(K)`, ensure chapter K has
   actually entered its hold via `await fixture.whenDispatched(0, K)` — otherwise
   the release fires the no-op placeholder and the later real resolver hangs.
5. **Timeout = deadlock backstop only.** Drop large inline per-test timeouts
   (`}, 180_000`); inherit the config default. A healthy run drains in ms; the
   backstop only trips on a true deadlock.

## Acceptance bar

Run `node scripts/flake-repro.mjs --file <test> --runs 3 --cpu-load --io-load`.
The test must pass every run with runtime **flat** vs no-load (no real disk/network
await remains in the assertion path). Worker-count/CPU-load invariance is a
secondary signal — the primary bar is **zero real I/O in the assertion path**.
