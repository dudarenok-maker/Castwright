/* #3967 — readWithRetry on its own: the callers' tests only reach it through a screen,
   where their timer cleanup masks what the helper itself must do. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attemptBoundMs, readWithRetry, retryDelayMs } from './book-read';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/* A read that never answers; records when it was issued and when its signal aborted. */
function hangingRead() {
  const issuedAt: number[] = [];
  const abortedAfter: number[] = [];
  const read = vi.fn((signal: AbortSignal) => {
    const t0 = Date.now();
    issuedAt.push(t0);
    signal.addEventListener('abort', () => abortedAfter.push(Date.now() - t0));
    return new Promise<never>(() => {});
  });
  return { read, issuedAt, abortedAfter };
}

describe('attemptBoundMs', () => {
  it('grows 15, 30, 60 s and stays at 60 s', () => {
    expect([0, 1, 2, 3, 9].map(attemptBoundMs)).toEqual([15000, 30000, 60000, 60000, 60000]);
  });
});

describe('readWithRetry', () => {
  it('returns the first answer without a second read', async () => {
    const read = vi.fn(() => Promise.resolve('ok'));
    const out = await readWithRetry(read, new AbortController().signal, new Set());
    expect(out).toBe('ok');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('aborts the first attempt at 15 s, not before', async () => {
    const { read, abortedAfter } = hangingRead();
    void readWithRetry(read, new AbortController().signal, new Set()).catch(() => {});
    await vi.advanceTimersByTimeAsync(14999);
    expect(abortedAfter).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(abortedAfter).toEqual([15000]);
  });

  it('lands a read that takes 16 s on every attempt', async () => {
    const read = vi.fn(
      (signal: AbortSignal) =>
        new Promise<string>((resolve, reject) => {
          const t = setTimeout(() => resolve('late'), 16000);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const p = readWithRetry(read, new AbortController().signal, new Set());
    await vi.advanceTimersByTimeAsync(300000);
    await expect(p).resolves.toBe('late');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('grows the bound per attempt (15, 30, 60, 60 s)', async () => {
    const { read, abortedAfter } = hangingRead();
    void readWithRetry(read, new AbortController().signal, new Set()).catch(() => {});
    await vi.advanceTimersByTimeAsync(400000);
    expect(abortedAfter.slice(0, 4)).toEqual([15000, 30000, 60000, 60000]);
  });

  it('retries on the hydrate backoff, not a constant delay', async () => {
    const { read, issuedAt } = hangingRead();
    void readWithRetry(read, new AbortController().signal, new Set()).catch(() => {});
    await vi.advanceTimersByTimeAsync(400000);
    const t0 = issuedAt[0]!;
    let expected = 0;
    const want = [0];
    for (let n = 0; n < 3; n++) {
      expected += attemptBoundMs(n) + retryDelayMs(n);
      want.push(expected);
    }
    expect(issuedAt.slice(0, 4).map((t) => t - t0)).toEqual(want);
  });

  it('calls onExpire with the attempt index on each expiry', async () => {
    const { read } = hangingRead();
    const onExpire = vi.fn();
    void readWithRetry(read, new AbortController().signal, new Set(), onExpire).catch(() => {});
    await vi.advanceTimersByTimeAsync(60000);
    expect(onExpire.mock.calls.map((c) => c[0])).toEqual([0, 1]);
  });

  it('passes a non-timeout rejection through unretried', async () => {
    const read = vi.fn(() => Promise.reject(new Error('boom')));
    await expect(readWithRetry(read, new AbortController().signal, new Set())).rejects.toThrow('boom');
    await vi.advanceTimersByTimeAsync(100000);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('rejects with AbortError and never reads when the signal is already aborted', async () => {
    const read = vi.fn(() => new Promise<never>(() => {}));
    const outer = new AbortController();
    outer.abort();
    await expect(readWithRetry(read, outer.signal, new Set())).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });

  it('aborting while a retry is pending cancels the retry (no further read) even if the caller never clears its timers', async () => {
    const { read } = hangingRead();
    const outer = new AbortController();
    const p = readWithRetry(read, outer.signal, new Set());
    const settled = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(16000); // first attempt expired, retry pending
    expect(read).toHaveBeenCalledTimes(1);
    outer.abort();
    await vi.advanceTimersByTimeAsync(300000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await settled).toMatchObject({ name: 'AbortError' });
  });

  it('aborting an in-flight read aborts its request and neither retries nor reports an expiry', async () => {
    /* A read that ignores its signal, so only the helper's own guard stops the expiry from retrying. */
    const read = vi.fn(() => new Promise<never>(() => {}));
    const onExpire = vi.fn();
    const outer = new AbortController();
    const p = readWithRetry(read, outer.signal, new Set(), onExpire);
    const settled = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(5000);
    outer.abort();
    await vi.advanceTimersByTimeAsync(300000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(onExpire).not.toHaveBeenCalled();
    expect(await settled).toMatchObject({ name: 'AbortError' });
  });
});
