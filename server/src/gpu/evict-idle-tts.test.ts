import { describe, it, expect, vi } from 'vitest';
import { evictIdleQwenBase } from './evict-idle-tts.js';

/* Second eviction lever for capacity admission (#1839). Frees a resident Qwen
   BASE TIER the current op does not need — Qwen only, and only when no render
   is in flight anywhere (see evict-idle-tts.ts for the full rationale). */

describe('evictIdleQwenBase', () => {
  it('frees the OTHER Qwen tier when no render is in flight', async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
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
    const reconcile = vi.fn().mockResolvedValue(undefined);
    await evictIdleQwenBase({
      modelKey: 'qwen3-tts-0.6b',
      _reconcile: reconcile,
      _isAnyGenerationActive: () => false,
    });

    expect(reconcile).toHaveBeenCalledWith({ keep06: true, keep17: false }, undefined);
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

  it('does nothing for a non-Qwen op', async () => {
    const reconcile = vi.fn();
    const freed = await evictIdleQwenBase({
      modelKey: 'kokoro-v1',
      _reconcile: reconcile,
      _isAnyGenerationActive: () => false,
    });

    expect(freed).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
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
