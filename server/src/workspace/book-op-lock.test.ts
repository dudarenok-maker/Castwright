/* #3711 — unit tests for the per-book operation lock (`withBookOp` & friends)
   and the handle-gated folder movers. See docs/features/288-book-op-lock.md.

   WORKSPACE_DIR is pointed at a tempdir BEFORE the modules load (paths.ts caches
   it at import), and real book folders are seeded under BOOKS_ROOT. */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, renameSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ManuscriptRecord } from '../store/manuscripts.js';

/* Fault injection for the movers' error mapping. Pass-through unless a test
   arms one of these. */
const faults = vi.hoisted(() => ({
  renameError: null as null | NodeJS.ErrnoException,
  rmAfterStateGoneError: null as null | NodeJS.ErrnoException,
  rmError: null as null | NodeJS.ErrnoException,
  /* One-shot: the next `readStateJsonWithRecovery(path)` for `path` finishes its
     read, signals `reached`, then parks until `release` resolves. */
  readGate: null as null | { path: string; reached: () => void; release: Promise<void> },
}));
vi.mock('./state-migrate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./state-migrate.js')>();
  return {
    ...actual,
    readStateJsonWithRecovery: async (p: string) => {
      const out = await actual.readStateJsonWithRecovery(p);
      const gate = faults.readGate;
      if (gate && gate.path === p) {
        faults.readGate = null;
        gate.reached();
        await gate.release;
      }
      return out;
    },
  };
});
vi.mock('./atomic-rename.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./atomic-rename.js')>();
  return {
    ...actual,
    renameWithRetry: async (src: string, dest: string) => {
      if (faults.renameError) throw faults.renameError;
      return actual.renameWithRetry(src, dest);
    },
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: async (p: string, opts?: unknown) => {
      if (faults.rmError) throw faults.rmError;
      if (faults.rmAfterStateGoneError) {
        await actual.unlink(`${p}/.audiobook/state.json`).catch(() => undefined);
        throw faults.rmAfterStateGoneError;
      }
      return actual.rm(p, opts as never);
    },
  };
});

let workspaceRoot: string;
let lock: typeof import('./book-op-lock.js');
let paths: typeof import('./paths.js');
let fileLock: typeof import('./file-lock.js');
let store: typeof import('../store/manuscripts.js');
let scan: typeof import('./scan.js');

function seedBook(
  author: string,
  series: string,
  title: string,
  opts: { bookId?: string | null; manuscriptId?: string; dirName?: string; chapters?: unknown[] } = {},
): { bookId: string; bookDir: string } {
  const bookId = opts.bookId === undefined ? paths.makeBookId(author, series, title) : opts.bookId;
  const bookDir = join(paths.BOOKS_ROOT, author, series, opts.dirName ?? title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      ...(bookId ? { bookId } : {}),
      manuscriptId: opts.manuscriptId ?? `ms-${bookId ?? title}`,
      title,
      author,
      series,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: false,
      chapters: opts.chapters ?? [],
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    }),
  );
  return { bookId: bookId ?? '', bookDir };
}

function record(manuscriptId: string, bookId: string | undefined, bookDir: string): ManuscriptRecord {
  return {
    manuscriptId,
    format: 'plaintext',
    title: 'T',
    wordCount: 1,
    byteSize: 1,
    uploadedAt: '2020-01-01T00:00:00.000Z',
    sourceText: 'x',
    chapterHints: [{ id: 1, title: 'C', body: 'x' }],
    bookId,
    bookDir,
  };
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

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-book-op-lock-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  [lock, paths, fileLock, store, scan] = await Promise.all([
    import('./book-op-lock.js'),
    import('./paths.js'),
    import('./file-lock.js'),
    import('../store/manuscripts.js'),
    import('./scan.js'),
  ]);
});

afterEach(() => {
  faults.renameError = null;
  faults.rmAfterStateGoneError = null;
  faults.rmError = null;
  faults.readGate = null;
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('withBookOp', () => {
  it('serialises same-book callers FIFO', async () => {
    const { bookId } = seedBook('A', 'S', 'Fifo');
    const gate = deferred();
    const order: string[] = [];
    const first = lock.withBookOp(bookId, async () => {
      order.push('first-start');
      await gate.promise;
      order.push('first-end');
    });
    await until(() => order.includes('first-start'));
    const second = lock.withBookOp(bookId, async () => {
      order.push('second');
    });
    const third = lock.withBookOp(bookId, async () => {
      order.push('third');
    });
    await until(() => fileLock.__keyWaitersForTest(`book-op:${bookId}`) === 2);
    expect(order).toEqual(['first-start']);
    gate.resolve();
    await Promise.all([first, second, third]);
    expect(order).toEqual(['first-start', 'first-end', 'second', 'third']);
  });

  it('hands fn a live handle { bookId, bookDir, state, held:true } and releases it after', async () => {
    const { bookId, bookDir } = seedBook('A', 'S', 'Handle');
    let captured: import('./book-op-lock.js').BookHandle | undefined;
    const out = await lock.withBookOp(bookId, async (b) => {
      captured = b;
      expect(b.held).toBe(true);
      expect(b.bookId).toBe(bookId);
      expect(b.bookDir).toBe(bookDir);
      expect(b.state.bookId).toBe(bookId);
      return 42;
    });
    expect(out).toBe(42);
    expect(captured?.held).toBe(false);
  });

  it('releases the handle (and the lock) when fn throws', async () => {
    const { bookId } = seedBook('A', 'S', 'Throws');
    let captured: import('./book-op-lock.js').BookHandle | undefined;
    await expect(
      lock.withBookOp(bookId, async (b) => {
        captured = b;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(captured?.held).toBe(false);
    expect(await lock.withBookOp(bookId, async () => 'ok')).toBe('ok');
  });

  it('a waiter queued behind a move continues on the NEW bookDir', async () => {
    const { bookId, bookDir } = seedBook('A', 'S', 'Before');
    const newDir = join(paths.BOOKS_ROOT, 'A', 'S', 'After');
    const gate = deferred();
    let started = false;
    const mover = lock.withBookOp(bookId, async (b) => {
      started = true;
      await gate.promise;
      await lock.moveBookFolder(b, newDir, (fresh) => ({ ...fresh, title: 'After' }));
    });
    await until(() => started);
    let waiterDir = '';
    const waiter = lock.withBookOp(bookId, async (b) => {
      waiterDir = b.bookDir;
    });
    await until(() => fileLock.__keyWaitersForTest(`book-op:${bookId}`) === 1);
    gate.resolve();
    await Promise.all([mover, waiter]);
    expect(waiterDir).toBe(newDir);
    expect(existsSync(bookDir)).toBe(false);
  });

  it('returns BOOK_GONE after a delete and never calls fn', async () => {
    const { bookId } = seedBook('A', 'S', 'Doomed');
    const gate = deferred();
    let started = false;
    const deleter = lock.withBookOp(bookId, async (b) => {
      started = true;
      await gate.promise;
      await lock.removeBookFolder(b);
    });
    await until(() => started);
    const fn = vi.fn(async () => 'ran');
    const waiter = lock.withBookOp(bookId, fn);
    await until(() => fileLock.__keyWaitersForTest(`book-op:${bookId}`) === 1);
    gate.resolve();
    await deleter;
    expect(await waiter).toBe(lock.BOOK_GONE);
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns BOOK_GONE for an id that never existed', async () => {
    const fn = vi.fn(async () => 'ran');
    expect(await lock.withBookOp('nobody__standalones__nothing', fn)).toBe(lock.BOOK_GONE);
    expect(fn).not.toHaveBeenCalled();
  });

  it('a timeout is curated: contention sentence, code kept, no key/path in the message', async () => {
    const { bookId, bookDir } = seedBook('A', 'S', 'Timeout');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gate = deferred();
    let started = false;
    const holder = lock.withBookOp(bookId, async () => {
      started = true;
      await gate.promise;
    });
    await until(() => started);
    const err = await lock
      .withBookOp(bookId, async () => 'never', { timeoutMs: 30 })
      .catch((e: unknown) => e as NodeJS.ErrnoException);
    expect((err as Error).message).toBe(fileLock.LOCK_CONTENTION_REQUEST_ERROR);
    expect((err as NodeJS.ErrnoException).code).toBe(fileLock.LOCK_ACQUISITION_TIMEOUT_CODE);
    expect(fileLock.isLockAcquisitionTimeout(err)).toBe(true);
    expect((err as Error).message).not.toContain(bookDir);
    expect((err as Error).message).not.toContain(bookId);
    expect(warn).toHaveBeenCalled(); // the raw error (with the key) goes to the log
    gate.resolve();
    await holder;
  });

  it('does not nest: a second withBookOp on the same id from inside fn times out (re-entry is the caller bug)', async () => {
    const { bookId } = seedBook('A', 'S', 'Nested');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const inner = await lock.withBookOp(bookId, async () =>
      lock.withBookOp(bookId, async () => 'inner', { timeoutMs: 30 }).catch((e: unknown) => e),
    );
    expect(fileLock.isLockAcquisitionTimeout(inner)).toBe(true);
  });
});

const BACKFILL_CHAPTER = { id: 1, title: 'One', slug: '01-one', duration: '0:00', uuid: 'u-1' };

function seedSegments(bookDir: string): void {
  mkdirSync(join(bookDir, 'audio'), { recursive: true });
  writeFileSync(
    join(bookDir, 'audio', '01-one.segments.json'),
    JSON.stringify({ durationSec: 5, modelKey: 'kokoro-test', synthesizedAt: '2021-01-01T00:00:00.000Z' }),
  );
}

describe('resolveBook (via withBookOp / peekBook)', () => {
  it('applies the same lazy audioModelKey backfill findBookBy applies (handle state is upgraded, and persisted)', async () => {
    const { bookId, bookDir } = seedBook('A', 'S', 'Backfill', { chapters: [BACKFILL_CHAPTER] });
    seedSegments(bookDir);
    const seen = await lock.withBookOp(bookId, async (b) => b.state.chapters[0]);
    expect(seen).toMatchObject({ audioModelKey: 'kokoro-test', audioRenderedAt: '2021-01-01T00:00:00.000Z' });
    const onDisk = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(onDisk.chapters[0].audioModelKey).toBe('kokoro-test');
    // control: findBookBy's own backfill agrees on the result
    const viaScan = await scan.findBookByBookId(bookId);
    expect(viaScan?.state.chapters[0].audioModelKey).toBe('kokoro-test');
  });

  it('a hintDir carrying a DIFFERENT bookId is rejected and the resolve falls back', async () => {
    const real = seedBook('A', 'S', 'Real');
    const other = seedBook('A', 'S', 'Other');
    const got = await lock.withBookOp(real.bookId, async (b) => b.bookDir, { hintDir: other.bookDir });
    expect(got).toBe(real.bookDir);
  });

  it('a correct hintDir is used', async () => {
    const real = seedBook('A', 'S', 'Hinted');
    const got = await lock.withBookOp(real.bookId, async (b) => b.bookDir, { hintDir: real.bookDir });
    expect(got).toBe(real.bookDir);
  });

  it('a stale index entry (folder moved out of process) falls back to the walk and re-seeds', async () => {
    const { bookId, bookDir } = seedBook('A', 'S', 'Stale');
    await lock.withBookOp(bookId, async () => undefined); // seeds the index
    expect(lock.__bookDirIndexForTest().get(bookId)).toBe(bookDir);
    const moved = join(paths.BOOKS_ROOT, 'A', 'S', 'Stale-moved');
    renameSync(bookDir, moved);
    const got = await lock.withBookOp(bookId, async (b) => b.bookDir);
    expect(got).toBe(moved);
    expect(lock.__bookDirIndexForTest().get(bookId)).toBe(moved);
  });

  it('a folder without a bookId in state.json never resolves', async () => {
    seedBook('A', 'S', 'NoId', { bookId: null });
    expect(await lock.peekBook(paths.makeBookId('A', 'S', 'NoId'))).toBeNull();
  });

  it('duplicate bookIds: resolves to the same first match as findBookByBookId and warns naming both paths', async () => {
    const id = 'dup__standalones__twin';
    const a = seedBook('Dup', 'S', 'Twin1', { bookId: id, manuscriptId: 'ms-dup-1' });
    const b = seedBook('Dup', 'S', 'Twin2', { bookId: id, manuscriptId: 'ms-dup-2' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const expected = await scan.findBookByBookId(id);
    const got = await lock.peekBook(id);
    expect(got?.bookDir).toBe(expected?.bookDir);
    expect([a.bookDir, b.bookDir]).toContain(got?.bookDir);
    const text = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(text).toContain(a.bookDir);
    expect(text).toContain(b.bookDir);
  });

  it('heals the live ManuscriptRecord when its bookId matches', async () => {
    const { bookId, bookDir } = seedBook('A', 'S', 'Heal', { manuscriptId: 'ms-heal' });
    store.putManuscript(record('ms-heal', bookId, join(paths.BOOKS_ROOT, 'A', 'S', 'Elsewhere')));
    await lock.withBookOp(bookId, async () => undefined);
    expect(store.getManuscript('ms-heal')?.bookDir).toBe(bookDir);
  });

  it('skips the record heal when rec.bookId !== bookId (twin sharing a manuscriptId)', async () => {
    const { bookId } = seedBook('A', 'S', 'TwinHeal', { manuscriptId: 'ms-shared' });
    const stale = join(paths.BOOKS_ROOT, 'A', 'S', 'SomeoneElses');
    store.putManuscript(record('ms-shared', 'a__s__other-twin', stale));
    await lock.withBookOp(bookId, async () => undefined);
    expect(store.getManuscript('ms-shared')?.bookDir).toBe(stale);
  });
});

describe('peekBook', () => {
  it('takes no lock: resolves while book-op is held and never queues', async () => {
    const { bookId, bookDir } = seedBook('A', 'S', 'Peek');
    const gate = deferred();
    let started = false;
    const holder = lock.withBookOp(bookId, async () => {
      started = true;
      await gate.promise;
    });
    await until(() => started);
    const peeked = await lock.peekBook(bookId);
    expect(peeked?.bookDir).toBe(bookDir);
    expect(peeked?.state.bookId).toBe(bookId);
    expect(fileLock.__keyWaitersForTest(`book-op:${bookId}`)).toBe(0);
    gate.resolve();
    await holder;
  });

  it('returns null for a missing book', async () => {
    expect(await lock.peekBook('ghost__standalones__ghost')).toBeNull();
  });

  it('writes nothing: a peek that read the OLD dir does not write it back into the record or the index after a move', async () => {
    const { bookId, bookDir } = seedBook('A', 'S', 'PeekRace', { manuscriptId: 'ms-peek-race' });
    store.putManuscript(record('ms-peek-race', bookId, bookDir));
    await lock.withBookOp(bookId, async () => undefined); // seeds the index at the OLD dir
    const newDir = join(paths.BOOKS_ROOT, 'A', 'S', 'PeekRaceMoved');
    const reached = deferred();
    const release = deferred();
    faults.readGate = {
      path: join(bookDir, '.audiobook', 'state.json'),
      reached: reached.resolve,
      release: release.promise,
    };
    const peeking = lock.peekBook(bookId); // reads the old dir, then parks
    await reached.promise;
    await lock.withBookOp(bookId, async (b) => {
      await lock.moveBookFolder(b, newDir, (f) => f);
    });
    expect(store.getManuscript('ms-peek-race')?.bookDir).toBe(newDir);
    expect(lock.__bookDirIndexForTest().get(bookId)).toBe(newDir);
    release.resolve();
    await peeking;
    expect(store.getManuscript('ms-peek-race')?.bookDir).toBe(newDir);
    expect(lock.__bookDirIndexForTest().get(bookId)).toBe(newDir);
  });

  it('does not backfill (no write): a peek leaves state.json byte-identical', async () => {
    const { bookId, bookDir } = seedBook('A', 'S', 'PeekNoBackfill', { chapters: [BACKFILL_CHAPTER] });
    seedSegments(bookDir);
    const before = readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8');
    const peeked = await lock.peekBook(bookId);
    expect(peeked?.state.chapters[0].audioModelKey).toBeUndefined();
    expect(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8')).toBe(before);
  });
});

describe('withBookOps', () => {
  it('dedupes and sorts the ids, handing fn the books in sorted order', async () => {
    const b = seedBook('A', 'S', 'Bravo');
    const a = seedBook('A', 'S', 'Alpha');
    const seen: string[] = [];
    const out = await lock.withBookOps([b.bookId, a.bookId, b.bookId], async (books) => {
      for (const x of books) seen.push(x.bookId);
      expect(books.every((x) => x.held)).toBe(true);
      return 'done';
    });
    expect(out).toBe('done');
    expect(seen).toEqual([a.bookId, b.bookId].sort());
  });

  it('AB and BA callers cannot deadlock (sorted acquisition)', async () => {
    const a = seedBook('A', 'S', 'Ab1');
    const b = seedBook('A', 'S', 'Ab2');
    await Promise.all([
      lock.withBookOps([a.bookId, b.bookId], async () => {
        await new Promise((r) => setTimeout(r, 20));
      }),
      lock.withBookOps([b.bookId, a.bookId], async () => {
        await new Promise((r) => setTimeout(r, 20));
      }),
    ]);
  });

  it('rejects an empty list', async () => {
    await expect(lock.withBookOps([], async () => 1)).rejects.toThrow(/no bookIds/);
  });

  it('returns BOOK_GONE if any book is gone and does not call fn', async () => {
    const a = seedBook('A', 'S', 'Present');
    const fn = vi.fn(async () => 1);
    expect(await lock.withBookOps([a.bookId, 'ghost__standalones__ghost2'], fn)).toBe(lock.BOOK_GONE);
    expect(fn).not.toHaveBeenCalled();
    // the lock on the present book was released
    expect(await lock.withBookOp(a.bookId, async () => 'ok')).toBe('ok');
  });

  it('releases every handle after fn', async () => {
    const a = seedBook('A', 'S', 'Rel1');
    const b = seedBook('A', 'S', 'Rel2');
    let handles: import('./book-op-lock.js').BookHandle[] = [];
    await lock.withBookOps([a.bookId, b.bookId], async (books) => {
      handles = books;
    });
    expect(handles.map((h) => h.held)).toEqual([false, false]);
  });

  it('a timeout is curated and keeps the code', async () => {
    const a = seedBook('A', 'S', 'Slow1');
    const b = seedBook('A', 'S', 'Slow2');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gate = deferred();
    let started = false;
    const holder = lock.withBookOp(b.bookId, async () => {
      started = true;
      await gate.promise;
    });
    await until(() => started);
    const err = await lock
      .withBookOps([a.bookId, b.bookId], async () => 1, { timeoutMs: 30 })
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe(fileLock.LOCK_CONTENTION_REQUEST_ERROR);
    expect(fileLock.isLockAcquisitionTimeout(err)).toBe(true);
    gate.resolve();
    await holder;
  });
});

describe('sanctioned movers', () => {
  it('moveBookFolder renames, writes buildNext(fresh) at the new path, heals record + index, prunes empty old parents', async () => {
    const { bookId, bookDir } = seedBook('MoveA', 'MoveS', 'Old', { manuscriptId: 'ms-move' });
    store.putManuscript(record('ms-move', bookId, bookDir));
    const newDir = join(paths.BOOKS_ROOT, 'MoveA2', 'MoveS2', 'New');
    let sawFresh = '';
    await lock.withBookOp(bookId, async (b) => {
      await lock.moveBookFolder(b, newDir, (fresh) => {
        sawFresh = fresh.title;
        return { ...fresh, title: 'New', author: 'MoveA2', series: 'MoveS2' };
      });
    });
    expect(sawFresh).toBe('Old');
    expect(existsSync(bookDir)).toBe(false);
    expect(existsSync(join(paths.BOOKS_ROOT, 'MoveA'))).toBe(false); // empty parents pruned
    const written = JSON.parse(readFileSync(join(newDir, '.audiobook', 'state.json'), 'utf8'));
    expect(written.title).toBe('New');
    expect(written.bookId).toBe(bookId);
    expect(store.getManuscript('ms-move')?.bookDir).toBe(newDir);
    expect(lock.__bookDirIndexForTest().get(bookId)).toBe(newDir);
  });

  it('moveBookFolder refuses with BookPathTakenError when newDir exists, leaving the book in place', async () => {
    const { bookId, bookDir } = seedBook('A', 'S', 'Mover');
    const taken = seedBook('A', 'S', 'Taken');
    await lock.withBookOp(bookId, async (b) => {
      await expect(lock.moveBookFolder(b, taken.bookDir, (f) => f)).rejects.toBeInstanceOf(
        lock.BookPathTakenError,
      );
    });
    expect(existsSync(bookDir)).toBe(true);
  });

  it('moveBookFolder maps EPERM from the rename to BookFolderInUseError (no path in the message), state untouched', async () => {
    const { bookId, bookDir } = seedBook('A', 'S', 'Locked');
    faults.renameError = Object.assign(new Error(`EPERM: operation not permitted, rename '${bookDir}'`), {
      code: 'EPERM',
    });
    const newDir = join(paths.BOOKS_ROOT, 'A', 'S', 'Locked2');
    await lock.withBookOp(bookId, async (b) => {
      const err = await lock.moveBookFolder(b, newDir, (f) => f).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(lock.BookFolderInUseError);
      expect((err as Error).message).not.toContain(bookDir);
    });
    expect(existsSync(join(bookDir, '.audiobook', 'state.json'))).toBe(true);
  });

  it('removeBookFolder deletes the folder and the index entry; the book is then gone', async () => {
    const { bookId, bookDir } = seedBook('A', 'S', 'Remove');
    await lock.withBookOp(bookId, async (b) => {
      await lock.removeBookFolder(b);
    });
    expect(existsSync(bookDir)).toBe(false);
    expect(lock.__bookDirIndexForTest().has(bookId)).toBe(false);
    expect(await lock.withBookOp(bookId, async () => 1)).toBe(lock.BOOK_GONE);
  });

  it('removeBookFolder maps EPERM with state.json still present to BookFolderInUseError', async () => {
    const { bookId, bookDir } = seedBook('A', 'S', 'RemoveLocked');
    faults.rmError = Object.assign(new Error(`EPERM: ${bookDir}`), { code: 'EPERM' });
    await lock.withBookOp(bookId, async (b) => {
      const err = await lock.removeBookFolder(b).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(lock.BookFolderInUseError);
      expect((err as Error).message).not.toContain(bookDir);
    });
    expect(existsSync(join(bookDir, '.audiobook', 'state.json'))).toBe(true);
  });

  it('removeBookFolder: an rm failing AFTER state.json is gone is BookPartlyDeletedError (and drops the index)', async () => {
    const { bookId, bookDir } = seedBook('A', 'S', 'Partly');
    await lock.withBookOp(bookId, async () => undefined); // seed index
    faults.rmAfterStateGoneError = Object.assign(new Error(`EBUSY: ${bookDir}`), { code: 'EBUSY' });
    await lock.withBookOp(bookId, async (b) => {
      const err = await lock.removeBookFolder(b).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(lock.BookPartlyDeletedError);
      expect((err as Error).message).not.toContain(bookDir);
    });
    expect(lock.__bookDirIndexForTest().has(bookId)).toBe(false);
    expect(await lock.peekBook(bookId)).toBeNull();
  });

  it('moveBookFolder refuses a newDir outside the books root (and leaves the book in place)', async () => {
    const { bookId, bookDir } = seedBook('A', 'S', 'Contained');
    await lock.withBookOp(bookId, async (b) => {
      for (const bad of [
        join(workspaceRoot, 'outside'),
        join(paths.BOOKS_ROOT, '..', 'escaped'),
        paths.BOOKS_ROOT,
      ]) {
        await expect(lock.moveBookFolder(b, bad, (f) => f)).rejects.toThrow(/not under the books root/);
      }
    });
    expect(existsSync(bookDir)).toBe(true);
    expect(existsSync(join(workspaceRoot, 'outside'))).toBe(false);
  });

  it('removeBookFolder: state.json absent at the handle dir after queueing (out-of-process move) deletes the MOVED book', async () => {
    const { bookId, bookDir } = seedBook('A', 'S', 'OopMoved');
    const moved = join(paths.BOOKS_ROOT, 'A', 'S', 'OopMoved-elsewhere');
    const statePath = join(bookDir, '.audiobook', 'state.json');
    let out: unknown;
    let removal!: Promise<unknown>;
    await fileLock.withStateJsonLock(statePath, async () => {
      removal = lock.withBookOp(bookId, async (b) => {
        out = await lock.removeBookFolder(b);
      });
      await until(() => fileLock.__stateJsonWaitersForTest(statePath) === 1);
      renameSync(bookDir, moved);
    });
    await removal;
    expect(out).toBe('removed');
    expect(existsSync(moved)).toBe(false);
    expect(existsSync(bookDir)).toBe(false);
  });

  it('removeBookFolder: state.json absent and the book nowhere (out-of-process delete) resolves "gone" and recreates nothing', async () => {
    const { bookId, bookDir } = seedBook('A', 'S', 'OopGone');
    const statePath = join(bookDir, '.audiobook', 'state.json');
    let out: unknown;
    let removal!: Promise<unknown>;
    await fileLock.withStateJsonLock(statePath, async () => {
      removal = lock.withBookOp(bookId, async (b) => {
        out = await lock.removeBookFolder(b);
      });
      await until(() => fileLock.__stateJsonWaitersForTest(statePath) === 1);
      rmSync(bookDir, { recursive: true, force: true });
    });
    await removal;
    expect(out).toBe('gone');
    expect(existsSync(bookDir)).toBe(false);
  });

  it('a spread copy of a live handle (held:true) and a hand-built {held:true} object are refused by both movers', async () => {
    const { bookId, bookDir } = seedBook('A', 'S', 'Unforgeable');
    await lock.withBookOp(bookId, async (b) => {
      const copy = { ...b };
      const forged = { bookId, bookDir: b.bookDir, state: b.state, held: true };
      for (const h of [copy, forged]) {
        expect(h.held).toBe(true);
        await expect(lock.moveBookFolder(h, join(paths.BOOKS_ROOT, 'A', 'S', 'Nope2'), (f) => f)).rejects.toThrow(
          /not held/,
        );
        await expect(lock.removeBookFolder(h)).rejects.toThrow(/not held/);
      }
      // the genuine handle still works
      await lock.moveBookFolder(b, join(paths.BOOKS_ROOT, 'A', 'S', 'Unforgeable2'), (f) => f);
    });
    expect(existsSync(bookDir)).toBe(false);
  });

  it('a RELEASED handle makes both movers throw', async () => {
    const { bookId } = seedBook('A', 'S', 'Released');
    let captured!: import('./book-op-lock.js').BookHandle;
    await lock.withBookOp(bookId, async (b) => {
      captured = b;
    });
    await expect(
      lock.moveBookFolder(captured, join(paths.BOOKS_ROOT, 'A', 'S', 'Nope'), (f) => f),
    ).rejects.toThrow(/not held/);
    await expect(lock.removeBookFolder(captured)).rejects.toThrow(/not held/);
    expect(existsSync(captured.bookDir)).toBe(true);
  });

  it('a handle forged from a peek (held:false) cannot move or remove', async () => {
    const { bookId } = seedBook('A', 'S', 'Forged');
    const peeked = await lock.peekBook(bookId);
    const forged = { bookId, bookDir: peeked!.bookDir, state: peeked!.state, held: false };
    await expect(lock.removeBookFolder(forged)).rejects.toThrow(/not held/);
  });

  it('refuses with BookBusyError(kinds) while a job is registered for the book (both movers)', async () => {
    const { bookId, bookDir } = seedBook('A', 'S', 'Busy');
    const release = lock.__addBookJobToken(bookId, 'render');
    await lock.withBookOp(bookId, async (b) => {
      const e1 = await lock.moveBookFolder(b, join(paths.BOOKS_ROOT, 'A', 'S', 'Busy2'), (f) => f).catch((e: unknown) => e);
      expect(e1).toBeInstanceOf(lock.BookBusyError);
      expect((e1 as import('./book-op-lock.js').BookBusyError).kinds).toEqual(['render']);
      const e2 = await lock.removeBookFolder(b).catch((e: unknown) => e);
      expect(e2).toBeInstanceOf(lock.BookBusyError);
    });
    expect(existsSync(bookDir)).toBe(true);
    release();
  });
});

describe('withBookPathClaim', () => {
  it('serialises claim holders workspace-wide', async () => {
    const gate = deferred();
    const order: string[] = [];
    const first = lock.withBookPathClaim(async () => {
      order.push('first');
      await gate.promise;
    });
    await until(() => order.length === 1);
    const second = lock.withBookPathClaim(async () => {
      order.push('second');
    });
    await until(() => fileLock.__keyWaitersForTest('book-path-claim') === 1);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('a timeout is curated: contention sentence, code kept, no key in the message', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gate = deferred();
    let started = false;
    const holder = lock.withBookPathClaim(async () => {
      started = true;
      await gate.promise;
    });
    await until(() => started);
    const err = await lock.withBookPathClaim(async () => 'never', 30).catch((e: unknown) => e);
    expect((err as Error).message).toBe(fileLock.LOCK_CONTENTION_REQUEST_ERROR);
    expect((err as NodeJS.ErrnoException).code).toBe(fileLock.LOCK_ACQUISITION_TIMEOUT_CODE);
    expect(fileLock.isLockAcquisitionTimeout(err)).toBe(true);
    expect((err as Error).message).not.toContain('book-path-claim');
    gate.resolve();
    await holder;
  });
});

describe('mintBookId', () => {
  it('returns makeBookId unchanged when no state.json carries it', async () => {
    expect(await lock.mintBookId('Fresh', '', 'Title')).toBe(paths.makeBookId('Fresh', '', 'Title'));
  });

  it('suffixes -2, -3 … onto the TITLE slug until the id is free (still three parts)', async () => {
    const base = paths.makeBookId('Mint', 'Ser', 'Same');
    seedBook('Mint', 'Ser', 'Same', { bookId: base });
    const second = await lock.mintBookId('Mint', 'Ser', 'Same');
    expect(second).toBe(`${base}-2`);
    seedBook('Mint', 'Ser', 'Same-b', { bookId: second });
    const third = await lock.mintBookId('Mint', 'Ser', 'Same');
    expect(third).toBe(`${base}-3`);
    expect(paths.parseBookId(third)).toEqual({
      authorSlug: 'mint',
      seriesSlug: 'ser',
      titleSlug: 'same-3',
    });
  });
});

describe('isBookIdTaken', () => {
  it('is true only for an id some state.json under books/ carries', async () => {
    const { bookId } = seedBook('Taken', 'Ser', 'Here');
    expect(await lock.isBookIdTaken(bookId)).toBe(true);
    expect(await lock.isBookIdTaken(`${bookId}-nope`)).toBe(false);
  });
});

describe('withBookOpAtDir (startup-sweep step)', () => {
  it('runs fn on the folder the book lives in NOW when a mover relocated it while the step queued', async () => {
    const { bookId, bookDir } = seedBook('Sweep', 'Ser', 'Mover');
    const newDir = join(paths.BOOKS_ROOT, 'Sweep', 'Ser', 'Mover Renamed');
    const seen: string[] = [];
    let stepP!: Promise<unknown>;
    await lock.withBookOp(bookId, async (book) => {
      stepP = lock.withBookOpAtDir(bookDir, async (dir) => {
        seen.push(dir);
      });
      await until(() => fileLock.__keyWaitersForTest(`book-op:${bookId}`) === 1);
      await lock.moveBookFolder(book, newDir, (fresh) => ({ ...fresh, title: 'Mover Renamed' }));
    });
    await stepP;
    expect(seen).toEqual([newDir]);
  });

  it('runs fn unlocked on the walked dir for a book whose state.json carries no bookId', async () => {
    const { bookDir } = seedBook('Sweep', 'Ser', 'No Id', { bookId: null });
    const seen: string[] = [];
    await lock.withBookOpAtDir(bookDir, async (dir) => {
      seen.push(dir);
    });
    expect(seen).toEqual([bookDir]);
  });

  it('skips (BOOK_GONE) a book that vanished while the step queued', async () => {
    const { bookId, bookDir } = seedBook('Sweep', 'Ser', 'Vanishes');
    const fn = vi.fn(async () => 'ran');
    let stepP!: Promise<unknown>;
    await lock.withBookOp(bookId, async (book) => {
      stepP = lock.withBookOpAtDir(bookDir, fn);
      await until(() => fileLock.__keyWaitersForTest(`book-op:${bookId}`) === 1);
      await lock.removeBookFolder(book);
    });
    expect(await stepP).toBe(lock.BOOK_GONE);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('test hooks', () => {
  it('__keyWaitersForTest generalises __stateJsonWaitersForTest', async () => {
    expect(fileLock.__keyWaitersForTest('nobody-holds-this')).toBe(0);
    const gate = deferred();
    let held = false;
    const holder = fileLock.withKeyLock('hook-key', async () => {
      held = true;
      await gate.promise;
    });
    await until(() => held);
    const waiter = fileLock.withKeyLock('hook-key', async () => undefined);
    expect(fileLock.__keyWaitersForTest('hook-key')).toBe(1);
    gate.resolve();
    await Promise.all([holder, waiter]);
    expect(fileLock.__keyWaitersForTest('hook-key')).toBe(0);
  });

  it('__stateJsonWaitersForTest still reads the state-json: key', async () => {
    const gate = deferred();
    let held = false;
    const p = join(workspaceRoot, 'x', 'state.json');
    const holder = fileLock.withStateJsonLock(p, async () => {
      held = true;
      await gate.promise;
    });
    await until(() => held);
    const waiter = fileLock.withStateJsonLock(p, async () => undefined);
    expect(fileLock.__stateJsonWaitersForTest(p)).toBe(1);
    expect(fileLock.__keyWaitersForTest(`state-json:${p}`)).toBe(1);
    gate.resolve();
    await Promise.all([holder, waiter]);
  });
});
