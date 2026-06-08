# Generation Stall Protection — Wave 3 (better recovery) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a sidecar recycles mid-render, recover WITHOUT discarding completed groups (C1), show a visible "recovering" state instead of a silent stall (C2), and turn an unrecoverable recycle storm into a clearly-named alert instead of a generic failure / hours of grind (C3).

**Architecture:** Three server-led changes plus a small frontend phase add.
**C1** moves the transient-recovery boundary from *around the whole chapter*
(`routes/generation.ts`'s `for (recovery…)` loop re-invoking `synthesiseChapter`
from the top) to *inside* `synthesiseChapter`'s per-group worker loop, via an
injected `onRecoverRecycle` hook. Because the function never restarts, every
already-completed `results[group.index]` slot is preserved; only the failed
group/batch re-attempts after the readiness wait. **C2** emits a
`chapter_recovering` SSE tick + `phase: 'recovering'` from that hook with a
heartbeat, mirroring srv-31's `chapter_verifying` phase (plan 197). **C3** makes
`synthesiseChapter` throw a dedicated `RecycleStormError` when the in-loop
recovery budget is exhausted; `generation.ts` maps it to a named, jargon-free
failure (`code: 'recycle-storm'`) whose stable reason the existing cross-chapter
cascade escalates to a run-stop — same pattern as `ChapterStallError`.

**Tech Stack:** TypeScript (Express server + Redux frontend + Vitest). No sidecar
Python change. Reuses the existing `ensureSidecarEngineReady` readiness gate
(`tts/ensure-sidecar-loaded.ts`), `isTransient` (`tts/retry.ts`), the failure
taxonomy (`routes/failure-taxonomy.ts`), and the chapter-phase machinery
(`src/store/chapters-slice.ts` + `src/views/generation.tsx`).

**Spec:** `docs/superpowers/specs/2026-06-08-generation-stall-protection-design.md` · **Bug:** #672 · **PR:** #673 · **Wave 1:** `…-wave1.md` · **Wave 2:** `…-wave2.md`

---

## Priority / ordering note

Implement in order **C1 → C2 → C3** (the design spec lists "C2 → C1 → C3" on a
value/risk basis, but C2 and C3 both hang off the recovery seam C1 introduces —
emitting the recovering tick against today's `for (recovery…)` loop would be
throwaway work that C1 immediately deletes). The delivered behaviour is identical
to the spec; only the internal task order differs.

- **C1** is the core fix and the only structural change (relocates one existing test).
- **C2** is a thin add on C1's `onRecoverRecycle` callback + a frontend phase (mirror plan 197).
- **C3** is a small named-error + taxonomy add on the same callback's exhaustion path.

**Recovery budget semantics (decided):** the in-loop budget is SHARED across all
groups/workers of a chapter and equals the current `MAX_RECYCLE_RECOVERIES` (2),
so total recovery attempts per chapter are unchanged from today — what changes is
that each attempt re-renders ONE group, not the whole chapter. **C3 disposition
(decided):** a single chapter's recycle-storm is recorded as a **non-fatal**
named failure (`fatal: false`); the existing cross-chapter cascade
(`recordNonFatal`) escalates to a run-stop when storms repeat — identical to how
`ChapterStallError` is handled. This avoids a bespoke queue-pause path; if the
user later wants a single storm to immediately pause the queue, that is a
one-line follow-up (flip the branch to `fatal: true`).

---

## File Structure

- `server/src/tts/synthesise-chapter.ts` — `onRecoverRecycle` + `maxRecycleRecoveries` opts, the `withRecycleRecovery` helper wrapping every synth site, and the new `RecycleStormError` (C1 + C3).
- `server/src/tts/synthesise-chapter.test.ts` — **extend**: resume-preservation + budget-exhaustion + passthrough unit tests (C1/C3).
- `server/src/routes/generation.ts` — collapse the `for (recovery…)` loop into a single `synthesiseChapter` call wired with `onRecoverRecycle` (which performs the readiness wait + emits the C2 recovering tick/heartbeat); map `RecycleStormError` in the outer catch (C1 + C2 + C3).
- `server/src/routes/generation-recycle-recovery.test.ts` — **rewrite** to the new architecture: assert the wiring (hook drives `ensureSidecarEngineReady` + recovering ticks; `RecycleStormError` → named `chapter_failed`).
- `server/src/routes/failure-taxonomy.ts` — add the `'recycle-storm'` `FailureCode` + signature (C3).
- `server/src/routes/failure-taxonomy.test.ts` — extend with the recycle-storm classification (C3).
- `src/lib/types.ts` — add `'recovering'` to the chapter `phase` union + `chapter_recovering` to the generation-event union (C2).
- `src/store/chapters-slice.ts` — reduce `chapter_recovering` → `phase: 'recovering'` (mirror `chapter_verifying`) (C2).
- `src/store/chapters-slice.test.ts` — extend with the recovering-phase case (C2).
- `src/views/generation.tsx` — render the "Recovering…" caption for `phase === 'recovering'` (C2).
- `src/views/generation.test.tsx` — extend with the recovering caption case (C2).
- `e2e/` — one spec asserting the recovering phase surfaces (C2, UI-visible across the SSE→redux→view seam per CLAUDE.md).

---

## Task 1: C1 — in-loop recycle recovery (resume from completed groups)

**Context:** `synthesiseChapter` (`tts/synthesise-chapter.ts`) synthesises the
title beat, an anchor group, then a worker pool over `workItems` (single +
Qwen-batch), writing each result into `results[group.index]`; a final
index-order pass concatenates. Today a transient sidecar-down (recycle/respawn
drop, or a non-poisoned drain-503 — both surface as `transient` once
`withTtsRetry`'s short budget exhausts) OR a `ChapterSynthTimeoutError` (a synth
that hung because the respawned sidecar was still loading the model in-band)
unwinds the whole `Promise.all` and bubbles out; `generation.ts`'s
`for (recovery = 0; ; recovery++)` loop (≈ lines 1144–1311) then catches it,
waits on `ensureSidecarEngineReady`, and **re-invokes `synthesiseChapter` from
the top — discarding every completed group**. C1 moves recovery inside: a synth
site that throws a recoverable error calls an injected `onRecoverRecycle` hook
(wired to the readiness gate) and re-attempts the SAME work item; completed
`results[]` slots are preserved because the function never restarts.

**Recoverable-error classification (ported verbatim from `generation.ts`
≈1290–1297):** recover iff `isTransient(err) || err.name ===
'ChapterSynthTimeoutError'`, AND NOT (`err.name === 'AbortError'` ||
`signal?.aborted`), AND the shared budget is not yet exhausted. Anything else
(poison, non-transient classifier errors, abort) re-throws unchanged.

**Files:**
- Modify: `server/src/tts/synthesise-chapter.ts`
- Modify: `server/src/routes/generation.ts`
- Test: `server/src/tts/synthesise-chapter.test.ts`
- Rewrite: `server/src/routes/generation-recycle-recovery.test.ts`

- [ ] **Step 1: Read the seams.** In `synthesise-chapter.ts`: the `SynthesiseChapterOpts` interface, the opts destructure (≈614–646), the title-beat synth (≈748–757), the anchor synth (≈1043–1048), the worker pool (≈1137–1169), and the segment-QA + ASR re-record `synthGroup` calls (≈1204, ≈1274). Note `withTtsRetry` is already imported from `./retry.js`; you will ALSO import `isTransient` from there. In `generation.ts`: the `for (recovery…)` loop (≈1144–1311), `ensureSidecarEngineReady` usage, `MAX_RECYCLE_RECOVERIES` (≈103), and `isTransient` import (≈82). In `generation-recycle-recovery.test.ts`: the whole file (it mocks `synthesiseChapter` wholesale + a swappable `ensureReadyImpl` — that harness is reused for the rewrite).

- [ ] **Step 2: Write the failing unit tests** in `server/src/tts/synthesise-chapter.test.ts`. Use the file's existing fake-provider pattern (a `provider` object with a `synthesize` returning `{ pcm, sampleRate }`; copy a neighbouring test's cast/sentence fixtures). Add a per-group call counter so resume can be asserted.

```ts
import { isTransient } from './retry.js'; // (only if a test constructs a transient; otherwise omit)

function transientErr(): Error {
  return Object.assign(new Error('sidecar not reachable (fetch failed)'), {
    transient: true as const,
    cause: 'network' as const,
  });
}

it('C1: recovers a transient mid-pool failure WITHOUT re-rendering completed groups', async () => {
  // 3 single-sentence groups, poolWidth 1 (serial). Provider throws transient
  // on the FIRST call for group index 1, succeeds on retry; groups 0 + 2 each
  // synth exactly once.
  const calls = new Map<string, number>(); // key by text
  let thrownForG1 = false;
  const provider = {
    synthesize: vi.fn(async ({ text }: { text: string }) => {
      calls.set(text, (calls.get(text) ?? 0) + 1);
      if (text.includes('SENT1') && !thrownForG1) { thrownForG1 = true; throw transientErr(); }
      return { pcm: Buffer.alloc(2), sampleRate: 24000 };
    }),
  };
  const onRecoverRecycle = vi.fn(async () => {});
  const result = await synthesiseChapter({
    sentences: [mkSent(0, 'SENT0'), mkSent(1, 'SENT1'), mkSent(2, 'SENT2')],
    cast, provider: provider as any, modelKey, engine: 'kokoro',
    sentenceConcurrency: 1, groupHeartbeatMs: 0,
    onRecoverRecycle, maxRecycleRecoveries: 2,
  });
  expect(onRecoverRecycle).toHaveBeenCalledTimes(1);       // one recovery
  expect(calls.get(normalisedOf('SENT0'))).toBe(1);         // completed group NOT re-rendered
  expect(calls.get(normalisedOf('SENT2'))).toBe(1);         // completed group NOT re-rendered
  expect(result.segments.length).toBe(3);                   // chapter completed
});

it('C1: throws RecycleStormError after the shared budget is exhausted', async () => {
  const provider = { synthesize: vi.fn(async () => { throw transientErr(); }) };
  await expect(synthesiseChapter({
    sentences: [mkSent(0, 'A')], cast, provider: provider as any, modelKey, engine: 'kokoro',
    sentenceConcurrency: 1, groupHeartbeatMs: 0,
    onRecoverRecycle: async () => {}, maxRecycleRecoveries: 2,
  })).rejects.toMatchObject({ name: 'RecycleStormError' });
  // 1 primary + 2 recoveries = 3 attempts.
  expect(provider.synthesize).toHaveBeenCalledTimes(3);
});

it('C1: a non-transient error does NOT recover (re-throws immediately)', async () => {
  const provider = { synthesize: vi.fn(async () => { throw new Error('index out of range in self'); }) };
  await expect(synthesiseChapter({
    sentences: [mkSent(0, 'A')], cast, provider: provider as any, modelKey, engine: 'kokoro',
    sentenceConcurrency: 1, groupHeartbeatMs: 0,
    onRecoverRecycle: async () => {}, maxRecycleRecoveries: 2,
  })).rejects.toThrow('index out of range');
  expect(provider.synthesize).toHaveBeenCalledTimes(1);
});

it('C1: passthrough — with no onRecoverRecycle a transient bubbles out unchanged (pre-C1)', async () => {
  const provider = { synthesize: vi.fn(async () => { throw transientErr(); }) };
  await expect(synthesiseChapter({
    sentences: [mkSent(0, 'A')], cast, provider: provider as any, modelKey, engine: 'kokoro',
    sentenceConcurrency: 1, groupHeartbeatMs: 0,
    // NO onRecoverRecycle
  })).rejects.toMatchObject({ transient: true });
  expect(provider.synthesize).toHaveBeenCalledTimes(1);
});
```
> `mkSent`/`normalisedOf`/`cast`/`modelKey` mirror the existing helpers in `synthesise-chapter.test.ts` — copy them from a neighbouring test rather than inventing. `normalisedOf` accounts for `normaliseForTts` (the key the provider sees). If the existing tests key the fake provider differently (e.g. by `voiceName`), follow that idiom.

- [ ] **Step 3: Run, confirm the C1 tests FAIL** (the opts don't exist / recovery isn't wired):
`cd server && npx vitest run src/tts/synthesise-chapter.test.ts -t "C1"`

- [ ] **Step 4: Implement in `synthesise-chapter.ts`.**
  1. Import `isTransient`: change `import { withTtsRetry } from './retry.js';` → `import { withTtsRetry, isTransient } from './retry.js';`.
  2. Add the error class near `ChapterStallError` (≈118):
```ts
/** Thrown by synthesiseChapter when the in-loop recycle-recovery budget
    (`maxRecycleRecoveries`) is exhausted on a single chapter — i.e. the sidecar
    recycled/respawned more times than allowed while this one chapter rendered.
    A NAMED signal (C3) so generation.ts can surface "the sidecar is thrashing —
    likely the host-memory leak (side-11) or insufficient headroom" instead of a
    generic mid-synth failure. Carries the recovery count + the last underlying
    error for the log. */
export class RecycleStormError extends Error {
  readonly recoveries: number;
  readonly lastError: unknown;
  constructor(recoveries: number, lastError: unknown) {
    super(
      `The TTS sidecar recycled ${recoveries}× while rendering this single chapter ` +
        `— it is likely thrashing (host-memory leak or insufficient VRAM/RAM headroom). ` +
        `Stopping so the run doesn't grind. Restart the sidecar / lower concurrency, then Retry.`,
    );
    this.name = 'RecycleStormError';
    this.recoveries = recoveries;
    this.lastError = lastError;
  }
}
```
  3. Add to `SynthesiseChapterOpts` (near the other recovery-relevant opts):
```ts
  /** C1 (Wave 3) — recover from a transient sidecar-down WITHOUT discarding
      completed groups. When a synth site throws a recoverable error
      (`isTransient` OR a `ChapterSynthTimeoutError`), the site calls this hook
      to wait out the respawn, then re-attempts the SAME work item; every
      already-completed `results[]` slot is preserved. Wired by generation.ts to
      `ensureSidecarEngineReady(engine, signal)` (+ the C2 recovering tick).
      `engine` is the failed item's resolved engine (a chapter can be mixed-
      engine); `attempt` is the 1-indexed shared recovery count. ABSENT → no
      in-loop recovery: a transient bubbles out unchanged (pre-C1 behaviour, the
      passthrough every existing caller/test relies on). */
  onRecoverRecycle?: (e: { engine: TtsEngine; attempt: number }) => Promise<void>;
  /** Max in-loop recycle recoveries SHARED across all groups/workers of this
      chapter. Mirrors generation.ts `MAX_RECYCLE_RECOVERIES` (2). Exceeding it
      throws `RecycleStormError` so the chapter fails fast (no infinite grind).
      Only consulted when `onRecoverRecycle` is provided. Default 2. */
  maxRecycleRecoveries?: number;
```
  4. Destructure them (with `onRecoverRecycle` undefined-by-default and `maxRecycleRecoveries = 2`).
  5. Add a shared counter + the helper, INSIDE `synthesiseChapter` (so it closes over `signal`, `onRecoverRecycle`, `maxRecycleRecoveries`), placed before the title beat:
```ts
  let recycleRecoveries = 0;
  /* C1 in-loop recovery. Re-attempt `fn` after waiting out a sidecar respawn,
     WITHOUT discarding completed groups (the function never restarts, so every
     filled `results[]` slot survives). The shared `recycleRecoveries` counter
     bounds total recoveries per chapter; exhaustion throws RecycleStormError
     (C3). Recoverable = isTransient OR ChapterSynthTimeoutError; an abort or a
     non-recoverable error re-throws. No-op passthrough when `onRecoverRecycle`
     is absent (pre-C1). Wraps EVERY synth site (title, anchor, pool item,
     QA/ASR re-record) so recovery coverage matches the old whole-chapter loop. */
  async function withRecycleRecovery<T>(
    engineForItem: TtsEngine,
    fn: () => Promise<T>,
  ): Promise<T> {
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (!onRecoverRecycle) throw err;
        const name = (err as { name?: string })?.name;
        if (name === 'AbortError' || signal?.aborted) throw err;
        const isRecycleTimeout = name === 'ChapterSynthTimeoutError';
        if (!isTransient(err) && !isRecycleTimeout) throw err;
        if (recycleRecoveries >= maxRecycleRecoveries) {
          throw new RecycleStormError(recycleRecoveries, err);
        }
        recycleRecoveries += 1;
        /* May throw AbortError (run paused mid-wait) → propagates out as a clean
           stop, exactly like the old generation.ts recovery loop. */
        await onRecoverRecycle({ engine: engineForItem, attempt: recycleRecoveries });
      }
    }
  }
```
  6. Wrap each synth site with `withRecycleRecovery(<engine>, () => <existing call>)`:
     - **Title beat** (≈748): `const titleResult = await withRecycleRecovery(titleRoute.engine, () => withTtsRetry(() => titleRoute.provider.synthesize({…}), { signal }));`
     - **Anchor group** (≈1044): `const result = await withRecycleRecovery(resolveGroup(anchorGroup).route.engine, () => synthGroup(anchorGroup));`
     - **Pool single item** (≈1153): `results[item.group.index] = await withRecycleRecovery(resolveGroup(item.group).route.engine, () => synthGroup(item.group));`
     - **Pool batch item** (≈1156): `const out = await withRecycleRecovery(resolveGroup(item.groups[0]).route.engine, () => synthBatch(item.groups));`
     - **Segment-QA re-record** (≈1204): `const fresh = await withRecycleRecovery(resolveGroup(group).route.engine, () => synthGroup(group));`
     - **ASR re-record** (≈1274): same wrap as segment-QA.
     > `resolveGroup(...)` is memoised by group index, so calling it for the engine is cheap and side-effect-free. `withRecycleRecovery` is a no-op passthrough when `onRecoverRecycle` is absent, so these wraps are byte-identical for every existing caller/test that doesn't pass the hook.

- [ ] **Step 5: Run, confirm the C1 unit tests PASS + the WHOLE synthesise-chapter suite stays green** (the passthrough wrap must not perturb the 30+ determinism/batching/QA tests):
`cd server && npx vitest run src/tts/synthesise-chapter.test.ts`

- [ ] **Step 6: Implement in `generation.ts` — collapse the loop.** Replace the `for (recovery = 0; ; recovery += 1) { try { result = await synthesiseChapter({…}); break; } catch (synthErr) { … ensureSidecarEngineReady … } }` block (≈1143–1311) with a SINGLE call that injects the hook:
```ts
      let result: Awaited<ReturnType<typeof synthesiseChapter>>;
      result = await synthesiseChapter({
        sentences,
        cast: cast.characters,
        provider,
        modelKey,
        engine,
        resolveForEngine,
        qwenUnavailable,
        forbidKokoroFallback: nonEnglishBook,
        bookLanguage,
        signal: chapterSignal,
        chapterTitleNarration,
        narratorCharacterId: 'narrator',
        onTitleStart: () => { /* …unchanged… */ },
        onGroupStart: ({ group, totalGroups, completed }) => { /* …unchanged… */ },
        onGroupComplete: ({ group, totalGroups, completed }) => { /* …unchanged… */ },
        onBatchComplete: ({ genMs, audioMs }) => { /* …unchanged… */ },
        maxSegmentRerecords: resolveSegmentQaRerecords(),
        onSegmentRerecord: () => { /* …unchanged… */ },
        ...(asrEnabled() ? { asr: { /* …unchanged… */ } } : {}),
        /* C1 — recover in-loop (preserves completed groups) instead of the old
           outer for-loop that re-rendered the whole chapter. The hook waits out
           the respawn on the readiness gate and emits the C2 recovering state
           (added in Task 2). MAX_RECYCLE_RECOVERIES is the shared per-chapter
           budget; on exhaustion synthesiseChapter throws RecycleStormError,
           mapped by the outer catch (Task 3). */
        maxRecycleRecoveries: MAX_RECYCLE_RECOVERIES,
        onRecoverRecycle: async ({ engine: recEngine, attempt }) => {
          console.warn(
            `[generation] chapter ${chapter.id} (${chapter.slug}): sidecar unavailable ` +
              `mid-synth (recycle/respawn) — riding out the respawn, re-attempt ` +
              `${attempt}/${MAX_RECYCLE_RECOVERIES} (preserving completed groups).`,
          );
          /* Task 2 (C2) inserts the recovering tick + heartbeat here, around the
             wait. For Task 1, just wait on the readiness gate (current behaviour,
             relocated into the hook). Honours the run abort. */
          await ensureSidecarEngineReady(recEngine, chapterSignal);
        },
      });
```
  Keep `synthStartMs` (≈1122) where it is. Delete the now-unused `for`/`recovery` scaffolding and the inner classification block (its logic moved into `withRecycleRecovery`). Leave the outer `try/catch` (≈1513) untouched for now — Task 3 adds the `RecycleStormError` branch.

- [ ] **Step 7: Rewrite `generation-recycle-recovery.test.ts`** to the new architecture. The file mocks `synthesiseChapter`, so it can no longer drive the inner recovery — instead it asserts the WIRING. Keep the harness (express app, queue seed, swappable `synthesiseImpl` + `ensureReadyImpl` + `ensureReadyCalls`). Replace the four `it(...)` bodies:
```ts
it('drives ensureSidecarEngineReady from onRecoverRecycle, then completes (no chapter_failed)', async () => {
  let calls = 0;
  synthesiseImpl = async (args: any) => {
    calls += 1;
    if (calls === 1) {
      // First call: exercise the injected hook once (simulating an in-loop
      // recovery), then succeed — proving generation wires the hook to the gate.
      await args.onRecoverRecycle({ engine: 'kokoro', attempt: 1 });
      return okResult();
    }
    return okResult();
  };
  const body = await runChapter();
  expect(calls).toBe(1);                       // synthesiseChapter called ONCE (recovery is internal now)
  expect(ensureReadyCalls).toBeGreaterThanOrEqual(2); // preload gate + the hook's wait
  expect(body).toContain('"type":"chapter_complete"');
  expect(body).not.toContain('"type":"chapter_failed"');
});

it('surfaces chapter_failed when synthesiseChapter throws RecycleStormError', async () => {
  const { RecycleStormError } = await import('../tts/synthesise-chapter.js');
  synthesiseImpl = async () => { throw new RecycleStormError(2, new Error('sidecar down')); };
  const body = await runChapter();
  expect(body).toContain('"type":"chapter_failed"');
  expect(body).not.toContain('"type":"chapter_complete"');
  // Task 3 asserts the recycle-storm code/remediation here too.
});

it('does NOT recover a non-transient error — surfaces immediately', async () => {
  synthesiseImpl = async () => { throw new Error('index out of range in self'); };
  const body = await runChapter();
  expect(body).toContain('"type":"chapter_failed"');
});

it('stops cleanly when the hook wait aborts (pause/displacement mid-recovery)', async () => {
  synthesiseImpl = async (args: any) => {
    await args.onRecoverRecycle({ engine: 'kokoro', attempt: 1 }); // throws AbortError (ensureReadyImpl below)
    return okResult();
  };
  ensureReadyImpl = async () => {
    if (ensureReadyCalls >= 2) throw new DOMException('preload aborted', 'AbortError');
  };
  const body = await runChapter();
  expect(body).not.toContain('"type":"chapter_failed"'); // abort = clean stop
  expect(body).not.toContain('"type":"chapter_complete"');
});
```
  > Update the file's top-of-file comment block to describe the new contract (recovery is internal to `synthesiseChapter`; this suite pins the generation-side wiring). Keep `transientSidecarDown()`/`okResult()` helpers — `okResult()` is still used.

- [ ] **Step 8: Run the rewritten generation suite + a broad server pass:**
`cd server && npx vitest run src/routes/generation-recycle-recovery.test.ts src/routes/generation.test.ts src/routes/generation-stall-watchdog.test.ts`

- [ ] **Step 9: Commit**
```bash
git add server/src/tts/synthesise-chapter.ts server/src/tts/synthesise-chapter.test.ts server/src/routes/generation.ts server/src/routes/generation-recycle-recovery.test.ts
git commit -m "feat(server): recover sidecar recycles in-loop without re-rendering completed groups (Refs #672)"
```

---

## Task 2: C2 — visible "recovering" phase

**Context:** During the readiness wait inside `onRecoverRecycle` (up to
`READINESS_TIMEOUT_MS` = 210 s), the SSE stream is silent — the client's 30 s
"Worker has gone quiet" stall detector (`STALL_THRESHOLD_MS`,
`src/store/chapters-slice.ts`) fires for what is actually a healthy respawn
ride-out. C2 emits a `chapter_recovering` tick + a heartbeat from the hook, and
adds a `phase: 'recovering'` the Generate view renders as "Recovering…". This is
the exact shape srv-31 added for `chapter_verifying` (plan 197,
`docs/features/archive/197-asr-verifying-phase.md`) — mirror it.

**Files:**
- Modify: `server/src/routes/generation.ts` (emit the tick + heartbeat in the hook; add `chapter_recovering` to the broadcast event union wherever `chapter_verifying` is declared)
- Modify: `src/lib/types.ts` (phase union + event union)
- Modify: `src/store/chapters-slice.ts` (reducer)
- Modify: `src/views/generation.tsx` (caption)
- Test: `src/store/chapters-slice.test.ts`, `src/views/generation.test.tsx`, `server/src/routes/generation-recycle-recovery.test.ts` (assert the tick fires)
- Test (e2e): `e2e/` (new spec)

- [ ] **Step 1: Read the precedent.** Read how `chapter_verifying` is declared on the server broadcast event type (grep `chapter_verifying` in `server/src/routes/` — find the union; it sits beside `chapter_assembling`), emitted (`emitVerifying`, generation.ts ≈1132), typed on the frontend (`src/lib/types.ts` event union + the `phase` union ≈ line 12), reduced (`src/store/chapters-slice.ts` ≈448–456), and rendered (`src/views/generation.tsx:1303,1310,1414`). Replicate each touch-point for `recovering`.

- [ ] **Step 2: Write the failing frontend tests.**
  - `src/store/chapters-slice.test.ts` — mirror the `chapter_verifying` reducer test (≈372): a `chapter_recovering` event holds the row `in_progress` with `phase === 'recovering'`.
  - `src/views/generation.test.tsx` — mirror the "Verifying speech…" test (≈322): a chapter with `phase: 'recovering'` shows the recovering caption.
```ts
// chapters-slice.test.ts
it('chapter_recovering holds the row in_progress with phase=recovering', () => {
  const start = baseState([makeChapter(3, { state: 'in_progress' })]);
  const next = reducer(start, applyGenerationEvent({ type: 'chapter_recovering', chapterId: 3, progress: 0.9 }));
  expect(next.chapters[0].phase).toBe('recovering');
  expect(next.chapters[0].state).toBe('in_progress');
});
// generation.test.tsx
it('shows the recovering caption on a chapter in the recovering phase', () => {
  // render with a chapter { phase: 'recovering', state: 'in_progress' }
  expect(screen.getByText('Recovering — restarting TTS engine…')).toBeInTheDocument();
});
```
  > Match the exact action creator / render harness the neighbouring `verifying` tests use (`applyGenerationEvent` vs a thunk; the view's render helper). Copy them verbatim as skeletons.

- [ ] **Step 3: Run, confirm FAIL:**
`npx vitest run src/store/chapters-slice.test.ts src/views/generation.test.tsx -t "recovering"`

- [ ] **Step 4: Implement.**
  - **`src/lib/types.ts`:** add `'recovering'` to the `phase` union (the comment ≈ line 12 documents `phase`; extend it to note `chapter_recovering`); add `chapter_recovering` to the generation-event union with the same fields as `chapter_verifying` (`chapterId`, `progress?`, `currentLine?`, `totalLines?`).
  - **`src/store/chapters-slice.ts`:** add a handler beside the `chapter_verifying` block (≈448):
```ts
      if (ev.type === 'chapter_recovering') {
        /* C2 (Wave 3) — sidecar recycled mid-render; the worker is riding out
           the respawn (up to ~210 s). Mirror chapter_verifying: hold the row
           in_progress with a distinct phase so the view shows "Recovering…"
           instead of a frozen caption + the 30 s stall banner. */
        ch.phase = 'recovering';
        ch.state = 'in_progress';
        ch.progress = ev.progress ?? ch.progress;
        if (ev.currentLine != null) ch.currentLine = ev.currentLine;
        if (ev.totalLines != null) ch.totalLines = ev.totalLines;
        return;
      }
```
  - **`src/views/generation.tsx`:** beside `const verifying = chapter.phase === 'verifying';` (≈1303) add `const recovering = chapter.phase === 'recovering';` and extend the caption ternary (≈1310 + the JSX ≈1414) so `recovering` → `'Recovering — restarting TTS engine…'`. Keep it ordered so `recovering` wins over the default synthesising caption.
  - **`server/src/routes/generation.ts`:** (a) add `chapter_recovering` to the server broadcast event union (beside `chapter_verifying`); (b) in the `onRecoverRecycle` hook (Task 1), emit the tick + a heartbeat around the wait:
```ts
        onRecoverRecycle: async ({ engine: recEngine, attempt }) => {
          console.warn(/* …unchanged… */);
          const emitRecovering = () => {
            bumpProgress(); // feed the server no-progress watchdog during the wait
            broadcast(job, {
              type: 'chapter_recovering',
              chapterId: chapter.id,
              characterId: null,
              progress: 0.9,
              currentLine: job.lastProgressTick?.currentLine ?? 0,
              totalLines,
            });
          };
          emitRecovering();
          const beat = setInterval(emitRecovering, 10_000); // < client 30 s stall threshold
          beat.unref?.();
          try {
            await ensureSidecarEngineReady(recEngine, chapterSignal);
          } finally {
            clearInterval(beat);
          }
        },
```
  > `bumpProgress` + the 10 s heartbeat together keep BOTH watchdogs fed: the server no-progress guard (`chapterNoProgressMs`, 720 s) and the client stall detector (30 s). The `0.9` progress + last `currentLine` keep the bar where synthesis left it.

- [ ] **Step 5: Add the server-side tick assertion** to the rewritten `generation-recycle-recovery.test.ts` (Task 1's first test): `expect(body).toContain('"type":"chapter_recovering"');`.

- [ ] **Step 6: Run frontend + server suites:**
`npx vitest run src/store/chapters-slice.test.ts src/views/generation.test.tsx` and `cd server && npx vitest run src/routes/generation-recycle-recovery.test.ts`

- [ ] **Step 7: Add one e2e spec** under `e2e/` asserting the recovering phase surfaces (UI-visible across SSE→redux→view per CLAUDE.md). Mirror the closest existing generation-phase e2e (search `e2e/` for `verifying`/`assembling`/`chapter_` mock-stream specs); if the e2e harness drives generation via the mock API, add a `chapter_recovering` frame to the mock stream and assert the "Recovering…" caption renders. If no comparable generation-SSE e2e exists, note that in the commit message and rely on the Vitest view test (do not invent a new harness).

- [ ] **Step 8: Commit**
```bash
git add server/src/routes/generation.ts server/src/routes/generation-recycle-recovery.test.ts src/lib/types.ts src/store/chapters-slice.ts src/store/chapters-slice.test.ts src/views/generation.tsx src/views/generation.test.tsx e2e/
git commit -m "feat(server,frontend): show a visible 'recovering' phase while a chapter rides out a sidecar respawn (Refs #672)"
```

---

## Task 3: C3 — named recycle-storm alert

**Context:** `RecycleStormError` (added in Task 1) currently surfaces through the
outer catch's generic `describeSynthesisError` path → an `unknown`/`sidecar-
unreachable` failure with no specific remediation. C3 maps it to a clear, named
failure (`code: 'recycle-storm'`) with concrete remediation, recorded
**non-fatal** so the existing cross-chapter cascade (`recordNonFatal`) escalates
to a run-stop when storms repeat — identical to how `ChapterStallError` is
handled (`isStall` branch, generation.ts ≈1527).

**Files:**
- Modify: `server/src/routes/failure-taxonomy.ts` (+ `'recycle-storm'` code + signature)
- Modify: `server/src/routes/generation.ts` (outer-catch branch)
- Test: `server/src/routes/failure-taxonomy.test.ts`, `server/src/routes/generation-recycle-recovery.test.ts`

- [ ] **Step 1: Read** `failure-taxonomy.ts` — the `FailureCode` union (≈18), the `FailureSignature` shape (≈37), the ORDERED `FAILURE_SIGNATURES` table (the timeout/`ChapterSynthTimeoutError` entry must stay first), and how `name` reaches a signature via `FailureContext`. Read `generation.ts`'s `isStall` branch (≈1527–1547) — C3's branch mirrors it.

- [ ] **Step 2: Write the failing tests.**
  - `failure-taxonomy.test.ts`: a `RecycleStormError` (raw message or `ctx.name === 'RecycleStormError'`) classifies to `{ code: 'recycle-storm', fatal: false }` with a remediation mentioning the sidecar/headroom.
  - `generation-recycle-recovery.test.ts` (the Task-1 RecycleStormError test): extend to assert `"errorCode":"recycle-storm"` and a remediation substring in the `chapter_failed` frame.

- [ ] **Step 3: Run, confirm FAIL:**
`cd server && npx vitest run src/routes/failure-taxonomy.test.ts -t "recycle-storm"`

> **⚠️ Ordering hazard (found in the C1 code-quality review).** `RecycleStormError`'s
> message contains the literal `"VRAM/RAM headroom"`, which matches the existing
> `vram-spill` signature's `/CUDA out of memory|VRAM/i` regex. Since the table is
> first-match-wins, the new `recycle-storm` signature MUST be placed **before** the
> `vram-spill` entry, and SHOULD match on `ctx.name === 'RecycleStormError'` (type-driven,
> not substring) so a future message reword can't silently mis-classify it. Independently,
> the `generation.ts` `isRecycleStorm` outer-catch branch (below) short-circuits BEFORE
> `describeSynthesisError` is ever called for this error — so the taxonomy entry is the
> defense-in-depth path for any other caller that classifies a `RecycleStormError`, and
> the outer-catch branch is the primary path generation uses. Implement BOTH.

- [ ] **Step 4: Implement.**
  - `failure-taxonomy.ts`: add `| 'recycle-storm'` to `FailureCode`; add a signature **placed BEFORE the `vram-spill` entry** (see the ordering hazard above), matching on `ctx.name === 'RecycleStormError'` first (type-driven) — the raw-message regex is only a fallback:
```ts
  {
    code: 'recycle-storm',
    fatal: false, // non-fatal per chapter; the cross-chapter cascade escalates repeats
    match: (raw, ctx) => ctx.name === 'RecycleStormError' || /recycled \d+× while rendering/.test(raw),
    userMessage: 'The TTS engine kept restarting while rendering this chapter.',
    remediation:
      'The sidecar is likely thrashing — the host-memory leak (side-11) or too little ' +
      'VRAM/RAM headroom. Restart the TTS sidecar and/or lower generation concurrency, then Retry.',
  },
```
  - `generation.ts` outer catch: add an `isRecycleStorm` branch beside `isStall` so the named code/remediation/`fatal:false` ride through (let it flow into `recordNonFatal(cascade, errorReason)` exactly like a stall). Pass `name` into the classifier via `FailureContext` if the existing `describeSynthesisError(e, engine)` call doesn't already forward `e.name` (it forwards `ctx.name` per failure-taxonomy — confirm and, if needed, ensure `(e as Error).name` is threaded). Simplest: mirror the `isStall` literal-object branch:
```ts
      const isRecycleStorm = (e as { name?: string })?.name === 'RecycleStormError';
      const initial = isStall
        ? { /* …unchanged stall object… */ }
        : isRecycleStorm
          ? {
              errorReason: (e as Error).message,
              fatal: false,
              code: 'recycle-storm' as FailureCode,
              remediation:
                'Restart the TTS sidecar (clears a thrashing/leaking process) and/or lower ' +
                'generation concurrency, then Retry. If it persists, the host-memory leak ' +
                '(side-11) needs headroom.',
            }
          : describeSynthesisError(e, engine);
```
  > Keep the log line specific: `console.error('[generation] chapter … RECYCLE STORM: sidecar recycled N× on one chapter — recorded non-fatal; cascade will stop the run if it repeats.')`.

- [ ] **Step 5: Run the taxonomy + generation suites:**
`cd server && npx vitest run src/routes/failure-taxonomy.test.ts src/routes/generation-recycle-recovery.test.ts`

- [ ] **Step 6: Commit**
```bash
git add server/src/routes/failure-taxonomy.ts server/src/routes/failure-taxonomy.test.ts server/src/routes/generation.ts server/src/routes/generation-recycle-recovery.test.ts
git commit -m "feat(server): name the recycle-storm failure class with concrete remediation (Refs #672)"
```

---

## Task 4: Wave 3 wrap-up

- [ ] **Step 1: Typecheck** — `npm run typecheck` → PASS (frontend + server; the new opts, event type, phase, and FailureCode must all line up).
- [ ] **Step 2: Server suite** — `npm run test:server` → PASS. (Worker-fork flake is known; re-run the single failing file in isolation if it appears — see the project memory.)
- [ ] **Step 3: Frontend suite** — `npm run test` → PASS.
- [ ] **Step 4: Fast battery** — `npm run verify:fast` → PASS (matches pre-commit).
- [ ] **Step 5: e2e (if a spec was added)** — `npm run test:e2e` → PASS.
- [ ] **Step 6: Mark the spec** — add `**Wave 3 landed:** <date>, <shas>` under Delivery in `…-generation-stall-protection-design.md`; note the C1→C2→C3 internal ordering. Commit `docs(docs): mark Wave 3 of generation stall protection landed (Closes #672)`.
- [ ] **Step 7: Spec status + bug** — Wave 3 completes the spec; flip bug #672 from `Refs` to a delivery that can `Closes #672` (the spec's defect-E recovery item is now shipped). Consider moving the design spec's status to `shipped` and whether the three plan files + spec should move under `docs/features/archive/` (follow the archive convention; if a stall-protection regression plan exists under `docs/features/`, fill its Ship notes).
- [ ] **Step 8: Push + PR** — push the branch and update PR #673 (or open the Wave 3 PR per the draft-first CI flow). Body: `Closes #672`. Run `npm run verify` once locally before `gh pr ready` (no CI minutes — local verify is authoritative).

---

## Self-review notes

- **Spec coverage (Wave 3):** C1 ✓ (Task 1 — boundary moved into the per-group loop, completed groups preserved, `out of scope`: disk-checkpoint across a full server restart stays out per the spec), C2 ✓ (Task 2 — `chapter_recovering` tick + phase + heartbeat), C3 ✓ (Task 3 — `RecycleStormError` + named taxonomy entry, escalates via the existing cascade).
- **Passthrough safety:** `withRecycleRecovery` is a no-op when `onRecoverRecycle` is absent, so every existing `synthesiseChapter` caller and its 30+ tests are byte-identical; only `generation.ts` opts in.
- **Test relocation (not deletion):** `generation-recycle-recovery.test.ts` is rewritten to the new architecture (wiring-level) and the resume-preservation proof moves to `synthesise-chapter.test.ts` — a complete replacement, satisfying the testing-discipline rule.
- **Preserved invariants:** the recoverable-error classification is ported verbatim (`isTransient || ChapterSynthTimeoutError`, abort excluded); `MAX_RECYCLE_RECOVERIES` is unchanged as the shared budget; poison/non-transient errors still surface immediately; the no-progress watchdog + abort plumbing are untouched (the hook runs under `chapterSignal`).
- **Cross-task types:** `onRecoverRecycle`/`maxRecycleRecoveries`/`RecycleStormError` (Task 1) are consumed by Tasks 2–3; `chapter_recovering` + `phase: 'recovering'` (Task 2) are defined once in `types.ts`; `'recycle-storm'` `FailureCode` (Task 3) is added in one place.
- **Ordering:** C1 → C2 → C3, each commits independently and is revertible; C2/C3 build on C1's hook (rationale in the priority note).
