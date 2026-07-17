import { describe, it, expect, afterEach } from 'vitest';
import { analyzerPoolWidth } from './analysis.js';

describe('analyzerPoolWidth (live from analyzer.ollama.concurrency)', () => {
  afterEach(() => {
    delete process.env.ANALYZER_OLLAMA_CONCURRENCY;
  });
  it('defaults to the knob (2)', () => {
    expect(analyzerPoolWidth()).toBe(2);
  });
  it('reads the env live and clamps to 6', () => {
    process.env.ANALYZER_OLLAMA_CONCURRENCY = '9';
    expect(analyzerPoolWidth()).toBe(6);
  });
  it('floors at 1', () => {
    process.env.ANALYZER_OLLAMA_CONCURRENCY = '1';
    expect(analyzerPoolWidth()).toBe(1);
  });
});
