import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  analyzerConcurrency,
  acquireAnalyzerSlot,
  describeAnalyzerConcurrency,
  syncAnalyzerConcurrency,
  getAnalyzerConcurrencyStats,
  resetAnalyzerConcurrencyPeak,
} from './analyzer-concurrency.js';

afterEach(() => {
  // Never let a per-test K override bleed into the next case (or the
  // "default 2" assertions above): clear the env and re-sync back to default.
  delete process.env.ANALYZER_OLLAMA_CONCURRENCY;
  syncAnalyzerConcurrency();
  resetAnalyzerConcurrencyPeak();
});

describe('width-K limiter', () => {
  it('is sized from analyzer.ollama.concurrency (default 2)', () => {
    expect(analyzerConcurrency.max).toBe(2);
  });

  it('FIFO: queued acquires are granted in arrival order as slots free', async () => {
    process.env.ANALYZER_OLLAMA_CONCURRENCY = '1';
    syncAnalyzerConcurrency();
    const order: string[] = [];
    const r1 = await acquireAnalyzerSlot('gemma:latest', true);
    const p2 = acquireAnalyzerSlot('gemma:latest', true).then((r) => {
      order.push('a');
      return r;
    });
    const p3 = acquireAnalyzerSlot('gemma:latest', true).then((r) => {
      order.push('b');
      return r;
    });
    await Promise.resolve();
    expect(analyzerConcurrency.queueDepth).toBe(2); // both waiting behind r1
    r1();
    const r2 = await p2;
    r2();
    const r3 = await p3;
    r3();
    expect(order).toEqual(['a', 'b']); // FIFO, not release-order-dependent
  });
});

describe('syncAnalyzerConcurrency (live K)', () => {
  it('resizes the limiter to the current K — the persisted/changed value takes effect without a restart', () => {
    expect(analyzerConcurrency.max).toBe(2); // module-load default
    process.env.ANALYZER_OLLAMA_CONCURRENCY = '4';
    syncAnalyzerConcurrency();
    expect(analyzerConcurrency.max).toBe(4); // adopted live, no re-import
    delete process.env.ANALYZER_OLLAMA_CONCURRENCY;
    syncAnalyzerConcurrency();
    expect(analyzerConcurrency.max).toBe(2); // falls back to default
  });

  it('acquireAnalyzerSlot adopts the current K before gating (was frozen at module-load before)', async () => {
    process.env.ANALYZER_OLLAMA_CONCURRENCY = '3';
    const r = await acquireAnalyzerSlot('gemma:latest', true); // onCpu → limiter only
    expect(analyzerConcurrency.max).toBe(3);
    r();
  });

  it('grows and drains a queued waiter when K is raised live', async () => {
    process.env.ANALYZER_OLLAMA_CONCURRENCY = '1';
    syncAnalyzerConcurrency();
    const r1 = await acquireAnalyzerSlot('gemma:latest', true);
    const p2 = acquireAnalyzerSlot('gemma:latest', true); // K=1, slot held by r1 → queues
    await Promise.resolve();
    expect(analyzerConcurrency.queueDepth).toBe(1);
    process.env.ANALYZER_OLLAMA_CONCURRENCY = '2';
    syncAnalyzerConcurrency(); // grows to 2 — should drain the queued waiter immediately
    const r2 = await p2; // resolves now that a second slot exists, no r1 release needed
    expect(analyzerConcurrency.inFlight).toBe(2);
    r1();
    r2();
  });
});

describe('peak-in-flight telemetry', () => {
  it('tracks the max simultaneous in-flight calls and resets to current', async () => {
    resetAnalyzerConcurrencyPeak();
    expect(getAnalyzerConcurrencyStats().peak).toBe(0);
    const r1 = await acquireAnalyzerSlot('gemma:latest', true);
    const r2 = await acquireAnalyzerSlot('gemma:latest', true);
    expect(getAnalyzerConcurrencyStats().inFlight).toBe(2);
    expect(getAnalyzerConcurrencyStats().peak).toBe(2);
    r1();
    expect(getAnalyzerConcurrencyStats().inFlight).toBe(1);
    expect(getAnalyzerConcurrencyStats().peak).toBe(2); // watermark holds after one leaves
    r2();
    expect(getAnalyzerConcurrencyStats().inFlight).toBe(0);
    resetAnalyzerConcurrencyPeak();
    expect(getAnalyzerConcurrencyStats().peak).toBe(0); // reset to current (0) in-flight
  });

  it('getAnalyzerConcurrencyStats reports the limiter width from .max', () => {
    process.env.ANALYZER_OLLAMA_CONCURRENCY = '5';
    syncAnalyzerConcurrency();
    expect(getAnalyzerConcurrencyStats().limiter).toBe(5);
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

describe('VRAM co-residence gate removal', () => {
  it('analyzer-concurrency.ts no longer imports gpuSemaphore/GpuSemaphore (deleted VRAM budget)', () => {
    const src = readFileSync(new URL('./analyzer-concurrency.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/gpuSemaphore|GpuSemaphore/);
  });
});
