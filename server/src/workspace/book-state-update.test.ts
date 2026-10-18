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

/* #3400 pass 9 -- `underBookLock` is for a pre-check that may reach the
   workspace scan, whose heals take the book lock AND the `state-json` leaf lock
   (`persistHealPatches` -> `updateStateJsonLocked`). The leaf lock is not
   re-entrant, so the hook must run BEFORE `updateStateAtDir` takes it: run
   inside it, a hook that heals the same book would wait on its own caller for the
   whole acquisition budget. Observable here by taking the leaf lock from inside
   the hook with a short budget: free => it resolves, held => it times out. */
describe('updateStateAtDir underBookLock', () => {
  it('runs inside the book lock but before the state-json leaf lock is held', async () => {
    const { updateStateAtDir } = await import('./book-state-update.js');
    const { withStateJsonLock } = await import('./file-lock.js');
    const bookDir = join(workspaceRoot, 'books', 'tester', 'myseries', 'locate');
    const statePath = paths.stateJsonPath(bookDir);

    const order: string[] = [];
    let leafFreeInHook: boolean | null = null;
    const wrote = await updateStateAtDir(
      bookDir,
      (s) => {
        order.push('mutate');
        return { ...s, title: 'Mutated' };
      },
      {
        underBookLock: async () => {
          order.push('hook');
          leafFreeInHook = await withStateJsonLock(statePath, async () => true, 150).catch(
            () => false,
          );
        },
      },
    );

    expect(wrote).toBe(true);
    expect(order).toEqual(['hook', 'mutate']);
    expect(leafFreeInHook).toBe(true);
  });

  /* "Inside the book lock" has to be observable, or the hook could run before
     withBookLock and the case above would still be green. A holder owns the
     book lock; the hook must not run until it lets go. */
  it('does not run until a concurrent holder of the book lock releases it', async () => {
    const { updateStateAtDir } = await import('./book-state-update.js');
    const { withBookLock } = await import('./book-lock.js');
    const bookDir = join(workspaceRoot, 'books', 'tester', 'myseries', 'locate');

    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((r) => {
      releaseHolder = r;
    });
    let holding!: () => void;
    const holderIn = new Promise<void>((r) => {
      holding = r;
    });
    const holder = withBookLock(BOOK_ID, async () => {
      holding();
      await holderGate;
    });
    await holderIn;

    let hookRan = false;
    const update = updateStateAtDir(bookDir, (s) => ({ ...s, title: 'Mutated' }), {
      underBookLock: async () => {
        hookRan = true;
      },
    });
    /* give a hook that wrongly ran outside the lock ample time to show itself */
    await new Promise((r) => setTimeout(r, 100));
    expect(hookRan).toBe(false);

    releaseHolder();
    await holder;
    expect(await update).toBe(true);
    expect(hookRan).toBe(true);
  });
});
