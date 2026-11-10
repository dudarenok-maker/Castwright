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
});
