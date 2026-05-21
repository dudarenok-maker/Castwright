/* Pipelined two-model analyzer — watermark + back-pressure contract
   (plan 88).

   These tests pin the back-pressure semaphore: Phase 1 chapter K is
   dispatchable ONLY when Phase 0 has completed `K + LAG` chapters OR
   Phase 0b has finalised. The watermark advances monotonically and
   never regresses. If Gemini ever catches up to within `LAG` of
   Gemma's watermark, the next Gemini chapter MUST park until Gemma
   pulls ahead again — this is the user's "keep 10 chapters between
   them" requirement.

   The watermark is per-job (per analysis run); each test constructs
   its own instance via `createPhaseWatermark` — no globals to reset. */

import { describe, it, expect } from 'vitest';
import { createPhaseWatermark, createSequentialWatermark } from './phase-watermark.js';

describe('createPhaseWatermark — default LAG=10', () => {
  it('(a) awaitPhase1Dispatch(0) resolves once markPhase0ChapterComplete is called 10 times', async () => {
    const wm = createPhaseWatermark({ minLagChapters: 10 });
    let resolved = false;
    const pending = wm.awaitPhase1Dispatch(0).then(() => {
      resolved = true;
    });

    /* Watermark not yet at 10 → waiter stays parked. */
    for (let i = 0; i < 9; i++) wm.markPhase0ChapterComplete(i);
    /* Give the microtask queue one tick so any spuriously-resolved
       waiters would have had a chance to flip the flag. */
    await Promise.resolve();
    expect(resolved).toBe(false);

    /* Tenth completion (chapter index 9) pushes watermark to 9 — still
       not >= 0 + 10. */
    wm.markPhase0ChapterComplete(9);
    await Promise.resolve();
    expect(resolved).toBe(false);

    /* Eleventh completion (chapter index 10) → watermark=10 >= 0+10. */
    wm.markPhase0ChapterComplete(10);
    await pending;
    expect(resolved).toBe(true);
  });

  it('(b) awaitPhase1Dispatch(5) resolves once watermark reaches 15', async () => {
    const wm = createPhaseWatermark({ minLagChapters: 10 });
    let resolved = false;
    const pending = wm.awaitPhase1Dispatch(5).then(() => {
      resolved = true;
    });

    /* Advance watermark to 14 — chapter 5 needs >= 15. */
    for (let i = 0; i <= 14; i++) wm.markPhase0ChapterComplete(i);
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(wm.watermark).toBe(14);

    wm.markPhase0ChapterComplete(15);
    await pending;
    expect(resolved).toBe(true);
    expect(wm.watermark).toBe(15);
  });

  it('(c) markPhase0AllDone() releases all pending waiters immediately, regardless of watermark', async () => {
    const wm = createPhaseWatermark({ minLagChapters: 10 });
    const pending = [
      wm.awaitPhase1Dispatch(0),
      wm.awaitPhase1Dispatch(5),
      wm.awaitPhase1Dispatch(20),
    ];

    /* Watermark stays at -1 (never incremented) — but markPhase0AllDone
       fires after the final Phase 0b consolidation in the real route. */
    wm.markPhase0AllDone();
    await Promise.all(pending);
    expect(wm.phase0Done).toBe(true);
  });

  it('(d) BACK-PRESSURE: Gemma stalls at watermark=12; Gemini chapters 0-2 dispatch, chapter 3 parks until 13', async () => {
    /* The user's "if Gemini catches up, slow it down" case. Simulate
       Gemma's watermark stalling at 12 (e.g. rate-limited). Gemini
       chapters 0, 1, 2 satisfy the lag (12 >= chapter + 10). Chapter 3
       does NOT (12 < 13) and MUST park until Gemma's next completion. */
    const wm = createPhaseWatermark({ minLagChapters: 10 });
    for (let i = 0; i <= 12; i++) wm.markPhase0ChapterComplete(i);
    expect(wm.watermark).toBe(12);

    /* Chapters 0, 1, 2 should resolve quickly — Phase 0 watermark
       already past their lag horizon. */
    let r0 = false,
      r1 = false,
      r2 = false,
      r3 = false,
      r4 = false;
    const p0 = wm.awaitPhase1Dispatch(0).then(() => {
      r0 = true;
    });
    const p1 = wm.awaitPhase1Dispatch(1).then(() => {
      r1 = true;
    });
    const p2 = wm.awaitPhase1Dispatch(2).then(() => {
      r2 = true;
    });
    const p3 = wm.awaitPhase1Dispatch(3).then(() => {
      r3 = true;
    });
    const p4 = wm.awaitPhase1Dispatch(4).then(() => {
      r4 = true;
    });

    await Promise.all([p0, p1, p2]);
    expect(r0).toBe(true);
    expect(r1).toBe(true);
    expect(r2).toBe(true);

    /* Chapter 3 must still be parked — back-pressure kicked in. */
    await Promise.resolve();
    await Promise.resolve();
    expect(r3).toBe(false);
    expect(r4).toBe(false);

    /* Gemma advances by one (chapter 13 done) → chapter 3 releases;
       chapter 4 still parked (13 < 14). */
    wm.markPhase0ChapterComplete(13);
    await p3;
    expect(r3).toBe(true);
    await Promise.resolve();
    expect(r4).toBe(false);

    /* Gemma advances again → chapter 4 releases. */
    wm.markPhase0ChapterComplete(14);
    await p4;
    expect(r4).toBe(true);
  });
});

describe('createPhaseWatermark — non-default LAG', () => {
  it('(e) minLagChapters=0 makes chapter K dispatchable as soon as Phase 0 chapter K is marked complete', async () => {
    const wm = createPhaseWatermark({ minLagChapters: 0 });
    let resolved = false;
    const pending = wm.awaitPhase1Dispatch(7).then(() => {
      resolved = true;
    });

    /* Watermark not yet at 7 — chapter 7 still parked. */
    for (let i = 0; i < 7; i++) wm.markPhase0ChapterComplete(i);
    await Promise.resolve();
    expect(resolved).toBe(false);

    /* Chapter 7 done → watermark=7 >= 7+0. */
    wm.markPhase0ChapterComplete(7);
    await pending;
    expect(resolved).toBe(true);
  });
});

describe('createPhaseWatermark — monotonicity + idempotency invariants', () => {
  it('(f) watermark never regresses — markPhase0ChapterComplete(5) then (3) keeps watermark at 5', () => {
    const wm = createPhaseWatermark({ minLagChapters: 10 });
    expect(wm.markPhase0ChapterComplete(5)).toBe(5);
    expect(wm.markPhase0ChapterComplete(3)).toBe(5);
    expect(wm.markPhase0ChapterComplete(4)).toBe(5);
    expect(wm.watermark).toBe(5);
  });

  it('(g) markPhase0AllDone() is idempotent — calling twice does not error', () => {
    const wm = createPhaseWatermark({ minLagChapters: 10 });
    wm.markPhase0AllDone();
    expect(wm.phase0Done).toBe(true);
    /* Second call must not throw; phase0Done stays true. */
    expect(() => wm.markPhase0AllDone()).not.toThrow();
    expect(wm.phase0Done).toBe(true);
  });

  it('out-of-order completions still wake waiters that earlier non-monotonic calls would have skipped', async () => {
    /* Regression for the notifyAll-after-skipped-update bug: if we
       only notify when the watermark actually moves, a stale chapter
       completion arriving late is correctly a no-op. But it must not
       starve real advances afterwards. */
    const wm = createPhaseWatermark({ minLagChapters: 10 });
    let resolved = false;
    const pending = wm.awaitPhase1Dispatch(0).then(() => {
      resolved = true;
    });

    wm.markPhase0ChapterComplete(15);
    await pending;
    expect(resolved).toBe(true);

    /* Late, lower-numbered completion arrives — watermark stays at 15. */
    wm.markPhase0ChapterComplete(2);
    expect(wm.watermark).toBe(15);
  });
});

describe('createSequentialWatermark — manual handoff / legacy short-circuit', () => {
  it('awaitPhase1Dispatch parks indefinitely until markPhase0AllDone fires', async () => {
    /* Manual cowork loop can't pipeline because it waits for human
       input between phases. The stub watermark behaves as an infinite
       lag — any chapter parked until Phase 0b consolidation completes. */
    const wm = createSequentialWatermark();
    let r0 = false;
    let r5 = false;
    const p0 = wm.awaitPhase1Dispatch(0).then(() => {
      r0 = true;
    });
    const p5 = wm.awaitPhase1Dispatch(5).then(() => {
      r5 = true;
    });

    /* markPhase0ChapterComplete is a no-op for the sequential stub —
       it returns -1 and never advances the watermark. */
    for (let i = 0; i < 100; i++) wm.markPhase0ChapterComplete(i);
    await Promise.resolve();
    await Promise.resolve();
    expect(r0).toBe(false);
    expect(r5).toBe(false);
    expect(wm.watermark).toBe(-1);

    wm.markPhase0AllDone();
    await Promise.all([p0, p5]);
    expect(r0).toBe(true);
    expect(r5).toBe(true);
  });

  it('markPhase0AllDone is idempotent', () => {
    const wm = createSequentialWatermark();
    wm.markPhase0AllDone();
    expect(() => wm.markPhase0AllDone()).not.toThrow();
    expect(wm.phase0Done).toBe(true);
  });
});
