/* #3713 / PR #4004 pass 2 -- the analysis cache (`handoff/cache/<manuscriptId>.json`)
   is global and, before the sweep, was ONE file read by both twins that shared a
   manuscriptId. Re-minting the loser's manuscriptId would leave the cache with the
   winner, and the status scan (`scanLibrary`) reads it: an analysed, unconfirmed copy
   dropped back to "Analysing". The sweep copies the cache to the new id, which
   reproduces the copy's pre-sweep view exactly. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;
let paths: typeof import('./paths.js');
let sweep: typeof import('./duplicate-bookid-sweep.js');
let scan: typeof import('./scan.js');
let cache: typeof import('../store/analysis-cache.js');
let warn: ReturnType<typeof vi.spyOn>;
/** Cache files this run created, removed again so nothing leaks into server/handoff/cache. */
const created = new Set<string>();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'audiobook-dup-bookid-cache-'));
  process.env.WORKSPACE_DIR = root;
  /* Sequential imports -- a Promise.all of dynamic imports races vi.mock factories (#2083). */
  paths = await import('./paths.js');
  sweep = await import('./duplicate-bookid-sweep.js');
  scan = await import('./scan.js');
  cache = await import('../store/analysis-cache.js');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

afterEach(async () => {
  for (const id of created) {
    rmSync(cache.cachePath(id), { recursive: true, force: true });
  }
  created.clear();
  warn.mockClear();
  rmSync(join(root, 'books'), { recursive: true, force: true });
  sweep.__resetDuplicateBookIdRepairsForTest();
});

function seed(title: string, bookId: string, manuscriptId: string, castRows: number, rendered: boolean): string {
  const dir = join(paths.BOOKS_ROOT, 'Auth', 'Ser', title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, 'manuscript.md'), '# Chapter One\n\nText.\n\n# Chapter Two\n\nMore text.\n');
  writeFileSync(
    paths.stateJsonPath(dir),
    JSON.stringify({
      bookId, manuscriptId, title, author: 'Auth', series: 'Ser', seriesPosition: 1, isStandalone: false,
      manuscriptFile: 'manuscript.md', castConfirmed: false, language: 'en',
      chapters: [
        { id: 1, title: 'Chapter One', slug: '01-chapter-one', ...(rendered ? { audioRenderedAt: '2026-02-01T00:00:00.000Z' } : {}) },
        { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
      ],
      coverGradient: ['#000', '#fff'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', schema: 1,
    }),
  );
  writeFileSync(
    paths.castJsonPath(dir),
    JSON.stringify({
      characters: Array.from({ length: castRows }, (_, i) => ({ id: `c${i}`, name: `C${i}`, role: 'character', color: '#abc', voiceId: 'v' })),
    }),
  );
  writeFileSync(
    paths.manuscriptEditsJsonPath(dir),
    JSON.stringify({
      sentences: [
        { id: 101, chapterId: 1, characterId: 'c0', confidence: 0.9, text: 'a' },
        { id: 201, chapterId: 2, characterId: 'c0', confidence: 0.9, text: 'b' },
      ],
    }),
  );
  return dir;
}

/** A finished analysis of both chapters: what puts a book at Confirm. */
const finishedCache = () => ({
  stage1: { characters: [{ id: 'c0', name: 'C0' }] },
  chapterCast: { 1: ['c0'], 2: ['c0'] },
  chapters: {
    1: [{ id: 101, chapterId: 1, characterId: 'c0', confidence: 0.9, text: 'a' }],
    2: [{ id: 201, chapterId: 2, characterId: 'c0', confidence: 0.9, text: 'b' }],
  },
  takesPersisted: true,
});
async function writeCache(manuscriptId: string, body: unknown = finishedCache()): Promise<void> {
  created.add(manuscriptId);
  await cache.saveAnalysisCache(manuscriptId, body as never);
}

const readState = (dir: string) => JSON.parse(readFileSync(paths.stateJsonPath(dir), 'utf8'));
async function rows() {
  const lib = await scan.scanLibrary();
  const out: Record<string, { status: string; analysed?: number }> = {};
  for (const a of lib.authors) {
    for (const s of a.series) {
      for (const b of s.books) {
        out[b.title] = { status: b.status, analysed: (b as { analysedChapterCount?: number }).analysedChapterCount };
      }
    }
  }
  return out;
}

describe('the analysis cache follows a re-minted manuscriptId', () => {
  it('an analysed, unconfirmed copy that shared the manuscriptId stays at Confirm, not Analysing', async () => {
    await writeCache('m_p2_shared');
    seed('Book', 'auth__ser__book', 'm_p2_shared', 4, false);
    seed('Book copy', 'auth__ser__book', 'm_p2_shared', 2, false);
    const before = await rows();
    expect(before['Book copy'].status).not.toBe('analysing');

    await sweep.repairDuplicateBookIds();
    created.add(readState(join(paths.BOOKS_ROOT, 'Auth', 'Ser', 'Book copy')).manuscriptId);
    const after = await rows();

    expect(after['Book copy']).toEqual(before['Book copy']);
    expect(after.Book).toEqual(before.Book);
  });

  it('the copy has its own file under the new id, identical to the old one; the winner keeps the old file', async () => {
    await writeCache('m_p2_copy');
    const loser = seed('Book copy', 'auth__ser__book', 'm_p2_copy', 1, false);
    seed('Book', 'auth__ser__book', 'm_p2_copy', 4, true);
    await sweep.repairDuplicateBookIds();
    const fresh = readState(loser).manuscriptId as string;
    created.add(fresh);
    expect(fresh).not.toBe('m_p2_copy');
    expect(readFileSync(cache.cachePath(fresh), 'utf8')).toBe(readFileSync(cache.cachePath('m_p2_copy'), 'utf8'));
  });

  it('no cache for the old id: nothing is created and the repair still lands', async () => {
    const loser = seed('Book copy', 'auth__ser__book', 'm_p2_nocache', 1, false);
    seed('Book', 'auth__ser__book', 'm_p2_nocache', 4, true);
    const r = await sweep.repairDuplicateBookIds();
    expect(r).toHaveLength(1);
    const fresh = readState(loser).manuscriptId as string;
    created.add(fresh);
    expect(existsSync(cache.cachePath(fresh))).toBe(false);
  });

  it('twins with different manuscriptIds copy nothing', async () => {
    await writeCache('m_p2_a');
    const loser = seed('Book copy', 'auth__ser__book', 'm_p2_b', 1, false);
    seed('Book', 'auth__ser__book', 'm_p2_a', 4, true);
    await sweep.repairDuplicateBookIds();
    expect(readState(loser).manuscriptId).toBe('m_p2_b');
    created.add('m_p2_b');
    expect(existsSync(cache.cachePath('m_p2_b'))).toBe(false);
  });

  it('a cache that cannot be copied is logged and does not undo the repair or stop the rekey', async () => {
    /* The source "file" is a directory: copyFile fails with EISDIR / EPERM. */
    created.add('m_p2_dir');
    mkdirSync(cache.cachePath('m_p2_dir'), { recursive: true });
    const loser = seed('Book copy', 'auth__ser__book', 'm_p2_dir', 1, false);
    seed('Book', 'auth__ser__book', 'm_p2_dir', 4, true);
    writeFileSync(paths.analysisStateJsonPath(loser), JSON.stringify({ manuscriptId: 'm_p2_dir', state: 'paused' }));
    const r = await sweep.repairDuplicateBookIds();
    expect(r).toHaveLength(1);
    const fresh = readState(loser).manuscriptId as string;
    created.add(fresh);
    expect(fresh).not.toBe('m_p2_dir');
    expect(JSON.parse(readFileSync(paths.analysisStateJsonPath(loser), 'utf8')).manuscriptId).toBe(fresh);
    expect(warn.mock.calls.some((c: unknown[]) => String(c[0]).includes('could not copy the analysis cache'))).toBe(true);
  });
});
