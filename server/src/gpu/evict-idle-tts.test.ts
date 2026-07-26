import { describe, it, expect, vi } from 'vitest';
import { evictIdleQwenBase } from './evict-idle-tts.js';

/* Second eviction lever for capacity admission (#1839). Frees a resident Qwen
   BASE TIER the current op does not need — Qwen only, and only when no render
   is in flight anywhere (see evict-idle-tts.ts for the full rationale). */

describe('evictIdleQwenBase', () => {
  it('frees the OTHER Qwen tier when no render is in flight', async () => {
    const reconcile = vi.fn().mockResolvedValue(true); // actually issued an /unload
    const freed = await evictIdleQwenBase({
      modelKey: 'qwen3-tts-1.7b',
      _reconcile: reconcile,
      _isAnyGenerationActive: () => false,
    });

    expect(freed).toBe(true);
    /* Keep the tier this op needs, drop the other. */
    expect(reconcile).toHaveBeenCalledWith({ keep06: false, keep17: true }, undefined);
  });

  it('keeps the 0.6B base when that is the tier being asked for', async () => {
    const reconcile = vi.fn().mockResolvedValue(true);
    await evictIdleQwenBase({
      modelKey: 'qwen3-tts-0.6b',
      _reconcile: reconcile,
      _isAnyGenerationActive: () => false,
    });

    expect(reconcile).toHaveBeenCalledWith({ keep06: true, keep17: false }, undefined);
  });

  it('#1839 finding 1: reports false when the tier to drop was never resident (nothing actually freed)', async () => {
    /* reconcileResidentQwenTiers ran successfully — it's not a wiring/network
       failure — but had nothing to unload (e.g. the op asked to keep both
       tiers, or the other tier was never loaded). Before the fix this still
       reported success ("true") just because the reconcile was CALLED, which
       cost capacity-retry.ts a wasted immediate-retry attempt instead of its
       normal poll wait (see capacity-retry.test.ts). */
    const reconcile = vi.fn().mockResolvedValue(false);
    const freed = await evictIdleQwenBase({
      modelKey: 'qwen3-tts-1.7b',
      _reconcile: reconcile,
      _isAnyGenerationActive: () => false,
    });

    expect(freed).toBe(false);
    expect(reconcile).toHaveBeenCalledWith({ keep06: false, keep17: true }, undefined);
  });

  it('does nothing while any render is in flight', async () => {
    /* A resident base may be in active use, and a mixed-tier book can have BOTH
       tiers live at once (a character pinned above its book's tier). The render
       path already gets reconcileResidentQwenTiers at run start. */
    const reconcile = vi.fn();
    const freed = await evictIdleQwenBase({
      modelKey: 'qwen3-tts-1.7b',
      _reconcile: reconcile,
      _isAnyGenerationActive: () => true,
    });

    expect(freed).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('#1839 finding 5: frees BOTH idle Qwen bases for a non-Qwen op (Coqui/Kokoro can never need either)', async () => {
    /* Before the fix this bailed out with `false` and never called reconcile
       at all — a Coqui/Kokoro preview blocked by an idle Qwen base (the
       likeliest real blocker on an 8 GB card) was neither freed nor named. */
    const reconcile = vi.fn().mockResolvedValue(true);
    const freed = await evictIdleQwenBase({
      modelKey: 'kokoro-v1',
      _reconcile: reconcile,
      _isAnyGenerationActive: () => false,
    });

    expect(freed).toBe(true);
    expect(reconcile).toHaveBeenCalledWith({ keep06: false, keep17: false }, undefined);
  });

  it('#1839 finding 5: a Coqui op also frees both idle Qwen bases (same non-Qwen rule)', async () => {
    const reconcile = vi.fn().mockResolvedValue(true);
    const freed = await evictIdleQwenBase({
      modelKey: 'coqui-xtts-v2',
      _reconcile: reconcile,
      _isAnyGenerationActive: () => false,
    });

    expect(freed).toBe(true);
    expect(reconcile).toHaveBeenCalledWith({ keep06: false, keep17: false }, undefined);
  });

  it('#1839 finding 5: a non-Qwen op still declines while any render is in flight (gate unchanged)', async () => {
    const reconcile = vi.fn();
    const freed = await evictIdleQwenBase({
      modelKey: 'kokoro-v1',
      _reconcile: reconcile,
      _isAnyGenerationActive: () => true,
    });

    expect(freed).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('#1839 finding 5: the lever never reaches beyond Qwen — its ONLY vocabulary is keep06/keep17, for either op shape', async () => {
    /* Documents the blast-radius guarantee: widening WHICH Qwen tiers a
       non-Qwen op may reclaim never grows into touching Coqui/Kokoro
       residency itself — the reconcile call's keep-map has no other keys to
       express that, for a Qwen op OR a non-Qwen one. */
    const reconcile = vi.fn().mockResolvedValue(true);
    await evictIdleQwenBase({
      modelKey: 'kokoro-v1',
      _reconcile: reconcile,
      _isAnyGenerationActive: () => false,
    });
    expect(Object.keys(reconcile.mock.calls[0][0]).sort()).toEqual(['keep06', 'keep17']);

    reconcile.mockClear();
    await evictIdleQwenBase({
      modelKey: 'qwen3-tts-1.7b',
      _reconcile: reconcile,
      _isAnyGenerationActive: () => false,
    });
    expect(Object.keys(reconcile.mock.calls[0][0]).sort()).toEqual(['keep06', 'keep17']);
  });

  it('fails closed when the active-generation gate is unregistered (default)', async () => {
    /* No `_isAnyGenerationActive` injected — exercises the real
       isAnyGenerationActive() from ./active-generation-gate.js. In this test
       file's process, routes/generation.ts never imports/registers, so the
       gate must resolve to "a render may be running" and decline to evict. */
    const reconcile = vi.fn();
    const freed = await evictIdleQwenBase({
      modelKey: 'qwen3-tts-1.7b',
      _reconcile: reconcile,
    });

    expect(freed).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('fails closed when the reconcile gate is unregistered (default)', async () => {
    /* No `_reconcile` injected — exercises the real
       reconcileResidentQwenTiersIfRegistered() from
       ./qwen-tier-reconcile-gate.js. In this test file's process,
       tts/ensure-sidecar-loaded.ts never imports/registers, so the gate must
       resolve to "nothing can be freed" — evictIdleQwenBase declines rather
       than pretending success. */
    const freed = await evictIdleQwenBase({
      modelKey: 'qwen3-tts-1.7b',
      _isAnyGenerationActive: () => false,
    });

    expect(freed).toBe(false);
  });
});
