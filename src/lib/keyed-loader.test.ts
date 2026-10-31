import { describe, expect, it, vi } from 'vitest';
import { createKeyedLoader } from './keyed-loader';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createKeyedLoader (#3991)', () => {
  it('gives both concurrent callers the value after one read', async () => {
    const d = deferred<string[]>();
    const fetchOne = vi.fn(() => d.promise);
    const loader = createKeyedLoader(fetchOne);
    const first = loader.load('b1');
    const waiter = loader.load('b1');
    d.resolve(['cast']);
    expect(await first).toEqual(['cast']);
    expect(await waiter).toEqual(['cast']);
    expect(fetchOne).toHaveBeenCalledTimes(1);
  });

  it('gives both callers null when the read fails', async () => {
    const d = deferred<string[]>();
    const fetchOne = vi.fn(() => d.promise);
    const loader = createKeyedLoader(fetchOne);
    const first = loader.load('b1');
    const waiter = loader.load('b1');
    d.reject(new Error('network down'));
    expect(await first).toBeNull();
    expect(await waiter).toBeNull();
    expect(fetchOne).toHaveBeenCalledTimes(1);
  });

  it('treats a null result as a failure for both callers', async () => {
    const d = deferred<string[] | null>();
    const loader = createKeyedLoader(() => d.promise);
    const first = loader.load('b1');
    const waiter = loader.load('b1');
    d.resolve(null);
    expect(await first).toBeNull();
    expect(await waiter).toBeNull();
  });

  it('sends one read per key, independently', async () => {
    const fetchOne = vi.fn((key: string) => Promise.resolve([key]));
    const loader = createKeyedLoader(fetchOne);
    const [a1, a2, b] = await Promise.all([loader.load('a'), loader.load('a'), loader.load('b')]);
    expect(a1).toEqual(['a']);
    expect(a2).toEqual(['a']);
    expect(b).toEqual(['b']);
    expect(fetchOne).toHaveBeenCalledTimes(2);
  });

  it('serves a landed value without another read', async () => {
    const fetchOne = vi.fn(() => Promise.resolve(['cast']));
    const loader = createKeyedLoader(fetchOne);
    await loader.load('b1');
    expect(await loader.load('b1')).toEqual(['cast']);
    expect(fetchOne).toHaveBeenCalledTimes(1);
  });

  it('keeps a failure sticky: a retry after it sends no new read', async () => {
    const fetchOne = vi.fn(() => Promise.reject(new Error('boom')));
    const loader = createKeyedLoader(fetchOne);
    expect(await loader.load('b1')).toBeNull();
    expect(await loader.load('b1')).toBeNull();
    expect(fetchOne).toHaveBeenCalledTimes(1);
  });
});
