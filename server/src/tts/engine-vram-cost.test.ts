/* engine-vram-cost — the per-engine VRAM weights the GPU semaphore charges
   each acquire. Pins the provisional values (so a future tuning pass is a
   visible diff here) and the unknown-engine fallback (cost 1, never grabs
   the whole budget by accident). */

import { describe, it, expect, afterEach } from 'vitest';
import { ENGINE_VRAM_COST, costForEngine, DEFAULT_GPU_VRAM_BUDGET } from './engine-vram-cost.js';

describe('engine-vram-cost', () => {
  it('exposes the provisional per-engine weights', () => {
    expect(ENGINE_VRAM_COST).toMatchObject({
      kokoro: 1,
      qwen: 1,
      coqui: 3,
      gemini: 0,
      analyzer: 4,
    });
  });

  it('returns the mapped cost for a known engine', () => {
    expect(costForEngine('kokoro')).toBe(1);
    expect(costForEngine('coqui')).toBe(3);
    expect(costForEngine('gemini')).toBe(0);
    expect(costForEngine('analyzer')).toBe(4);
    expect(costForEngine('qwen')).toBe(1);
  });

  it('falls back to cost 1 for an unknown engine', () => {
    expect(costForEngine('piper')).toBe(1);
    expect(costForEngine('totally-new-engine')).toBe(1);
    expect(costForEngine('')).toBe(1);
  });

  it('documents a default budget that fits Kokoro + Qwen together', () => {
    expect(DEFAULT_GPU_VRAM_BUDGET).toBe(4);
    expect(ENGINE_VRAM_COST.kokoro + ENGINE_VRAM_COST.qwen).toBeLessThanOrEqual(
      DEFAULT_GPU_VRAM_BUDGET,
    );
    /* Two Coqui ops would spill the budget → serialise. */
    expect(ENGINE_VRAM_COST.coqui * 2).toBeGreaterThan(DEFAULT_GPU_VRAM_BUDGET);
  });
});

describe('engine-vram-cost: spk (srv-47)', () => {
  afterEach(() => {
    delete process.env.GPU_WEIGHT_SPK;
  });

  it('registers spk at cost 1 in the static map', () => {
    expect(ENGINE_VRAM_COST.spk).toBe(1);
  });

  it('costForEngine("spk") reads the live gpu.weight.spk knob (default 1)', () => {
    expect(costForEngine('spk')).toBe(1);
  });

  it('costForEngine("spk") honours a GPU_WEIGHT_SPK override', () => {
    process.env.GPU_WEIGHT_SPK = '2';
    expect(costForEngine('spk')).toBe(2);
  });
});
