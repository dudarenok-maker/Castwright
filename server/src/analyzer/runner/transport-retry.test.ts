import { describe, it, expect, vi } from 'vitest';
import { withTransportRetry, type RetryClassifier, type RetryDisposition } from './transport-retry.js';
import { AnalysisAbortedError } from '../errors.js';
import { DailyQuotaExhaustedError, type GeminiRateLimiter } from '../rate-limit.js';

const tagged = (d: RetryDisposition, retryAfter: number | null = null) =>
  Object.assign(new Error(d), { d, retryAfter });
const classifier: RetryClassifier = {
  classify: (err) => (err as { d?: RetryDisposition }).d ?? 'no-retry',
  retryAfterMs: (err) => (err as { retryAfter?: number | null }).retryAfter ?? null,
};
function fakeLimiter() {
  return { acquire: vi.fn(async () => undefined), recordActualTokens: vi.fn(), recordRejection: vi.fn() };
}
function opts(limiter: ReturnType<typeof fakeLimiter>, over: Record<string, unknown> = {}) {
  return {
    model: 'm',
    limiter: limiter as unknown as GeminiRateLimiter,
    estimatedInputTokens: 42,
    classifier,
    logTag: 'gemini',
    displayName: 'Gemini',
    ...over,
  };
}

describe('withTransportRetry (extracted from GeminiAnalyzer.generateWithLimiter)', () => {
  it('acquires the limiter per attempt and records actual tokens only when the reconciler returns a number', async () => {
    const limiter = fakeLimiter();
    const out = await withTransportRetry(async () => 'ok', opts(limiter, { recordActualTokens: () => 900 }));
    expect(out).toBe('ok');
    expect(limiter.acquire).toHaveBeenCalledTimes(1);
    expect(limiter.acquire.mock.calls[0][0]).toBe('m');
    expect(limiter.acquire.mock.calls[0][1]).toBe(42);
    expect(limiter.recordActualTokens).toHaveBeenCalledWith('m', 900);
    const l2 = fakeLimiter();
    await withTransportRetry(async () => 'ok', opts(l2, { recordActualTokens: () => undefined }));
    expect(l2.recordActualTokens).not.toHaveBeenCalled();
  });

  it.each(['server-error', 'idle'] as const)('%s retries up to maxAttempts, then rethrows the LAST error', async (d) => {
    const limiter = fakeLimiter();
    const errs = [tagged(d), tagged(d), tagged(d)];
    const attempt = vi.fn(async () => {
      throw errs[attempt.mock.calls.length - 1];
    });
    await expect(withTransportRetry(attempt, opts(limiter))).rejects.toBe(errs[2]);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(limiter.acquire).toHaveBeenCalledTimes(3);
  });

  it('rate-limit records the rejection with retry-after on every 429 and retries', async () => {
    const limiter = fakeLimiter();
    const attempt = vi.fn().mockRejectedValueOnce(tagged('rate-limit', 2000)).mockResolvedValueOnce('ok');
    await expect(withTransportRetry(attempt, opts(limiter, { backoffsMs: [0] }))).resolves.toBe('ok');
    expect(limiter.recordRejection).toHaveBeenCalledWith('m', 2000);
  });

  it('daily-quota blocks the limiter and throws DailyQuotaExhaustedError without retrying', async () => {
    const limiter = fakeLimiter();
    const attempt = vi.fn().mockRejectedValue(tagged('daily-quota'));
    await expect(withTransportRetry(attempt, opts(limiter))).rejects.toBeInstanceOf(DailyQuotaExhaustedError);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(limiter.recordRejection.mock.calls[0][0]).toBe('m');
    expect(limiter.recordRejection.mock.calls[0][1]).toBeGreaterThan(0);
  });

  it.each(['abort', 'no-retry'] as const)('%s rethrows immediately', async (d) => {
    const err = tagged(d);
    const attempt = vi.fn().mockRejectedValue(err);
    await expect(withTransportRetry(attempt, opts(fakeLimiter()))).rejects.toBe(err);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('an exhausted time budget before any attempt throws the display-named budget error', async () => {
    const attempt = vi.fn();
    await expect(withTransportRetry(attempt, opts(fakeLimiter(), { maxTotalMs: 0 }))).rejects.toThrow(
      'Gemini retry budget exhausted with no recorded error.',
    );
    expect(attempt).not.toHaveBeenCalled();
  });

  it('a backoff over 1s is announced via onThrottle(…, "retry-after")', async () => {
    const onThrottle = vi.fn();
    const attempt = vi.fn().mockRejectedValueOnce(tagged('server-error')).mockResolvedValueOnce('ok');
    await withTransportRetry(attempt, opts(fakeLimiter(), { backoffsMs: [1500], onThrottle }));
    expect(onThrottle).toHaveBeenCalledWith(expect.any(Number), 'retry-after');
    expect(onThrottle.mock.calls[0][0]).toBeGreaterThan(1000);
  });

  it('aborting during a backoff rejects with AnalysisAbortedError naming the log tag', async () => {
    const ac = new AbortController();
    const attempt = vi.fn().mockRejectedValue(tagged('server-error'));
    const p = withTransportRetry(attempt, opts(fakeLimiter(), { backoffsMs: [5000], signal: ac.signal }));
    setTimeout(() => ac.abort(), 50);
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AnalysisAbortedError);
    expect((err as Error).message).toBe('Aborted during gemini retry backoff.');
  });
});