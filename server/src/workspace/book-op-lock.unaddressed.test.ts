/* #4336 — withBookOpAtDir hands its callback a handle; the unaddressed kind
   (R4-8, R5-7, R6-6) and the take module's refusals (K2-K6, K8). */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

let workspaceRoot: string;
let lock: typeof import('./book-op-lock.js');
let take: typeof import('./chapter-take.js');
let key: typeof import('./book-dir-key.js');
let paths: typeof import('./paths.js');
let seq = 0;

function seedBook(withId: boolean): { bookId: string; bookDir: string } {
  seq += 1;
  const title = `Unaddr ${seq}`;
  const bookId = paths.makeBookId('Una', 'Ser', title);
  const bookDir = join(paths.BOOKS_ROOT, 'Una', 'Ser', title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  mkdirSync(join(bookDir, 'audio'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      ...(withId ? { bookId } : {}),
      manuscriptId: `ms-un-${seq}`,
      title,
      author: 'Una',
      series: 'Ser',
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

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-unaddressed-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  [lock, take, key, paths] = await Promise.all([
    import('./book-op-lock.js'),
    import('./chapter-take.js'),
    import('./book-dir-key.js'),
    import('./paths.js'),
  ]);
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

type Unaddressed = import('./book-op-lock.js').UnaddressedBookHandle;

describe('withBookOpAtDir handles', () => {
  it('K6: a book with a bookId still runs under withBookOp and gets a live BookHandle', async () => {
    const { bookId, bookDir } = seedBook(true);
    const seen = await lock.withBookOpAtDir(bookDir, async (h) => {
      expect('kind' in h).toBe(false);
      expect(h.held).toBe(true);
      expect((h as { bookId: string }).bookId).toBe(bookId);
      lock.assertHeld(h, 'test');
      expect(key.isUnaddressedDir(bookDir)).toBe(false);
      return h.bookDir;
    });
    expect(seen).toBe(bookDir);
  });

  it('K3: a no-bookId book gets an unaddressed handle the take module accepts, then refuses', async () => {
    const { bookDir } = seedBook(false);
    let kept: Unaddressed | undefined;
    await lock.withBookOpAtDir(bookDir, async (h) => {
      expect('kind' in h && h.kind).toBe('unaddressed');
      expect(h.held).toBe(true);
      expect(key.isUnaddressedDir(bookDir)).toBe(true);
      await expect(take.ensureTakeIdentity(h, 'ch-01')).resolves.toBeUndefined();
      kept = h as Unaddressed;
    });
    expect(kept?.held).toBe(false);
    await expect(take.ensureTakeIdentity(kept as Unaddressed, 'ch-01')).rejects.toThrow(/not held/);
  });

  it('K2: an fn that throws leaves the set empty, and the next call registers fine', async () => {
    const { bookDir } = seedBook(false);
    await expect(
      lock.withBookOpAtDir(bookDir, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(key.isUnaddressedDir(bookDir)).toBe(false);
    const fn = vi.fn(async () => 'ran');
    expect(await lock.withBookOpAtDir(bookDir, fn)).toBe('ran');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('K4: a second holder of the same folder (spelled differently) is skipped and logged', async () => {
    const { bookDir } = seedBook(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const inner = vi.fn(async () => 'inner');
    const spelled = `${process.platform === 'win32' ? bookDir.toUpperCase().split(sep).join('/') : bookDir}${sep}`;
    const outer = await lock.withBookOpAtDir(bookDir, async () => lock.withBookOpAtDir(spelled, inner));
    expect(outer).toBe(lock.BOOK_GONE);
    expect(inner).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(key.isUnaddressedDir(bookDir)).toBe(false);
  });
});

describe('the take module refuses what it must', () => {
  it('K5: a BookHandle whose canonical directory is registered throws BookBusyError', async () => {
    const { bookId, bookDir } = seedBook(true);
    await lock.withBookOp(bookId, async (book) => {
      expect(key.registerUnaddressedDir(bookDir)).toBe(true);
      try {
        await expect(take.ensureTakeIdentity(book, 'ch-01')).rejects.toBeInstanceOf(lock.BookBusyError);
      } finally {
        key.releaseUnaddressedDir(bookDir);
      }
      await expect(take.ensureTakeIdentity(book, 'ch-01')).resolves.toBeUndefined();
    });
  });

  it('K8: a hand-built unaddressed handle is refused', async () => {
    const { bookDir } = seedBook(false);
    const forged = { kind: 'unaddressed' as const, bookDir, held: true };
    await expect(take.ensureTakeIdentity(forged, 'ch-01')).rejects.toThrow(/not held/);
  });
});
