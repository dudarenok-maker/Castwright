import { describe, it, expect, afterEach } from 'vitest';
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
  it('floors effective at 1 when budget < cost (M4)', () => {
    expect(describeAnalyzerConcurrency(4, 1)).toContain('effective 1');
  });
  it('reports min(K, floor(budget/cost)) otherwise', () => {
    expect(describeAnalyzerConcurrency(4, 16)).toContain('effective 2');
  });
});
