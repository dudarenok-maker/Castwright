/* engine-vram-cost — the per-engine VRAM weights the GPU semaphore charges
   each acquire. Pins the provisional values (so a future tuning pass is a
   visible diff here) and the unknown-engine fallback (cost 1, never grabs
   the whole budget by accident). */

import { describe, it, expect, afterEach } from 'vitest';
import { ENGINE_VRAM_COST, costForEngine, DEFAULT_GPU_VRAM_BUDGET } from './engine-vram-cost.js';
import { setLastKnownAnalyzerDevice } from '../gpu/analyzer-device-state.js';

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
  it('registers spk at cost 1 in the static map', () => {
    expect(ENGINE_VRAM_COST.spk).toBe(1);
  });

  it('costForEngine("spk") returns the static weight (default 1)', () => {
    expect(costForEngine('spk')).toBe(1);
  });
});

describe('costForEngine — analyzer cross-charge guard (W2.6)', () => {
  afterEach(() => {
    setLastKnownAnalyzerDevice('unknown');
  });

  it('returns 0 when the analyzer is confirmed on CPU (no GPU contention possible)', () => {
    setLastKnownAnalyzerDevice('cpu');
    expect(costForEngine('analyzer')).toBe(0);
  });

  it('returns the static weight when the analyzer is confirmed on GPU', () => {
    setLastKnownAnalyzerDevice('cuda');
    expect(costForEngine('analyzer')).toBe(ENGINE_VRAM_COST.analyzer);
  });

  it('returns the static weight when the analyzer placement is unknown (conservative)', () => {
    setLastKnownAnalyzerDevice('unknown');
    expect(costForEngine('analyzer')).toBe(ENGINE_VRAM_COST.analyzer);
  });
});
