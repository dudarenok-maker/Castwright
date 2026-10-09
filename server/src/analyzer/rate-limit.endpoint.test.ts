import { beforeEach, describe, expect, it } from 'vitest';
import { analyzerRateLimiter, geminiRateLimiter } from './rate-limit.js';

beforeEach(() => geminiRateLimiter._reset());

describe('analyzer limiter — OpenAI-compatible endpoint ids (#3084 decision 5)', () => {
  it('is the same singleton as the Gemini limiter', () => {
    expect(analyzerRateLimiter).toBe(geminiRateLimiter);
  });

  it('never throttles an endpoint id by default (Infinity limits are handled)', async () => {
    const start = Date.now();
    for (let i = 0; i < 200; i += 1) {
      await analyzerRateLimiter.acquire('openai:lab::qwen3:30b', 1_000_000);
    }
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it('still honours a server retry-after for an endpoint id', async () => {
    analyzerRateLimiter.recordRejection('openai:lab::qwen3:30b', 300);
    const start = Date.now();
    await analyzerRateLimiter.acquire('openai:lab::qwen3:30b', 10);
    expect(Date.now() - start).toBeGreaterThanOrEqual(250);
  });

  it('a GEMINI_RPM_<slug> env var cannot throttle an endpoint', async () => {
    process.env.GEMINI_RPM_OPENAI_LAB_QWEN3_30B = '1';
    try {
      await analyzerRateLimiter.acquire('openai:lab::qwen3:30b', 10);
      const start = Date.now();
      await analyzerRateLimiter.acquire('openai:lab::qwen3:30b', 10);
      expect(Date.now() - start).toBeLessThan(500);
    } finally {
      delete process.env.GEMINI_RPM_OPENAI_LAB_QWEN3_30B;
    }
  });
});
