/* Unit coverage for the TTS retry helper.

   What this pins:
   - Transient errors trigger the retry path (1 attempt + 2 retries by default).
   - Non-transient errors bail immediately on the first throw.
   - AbortError bails immediately even when the `transient` flag is set
     — caller-driven stop is never auto-retried.
   - Retry-budget exhaustion re-throws the LAST transient error so the
     surface text reflects the actual underlying failure.
   - `onRetry` fires once per retry sleep with the correct attempt number.
   - Mid-backoff abort tears down the sleep promptly.

   See `synthesise-chapter.test.ts` for the end-to-end "two 503s then a
   200" assertion against the real provider call site. */

import { describe, it, expect, vi } from 'vitest';
import { isTransient, withTtsRetry } from './retry.js';

function transientError(message: string, status = 503): Error {
  return Object.assign(new Error(message), { transient: true as const, status });
}

function fatalError(message: string, status = 400): Error {
  return Object.assign(new Error(message), { transient: false as const, status });
}

describe('isTransient', () => {
  it('returns true when the error carries transient:true', () => {
    expect(isTransient(transientError('boom'))).toBe(true);
  });

  it('returns false when the flag is missing', () => {
    expect(isTransient(new Error('plain'))).toBe(false);
  });

  it('returns false when the flag is explicitly false', () => {
    expect(isTransient(fatalError('nope'))).toBe(false);
  });

  it('tolerates non-Error throwables', () => {
    expect(isTransient(null)).toBe(false);
    expect(isTransient(undefined)).toBe(false);
    expect(isTransient('string err')).toBe(false);
    expect(isTransient(42)).toBe(false);
  });
});

describe('withTtsRetry', () => {
  it('returns the resolved value on a clean primary attempt (no sleep)', async () => {
    const fn = vi.fn().mockResolvedValueOnce('ok');
    const onRetry = vi.fn();
    const result = await withTtsRetry(fn, { onRetry, backoffsMs: [10, 10] });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('retries on transient throw and returns the eventual success', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transientError('503 first'))
      .mockRejectedValueOnce(transientError('503 second'))
      .mockResolvedValueOnce('eventual-ok');
    const onRetry = vi.fn();

    const result = await withTtsRetry(fn, { onRetry, backoffsMs: [5, 5] });

    expect(result).toBe('eventual-ok');
    expect(fn).toHaveBeenCalledTimes(3);
    // Two retries fired (one per failed attempt before the success).
    expect(onRetry).toHaveBeenCalledTimes(2);
    // attempt numbering: 2 = "about to start attempt 2", 3 = "about to start attempt 3".
    expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 2, reason: '503 first' });
    expect(onRetry.mock.calls[1][0]).toMatchObject({ attempt: 3, reason: '503 second' });
  });

  it('bails immediately on a non-transient error (no retry, no sleep)', async () => {
    const fn = vi.fn().mockRejectedValueOnce(fatalError('400 bad request'));
    const onRetry = vi.fn();

    await expect(withTtsRetry(fn, { onRetry, backoffsMs: [5, 5] })).rejects.toThrow(
      '400 bad request',
    );

    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('bails immediately on AbortError even when transient:true is set', async () => {
    const abort = Object.assign(new Error('cancelled'), {
      name: 'AbortError',
      transient: true,
    });
    const fn = vi.fn().mockRejectedValueOnce(abort);

    await expect(withTtsRetry(fn, { backoffsMs: [5, 5] })).rejects.toThrow('cancelled');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('re-throws the LAST transient error after budget exhaustion', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transientError('first-503'))
      .mockRejectedValueOnce(transientError('second-503'))
      .mockRejectedValueOnce(transientError('third-503'));

    await expect(withTtsRetry(fn, { backoffsMs: [5, 5], maxAttempts: 3 })).rejects.toThrow(
      'third-503',
    );

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('honours maxAttempts when set to 1 (no retries at all)', async () => {
    const fn = vi.fn().mockRejectedValueOnce(transientError('503'));

    await expect(withTtsRetry(fn, { backoffsMs: [5], maxAttempts: 1 })).rejects.toThrow('503');

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('aborts mid-backoff promptly when signal fires during the sleep', async () => {
    const controller = new AbortController();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transientError('503'))
      .mockResolvedValueOnce('would-not-reach');

    // Long backoff so the abort visibly cuts it short.
    const start = Date.now();
    const pending = withTtsRetry(fn, {
      signal: controller.signal,
      backoffsMs: [5000, 5000],
    });
    // Fire abort shortly after the first failure starts its backoff.
    setTimeout(() => controller.abort(), 30);

    await expect(pending).rejects.toThrow(/aborted/i);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    // Only the primary attempt should have run; the retry never started.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reads beyond the backoffs[] array by repeating the last value', async () => {
    // 4 attempts but only 2 backoff entries → entries [0]=10, [1]=10, [2]=10 (repeat last).
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transientError('t1'))
      .mockRejectedValueOnce(transientError('t2'))
      .mockRejectedValueOnce(transientError('t3'))
      .mockResolvedValueOnce('ok');

    const onRetry = vi.fn();
    const result = await withTtsRetry(fn, {
      maxAttempts: 4,
      backoffsMs: [5, 5],
      onRetry,
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(4);
    expect(onRetry).toHaveBeenCalledTimes(3);
  });
});
