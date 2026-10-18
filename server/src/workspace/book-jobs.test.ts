/* #3711 — unit tests for the long-job busy registry (`runBookJob`).
   See docs/features/288-book-op-lock.md "Busy registry". */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workspaceRoot: string;
let jobs: typeof import('./book-jobs.js');
let lock: typeof import('./book-op-lock.js');
let paths: typeof import('./paths.js');
let fileLock: typeof import('./file-lock.js');

function seedBook(author: string, series: string, title: string): { bookId: string; bookDir: string } {
  const bookId = paths.makeBookId(author, series, title);
  const bookDir = join(paths.BOOKS_ROOT, author, series, title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `ms-${bookId}`,
      title,
      author,
      series,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: false,
      chapters: [],
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    }),
  );
  return { bookId, bookDir };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

/** runBookJob resolves to `{ done }` or BOOK_GONE; narrow for the tests. */
async function start<T>(
  bookId: string,
  kind: import('./book-jobs.js').BookJobKind,
  fn: (lease: import('./book-jobs.js').BookJobLease) => Promise<T>,
  opts?: { hintDir?: string; timeoutMs?: number },
): Promise<{ done: Promise<T> }> {
  const r = await jobs.runBookJob(bookId, kind, fn, opts);
  if (r === lock.BOOK_GONE) throw new Error('unexpected BOOK_GONE');
  return r;
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-book-jobs-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  [jobs, lock, paths, fileLock] = await Promise.all([
    import('./book-jobs.js'),
    import('./book-op-lock.js'),
    import('./paths.js'),
    import('./file-lock.js'),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('runBookJob', () => {
  it('registers the kind for the span of fn, hands fn a lease, and releases after done', async () => {
    const { bookId, bookDir } = seedBook('A', 'S', 'Basic');
    const gate = deferred();
    const fn = vi.fn(async (lease: import('./book-jobs.js').BookJobLease) => {
      expect(lease.bookId).toBe(bookId);
      expect(lease.bookDir).toBe(bookDir);
      expect(lease.state.bookId).toBe(bookId);
      await gate.promise;
      return 'result';
    });
    const { done } = await start(bookId, 'render', fn);
    expect(jobs.bookJobKinds(bookId)).toEqual(['render']);
    expect(fn).toHaveBeenCalledTimes(1);
    gate.resolve();
    expect(await done).toBe('result');
    expect(jobs.bookJobKinds(bookId)).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT hold book-op while the job runs (a quick op proceeds)', async () => {
    const { bookId } = seedBook('A', 'S', 'NoHold');
    const gate = deferred();
    const { done } = await start(bookId, 'scoring', async () => {
      await gate.promise;
    });
    expect(await lock.withBookOp(bookId, async () => 'quick-ran')).toBe('quick-ran');
    gate.resolve();
    await done;
  });

  it('releases when fn throws SYNCHRONOUSLY (non-async fn)', async () => {
    const { bookId } = seedBook('A', 'S', 'SyncThrow');
    const { done } = await start(bookId, 'analysis', ((): Promise<never> => {
      throw new Error('sync boom');
    }) as never);
    await expect(done).rejects.toThrow('sync boom');
    expect(jobs.bookJobKinds(bookId)).toEqual([]);
  });

  it('releases on an early return', async () => {
    const { bookId } = seedBook('A', 'S', 'Early');
    const { done } = await start(bookId, 'design', async () => {
      if (bookId) return 'early';
      await new Promise(() => undefined);
      return 'late';
    });
    expect(await done).toBe('early');
    expect(jobs.bookJobKinds(bookId)).toEqual([]);
  });

  it('releases on a rejection', async () => {
    const { bookId } = seedBook('A', 'S', 'Rejects');
    const { done } = await start(bookId, 'export', async () => {
      throw new Error('async boom');
    });
    await expect(done).rejects.toThrow('async boom');
    expect(jobs.bookJobKinds(bookId)).toEqual([]);
  });

  it('releases on a resolve', async () => {
    const { bookId } = seedBook('A', 'S', 'Resolves');
    const { done } = await start(bookId, 'script-review', async () => 1);
    await done;
    expect(jobs.bookJobKinds(bookId)).toEqual([]);
  });

  it('holds the token until the WHOLE job promise settles, not when fn is first awaited', async () => {
    const { bookId } = seedBook('A', 'S', 'Whole');
    const gate = deferred();
    const { done } = await start(bookId, 'render', async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 15));
      await gate.promise;
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(jobs.bookJobKinds(bookId)).toEqual(['render']);
    gate.resolve();
    await done;
  });

  it('a gone book is never registered and fn is never called', async () => {
    const fn = vi.fn(async () => 'ran');
    const r = await jobs.runBookJob('ghost__standalones__ghost', 'render', fn);
    expect(r).toBe(lock.BOOK_GONE);
    expect(fn).not.toHaveBeenCalled();
    expect(jobs.bookJobKinds('ghost__standalones__ghost')).toEqual([]);
  });

  it('two jobs of the same kind coexist with unique tokens; kinds drops as each settles', async () => {
    const { bookId } = seedBook('A', 'S', 'Coexist');
    const g1 = deferred();
    const g2 = deferred();
    const j1 = await start(bookId, 'render', () => g1.promise);
    const j2 = await start(bookId, 'render', () => g2.promise);
    expect(jobs.bookJobKinds(bookId)).toEqual(['render', 'render']);
    g1.resolve();
    await j1.done;
    expect(jobs.bookJobKinds(bookId)).toEqual(['render']);
    g2.resolve();
    await j2.done;
    expect(jobs.bookJobKinds(bookId)).toEqual([]);
  });

  it('registration happens under book-op: a registration queued behind a move starts on the NEW folder', async () => {
    const { bookId, bookDir } = seedBook('A', 'S', 'RegMove');
    const newDir = join(paths.BOOKS_ROOT, 'A', 'S', 'RegMoved');
    const gate = deferred();
    let started = false;
    const mover = lock.withBookOp(bookId, async (b) => {
      started = true;
      await gate.promise;
      await lock.moveBookFolder(b, newDir, (f) => f);
    });
    await until(() => started);
    let leaseDir = '';
    const registering = start(bookId, 'scoring', async (lease) => {
      leaseDir = lease.bookDir;
    });
    await until(() => fileLock.__keyWaitersForTest(`book-op:${bookId}`) === 1);
    gate.resolve();
    await mover;
    const { done } = await registering;
    await done;
    expect(leaseDir).toBe(newDir);
    expect(leaseDir).not.toBe(bookDir);
  });

  it('a move attempted while a job is registered is refused (BookBusyError names the kind)', async () => {
    const { bookId, bookDir } = seedBook('A', 'S', 'RefuseMove');
    const gate = deferred();
    const { done } = await start(bookId, 'export', () => gate.promise);
    await lock.withBookOp(bookId, async (b) => {
      const err = await lock
        .moveBookFolder(b, join(paths.BOOKS_ROOT, 'A', 'S', 'RefuseMove2'), (f) => f)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(lock.BookBusyError);
      expect((err as import('./book-op-lock.js').BookBusyError).kinds).toEqual(['export']);
    });
    expect(
      await lock.withBookOp(bookId, async (b) => b.bookDir),
    ).toBe(bookDir);
    gate.resolve();
    await done;
  });

  it('a registration timeout is curated and keeps the code; nothing is registered', async () => {
    const { bookId } = seedBook('A', 'S', 'RegTimeout');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gate = deferred();
    let held = false;
    const holder = lock.withBookOp(bookId, async () => {
      held = true;
      await gate.promise;
    });
    await until(() => held);
    const fn = vi.fn(async () => 1);
    const err = await jobs.runBookJob(bookId, 'render', fn, { timeoutMs: 30 }).catch((e: unknown) => e);
    expect((err as Error).message).toBe(fileLock.LOCK_CONTENTION_REQUEST_ERROR);
    expect(fileLock.isLockAcquisitionTimeout(err)).toBe(true);
    expect(fn).not.toHaveBeenCalled();
    expect(jobs.bookJobKinds(bookId)).toEqual([]);
    gate.resolve();
    await holder;
  });

  it('a rejecting job whose caller never touches `done` is NOT an unhandled rejection; an awaiting caller still sees it', async () => {
    const { bookId } = seedBook('A', 'S', 'FireAndForget');
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      const r = await start(bookId, 'render', async () => {
        throw new Error('job blew up');
      });
      // let the microtask/macrotask queues drain: Node raises 'unhandledRejection' after a tick
      for (let i = 0; i < 5; i++) await new Promise((res) => setImmediate(res));
      expect(unhandled).toEqual([]);
      await expect(r.done).rejects.toThrow('job blew up');
      expect(jobs.bookJobKinds(bookId)).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('exports no other registration function', () => {
    expect(Object.keys(jobs).sort()).toEqual(['bookJobKinds', 'runBookJob']);
  });
});
