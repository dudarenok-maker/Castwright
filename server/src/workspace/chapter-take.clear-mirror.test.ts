/* #4319 review pass 3 — `clearTakeIdMirror`'s own guards. Each test names the mutation
   that turns it red. `writeJsonAtomic` is wrapped so a write can be counted and made
   to fail; the book is a real one on disk, reached through a real `withBookOp`. */
import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const writes = { n: 0, fail: false };

vi.mock('./state-io.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./state-io.js')>();
  return {
    ...real,
    writeJsonAtomic: vi.fn(async (...args: Parameters<typeof real.writeJsonAtomic>) => {
      if (String(args[0]).endsWith('state.json')) {
        writes.n += 1;
        if (writes.fail) throw new Error('EPERM: injected state write failure');
      }
      return real.writeJsonAtomic(...args);
    }),
  };
});

const SLUG = 'ch-01';
let workspaceRoot: string;
let take: typeof import('./chapter-take.js');
let lock: typeof import('./book-op-lock.js');
let paths: typeof import('./paths.js');
let seq = 0;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-clear-mirror-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  [take, lock, paths] = await Promise.all([import('./chapter-take.js'), import('./book-op-lock.js'), import('./paths.js')]);
});

afterEach(() => {
  vi.restoreAllMocks();
  writes.n = 0;
  writes.fail = false;
  rmSync(paths.BOOKS_ROOT, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

function seedBook(chapter: Record<string, unknown>) {
  seq += 1;
  const title = `Mirror Book ${seq}`;
  const bookDir = join(paths.BOOKS_ROOT, 'Mirrorer', 'Ser', title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  mkdirSync(join(bookDir, 'audio'), { recursive: true });
  const statePath = join(bookDir, '.audiobook', 'state.json');
  const bookId = paths.makeBookId('Mirrorer', 'Ser', title);
  writeFileSync(
    statePath,
    JSON.stringify({
      bookId,
      manuscriptId: `ms-${seq}`,
      title,
      author: 'Mirrorer',
      series: 'Ser',
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: false,
      chapters: [{ id: 1, title: 'One', slug: SLUG, ...chapter }],
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    }),
  );
  const clear = () => lock.withBookOp(bookId, (h) => take.clearTakeIdMirror(h, SLUG));
  const chapterNow = () => JSON.parse(readFileSync(statePath, 'utf8')).chapters[0] as Record<string, unknown>;
  return { clear, chapterNow };
}

describe('clearTakeIdMirror', () => {
  it('removes audioTakeId and leaves every other member alone', async () => {
    const b = seedBook({ duration: '0:12', audioRenderedAt: 'T-A', audioTakeId: 'aaaaaaaaaaaaaaaa' });
    await b.clear();
    expect(b.chapterNow()).toEqual({ id: 1, title: 'One', slug: SLUG, duration: '0:12', audioRenderedAt: 'T-A' });
    expect(writes.n).toBe(1);
  });

  it('writes nothing when the member is already absent (M14: the absent-check removed turns this red)', async () => {
    const b = seedBook({ duration: '0:12', audioRenderedAt: 'T-A' });
    await b.clear();
    expect(writes.n).toBe(0);
  });

  it('a failed state write is logged and swallowed: the restore has landed (M12: the catch rethrows turns this red)', async () => {
    const b = seedBook({ duration: '0:12', audioTakeId: 'aaaaaaaaaaaaaaaa' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writes.fail = true;
    await expect(b.clear()).resolves.toBeUndefined();
    expect(writes.n).toBe(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('audioTakeId clear failed'))).toBe(true);
    expect(b.chapterNow().audioTakeId).toBe('aaaaaaaaaaaaaaaa');
  });
});
