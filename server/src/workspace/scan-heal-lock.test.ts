/* #3400 — the scan self-heal writes (segments backfill in `findBookBy` /
   `scanBook`, and the srv-35 uuid mint) used to rewrite the WHOLE state.json
   from an unlocked earlier read, so they could revert a concurrent chapter
   restructure's chapter list. They now re-read state.json under the per-book
   lock and fill only the missing fields of chapters that still exist. */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hooks = vi.hoisted(() => ({
  onSegmentsRead: undefined as undefined | ((path: string) => Promise<void>),
}));

vi.mock('./state-io.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./state-io.js')>();
  return {
    ...orig,
    readJson: (async (path: string, ...rest: unknown[]) => {
      if (path.endsWith('.segments.json')) await hooks.onSegmentsRead?.(path);
      return (orig.readJson as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof orig.readJson,
  };
});

let workspaceRoot: string;
let scan: typeof import('./scan.js');
let lock: typeof import('./book-lock.js');
let makeBookId: typeof import('./paths.js').makeBookId;

const AUTHOR = 'Heal Author';
const SERIES = 'Standalones';
let seq = 0;

function seedBook(chapterCount: number, opts: { uuids?: boolean } = {}) {
  const title = `Heal Book ${seq++}`;
  const bookId = makeBookId(AUTHOR, SERIES, title);
  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
  const audioRoot = join(bookDir, 'audio');
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  mkdirSync(audioRoot, { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  const chapters = Array.from({ length: chapterCount }, (_, i) => ({
    id: i + 1,
    title: `Chapter ${i + 1}`,
    slug: `hc-${i + 1}`,
    ...(opts.uuids ? { uuid: `uuid-${i + 1}`, audioModelKey: 'x', audioRenderedAt: 'y', duration: '01:00' } : {}),
  }));
  for (const c of chapters) {
    writeFileSync(
      join(audioRoot, `${c.slug}.segments.json`),
      JSON.stringify({
        durationSec: 90,
        modelKey: 'xtts_v2',
        synthesizedAt: '2026-01-01T00:00:00.000Z',
        segments: [],
      }),
    );
  }
  const statePath = join(bookDir, '.audiobook', 'state.json');
  const state = {
    bookId,
    manuscriptId: `m_${bookId}`,
    title,
    author: AUTHOR,
    series: SERIES,
    seriesPosition: null,
    isStandalone: true,
    manuscriptFile: 'manuscript.txt',
    castConfirmed: false,
    chapters,
    coverGradient: ['#000', '#fff'],
    language: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(statePath, JSON.stringify(state));
  return { bookId, bookDir, statePath, state };
}

const readState = (p: string) => JSON.parse(readFileSync(p, 'utf-8'));
const tick = (n: number) => new Promise<void>((r) => setTimeout(r, n));

/* Fire `fn` (and wait for it) the first time a segments file under `bookDir`
   is read — i.e. inside the heal's read-to-write window. */
function armOnce(bookDir: string, fn: () => Promise<void>) {
  const norm = (p: string) => p.split('\\').join('/');
  let fired = false;
  return async (path: string) => {
    if (fired || !norm(path).startsWith(norm(bookDir))) return;
    fired = true;
    await fn();
  };
}

/* What a restructure does under the lock: write a state.json with an added
   chapter 99 (and a changed chapter list). */
async function restructureAddChapter(bookId: string, statePath: string) {
  await lock.withBookLock(bookId, async () => {
    const cur = readState(statePath);
    cur.chapters.push({ id: 99, title: 'Added', slug: 'hc-added', uuid: 'uuid-added' });
    writeFileSync(statePath, JSON.stringify(cur));
    await tick(1);
  });
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-heal-lock-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  scan = await import('./scan.js');
  lock = await import('./book-lock.js');
  makeBookId = (await import('./paths.js')).makeBookId;
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('segments backfill (findBookByBookId) merges under the book lock', () => {
  it('still fills audioModelKey / audioRenderedAt / duration', async () => {
    const { bookId, statePath } = seedBook(2, {});
    await scan.findBookByBookId(bookId);
    const s = readState(statePath);
    for (const ch of s.chapters) {
      expect(ch.audioModelKey).toBe('xtts_v2');
      expect(ch.audioRenderedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(ch.duration).not.toBe('00:00');
    }
  });

  it('does not revert a concurrent restructure that lands mid-heal', async () => {
    for (let k = 0; k < 5; k++) {
      const { bookId, bookDir, statePath } = seedBook(8);
      hooks.onSegmentsRead = armOnce(bookDir, () => restructureAddChapter(bookId, statePath));
      await scan.findBookByBookId(bookId);
      const s = readState(statePath);
      expect(s.chapters.map((c: { id: number }) => c.id), `iteration ${k}`).toContain(99);
      expect(s.chapters).toHaveLength(9);
      /* the heal still filled the chapters that survived */
      expect(s.chapters.filter((c: { audioModelKey?: string }) => c.audioModelKey)).toHaveLength(8);
    }
  });

  it('skips a chapter whose slug changed under it', async () => {
    const { bookId, bookDir, statePath } = seedBook(1);
    hooks.onSegmentsRead = armOnce(bookDir, () =>
      lock.withBookLock(bookId, async () => {
        const cur = readState(statePath);
        cur.chapters[0].slug = 'renamed';
        writeFileSync(statePath, JSON.stringify(cur));
      }),
    );
    await scan.findBookByBookId(bookId);
    const s = readState(statePath);
    expect(s.chapters[0].slug).toBe('renamed');
    expect(s.chapters[0].audioModelKey).toBeUndefined();
  });

  it('completes (no deadlock) when the caller already holds the book lock', async () => {
    const { bookId, statePath } = seedBook(3);
    const run = lock.withBookLock(bookId, async () => {
      const located = await scan.findBookByBookId(bookId);
      return located?.state.chapters.length;
    });
    const timeout = new Promise<string>((r) => setTimeout(() => r('TIMEOUT'), 5000));
    expect(await Promise.race([run, timeout])).toBe(3);
    expect(readState(statePath).chapters[0].audioModelKey).toBe('xtts_v2');
  });
});

describe('scanLibrary uuid mint + backfill merge under the book lock', () => {
  it('mints uuids and does not revert a concurrent restructure', async () => {
    for (let k = 0; k < 3; k++) {
      const { bookId, bookDir, statePath } = seedBook(6);
      hooks.onSegmentsRead = armOnce(bookDir, () => restructureAddChapter(bookId, statePath));
      await scan.scanLibrary();
      const s = readState(statePath);
      expect(s.chapters.map((c: { id: number }) => c.id), `iteration ${k}`).toContain(99);
      expect(s.chapters.find((c: { id: number }) => c.id === 1).uuid).toBeTruthy();
    }
  });

  it('persists a minted uuid that matches what a second locate sees', async () => {
    const { statePath, bookId } = seedBook(2);
    await scan.scanLibrary();
    const first = readState(statePath).chapters.map((c: { uuid: string }) => c.uuid);
    expect(first.every(Boolean)).toBe(true);
    const located = await scan.findBookByBookId(bookId);
    expect(located?.state.chapters.map((c) => c.uuid)).toEqual(first);
  });
});
