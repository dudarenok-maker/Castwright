import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { gpuSemaphore } from '../gpu/semaphore.js';
import {
  analyzerConcurrency,
  acquireAnalyzerSlot,
  canonicalLeaseKey,
  describeAnalyzerConcurrency,
  __resetAnalyzerLeasesForTest,
} from './analyzer-concurrency.js';

afterEach(() => __resetAnalyzerLeasesForTest());

describe('width-K limiter', () => {
  it('is sized from analyzer.ollama.concurrency (default 2)', () => {
    expect(analyzerConcurrency.budget).toBe(2);
  });
});

describe('canonicalLeaseKey', () => {
  it('appends :latest to a bare tag so one model has one key', () => {
    expect(canonicalLeaseKey('qwen3.5')).toBe(canonicalLeaseKey('qwen3.5:latest'));
  });
});

describe('per-model lease', () => {
  beforeAll(() => {
    // These assertions assume the test-env gpuSemaphore budget is 1 (the
    // "budget-1 test env" the inline comments below rely on). A dev box with
    // GPU_VRAM_BUDGET >= 2 in server/.env would otherwise fail these tests
    // with a confusing serialize-assertion mismatch — fail loudly here
    // instead so the real cause is obvious.
    expect(
      gpuSemaphore.budget,
      'per-model lease tests assume gpuSemaphore.budget === 1 (unset GPU_VRAM_BUDGET/GPU_CONCURRENCY); ' +
        'a server/.env with GPU_VRAM_BUDGET >= 2 will make these assertions fail confusingly — unset it to run this suite',
    ).toBe(1);
  });

  it('same model: two concurrent calls share ONE gpuSemaphore slot', async () => {
    const before = gpuSemaphore.usedTokens;
    const r1 = await acquireAnalyzerSlot('gemma:latest', false);
    const r2 = await acquireAnalyzerSlot('gemma:latest', false); // joins, no 2nd acquire
    expect(gpuSemaphore.usedTokens).toBe(before + gpuSemaphore.budget); // one lease = whole (budget-1 test env)
    r1(); r2();
    expect(gpuSemaphore.usedTokens).toBe(before);
  });

  it('two DIFFERENT models serialize (budget cannot hold both) — the L2 fix', async () => {
    const r1 = await acquireAnalyzerSlot('gemma:latest', false); // takes the whole budget-1
    let granted = false;
    const p2 = acquireAnalyzerSlot('qwen:latest', false).then((r) => { granted = true; return r; });
    await Promise.resolve();
    expect(granted).toBe(false);                 // qwen queued on gpuSemaphore
    expect(gpuSemaphore.queueDepth).toBe(1);
    r1();                                         // frees the slot
    const r2 = await p2;
    expect(granted).toBe(true);
    r2();
  });

  it('CPU call takes NO gpuSemaphore slot (but still the limiter)', async () => {
    const before = gpuSemaphore.usedTokens;
    const r = await acquireAnalyzerSlot('gemma:latest', true);
    expect(gpuSemaphore.usedTokens).toBe(before); // no slot
    expect(analyzerConcurrency.inFlight).toBe(1); // limiter still taken
    r();
    expect(analyzerConcurrency.inFlight).toBe(0);
  });

  it('releases the slot when only the LAST same-model call leaves', async () => {
    const before = gpuSemaphore.usedTokens;
    const r1 = await acquireAnalyzerSlot('gemma:latest', false);
    const r2 = await acquireAnalyzerSlot('gemma:latest', false);
    r1();
    expect(gpuSemaphore.usedTokens).toBe(before + gpuSemaphore.budget); // still held (r2 in flight)
    r2();
    expect(gpuSemaphore.usedTokens).toBe(before);                       // now freed
  });
});

describe('describeAnalyzerConcurrency', () => {
  it('reports the same-model call ceiling as K, separately from distinct-model co-residency (M4)', () => {
    // budget=1, cost=4 -> distinct-model co-residency floors at 1, but the
    // same-model call ceiling is STILL K=2 — these are different axes and
    // must not collapse into one misleading "effective N".
    const msg = describeAnalyzerConcurrency(4, 1);
    expect(msg).toContain('K=2');
    expect(msg).toContain('same-model');
    expect(msg).toContain('OLLAMA_NUM_PARALLEL >= 2');
    expect(msg).toContain('distinct-model co-residency');
    expect(msg).toContain('co-residency ceiling (GPU budget=1 / analyzer cost=4) = 1');
    expect(msg).not.toMatch(/effective \d/);
  });
  it('reports distinct-model co-residency as floor(budget/cost), still separate from K', () => {
    // budget=16, cost=4 -> co-residency=4, independent of K.
    const msg = describeAnalyzerConcurrency(4, 16);
    expect(msg).toContain('K=2');
    expect(msg).toContain('same-model');
    expect(msg).toContain('OLLAMA_NUM_PARALLEL >= 2');
    expect(msg).toContain('distinct-model co-residency');
    expect(msg).toContain('co-residency ceiling (GPU budget=16 / analyzer cost=4) = 4');
    expect(msg).not.toMatch(/effective \d/);
  });
});
