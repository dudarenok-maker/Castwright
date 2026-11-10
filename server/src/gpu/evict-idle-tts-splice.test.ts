import { describe, it, expect, vi, beforeEach } from 'vitest';

/* #4066 — a splice or QA repair (chapter-job-coordination's `registerSplice`)
   is a GPU job generation's `inFlightByBook` cannot see. With the REAL leaf
   gate and the REAL registry (no `_isAnyGenerationActive` injection), a
   registered splice must stop a design's auto-free from unloading Qwen. Fresh
   modules per test: the gate's providers are process-lifetime state. */

beforeEach(() => {
  vi.resetModules();
});

describe('evictIdleQwenBase with a registered splice/repair', () => {
  it('declines to unload for a voice design while a splice is in flight', async () => {
    const gate = await import('./active-generation-gate.js');
    const { registerSplice } = await import('../routes/chapter-job-coordination.js');
    const { evictIdleQwenBase } = await import('./evict-idle-tts.js');
    gate.setActiveGenerationBooksProvider(() => []); // generation itself is idle

    const reconcile = vi.fn(async () => true);
    const probe = vi.fn(async () => ({ status: 'ok' as const, kokoroLoaded: true, devices: { kokoro: 'cuda' } }));
    const release = registerSplice('book-1', 3, new AbortController());
    try {
      const out = await evictIdleQwenBase({
        modelKey: 'qwen3-tts-0.6b',
        purpose: 'design',
        _reconcile: reconcile,
        _probeHealth: probe as never,
      });
      expect(out).toBe('declined'); // #4075: splice-only, latch stays armed
      expect(reconcile).not.toHaveBeenCalled();
    } finally {
      release();
    }

    /* Control: with the splice released, the same call proceeds to reconcile. */
    await evictIdleQwenBase({
      modelKey: 'qwen3-tts-0.6b',
      purpose: 'design',
      _reconcile: reconcile,
      _probeHealth: probe as never,
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('#4075: a render in flight (with or without a splice) answers false, not declined', async () => {
    const gate = await import('./active-generation-gate.js');
    const { registerSplice } = await import('../routes/chapter-job-coordination.js');
    const { evictIdleQwenBase } = await import('./evict-idle-tts.js');
    gate.setActiveGenerationBooksProvider(() => ['book-1']); // a render is registered

    const reconcile = vi.fn(async () => true);
    const probe = vi.fn(async () => ({ status: 'ok' as const, kokoroLoaded: true, devices: { kokoro: 'cuda' } }));
    const ask = () =>
      evictIdleQwenBase({
        modelKey: 'qwen3-tts-0.6b',
        purpose: 'design',
        _reconcile: reconcile,
        _probeHealth: probe as never,
      });

    expect(await ask()).toBe(false);
    const release = registerSplice('book-2', 1, new AbortController());
    try {
      expect(await ask()).toBe(false); // render + splice: the render wins
    } finally {
      release();
    }
    expect(reconcile).not.toHaveBeenCalled();
  });

  /* #4075 pass 4 — the epoch tests in evict-idle-tts-quiet.test.ts inject
     `_spliceEpoch`; these use the REAL gate and REAL registry, so the lever's
     default epoch wiring and the light path's epoch check are exercised. */
  it('#4075: the real epoch wiring — a splice wholly between two idle asks does not let the next ask evict', async () => {
    const gate = await import('./active-generation-gate.js');
    const { registerSplice } = await import('../routes/chapter-job-coordination.js');
    const { evictIdleQwenBase } = await import('./evict-idle-tts.js');
    gate.setActiveGenerationBooksProvider(() => []);
    let now = 0;
    const reconcile = vi.fn(async () => true);
    const probe = vi.fn(async () => ({ status: 'ok' as const, qwenLoaded: true }));
    const quiet = { minGapMs: 10, sawRepair: false, idleSince: null, epoch: null };
    const ask = () =>
      evictIdleQwenBase({
        modelKey: 'qwen3-tts-0.6b',
        purpose: 'design',
        quiet,
        _probeHealth: probe as never,
        _reconcile: reconcile,
        _now: () => now,
      });
    const r1 = registerSplice('book-1', 1, new AbortController());
    expect(await ask()).toBe('declined'); // chapter 1 splicing
    r1();
    now = 100;
    expect(await ask()).toBe('declined'); // gap: streak starts
    registerSplice('book-1', 2, new AbortController())(); // chapter 2, never seen by an ask
    now = 200;
    expect(await ask()).toBe('declined');
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('#4075: the light path (kokoro-v1, no probe) re-checks the epoch too', async () => {
    const gate = await import('./active-generation-gate.js');
    const { registerSplice } = await import('../routes/chapter-job-coordination.js');
    const { evictIdleQwenBase } = await import('./evict-idle-tts.js');
    gate.setActiveGenerationBooksProvider(() => []);
    let now = 0;
    const reconcile = vi.fn(async () => true);
    const quiet = { minGapMs: 10, sawRepair: false, idleSince: null, epoch: null };
    const ask = () =>
      evictIdleQwenBase({ modelKey: 'kokoro-v1' as never, quiet, _reconcile: reconcile, _now: () => now });
    const r1 = registerSplice('book-1', 1, new AbortController());
    expect(await ask()).toBe('declined');
    r1();
    now = 100;
    expect(await ask()).toBe('declined');
    registerSplice('book-1', 2, new AbortController())();
    now = 200;
    expect(await ask()).toBe('declined');
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('#4075: a render chapter that registers and deregisters wholly between two idle asks, after a repair, does not let the next ask evict', async () => {
    const { __registerFakeJobForTest } = await import('../routes/generation.js');
    const { registerSplice } = await import('../routes/chapter-job-coordination.js');
    const { evictIdleQwenBase } = await import('./evict-idle-tts.js');
    let now = 0;
    const reconcile = vi.fn(async () => true);
    const probe = vi.fn(async () => ({ status: 'ok' as const, qwenLoaded: true }));
    const quiet = { minGapMs: 10, sawRepair: false, idleSince: null, epoch: null };
    const ask = () =>
      evictIdleQwenBase({
        modelKey: 'qwen3-tts-0.6b',
        purpose: 'design',
        quiet,
        _probeHealth: probe as never,
        _reconcile: reconcile,
        _now: () => now,
      });
    const qa = registerSplice('book-a', 3, new AbortController()); // Listen-row QA repair
    expect(await ask()).toBe('declined'); // sawRepair set
    qa();
    now = 100;
    expect(await ask()).toBe('declined'); // streak starts
    __registerFakeJobForTest('book-b', [])(); // a short render chapter, never seen by an ask
    now = 200;
    expect(await ask()).toBe('declined');
    expect(reconcile).not.toHaveBeenCalled();
  });
});
