# Mock-mode script-review dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop mock-mode script-review from running two racing timelines for one book (and close the shared-`sessionStorage` cancel-identity bug), by joining a concurrent caller to a single in-flight timeline with buffered-event replay.

**Architecture:** A module-level `Map<bookId, InFlightMockReview>` registry in `src/lib/api.ts` holds each live mock run's subscriber set + op/checkpoint accumulators + shared promise. `mockReviewScript` becomes a thin wrapper: an existing entry means *join* (replay accumulated ops/checkpoints to the new caller, then subscribe to live events); no entry means *start* (register, run the timeline body). Cancellation keys on entry-object identity, not the `sessionStorage` `running` flag. Real-backend paths are untouched.

**Tech Stack:** TypeScript, Vitest (+ jsdom, fake timers), React/Redux (consumer only — one comment touched).

## Global Constraints

- **Mock/dev/e2e only.** Do NOT touch `realReviewScript`, `realAttachScriptReview`, or any `server/` code. No OpenAPI change.
- **Design of record:** `docs/superpowers/specs/2026-07-14-mock-script-review-dedup-design.md`. This plan implements it; the "load-bearing constraint" (join MUST replay buffered ops/checkpoints, because `attachToRunningReview` deliberately does not seed from the state snapshot) is mandatory.
- **`setReview` is a per-chapter preserve-the-rest replace** — replay makes the joiner's op set identical to the original caller's, so the unavoidable double `setReview` is an idempotent no-op. Do not "optimize" away either dispatch.
- **Reset naming:** export `_resetMockScriptReviewInFlight` (single leading underscore, matching existing `_resetMockListenStats` / `_resetMockAppInfo`). (The spec sketched `__resetMockScriptReviewInFlight`; the single-underscore form matches the file's convention.)
- **Test isolation:** every `beforeEach` that clears `sessionStorage` for a block exercising `mockReviewScript`/`mockAttachScriptReview` MUST also call `_resetMockScriptReviewInFlight()` — clearing one but not the other manufactures an inconsistent state the design assumes impossible in-context.
- **Assert op SET, not `onOps` call order** in the dedup test: the join replays from chapter-keyed accumulators and `Object.entries` iterates integer-like keys ascending (ch1 before ch3), which is not emission order. Correctness is order-independent.
- **Commit convention:** `<type>(<scope>): <subject>`. Branch is already `fix/frontend-mock-script-review-dedup` in worktree `.claude/worktrees/mock-review-dedup`.

---

## File Structure

- `src/lib/api.ts` — **modify.** Add the registry type + map + `_resetMockScriptReviewInFlight`; replace `mockReviewScript` (currently ~lines 3281–3441) with a wrapper + `runMockReviewTimeline`; add one `inFlightMockReviews.delete(bookId)` to `mockCancelScriptReview`. `mockAttachScriptReview` is unchanged.
- `src/lib/api.test.ts` — **modify.** Import the reset export; add `_resetMockScriptReviewInFlight()` to the existing cancellation block's `beforeEach`; add a new `describe` block with the three tests.
- `src/views/manuscript.tsx` — **modify.** Extend one comment (~lines 182–184). No behavior change.
- `docs/release-notes-next.md` + `RELEASE_NOTES.md` — **modify.** One entry each.

---

## Task 1: Registry + dedup/replay + cancel-identity (api.ts + tests)

**Files:**
- Modify: `src/lib/api.ts` (registry near ~line 3280; `mockReviewScript` ~3281–3441; `mockCancelScriptReview` ~3678–3683)
- Test: `src/lib/api.test.ts` (imports ~line 27; cancellation block `beforeEach` ~line 614; new `describe` appended after the cancellation block, ~line 724)

**Interfaces:**
- Produces:
  - `interface InFlightMockReview { subscribers: Set<ReviewScriptOpts>; opsAccum: Record<number, ReviewOp[]>; versionAccum: Record<number, number>; promise: Promise<ReviewScriptResult> }` (module-private; `ReviewOp` via `import('./script-review-apply').ReviewOp`).
  - `export function _resetMockScriptReviewInFlight(): void` — clears the registry (test-only).
  - `mockReviewScript(bookId: string, opts?: ReviewScriptOpts): Promise<ReviewScriptResult>` — unchanged public signature; now dedups internally.
- Consumes (already in `api.ts` scope): `wait`, `ReviewScriptOpts`, `ReviewScriptResult`, `ReviewScriptError`, `SubstagePhaseEvent`, `readMockScriptReviewState`, `writeMockScriptReviewState`, `LedgerEntryDTO`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/api.test.ts`, add `_resetMockScriptReviewInFlight` to the import block from `./api` (alongside `mockReviewScript` at line 27):

```ts
  mockReviewScript,
  mockCancelScriptReview,
  mockAttachScriptReview,
  _resetMockScriptReviewInFlight,
```

In the existing `describe('mock-mode script-review cancellation (fs-58 follow-up #1481)', …)` block, update its `beforeEach` (currently just `sessionStorage.clear();`) to also reset the registry:

```ts
  beforeEach(() => {
    _resetMockScriptReviewInFlight();
    sessionStorage.clear();
  });
```

Append a new `describe` block immediately after that cancellation block (after its closing `});`, ~line 724):

```ts
describe('mock-mode script-review dedup against a concurrent in-flight timeline (#1496)', () => {
  beforeEach(() => {
    _resetMockScriptReviewInFlight();
    sessionStorage.clear();
  });

  it('a concurrent attach joins the single in-flight timeline (dedup) and replays already-emitted ops, without doubling the ledger', async () => {
    vi.useFakeTimers();
    try {
      const bookId = 'book-mock-dedup';
      const aOps: Array<{ chapterId: number; ops: unknown[] }> = [];
      const aPromise = mockReviewScript(bookId, { onOps: (e) => aOps.push(e) });

      // 60+500+500+400 = 1460ms reaches the terminal op block; ch3 + ch1 ops
      // and their checkpoints emit synchronously, then the run suspends in the
      // 200ms progressive-emission wait. Advancing to 1500 lands the joiner
      // inside that window with ops already accumulated on the registry entry.
      await vi.advanceTimersByTimeAsync(1500);

      const bOps: Array<{ chapterId: number; ops: unknown[] }> = [];
      const bCheckpoints: Array<{ chapterId: number; version: number }> = [];
      const bPromise = mockAttachScriptReview(bookId, {
        onOps: (e) => bOps.push(e),
        onCheckpoint: (e) => bCheckpoints.push(e),
      });

      // Replay is synchronous on attach: the joiner already holds the pre-join
      // ops/checkpoints BEFORE any further timer advance.
      expect(bOps.flatMap((e) => e.ops).length).toBeGreaterThan(0);
      expect(bCheckpoints.length).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(300); // finish the timeline
      const aResult = await aPromise;
      const bResult = await bPromise;

      // One timeline: both callers see the same single result.
      expect(aResult).toEqual({ reviewedChapters: 1, totalOps: 5 });
      expect(bResult).toEqual(aResult);

      // Both callers end with the COMPLETE op set (assert the set/count, NOT
      // the order of onOps calls — replay iterates chapter keys ascending).
      expect(aOps.flatMap((e) => e.ops)).toHaveLength(5);
      expect(bOps.flatMap((e) => e.ops)).toHaveLength(5);

      // Ledger reflects exactly ONE canned run (a second racing timeline would
      // double ch3 to 6 ops): ch3 = 3 ops, ch1 = 2 ops.
      const state = await mockGetScriptReviewState(bookId);
      if (state.kind !== 'ledger') throw new Error('expected ledger');
      expect((state.entries['3'].ops as unknown[]).length).toBe(3);
      expect((state.entries['1'].ops as unknown[]).length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a cancel evicts the run by entry-identity, so a fresh run cannot resurrect the cancelled one via the shared sessionStorage flag', async () => {
    vi.useFakeTimers();
    try {
      const bookId = 'book-mock-cancel-identity';
      const run1 = mockReviewScript(bookId, {});
      await vi.advanceTimersByTimeAsync(100); // run1 past its sync prefix, suspended mid-timeline

      const cancelResult = await mockCancelScriptReview(bookId);
      expect(cancelResult.cancelled).toBe(true);

      // Fresh run: registry was emptied by cancel, so this starts a NEW entry
      // and re-writes sessionStorage.running non-null.
      const run2 = mockReviewScript(bookId, {});

      // run1's next throwIfCancelled sees run2's entry (not its own) and throws
      // — it must NOT keep running just because running is non-null again.
      await vi.advanceTimersByTimeAsync(600);
      let caught: unknown;
      try {
        await run1;
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ReviewScriptError);
      expect((caught as InstanceType<typeof ReviewScriptError>).code).toBe('cancelled');

      // run2 completes independently.
      await vi.advanceTimersByTimeAsync(2000);
      const r2 = await run2;
      expect(r2).toEqual({ reviewedChapters: 1, totalOps: 5 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('with an empty registry but a persisted running job (post-reload), attach starts a resume run and completes without regressing the pill', async () => {
    const bookId = 'book-mock-reload-resume';
    sessionStorage.setItem(
      mockScriptReviewKey(bookId),
      JSON.stringify({ running: { lastPhase: { progress: 0.85, label: 'Reviewing script' } }, entries: {} }),
    );
    const phases: Array<{ progress: number }> = [];
    const result = await mockAttachScriptReview(bookId, { onPhase: (p) => phases.push(p) });
    expect(result).toEqual({ reviewedChapters: 1, totalOps: 5 });
    // Seeded at 0.85: every phase tick at or below the seed is skipped, so the
    // pill never regresses (no tick fires at all here).
    expect(phases).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- src/lib/api.test.ts -t "dedup against a concurrent"`
Expected: FAIL — compile/import error `"_resetMockScriptReviewInFlight" is not exported by "src/lib/api.ts"` (the export doesn't exist yet).

- [ ] **Step 3: Implement the registry, wrapper, timeline body, cancel eviction, and reset export**

In `src/lib/api.ts`, immediately **above** `export async function mockReviewScript(` (~line 3281), insert:

```ts
/* fs-58 follow-up (#1496) — mock-mode dedup registry. Mock mode has no server
   job registry, so without this a hydration effect re-firing mid-review (nav
   away + back) would start a SECOND racing timeline for the same book. Each
   live run is one entry; a concurrent caller JOINS it (replaying accumulated
   ops/checkpoints, then subscribing to live events) instead of starting a
   second run. The entry object reference IS the per-run identity used for
   cancellation. Lives only within one JS context — sessionStorage remains the
   durable cross-reload snapshot. */
interface InFlightMockReview {
  subscribers: Set<ReviewScriptOpts>;
  opsAccum: Record<number, import('./script-review-apply').ReviewOp[]>;
  versionAccum: Record<number, number>;
  promise: Promise<ReviewScriptResult>;
}
const inFlightMockReviews = new Map<string, InFlightMockReview>();

/** Test-only: clear the in-flight mock-review registry. MUST be called in
    lockstep with sessionStorage.clear() in a test beforeEach (see the dedup
    design spec) — clearing one but not the other manufactures an inconsistent
    registry-empty + sessionStorage-running state the design assumes is
    impossible in-context. */
export function _resetMockScriptReviewInFlight(): void {
  inFlightMockReviews.clear();
}
```

**Replace the entire current `mockReviewScript` function** (from `export async function mockReviewScript(` through its closing `}` and the trailing `return { reviewedChapters: 1, totalOps: 5 };` `}` — currently ~lines 3281–3441) with the wrapper + timeline body below. Preserve the surrounding comments' spirit; the block below folds them in:

```ts
export async function mockReviewScript(bookId: string, opts: ReviewScriptOpts = {}): Promise<ReviewScriptResult> {
  const existing = inFlightMockReviews.get(bookId);
  if (existing) {
    /* JOIN — replay what this caller missed, faithfully mirroring the real
       server's attachSubscriber replay. attachToRunningReview (script-review
       -thunk.ts) deliberately does NOT seed allOps/versionByChapter from the
       state snapshot; it relies on the join replaying every already-emitted
       ops/checkpoint through these callbacks. Replay from the accumulated
       state (not an ordered log) is faithful: the joiner only pushes ops into
       its own allOps and takes the last version per chapter. NO await between
       replay and subscribe, so no live emit can interleave and be missed. */
    for (const [chIdStr, ops] of Object.entries(existing.opsAccum)) {
      opts.onOps?.({ chapterId: Number(chIdStr), ops });
    }
    for (const [chIdStr, version] of Object.entries(existing.versionAccum)) {
      opts.onCheckpoint?.({ chapterId: Number(chIdStr), version });
    }
    existing.subscribers.add(opts);
    try {
      return await existing.promise;
    } finally {
      existing.subscribers.delete(opts);
    }
  }

  /* START — register BEFORE running (no await before set()), so the body can
     reference `entry` for identity/accumulators and the first throwIfCancelled
     (which only runs after the first await) always sees this entry. The
     placeholder promise is assigned on the very next line; the body never
     reads entry.promise. */
  const entry: InFlightMockReview = {
    subscribers: new Set([opts]),
    opsAccum: {},
    versionAccum: {},
    promise: undefined as unknown as Promise<ReviewScriptResult>,
  };
  inFlightMockReviews.set(bookId, entry);
  entry.promise = runMockReviewTimeline(bookId, entry);
  try {
    return await entry.promise;
  } finally {
    // Evict only if still the current entry — a cancel (which evicts) followed
    // by a fresh run may have replaced us; never evict a successor.
    if (inFlightMockReviews.get(bookId) === entry) inFlightMockReviews.delete(bookId);
  }
}

async function runMockReviewTimeline(bookId: string, entry: InFlightMockReview): Promise<ReviewScriptResult> {
  /* fs-58 follow-up (#1481) — a resumed reattach (mockAttachScriptReview after
     a reload) delegates back here with progress already recorded; without the
     alreadyAt guards below, resuming from 85% would restart the pill at 25%. A
     fresh run has running:null, so alreadyAt is 0 and every guard is a no-op. */
  const alreadyAt = readMockScriptReviewState(bookId).running?.lastPhase.progress ?? 0;

  const emitPhase = (p: SubstagePhaseEvent) => {
    for (const s of entry.subscribers) s.onPhase?.(p);
  };
  const notePhase = (phase: SubstagePhaseEvent) => {
    writeMockScriptReviewState(bookId, {
      running: { lastPhase: phase },
      entries: readMockScriptReviewState(bookId).entries,
    });
    emitPhase(phase);
  };
  const noteOps = (chId: number, ops: import('./script-review-apply').ReviewOp[]) => {
    (entry.opsAccum[chId] ??= []).push(...ops);
    for (const s of entry.subscribers) s.onOps?.({ chapterId: chId, ops });
  };
  const noteCheckpoint = (chId: number, version: number) => {
    entry.versionAccum[chId] = version;
    for (const s of entry.subscribers) s.onCheckpoint?.({ chapterId: chId, version });
  };
  /* Cancellation is now keyed on entry-object IDENTITY, not the shared
     sessionStorage running flag (#1496): mockCancelScriptReview evicts this
     book's entry, and a fresh run registers a different entry — either way
     `get(bookId) !== entry` here, so a still-alive cancelled run can't be
     resurrected by a fresh run re-writing running non-null. */
  const throwIfCancelled = () => {
    if (inFlightMockReviews.get(bookId) !== entry) {
      throw new ReviewScriptError('Review cancelled.', 'cancelled');
    }
  };

  /* Mark active synchronously before the first await — PERSISTENCE ONLY now
     (cancellation is entry-identity based). Keeps mockGetScriptReviewState and
     a reload within the first tick observing a running job. Runs before any
     await, so no concurrently-dispatched cancel can interleave before it. */
  writeMockScriptReviewState(bookId, {
    running: { lastPhase: { progress: alreadyAt, label: 'Reviewing script' } },
    entries: readMockScriptReviewState(bookId).entries,
  });

  await wait(60);
  throwIfCancelled();
  if (alreadyAt < 0.25) {
    onPhaseLoadingTick(emitPhase);
    notePhase({
      progress: 0.25,
      label: 'Reviewing script',
      chapterId: 1,
      chapterIndex: 1,
      totalChapters: 3,
      activityState: 'waiting',
      model: 'qwen3.5:9b',
      engine: 'local',
    });
  }
  await wait(500);
  throwIfCancelled();
  if (alreadyAt < 0.5) {
    notePhase({ progress: 0.5, label: 'Reviewing script', chapterId: 3, chapterIndex: 2, totalChapters: 3, estRemainingMs: 20_000 });
  }
  await wait(500);
  throwIfCancelled();
  if (alreadyAt < 0.85) {
    notePhase({ progress: 0.85, label: 'Reviewing script', chapterId: 3, chapterIndex: 3, totalChapters: 3, estRemainingMs: 5_000 });
  }
  await wait(400);
  throwIfCancelled();
  // One streaming heartbeat so the streaming timer has data before ops land.
  for (const s of entry.subscribers) s.onHeartbeat?.({ chapterId: 3, streaming: true });
  /* fs-58 Unit A: strip_tag on ch3 sentence 1. */
  noteOps(3, [{ id: 1, op: 'strip_tag', newText: 'x', rationale: 'tag' }]);
  noteCheckpoint(3, 1);
  /* validate_instruct: strip_tag + validate_instruct on ch1 sentence 1. */
  noteOps(1, [
    { id: 1, op: 'strip_tag', newText: 'x', rationale: 'tag' },
    { id: 1, op: 'validate_instruct', newInstruct: 'a calm tone', rationale: 'contradicts the line' },
  ]);
  noteCheckpoint(1, 1);
  /* Progressive emission (#1496): yield here so a concurrent attach lands with
     ch3 + ch1 already accumulated and exercises the join REPLAY path, instead
     of every op arriving in one synchronous burst (which would make replay
     dead code and its test self-certifying). Also better models a real review
     that checkpoints chapters progressively. */
  await wait(200);
  throwIfCancelled();
  /* fs-58 Unit B: off-roster reattribute on ch3 sentence 3, flag_nonstory on
     ch3 sentence 15. Both default OFF in the diff modal. */
  noteOps(3, [
    { id: 3, op: 'reattribute', proposed: { name: 'Ferra', gender: 'female' }, rationale: 'speaker not in cast' },
    { id: 15, op: 'flag_nonstory', rationale: 'page number artefact' },
  ]);
  noteCheckpoint(3, 2);

  /* Finalize: fold this run's ops/versions into the ledger and clear running. */
  const entries: Record<string, LedgerEntryDTO> = { ...readMockScriptReviewState(bookId).entries };
  for (const [chIdStr, ops] of Object.entries(entry.opsAccum)) {
    entries[chIdStr] = {
      manuscriptId: bookId,
      version: entry.versionAccum[Number(chIdStr)] ?? 1,
      // ReviewOp[] -> LedgerEntryDTO['ops'] (openapi's deliberately-loose
      // {[key: string]: unknown}[]) — same unknown bounce as elsewhere here.
      ops: ops as unknown as LedgerEntryDTO['ops'],
      selected: {},
      completedAt: new Date().toISOString(),
    };
  }
  writeMockScriptReviewState(bookId, { running: null, entries });

  return { reviewedChapters: 1, totalOps: 5 };
}

/* fs-58 heartbeat follow-up — a transient "loading the model" tick so the
   popover renders before the first real chapter tick. NOT persisted via
   notePhase (that would clobber the running.lastPhase.progress a reattach
   reads back), so a reload never sees this as the last-known phase. */
function onPhaseLoadingTick(emitPhase: (p: SubstagePhaseEvent) => void): void {
  emitPhase({ progress: 0, label: 'Loading model', activityState: 'loading', engine: 'local', model: 'qwen3.5:9b' });
}
```

Then, in `mockCancelScriptReview` (~line 3678), add the eviction line before the `writeMockScriptReviewState` call:

```ts
export async function mockCancelScriptReview(bookId: string): Promise<CancelScriptReviewResult> {
  const state = readMockScriptReviewState(bookId);
  const cancelled = state.running !== null;
  // Kill the live run via entry-identity mismatch (#1496): a still-alive run's
  // next throwIfCancelled will see its entry gone (or replaced) and throw.
  inFlightMockReviews.delete(bookId);
  writeMockScriptReviewState(bookId, { running: null, entries: state.entries });
  return { ok: true, cancelled };
}
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `npm test -- src/lib/api.test.ts -t "dedup against a concurrent"`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the FULL api.test.ts to prove no regression (existing cancellation/attach/resume tests)**

Run: `npm test -- src/lib/api.test.ts`
Expected: PASS (all, including the `mock-mode script-review cancellation` block and the ledger/resolve/selection blocks).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors). If `onPhaseLoadingTick` or any helper flags an unused/`SubstagePhaseEvent` import issue, resolve it (the type is already imported/used by the pre-existing `notePhase` signature).

- [ ] **Step 7: Commit**

```bash
git add src/lib/api.ts src/lib/api.test.ts
git commit -m "fix(frontend): dedup mock script-review against concurrent in-flight timeline (#1496)"
```

---

## Task 2: Update the manuscript hydration-effect comment

**Files:**
- Modify: `src/views/manuscript.tsx` (~lines 182–184)

**Interfaces:** none (comment-only).

- [ ] **Step 1: Extend the "safe to abandon" comment**

Replace the existing trailing comment inside the hydration `useEffect` (currently):

```tsx
    // Intentionally no cleanup/abort: hydration is a one-shot reconciliation
    // per mount, and the sticky job registry (server Task 2) makes a
    // duplicate in-flight POST from attachToRunningReview safe to abandon.
```

with:

```tsx
    // Intentionally no cleanup/abort: hydration is a one-shot reconciliation
    // per mount, and a duplicate in-flight POST from attachToRunningReview is
    // safe to abandon in BOTH modes — real backend via the sticky server job
    // registry (server Task 2), and mock mode via the in-memory
    // inFlightMockReviews dedup registry in src/lib/api.ts (#1496), which joins
    // the existing timeline instead of starting a second racing one.
```

- [ ] **Step 2: Typecheck (comment-only, but confirm no accidental edit)**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/views/manuscript.tsx
git commit -m "docs(frontend): note mock dedup registry in hydration-effect comment (#1496)"
```

---

## Task 3: Release notes

**Files:**
- Modify: `docs/release-notes-next.md` (technical register)
- Modify: `RELEASE_NOTES.md` (user-facing, in-progress version section at top)

**Interfaces:** none.

- [ ] **Step 1: Append the technical entry**

Add to `docs/release-notes-next.md` under its current in-progress section (match the file's existing bullet format, PR-refed — leave the PR number as `#TBD` only if the PR isn't open yet, else fill it):

```markdown
- fix(frontend): mock-mode script-review now dedups a concurrent in-flight
  timeline — a hydration effect re-firing for the same book (nav away + back
  mid-review) joins the single canned timeline with buffered-op replay instead
  of starting a second racing one, and cancellation now keys on per-run identity
  rather than the shared sessionStorage flag. Mock/dev/e2e only; real backend
  was already protected by its job registry. (#1496)
```

- [ ] **Step 2: Append the user-facing entry**

Add to the top (in-progress version) section of `RELEASE_NOTES.md`, matching the brand-voice one-liner style already there. Since this is a mock/dev-only fix with no user-visible production behavior, add it under a developer/internal note if the section distinguishes those; otherwise a terse line:

```markdown
- Fixed a rare developer-mode glitch where flipping between a book and its
  script review too quickly could make the review progress jump around. (#1496)
```

(If `RELEASE_NOTES.md`'s top section is strictly end-user-facing and has no place for a dev-only fix, note that in the commit message and skip this file — but land the `release-notes-next.md` entry regardless.)

- [ ] **Step 3: Commit**

```bash
git add docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs: release notes for mock script-review dedup (#1496)"
```

---

## Self-Review

**1. Spec coverage:**
- Registry + subscriber set + accumulators + shared promise → Task 1 Step 3 (`InFlightMockReview`, `inFlightMockReviews`). ✓
- Join path replays accumulated ops/checkpoints → Task 1 Step 3 wrapper JOIN branch. ✓
- Entry-reference identity + register-before-run + placeholder promise → Task 1 Step 3 START branch + `throwIfCancelled`. ✓
- Fan-out to live subscribers (phase/ops/checkpoint/heartbeat) → `emitPhase`/`noteOps`/`noteCheckpoint`/heartbeat loop. ✓
- Sync mark-active write kept, re-commented as persistence-only → Task 1 Step 3. ✓
- `mockCancelScriptReview` evicts entry → Task 1 Step 3. ✓
- `mockAttachScriptReview` unchanged → not modified (correct). ✓
- Test-only reset export + lockstep beforeEach → Task 1 Steps 1 & 3. ✓
- Three tests (dedup+replay / cancel-identity / reload-resume), assert set not order → Task 1 Step 1. ✓
- manuscript.tsx comment → Task 2. ✓
- E2E intentionally skipped → no task (documented in spec). ✓
- Release notes → Task 3. ✓

**2. Placeholder scan:** No TBD/TODO in code steps; every code step shows complete code. `#TBD` appears only as an explicit conditional in the release-notes step (PR number), which is legitimate. ✓

**3. Type consistency:** `InFlightMockReview` fields (`subscribers`/`opsAccum`/`versionAccum`/`promise`) used identically in wrapper and body. `_resetMockScriptReviewInFlight` spelled consistently in import, export, and both `beforeEach`. `runMockReviewTimeline(bookId, entry)` signature matches its one call site. `emitPhase` typed `(p: SubstagePhaseEvent) => void` matches `onPhaseLoadingTick`'s param. `ReviewOp` referenced via `import('./script-review-apply').ReviewOp` in both the interface and `noteOps`. ✓

## Execution Handoff

Plan complete. This will be executed via subagent-driven-development per the controlling thread's mandate (fresh implementer per task + two-stage review), then the ship task (verify, PR, code-review gate).
