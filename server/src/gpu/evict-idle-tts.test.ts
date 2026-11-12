import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evictIdleQwenBase, keepForRunStart, freeKokoroForRenderSynth } from './evict-idle-tts.js';
import { computeUsedQwenTiers } from '../tts/per-character-engine.js';
import { getLastTtsAutoFree, resetTtsAutoFreeForTests } from './tts-auto-free-notice.js';

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
      _probeHealth: async () => ({ qwenLoaded: true }),
    });

    expect(freed).toBe(true);
    /* Keep the tier this op needs, drop the other. */
    expect(reconcile).toHaveBeenCalledWith({ keep06: false, keep17: true }, undefined, expect.any(Array));
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
      _probeHealth: async () => ({ qwenLoaded: true }),
    });

    expect(freed).toBe(false);
    expect(reconcile).toHaveBeenCalledWith({ keep06: false, keep17: true }, undefined, expect.any(Array));
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
      _isRepairOnlyKnownActive: () => false,
    });

    /* #4075 - a render answers false (spends the caller's latch), never 'declined'. */
    expect(freed).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('#4075: a splice / QA repair with NO render answers declined (the caller re-asks once it ends)', async () => {
    const reconcile = vi.fn();
    const freed = await evictIdleQwenBase({
      modelKey: 'qwen3-tts-1.7b',
      _reconcile: reconcile,
      _isAnyGenerationActive: () => true,
      _isRepairOnlyKnownActive: () => true,
    });

    expect(freed).toBe('declined');
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
      _isRepairOnlyKnownActive: () => false,
    });

    expect(freed).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('#1839 finding 5: a light op never reaches beyond Qwen — its ONLY vocabulary is keep06/keep17', async () => {
    /* Documents the blast-radius guarantee for every op that is NOT a voice
       design or a Quality (1.7B) op: widening WHICH Qwen tiers a non-Qwen op
       may reclaim never grows into touching Coqui/Kokoro residency itself.
       #4066 deliberately widened this for the two heavy op shapes only (see
       the #4066 block below) — Kokoro on the GPU is reclaimable there. */
    resetTtsAutoFreeForTests();
    const reconcile = vi.fn().mockResolvedValue(true);
    const probeHealth = vi.fn(async () => ({ kokoroLoaded: true, devices: { kokoro: 'cuda' } }));
    await evictIdleQwenBase({
      modelKey: 'kokoro-v1',
      _reconcile: reconcile,
      _isAnyGenerationActive: () => false,
      _probeHealth: probeHealth,
    });
    expect(Object.keys(reconcile.mock.calls[0][0]).sort()).toEqual(['keep06', 'keep17']);

    reconcile.mockClear();
    await evictIdleQwenBase({
      modelKey: 'qwen3-tts-0.6b',
      _reconcile: reconcile,
      _isAnyGenerationActive: () => false,
      _probeHealth: probeHealth,
    });
    expect(Object.keys(reconcile.mock.calls[0][0]).sort()).toEqual(['keep06', 'keep17']);
    expect(getLastTtsAutoFree()).toBeNull();
  });

  describe('#4066 — a voice design or a Quality (1.7B) op frees the standard Qwen and Kokoro first', () => {
    beforeEach(() => resetTtsAutoFreeForTests());

    /* A reconcile stand-in that reports (through the out-param) what it
       "unloaded", the way the real one does per successful /unload. */
    const reconcileFreeing = (names: string[], result: boolean) =>
      vi.fn(async (_keep: unknown, _signal: unknown, freedOut?: string[]) => {
        freedOut?.push(...names);
        return result;
      });

    it('a design frees the resident standard Qwen 0.6B, even though the book itself is on 0.6B, and records the notice', async () => {
      /* The design route passes the BOOK's model key (0.6B here). Before
         #4066 that kept the 0.6B base resident (the elevate-only rule), so on
         an 8 GB card the design's 6144 MB admission could never fit. */
      const reconcile = reconcileFreeing(['Qwen 0.6B'], true);
      const freed = await evictIdleQwenBase({
        modelKey: 'qwen3-tts-0.6b',
        purpose: 'design',
        _reconcile: reconcile,
        _isAnyGenerationActive: () => false,
        _probeHealth: async () => ({ qwenLoaded: true, kokoroLoaded: false }),
      });

      expect(freed).toBe(true);
      expect(reconcile).toHaveBeenCalledWith({ keep06: false, keep17: false }, undefined, expect.any(Array));
      expect(getLastTtsAutoFree()).toMatchObject({ models: ['Qwen 0.6B'], purpose: 'voice design' });
    });

    it('a design also frees an on-demand Kokoro that sits on the GPU', async () => {
      const reconcile = reconcileFreeing(['Kokoro'], true);
      const freed = await evictIdleQwenBase({
        modelKey: 'qwen3-tts-0.6b',
        purpose: 'design',
        _reconcile: reconcile,
        _isAnyGenerationActive: () => false,
        _probeHealth: async () => ({ qwenLoaded: false, kokoroLoaded: true, devices: { kokoro: 'cuda' } }),
      });

      expect(freed).toBe(true);
      expect(reconcile).toHaveBeenCalledWith(
        { keep06: false, keep17: false, keepKokoro: false },
        undefined,
        expect.any(Array),
      );
      expect(getLastTtsAutoFree()).toMatchObject({ models: ['Kokoro'], purpose: 'voice design' });
    });

    it('a Quality (1.7B) op frees the 0.6B base and a GPU Kokoro together', async () => {
      const reconcile = reconcileFreeing(['Qwen 0.6B', 'Kokoro'], true);
      await evictIdleQwenBase({
        modelKey: 'qwen3-tts-1.7b',
        _reconcile: reconcile,
        _isAnyGenerationActive: () => false,
        _probeHealth: async () => ({ qwenLoaded: true, kokoroLoaded: true, devices: { kokoro: 'cuda' } }),
      });

      expect(reconcile).toHaveBeenCalledWith(
        { keep06: false, keep17: true, keepKokoro: false },
        undefined,
        expect.any(Array),
      );
      expect(getLastTtsAutoFree()).toMatchObject({ models: ['Qwen 0.6B', 'Kokoro'], purpose: 'Quality render' });
    });

    it('leaves a CPU-resident Kokoro alone — it holds no VRAM to free', async () => {
      const reconcile = reconcileFreeing(['Qwen 0.6B'], true);
      await evictIdleQwenBase({
        modelKey: 'qwen3-tts-0.6b',
        purpose: 'design',
        _reconcile: reconcile,
        _isAnyGenerationActive: () => false,
        _probeHealth: async () => ({ qwenLoaded: true, kokoroLoaded: true, devices: { kokoro: 'cpu' } }),
      });

      expect(reconcile).toHaveBeenCalledWith({ keep06: false, keep17: false }, undefined, expect.any(Array));
      expect(getLastTtsAutoFree()).toMatchObject({ models: ['Qwen 0.6B'] });
    });

    it('frees nothing and records no notice while a render is in flight', async () => {
      const reconcile = reconcileFreeing(['Qwen 0.6B'], true);
      const probeHealth = vi.fn(async () => ({ qwenLoaded: true, kokoroLoaded: true, devices: { kokoro: 'cuda' } }));
      const freed = await evictIdleQwenBase({
        modelKey: 'qwen3-tts-0.6b',
        purpose: 'design',
        _reconcile: reconcile,
        _isAnyGenerationActive: () => true,
        _isRepairOnlyKnownActive: () => false,
        _probeHealth: probeHealth,
      });

      expect(freed).toBe(false);
      expect(reconcile).not.toHaveBeenCalled();
      expect(getLastTtsAutoFree()).toBeNull();
    });

    it('records no notice when nothing was actually unloaded', async () => {
      const reconcile = reconcileFreeing([], false);
      await evictIdleQwenBase({
        modelKey: 'qwen3-tts-0.6b',
        purpose: 'design',
        _reconcile: reconcile,
        _isAnyGenerationActive: () => false,
        _probeHealth: async () => ({ qwenLoaded: true }),
      });

      expect(getLastTtsAutoFree()).toBeNull();
    });

    it('each recorded notice gets a new sequence number', async () => {
      const run = () =>
        evictIdleQwenBase({
          modelKey: 'qwen3-tts-0.6b',
          purpose: 'design',
          _reconcile: reconcileFreeing(['Qwen 0.6B'], true),
          _isAnyGenerationActive: () => false,
          _probeHealth: async () => ({ qwenLoaded: true }),
        });
      await run();
      const first = getLastTtsAutoFree()!.seq;
      await run();
      expect(getLastTtsAutoFree()!.seq).toBeGreaterThan(first);
    });

    it("still records the Qwen model it freed when Kokoro's unload failed (reconcile returns false)", async () => {
      const freed = await evictIdleQwenBase({
        modelKey: 'qwen3-tts-0.6b',
        purpose: 'design',
        _reconcile: reconcileFreeing(['Qwen 0.6B'], false),
        _isAnyGenerationActive: () => false,
        _probeHealth: async () => ({ qwenLoaded: true, kokoroLoaded: true, devices: { kokoro: 'cuda' } }),
      });

      expect(freed).toBe(false);
      expect(getLastTtsAutoFree()).toMatchObject({ models: ['Qwen 0.6B'] });
    });

    it.each([
      ['the probe throws', async () => { throw new Error('health down'); }],
      ['the probe is unregistered (null)', async () => null],
      ['the probe reports the sidecar unreachable', async () => ({ status: 'unreachable' as const })],
    ])('declines a heavy op when %s — an unreadable probe cannot rule out an in-flight design', async (_name, probe) => {
      const reconcile = reconcileFreeing(['Qwen 0.6B'], true);
      const result = await evictIdleQwenBase({
        modelKey: 'qwen3-tts-0.6b',
        purpose: 'design',
        _reconcile: reconcile,
        _isAnyGenerationActive: () => false,
        _probeHealth: probe,
      });

      expect(result).toBe('declined');
      expect(reconcile).not.toHaveBeenCalled();
      expect(getLastTtsAutoFree()).toBeNull();
    });

    it('a light (non-Qwen) op does not need a readable probe — it never consults it', async () => {
      const reconcile = vi.fn(async () => true);
      const probeHealth = vi.fn(async () => null);
      const freed = await evictIdleQwenBase({
        modelKey: 'coqui-xtts-v2',
        _reconcile: reconcile,
        _isAnyGenerationActive: () => false,
        _probeHealth: probeHealth,
      });

      expect(freed).toBe(true);
      expect(probeHealth).not.toHaveBeenCalled();
    });

    it('declines when a VoiceDesign model is resident on the denied device — unloading would kill another design', async () => {
      const reconcile = reconcileFreeing(['Qwen 0.6B'], true);
      const result = await evictIdleQwenBase({
        modelKey: 'qwen3-tts-0.6b',
        purpose: 'design',
        deviceKey: 'cuda:0',
        _reconcile: reconcile,
        _isAnyGenerationActive: () => false,
        _probeHealth: async () => ({ qwenLoaded: true, qwenDesignResident: true, qwenDeviceKey: 'cuda:0' }),
      });

      expect(result).toBe('declined');
      expect(reconcile).not.toHaveBeenCalled();
      expect(getLastTtsAutoFree()).toBeNull();
    });

    it('a VoiceDesign resident on a DIFFERENT device does not stop the free', async () => {
      const reconcile = reconcileFreeing(['Qwen 0.6B'], true);
      const result = await evictIdleQwenBase({
        modelKey: 'qwen3-tts-0.6b',
        purpose: 'design',
        deviceKey: 'cuda:1',
        _reconcile: reconcile,
        _isAnyGenerationActive: () => false,
        _probeHealth: async () => ({ qwenLoaded: true, qwenDesignResident: true, qwenDeviceKey: 'cuda:0' }),
      });

      expect(result).toBe(true);
      expect(reconcile).toHaveBeenCalled();
    });

    it('re-checks the render gate after the health probe, right before unloading', async () => {
      /* A render can start during the probe's (up to ~2 s) round trip. */
      const reconcile = reconcileFreeing(['Qwen 0.6B'], true);
      const gate = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
      const result = await evictIdleQwenBase({
        modelKey: 'qwen3-tts-0.6b',
        purpose: 'design',
        _reconcile: reconcile,
        _isAnyGenerationActive: gate,
        _isRepairOnlyKnownActive: () => false,
        _probeHealth: async () => ({ qwenLoaded: true }),
      });

      expect(result).toBe(false);
      expect(reconcile).not.toHaveBeenCalled();
      expect(getLastTtsAutoFree()).toBeNull();
    });

    it('#4075: a repair that starts during the probe keeps the latch armed (declined)', async () => {
      const reconcile = reconcileFreeing(['Qwen 0.6B'], true);
      const gate = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
      const result = await evictIdleQwenBase({
        modelKey: 'qwen3-tts-0.6b',
        purpose: 'design',
        _reconcile: reconcile,
        _isAnyGenerationActive: gate,
        _isRepairOnlyKnownActive: () => true,
        _probeHealth: async () => ({ qwenLoaded: true }),
      });

      expect(result).toBe('declined');
      expect(reconcile).not.toHaveBeenCalled();
    });
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

    expect(freed).toBe(false); // unregistered reads as active, and a repair is never known: false, like main
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
      _probeHealth: async () => ({ qwenLoaded: true }),
    });

    expect(freed).toBe(false);
  });
});

describe('keepForRunStart (#4066 — a Quality chapter render unloads an on-GPU Kokoro at run start)', () => {
  const keep = { keep06: false, keep17: true };

  it('adds keepKokoro:false for a Quality (1.7B) run with Kokoro on the GPU', async () => {
    const out = await keepForRunStart(keep, false, async () => ({
      kokoroLoaded: true,
      devices: { kokoro: 'cuda' },
    }));
    expect(out).toEqual({ keep06: false, keep17: true, keepKokoro: false });
  });

  it('leaves a Standard (0.6B) run alone', async () => {
    const out = await keepForRunStart({ keep06: true, keep17: false }, false, async () => ({
      kokoroLoaded: true,
      devices: { kokoro: 'cuda' },
    }));
    expect(out).toEqual({ keep06: true, keep17: false });
  });

  it('keys on the tier the run will LOAD: a Standard-default book with every character toggled to Quality drops Kokoro', async () => {
    /* The target the route hands in is `computeUsedQwenTiers`, which resolves
       per-character tiers (fs-56) against the run default: an all-elevated cast
       yields keep17-only whatever the run default (0.6B here) says. Composed
       for real, not hand-written, so the input is the route's own. */
    const tiers = computeUsedQwenTiers(
      [
        { ttsEngine: 'qwen', ttsModelKey: 'qwen3-tts-1.7b' },
        { ttsEngine: 'qwen', ttsModelKey: 'qwen3-tts-1.7b' },
      ],
      'qwen',
      'qwen3-tts-0.6b',
    );
    expect(tiers).toEqual({ keep06: false, keep17: true });
    const out = await keepForRunStart(tiers, false, async () => ({
      kokoroLoaded: true,
      devices: { kokoro: 'cuda' },
    }));
    expect(out).toEqual({ keep06: false, keep17: true, keepKokoro: false });
  });

  it('a mixed-tier run (any 1.7B in it) drops Kokoro too', async () => {
    const out = await keepForRunStart({ keep06: true, keep17: true }, false, async () => ({
      kokoroLoaded: true,
      devices: { kokoro: 'cuda' },
    }));
    expect(out).toEqual({ keep06: true, keep17: true, keepKokoro: false });
  });

  it('leaves Kokoro alone, without probing, when another generation is in flight', async () => {
    const probe = vi.fn(async () => ({ kokoroLoaded: true, devices: { kokoro: 'cuda' } }));
    const out = await keepForRunStart(keep, true, probe);
    expect(out).toEqual(keep);
    expect(probe).not.toHaveBeenCalled();
  });

  it('leaves a CPU Kokoro alone', async () => {
    const out = await keepForRunStart(keep, false, async () => ({
      kokoroLoaded: true,
      devices: { kokoro: 'cpu' },
    }));
    expect(out).toEqual(keep);
  });

  it('leaves everything alone when Kokoro is not resident or the probe fails', async () => {
    expect(await keepForRunStart(keep, false, async () => ({ kokoroLoaded: false }))).toEqual(keep);
    expect(
      await keepForRunStart(keep, false, async () => {
        throw new Error('health down');
      }),
    ).toEqual(keep);
    expect(await keepForRunStart(keep, false, async () => null)).toEqual(keep);
  });
});

describe('freeKokoroForRenderSynth (#4079)', () => {
  const gpuKokoro = async () => ({ kokoroLoaded: true, devices: { kokoro: 'cuda' } });

  it('unloads Kokoro and nothing else for a render-own Quality synth', async () => {
    const reconcile = vi.fn(async (_k: unknown, _s?: AbortSignal, out?: string[]) => {
      out?.push('Kokoro');
      return true;
    });
    const freed = await freeKokoroForRenderSynth({
      modelKey: 'qwen3-tts-1.7b',
      isRenderSynth: true,
      _probeHealth: gpuKokoro,
      _reconcile: reconcile,
    });
    expect(freed).toBe(true);
    /* both Qwen tiers kept: only Kokoro may go */
    expect(reconcile).toHaveBeenCalledWith({ keep06: true, keep17: true, keepKokoro: false }, undefined, expect.any(Array));
  });

  it.each([
    ['not a render synth (a design / preview / other op)', { modelKey: 'qwen3-tts-1.7b' as const, isRenderSynth: false }],
    ['a standard-tier render synth', { modelKey: 'qwen3-tts-0.6b' as const, isRenderSynth: true }],
    ['no model key', { isRenderSynth: true }],
  ])('frees nothing for %s', async (_n, o) => {
    const reconcile = vi.fn(async () => true);
    const probe = vi.fn(gpuKokoro);
    expect(await freeKokoroForRenderSynth({ ...o, _probeHealth: probe, _reconcile: reconcile })).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('leaves a CPU Kokoro, an absent Kokoro and an unreadable probe alone', async () => {
    const reconcile = vi.fn(async () => true);
    const base = { modelKey: 'qwen3-tts-1.7b' as const, isRenderSynth: true, _reconcile: reconcile };
    expect(await freeKokoroForRenderSynth({ ...base, _probeHealth: async () => ({ kokoroLoaded: true, devices: { kokoro: 'cpu' } }) })).toBe(false);
    expect(await freeKokoroForRenderSynth({ ...base, _probeHealth: async () => ({ kokoroLoaded: false }) })).toBe(false);
    expect(await freeKokoroForRenderSynth({ ...base, _probeHealth: async () => null })).toBe(false);
    expect(await freeKokoroForRenderSynth({ ...base, _probeHealth: async () => ({ status: 'unreachable' as const }) })).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('reports false when Kokoro was not actually unloaded', async () => {
    expect(
      await freeKokoroForRenderSynth({
        modelKey: 'qwen3-tts-1.7b',
        isRenderSynth: true,
        _probeHealth: gpuKokoro,
        _reconcile: async () => false,
      }),
    ).toBe(false);
  });

  it('#4066 still holds: the general lever frees nothing while a render is in flight', async () => {
    const reconcile = vi.fn(async () => true);
    const freed = await evictIdleQwenBase({
      modelKey: 'qwen3-tts-1.7b',
      purpose: 'design',
      _reconcile: reconcile,
      _isAnyGenerationActive: () => true,
      _probeHealth: gpuKokoro,
    });
    expect(freed).toBe(false);
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe('freeKokoroForRenderSynth — visibility and one-shot (#4079)', () => {
  it('logs that the render freed Kokoro for its own line (no Qwen tier)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await freeKokoroForRenderSynth({
        modelKey: 'qwen3-tts-1.7b',
        isRenderSynth: true,
        _probeHealth: async () => ({ kokoroLoaded: true, devices: { kokoro: 'cuda' } }),
        _reconcile: async (_k, _s, out) => {
          out?.push('Kokoro');
          return true;
        },
      });
      expect(info.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/render's own Quality line refused.*unloading Kokoro/);
    } finally {
      info.mockRestore();
    }
  });
});
