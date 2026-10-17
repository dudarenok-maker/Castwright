/* #3400 pass 8 -- withLocatedBook's promise ("never a pre-wait snapshot"): the
   book is located AFTER the lock is acquired, so a writer queued behind a
   holder that changes state.json decides from what the holder left, not from
   what was on disk when the writer arrived. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workspaceRoot: string;
let paths: typeof import('./paths.js');

const BOOK_ID = 'tester__myseries__locate';

function stateWith(title: string): string {
  return JSON.stringify({
    bookId: BOOK_ID,
    manuscriptId: BOOK_ID,
    title,
    author: 'tester',
    series: 'myseries',
    seriesPosition: null,
    isStandalone: false,
    manuscriptFile: 'manuscript.txt',
    castConfirmed: false,
    chapters: [],
    coverGradient: ['#111111', '#222222'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'locate-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  vi.resetModules();
  paths = await import('./paths.js');
  const bookDir = join(workspaceRoot, 'books', 'tester', 'myseries', 'locate');
  await mkdir(join(bookDir, '.audiobook'), { recursive: true });
  await writeFile(join(bookDir, 'manuscript.txt'), 'chapter one', 'utf8');
  await writeFile(paths.stateJsonPath(bookDir), stateWith('Before'), 'utf8');
});

afterEach(async () => {
  delete process.env.WORKSPACE_DIR;
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('withLocatedBook', () => {
  it('locates the book after the lock is acquired, never from a pre-wait snapshot', async () => {
    const { withBookLock } = await import('./book-lock.js');
    const { withLocatedBook } = await import('./book-state-update.js');
    const bookDir = join(workspaceRoot, 'books', 'tester', 'myseries', 'locate');

    let releaseHolder!: () => void;
    let holderIn!: () => void;
    const holderEntered = new Promise<void>((r) => (holderIn = r));
    const holder = withBookLock(BOOK_ID, async () => {
      holderIn();
      await new Promise<void>((r) => (releaseHolder = r));
      await writeFile(paths.stateJsonPath(bookDir), stateWith('After'), 'utf8');
    });
    await holderEntered;

    let seen: string | null = null;
    const writer = withLocatedBook(BOOK_ID, async (located) => {
      seen = located.state.title;
    });
    /* give a (mutant) pre-lock locate every chance to read the old file */
    await new Promise((r) => setTimeout(r, 150));
    expect(seen).toBeNull();
    releaseHolder();
    await holder;
    await writer;
    expect(seen).toBe('After');
  });
});
