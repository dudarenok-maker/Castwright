/* #3625 pass 6 (🟠1, probe P-WIN) - a state.json read that lands inside a
   rotating write's rename window.

   `writeJsonAtomic` renames main to `.bak.1` before it renames the new file in
   (the order #3625 chose because #3706's copy-then-replace failed with EPERM
   on Windows), so for that window `.audiobook/state.json` is absent. A reader
   that used a plain `readJson` there saw "no book" and skipped it: a series
   override propagation reported success and silently missed the book being
   written. Every state.json reader goes through the recovering read, which
   serves `.bak.1` (the state before the write) instead.

   Book Two's `writeStateJsonAtomic` is HELD at its rename-in (the real writer,
   not a hand-made disk state), and the series walk runs during the hold. */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hold = vi.hoisted(() => ({
  /** When set, a rename onto this path waits for `release` first. */
  dest: null as string | null,
  reached: null as null | (() => void),
  release: null as Promise<void> | null,
}));

vi.mock('../workspace/atomic-rename.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/atomic-rename.js')>();
  return {
    ...actual,
    renameWithRetry: async (src: string, dest: string) => {
      if (hold.dest && dest === hold.dest && src.includes('.tmp-')) {
        hold.reached?.();
        await hold.release;
      }
      return actual.renameWithRetry(src, dest);
    },
  };
});

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';

let workspaceRoot: string;
let bookOneDir: string;
let bookTwoDir: string;

function writeBook(title: string, bookId: string): string {
  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({ characters: [{ id: 'alice', name: 'Alice', voiceId: 'v-shared' }] }),
  );
  return bookDir;
}

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'cw-state-window-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  bookOneDir = writeBook('Book One', 'book-one');
  bookTwoDir = writeBook('Book Two', 'book-two');
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

const castOf = (bookDir: string) =>
  JSON.parse(readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8')) as {
    characters: Array<Record<string, unknown>>;
  };

describe('a state.json reader inside a rotating write\'s rename window (P-WIN)', () => {
  it('forEachMatchingCastCharacter still reaches the book whose state.json is mid-write (updated=2)', async () => {
    const [{ forEachMatchingCastCharacter }, { writeStateJsonAtomic }, { stateJsonPath }] = await Promise.all([
      import('./voices.js'),
      import('../workspace/state-migrate.js'),
      import('../workspace/paths.js'),
    ]);
    const statePath = stateJsonPath(bookTwoDir);
    const current = JSON.parse(readFileSync(statePath, 'utf8'));

    let release!: () => void;
    hold.release = new Promise<void>((r) => (release = r));
    const reached = new Promise<void>((r) => (hold.reached = r));
    hold.dest = statePath;
    let write: Promise<void> | undefined;
    try {
      /* Stands in for a chapter finalize or an autosave PUT on Book Two. */
      write = writeStateJsonAtomic(statePath, { ...current, updatedAt: '2026-10-02T00:00:00.000Z' });
      await reached;
      expect(existsSync(statePath), 'precondition: main is absent mid-write').toBe(false);

      const updated = await forEachMatchingCastCharacter('v-shared', { author: AUTHOR, series: SERIES }, (c) => ({
        ...c,
        voiceStyle: 'marked',
      }));
      expect(updated).toBe(2);
    } finally {
      hold.dest = null;
      release();
      await write;
    }
    expect(castOf(bookOneDir).characters[0].voiceStyle).toBe('marked');
    expect(castOf(bookTwoDir).characters[0].voiceStyle).toBe('marked');
  });
});
